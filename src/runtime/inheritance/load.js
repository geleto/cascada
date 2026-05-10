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
  origin: SourceOrigin | null, // callable declaration site for diagnostics
  ownLinkedChannels: string[], // local body reads/observations
  ownMutatedChannels: string[], // local body mutations
  super: boolean, // true when the body calls super()
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

async function loadInheritanceChain({
  root,
  context,
  env,
  runtime,
  inheritanceState,
  origin = null
}) {
  if (!inheritanceState) {
    throw new RuntimeFatalError(
      'loadInheritanceChain requires an inheritance state',
      0,
      0,
      null,
      context?.path ?? null
    );
  }
  if (inheritanceState.finalized) {
    throw new RuntimeFatalError(
      'Cannot load inheritance chain after metadata finalization',
      0,
      0,
      null,
      context?.path ?? null
    );
  }
  if (inheritanceState.renderPlan || inheritanceState.loading.files.length > 0) {
    throw new RuntimeFatalError(
      'Cannot load inheritance chain more than once',
      origin?.lineno ?? 0,
      origin?.colno ?? 0,
      origin?.errorContextString ?? null,
      origin?.path ?? context?.path ?? null
    );
  }

  const chain = [];
  await loadSelectedInheritanceRoot({
    root,
    context,
    env,
    runtime,
    inheritanceState,
    origin,
    chain,
    incomingPayload: null
  });

  inheritanceState.renderPlan = createRenderPlan(chain);
  return inheritanceState.renderPlan;
}

async function loadSelectedInheritanceRoot({
  root,
  context,
  env,
  runtime,
  inheritanceState,
  origin,
  chain,
  incomingPayload,
  allowEmptyRoot = false
}) {
  const selectedRoot = await runtime.resolveSingle(root);
  if (selectedRoot === null || selectedRoot === undefined) {
    if (allowEmptyRoot) {
      return null;
    }
    throw new RuntimeFatalError(
      'loadInheritanceChain requires a selected root',
      origin?.lineno ?? 0,
      origin?.colno ?? 0,
      origin?.errorContextString ?? null,
      origin?.path ?? context?.path ?? null
    );
  }
  if (typeof selectedRoot !== 'object') {
    throw new RuntimeFatalError(
      'Selected inheritance root must be a compiled template or script',
      origin?.lineno ?? 0,
      origin?.colno ?? 0,
      origin?.errorContextString ?? null,
      origin?.path ?? context?.path ?? null
    );
  }

  const token = enterLoadingPath(inheritanceState, selectedRoot.path, origin || context);
  try {
    if (typeof selectedRoot.compile === 'function') {
      selectedRoot.compile();
    }
    if (!selectedRoot.inheritanceSpec) {
      throw new RuntimeFatalError(
        'Selected inheritance root is missing inheritance metadata',
        origin?.lineno ?? 0,
        origin?.colno ?? 0,
        origin?.errorContextString ?? null,
        origin?.path ?? context?.path ?? selectedRoot.path ?? null
      );
    }

    const entry = {
      root: selectedRoot,
      path: selectedRoot.path == null ? null : String(selectedRoot.path),
      compositionPayload: incomingPayload ?? null,
      origin: normalizeSourceOrigin(origin || context)
    };
    chain.push(entry);
    bootstrapInheritanceMetadata(inheritanceState, selectedRoot.inheritanceSpec, entry.origin);

    const resolver = selectedRoot.resolveInheritanceParent;
    if (typeof resolver !== 'function') {
      return entry;
    }
    const selection = await resolver(env, context, runtime, inheritanceState, entry.origin);
    if (!selection || !selection.parentRoot) {
      return entry;
    }

    const parentContext = selection.compositionPayload && typeof context?.forkForCompositionPayload === 'function'
      ? context.forkForCompositionPayload(
        selection.parentRoot.path,
        selection.compositionPayload,
        context.getRenderContextVariables ? context.getRenderContextVariables() : undefined
      )
      : (typeof context?.forkForPath === 'function'
        ? context.forkForPath(selection.parentRoot.path)
        : context);

    return loadSelectedInheritanceRoot({
      root: selection.parentRoot,
      context: parentContext,
      env,
      runtime,
      inheritanceState,
      origin: selection.origin || entry.origin,
      chain,
      incomingPayload: selection.compositionPayload ?? null,
      allowEmptyRoot: true
    });
  } finally {
    leaveLoadingPath(inheritanceState, token);
  }
}

function createRenderPlan(chain) {
  const hasParent = chain.length > 1;
  const structuralEntry = hasParent && chain[chain.length - 1].root?.scriptMode === false
    ? chain[chain.length - 1]
    : null;
  return {
    chain,
    structuralEntry,
    hasParent
  };
}

function enterLoadingPath(inheritanceState, path, context) {
  const loading = inheritanceState?.loading;
  if (!loading) {
    return null;
  }
  const normalizedPath = path == null ? '__anonymous__' : String(path);
  if (loading.chainPaths.includes(normalizedPath)) {
    throw new RuntimeFatalError(
      `Inheritance cycle detected: ${loading.chainPaths.join(' -> ')} -> ${normalizedPath}`,
      0,
      0,
      'Inheritance',
      context?.path ?? null
    );
  }
  loading.chainPaths.push(normalizedPath);
  return normalizedPath;
}

function leaveLoadingPath(inheritanceState, token) {
  const chainPaths = inheritanceState?.loading?.chainPaths;
  if (!token || !chainPaths) {
    return;
  }
  chainPaths.pop();
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
    context: normalizeSourceOrigin(context)
  });
}

function normalizeSourceOrigin(context) {
  if (isSourceOrigin(context)) {
    return {
      lineno: context.lineno ?? 0,
      colno: context.colno ?? 0,
      errorContextString: context.errorContextString ?? 'Inheritance',
      path: context.path || null
    };
  }
  return context
    ? {
      lineno: 0,
      colno: 0,
      errorContextString: 'Inheritance',
      path: context.path || null
    }
    : null;
}

function isSourceOrigin(value) {
  return value && typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, 'lineno') &&
    Object.prototype.hasOwnProperty.call(value, 'colno') &&
    Object.prototype.hasOwnProperty.call(value, 'errorContextString');
}

export {bootstrapInheritanceMetadata, loadInheritanceChain};
