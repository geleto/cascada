
const CHANNEL_TYPE_FACTS = Object.freeze({
  data: Object.freeze({
    channelDeclarationTag: true,
    commandClass: 'DataCommand',
    requiresInitializer: false,
    supportsValueInitializer: true
  }),
  text: Object.freeze({
    channelDeclarationTag: true,
    commandClass: 'TextCommand',
    requiresInitializer: false,
    supportsValueInitializer: true
  }),
  var: Object.freeze({
    channelDeclarationTag: false,
    commandClass: 'VarCommand',
    requiresInitializer: false,
    supportsValueInitializer: true
  }),
  sequence: Object.freeze({
    channelDeclarationTag: true,
    commandClass: 'SequenceCallCommand',
    requiresInitializer: true,
    supportsValueInitializer: false
  })
});

const CHANNEL_TYPES = Object.freeze(Object.keys(CHANNEL_TYPE_FACTS));

export { CHANNEL_TYPE_FACTS, CHANNEL_TYPES };
