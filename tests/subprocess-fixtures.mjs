import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const scenario = process.env.TEST_SCENARIO || (args.includes('--scenario') ? args[args.indexOf('--scenario') + 1] : '');

if (args.includes('--version')) {
  if (scenario === 'version-fail') {
    console.error('synthetic failure');
    process.exit(9);
  }
  if (scenario === 'empty-version') {
    process.exit(0);
  }
  if (scenario === 'signal-version') {
    process.kill(process.pid, 'SIGTERM');
  }
  console.log('1.3.2');
  process.exit(0);
}

if (args.includes('--help')) {
  if (scenario === 'help-fail') {
    console.error('synthetic help failure');
    process.exit(2);
  }
  if (scenario === 'empty-help') {
    process.exit(0);
  }
  if (scenario === 'incompatible-help') {
    console.log('unrelated-command\n--foo\n--bar');
    process.exit(0);
  }
  console.log('--input-format stream-json\n--output-format stream-json\n--model\n--conversation\n--sandbox\n--add-dir\n--new-project\n--json-schema\n--mode (accept-edits, plan)\nmodels');
  process.exit(0);
}

if (args.includes('models')) {
  console.log('mock-pro\tMock Pro\nmock-flash\tMock Flash');
  process.exit(0);
}

if (scenario === 'startup-fail') {
  console.error('startup fatal failure');
  process.exit(127);
}

if (scenario === 'posix-descendant-hang') {
  spawn(process.execPath, ['-e', 'const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync("descendant-ready.txt", "ready\\n"); setInterval(() => {}, 1000);'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const cleanup = () => { process.exit(0); };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (scenario === 'early-exit-epipe' || scenario === 'immediate-exit') {
  // Controlled closed stdin plus fake success output and exit
  process.stdin.destroy();
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'fake success' } }));
  process.exit(0);
}

if (scenario === 'result-with-secret-error') {
  console.log(JSON.stringify({
    event: 'result',
    result: {
      status: 'FAILED',
      error: 'Failure with token AIzaSyD12345678901234567890123456789012',
    },
  }));
  process.exit(1);
}

if (scenario === 'stderr-private-key') {
  process.stderr.write('before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0sensitive\n-----END RSA PRIVATE KEY-----\nafter\n');
  process.exit(1);
}

if (scenario === 'modify-copy-hang') {
  // Simulate partial edits before cancellation/timeout in read-only mode
  try {
    writeFileSync('source.txt', 'mutated content by plan mode\n');
  } catch { /* ignore */ }
  const timer = setInterval(() => {}, 1000);
  const cleanup = () => { clearInterval(timer); process.exit(0); };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  await new Promise(() => {});
}

if (scenario === 'hang') {
  // Keep active event-loop handle until cleanly terminated by parent
  const timer = setInterval(() => {}, 1000);
  const cleanup = () => { clearInterval(timer); process.exit(0); };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  await new Promise(() => {});
}

if (scenario === 'signal-task') {
  console.log(JSON.stringify({ event: 'init', conversation_id: 'signal-conv', init: {} }));
  process.kill(process.pid, 'SIGTERM');
}

if (scenario === 'final-stderr-no-newline') {
  for await (const _ of process.stdin) {}
  process.stderr.write('synthetic fatal crash without newline');
  process.exit(42);
}

if (scenario === 'malformed-stream-json') {
  for await (const _ of process.stdin) {}
  console.log(JSON.stringify({ event: 'init', conversation_id: 'malformed-conv', init: {} }));
  console.log('{corrupted-json-line');
  process.exit(0);
}

if (scenario === 'incomplete-result-exit-zero') {
  for await (const _ of process.stdin) {}
  console.log(JSON.stringify({ event: 'init', conversation_id: 'incomplete-conv', init: {} }));
  process.exit(0);
}

if (scenario === 'result-non-success-status') {
  for await (const _ of process.stdin) {}
  console.log(JSON.stringify({ event: 'init', conversation_id: 'nonsuccess-conv', init: {} }));
  console.log(JSON.stringify({
    event: 'result',
    result: {
      status: 'FAILED',
      error: 'Upstream generation rejected',
    },
  }));
  process.exit(0);
}

// Default normal execution: consume stdin, echo user message and report SUCCESS
let input = '';
for await (const chunk of process.stdin) input += chunk;
const prompt = JSON.parse(input.trim()).message.content;
const conversationId = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : 'mock-conversation';

console.log(JSON.stringify({ event: 'init', conversation_id: conversationId, init: { cwd: process.cwd(), args } }));
console.log(JSON.stringify({
  event: 'result',
  result: {
    conversation_id: conversationId,
    status: 'SUCCESS',
    response: prompt,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0 },
  },
}));
process.exit(0);
