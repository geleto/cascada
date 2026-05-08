export default class EventEmitter {
  constructor() {
    this.events = Object.create(null);
  }

  on(type, listener) {
    (this.events[type] ||= []).push(listener);
    return this;
  }

  once(type, listener) {
    const onceListener = (...args) => {
      this.removeListener(type, onceListener);
      listener(...args);
    };
    onceListener.listener = listener;
    return this.on(type, onceListener);
  }

  emit(type, ...args) {
    const listeners = this.events[type];
    if (!listeners) {
      return false;
    }
    for (const listener of [...listeners]) {
      listener(...args);
    }
    return true;
  }

  removeListener(type, listener) {
    const listeners = this.events[type];
    if (!listeners) {
      return this;
    }
    this.events[type] = listeners.filter((item) => item !== listener && item.listener !== listener);
    return this;
  }

  off(type, listener) {
    return this.removeListener(type, listener);
  }

  removeAllListeners(type) {
    if (type) {
      delete this.events[type];
    } else {
      this.events = Object.create(null);
    }
    return this;
  }
}
