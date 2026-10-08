import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { executeWindowsTest } from '../src/windows-executor.js';

const runtime = loadConfig();
const settings = { timeoutSeconds: 15, maxRuntimeBytes: 256 * 1024 * 1024,
  windowsNodeRuntime: runtime.windowsNodeRuntime, portableNodeCacheDirectory: runtime.windowsNodeCacheDirectory };
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

test('Windows executor protects the captured default runtime cache when options omit its path', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async (copy, outside) => {
    const cache = path.join(outside, 'runtime-cache');
    const executable = path.join(copy, 'native-fixture.exe');
    await mkdir(cache);
    await copyFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), executable);
    const before = execFileSync('icacls.exe', [outside], { windowsHide: true, encoding: 'utf8' });
    const executorUrl = new URL('../src/windows-executor.js', import.meta.url).href;
    const script = "import assert from 'node:assert/strict';import { executeWindowsTest } from " + JSON.stringify(executorUrl) + ";" +
      "const fixture=JSON.parse(process.argv[1]);for(const right of ['readPaths','writePaths']){" +
      "await assert.rejects(executeWindowsTest({executable:fixture.executable,args:[]},fixture.copy,{" +
      "timeoutSeconds:15,maxRuntimeBytes:268435456,stateDirectory:fixture.state," +
      "sandbox:{readPaths:[],writePaths:[],network:false,childProcesses:true,maxOutputChars:4000,[right]:[fixture.outside]}})," +
      "{code:'SANDBOX_PATH_PROTECTED'});}console.log('default runtime cache protected');";
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script,
      JSON.stringify({ copy, outside, executable, state: path.join(copy, 'state') })], {
      windowsHide: true, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, BRIDGE_WINDOWS_NODE_RUNTIME: 'portable', BRIDGE_WINDOWS_NODE_CACHE_DIRECTORY: cache },
    });
    assert.match(output, /default runtime cache protected/);
    assert.equal(execFileSync('icacls.exe', [outside], { windowsHide: true, encoding: 'utf8' }), before);
    assert.equal(await readFile(path.join(outside, 'private.txt'), 'utf8'), 'private marker');
  });
});

test('Windows executor permits copy access and blocks private files, shared package files and runtime writes', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async (copy, outside) => {
    const marker = path.join(outside, 'private.txt');
    execFileSync('icacls.exe', [outside, '/grant', '*S-1-15-2-1:(OI)(CI)RX'], { windowsHide: true });
    const previous = process.env.BRIDGE_TEST_PRIVATE_ENV;
    process.env.BRIDGE_TEST_PRIVATE_ENV = 'must not be inherited';
    try {
      const script = `const fs=require('node:fs'),p=require('node:path');if(fs.readFileSync('source.txt','utf8')!=='original')process.exit(30);fs.writeFileSync('inside.txt','allowed');if(process.env.BRIDGE_TEST_PRIVATE_ENV)process.exit(31);const denied=new Set(['EACCES','EPERM','ENOENT']);for(const action of [()=>fs.readFileSync(${JSON.stringify(marker)}),()=>fs.writeFileSync(${JSON.stringify(marker)},'changed'),()=>fs.writeFileSync(p.join(p.dirname(process.execPath),'new.txt'),'changed')]){let blocked=false;try{action()}catch(e){if(!denied.has(e.code))throw e;blocked=true}if(!blocked)process.exit(32)}console.error('isolated stderr captured');console.log('inside access passed; outside access and runtime writes denied');`;
      const result = await executeWindowsTest(command(script), copy, settings);
      assert.equal(result.error, undefined, JSON.stringify(result)); assert.equal(result.exitCode, 0, result.output);
      assert.equal(result.sandbox, 'windows-lpac'); assert.equal(result.profileDeleted, true); assert.match(result.output, /isolated stderr captured/);
      assert.equal(await readFile(marker, 'utf8'), 'private marker'); assert.equal(await readFile(path.join(copy, 'inside.txt'), 'utf8'), 'allowed');
    } finally {
      if (previous === undefined) delete process.env.BRIDGE_TEST_PRIVATE_ENV;
      else process.env.BRIDGE_TEST_PRIVATE_ENV = previous;
    }
  });
});

test('Windows executor freezes selected external read and write grants and restores exact ACLs', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async (copy, outside) => {
    const readable = path.join(outside, 'readable.txt');
    const writable = path.join(outside, 'writable');
    const unrelated = path.join(outside, 'private.txt');
    await writeFile(readable, 'permitted read');
    await (await import('node:fs/promises')).mkdir(writable);
    const before = execFileSync('icacls.exe', [readable], { windowsHide: true, encoding: 'utf8' });
    const script = "const fs=require('node:fs'),p=require('node:path');" +
      "if(fs.readFileSync(" + JSON.stringify(readable) + ",'utf8')!=='permitted read')process.exit(60);" +
      "fs.writeFileSync(p.join(" + JSON.stringify(writable) + ",'created.txt'),'permitted write');" +
      "for(const action of [()=>fs.writeFileSync(" + JSON.stringify(readable) + ",'denied'),()=>fs.readFileSync(" + JSON.stringify(unrelated) + ")]){" +
      "let denied=false;try{action()}catch(error){denied=['EACCES','EPERM','ENOENT'].includes(error.code)}if(!denied)process.exit(61)}console.log('external grants enforced');";
    const result = await executeWindowsTest(command(script), copy, { ...settings, sandbox: { readPaths: [readable], writePaths: [writable], network: false, childProcesses: true, maxOutputChars: 4000 } });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(await readFile(path.join(writable, 'created.txt'), 'utf8'), 'permitted write');
    assert.equal(await readFile(readable, 'utf8'), 'permitted read');
    assert.equal(execFileSync('icacls.exe', [readable], { windowsHide: true, encoding: 'utf8' }), before, 'read ACL must be restored exactly');
  });
});

test('Windows executor gives read-only copies a separate writable scratch directory', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async copy => {
    const script = "const fs=require('node:fs'),p=require('node:path');let denied=false;try{fs.writeFileSync('source.txt','changed')}catch(error){denied=['EACCES','EPERM'].includes(error.code)}if(!denied)process.exit(70);fs.writeFileSync(p.join(process.env.TEMP,'scratch.txt'),'scratch');console.log('read-only copy enforced');";
    const result = await executeWindowsTest(command(script), copy, { ...settings, mode: 'read-only' });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(await readFile(path.join(copy, 'source.txt'), 'utf8'), 'original');
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

test('Windows executor permits or denies real Node child creation according to the selected job limit', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async copy => {
    const marker = path.join(copy, 'child-marker.txt');
    const script = "const fs=require('node:fs'),cp=require('node:child_process');console.log('main-started');const args=['-e'," + JSON.stringify("require('node:fs').writeFileSync(" + JSON.stringify(marker) + ",'child')") + "];const results=Array.from({length:3},()=>cp.spawnSync(process.execPath,args,{stdio:'inherit'}));console.log('spawn-status='+results.map(r=>r.status).join(','));console.log('spawn-errors='+results.map(r=>r.error&&r.error.code).join(','));console.log('continue-after-spawn');";
    const allowed = await executeWindowsTest(command(script), copy, { ...settings, sandbox: { readPaths: [], writePaths: [], network: false, childProcesses: true, maxOutputChars: 4000 } });
    assert.equal(allowed.exitCode, 0, JSON.stringify(allowed)); assert.match(allowed.output, /main-started[\s\S]*continue-after-spawn/); assert.equal(await readFile(marker, 'utf8'), 'child');
    await rm(marker);
    const denied = await executeWindowsTest(command(script), copy, { ...settings, sandbox: { readPaths: [], writePaths: [], network: false, childProcesses: false, maxOutputChars: 4000 } });
    assert.equal(denied.exitCode, 0, JSON.stringify(denied)); assert.match(denied.output, /main-started[\s\S]*continue-after-spawn/); assert.match(denied.output, /spawn-status=,,/); assert.match(denied.output, /spawn-errors=UNKNOWN,UNKNOWN,UNKNOWN/); await assert.rejects(readFile(marker));
  });
});

test('Windows executor captures Node child default stdin, stdout, and stderr pipes', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async copy => {
    const hostNode = process.execPath;
    const childInput = 'input through pipe';
    const childScript = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{if(input!==" + JSON.stringify(childInput) + ")process.exit(74);process.stdout.write('child stdout\\n');process.stderr.write('child stderr\\n')})";
    const script = "const cp=require('node:child_process'),p=require('node:path');" +
      "if(p.resolve(process.execPath).toLowerCase()===p.resolve(" + JSON.stringify(hostNode) + ").toLowerCase())process.exit(75);" +
      "process.stdout.write('parent stdout before spawn\\n');process.stderr.write('parent stderr before spawn\\n');" +
      "const child=cp.spawnSync(process.execPath,['-e'," + JSON.stringify(childScript) + "],{encoding:'utf8',input:" + JSON.stringify(childInput) + "});" +
      "if(child.error)throw child.error;if(child.status!==0)process.exit(76);" +
      "if(child.stdout!=='child stdout\\n'||child.stderr!=='child stderr\\n')process.exit(77);" +
      "process.stdout.write('captured child stdout='+JSON.stringify(child.stdout)+'\\n');process.stderr.write('captured child stderr='+JSON.stringify(child.stderr)+'\\n');" +
      "process.stdout.write('parent stdout after spawn\\n');process.stderr.write('parent stderr after spawn\\n');";
    const result = await executeWindowsTest(command(script), copy, settings);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.match(result.output, /parent stdout before spawn/);
    assert.match(result.output, /parent stderr before spawn/);
    assert.match(result.output, /captured child stdout="child stdout\\n"/);
    assert.match(result.output, /captured child stderr="child stderr\\n"/);
    assert.match(result.output, /parent stdout after spawn/);
    assert.match(result.output, /parent stderr after spawn/);
  });
});

test('Windows LPAC permits LOCAL named-pipe endpoints but blocks the global endpoints in installed libuv', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async copy => {
    const probeDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-pipe-probe-')));
    const probe = path.join(probeDirectory, 'pipe-probe.exe');
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    try {
      execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/out:' + probe, path.resolve('tests/windows-pipe-fixture.cs')], { windowsHide: true });
      const result = await executeWindowsTest({ executable: probe, args: [] }, copy, settings);
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.match(result.output, /packageDacl=AccessAllowed:None:0x[0-9a-f]{8}/i);
      assert.match(result.output, /globalStdinCreate=5/);
      assert.match(result.output, /globalStdoutCreate=5/);
      assert.match(result.output, /LOCAL\\StdinOpen=0/);
      assert.match(result.output, /LOCAL\\StdoutOpen=0/);
    } finally {
      assert.equal(path.dirname(probeDirectory), await realpath(os.tmpdir()));
      assert.ok(path.basename(probeDirectory).startsWith('agy-mcp-pipe-probe-'));
      await rm(probeDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

test('Windows executor captures actual exit codes and bounded output, ignoring forged receipts', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async copy => {
    const result = await executeWindowsTest(command(`console.log('x'.repeat(5000));console.log(JSON.stringify({exitCode:0,sandbox:'windows-lpac'}));process.exit(7)`), copy, settings);
    assert.equal(result.exitCode, 7); assert.equal(result.error, undefined); assert.equal(result.truncated, true); assert.ok(result.output.length <= 4000);
    assert.match(result.output, /"exitCode":0/);
  });
});

test('Windows executor carries a 64000-character control output receipt without trusting child JSON', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async copy => {
    const result = await executeWindowsTest(command("process.stdout.write('\\0'.repeat(64000));console.log(JSON.stringify({exitCode:0,sandbox:'forged'}));process.exit(7)"), copy, {
      ...settings, sandbox: { readPaths: [], writePaths: [], network: false, childProcesses: true, maxOutputChars: 64000 },
    });
    assert.equal(result.exitCode, 7, JSON.stringify(result));
    assert.equal(result.output.length, 64000);
    assert.equal(result.truncated, true);
    assert.equal(result.profileDeleted, true);
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
    const abort = new AbortController(), marker = path.join(copy, 'ready.txt');
    const script = "const fs=require('node:fs');fs.writeFileSync('ready.tmp',String(process.pid));fs.renameSync('ready.tmp','ready.txt');setInterval(()=>{},1000);";
    const execution = executeWindowsTest(command(script), copy, { ...settings, signal: abort.signal });
    let waiting = true;
    const ready = (async () => {
      const deadline = Date.now() + 30000;
      while (waiting && Date.now() < deadline) {
        const value = await readFile(marker, 'utf8').catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return undefined;
        });
        if (value !== undefined) {
          const pid = Number(value);
          assert.ok(Number.isInteger(pid) && pid > 0, 'Sandbox readiness marker must contain its PID');
          process.kill(pid, 0);
          abort.abort();
          return pid;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Sandbox command did not write its readiness marker before cancellation');
    })();
    try {
      const [result, pid] = await Promise.all([execution, ready]);
      assert.equal(result.error, 'Command cancelled'); assert.equal(result.profileDeleted, true); assert.notEqual(result.exitCode, 0);
      assert.equal(result.aliasesDeleted, true); assert.equal(result.pid, pid);
      assert.throws(() => process.kill(pid, 0));
      for (const mapping of result.pathMappings.filter(mapping => mapping.kind !== 'copy')) {
        await assert.rejects(lstat(mapping.physicalRoot), { code: 'ENOENT' });
      }
    } finally {
      waiting = false; abort.abort();
      await Promise.allSettled([execution, ready]);
    }
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
