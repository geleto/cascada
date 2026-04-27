'use strict';

const CHANNEL_TYPE_FACTS = Object.freeze({
  data: Object.freeze({
    channelDeclarationTag: true,
    commandClass: 'DataCommand',
    requiresInitializer: false,
    supportsValueInitializer: true,
    usesInitializerAsTarget: false
  }),
  text: Object.freeze({
    channelDeclarationTag: true,
    commandClass: 'TextCommand',
    requiresInitializer: false,
    supportsValueInitializer: true,
    usesInitializerAsTarget: false
  }),
  var: Object.freeze({
    channelDeclarationTag: false,
    commandClass: 'VarCommand',
    requiresInitializer: false,
    supportsValueInitializer: true,
    usesInitializerAsTarget: false
  }),
  sequence: Object.freeze({
    channelDeclarationTag: true,
    commandClass: 'SequenceCallCommand',
    requiresInitializer: true,
    supportsValueInitializer: false,
    usesInitializerAsTarget: true
  })
});

const CHANNEL_TYPES = Object.freeze(Object.keys(CHANNEL_TYPE_FACTS));

const __defaultExport = {
  CHANNEL_TYPE_FACTS,
  CHANNEL_TYPES
};
export { CHANNEL_TYPE_FACTS, CHANNEL_TYPES };
export default __defaultExport;
if (typeof module !== 'undefined') { module['exports'] = __defaultExport; }
