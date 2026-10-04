import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CliAdapter } from '../src/cli-adapter.js';
import { loadConfig } from '../src/config.js';

test('Windows commands resolve when an MCP client omits PATHEXT, preserving explicit values', { skip: process.platform !== 'win32' }, async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agy-environment-test-')));
  const executable = path.join(directory, 'bridge-environment-fixture.cmd');
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  const mockPath = fileURLToPath(new URL('../../tests/mock-agy.mjs', import.meta.url));
  try {
    await writeFile(executable, '@exit /b 0\r\n');
    assert.equal(getDefaultEnvironment().PATHEXT, undefined);
    process.env.PATH = directory + path.delimiter + (originalPath || '');
    for (const pathExt of [undefined, '.EXE;.CMD', '']) {
      if (pathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = pathExt;
      const adapter = new CliAdapter(loadConfig({ AGY_PATH: process.execPath }), [mockPath]);
      await adapter.discover();
      const child = adapter.spawnTask({ prompt: 'resolve-command:', workingDirectory: directory, timeoutSeconds: 30 }, undefined, directory);
      let output = '', diagnostics = '';
      child.stdout.on('data', chunk => { output += String(chunk); });
      child.stderr.on('data', chunk => { diagnostics += String(chunk); });
      const timer = setTimeout(() => child.kill(), 30000);
      let code;
      try {
        code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      } finally { clearTimeout(timer); }
      const events = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
      const lookup = JSON.parse(events.find(event => event.event === 'step_update').step_update.tool_info.output);
      assert.equal(code, pathExt === '' ? 1 : 0, JSON.stringify({ lookup, diagnostics }));
      assert.equal(lookup.exitCode, pathExt === '' ? 42 : 0);
      if (pathExt !== '') assert.equal(path.relative(executable, lookup.source), '');
      if (pathExt !== undefined) assert.equal(lookup.pathExt, pathExt);
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = originalPathExt;
    assert.equal(path.relative(await realpath(os.tmpdir()), path.dirname(directory)), '');
    assert.ok(path.basename(directory).startsWith('agy-environment-test-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
