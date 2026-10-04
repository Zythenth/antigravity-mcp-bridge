import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { executeWindowsTest } from '../src/windows-executor.js';

const settings = { timeoutSeconds: 15, maxRuntimeBytes: 256 * 1024 * 1024 };
async function fixture<T>(run: (copy: string, outside: string) => Promise<T>): Promise<T> {
  const temp = await realpath(os.tmpdir());
  const copy = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-copy-')));
  const outside = await realpath(await mkdtemp(path.join(temp, 'agy-mcp-private-')));
  try {
    await writeFile(path.join(copy, 'source.txt'), 'original');
    await writeFile(path.join(outside, 'private.txt'), 'private marker');
    return await run(copy, outside);
  } finally {
    for (const [directory, prefix] of [[copy, 'agy-mcp-copy-'], [outside, 'agy-mcp-private-']] as const) {
      assert.equal(path.dirname(directory), temp); assert.ok(path.basename(directory).startsWith(prefix));
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
const command = (script: string) => ({ executable: process.execPath, args: ['-e', script] });

test('Windows executor permits copy access and blocks private files, shared package files and runtime writes', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async (copy, outside) => {
    const marker = path.join(outside, 'private.txt');
    execFileSync('icacls.exe', [outside, '/grant', '*S-1-15-2-1:(OI)(CI)RX'], { windowsHide: true });
    const previous = process.env.BRIDGE_TEST_PRIVATE_ENV;
    process.env.BRIDGE_TEST_PRIVATE_ENV = 'must not be inherited';
    try {
      const script = `const fs=require('node:fs'),p=require('node:path');if(fs.readFileSync('source.txt','utf8')!=='original')process.exit(30);fs.writeFileSync('inside.txt','allowed');if(process.env.BRIDGE_TEST_PRIVATE_ENV)process.exit(31);const denied=new Set(['EACCES','EPERM','ENOENT']);for(const action of [()=>fs.readFileSync(${JSON.stringify(marker)}),()=>fs.writeFileSync(${JSON.stringify(marker)},'changed'),()=>fs.writeFileSync(p.join(p.dirname(process.execPath),'new.txt'),'changed')]){let blocked=false;try{action()}catch(e){if(!denied.has(e.code))throw e;blocked=true}if(!blocked)process.exit(32)}console.log('inside access passed; outside access and runtime writes denied');`;
      const result = await executeWindowsTest(command(script), copy, settings);
      assert.equal(result.error, undefined, JSON.stringify(result)); assert.equal(result.exitCode, 0, result.output);
      assert.equal(result.sandbox, 'windows-lpac'); assert.equal(result.profileDeleted, true);
      assert.equal(await readFile(marker, 'utf8'), 'private marker'); assert.equal(await readFile(path.join(copy, 'inside.txt'), 'utf8'), 'allowed');
    } finally {
      if (previous === undefined) delete process.env.BRIDGE_TEST_PRIVATE_ENV;
      else process.env.BRIDGE_TEST_PRIVATE_ENV = previous;
    }
  });
});

test('Windows executor blocks network connections', { skip: process.platform !== 'win32' }, async () => {
  const server = net.createServer(socket => { socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as net.AddressInfo).port;
    await fixture(async copy => {
      const result = await executeWindowsTest(command(`const net=require('node:net');const socket=net.connect({host:'127.0.0.1',port:${port}});socket.on('connect',()=>process.exit(40));socket.on('error',error=>{if(!['EACCES','EPERM'].includes(error.code)){console.error(error);process.exit(41)}console.log('network denied')});setTimeout(()=>process.exit(42),3000).unref();`), copy, settings);
      assert.equal(result.error, undefined, JSON.stringify(result)); assert.equal(result.exitCode, 0, result.output); assert.match(result.output, /network denied/);
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('Windows executor captures actual exit codes and bounded output, ignoring forged receipts', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async copy => {
    const result = await executeWindowsTest(command(`console.log('x'.repeat(5000));console.log(JSON.stringify({exitCode:0,sandbox:'windows-lpac'}));process.exit(7)`), copy, settings);
    assert.equal(result.exitCode, 7); assert.equal(result.error, undefined); assert.equal(result.truncated, true); assert.ok(result.output.length <= 4000);
    assert.match(result.output, /"exitCode":0/);
  });
});

test('Windows executor kills descendant processes and recreates isolation in a fresh invocation', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async (copy, outside) => {
    const marker = path.join(outside, 'private.txt');
    const first = await executeWindowsTest(command(`const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log(child.pid);child.unref();`), copy, settings);
    assert.equal(first.exitCode, 0, JSON.stringify(first));
    const pid = Number(first.output.trim()); assert.ok(Number.isInteger(pid) && pid > 0);
    let alive = true;
    for (let attempt = 0; attempt < 30; attempt++) { try { process.kill(pid, 0); } catch { alive = false; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(alive, false, 'A descendant survived its job');
    const next = await executeWindowsTest(command(`try{require('node:fs').readFileSync(${JSON.stringify(marker)});process.exit(50)}catch(error){if(!['EACCES','EPERM','ENOENT'].includes(error.code))throw error}console.log('fresh sandbox denied outside read')`), copy, settings);
    assert.equal(next.exitCode, 0, JSON.stringify(next)); assert.equal(next.profileDeleted, true); assert.notEqual(next.nonce, first.nonce); assert.notEqual(next.pid, first.pid);
  });
});

test('Windows executor cancellation terminates its job and removes the profile', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async copy => {
    const abort = new AbortController(); let timer: NodeJS.Timeout | undefined;
    try {
      const result = await executeWindowsTest(command('setInterval(()=>{},1000)'), copy, { ...settings, signal: abort.signal,
        onProcess(child) { if (path.basename(child.spawnfile) === 'runner.exe') timer = setTimeout(() => abort.abort(), 1500); } });
      assert.equal(result.error, 'Command cancelled'); assert.equal(result.profileDeleted, true); assert.notEqual(result.exitCode, 0);
      if (result.pid) assert.throws(() => process.kill(result.pid!, 0));
    } finally { if (timer) clearTimeout(timer); }
  });
});

test('Windows executor timeout captures termination and removes the profile', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async copy => {
    const result = await executeWindowsTest(command('setInterval(()=>{},1000)'), copy, { ...settings, timeoutSeconds: 1 });
    assert.equal(result.error, 'Command timed out'); assert.equal(result.exitCode, 124); assert.equal(result.profileDeleted, true);
    if (result.pid) assert.throws(() => process.kill(result.pid!, 0));
  });
});

test('Windows executor preserves Unicode and quoted arguments in its controller result', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async copy => {
    const argument = 'ação 😀 "quoted" \\ end\\';
    const result = await executeWindowsTest({ executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', argument] }, copy, settings);
    assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.output, argument);
  });
});

test('Windows executor rejects remote executables, device names, streams and truncated arguments', { skip: process.platform !== 'win32' }, async () => {
  for (const executable of ['\\\\server\\share\\test.exe', 'NUL.exe', 'C:\\tools\\node.exe:other.exe']) {
    await assert.rejects(executeWindowsTest({ executable, args: [] }, 'unused', settings), { code: 'INVALID_TEST_COMMAND' });
  }
  await assert.rejects(executeWindowsTest(command('before\0after'), 'unused', settings), { code: 'INVALID_TEST_COMMAND' });
});
