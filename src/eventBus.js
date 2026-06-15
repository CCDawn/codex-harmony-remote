export class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  subscribe(taskId, listener) {
    const listeners = this.listeners.get(taskId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(taskId);
      }
    };
  }

  publish(taskId, event) {
    const listeners = this.listeners.get(taskId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }
}
