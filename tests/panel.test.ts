import assert from 'node:assert/strict';
import test from 'node:test';
import { panelState, panelOutputSchemas, panelTask } from '../src/panel.js';
import type { TaskRecord } from '../src/types.js';
const id = 'a5172f75-40ff-403c-a887-4f3afd98b619';
const record: TaskRecord = {taskId: id, workingDirectory: '/source', status: 'completed', createdAt: new Date().toISOString(), prompt: 'Task label\nPrompt body excluded', mode: 'read-only', deliveryMode: 'messages',
  result: {response: 'x'.repeat(10005), private_field: 'NEVER_INLINE_PRIVATE_RESULT'}, messages: [], messageCursor: 0};
function fixture() {
  const events = [
    {taskId: id, sequence: 1, timestamp: record.createdAt, type: 'step.update', data: {step_index: 0, step_type: 'thought', state: 'DONE', text_delta: 'NEVER_PRIVATE_THOUGHT'}, raw: {private: 'NEVER_RAW'}},
    {taskId: id, sequence: 2, timestamp: record.createdAt, type: 'response.chunk', data: {step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'PUBLIC_REPLY'}},
    {taskId: id, sequence: 3, timestamp: record.createdAt, type: 'agy.result', data: record.result},
  ];
  return {list: () => [record], status: (_id: string) => record,
    readEvents: (_id: string, after = 0, limit = 200) => {const page = events.filter(e => e.sequence > after).slice(0,limit);return {events: page,nextCursor: page.at(-1)?.sequence ?? after,oldestAvailable: 1,truncated: false};},
    inbox: () => [], panelCapabilities: () => ({messaging: true, deliveryMode: true, cancel: false, undo: false, preview: false, maxConcurrentTasks: 2})};
}
test('panel separates public events from raw results and thought content, preserving paging cursors', () => {
  const tasks = fixture(), state = panelState(tasks,{taskId: id, limit: 2});
  assert.equal(panelOutputSchemas.antigravity_panel_state.safeParse(state).success, true);
  assert.equal(state.nextCursor, 2); assert.equal(state.events.length, 2);
  assert.equal(state.events[1]!.data && (state.events[1]!.data as {text_delta: string}).text_delta, 'PUBLIC_REPLY');
  assert.ok(!JSON.stringify(state).includes('NEVER_')); assert.ok(!JSON.stringify(panelTask(record)).includes('Prompt body'));
  const next = panelState(tasks,{taskId: id,after: state.nextCursor,includeResponse: false});
  assert.equal(next.nextCursor,3); assert.deepEqual(next.events[0]!.data,{available:true}); assert.equal(next.response,null);
});
test('response pages are complete and reject stale hashes or invalid offsets', () => {
  const tasks=fixture(), first=panelState(tasks,{taskId:id}).response!;
  const rest=panelState(tasks,{taskId:id,responseOffset:first.nextOffset,expectedResponseSha256:first.contentSha256}).response!;
  assert.equal(first.text+rest.text,(record.result as {response: string}).response); assert.equal(rest.hasMore,false);
  assert.throws(() => panelState(tasks,{taskId:id,responseOffset:99999}),{code:'INVALID_CURSOR'});
  assert.throws(() => panelState(tasks,{taskId:id,expectedResponseSha256:'0'.repeat(64)}),{code:'CONTENT_CHANGED'});
});
