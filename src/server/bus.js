// Event bus: a ring of the last events plus subscribers. Every event is {id, t, type, ...data}.
const RESERVED = new Set(['id', 't', 'type']);

export class Bus {
  constructor({ ring = 500 } = {}) {
    this.ring = ring;
    this.events = [];
    this.listeners = new Set();
    this.nextId = 1;
  }

  emit(type, data = {}) {
    const event = { id: this.nextId++, t: Date.now(), type };
    for (const [k, v] of Object.entries(data)) if (!RESERVED.has(k)) event[k] = v;
    this.events.push(event);
    if (this.events.length > this.ring) this.events.splice(0, this.events.length - this.ring);
    for (const fn of [...this.listeners]) {
      try {
        fn(event);
      } catch {
        // a faulty subscriber must not break the others
      }
    }
    return event;
  }

  /** Subscribe; returns the unsubscribe function. */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recent(n = this.events.length) {
    return n <= 0 ? [] : this.events.slice(-n);
  }
}
