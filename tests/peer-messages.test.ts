import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../src/types.js';
import {
  peerMessageInputSchema,
  peerRoutesSchema,
  validatePeerRoutes,
  isPeerRouteAllowed,
  extractPeerMessages,
  MAX_PEER_SCAN_CHARS,
  MAX_PEER_PAYLOAD_CHARS,
} from '../src/peer-messages.js';

const fixtureGraph = {
  nodes: [
    { key: 'alpha', owner: 'lead', dependsOn: [] },
    { key: 'beta', owner: 'worker', dependsOn: ['alpha'] },
    { key: 'gamma', owner: 'reviewer', dependsOn: ['alpha'] },
  ],
};

test('1. directed routes allow selected forward edge and deny reverse or implicit broadcast', () => {
  const routes = [{ from: 'alpha', to: 'beta' }];
  assert.equal(isPeerRouteAllowed(fixtureGraph, routes, 'alpha', 'beta'), true);
  assert.equal(isPeerRouteAllowed(fixtureGraph, routes, 'beta', 'alpha'), false);
  assert.equal(isPeerRouteAllowed(fixtureGraph, routes, 'alpha', 'gamma'), false);
  assert.equal(isPeerRouteAllowed(fixtureGraph, routes, 'alpha', '*'), false);
});

test('2. default-empty routes validate successfully and permit no communication', () => {
  const validated = validatePeerRoutes(fixtureGraph, []);
  assert.deepEqual(validated, []);
  assert.equal(isPeerRouteAllowed(fixtureGraph, [], 'alpha', 'beta'), false);
  assert.equal(isPeerRouteAllowed(fixtureGraph, [], 'beta', 'gamma'), false);
});

test('3. unknown endpoints throw INVALID_PEER_ROUTES on validation and return false on query, while invalid graphs retain INVALID_GROUP', () => {
  assert.throws(
    () => validatePeerRoutes(fixtureGraph, [{ from: 'alpha', to: 'delta' }]),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_PEER_ROUTES'
  );
  assert.throws(
    () => validatePeerRoutes(fixtureGraph, [{ from: 'omega', to: 'beta' }]),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_PEER_ROUTES'
  );
  assert.equal(isPeerRouteAllowed(fixtureGraph, [{ from: 'alpha', to: 'beta' }], 'alpha', 'unknown'), false);
  assert.equal(isPeerRouteAllowed(fixtureGraph, [{ from: 'alpha', to: 'beta' }], 'unknown', 'beta'), false);

  assert.throws(
    () => validatePeerRoutes({ nodes: [] }, []),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_GROUP'
  );
});

test('4. self edges and duplicate directed edges in routes are rejected with INVALID_PEER_ROUTES', () => {
  assert.throws(
    () => validatePeerRoutes(fixtureGraph, [{ from: 'alpha', to: 'alpha' }]),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_PEER_ROUTES'
  );
  assert.throws(
    () => validatePeerRoutes(fixtureGraph, [{ from: 'alpha', to: 'beta' }, { from: 'alpha', to: 'beta' }]),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_PEER_ROUTES'
  );
});

test('5. valid bidirectional routes are accepted as distinct permissions', () => {
  const twoWay = [
    { from: 'alpha', to: 'beta' },
    { from: 'beta', to: 'alpha' },
  ];
  const validated = validatePeerRoutes(fixtureGraph, twoWay);
  assert.equal(validated.length, 2);
  assert.equal(isPeerRouteAllowed(fixtureGraph, twoWay, 'alpha', 'beta'), true);
  assert.equal(isPeerRouteAllowed(fixtureGraph, twoWay, 'beta', 'alpha'), true);
});

test('6. mutation detachment isolates input data and returned route structures', () => {
  const input = [{ from: 'alpha', to: 'beta' }];
  const output = validatePeerRoutes(fixtureGraph, input);
  input.push({ from: 'alpha', to: 'gamma' });
  input[0]!.to = 'gamma';
  assert.equal(output.length, 1);
  assert.equal(output[0]!.to, 'beta');

  output[0]!.to = 'gamma';
  const fresh = validatePeerRoutes(fixtureGraph, [{ from: 'alpha', to: 'beta' }]);
  assert.equal(fresh[0]!.to, 'beta');
});

test('7. extractPeerMessages parses valid public envelopes and ignores surrounding content', () => {
  const id1 = randomUUID();
  const id2 = randomUUID();
  const text = `Log preamble
<antigravity-peer-message>{"messageId":"${id1}","toNode":"beta","text":"Hello beta"}</antigravity-peer-message>
Intermediate text
<antigravity-peer-message>{"messageId":"${id2}","toNode":"gamma","text":"Review requested"}</antigravity-peer-message>
Trailing commentary`;

  const result = extractPeerMessages(text);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.messages, [
    { messageId: id1, toNode: 'beta', text: 'Hello beta' },
    { messageId: id2, toNode: 'gamma', text: 'Review requested' },
  ]);
});

test('8. peer message text preserves bytes but rejects all-whitespace, empty, and NUL bytes', () => {
  const id = randomUUID();
  const preservedText = '  line 1\n\tline 2  ';
  const parsed = peerMessageInputSchema.safeParse({
    messageId: id,
    toNode: 'beta',
    text: preservedText,
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.text, preservedText);
  }

  assert.equal(peerMessageInputSchema.safeParse({ messageId: id, toNode: 'beta', text: '   \t\n  ' }).success, false);
  assert.equal(peerMessageInputSchema.safeParse({ messageId: id, toNode: 'beta', text: '' }).success, false);
  assert.equal(peerMessageInputSchema.safeParse({ messageId: id, toNode: 'beta', text: 'hello\0world' }).success, false);

  const envWhitespace = `<antigravity-peer-message>{"messageId":"${id}","toNode":"beta","text":"   "}</antigravity-peer-message>`;
  const envNul = `<antigravity-peer-message>{"messageId":"${id}","toNode":"beta","text":"nul\\u0000byte"}</antigravity-peer-message>`;
  assert.deepEqual(extractPeerMessages(envWhitespace).messages, []);
  assert.deepEqual(extractPeerMessages(envNul).messages, []);
});

test('9. envelope body exceeding 4096 units is ignored while compliant payload is parsed', () => {
  const id = randomUUID();
  const oversizedPayload = JSON.stringify({
    messageId: id,
    toNode: 'beta',
    text: 'x'.repeat(MAX_PEER_PAYLOAD_CHARS),
  });
  assert.ok(oversizedPayload.length > MAX_PEER_PAYLOAD_CHARS);

  const textOversized = `<antigravity-peer-message>${oversizedPayload}</antigravity-peer-message>`;
  assert.deepEqual(extractPeerMessages(textOversized).messages, []);

  const validPayload = JSON.stringify({
    messageId: id,
    toNode: 'beta',
    text: 'acceptable length',
  });
  const textValid = `<antigravity-peer-message>${validPayload}</antigravity-peer-message>`;
  const result = extractPeerMessages(textValid);
  assert.equal(result.messages.length, 1);
  assert.equal(result.truncated, false);
});

test('10. scan limit caps inspection at 1,000,000 UTF-16 units and marks result truncated', () => {
  const id1 = randomUUID();
  const id2 = randomUUID();
  const earlyEnv = `<antigravity-peer-message>{"messageId":"${id1}","toNode":"beta","text":"early"}</antigravity-peer-message>`;
  const lateEnv = `<antigravity-peer-message>{"messageId":"${id2}","toNode":"gamma","text":"late"}</antigravity-peer-message>`;

  const filler = 'a'.repeat(MAX_PEER_SCAN_CHARS);
  const oversizedText = earlyEnv + filler + lateEnv;

  const result = extractPeerMessages(oversizedText);
  assert.equal(result.truncated, true);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]!.messageId, id1);
});

test('11. count limit caps at 20 messages and marks truncated when more valid messages exist', () => {
  const makeEnv = (num: number) =>
    `<antigravity-peer-message>{"messageId":"${randomUUID()}","toNode":"beta","text":"msg ${num}"}</antigravity-peer-message>`;

  const exact20 = Array.from({ length: 20 }, (_, i) => makeEnv(i)).join('\n');
  const res20 = extractPeerMessages(exact20);
  assert.equal(res20.messages.length, 20);
  assert.equal(res20.truncated, false);

  const overflow25 = Array.from({ length: 25 }, (_, i) => makeEnv(i)).join('\n');
  const res25 = extractPeerMessages(overflow25);
  assert.equal(res25.messages.length, 20);
  assert.equal(res25.truncated, true);
});

test('12. malformed envelopes and unknown fields are ignored while repeated IDs are preserved', () => {
  const sharedId = randomUUID();
  const text = `
<antigravity-peer-message>{not valid json}</antigravity-peer-message>
<antigravity-peer-message>{"messageId":"${randomUUID()}","toNode":"beta","text":"ok","unknownField":123}</antigravity-peer-message>
<antigravity-peer-message>unclosed tag
<antigravity-peer-message>{"messageId":"${sharedId}","toNode":"beta","text":"first copy"}</antigravity-peer-message>
<antigravity-peer-message>{"messageId":"${sharedId}","toNode":"beta","text":"second copy"}</antigravity-peer-message>
`;

  const result = extractPeerMessages(text);
  assert.equal(result.truncated, false);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]!.messageId, sharedId);
  assert.equal(result.messages[1]!.messageId, sharedId);
  assert.equal(result.messages[0]!.text, 'first copy');
  assert.equal(result.messages[1]!.text, 'second copy');
});

test('nested malformed opening tags do not repeatedly rescan the same closing range', () => {
  const open = '<antigravity-peer-message>', close = '</antigravity-peer-message>';
  const text = open.repeat(1000) + JSON.stringify({ messageId: randomUUID(), toNode: 'beta', text: 'bounded' }) + close;
  const original = String.prototype.indexOf; let scanned = 0;
  try {
    String.prototype.indexOf = function(this: string, needle: string, position = 0) {
      const result = original.call(this, needle, position);
      if (this.length === text.length) scanned += Math.max(0, (result < 0 ? this.length : result + needle.length) - position);
      return result;
    };
    assert.equal(extractPeerMessages(text).messages.length, 1);
  } finally { String.prototype.indexOf = original; }
  assert.ok(scanned <= text.length * 3, 'Parser repeatedly rescanned the same input range');
});
test('literal envelope tags within JSON message text preserve the message', () => {
  const message = { messageId: randomUUID(), toNode: 'beta', text: 'Example <antigravity-peer-message>body</antigravity-peer-message>' };
  const text = '<antigravity-peer-message>' + JSON.stringify(message) + '</antigravity-peer-message>';
  assert.deepEqual(extractPeerMessages(text).messages, [message]);
});

test('route count admits128 distinct edges and rejects129 without relying on duplicates', () => {
  const nodes = Array.from({ length: 16 }, (_, index) => ({ key: 'node-' + index, owner: 'implementer', dependsOn: [] }));
  const routes = nodes.flatMap(from => nodes.filter(to => to.key !== from.key).map(to => ({ from: from.key, to: to.key })));
  assert.equal(validatePeerRoutes({ nodes }, routes.slice(0, 128)).length, 128);
  assert.equal(peerRoutesSchema.safeParse(routes.slice(0, 129)).success, false);
});
