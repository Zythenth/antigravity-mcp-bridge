import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { executeWindowsTest, recoverWindowsExecutions } from '../src/windows-executor.js';
import { TaskManager } from '../src/task-manager.js';
import { loadConfig } from '../src/config.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { StateStore } from '../src/state-store.js';
import { discardProjectCopy } from '../src/isolation.js';

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

function storedAcls(targets: { path: string; mode?: string }[]): string[] {
  const source = `using System;using System.IO;using System.ComponentModel;using System.Runtime.InteropServices;using System.Security.AccessControl;
public static class AclFixture {
[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool GetFileSecurity(string p,uint i,byte[] b,uint n,out uint needed);
[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool SetFileSecurity(string p,uint i,byte[] b);
public static string Apply(string p,string mode){uint n;GetFileSecurity(p,4,null,0,out n);byte[] b=new byte[n];if(!GetFileSecurity(p,4,b,n,out n))throw new Win32Exception();var sd=new RawSecurityDescriptor(b,0);
if(!String.IsNullOrEmpty(mode)){if(mode=="foreign")sd.DiscretionaryAcl.InsertAce(0,new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,0x120089,new System.Security.Principal.SecurityIdentifier("S-1-5-21-1-2-3-4567"),false,null));
else if(mode.StartsWith("S-1-"))sd.DiscretionaryAcl.InsertAce(0,new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,0x120089,new System.Security.Principal.SecurityIdentifier(mode),false,null));
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

function ownedProfile(profile: string, action: 'create' | 'remove'): string {
  assert.match(profile, /^agy\.test\.[0-9a-f]{32}$/);
  const source = 'using System;using System.Runtime.InteropServices;using System.Security.Principal;public static class ProfileFixture {' +
    '[DllImport("userenv.dll",CharSet=CharSet.Unicode)]static extern int CreateAppContainerProfile(string n,string d,string x,IntPtr c,uint z,out IntPtr s);' +
    '[DllImport("userenv.dll",CharSet=CharSet.Unicode)]static extern int DeleteAppContainerProfile(string n);[DllImport("advapi32.dll")]static extern IntPtr FreeSid(IntPtr s);' +
    'public static string Create(string n){IntPtr s;int r=CreateAppContainerProfile(n,n,"Owned test profile",IntPtr.Zero,0,out s);if(r<0)Marshal.ThrowExceptionForHR(r);try{return new SecurityIdentifier(s).Value;}finally{FreeSid(s);}}' +
    'public static void Remove(string n){int r=DeleteAppContainerProfile(n);if(r<0&&r!=unchecked((int)0x80070002)&&r!=unchecked((int)0x80070003))Marshal.ThrowExceptionForHR(r);}}';
  const script = "$ErrorActionPreference='Stop';Add-Type -TypeDefinition $env:BRIDGE_PROFILE_SOURCE;" + (action === 'create' ? '[ProfileFixture]::Create($env:BRIDGE_PROFILE_NAME)' : '[ProfileFixture]::Remove($env:BRIDGE_PROFILE_NAME)');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: { ...process.env, BRIDGE_PROFILE_SOURCE: source, BRIDGE_PROFILE_NAME: profile } }).trim();
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
      // Simulate an interrupted Null grant intent that was never written.
      assert.equal((active.value as Lease & { version?: number }).version, 3);
      await writeFile(active.file, JSON.stringify({ ...active.value, controllerPid: process.pid, controllerStarted: 1, nullDeviceGrant: true }), 'utf8');
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

test('Windows cleanup revokes the owned SID after a child creates a hardlink', { skip: process.platform !== 'win32' }, async () => {
  await crashFixture(async ({ copy, state }) => {
    const seedPath = path.join(copy, 'seed.txt');
    await writeFile(seedPath, 'seed content');
    storedAcls([{ path: seedPath, mode: 'foreign' }]);
    const beforeSeedDacl = storedAcls([{ path: seedPath }])[0]!;
    assert.ok(beforeSeedDacl.includes('(A;;FR;;;S-1-5-21-1-2-3-4567)'), 'foreign ACE must exist before run');

    const lpacScript = "const fs=require('node:fs');fs.linkSync('seed.txt','alias.txt');process.stdout.write('hardlink-created');";
    const result = await executeWindowsTest({ executable: process.execPath, args: ['-e', lpacScript] }, copy, { ...settings, stateDirectory: state });

    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.aliasesDeleted, true, 'DOS aliases must be cleaned');
    assert.equal(result.profileDeleted, true, 'AppContainer profile must be deleted');
    assert.equal(result.output, 'hardlink-created');

    const aliasPath = path.join(copy, 'alias.txt');
    const afterSeedDacl = storedAcls([{ path: seedPath }])[0]!;
    const afterAliasDacl = storedAcls([{ path: aliasPath }])[0]!;

    assert.equal(afterSeedDacl, beforeSeedDacl, 'seed DACL must match exactly before the run');
    assert.equal(afterAliasDacl, beforeSeedDacl, 'alias DACL must match exactly before the run');

    const leaseDir = path.join(state, 'windows-lpac-leases');
    const leaseFiles = await readdir(leaseDir).catch(() => []);
    assert.equal(leaseFiles.filter(f => f.endsWith('.json')).length, 0, 'lease file must be deleted after verified cleanup');

    // Verify independent next run in a different owned copy sharing the same state directory
    const temp = await realpath(os.tmpdir());
    const secondCopy = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-copy-')));
    try {
      const nextResult = await executeWindowsTest({ executable: process.execPath, args: ['-e', "process.stdout.write('next run ok')"] }, secondCopy, { ...settings, stateDirectory: state });
      assert.equal(nextResult.exitCode, 0, nextResult.output);
      assert.equal(nextResult.output, 'next run ok');
    } finally {
      await removeOwned(secondCopy, 'agy-mcp-copy-');
    }

    // Verify preexisting hardlinks are still refused at admission
    const thirdCopy = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-copy-')));
    try {
      const pre1 = path.join(thirdCopy, 'pre1.txt');
      const pre2 = path.join(thirdCopy, 'pre2.txt');
      await writeFile(pre1, 'preexisting');
      await link(pre1, pre2);
      await assert.rejects(
        executeWindowsTest({ executable: process.execPath, args: ['-e', 'process.exit(0)'] }, thirdCopy, { ...settings, stateDirectory: state }),
        /hard links|INVALID_SANDBOX_PATH/
      );
    } finally {
      await removeOwned(thirdCopy, 'agy-mcp-copy-');
    }
  });
});

test('Windows recovery handles creating leases and missing SID cannot produce invalid cleanup-failed lease', { skip: process.platform !== 'win32' }, async () => {
  await crashFixture(async ({ copy, state }) => {
    const temp = await realpath(os.tmpdir());
    const scratch = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-scratch-')));
    const runtime = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-runtime-')));
    try {
      const nonce = randomUUID();
      const profile = 'agy.test.' + nonce.replace(/-/g, '');
      const leaseDirectory = path.join(state, 'windows-lpac-leases');
      await mkdir(leaseDirectory, { recursive: true });
      const leaseFile = path.join(leaseDirectory, nonce.replace(/-/g, '') + '.json');

      // 1. Legacy creating lease without SID but with real nonce-owned profile created
      const creatingLease = {
        version: 3,
        nonce,
        profile,
        sid: '',
        phase: 'creating',
        controllerPid: process.pid,
        controllerStarted: 1, // dead controller start time
        cwd: copy,
        runtime,
        scratch,
        grants: [],
        logon: '00000000.00000000',
        aliases: [
          { kind: 'copy', physicalRoot: copy, customName: 'AGY.TEST.' + nonce.toUpperCase() + '.COPY', drive: 'Z:', aliasRoot: 'Z:\\', customTarget: '\\??\\' + copy, driveTarget: '\\??\\AGY.TEST.' + nonce.toUpperCase() + '.COPY', volume: 0, fileIndexHigh: 0, fileIndexLow: 0 },
          { kind: 'runtime', physicalRoot: runtime, customName: 'AGY.TEST.' + nonce.toUpperCase() + '.RUNTIME', drive: 'Y:', aliasRoot: 'Y:\\', customTarget: '\\??\\' + runtime, driveTarget: '\\??\\AGY.TEST.' + nonce.toUpperCase() + '.RUNTIME', volume: 0, fileIndexHigh: 0, fileIndexLow: 0 },
          { kind: 'scratch', physicalRoot: scratch, customName: 'AGY.TEST.' + nonce.toUpperCase() + '.SCRATCH', drive: 'X:', aliasRoot: 'X:\\', customTarget: '\\??\\' + scratch, driveTarget: '\\??\\AGY.TEST.' + nonce.toUpperCase() + '.SCRATCH', volume: 0, fileIndexHigh: 0, fileIndexLow: 0 },
        ],
        nullDeviceGrant: false,
        jobCreated: false,
      };

      const sid1 = ownedProfile(profile, 'create');
      try {
        assert.equal(await profileExists(sid1), true);
        await writeFile(leaseFile, JSON.stringify(creatingLease), 'utf8');
        await recoverWindowsExecutions(state);
        assert.equal(await profileExists(sid1), false, 'creating lease without SID removes existing nonce-owned profile');
        await assert.rejects(readFile(leaseFile), { code: 'ENOENT' });
      } finally {
        ownedProfile(profile, 'remove');
      }

      // 2. Creating lease with persisted SID
      const nonce2 = randomUUID(), profile2 = 'agy.test.' + nonce2.replaceAll('-', '');
      const file2 = path.join(leaseDirectory, nonce2.replaceAll('-', '') + '.json');
      const sid2 = ownedProfile(profile2, 'create');
      try {
        assert.equal(await profileExists(sid2), true);
        const aliases = creatingLease.aliases.map(alias => {
          const customName = 'AGY.TEST.' + nonce2.toUpperCase() + '.' + alias.kind.toUpperCase();
          return { ...alias, customName, driveTarget: '\\??\\' + customName };
        });
        await writeFile(file2, JSON.stringify({ ...creatingLease, nonce: nonce2, profile: profile2, sid: sid2, aliases }), 'utf8');
        await recoverWindowsExecutions(state);
        assert.equal(await profileExists(sid2), false, 'creating recovery must remove only the owned profile');
        await assert.rejects(readFile(file2), { code: 'ENOENT' });
      } finally {
        ownedProfile(profile2, 'remove');
      }
    } finally {
      await removeOwned(scratch, 'agy-mcp-scratch-');
      await removeOwned(runtime, 'agy-mcp-runtime-');
    }
  });
});

test('Windows cleanup budget allows growth above admission limit and preserves foreign ACL', { skip: process.platform !== 'win32' }, async () => {
  const temp = await realpath(os.tmpdir());
  const compileDir = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-harness-compile-')));
  const runnerExe = path.join(compileDir, 'runner.exe');
  const harnessExe = path.join(compileDir, 'harness.exe');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  try {
    execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', '/nowarn:0649', '/out:' + runnerExe, path.resolve('native/windows-test-runner.cs')], { windowsHide: true });
    execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', '/nowarn:0649', '/out:' + harnessExe, path.resolve('tests/windows-alias-harness.cs')], { windowsHide: true });
    const output = execFileSync(harnessExe, [runnerExe, 'cleanup-growth'], { windowsHide: true, encoding: 'utf8' });
    assert.equal(output.trim(), '');
  } finally {
    await removeOwned(compileDir, 'agy-mcp-harness-compile-');
  }
});

test('Windows cleanup revokes the owned SID from post-grant final reparse point without following destination', { skip: process.platform !== 'win32' }, async () => {
  await crashFixture(async ({ copy, state, grant, ready, heartbeat }) => {
    let worker: ChildProcessWithoutNullStreams | undefined;
    let controllerDirectory: string | undefined;
    const temp = await realpath(os.tmpdir());
    const destination = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-destination-')));
    try {
      const destFile = path.join(destination, 'dest-file.txt');
      await writeFile(destFile, 'destination content');
      storedAcls([{ path: destination, mode: 'foreign' }, { path: destFile, mode: 'foreign' }]);

      const launched = await launchCrashWorker(copy, state, grant, ready, heartbeat);
      worker = launched.worker;
      controllerDirectory = path.dirname(launched.announcement.requestPath);
      await verifyControllerAnnouncement(launched.announcement, state);
      await eventually('LPAC command did not become ready', async () => (await readFile(ready, 'utf8').catch(() => undefined)) === 'ready' ? true : undefined);

      const active = await readLease(state);
      const sibling = path.join(grant, 'sibling.txt');
      await writeFile(sibling, 'sibling content');
      storedAcls([{ path: sibling, mode: 'foreign' }]);

      const junction = path.join(grant, 'junction-link');
      await symlink(destination, junction, 'junction');

      // Add ACE with the real active.value.sid to destination, destFile, and junction
      storedAcls([
        { path: destination, mode: active.value.sid },
        { path: destFile, mode: active.value.sid },
        { path: junction, mode: active.value.sid },
      ]);
      const beforeDestDirDacl = storedAcls([{ path: destination }])[0]!;
      const beforeDestFileDacl = storedAcls([{ path: destFile }])[0]!;
      const beforeJunctionDacl = storedAcls([{ path: junction }])[0]!;
      assert.ok(beforeDestDirDacl.includes(active.value.sid), 'destination intentionally has real execution SID');
      assert.ok(beforeDestFileDacl.includes(active.value.sid), 'destFile intentionally has real execution SID');
      assert.ok(beforeJunctionDacl.includes(active.value.sid), 'junction link has real execution SID');

      await stopController(worker, launched.announcement);
      worker = undefined;

      await freshRecovery(state);

      const afterDestDirDacl = storedAcls([{ path: destination }])[0]!;
      const afterDestFileDacl = storedAcls([{ path: destFile }])[0]!;
      assert.equal(afterDestDirDacl, beforeDestDirDacl, 'destination directory DACL must be untouched and preserve exact SDDL');
      assert.equal(afterDestFileDacl, beforeDestFileDacl, 'destination file DACL must be untouched and preserve exact SDDL');
      assert.ok(afterDestDirDacl.includes(active.value.sid), 'destination intentionally preserved the execution SID');
      assert.ok(afterDestFileDacl.includes(active.value.sid), 'destination file intentionally preserved the execution SID');

      const afterJunctionDacl = storedAcls([{ path: junction }])[0]!;
      assert.ok(!afterJunctionDacl.includes(active.value.sid), 'junction link must have owned execution SID removed');

      const siblingDacl = storedAcls([{ path: sibling }])[0]!;
      assert.ok(siblingDacl.includes('(A;;FR;;;S-1-5-21-1-2-3-4567)'), 'sibling foreign ACE preserved');
      assert.ok(!siblingDacl.includes(active.value.sid), 'owned SID removed from sibling');

      await assert.rejects(readFile(active.file));

      const preJunctionCopy = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-copy-')));
      try {
        await symlink(destination, path.join(preJunctionCopy, 'pre-junction'), 'junction');
        await assert.rejects(
          executeWindowsTest(
            { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
            preJunctionCopy,
            { ...settings, stateDirectory: state }
          ),
          /reparse point|INVALID_SANDBOX_PATH/
        );
      } finally {
        await removeOwned(preJunctionCopy, 'agy-mcp-copy-');
      }
    } finally {
      if (worker && worker.exitCode === null) worker.kill('SIGTERM');
      await removeOwned(destination, 'agy-mcp-destination-');
      await removeOwned(controllerDirectory, 'agy-mcp-controller-');
    }
  });
});

test('Windows test admission allows retry of terminal local-executor failure after native recovery while preserving prior failure', { skip: process.platform !== 'win32' }, async () => {
  const temp = await realpath(os.tmpdir());
  const repoDir = await realpath(await mkdtemp(path.join(temp, 'agy-retry-repo-')));
  const stateDir = await realpath(await mkdtemp(path.join(temp, 'agy-retry-state-')));
  execFileSync('git', ['init', '--quiet', repoDir]);
  await writeFile(path.join(repoDir, 'source.txt'), 'initial source');
  const startupLease = path.join(stateDir, 'windows-lpac-leases', 'initial-invalid.json');
  await mkdir(path.dirname(startupLease), { recursive: true });
  await writeFile(startupLease, 'invalid-initial-lease');
  const mockPath = path.resolve('tests/mock-agy.mjs');
  const config = loadConfig({ BRIDGE_ANTI_AI_CRAFT: 'off', 
    AGY_PATH: process.execPath,
    BRIDGE_TEST_EXECUTOR: 'windows-lpac',
    BRIDGE_STATE_DIRECTORY: stateDir,
    DEFAULT_TIMEOUT_SECONDS: '180',
    BRIDGE_WINDOWS_NODE_RUNTIME: process.env.BRIDGE_WINDOWS_NODE_RUNTIME,
    BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: process.env.BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY,
  });
  const adapter = new CliAdapter(config, [mockPath]);
  const tasks = new TaskManager(adapter, config);
  const until = async (taskId: string, timeout = 180000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const task = tasks.status(taskId);
      if (['completed', 'failed', 'cancelled', 'timeout'].includes(task.status)) return task;
      await pause(25);
    }
    throw new Error('Task did not finish: ' + JSON.stringify(tasks.status(taskId)));
  };
  try {
    await adapter.discover();
    const initTask = await tasks.run({ prompt: 'write:test', workingDirectory: repoDir });
    const initDone = await until(initTask.taskId);
    assert.equal(initDone.status, 'completed');
    const preview = await tasks.preview(initTask.taskId);

    const missingExe = path.join(temp, 'non-existent-executable-' + randomUUID() + '.exe');
    const failedTest = await tasks.startTests(initTask.taskId, preview.sha256, { executable: missingExe, args: [] }, 0, 120);
    const failedDone = await until(failedTest.taskId);
    assert.equal(failedDone.status, 'failed');
    assert.equal(failedDone.usageProvenance, 'local-executor');
    assert.equal(failedDone.error?.code, 'WINDOWS_EXECUTION_RECOVERY_FAILED');
    await rm(startupLease, { force: true });

    const validCommand = { executable: process.execPath, args: ['-e', "process.stdout.write('retry-success')"] };
    const retryAttempt = await tasks.startTests(failedDone.taskId, preview.sha256, validCommand, 0, 120);
    assert.notEqual(retryAttempt.taskId, failedDone.taskId, 'retry must create a new task attempt');
    assert.equal(retryAttempt.parentTaskId, failedDone.taskId, 'new attempt must record parentTaskId');

    const priorTask = tasks.status(failedDone.taskId);
    assert.equal(priorTask.status, 'failed', 'prior failed record must remain failed');
    assert.equal(priorTask.usageProvenance, 'local-executor');

    const retryDone = await until(retryAttempt.taskId);
    assert.equal(retryDone.status, 'completed', JSON.stringify(retryDone));
    assert.equal(retryDone.tests?.at(-1)?.output, 'retry-success');

    const secondFailure = await tasks.startTests(retryDone.taskId, preview.sha256, { executable: missingExe, args: [] }, 0, 120);
    const secondFailedDone = await until(secondFailure.taskId);
    assert.equal(secondFailedDone.status, 'failed');
    assert.equal(secondFailedDone.usageProvenance, 'local-executor');

    const leaseDir = path.join(stateDir, 'windows-lpac-leases');
    await mkdir(leaseDir, { recursive: true });
    const corruptLeaseFile = path.join(leaseDir, 'corrupt-lease.json');
    await writeFile(corruptLeaseFile, 'invalid-json-content', 'utf8');
    try {
      await assert.rejects(
        tasks.startTests(secondFailedDone.taskId, preview.sha256, validCommand, 0, 120),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal((err as { code?: string }).code, 'WINDOWS_EXECUTION_RECOVERY_FAILED');
          return true;
        }
      );
    } finally {
      await rm(corruptLeaseFile, { force: true });
    }

    const recovered = await tasks.startTests(secondFailedDone.taskId, preview.sha256, validCommand, 0, 120);
    assert.equal((await until(recovered.taskId)).status, 'completed');
    const modelTask = await tasks.run({ prompt: 'failure:test', workingDirectory: repoDir });
    const modelDone = await until(modelTask.taskId);
    assert.equal(modelDone.status, 'failed');
    assert.notEqual(modelDone.usageProvenance, 'local-executor');
    await assert.rejects(
      tasks.startTests(modelDone.taskId, (await tasks.preview(modelDone.taskId)).sha256, validCommand, 0, 120),
      { code: 'TASK_NOT_READY' }
    );

    const slowTask = await tasks.run({ prompt: 'cancel:test', workingDirectory: repoDir });
    await eventually('cancel fixture did not start', async () => ['running', 'streaming'].includes(tasks.status(slowTask.taskId).status) ? true : undefined, 180000);
    await tasks.cancel(slowTask.taskId);
    assert.equal((await until(slowTask.taskId)).status, 'cancelled');
    await assert.rejects(
      tasks.startTests(slowTask.taskId, (await tasks.preview(slowTask.taskId)).sha256, validCommand, 0, 120),
      { code: 'TASK_NOT_READY' }
    );
    const timed = await tasks.run({ prompt: 'timeout:test', workingDirectory: repoDir, timeoutSeconds: 1 });
    assert.equal((await until(timed.taskId)).status, 'timeout');
    await assert.rejects(tasks.startTests(timed.taskId, (await tasks.preview(timed.taskId)).sha256, validCommand, 0, 120), { code: 'TASK_NOT_READY' });
  } finally {
    await tasks.shutdown();
    await rm(startupLease, { force: true });
    for (const project of new Map(new StateStore(stateDir).load().filter(entry => entry.project).map(entry => [entry.project!.copyDirectory, entry.project!])).values()) await discardProjectCopy(project);
    await ownedTemporaryDirectory(repoDir, 'agy-retry-repo-');
    await ownedTemporaryDirectory(stateDir, 'agy-retry-state-');
    await rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});


test('Windows recovery retry refuses active leases until owned execution is cancelled', { skip: process.platform !== 'win32' }, async () => {
  await crashFixture(async ({ copy, state, ready }) => {
    const controller = new AbortController();
    const running = executeWindowsTest({ executable: process.execPath, args: ['-e', "require('node:fs').writeFileSync('ready.txt','ready');setInterval(()=>{},1000)"] }, copy,
      { ...settings, timeoutSeconds: 60, stateDirectory: state, signal: controller.signal })
      .then(result => ({ result, error: undefined }), error => ({ result: undefined, error: error as unknown }));
    try {
      await eventually('owned LPAC command did not become ready', async () => await readFile(ready, 'utf8').catch(() => '') === 'ready' ? true : undefined, 60000);
      const active = await readLease(state);
      await assert.rejects(recoverWindowsExecutions(state, { requireIdle: true }), error => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, 'WINDOWS_EXECUTION_RECOVERY_FAILED');
        assert.match(error.message, /Active Windows executions/);
        return true;
      });
      assert.equal((await readLease(state)).value.nonce, active.value.nonce);
      assert.equal(await profileExists(active.value.sid), true);
    } finally {
      controller.abort();
      const outcome = await running;
      if (outcome.error) throw outcome.error;
      assert.ok(outcome.result);
      assert.equal(outcome.result.error, 'Command cancelled');
      await recoverWindowsExecutions(state, { requireIdle: true });
    }
  });
});
