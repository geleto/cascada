'use strict';

// Component bootstrap helpers.
// Owns resolving the imported component template, bootstrapping inheritance
// metadata/shared inputs, and starting the component constructor when present.

const { declareBufferChannel } = require('./channel');
const { WaitResolveCommand } = require('./commands');
const { resolveSingle } = require('./resolve');
const { RuntimeFatalError } = require('./errors');
const inheritanceBootstrap = require('./inheritance-bootstrap');
const inheritanceCall = require('./inheritance-call');

function _normalizeComponentBootstrapFailure(err, pos, path) {
  if (err instanceof RuntimeFatalError) {
    throw err;
  }
  throw new RuntimeFatalError(err, pos.lineno, pos.colno, null, path);
}

function _bootstrapResolvedTemplate({
  resolvedTemplate,
  inputValues,
  componentContext,
  componentRoot,
  componentInstance,
  inheritanceState,
  env,
  runtime,
  cb,
  pos
}) {
  if (!resolvedTemplate || typeof resolvedTemplate.compile !== 'function') {
    throw new RuntimeFatalError('Component import requires a resolved script/template object', pos.lineno, pos.colno, null, pos.path);
  }
  if (componentInstance.closed) {
    return componentInstance;
  }

  resolvedTemplate.compile();
  componentContext.path = resolvedTemplate.path;
  componentInstance.template = resolvedTemplate;

  try {
    inheritanceBootstrap.bootstrapInheritanceMetadata(
      inheritanceState,
      resolvedTemplate.methods || {},
      resolvedTemplate.sharedSchema || [],
      resolvedTemplate.path,
      componentRoot,
      componentContext
    );
  } catch (err) {
    _normalizeComponentBootstrapFailure(err, pos, componentContext.path || pos.path);
  }

  if (inputValues && typeof inputValues === 'object' && Object.keys(inputValues).length > 0) {
    try {
      inheritanceBootstrap.preloadSharedInputs(
        resolvedTemplate.sharedSchema || [],
        inputValues,
        componentRoot,
        componentContext,
        pos,
        'component import'
      );
    } catch (err) {
      _normalizeComponentBootstrapFailure(err, pos, componentContext.path || pos.path);
    }
  }

  const constructorEntry = (resolvedTemplate.methods || {}).__constructor__;
  if (constructorEntry) {
    const admission = inheritanceCall.admitConstructorEntry(
      componentContext,
      inheritanceState,
      constructorEntry,
      [],
      env,
      runtime,
      cb,
      componentRoot,
      pos
    );
    if (admission && admission.completion && typeof admission.completion.then === 'function') {
      admission.completion.catch((err) => {
        // Component constructors ignore their own return value. Non-fatal
        // failures remain visible through poisoned shared channel state; only
        // fatal completion failures need explicit cb() routing here.
        if (err instanceof RuntimeFatalError) {
          cb(err);
        }
      });
    }
  }

  return componentInstance;
}

function startComponentBootstrap({
  templateValue,
  inputValues,
  componentContext,
  componentRoot,
  componentInstance,
  inheritanceState,
  env,
  runtime,
  cb,
  pos
}) {
  const bootstrapChannelName = '__component_bootstrap__';
  declareBufferChannel(componentRoot, bootstrapChannelName, 'var', componentContext, null);

  try {
    const resolvedTemplate = resolveSingle(templateValue);
    if (!resolvedTemplate || typeof resolvedTemplate.then !== 'function') {
      return _bootstrapResolvedTemplate({
        resolvedTemplate,
        inputValues,
        componentContext,
        componentRoot,
        componentInstance,
        inheritanceState,
        env,
        runtime,
        cb,
        pos
      });
    }
    const bootstrapPromise = resolvedTemplate.then((loadedTemplate) =>
      _bootstrapResolvedTemplate({
        resolvedTemplate: loadedTemplate,
        inputValues,
        componentContext,
        componentRoot,
        componentInstance,
        inheritanceState,
        env,
        runtime,
        cb,
        pos
      })
    );
    componentRoot.add(new WaitResolveCommand({
      channelName: bootstrapChannelName,
      args: [bootstrapPromise],
      pos
    }), bootstrapChannelName);
    return bootstrapPromise;
  } catch (err) {
    if (err instanceof RuntimeFatalError) {
      throw err;
    }
    throw new RuntimeFatalError(err, pos.lineno, pos.colno, null, pos.path);
  }
}

module.exports = {
  startComponentBootstrap
};
