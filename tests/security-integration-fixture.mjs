import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);

let reportPath;
const reportIdx = args.indexOf('--report');
if (reportIdx !== -1 && args[reportIdx + 1]) {
  reportPath = args[reportIdx + 1];
}

function recordObservation(op) {
  if (!reportPath) return;
  const observation = {
    op,
    hasThirdPartySecret: Boolean(process.env.THIRD_PARTY_SECRET),
    hasNodeOptions: Boolean(process.env.NODE_OPTIONS),
    hasAllowedVar: Boolean(process.env.MY_SAFE_EXTENSION_VAR),
    hasPath: Boolean(process.env.PATH),
    hasSystemRoot: process.platform === 'win32' ? Boolean(process.env.SystemRoot) : true,
    hasPathExt: process.platform === 'win32' ? Boolean(process.env.PATHEXT) : true,
  };
  try {
    appendFileSync(reportPath, JSON.stringify(observation) + '\n', 'utf8');
  } catch {
    // Non-fatal if report file write fails
  }
}

if (args.includes('--version')) {
  recordObservation('version');
  console.log('1.2.11');
  process.exit(0);
}

if (args.includes('--help')) {
  recordObservation('help');
  console.log('--input-format stream-json\n--output-format stream-json\n--model\n--conversation\n--sandbox\n--add-dir\n--new-project\n--json-schema\n--mode (accept-edits, plan)\nmodels');
  process.exit(0);
}

if (args.includes('models')) {
  recordObservation('models');
  console.log('mock-pro\tMock Pro\nmock-flash\tMock Flash');
  process.exit(0);
}

if (!args.includes('--sandbox')) {
  console.error('sandbox flag required');
  process.exit(2);
}

recordObservation('task');

let input = '';
for await (const chunk of process.stdin) input += chunk;
JSON.parse(input.trim());
const conversationId = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : 'mock-conversation';

const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');
send({ event: 'init', conversation_id: conversationId, init: { cwd: process.cwd(), args } });

const observation = {
  hasThirdPartySecret: Boolean(process.env.THIRD_PARTY_SECRET),
  hasNodeOptions: Boolean(process.env.NODE_OPTIONS),
  hasAllowedVar: Boolean(process.env.MY_SAFE_EXTENSION_VAR),
  hasPath: Boolean(process.env.PATH),
  hasSystemRoot: process.platform === 'win32' ? Boolean(process.env.SystemRoot) : true,
  hasPathExt: process.platform === 'win32' ? Boolean(process.env.PATHEXT) : true,
};

send({
  event: 'result',
  result: {
    conversation_id: conversationId,
    status: 'SUCCESS',
    response: JSON.stringify(observation),
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0 },
  },
});
