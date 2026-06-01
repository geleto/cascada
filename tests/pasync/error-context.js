import expect from 'expect.js';
import {
  CommandBuffer,
  ErrorCommand,
  PoisonError,
  PoisonErrorGroup,
  RuntimeError,
  declareBufferChain,
  guard,
  isPoison,
  memberLookupScript,
  prepareErrorContexts,
  runControlFlowBoundary,
  runValueBoundary,
  sequentialContextLookupValue
} from '../../src/runtime/runtime.js';
import * as runtime from '../../src/runtime/runtime.js';
import {AsyncEnvironment} from '../../src/environment/async-environment.js';
import {Script} from '../../src/environment/script.js';
import {AsyncTemplate} from '../../src/environment/template.js';
import {CompileError} from '../../src/errors.js';
import {StringLoader} from '../util.js';

const TEST_EC = [1, 1, 'Test', 'test.casc', null];
const TEST_DIAGNOSTIC_CONTEXT = { ec: TEST_EC, entryName: 'test' };

async function captureCommandStacks(render, shouldCapture) {
  const originalAddCommand = CommandBuffer.prototype.addCommand;
  const markerBuffers = [];
  CommandBuffer.prototype.addCommand = function(command, chainName) {
    if (this.bufferStackContext && shouldCapture(command, chainName)) {
      markerBuffers.push(this);
    }
    return originalAddCommand.call(this, command, chainName);
  };

  let output;
  try {
    output = await render();
  } finally {
    CommandBuffer.prototype.addCommand = originalAddCommand;
  }

  return {
    output,
    stacks: markerBuffers.map(buffer => buffer.getDiagnosticStack()),
    messages: markerBuffers.map(buffer =>
      runtime.RuntimeContextError.formatInfo(null, buffer.bufferStackContext, { stackBuffer: buffer })
    )
  };
}

async function captureSymbolTextStacks(render) {
  return captureCommandStacks(render, (command) =>
    command instanceof runtime.TextCommand &&
    command.errorContext &&
    command.errorContext[2] === 'Symbol'
  );
}

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

  it('allows contextless RuntimeError only as a fatal runtime fallback', () => {
    const ec = [1, 1, 'Direct.RuntimeError', 'direct.casc', null];
    const err = new RuntimeError('plain failure', ec);

    expect(err.message).to.contain('direct.casc');
    expect(err.context).to.eql({
      lineno: 1,
      colno: 1,
      label: 'Direct.RuntimeError',
      path: 'direct.casc',
      renderState: null
    });
    expect(err.errorContext).to.be(undefined);
    const contextless = new RuntimeError('missing context');
    expect(contextless.context).to.eql({
      lineno: null,
      colno: null,
      label: null,
      path: null,
      renderState: null
    });
    expect(contextless.message).to.contain('(unknown path) [Line ?, Column ?]');
    expect(() => contextless.getInfo()).to.throwException((error) => {
      expect(error.message).to.contain('origin context');
    });
  });

  it('preserves existing context when RuntimeError wraps an error directly', () => {
    const origin = [2, 4, 'FunCall', 'origin.casc', null];
    const fallback = [9, 1, 'Output', 'consumer.casc', null];
    const err = new Error('original failure');
    err._errorContext = origin;

    const wrapped = new RuntimeError(err, fallback);

    expect(wrapped.context.path).to.be('origin.casc');
    expect(wrapped.context.label).to.be('FunCall');
    expect(wrapped.message).to.contain('origin.casc');
    expect(wrapped.message).to.contain('FunCall');
    expect(wrapped.fullMessage).to.contain('RuntimeError: original failure');
    expect(wrapped.fullMessage).to.contain('(origin.casc) [Line 2, Column 4] FunCall');
  });

  it('exposes a common diagnostic shape on CompileError', () => {
    const err = new CompileError('bad syntax', {
      lineno: 3,
      colno: 8,
      label: 'Parser',
      path: 'compile.casc'
    });

    expect(err.description).to.be('bad syntax');
    expect(err.message).to.be([
      'CompileError: bad syntax',
      '(compile.casc) [Line 3, Column 8] Parser'
    ].join('\n'));
    expect(err.fullMessage).to.be(err.message);
    expect(err.context).to.eql({
      lineno: 3,
      colno: 8,
      label: 'Parser',
      path: 'compile.casc'
    });
  });

  it('stores source context on PoisonError and preserves it when grouped', () => {
    const origin = [2, 4, 'FunCall', 'origin.casc', null];
    const poison = PoisonError.create('poisoned', origin);
    const grouped = new PoisonErrorGroup(poison);

    expect(poison.context.path).to.be('origin.casc');
    expect(poison.context.label).to.be('FunCall');
    expect(grouped.context).to.eql(poison.context);
    expect(grouped.errors[0]).to.be(poison);
  });

  it('requires existing poison errors when grouping', () => {
    const raw = new Error('raw');

    expect(() => PoisonError.group([raw])).to.throwException((error) => {
      expect(error.message).to.contain('existing poison errors');
    });
  });

  it('createPoison accepts ready poison errors only', () => {
    const ec = [5, 9, 'Switch.Expression(Symbol)', 'switch.casc', null];
    const poison = runtime.createPoison(PoisonError.create('one', ec));

    expect(isPoison(poison)).to.be(true);
    expect(poison.errors).to.have.length(1);
    expect(poison.errors[0].context.label).to.be('Switch.Expression(Symbol)');
  });

  it('preserves promise input failure origin through lookup consumption', async () => {
    const ec = [8, 12, 'LookupVal', 'lookup.casc', null];
    const origin = [3, 5, 'Origin', 'origin.casc', null];
    const buffer = new CommandBuffer({ path: 'lookup.casc' }, null, null, null, null, { ec, entryName: 'lookup' });
    const inputError = PoisonError.create('lookup failed', origin);

    try {
      await memberLookupScript(Promise.reject(inputError), 'name', ec, buffer);
      throw new Error('expected lookup failure');
    } catch (error) {
      const contextualError = error.errors ? error.errors[0] : error;
      expect(contextualError.context.path).to.be('origin.casc');
      expect(contextualError.context.label).to.be('Origin');
      expect(contextualError.message).to.contain('origin.casc');
      expect(contextualError.message).to.contain('Origin');
    }
  });

  it('uses the call-site context for errors thrown by user functions', async () => {
    const env = new AsyncEnvironment();
    env.addGlobal('fail', () => {
      throw new Error('user poison');
    });

    try {
      await env.renderTemplateString('{{ fail() }}');
      throw new Error('expected poison failure');
    } catch (error) {
      expect(error.errors).to.have.length(1);
      expect(error.errors[0].label).to.be('FunCall');
      expect(error.errors[0].message).to.contain('FunCall');
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

  it('RuntimeError accepts compact context', () => {
    const ec = [6, 10, 'Include.Template', 'include.casc', null];
    const err = new RuntimeError('include failed', ec);

    expect(err.name).to.be('RuntimeError');
    expect(err.context.label).to.be('Include.Template');
    expect(err.message).to.contain('RuntimeError: include failed');
    expect(err.message).to.contain('(include.casc) [Line 6, Column 10] Include.Template');
    expect(err.message).to.contain('Include.Template');
    expect(err.fullMessage).to.contain('RuntimeError: include failed');
  });

  it('RuntimeError merges buffer stack metadata with compact context', () => {
    const ec = [8, 2, 'For', 'loop.casc', null];
    const bufferStackContext = {
      ec,
      blockName: 'body',
      loop: { index: 1, variables: ['item'] }
    };
    const err = RuntimeError.create('loop failed', bufferStackContext);
    const info = err.getInfo();

    expect(err.context.label).to.be('For');
    expect(err.context.blockName).to.be('body');
    expect(err.context.loop).to.eql({ index: 1, variables: ['item'] });
    expect(err.fullMessage).to.contain('RuntimeError: loop failed');
    expect(err.fullMessage).to.contain('(loop.casc) [Line 8, Column 2] For');
    expect(info).to.eql({
      lineno: 8,
      colno: 2,
      path: 'loop.casc',
      label: 'For',
      blockName: 'body',
      loop: { index: 1, variables: ['item'] }
    });
  });

  it('render state returns a rejected root race after synchronous fatal report', async () => {
    const renderState = runtime.createRenderState();
    const failure = new Error('sync fatal');

    renderState.reportFatalError(failure);

    try {
      await renderState.raceRootResult('ignored');
      expect().fail('Expected render-state race to reject');
    } catch (error) {
      expect(error).to.be(failure);
    }
  });

  it('includes command-buffer error context in error info', () => {
    const bufferEc = [3, 4, 'If.Condition(FunCall)', 'script.casc', null];
    const buffer = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, {
      ec: bufferEc,
      branch: 'then',
      blockName: 'if-block'
    });

    expect(buffer.getDiagnosticContext()).to.eql({
      lineno: 3,
      colno: 4,
      path: 'script.casc',
      label: 'If.Condition(FunCall)',
      branch: 'then',
      blockName: 'if-block'
    });
  });

  it('builds command-buffer stack through parent links', () => {
    const rootEc = [1, 0, 'Root', 'script.casc', null];
    const childEc = [5, 2, 'For.Iterator(Symbol)', 'script.casc', null];
    const root = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, {
      ec: rootEc,
      entryName: 'root'
    });
    const loop = {
      index: 2,
      index0: 1,
      length: 3,
      first: false,
      last: false,
      revindex: 2,
      revindex0: 1,
      variables: ['item']
    };
    const child = new CommandBuffer({ path: 'script.casc' }, root, null, null, null, {
      ec: childEc,
      loop
    });

    expect(child.getDiagnosticStack()).to.eql([
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
        entryName: 'root'
      }
    ]);
  });

  it('builds command-buffer stack through traceParent for clear-scope buffers', () => {
    const rootEc = [1, 0, 'Root', 'script.casc', null];
    const macroEc = [7, 2, 'Macro', 'script.casc', null];
    const root = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, {
      ec: rootEc,
      entryName: 'root'
    });
    const macro = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, {
      ec: macroEc,
      macroName: 'renderCard'
    }, root);

    expect(macro.getDiagnosticStack().map(frame => frame.macroName || frame.entryName)).to.eql(['renderCard', 'root']);
  });

  it('prefers traceParent over parent when building command-buffer stack', () => {
    const sharedEc = [2, 0, 'SharedRoot', 'script.casc', null];
    const callerEc = [4, 0, 'CallerSite', 'script.casc', null];
    const methodEc = [9, 0, 'Method', 'script.casc', null];
    const shared = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, {
      ec: sharedEc,
      entryName: 'shared'
    });
    const caller = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, {
      ec: callerEc,
      caller: true
    });
    const method = new CommandBuffer({ path: 'script.casc' }, shared, null, null, null, {
      ec: methodEc,
      methodName: 'method'
    }, caller);

    expect(method.getDiagnosticStack().map(frame => frame.methodName || (frame.caller ? 'caller' : frame.entryName))).to.eql(['method', 'caller']);
  });

  it('outputs actual compiled boundary metadata in one stack', async () => {
    const { output, stacks, messages } = await captureSymbolTextStacks(async () => {
      const env = new AsyncEnvironment();
      const template = new AsyncTemplate(
        '{% macro wrap() %}{{ caller() }}{% endmacro %}' +
        '{% call wrap() %}' +
        '{% for item in items %}' +
        '{% if item.ok %}{{ marker }}{% endif %}' +
        '{% endfor %}' +
        '{% endcall %}',
        env,
        'macro-stack.njk'
      );
      return template.render(
        {
          items: [{ ok: true }],
          marker: Promise.resolve('STACK_MARKER')
        }
      );
    });

    expect(output).to.be('STACK_MARKER');
    const stack = stacks[stacks.length - 1];

    expect(stack).to.eql([
      {
        lineno: 1,
        colno: 96,
        path: 'macro-stack.njk',
        label: 'If.Condition(LookupVal)',
        branch: 'then'
      },
      {
        lineno: 1,
        colno: 66,
        path: 'macro-stack.njk',
        label: 'Iteration',
        loop: {
          index: 1,
          index0: 0,
          first: true,
          length: 1,
          last: true,
          revindex: 1,
          revindex0: 0,
          variables: ['item']
        }
      },
      {
        lineno: 1,
        colno: 66,
        path: 'macro-stack.njk',
        label: 'For',
        loopVariables: ['item']
      },
      {
        lineno: 1,
        colno: 27,
        path: 'macro-stack.njk',
        label: 'FunCall',
        caller: true,
        callableName: 'caller',
        callSignature: 'caller()'
      },
      {
        lineno: 1,
        colno: 3,
        path: 'macro-stack.njk',
        label: 'Macro',
        callerBlock: true,
        macroName: 'wrap',
        macroSignature: 'wrap()'
      },
      {
        lineno: 1,
        colno: 0,
        path: 'macro-stack.njk',
        label: 'Root',
        entryName: 'root'
      }
    ]);
    expect(messages[messages.length - 1]).to.be([
      '(macro-stack.njk) [Line 1, Column 96] If.Condition(LookupVal) (branch=then)',
      'Stack:',
      '  1. (macro-stack.njk) [Line 1, Column 66] Iteration (loop={ index: 1, index0: 0, first: true, length: 1, last: true, revindex: 1, revindex0: 0, variables: [item] })',
      '  2. (macro-stack.njk) [Line 1, Column 66] For (loop variables=[item])',
      '  3. (macro-stack.njk) [Line 1, Column 27] call caller()',
      '  4. (macro-stack.njk) [Line 1, Column 3] macro wrap() (caller block)',
      '  5. (macro-stack.njk) [Line 1, Column 0] Root (entry name=root)'
    ].join('\n'));
  });

  it('outputs switch boundary metadata in compiled stacks', async () => {
    const { output, stacks, messages } = await captureSymbolTextStacks(async () => {
      const env = new AsyncEnvironment();
      const template = new AsyncTemplate(
        '{% switch state %}' +
        '{% case "a" %}{{ marker }}' +
        '{% default %}no' +
        '{% endswitch %}',
        env,
        'switch-stack.njk'
      );
      return template.render(
        {
          state: Promise.resolve('a'),
          marker: Promise.resolve('STACK_MARKER')
        }
      );
    });

    expect(output).to.be('STACK_MARKER');
    expect(stacks[stacks.length - 1]).to.eql([
      {
        lineno: 1,
        colno: 10,
        path: 'switch-stack.njk',
        label: 'Switch.Expression(Symbol)',
        branch: 'case'
      },
      {
        lineno: 1,
        colno: 0,
        path: 'switch-stack.njk',
        label: 'Root',
        entryName: 'root'
      }
    ]);
    expect(messages[messages.length - 1]).to.be([
      '(switch-stack.njk) [Line 1, Column 10] Switch.Expression(Symbol) (branch=case)',
      'Stack:',
      '  1. (switch-stack.njk) [Line 1, Column 0] Root (entry name=root)'
    ].join('\n'));
  });

  it('keeps included template path in compiled stack metadata', async () => {
    const loader = new StringLoader();
    loader.addTemplate('parent.njk', 'Before {% include "child.njk" with context %} After');
    loader.addTemplate('child.njk', 'Child {{ marker }}');

    const { output, stacks, messages } = await captureSymbolTextStacks(async () => {
      const env = new AsyncEnvironment(loader);
      return env.renderTemplate('parent.njk', {
        marker: Promise.resolve('STACK_MARKER')
      });
    });

    expect(output).to.be('Before Child STACK_MARKER After');
    expect(stacks[stacks.length - 1]).to.eql([
      {
        lineno: 1,
        colno: 0,
        path: 'child.njk',
        label: 'Root',
        entryName: 'root'
      }
    ]);
    expect(messages[messages.length - 1]).to.be('(child.njk) [Line 1, Column 0] Root (entry name=root)');
  });

  it('outputs capture boundary metadata in compiled stacks', async () => {
    const { output, stacks, messages } = await captureSymbolTextStacks(async () => {
      const env = new AsyncEnvironment();
      const template = new AsyncTemplate(
        '{% set value %}{{ marker }}{% endset %}{{ value }}',
        env,
        'capture-stack.njk'
      );
      return template.render({
        marker: Promise.resolve('STACK_MARKER')
      });
    });

    expect(output).to.be('STACK_MARKER');
    expect(stacks[0]).to.eql([
      {
        lineno: 1,
        colno: 0,
        path: 'capture-stack.njk',
        label: 'NodeList',
        capture: true
      },
      {
        lineno: 1,
        colno: 0,
        path: 'capture-stack.njk',
        label: 'Root',
        entryName: 'root'
      }
    ]);
    expect(messages[0]).to.be([
      '(capture-stack.njk) [Line 1, Column 0] NodeList (capture)',
      'Stack:',
      '  1. (capture-stack.njk) [Line 1, Column 0] Root (entry name=root)'
    ].join('\n'));
  });

  it('keeps imported script function path in compiled stack metadata', async () => {
    const loader = new StringLoader();
    loader.addTemplate('lib.script', [
      'function echo(first, second)',
      '  return first',
      'endfunction'
    ].join('\n'));

    const { output, stacks, messages } = await captureCommandStacks(async () => {
      const env = new AsyncEnvironment(loader);
      const script = new Script([
        'from "lib.script" import echo',
        'return echo(marker, other)'
      ].join('\n'), env, 'main.script');
      return script.render({
        marker: Promise.resolve('STACK_MARKER'),
        other: 'unused'
      });
    }, (command, chainName) =>
      command.constructor.name === 'SnapshotCommand' &&
      chainName === 'first' &&
      command.errorContext &&
      command.errorContext[2] === 'Symbol'
    );

    expect(output).to.be('STACK_MARKER');
    expect(stacks[stacks.length - 1]).to.eql([
      {
        lineno: 1,
        colno: 4,
        path: 'lib.script',
        label: 'Macro',
        macroName: 'echo',
        macroSignature: 'echo(first, second)'
      },
      {
        lineno: 2,
        colno: 15,
        path: 'main.script',
        label: 'FunCall',
        callableName: 'echo',
        callSignature: 'echo(marker, other)'
      },
      {
        lineno: 1,
        colno: 0,
        path: 'main.script',
        label: 'Root',
        entryName: 'root'
      }
    ]);
    expect(messages[messages.length - 1]).to.be([
      '(lib.script) [Line 1, Column 4] macro echo(first, second)',
      'Stack:',
      '  1. (main.script) [Line 2, Column 15] call echo(marker, other)',
      '  2. (main.script) [Line 1, Column 0] Root (entry name=root)'
    ].join('\n'));
  });

  it('preserves dynamic import target rejection origin', async () => {
    const env = new AsyncEnvironment(new StringLoader());
    const template = new AsyncTemplate(
      '{% import target as lib %}{{ lib.value }}',
      env,
      'import-target.njk'
    );
    const sourceError = new Error('target load failed');

    try {
      await template.render({
        target: Promise.reject(sourceError)
      });
      throw new Error('Expected render to fail');
    } catch (err) {
      expect(runtime.isPoisonError(err)).to.be(true);
      const poisonError = err.errors ? err.errors[0] : err;
      expect(poisonError.cause).to.be(sourceError);
      expect(poisonError.context.path).to.be('import-target.njk');
      expect(poisonError.context.label).to.be('Import.Template(Symbol)');
    }
  });

  it('reports missing from-import bindings with binding context', async () => {
    const loader = new StringLoader();
    loader.addTemplate('lib.njk', '{% set present = "ok" %}');
    const env = new AsyncEnvironment(loader);
    const template = new AsyncTemplate(
      '{% from "lib.njk" import missing %}{{ missing }}',
      env,
      'from-missing.njk'
    );

    try {
      await template.render({});
      throw new Error('Expected render to fail');
    } catch (err) {
      expect(runtime.isRuntimeError(err)).to.be(true);
      expect(err.message).to.contain('cannot import \'missing\'');
      expect(err.context.path).to.be('from-missing.njk');
      expect(err.context.label).to.be('Symbol');
    }
  });

  it('stores buffer stack context on runtime value boundaries', async () => {
    const root = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
    const boundaryEc = [11, 6, 'FunCall', 'script.casc', null];
    let child = null;

    await runValueBoundary(root, null, null, async (currentBuffer) => {
      child = currentBuffer;
    }, { ec: boundaryEc, loadName: 'include source@(11,6)' });

    expect(child.traceParent).to.be(root);
    expect(child.bufferStackContext.ec).to.be(boundaryEc);
    expect(child.bufferStackContext.loadName).to.be('include source@(11,6)');
    expect(child.bufferStackContext.diagnosticStack).to.eql(child.getDiagnosticStack());
  });

  it('stores buffer stack context on runtime control-flow boundaries', async () => {
    const root = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
    const boundaryEc = [12, 3, 'If.Condition(Symbol)', 'script.casc', null];
    let child = null;

    const renderState = runtime.createRenderState();

    await runControlFlowBoundary(root, null, null, { path: 'script.casc' }, renderState, async (currentBuffer) => {
      child = currentBuffer;
    }, { ec: boundaryEc, branch: 'then' });

    expect(child.traceParent).to.be(root);
    expect(child.bufferStackContext.ec).to.be(boundaryEc);
    expect(child.bufferStackContext.branch).to.be('then');
    expect(child.bufferStackContext.diagnosticStack).to.eql(child.getDiagnosticStack());
  });

  it('requires source context on command-buffer error commands', () => {
    const ec = [13, 2, 'Guard.Condition(Symbol)', 'script.casc', null];
    const command = new ErrorCommand(PoisonError.create('guard failed', ec), ec);

    expect(command.errorContext).to.eql(ec);
    expect(() => new ErrorCommand(PoisonError.create('guard failed', ec))).to.throwError(/ErrorCommand requires a compact errorContext/);
    expect(() => new ErrorCommand(null, ec)).to.throwError(/Expected existing poison errors/);
  });

  it('requires source context for direct text chain invocation', () => {
    const buffer = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
    const text = declareBufferChain(buffer, 'text', 'text', { path: 'script.casc' }, null);
    const ec = [14, 4, 'Output(Symbol)', 'script.casc', null];

    expect(() => text.invoke()).to.throwError(/TextChain\.invoke requires a compact errorContext/);
    expect(() => text.invoke(ec)).to.not.throwError();
    expect(() => text.invoke('hello', ec)).to.not.throwError();
  });

  it('requires source context for guard command helpers', () => {
    const buffer = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
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

      expect(source).to.contain('const __ec = getErrorContexts(runtime, context.path, renderState);');
      expect(source).to.contain('function getErrorContexts(runtime, path, renderState) {');
      expect(source).to.contain('return runtime.prepareErrorContexts(path, renderState,');
      expect(source).to.contain('"If.Condition(Symbol)"');
      expect(source).to.match(/\[3,7,\d+\]/);
      expect(source).to.match(/\[6,7,\d+\]/);
      expect(source).to.match(/\[\d+,\d+,"[^"]+"\]/);
      expect(source).to.match(/new runtime\.CommandBuffer\(context, null, null, null, null, \{ ec: __ec\[\d+\], entryName: "root" \}, null, renderState\);/);
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
      expect(source).to.contain('const __ec = getErrorContexts(runtime, context.path, renderState);');
      expect(source).to.match(/function b_body\(env, context, runtime, renderState, parentBuffer = null.*currentInstance\)/);
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
        errorContext: [1, 0, 'Inheritance', 'child.script', null],
        renderState: runtime.createRenderState()
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
      parent.rootRenderFunc = function observedParentRoot(envArg, contextArg, runtimeArg, renderState, ...rest) {
        reporters.push({ path: 'parent.njk', reportError: renderState.reportError });
        return parentRoot.call(this, envArg, contextArg, runtimeArg, renderState, ...rest);
      };

      const childRoot = child.rootRenderFunc;
      child.rootRenderFunc = function observedChildRoot(envArg, contextArg, runtimeArg, renderState, ...rest) {
        reporters.push({ path: 'child.njk', reportError: renderState.reportError });
        return childRoot.call(this, envArg, contextArg, runtimeArg, renderState, ...rest);
      };

      const result = await parent.render({});

      expect(result.trim()).to.be('Parent Child');
      expect(reporters.map((entry) => entry.path)).to.eql(['parent.njk', 'child.njk']);
      expect(reporters[1].reportError).to.be(reporters[0].reportError);
    });

    it('uses one reportError callback when importing templates', async () => {
      const loader = new StringLoader();
      loader.addTemplate('parent.njk', '{% import "child.njk" as child %}{{ child.value }}');
      loader.addTemplate('child.njk', '{% set value = "Child" %}');
      const env = new AsyncEnvironment(loader);
      const parent = await env.getTemplate('parent.njk', true, null, false);
      const child = await env.getTemplate('child.njk', true, null, false);
      const reporters = [];

      parent.compile();
      child.compile();

      const parentRoot = parent.rootRenderFunc;
      parent.rootRenderFunc = function observedParentRoot(envArg, contextArg, runtimeArg, renderState, ...rest) {
        reporters.push({ path: 'parent.njk', reportError: renderState.reportError });
        return parentRoot.call(this, envArg, contextArg, runtimeArg, renderState, ...rest);
      };

      const childRoot = child.rootRenderFunc;
      child.rootRenderFunc = function observedChildRoot(envArg, contextArg, runtimeArg, renderState, ...rest) {
        reporters.push({ path: 'child.njk', reportError: renderState.reportError });
        return childRoot.call(this, envArg, contextArg, runtimeArg, renderState, ...rest);
      };

      const result = await parent.render({});

      expect(result.trim()).to.be('Child');
      expect(reporters.map((entry) => entry.path)).to.eql(['parent.njk', 'child.njk']);
      expect(reporters[1].reportError).to.be(reporters[0].reportError);
    });

    it('passes explicit render state through direct getExported execution', async () => {
      const loader = new StringLoader();
      loader.addTemplate('exports.njk', '{% set value = "ok" %}');
      const env = new AsyncEnvironment(loader);
      const template = await env.getTemplate('exports.njk', true, null, false);
      const renderState = runtime.createRenderState();
      let observedRenderState = null;

      template.compile();

      const root = template.rootRenderFunc;
      template.rootRenderFunc = function observedRoot(envArg, contextArg, runtimeArg, rootRenderState, ...rest) {
        observedRenderState = rootRenderState;
        return root.call(this, envArg, contextArg, runtimeArg, rootRenderState, ...rest);
      };

      template.getExported({}, null, renderState);

      expect(observedRenderState).to.be(renderState);
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
      parent.rootRenderFunc = function observedParentRoot(envArg, contextArg, runtimeArg, renderState, ...rest) {
        reporters.push({ path: 'parent.njk', reportError: renderState.reportError });
        return parentRoot.call(this, envArg, contextArg, runtimeArg, renderState, ...rest);
      };

      const childRoot = child.rootRenderFunc;
      child.rootRenderFunc = function observedChildRoot(envArg, contextArg, runtimeArg, renderState, ...rest) {
        reporters.push({ path: 'child.njk', reportError: renderState.reportError });
        return childRoot.call(this, envArg, contextArg, runtimeArg, renderState, ...rest);
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

    it('does not start later include roots after a fatal include report', async () => {
      const loader = new StringLoader();
      loader.addTemplate('parent.njk', '{% include "bad.njk" %}{% include "late.njk" %}');
      loader.addTemplate('bad.njk', 'Bad');
      loader.addTemplate('late.njk', 'Late');
      const env = new AsyncEnvironment(loader);
      const parent = await env.getTemplate('parent.njk', true, null, false);
      const bad = await env.getTemplate('bad.njk', true, null, false);
      const late = await env.getTemplate('late.njk', true, null, false);
      let lateRootCalls = 0;

      parent.compile();
      bad.compile();
      late.compile();

      bad.rootRenderFunc = function observedBadRoot(envArg, contextArg, runtimeArg, renderState) {
        renderState.reportFatalError(new Error('first include failed'));
        return new Promise(() => {});
      };

      const lateRoot = late.rootRenderFunc;
      late.rootRenderFunc = function observedLateRoot(...args) {
        lateRootCalls++;
        return lateRoot.apply(this, args);
      };

      const error = await new Promise((resolve) => {
        parent.render({}, (err) => resolve(err));
      });

      expect(error).to.be.an(Error);
      expect(error.message).to.contain('first include failed');
      expect(lateRootCalls).to.be(0);
    });

    it('does not start later import roots after a fatal import report', async () => {
      const loader = new StringLoader();
      loader.addTemplate('parent.njk', '{% import "bad.njk" as bad %}{% import "late.njk" as late %}{{ late.value }}');
      loader.addTemplate('bad.njk', '{% set value = "bad" %}');
      loader.addTemplate('late.njk', '{% set value = "late" %}');
      const env = new AsyncEnvironment(loader);
      const parent = await env.getTemplate('parent.njk', true, null, false);
      const bad = await env.getTemplate('bad.njk', true, null, false);
      const late = await env.getTemplate('late.njk', true, null, false);
      let lateRootCalls = 0;

      parent.compile();
      bad.compile();
      late.compile();

      bad.rootRenderFunc = function observedBadRoot(envArg, contextArg, runtimeArg, renderState) {
        renderState.reportFatalError(new Error('first import failed'));
        return new Promise(() => {});
      };

      const lateRoot = late.rootRenderFunc;
      late.rootRenderFunc = function observedLateRoot(...args) {
        lateRootCalls++;
        return lateRoot.apply(this, args);
      };

      const error = await new Promise((resolve) => {
        parent.render({}, (err) => resolve(err));
      });

      expect(error).to.be.an(Error);
      expect(error.message).to.contain('first import failed');
      expect(lateRootCalls).to.be(0);
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
