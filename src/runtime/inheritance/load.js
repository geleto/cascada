// Records compiler-emitted inheritance specs in child-first order.
// Keeps raw compiler data unchanged until finalization.

import {RuntimeFatalError} from '../errors.js';

/*
// Source location for diagnostics.
type SourceOrigin = {
  lineno: number,
  colno: number,
  errorContextString: string,
  path: string | null
}

// Compiler output for one inherited callable reference.
type InvokedMethodRef = {
  name: string,
  origin: SourceOrigin | null
}

// Compiler output for one callable body.
type CompiledMethodEntry = {
  fn: Function,
  signature: { argNames: string[] },
  ownerKey: string, // file/template that defined this method
  ownLinkedChannels: string[], // local body reads/observations
  ownMutatedChannels: string[], // local body mutations
  super: boolean,
  superOrigin: SourceOrigin | null, // super() call site
  invokedMethodRefs: Record<string, InvokedMethodRef> // method name -> first call site, for error output when missing
}

// Compiler output for one template/script file.
type CompiledInheritanceSpec = {
  setup: Function,
  methodEntries: Record<string, CompiledMethodEntry>, // method name -> compiled method
  sharedSchema: Record<string, string>, // channel name -> channel type
  invokedMethodRefs: Record<string, InvokedMethodRef>, // method name -> first call site
  hasExtends: boolean
}

// Temporary loaded file entry before finalization.
type LoadedInheritanceFile = {
  spec: CompiledInheritanceSpec,
  context: SourceOrigin | null
}
*/

function bootstrapInheritanceMetadata(state, spec, context) {
  if (!state) {
    throw new RuntimeFatalError(
      'bootstrapInheritanceMetadata requires an inheritance state',
      0,
      0,
      null,
      context?.path ?? null
    );
  }
  if (state.finalized) {
    return state;
  }

  addLoadedInheritanceSpec(state, spec, context);

  return state;
}

function addLoadedInheritanceSpec(state, spec, context = null) {
  if (!state.loading) {
    throw new RuntimeFatalError(
      'Cannot add inheritance spec after metadata finalization',
      0,
      0,
      null,
      context?.path ?? null
    );
  }
  state.loading.files.push({
    spec,
    context: createStubSourceOrigin(context)
  });
}

// Temporary until loading receives a proper source origin.
function createStubSourceOrigin(context) {
  return context
    ? {
      lineno: 0,
      colno: 0,
      errorContextString: 'Inheritance',
      path: context.path || null
    }
    : null;
}

export {bootstrapInheritanceMetadata};
