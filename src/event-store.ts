import type { BridgeEvent } from './types.js';
import { logTaskEvent } from './logger.js';

export class EventStore {
  private readonly events: BridgeEvent[] = [];
  private readonly cursors = new Map<string, number>();
  constructor(private readonly capacity: number, private readonly onAppend?: (taskId: string) => void) {}

  append(taskId: string, type: string, data: unknown, raw?: unknown): BridgeEvent {
    const sequence = (this.cursors.get(taskId) || 0) + 1;
    this.cursors.set(taskId, sequence);
    const bounded = (value: unknown) => {
      const serialized = JSON.stringify(value);
      return serialized && serialized.length > 16000 ? { truncated: true, preview: serialized.slice(0, 16000) } : value;
    };
    const event: BridgeEvent = { taskId, sequence, timestamp: new Date().toISOString(), type, data: bounded(data) };
    if (raw !== undefined) event.raw = bounded(raw);
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    logTaskEvent(taskId, type, data);
    this.onAppend?.(taskId);
    return event;
  }

  read(taskId: string, after = 0, limit = 200): { events: BridgeEvent[]; nextCursor: number; oldestAvailable: number; truncated: boolean } {
    const bucket = this.events.filter(event => event.taskId === taskId);
    const oldestAvailable = bucket[0]?.sequence || (this.cursors.get(taskId) || 0) + 1;
    const events = bucket.filter(event => event.sequence > after).slice(0, limit);
    return { events, nextCursor: events.at(-1)?.sequence || after, oldestAvailable, truncated: after < oldestAvailable - 1 };
  }

  drop(taskId: string): void {
    this.cursors.delete(taskId);
    for (let index = this.events.length - 1; index >= 0; index--) {
      if (this.events[index]?.taskId === taskId) this.events.splice(index, 1);
    }
  }

  snapshot(taskId: string): { events: BridgeEvent[]; cursor: number } {
    return { events: this.events.filter(event => event.taskId === taskId), cursor: this.cursors.get(taskId) || 0 };
  }

  restore(taskId: string, events: BridgeEvent[], cursor: number): void {
    this.drop(taskId);
    this.events.push(...events);
    this.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    this.cursors.set(taskId, cursor);
  }
}
