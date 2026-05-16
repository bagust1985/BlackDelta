/**
 * Inter-agent message bus + shared context.
 *
 * Tiny in-process EventEmitter wrapper used by the supervisor to:
 *   - publish "tick", "deploy", "close" events specialists react to
 *   - share context: open positions, candidates, signals, allocator audit,
 *     WS events
 *
 * Not persistent — context lives for one supervisor.tick() lifetime.
 */

import { EventEmitter } from "node:events";

class AgentBus extends EventEmitter {
  constructor() {
    super();
    this.context = {};
  }

  setContext(patch) {
    Object.assign(this.context, patch || {});
  }

  getContext() {
    return { ...this.context };
  }

  resetContext() {
    this.context = {};
  }

  publish(topic, payload) {
    this.emit(topic, payload);
  }

  subscribe(topic, handler) {
    this.on(topic, handler);
  }
}

export const bus = new AgentBus();
export default bus;
