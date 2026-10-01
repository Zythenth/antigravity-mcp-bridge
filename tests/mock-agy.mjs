import { writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.2.11'); process.exit(0); }
if (args.includes('--help')) {
  console.log('--input-format stream-json\n--output-format stream-json\n--model\n--conversation\n--sandbox\n--mode (accept-edits, plan)\nmodels');
  process.exit(0);
}
if (args.includes('models')) {
  if (args.includes('auth')) { console.error('authentication required'); process.exit(1); }
  console.log('mock-pro\tMock Pro\nmock-flash\tMock Flash');
  process.exit(0);
}

if (!args.includes('--sandbox')) { console.error('sandbox flag required'); process.exit(2); }

let input = '';
for await (const chunk of process.stdin) input += chunk;
const prompt = JSON.parse(input.trim()).message.content;
const scenario = prompt.split(':')[0];
const conversationId = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : 'mock-conversation';
const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const result = (status = 'SUCCESS') => send({ event: 'result', result: { conversation_id: conversationId, status,
  response: prompt, usage: { input_tokens: 1, output_tokens: 2 }, ...(status === 'ERROR' ? { error: 'mock failure' } : {}) } });
send({ event: 'init', conversation_id: conversationId, init: { cwd: process.cwd(), model: args[args.indexOf('--model') + 1], args } });

if (scenario === 'crash') process.exit(7);
if (scenario === 'timeout' || scenario === 'cancel' || scenario === 'slow') {
  await new Promise(resolve => setTimeout(resolve, scenario === 'slow' ? 300 : 3000));
}
if (scenario === 'stderr') console.error('mock diagnostic');
if (scenario === 'malformed') process.stdout.write('not-json\n');
if (scenario === 'split') {
  const bytes = Buffer.from(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Olá' } }) + '\n');
  const accent = bytes.indexOf(Buffer.from('á'));
  process.stdout.write(bytes.subarray(0, accent + 1));
  await new Promise(resolve => setTimeout(resolve, 10));
  process.stdout.write(bytes.subarray(accent + 1));
  send({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'write_to_file' } });
  send({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'write_to_file' } });
}
if (scenario === 'write') writeFileSync(path.join(process.cwd(), 'AGY_BRIDGE_TEST.md'), 'Antigravity MCP bridge test successful.');
if (scenario === 'failure') { result('ERROR'); process.exit(1); }
result();
