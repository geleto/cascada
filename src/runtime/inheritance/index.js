// Exports the inheritance runtime surface.

export {
  createInheritanceState,
  setInheritanceStartupPromise
} from './state.js';
export {bootstrapInheritanceMetadata} from './load.js';
export {finalizeInheritanceMetadata} from './finalize.js';
export {
  bootstrapInheritanceParentScript,
  getInheritanceSharedBuffer,
  linkCurrentBufferToParentChannels,
  renderInheritanceParentRoot,
  runCompiledRootStartup
} from './startup.js';
export {
  getCallableLinkedChannels,
  getCallableMutatedChannels,
  invokeInheritedCallable,
  invokeSuperCallable
} from './invoke.js';
export {
  claimInheritanceSharedDefault,
  declareInheritanceSharedChannel,
  ensureInheritanceSharedSchemaTable,
  initializeInheritanceSharedChannelDefault,
  linkCurrentBufferToSharedChannels,
  resolveInheritanceSharedChannel
} from './shared.js';
