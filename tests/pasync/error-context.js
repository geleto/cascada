import expect from 'expect.js';
import {
  CommandBuffer,
  ErrorCommand,
  PoisonError,
  RuntimeError,
  RuntimeFatalError,
  createPoison,
  declareBufferChain,
  getErrorInfo,
  contextualizeError,
  guard,
  handleFatal,
  isPoison,
  memberLookupScript,
  normalizeErrorContext,
  prepareErrorContexts,
  runControlFlowBoundary,
  runValueBoundary,
  sequentialContextLookupValue
} from '../../src/runtime/runtime.js';
import * as runtime from '../../src/runtime/runtime.js';
import {AsyncEnvironment} from '../../src/environment/async-environment.js';
import {Script} from '../../src/environment/script.js';
import {AsyncTemplate} from '../../src/environment/template.js';
import {StringLoader} from '../util.js';

describe('error context tracing runtime foundation', () => {
  it('prepares compact contexts without mutating shared specs', () => {
    const labels = ['For.Iterator(Symbol)'];
    const specs = [
      [1, 0, 'Root'],
      [7, 11, 0]
    ];
    const reportError = () => {};

    const prepared = prepareErrorContexts('script.casc', reportError, labels, specs);

    expect(prepared).to.eql([
      [1, 0, 'Root', 'script.casc', reportError],
      [7, 11, 'For.Iterator(Symbol)', 'script.casc', reportError]
    ]);
    expect(specs).to.eql([
      [1, 0, 'Root'],
      [7, 11, 0]
    ]);

    const secondCb = () => {};
    const second = prepareErrorContexts('other.casc', secondCb, labels, specs);

    expect(second).to.eql([
      [1, 0, 'Root', 'other.casc', secondCb],
      [7, 11, 'For.Iterator(Symbol)', 'other.casc', secondCb]
    ]);
    expect(second[0]).not.to.be(prepared[0]);
    expect(second[1]).not.to.be(prepared[1]);
  });

  it('wraps errors with compact context metadata', () => {
    const ec = [3, 7, 'If.Condition(LookupVal)', 'script.casc', null];
    const wrapped = contextualizeError(new Error('bad condition'), ec);

    expect(wrapped.message).to.contain('(script.casc) [Line 3, Column 7]');
    expect(wrapped.message).to.contain('doing \'If.Condition(LookupVal)\'');
    expect(wrapped.errorContext).to.eql(ec);
    expect(wrapped.label).to.be('If.Condition(LookupVal)');
  });

  it('normalizes compact contexts', () => {
    const reportError = () => {};

    expect(normalizeErrorContext([1, 2, 'LookupVal', 'script.casc', reportError])).to.eql({
      lineno: 1,
      colno: 2,
      label: 'LookupVal',
      path: 'script.casc',
      reportError
    });
    try {
      normalizeErrorContext(null);
      expect().fail('Expected normalizeErrorContext to reject null');
    } catch (err) {
      expect(err.message).to.contain('compact error context');
    }
  });

  it('does not add source metadata when no context is present', () => {
    const err = new RuntimeError('plain failure');

    expect(err.message).to.equal('plain failure');
    expect(err.errorContext).to.be(null);
  });

  it('preserves an existing error context over helper fallback context', () => {
    const origin = [2, 4, 'FunCall', 'origin.casc', null];
    const fallback = [9, 1, 'Output', 'consumer.casc', null];
    const wrapped = contextualizeError(new Error('original failure'), origin);
    const consumed = contextualizeError(wrapped, fallback);

    expect(consumed).to.equal(wrapped);
    expect(consumed.errorContext).to.eql(origin);
    expect(getErrorInfo(consumed, fallback, null, false)).to.eql({
      lineno: 2,
      colno: 4,
      path: 'origin.casc',
      label: 'FunCall',
      reportError: null
    });
    expect(getErrorInfo(consumed, fallback, null, true).stack).to.eql([]);
  });

  it('preserves existing context when RuntimeError wraps an error directly', () => {
    const origin = [2, 4, 'FunCall', 'origin.casc', null];
    const fallback = [9, 1, 'Output', 'consumer.casc', null];
    const err = new Error('original failure');
    err.errorContext = origin;

    const wrapped = new RuntimeError(err, fallback);

    expect(wrapped.errorContext).to.eql(origin);
    expect(wrapped.message).to.contain('origin.casc');
    expect(wrapped.message).to.contain('doing \'FunCall\'');
  });

  it('stores context on PoisonError contents rather than the wrapper', () => {
    const origin = [2, 4, 'FunCall', 'origin.casc', null];
    const fallback = [9, 1, 'Output', 'consumer.casc', null];
    const poison = new PoisonError([new Error('poisoned')], origin);

    const cloned = new PoisonError(poison, fallback);

    expect(poison.errorContext).to.be(undefined);
    expect(poison.errors[0].errorContext).to.eql(origin);
    expect(cloned.errorContext).to.be(undefined);
    expect(cloned.errors[0].errorContext).to.eql(origin);
  });

  it('applies context precedence per PoisonError contained error', () => {
    const origin = [4, 2, 'LookupVal', 'origin.casc', null];
    const fallback = [8, 3, 'For.Iterator(Symbol)', 'consumer.casc', null];
    const wrapped = contextualizeError(new Error('already wrapped'), origin);
    const raw = new Error('raw');
    const poison = new PoisonError([wrapped, raw]);

    const handled = contextualizeError(poison, fallback);

    expect(handled.errors[0].errorContext).to.eql(origin);
    expect(handled.errors[1].errorContext).to.eql(fallback);
    expect(handled.errors[1].message).to.contain('consumer.casc');
  });

  it('does not wrap PoisonError contents when no context exists', () => {
    const raw = new Error('raw');
    const poison = new PoisonError([raw]);

    const handled = contextualizeError(poison);

    expect(handled.errors[0]).to.equal(raw);
  });

  it('createPoison accepts plural inputs and compact context', () => {
    const ec = [5, 9, 'Switch.Expression(Symbol)', 'switch.casc', null];
    const poison = createPoison([new Error('one'), 'two'], ec);

    expect(isPoison(poison)).to.be(true);
    expect(poison.errors).to.have.length(2);
    expect(poison.errors[0].errorContext).to.eql(ec);
    expect(poison.errors[1].errorContext).to.eql(ec);
    expect(poison.errors[1].message).to.contain('two');
  });

  it('applies lookup context to promise input failures', async () => {
    const ec = [8, 12, 'LookupVal', 'lookup.casc', null];
    const buffer = new CommandBuffer({ path: 'lookup.casc' });

    try {
      await memberLookupScript(Promise.reject(new Error('lookup failed')), 'name', ec, buffer);
      throw new Error('expected lookup failure');
    } catch (error) {
      const contextualError = error.errors ? error.errors[0] : error;
      expect(contextualError.errorContext).to.eql(ec);
      expect(contextualError.message).to.contain('lookup.casc');
      expect(contextualError.message).to.contain('LookupVal');
    }
  });

  it('stores sequential root lookup command context without normalizing position', () => {
    const ec = [9, 4, 'Symbol', 'sequence.casc', null];
    let command = null;
    const buffer = {
      getChainIfExists: () => ({ _chainType: 'sequential_path' }),
      addCommand: (cmd) => {
        command = cmd;
        return cmd.promise;
      }
    };

    sequentialContextLookupValue({ lookup: () => 'db' }, 'db', '!db', ec, false, buffer);

    expect(command.errorContext).to.eql(ec);
    expect(command.pos).to.be(undefined);
  });

  it('RuntimeFatalError accepts compact context', () => {
    const ec = [6, 10, 'Include.Template', 'include.casc', null];
    const err = new RuntimeFatalError('include failed', ec, {});

    expect(err.name).to.be('RuntimeFatalError');
    expect(err.errorContext).to.eql(ec);
    expect(err.message).to.contain('(include.casc) [Line 6, Column 10]');
    expect(err.message).to.contain('doing \'Include.Template\'');
  });

  it('handleFatal reports through context callback when present', () => {
    let reported = null;
    const reportError = err => {
      reported = err;
    };
    const ec = [7, 2, 'AsyncBoundary', 'fatal.casc', reportError];

    const wrapped = handleFatal(new Error('fatal failure'), ec);

    expect(reported).to.equal(wrapped);
    expect(wrapped.errorContext).to.eql(ec);
    expect(wrapped.message).to.contain('fatal.casc');
  });

  it('handleFatal throws when no context callback is present', () => {
    const ec = [7, 2, 'AsyncBoundary', 'fatal.casc', null];

    expect(() => handleFatal(new Error('fatal failure'), ec)).to.throwException(err => {
      expect(err.errorContext).to.eql(ec);
      expect(err.message).to.contain('fatal.casc');
    });
  });

  it('includes command-buffer error context in error info', () => {
    const opEc = [9, 1, 'Output', 'consumer.casc', null];
    const bufferEc = [3, 4, 'If.Condition(FunCall)', 'script.casc', null];
    const buffer = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, {
      ec: bufferEc,
      branch: 'then',
      branchName: 'if-block'
    });

    const info = getErrorInfo(new Error('failure'), opEc, buffer, false);

    expect(info.buffer).to.eql({
      lineno: 3,
      colno: 4,
      path: 'script.casc',
      label: 'If.Condition(FunCall)',
      branch: 'then',
      branchName: 'if-block'
    });
  });

  it('builds command-buffer stack through parent links', () => {
    const rootEc = [1, 0, 'Root', 'script.casc', null];
    const childEc = [5, 2, 'For.Iterator(Symbol)', 'script.casc', null];
    const root = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, {
      ec: rootEc,
      branchName: 'root'
    });
    const loop = {
      index: 2,
      index0: 1,
      length: 3,
      first: false,
      last: false,
      revindex: 2,
      revindex0: 1
    };
    const child = new CommandBuffer({ path: 'script.casc' }, root, null, null, null, {
      ec: childEc,
      loop
    });

    const info = getErrorInfo(new Error('failure'), childEc, child, true);

    expect(info.stack).to.eql([
      {
        lineno: 5,
        colno: 2,
        path: 'script.casc',
        label: 'For.Iterator(Symbol)',
        loop
      },
      {
        lineno: 1,
        colno: 0,
        path: 'script.casc',
        label: 'Root',
        branchName: 'root'
      }
    ]);
  });

  it('builds command-buffer stack through traceParent for clear-scope buffers', () => {
    const rootEc = [1, 0, 'Root', 'script.casc', null];
    const macroEc = [7, 2, 'Macro', 'script.casc', null];
    const root = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, {
      ec: rootEc,
      branchName: 'root'
    });
    const macro = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, {
      ec: macroEc,
      branchName: 'renderCard'
    }, root);

    const info = getErrorInfo(new Error('failure'), macroEc, macro, true);

    expect(info.stack.map(frame => frame.branchName)).to.eql(['renderCard', 'root']);
  });

  it('prefers traceParent over parent when building command-buffer stack', () => {
    const sharedEc = [2, 0, 'SharedRoot', 'script.casc', null];
    const callerEc = [4, 0, 'CallerSite', 'script.casc', null];
    const methodEc = [9, 0, 'Method', 'script.casc', null];
    const shared = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, {
      ec: sharedEc,
      branchName: 'shared'
    });
    const caller = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, {
      ec: callerEc,
      branchName: 'caller'
    });
    const method = new CommandBuffer({ path: 'script.casc' }, shared, null, null, null, {
      ec: methodEc,
      branchName: 'method'
    }, caller);

    const info = getErrorInfo(new Error('failure'), methodEc, method, true);

    expect(info.stack.map(frame => frame.branchName)).to.eql(['method', 'caller']);
  });

  it('stores buffer branch context on runtime value boundaries', async () => {
    const root = new CommandBuffer({ path: 'script.casc' });
    const boundaryEc = [11, 6, 'FunCall', 'script.casc', null];
    let child = null;

    await runValueBoundary(root, null, null, async (currentBuffer) => {
      child = currentBuffer;
    }, { ec: boundaryEc, loadName: 'include source@(11,6)' });

    expect(child.traceParent).to.be(root);
    expect(child.bufferBranchContext).to.eql({
      ec: boundaryEc,
      loadName: 'include source@(11,6)'
    });
  });

  it('stores buffer branch context on runtime control-flow boundaries', async () => {
    const root = new CommandBuffer({ path: 'script.casc' });
    const boundaryEc = [12, 3, 'If.Condition(Symbol)', 'script.casc', null];
    let child = null;

    await runControlFlowBoundary(root, null, null, { path: 'script.casc' }, null, async (currentBuffer) => {
      child = currentBuffer;
    }, { ec: boundaryEc, branch: 'then' });

    expect(child.traceParent).to.be(root);
    expect(child.bufferBranchContext).to.eql({
      ec: boundaryEc,
      branch: 'then'
    });
  });

  it('requires source context on command-buffer error commands', () => {
    const ec = [13, 2, 'Guard.Condition(Symbol)', 'script.casc', null];
    const command = new ErrorCommand([new Error('guard failed')], ec);

    expect(command.errorContext).to.eql(ec);
    expect(() => new ErrorCommand([new Error('guard failed')])).to.throwError(/ErrorCommand requires a compact errorContext/);
  });

  it('requires source context for direct text chain invocation', () => {
    const buffer = new CommandBuffer({ path: 'script.casc' });
    const text = declareBufferChain(buffer, 'text', 'text', { path: 'script.casc' }, null);
    const ec = [14, 4, 'Output(Symbol)', 'script.casc', null];

    expect(() => text.invoke()).to.throwError(/TextChain\.invoke requires a compact errorContext/);
    expect(() => text.invoke(ec)).to.not.throwError();
    expect(() => text.invoke('hello', ec)).to.not.throwError();
  });

  it('requires source context for guard command helpers', () => {
    const buffer = new CommandBuffer({ path: 'script.casc' });
    declareBufferChain(buffer, 'text', 'text', { path: 'script.casc' }, null);

    expect(() => guard.initChainSnapshots(['text'], buffer, null)).to.throwError(/guard\.initChainSnapshots requires a compact errorContext/);
  });

  describe('error context compiler table', () => {
    it('emits prepared context tables with repeated labels compressed inline', () => {
      const env = new AsyncEnvironment();
      const source = new Script([
        'data result',
        'var x = true',
        'if x',
        '  result.a.set(1)',
        'endif',
        'if x',
        '  result.b.set(2)',
        'endif',
        'return result.snapshot()'
      ].join('\n'), env, 'context-table.casc').compileSource();

      expect(source).to.contain('const __ec = getErrorContexts(runtime, context.path, reportError);');
      expect(source).to.contain('function getErrorContexts(runtime, path, reportError) {');
      expect(source).to.contain('return runtime.prepareErrorContexts(path, reportError,');
      expect(source).to.contain('"If.Condition(Symbol)"');
      expect(source).to.match(/\[3,7,\d+\]/);
      expect(source).to.match(/\[6,7,\d+\]/);
      expect(source).to.match(/\[\d+,\d+,"[^"]+"\]/);
      expect(source).to.match(/new runtime\.CommandBuffer\(context, null, null, null, null, \{ ec: __ec\[\d+\], branchName: "root" \}\);/);
    });

    it('uses parent-provided semantic labels in generated diagnostics', () => {
      const env = new AsyncEnvironment();
      const source = new Script([
        'data result',
        'var x = true',
        'if x',
        '  result.a.set(1)',
        'endif',
        'return result.snapshot()'
      ].join('\n'), env, 'semantic-label.casc').compileSource();

      expect(source).to.contain('If.Condition(Symbol)');
    });

    it('uses semantic labels for switch case expressions', () => {
      const env = new AsyncEnvironment();
      const source = new AsyncTemplate([
        '{% switch status %}',
        '{% case "active" %}yes',
        '{% default %}no',
        '{% endswitch %}'
      ].join('\n'), env, 'switch-label.njk').compileSource();

      expect(source).to.contain('Switch.Expression(Symbol)');
      expect(source).to.contain('Switch.Case(Literal)');
    });

    it('prepares contexts once in the root and threads them into sibling callables', () => {
      const env = new AsyncEnvironment();
      const source = new AsyncTemplate([
        '{% block body %}',
        '  {{ name }}',
        '{% endblock %}'
      ].join('\n'), env, 'block-context.njk').compileSource();

      expect(source.match(/runtime\.prepareErrorContexts/g)).to.have.length(1);
      expect(source).to.contain('const __ec = getErrorContexts(runtime, context.path, reportError);');
      expect(source).to.match(/function b_body\(env, context, runtime, reportError, parentBuffer = null.*currentInstance\)/);
      expect(source).not.to.contain('__ec = null');
      expect(source).to.contain('methodData.errorContextTable[');
    });

    it('uses script labels for script-mode load targets', () => {
      const env = new AsyncEnvironment();
      const source = new Script([
        'extends "base.script"',
        'import "lib.script" as lib',
        'from "more.script" import importedValue',
        'component "card.script" as card',
        'return lib'
      ].join('\n'), env, 'script-load-labels.casc').compileSource();

      expect(source).to.contain('Import.Script(Literal)');
      expect(source).to.contain('FromImport.Script(Literal)');
      expect(source).to.contain('Component.Script(Literal)');
      expect(source).to.contain('Extends.Script(Literal)');
    });

    it('prepares parent artifact contexts when invoking inherited template blocks', async () => {
      const loader = new StringLoader();
      loader.addTemplate('parent.njk', '{% block body %}Parent {{ name }}{% endblock %}');
      loader.addTemplate('child.njk', '{% extends "parent.njk" %}');
      const env = new AsyncEnvironment(loader);
      const parent = await env.getTemplate('parent.njk', true, null, false);
      const parentContextPaths = [];
      const getParentErrorContexts = parent.getErrorContexts;

      parent.getErrorContexts = function getObservedErrorContexts(runtimeArg, path, reportError) {
        parentContextPaths.push(path);
        return getParentErrorContexts.call(this, runtimeArg, path, reportError);
      };

      const result = await env.renderTemplate('child.njk', { name: 'Ada' });

      expect(result.trim()).to.be('Parent Ada');
      expect(parentContextPaths).to.contain('parent.njk');
    });

    it('prepares script artifact contexts when invoking inherited script methods', async () => {
      const loader = new StringLoader();
      loader.addTemplate('parent.script', [
        'method build(name)',
        '  return "Parent " + name',
        'endmethod'
      ].join('\n'));
      loader.addTemplate('child.script', [
        'extends "parent.script"',
        'method build(name)',
        '  return super(name)',
        'endmethod'
      ].join('\n'));
      const env = new AsyncEnvironment(loader);
      const parent = await env.getScript('parent.script', true, null, false);
      const parentContextPaths = [];
      const getParentErrorContexts = parent.getErrorContexts;

      parent.getErrorContexts = function getObservedScriptErrorContexts(runtimeArg, path, reportError) {
        parentContextPaths.push(path);
        return getParentErrorContexts.call(this, runtimeArg, path, reportError);
      };

      const child = await env.getScript('child.script', true, null, false);
      const instance = await runtime.InheritanceInstance.create({
        entryTemplateOrScript: child,
        env,
        context: child._createContext({ name: 'Ada' }),
        runtime,
        reportError: () => {}
      });
      const result = await instance.invoke('build', ['Ada'], [1, 0, 'Call', 'test.script', null]);

      expect(result).to.be('Parent Ada');
      expect(parentContextPaths).to.contain('parent.script');
    });

    it('uses one reportError callback when rendering included templates', async () => {
      const loader = new StringLoader();
      loader.addTemplate('parent.njk', 'Parent {% include "child.njk" %}');
      loader.addTemplate('child.njk', 'Child');
      const env = new AsyncEnvironment(loader);
      const parent = await env.getTemplate('parent.njk', true, null, false);
      const child = await env.getTemplate('child.njk', true, null, false);
      const reporters = [];

      parent.compile();
      child.compile();

      const parentRoot = parent.rootRenderFunc;
      parent.rootRenderFunc = function observedParentRoot(envArg, contextArg, runtimeArg, reportError, ...rest) {
        reporters.push({ path: 'parent.njk', reportError });
        return parentRoot.call(this, envArg, contextArg, runtimeArg, reportError, ...rest);
      };

      const childRoot = child.rootRenderFunc;
      child.rootRenderFunc = function observedChildRoot(envArg, contextArg, runtimeArg, reportError, ...rest) {
        reporters.push({ path: 'child.njk', reportError });
        return childRoot.call(this, envArg, contextArg, runtimeArg, reportError, ...rest);
      };

      const result = await parent.render({});

      expect(result.trim()).to.be('Parent Child');
      expect(reporters.map((entry) => entry.path)).to.eql(['parent.njk', 'child.njk']);
      expect(reporters[1].reportError).to.be(reporters[0].reportError);
    });

    it('reports included template failures through the shared reportError callback once', async () => {
      const loader = new StringLoader();
      loader.addTemplate('parent.njk', 'Parent {% include "child.njk" with fail %}');
      loader.addTemplate('child.njk', '{{ fail() }}');
      const env = new AsyncEnvironment(loader);
      const parent = await env.getTemplate('parent.njk', true, null, false);
      const child = await env.getTemplate('child.njk', true, null, false);
      const reporters = [];
      let callbackCount = 0;

      parent.compile();
      child.compile();

      const parentRoot = parent.rootRenderFunc;
      parent.rootRenderFunc = function observedParentRoot(envArg, contextArg, runtimeArg, reportError, ...rest) {
        reporters.push({ path: 'parent.njk', reportError });
        return parentRoot.call(this, envArg, contextArg, runtimeArg, reportError, ...rest);
      };

      const childRoot = child.rootRenderFunc;
      child.rootRenderFunc = function observedChildRoot(envArg, contextArg, runtimeArg, reportError, ...rest) {
        reporters.push({ path: 'child.njk', reportError });
        return childRoot.call(this, envArg, contextArg, runtimeArg, reportError, ...rest);
      };

      const error = await new Promise((resolve) => {
        parent.render({
          fail() {
            throw new Error('included failure');
          }
        }, (err) => {
          callbackCount++;
          resolve(err);
        });
      });

      expect(error).to.be.an(Error);
      expect(error.message).to.contain('included failure');
      expect(callbackCount).to.be(1);
      expect(reporters.map((entry) => entry.path)).to.eql(['parent.njk', 'child.njk']);
      expect(reporters[1].reportError).to.be(reporters[0].reportError);
    });

    it('emits compact contexts for migrated helper and command call sites', () => {
      const env = new AsyncEnvironment();
      const source = new Script([
        'data result',
        'var user = fetchUser(userId)',
        'var name = user.name',
        'db!.save(name)',
        'result.name.set(name)',
        'return result.snapshot()'
      ].join('\n'), env, 'phase4-generated.casc').compileSource();

      expect(source).to.match(/runtime\.callWrapAsync\([^;]+__ec\[\d+\], output\)/);
      expect(source).to.match(/context\.lookupScript\("fetchUser", __ec\[\d+\]\)/);
      expect(source).to.match(/runtime\.memberLookupScript\([^;]+__ec\[\d+\], output\)/);
      expect(source).to.match(/runtime\.sequentialCallWrapValue\([^;]+__ec\[\d+\], false, output\)/);
      expect(source).to.match(/new runtime\.SnapshotCommand\(\{ chainName: "name", errorContext: __ec\[\d+\] \}\)/);
      expect(source).to.match(/new runtime\.VarCommand\(\{ chainName: 'name', args: \[t_\d+\], errorContext: __ec\[\d+\] \}\)/);
      expect(source).to.contain('new runtime.DataCommand({ chainName: \'result\'');
      expect(source).to.match(/errorContext: __ec\[\d+\] \}\);/);
    });

    it('passes compact contexts into sequential root lookups', () => {
      const env = new AsyncEnvironment();
      const source = new Script([
        'data result',
        'db!.save(userId)',
        'return result.snapshot()'
      ].join('\n'), env, 'phase4-sequential-root.casc').compileSource();

      expect(source).to.match(/runtime\.sequentialCallWrapValue\([^;]+context\.lookupScript\("db", __ec\[\d+\]\)[^;]+__ec\[\d+\], false, output\)/);
    });
  });
});
