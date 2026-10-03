import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.2.11'); process.exit(0); }
if (args.includes('--help')) {
  console.log('--input-format stream-json\n--output-format stream-json\n--model\n--conversation\n--sandbox\n--add-dir\n--new-project\n--json-schema\n--mode (accept-edits, plan)\nmodels');
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
const schema = args.includes('--json-schema') ? JSON.parse(args[args.indexOf('--json-schema') + 1]) : undefined;
const report = schema?.properties.reviewedFiles ? {
  summary: 'Fixture review', reviewedFiles: ['source.txt'], findings: [{ severity: 'P2', path: 'source.txt', line: 1,
    quote: scenario === 'fabricated-review' ? 'invented source' : 'source', message: 'Fixture finding', impact: 'Fixture impact', suggestion: 'Fixture suggestion' }], unverified: [],
} : schema ? { summary: 'Fixture plan', steps: [{ description: 'Inspect source', files: ['source.txt'], verification: 'Check requested behavior' }], unverified: ['Runtime not tested'] } : undefined;
if (scenario === 'comparison' && report?.findings && args[args.indexOf('--model') + 1] === 'mock-flash') {
  report.findings[0].severity = 'P3';
  report.findings[0].message = 'Flash interpretation';
}
const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const result = (status = 'SUCCESS') => send({ event: 'result', result: { conversation_id: conversationId, status,
  response: prompt, usage: { input_tokens: args.includes('--conversation') ? 2 : 1, output_tokens: args.includes('--conversation') ? 4 : 2,
    total_tokens: args.includes('--conversation') ? 6 : 3, thinking_tokens: 0, cache_read_tokens: 0 },
  ...(report ? { structured_output: report } : {}), ...(status === 'ERROR' ? { error: 'mock failure' } : {}) } });
send({ event: 'init', conversation_id: conversationId, init: { cwd: process.cwd(), model: args[args.indexOf('--model') + 1], args } });
const nativeTest = prompt.match(/<bridge-test-command>(.*?)<\/bridge-test-command>/s);
if (nativeTest && !args.includes('no-test-events')) {
  const request = JSON.parse(nativeTest[1]);
  for (let index = 0; index < request.maxAttempts; index++) {
    const output = execSync(request.commandLine, { cwd: process.cwd(), encoding: 'utf8', windowsHide: true,
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh' });
    send({ event: 'step_update', step_update: { step_index: index, state: 'DONE', step_type: 'tool', tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: request.commandLine }, output } } });
    const encoded = output.trim().split('\n').at(-1).split(':').at(-1);
    if (JSON.parse(Buffer.from(encoded, 'base64').toString()).exitCode === 0) break;
    if (request.maxAttempts > 1) writeFileSync('source.txt', 'fixed');
  }
}

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
if (scenario === 'write-many') {
  writeFileSync(path.join(process.cwd(), 'one.txt'), 'one');
  writeFileSync(path.join(process.cwd(), 'two.txt'), 'two');
}
if (scenario === 'failure') { result('ERROR'); process.exit(1); }
result();
