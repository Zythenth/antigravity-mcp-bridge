import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { executeWindowsTest, recoverWindowsExecutions } from '../src/windows-executor.js';

const settings = { timeoutSeconds: 20, maxRuntimeBytes: 256 * 1024 * 1024 };
type Grant = { path: string; rights: 'read' | 'modify'; directory: boolean; volume: number; fileIndexHigh: number; fileIndexLow: number };
type Lease = { nonce: string; profile: string; sid: string; phase: string; controllerPid: number; controllerStarted: number; cwd: string; runtime: string; scratch: string; grants: Grant[] };
type Announcement = { controllerPid: number; requestPath: string };

const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function eventually<T>(description: string, observe: () => Promise<T | undefined>, timeoutMilliseconds = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await observe();
      if (value !== undefined) return value;
      last = value;
    } catch (error) { last = error; }
    await pause(50);
  }
  throw new Error(description + ': ' + String(last));
}

async function ownedTemporaryDirectory(directory: string, prefix: string): Promise<string> {
  const temporary = await realpath(os.tmpdir());
  const canonical = await realpath(directory);
  assert.equal(path.dirname(canonical), temporary, 'temporary target must be directly below os.tmpdir()');
  assert.ok(path.basename(canonical).startsWith(prefix), 'temporary target prefix');
  assert.equal((await lstat(canonical)).isSymbolicLink(), false, 'temporary target cannot be a link');
  return canonical;
}

async function removeOwned(directory: string | undefined, prefix: string): Promise<void> {
  if (!directory) return;
  const canonical = await ownedTemporaryDirectory(directory, prefix);
  await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function storedAcls(targets: { path: string; mode?: 'explicit' | 'foreign' }[]): string[] {
  const source = `using System;using System.IO;using System.ComponentModel;using System.Runtime.InteropServices;using System.Security.AccessControl;
public static class AclFixture {
[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool GetFileSecurity(string p,uint i,byte[] b,uint n,out uint needed);
[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool SetFileSecurity(string p,uint i,byte[] b);
public static string Apply(string p,string mode){uint n;GetFileSecurity(p,4,null,0,out n);byte[] b=new byte[n];if(!GetFileSecurity(p,4,b,n,out n))throw new Win32Exception();var sd=new RawSecurityDescriptor(b,0);
if(!String.IsNullOrEmpty(mode)){if(mode=="foreign")sd.DiscretionaryAcl.InsertAce(0,new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,0x120089,new System.Security.Principal.SecurityIdentifier("S-1-5-21-1-2-3-4567"),false,null));
else {var flags=sd.ControlFlags&~(ControlFlags.DiscretionaryAclProtected|ControlFlags.DiscretionaryAclAutoInherited|ControlFlags.DiscretionaryAclAutoInheritRequired);sd.SetFlags(flags);foreach(GenericAce ace in sd.DiscretionaryAcl){ace.AceFlags&=~AceFlags.Inherited;}}
b=new byte[sd.BinaryLength];sd.GetBinaryForm(b,0);if(!SetFileSecurity(p,4,b))throw new Win32Exception();GetFileSecurity(p,4,null,0,out n);b=new byte[n];if(!GetFileSecurity(p,4,b,n,out n))throw new Win32Exception();sd=new RawSecurityDescriptor(b,0);}
return sd.GetSddlForm(AccessControlSections.Access);}}`;
  const script = "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition $env:BRIDGE_ACL_FIXTURE_SOURCE; $targets = ConvertFrom-Json $env:BRIDGE_ACL_FIXTURE_TARGETS; $values = @($targets | ForEach-Object { [AclFixture]::Apply($_.path, $_.mode) }); ConvertTo-Json -InputObject $values -Compress";
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, BRIDGE_ACL_FIXTURE_SOURCE: source, BRIDGE_ACL_FIXTURE_TARGETS: JSON.stringify(targets) },
  })) as string[];
}

async function readAcl(target: string): Promise<string> {
  const child = spawn('icacls.exe', [target], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { error += String(chunk); });
  const code = await new Promise<number | null>(resolve => child.once('close', resolve));
  assert.equal(code, 0, error);
  return output;
}

async function profileExists(sid: string): Promise<boolean> {
  const key = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings\\' + sid;
  const child = spawn('reg.exe', ['query', key], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let error = '';
  child.stderr.on('data', chunk => { error += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.ok(code === 0 || code === 1, error);
  return code === 0;
}

async function readLease(state: string): Promise<{ file: string; value: Lease }> {
  const directory = path.join(state, 'windows-lpac-leases');
  const name = await eventually('active lease was not written', async () => (await readdir(directory).catch(() => [])).find(entry => entry.endsWith('.json')));
  const file = path.join(directory, name);
  const value = JSON.parse(await readFile(file, 'utf8')) as Lease;
  assert.equal(value.phase, 'active');
  assert.ok(value.sid.startsWith('S-1-15-2-'));
  assert.ok(value.grants.length > 0);
  return { file, value };
}

async function waitForExit(child: ChildProcessWithoutNullStreams, expected: number): Promise<void> {
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not exit')), 30_000);
    child.once('exit', exitCode => { clearTimeout(timer); resolve(exitCode); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(code, expected);
}

async function launchCrashWorker(copy: string, state: string, grant: string, ready: string, heartbeat: string): Promise<{ worker: ChildProcessWithoutNullStreams; announcement: Announcement }> {
  const executorUrl = new URL('../src/windows-executor.js', import.meta.url).href;
  const childPid = path.join(copy, 'child-pid.txt');
  const lpacScript = "const fs=require('node:fs');let tick=0;fs.writeFileSync(" + JSON.stringify(childPid) + ",String(process.pid));fs.writeFileSync(" + JSON.stringify(ready) + ",'ready');setInterval(()=>fs.writeFileSync(" + JSON.stringify(heartbeat) + ",String(++tick)),100);setInterval(()=>{},1000);";
  const workerSource = "import { readFileSync } from 'node:fs';import { executeWindowsTest } from " + JSON.stringify(executorUrl) + ";" +
    "const settings=JSON.parse(process.argv[1]);const command={executable:process.execPath,args:['-e'," + JSON.stringify(lpacScript) + "]};" +
    "await executeWindowsTest(command,settings.copy,{timeoutSeconds:20,maxRuntimeBytes:268435456,stateDirectory:settings.state,sandbox:{readPaths:[],writePaths:[settings.grant],network:false,childProcesses:true,maxOutputChars:4000},onProcess(child){const requestPath=child.spawnargs.at(-1);if(typeof requestPath!=='string')return;let request;try{request=JSON.parse(readFileSync(requestPath,'utf8'));}catch{return;}if(request.action!=='write')return;process.stdout.write(JSON.stringify({controllerPid:child.pid,requestPath})+'\\n');child.once('exit',()=>process.exit(86));}});process.exit(0);";
  const worker = spawn(process.execPath, ['--input-type=module', '-e', workerSource, JSON.stringify({ copy, state, grant })], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '';
  worker.stdout.on('data', chunk => { output += String(chunk); });
  worker.stderr.on('data', chunk => { error += String(chunk); });
  const announcement = await eventually('worker did not announce a write controller', async () => {
    const line = output.split(/\r?\n/).find(value => value.startsWith('{'));
    if (!line) return undefined;
    const value = JSON.parse(line) as Announcement;
    if (!Number.isInteger(value.controllerPid) || value.controllerPid <= 0 || typeof value.requestPath !== 'string') throw new Error('invalid worker announcement: ' + line + error);
    return value;
  });
  return { worker, announcement };
}

async function verifyControllerAnnouncement(announcement: Announcement, state: string): Promise<void> {
  const temporary = await realpath(os.tmpdir());
  const request = JSON.parse(await readFile(announcement.requestPath, 'utf8')) as { action?: string; stateDirectory?: string };
  assert.equal(request.action, 'write');
  assert.equal(path.resolve(request.stateDirectory || ''), path.resolve(state));
  assert.equal(path.dirname(path.dirname(announcement.requestPath)), temporary);
  assert.ok(path.basename(path.dirname(announcement.requestPath)).startsWith('agy-mcp-controller-'));
  process.kill(announcement.controllerPid, 0);
}

async function freshRecovery(state: string): Promise<void> {
  const executorUrl = new URL('../src/windows-executor.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', "import { recoverWindowsExecutions } from " + JSON.stringify(executorUrl) + ";await recoverWindowsExecutions(process.argv[1]);", state], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(output);
}

async function stopController(worker: ChildProcessWithoutNullStreams, announcement: Announcement): Promise<void> {
  process.kill(announcement.controllerPid, 'SIGTERM');
  await waitForExit(worker, 86);
}

async function crashFixture<T>(run: (resources: { copy: string; state: string; grant: string; ready: string; heartbeat: string }) => Promise<T>): Promise<T> {
  const temporary = await realpath(os.tmpdir());
  const copy = await realpath(await mkdtemp(path.join(temporary, 'agy-mcp-copy-')));
  const state = await realpath(await mkdtemp(path.join(temporary, 'agy-mcp-recovery-state-')));
  const grant = await realpath(await mkdtemp(path.join(temporary, 'agy-mcp-recovery-grant-')));
  try {
    storedAcls([{ path: grant, mode: 'explicit' }]);
    return await run({ copy, state, grant, ready: path.join(copy, 'ready.txt'), heartbeat: path.join(copy, 'heartbeat.txt') }); }
  finally {
    for (const [directory, prefix] of [[copy, 'agy-mcp-copy-'], [state, 'agy-mcp-recovery-state-'], [grant, 'agy-mcp-recovery-grant-']] as const) await removeOwned(directory, prefix);
  }
}

test('Windows recovery preserves a live controller, rejects a reused PID as stale, and recovers in a fresh process', { skip: process.platform !== 'win32' }, async () => {
  await crashFixture(async ({ copy, state, grant, ready, heartbeat }) => {
    let worker: ChildProcessWithoutNullStreams | undefined;
    let controllerDirectory: string | undefined;
    try {
      const beforeAcl = await readAcl(grant);
      const beforeDacl = storedAcls([{ path: grant }])[0]!;
      const launched = await launchCrashWorker(copy, state, grant, ready, heartbeat);
      worker = launched.worker; controllerDirectory = path.dirname(launched.announcement.requestPath);
      await verifyControllerAnnouncement(launched.announcement, state);
      await eventually('LPAC command did not become ready', async () => (await readFile(ready, 'utf8').catch(() => undefined)) === 'ready' ? true : undefined);
      const active = await readLease(state);
      assert.equal(active.value.controllerPid, launched.announcement.controllerPid);
      assert.equal(await profileExists(active.value.sid), true, 'active lease profile must remain available');
      const created = path.join(grant, 'created-during-execution.txt');
      await writeFile(created, 'created');
      storedAcls([{ path: created, mode: 'foreign' }]);
      const childAcl = storedAcls([{ path: created }])[0]!;
      assert.ok(childAcl.includes(active.value.sid), 'a new child must inherit the active profile grant');
      const activeAcl = await readAcl(grant);
      assert.notEqual(activeAcl, beforeAcl); assert.match(activeAcl, new RegExp(active.value.sid));
      const firstHeartbeat = Number(await eventually('LPAC heartbeat was not written', async () => {
        const value = await readFile(heartbeat, 'utf8').catch(() => undefined);
        return value === undefined ? undefined : value;
      }));
      await recoverWindowsExecutions(state);
      assert.deepEqual((await readLease(state)).value, active.value, 'active lease must remain unchanged');
      assert.equal(await readAcl(grant), activeAcl, 'active ACL must remain unchanged');
      await eventually('LPAC heartbeat stopped during active recovery', async () => Number(await readFile(heartbeat, 'utf8')) > firstHeartbeat ? true : undefined);
      await stopController(worker, launched.announcement); worker = undefined;
      assert.equal((await lstat(active.file)).isFile(), true, 'controller crash leaves a lease for a fresh process');
      await writeFile(active.file, JSON.stringify({ ...active.value, controllerPid: process.pid, controllerStarted: 1 }), 'utf8');
      await freshRecovery(state);
      process.kill(process.pid, 0);
      await assert.rejects(readFile(active.file));
      assert.equal(await profileExists(active.value.sid), false, 'stale profile must be removed');
      assert.equal(await readAcl(grant), beforeAcl, 'owned grant ACL must be restored');
      assert.equal(storedAcls([{ path: grant }])[0], beforeDacl, 'stored grant DACL must be restored exactly');
      const recoveredChildAcl = storedAcls([{ path: created }])[0]!;
      assert.equal(recoveredChildAcl, childAcl.replace(new RegExp('\\(A;[^)]*;' + active.value.sid + '\\)'), ''), 'recovery removes only the owned child rule and preserves the foreign update');
      assert.ok(recoveredChildAcl.includes('(A;;FR;;;S-1-5-21-1-2-3-4567)'));
      const childPid = Number(await readFile(path.join(copy, 'child-pid.txt'), 'utf8').catch(() => '0'));
      if (childPid > 0) await eventually('LPAC descendant survived recovery', async () => { try { process.kill(childPid, 0); return undefined; } catch { return true; } });
      const fresh = await executeWindowsTest({ executable: process.execPath, args: ['-e', "process.stdout.write('fresh execution')"] }, copy, { ...settings, stateDirectory: state });
      assert.equal(fresh.exitCode, 0, JSON.stringify(fresh)); assert.equal(fresh.output, 'fresh execution');
    } finally {
      if (worker && worker.exitCode === null) worker.kill('SIGTERM');
      await removeOwned(controllerDirectory, 'agy-mcp-controller-');
    }
  });
});

test('Windows recovery leaves an existing scratch replacement untouched but skips missing owned temporary targets', { skip: process.platform !== 'win32' }, async () => {
  await crashFixture(async ({ copy, state, grant, ready, heartbeat }) => {
    let worker: ChildProcessWithoutNullStreams | undefined;
    let controllerDirectory: string | undefined;
    let staleLease: string | undefined;
    try {
      const beforeGrantAcl = await readAcl(grant);
      const beforeGrantDacl = storedAcls([{ path: grant }])[0]!;
      const launched = await launchCrashWorker(copy, state, grant, ready, heartbeat);
      worker = launched.worker; controllerDirectory = path.dirname(launched.announcement.requestPath);
      await verifyControllerAnnouncement(launched.announcement, state);
      await eventually('LPAC command did not become ready', async () => (await readFile(ready, 'utf8').catch(() => undefined)) === 'ready' ? true : undefined);
      const active = await readLease(state); staleLease = active.file;
      const scratch = await ownedTemporaryDirectory(active.value.scratch, 'agy-mcp-scratch-');
      const runtime = await ownedTemporaryDirectory(active.value.runtime, 'agy-mcp-runtime-');
      assert.ok(active.value.grants.some(grantEntry => grantEntry.path === scratch));
      assert.ok(active.value.grants.some(grantEntry => grantEntry.path === runtime));
      await stopController(worker, launched.announcement); worker = undefined;
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await mkdir(scratch);
      const replacementAcl = await readAcl(scratch);
      await writeFile(active.file, JSON.stringify({ ...active.value, controllerPid: process.pid, controllerStarted: 1 }), 'utf8');
      await assert.rejects(freshRecovery(state), /Granted target identity changed/);
      process.kill(process.pid, 0);
      assert.equal(await profileExists(active.value.sid), false, 'identity mismatch does not stop independent profile cleanup');
      assert.equal(await readAcl(scratch), replacementAcl, 'recovery must not change a replacement ACL');
      assert.equal(await readAcl(grant), beforeGrantAcl, 'independent cleanup still restores other owned grants');
      assert.equal(storedAcls([{ path: grant }])[0], beforeGrantDacl, 'independent cleanup must preserve the stored grant DACL');
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await freshRecovery(state);
      await assert.rejects(readFile(active.file)); staleLease = undefined;
    } finally {
      if (worker && worker.exitCode === null) worker.kill('SIGTERM');
      if (staleLease) await rm(staleLease, { force: true });
      await removeOwned(controllerDirectory, 'agy-mcp-controller-');
    }
  });
});
