import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// The packaged server spawns AGY_PATH directly; run the JavaScript fake through node instead.
const script = process.env.AGY_PATH;
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (command === script) return spawn.call(this, process.execPath, [script, ...args], options);
  return spawn.apply(this, arguments);
};
syncBuiltinESMExports();
