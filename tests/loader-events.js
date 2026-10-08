import expect from 'expect.js';
import {subscribeLoaderEvent} from '../src/loader/loader-events.js';

class SubscriptionLoader {
  constructor() {
    this.events = new Map();
  }

  on(event, callback) {
    let listeners = this.events.get(event);
    if (!listeners) {
      listeners = [];
      this.events.set(event, listeners);
    }
    listeners.push(callback);
  }

  emit(event, ...args) {
    for (const callback of this.events.get(event) || []) callback(...args);
  }
}

function recordEvent(target, loader, value) {
  target.events.push({loader, value});
}

describe('loader event subscriptions', function() {
  it('deduplicates each target and callback independently for each event', function() {
    const loader = new SubscriptionLoader();
    const first = {events: []};
    const second = {events: []};
    function recordOtherEvent(target, source, value) {
      target.events.push({loader: source, value: 'other:' + value});
    }

    subscribeLoaderEvent(loader, 'update', first, recordEvent);
    subscribeLoaderEvent(loader, 'update', first, recordEvent);
    subscribeLoaderEvent(loader, 'update', first, recordOtherEvent);
    subscribeLoaderEvent(loader, 'update', second, recordEvent);
    subscribeLoaderEvent(loader, 'load', first, recordEvent);

    loader.emit('update', 'changed');
    loader.emit('load', 'loaded');
    expect(first.events).to.eql([
      {loader, value: 'changed'},
      {loader, value: 'other:changed'},
      {loader, value: 'loaded'}
    ]);
    expect(second.events).to.eql([{loader, value: 'changed'}]);
    expect(loader.events.get('update').length).to.be(1);
    expect(loader.events.get('load').length).to.be(1);
  });

  it('registers new subscribers without reading or retaining existing weak targets', function() {
    const loader = new SubscriptionLoader();
    const targets = Array.from({length: 1000}, () => ({events: []}));
    const deref = WeakRef.prototype.deref;
    let dereferences = 0;
    WeakRef.prototype.deref = function() {
      dereferences++;
      return deref.call(this);
    };
    try {
      for (const target of targets) subscribeLoaderEvent(loader, 'update', target, recordEvent);
      expect(dereferences).to.be(1);
    } finally {
      WeakRef.prototype.deref = deref;
    }

    loader.emit('update', 'changed');
    expect(targets.every(target => target.events.length === 1)).to.be(true);
    expect(loader.events.get('update').length).to.be(1);
  });
});
