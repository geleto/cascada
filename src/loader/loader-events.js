// Loader instances are often shared across many short-lived environments.
// Subscribe once per event and keep subscribers weak so the loader cannot retain them.
const loaderEvents = new WeakMap();
const subscriptions = new FinalizationRegistry(({hub, event, entry}) => {
  hub.deref()?.remove(event, entry);
});

class LoaderEvents {
  constructor(loader) {
    this.loader = new WeakRef(loader);
    this.events = new Map();
  }

  subscribe(event, target, callback) {
    let listeners = this.events.get(event);
    if (!listeners) {
      listeners = {entries: new Set(), dispatch: (...args) => this.dispatch(event, args)};
      this.events.set(event, listeners);
      this.loader.deref().on(event, listeners.dispatch);
    }
    for (const entry of listeners.entries) {
      if (entry.target.deref() === target && entry.callback === callback) return;
    }
    const entry = {target: new WeakRef(target), callback};
    listeners.entries.add(entry);
    subscriptions.register(target, {hub: new WeakRef(this), event, entry}, entry);
  }

  dispatch(event, args) {
    const loader = this.loader.deref();
    const listeners = this.events.get(event);
    if (!listeners) return;
    for (const entry of Array.from(listeners.entries)) {
      const target = entry.target.deref();
      if (target) {
        entry.callback(target, loader, ...args);
      } else {
        this.remove(event, entry);
      }
    }
  }

  remove(event, entry) {
    const listeners = this.events.get(event);
    if (!listeners) return;
    listeners.entries.delete(entry);
    subscriptions.unregister(entry);
    if (!listeners.entries.size) {
      const loader = this.loader.deref();
      const remove = loader?.off || loader?.removeListener;
      if (remove) {
        remove.call(loader, event, listeners.dispatch);
        this.events.delete(event);
      }
    }
  }
}

// Callbacks receive the target rather than closing over it. Passing a callback
// that captures the target would defeat the weak subscription.
function subscribeLoaderEvent(loader, event, target, callback) {
  if (typeof loader.on !== 'function') return;
  let hub = loaderEvents.get(loader);
  if (!hub) {
    hub = new LoaderEvents(loader);
    loaderEvents.set(loader, hub);
  }
  hub.subscribe(event, target, callback);
}

export {subscribeLoaderEvent};
