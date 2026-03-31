'use strict';

const { createLoopBindings } = require('./loop');

function markSyncTemplateFrameTopLevel(frame) {
  frame._syncTemplateFrameTopLevel = true;
  return frame;
}

function isSyncTemplateFrameTopLevel(frame) {
  return !!(frame && frame._syncTemplateFrameTopLevel);
}

function contextOrSyncTemplateFrameLookup(context, frame, name) {
  var val = frame.lookup(name);
  return (val !== undefined) ?
    val :
    context.lookup(name);
}

function setSyncTemplateFrameLoopBindings(frame, index, len, last) {
  const loopMeta = createLoopBindings(index, len, last);
  frame.set('loop.index', loopMeta.index);
  frame.set('loop.index0', loopMeta.index0);
  frame.set('loop.revindex', loopMeta.revindex);
  frame.set('loop.revindex0', loopMeta.revindex0);
  frame.set('loop.first', loopMeta.first);
  frame.set('loop.last', loopMeta.last);
  frame.set('loop.length', loopMeta.length);
}

module.exports = {
  markSyncTemplateFrameTopLevel,
  isSyncTemplateFrameTopLevel,
  contextOrSyncTemplateFrameLookup,
  setSyncTemplateFrameLoopBindings,
};
