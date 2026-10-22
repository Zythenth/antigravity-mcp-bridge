// Synthetic CLI that streams credential-shaped values across every retained output channel.
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.3.2'); process.exit(0); }
if (args.includes('--help')) {
  console.log('--input-format stream-json\n--output-format stream-json\n--model\n--conversation\n--sandbox\n--add-dir\n--new-project\n--json-schema\n--mode (accept-edits, plan)\nmodels');
  process.exit(0);
}
if (args.includes('models')) { console.log('mock-pro\tMock Pro'); process.exit(0); }

const token = 'gh' + 'p_' + 'D'.repeat(36);
const key = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const emit = value => console.log(JSON.stringify(value));
// Piped stdout is asynchronous; exiting before it drains would drop the final frames.
const exitAfterFlush = code => process.stdout.write('', () => process.exit(code));
const scenario = args.includes('--scenario') ? args[args.indexOf('--scenario') + 1] : '';
process.stdin.resume();
process.stdin.once('data', () => {
  const delta = (step_index, text_delta) => emit({ event: 'step_update', step_update: { step_index, step_type: 'agent_response', state: 'ACTIVE', text_delta } });
  if (scenario === 'long-line') {
    delta(1, 'head\n' + 'x'.repeat(8190) + '!' + token.slice(0, 4));
    delta(1, token.slice(4) + ' Bearer ' + 'v'.repeat(9000));
    delta(1, 'v'.repeat(9000) + ' end\nnext line ok\n');
  } else if (scenario === 'key-across-steps') {
    delta(1, 'intro\n' + key + '\nMIIEfirstbody');
    for (let step = 2; step <= 18; step++) delta(step, 'unfinished ' + step);
    delta(1, 'MIIEsecondbody\n-----END PRIVATE KEY-----\nafter key\n');
  } else if (scenario === 'key-after-long-line') {
    delta(1, 'x'.repeat(8193) + key);
    delta(1, '\nMIIEhiddenbody\n-----END PRIVATE KEY-----\nafter\n');
    for (const half of [token.slice(0, 20), token.slice(20)]) {
      emit({ event: 'step_update', step_update: { step_index: '2', step_type: 'agent_response', state: 'ACTIVE', text_delta: half } });
    }
  } else if (scenario === 'step-limit') {
    for (let step = 1; step <= 1000; step++) emit({ event: 'step_update', step_update: { step_index: step, step_type: 'agent_response', state: 'DONE', text_delta: 'ok\n' } });
    delta(1001, key + '\n');
    delta(1001, 'MIIEoverflowbody\n');
  } else if (scenario === 'escaped-message') {
    // The JSON escape hides the token from text redaction until the envelope body is decoded.
    const body = JSON.stringify({ kind: 'question', text: 'use ' + token }).replace('gh', '\\u0067h');
    delta(1, '<antigravity-message>' + body + '</antigravity-message>\n');
  } else if (scenario === 'headless-key') {
    const end = ['-----END', 'PRIVATE KEY-----'].join(' ');
    delta(1, 'intro\nMIIEheadlessaaaaaaaaaa\nMIIEheadlessbbbbbbbbbb\n');
    delta(1, end + '\nafter\n');
    emit({ event: 'step_update', step_update: { step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: 'MIIEsameframeaaaaaaaaa\n' + end + '\n' } });
    delta(3, 'deadbeefdeadbeefdeadbeef\nordinary text\n');
    // Terminator split across frames after a complete body, and a short final body line.
    delta(4, 'MIIEsplitterminatoraaaa\nMIIEshorttailbbbbbbbbbbbbb\nAQ==\n');
    delta(4, '-----END PRIVATE');
    delta(4, ' KEY-----\nclosing\n');
    // A body longer than the hold limit is dropped, including its short final line.
    delta(5, ('MIIEoverflow' + 'A'.repeat(52) + '\n').repeat(101));
    delta(5, 'AQ==\n' + end + '\nbye\n');
  } else if (scenario === 'no-result') {
    delta(1, 'Diagnostic before failure ' + token);
    return exitAfterFlush(1);
  } else if (scenario === 'message-tail') {
    delta(1, '<antigravity-message>{"kind":"question","text":"Which branch?"}</antigravity-message>');
  }
  if (scenario) {
    emit({ event: 'result', result: { status: 'SUCCESS', response: 'done' } });
    return exitAfterFlush(0);
  }
  emit({ event: 'init', conversation_id: 'redaction-conv', init: { note: 'starting ' + token } });
  const response = (text, state = 'ACTIVE') => emit({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state, text_delta: text } });
  response('Report: ' + token.slice(0, 20));
  response(token.slice(20) + ' done\nKey follows\n' + key + '\nMIIEsyntheticbody');
  response('line\n-----END PRIVATE KEY-----\ntail without newline ' + token.slice(0, 10));
  response(token.slice(10), 'DONE');
  emit({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'read_file', tool_info: { output: 'file says ' + token + ' MIIEheadlessbody\n' + ['-----END', 'PRIVATE KEY-----'].join(' ') } } });
  // Deeper than JSON.stringify and structuredClone can handle; written by hand for the same reason.
  console.log('{"event":"note","nested":' + '['.repeat(20000) + JSON.stringify(token) + ']'.repeat(20000) + '}');
  emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'redaction-conv', response: 'final ' + token, structured_output: { summary: 'summary ' + token } } });
  exitAfterFlush(0);
});
