// Defines inheritance state for one render or component instance.
// Stores loaded specs, finalized tables, startup status, and the shared-root
// command buffer.

/*
// Runtime method entry after finalization.
type RuntimeMethodEntry = {
  name: string,
  fn: Function,
  signature: { argNames: string[] },
  ownerKey: string, // file/template that defined this method
  origin: SourceOrigin | null, // callable declaration site for diagnostics
  super: RuntimeMethodEntry | null, // owner-relative parent method
  mergedLinkedChannels: string[], // transitive reads/observations
  mergedMutatedChannels: string[] // transitive mutations
}

// Compiler output for one template/script file.
type CompiledInheritanceSpec = {
  setup: Function,
  methodEntries: Record<string, CompiledMethodEntry>, // method name -> compiled method
  sharedSchema: Record<string, string>, // channel name -> channel type
  invokedMethodRefs: Record<string, InvokedMethodRef>, // method name -> first call site
  hasExtends: boolean
}

// Source location for diagnostics.
type SourceOrigin = {
  lineno: number,
  colno: number,
  errorContextString: string,
  path: string | null
}

// Temporary child-to-parent chain loading state.
type LoadingState = {
  files: LoadedInheritanceFile[], // child, parent, grandparent, ...
  chainPaths: string[] // loaded file path stack for cycle detection
}

// Temporary loaded file entry before finalization.
type LoadedInheritanceFile = {
  spec: CompiledInheritanceSpec,
  context: SourceOrigin | null
}

// Per-instance mutable runtime state.
type InheritanceState = {
  methods: Record<string, RuntimeMethodEntry>, // method name -> finalized method
  sharedSchema: Record<string, string>, // shared channel name -> channel type
  sharedRootBuffer: CommandBuffer | null,
  compositionPayload: object | null,
  startupPromise: Promise<unknown> | null,
  finalized: boolean,
  failure: Error | null,
  loading: LoadingState | null
}
*/

class InheritanceState {
  constructor() {
    this.methods = Object.create(null);
    this.sharedSchema = Object.create(null);
    this.sharedRootBuffer = null;
    this.compositionPayload = null;
    this.startupPromise = null;
    this.finalized = false;
    this.failure = null;
    this.loading = {
      files: [],
      chainPaths: []
    };
  }
}

function createInheritanceState() {
  return new InheritanceState();
}

function setInheritanceStartupPromise(state, promise) {
  state.startupPromise = promise ?? null;
  return promise;
}

function setInheritanceSharedRootBuffer(state, buffer) {
  if (!state.sharedRootBuffer) {
    state.sharedRootBuffer = buffer;
  }
  return state.sharedRootBuffer;
}

export {
  createInheritanceState,
  setInheritanceSharedRootBuffer,
  setInheritanceStartupPromise
};
