import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const [mode, root, moduleUrl] = process.argv.slice(2);
if (!path.isAbsolute(root) || path.relative(path.resolve(os.tmpdir()), path.dirname(path.resolve(root))) !== '' || !path.basename(root).startsWith('agy-state-lock-test-')) throw Error('Expected named temporary fixture root');
const primary = path.join(root, 'state', 'registry.lock'), write = fs.writeFileSync, remove = fs.rmSync;
let paused = false;
function pause(ready, go) {
  write(path.join(root, ready), '1');
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(root, go))) {
    if (Date.now() > deadline) throw Error('Fixture barrier expired');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
if (mode === 'b') fs.rmSync = (file, ...args) => {
  if (file === primary && !paused) { paused = true; pause('b-ready', 'b-go'); }
  return remove(file, ...args);
};
if (mode === 'a') fs.writeFileSync = (file, ...args) => {
  const result = write(file, ...args);
  if (file === primary && !paused) { paused = true; pause('a-ready', 'a-go'); }
  return result;
};
syncBuiltinESMExports();
const { StateStore } = await import(moduleUrl);
try {
  const release = new StateStore(path.join(root, 'state')).acquire('registry');
  release(); console.log(JSON.stringify({ status: 'success' }));
} catch (error) { console.log(JSON.stringify({ status: 'failed', code: error.code ?? 'FIXTURE_ERROR' })); }
