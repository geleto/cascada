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
  runWaitedControlFlowBoundary,
  runValueBoundary,
  sequentialContextLookupValue
} from '../../src/runtime/runtime.js';
import * as runtime from '../../src/runtime/runtime.js';
import {AsyncEnvironment} from '../../src/environment/async-environment.js';
import {Script} from '../../src/environment/script.js';
import {AsyncTemplate} from '../../src/environment/template.js';
import {CompileError} from '../../src/errors.js';
import {StringLoader} from '../util.js';

const TEST_EC = [1, 1, 'Test', 'test.casc', null, null];
const TEST_DIAGNOSTIC_CONTEXT = runtime.cloneWithAddedContext(TEST_EC, { entryName: 'test' });

function expandedContext(context) {
  const info = runtime.RuntimeContextError.getInfo(null, context);
  delete info.stack;
  return info;
}

async function expectPoisonKind(operation, kind) {
  try {
    await operation();
    throw new Error(`Expected render to fail with ${kind}`);
  } catch (err) {
    expect(runtime.isPoisonError(err)).to.be(true);
    expect(err.errors[0].kind).to.be(kind);
  }
}

async function expectSourceKind(seenKinds, operation, kind) {
  await expectPoisonKind(operation, kind);
  seenKinds.add(kind);
}

function expandedStack(stack) {
  return stack.map(expandedContext);
}

async function captureCommandStacks(render, shouldCapture) {
  const originalAddCommand = CommandBuffer.prototype.addCommand;
  const markerBuffers = [];
  CommandBuffer.prototype.addCommand = function(command, chainName) {
    if (this.bufferStackErrorContext && shouldCapture(command, chainName)) {
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
    stacks: markerBuffers.map(buffer => expandedStack(buffer.getDiagnosticStack())),
    messages: markerBuffers.map(buffer =>
      runtime.RuntimeContextError.formatInfo(null, buffer.bufferStackErrorContext, buffer.getDiagnosticStack())
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

async function captureSymbolTextContexts(render) {
  return captureTextContexts(render, (command) => command.errorContext[2] === 'Symbol');
}

async function captureTextContexts(render, shouldCapture = () => true) {
  const originalAddCommand = CommandBuffer.prototype.addCommand;
  const contexts = [];
  CommandBuffer.prototype.addCommand = function(command, chainName) {
    if (
      command instanceof runtime.TextCommand &&
      command.errorContext &&
      shouldCapture(command, chainName)
    ) {
      contexts.push(expandedContext(command.errorContext));
    }
    return originalAddCommand.call(this, command, chainName);
  };

  let output;
  try {
    output = await render();
  } finally {
    CommandBuffer.prototype.addCommand = originalAddCommand;
  }

  return { output, contexts };
}

describe('error context tracing runtime foundation', () => {
  it('prepares compact contexts without mutating shared specs', () => {
    const labels = ['For.Iterator(Symbol)'];
    const specs = [
      [1, 0, 'Root'],
      [7, 11, 0]
    ];
    const renderState = {};

    const prepared = prepareErrorContexts('script.casc', renderState, labels, specs);

    expect(prepared).to.eql([
      [1, 0, 'Root', 'script.casc', null, renderState],
      [7, 11, 'For.Iterator(Symbol)', 'script.casc', null, renderState]
    ]);
    expect(specs).to.eql([
      [1, 0, 'Root'],
      [7, 11, 0]
    ]);

    const otherRenderState = {};
    const second = prepareErrorContexts('other.casc', otherRenderState, labels, specs);

    expect(second).to.eql([
      [1, 0, 'Root', 'other.casc', null, otherRenderState],
      [7, 11, 'For.Iterator(Symbol)', 'other.casc', null, otherRenderState]
    ]);
    expect(second[0]).not.to.be(prepared[0]);
    expect(second[1]).not.to.be(prepared[1]);
  });

  it('uses contextless RuntimeError only as a last-resort fatal runtime fallback', () => {
    const ec = [1, 1, 'Direct.RuntimeError', 'direct.casc', null, null];
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
    expect(contextless.getInfo()).to.eql({
      lineno: null,
      colno: null,
      label: null,
      path: null
    });
  });

  it('preserves existing context when RuntimeError wraps an error directly', () => {
    const origin = [2, 4, 'FunCall', 'origin.casc', null, null];
    const fallback = [9, 1, 'Output', 'consumer.casc', null, null];
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
    const origin = [2, 4, 'FunCall', 'origin.casc', null, null];
    const poison = PoisonError.create('poisoned', origin, 'UserCallThrew');
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
    const ec = [5, 9, 'Switch.Expression(Symbol)', 'switch.casc', null, null];
    const poison = runtime.createPoison(PoisonError.create('one', ec, 'UserCallThrew'));

    expect(isPoison(poison)).to.be(true);
    expect(poison.errors).to.have.length(1);
    expect(poison.errors[0].context.label).to.be('Switch.Expression(Symbol)');
  });

  it('preserves promise input failure origin through lookup consumption', async () => {
    const ec = [8, 12, 'LookupVal', 'lookup.casc', null, null];
    const origin = [3, 5, 'Origin', 'origin.casc', null, null];
    const buffer = new CommandBuffer({ path: 'lookup.casc' }, null, null, null, null, runtime.cloneWithAddedContext(ec, { entryName: 'lookup' }));
    const inputError = PoisonError.create('lookup failed', origin, 'UserCallThrew');

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
    const ec = [9, 4, 'Symbol', 'sequence.casc', null, null];
    let command = null;
    const buffer = {
      getChainIfExists: () => ({ _chainType: 'sequential_path' }),
      addCommand: (cmd) => {
        command = cmd;
        return cmd.promise;
      }
    };

    sequentialContextLookupValue({ lookupScript: () => 'db' }, 'db', '!db', ec, false, buffer);

    expect(command.errorContext).to.eql(ec);
    expect(command.pos).to.be(undefined);
  });

  it('RuntimeError accepts compact context', () => {
    const ec = [6, 10, 'Include.Template', 'include.casc', null, null];
    const err = new RuntimeError('include failed', ec);

    expect(err.name).to.be('RuntimeError');
    expect(err.context.label).to.be('Include.Template');
    expect(err.message).to.contain('RuntimeError: include failed');
    expect(err.message).to.contain('(include.casc) [Line 6, Column 10] Include.Template');
    expect(err.message).to.contain('Include.Template');
    expect(err.fullMessage).to.contain('RuntimeError: include failed');
  });

  it('RuntimeError merges buffer stack metadata with compact context', () => {
    const ec = [8, 2, 'For', 'loop.casc', null, null];
    const bufferStackErrorContext = runtime.cloneWithAddedContext(ec, {
      blockName: 'body',
      loop: { index: 1, variables: ['item'] }
    });
    const err = RuntimeError.create('loop failed', bufferStackErrorContext);
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
    const bufferEc = [3, 4, 'If.Condition(FunCall)', 'script.casc', null, null];
    const bufferContext = runtime.setContextLabel(runtime.cloneWithAddedContext(bufferEc, {
      blockName: 'if-block'
    }), 'If.Then');
    const buffer = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, bufferContext);

    expect(expandedContext(buffer.bufferStackErrorContext)).to.eql({
      lineno: 3,
      colno: 4,
      path: 'script.casc',
      label: 'If.Then',
      blockName: 'if-block'
    });
  });

  it('builds command-buffer stack through parent links', () => {
    const rootEc = [1, 0, 'Root', 'script.casc', null, null];
    const childEc = [5, 2, 'For.Iterator(Symbol)', 'script.casc', null, null];
    const root = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, runtime.cloneWithAddedContext(rootEc, {
      entryName: 'root'
    }));
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
    const child = new CommandBuffer({ path: 'script.casc' }, root, null, null, null, runtime.cloneWithAddedContext(childEc, {
      loop
    }));

    expect(expandedStack(child.getDiagnosticStack())).to.eql([
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
    const rootEc = [1, 0, 'Root', 'script.casc', null, null];
    const macroEc = [7, 2, 'Macro', 'script.casc', null, null];
    const root = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, runtime.cloneWithAddedContext(rootEc, {
      entryName: 'root'
    }));
    const macro = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, runtime.cloneWithAddedContext(macroEc, {
      macroName: 'renderCard'
    }), root);

    expect(expandedStack(macro.getDiagnosticStack()).map(frame => frame.macroName || frame.entryName)).to.eql(['renderCard', 'root']);
  });

  it('prefers traceParent over parent when building command-buffer stack', () => {
    const sharedEc = [2, 0, 'SharedRoot', 'script.casc', null, null];
    const callerEc = [4, 0, 'CallerSite', 'script.casc', null, null];
    const methodEc = [9, 0, 'Method', 'script.casc', null, null];
    const shared = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, runtime.cloneWithAddedContext(sharedEc, {
      entryName: 'shared'
    }));
    const caller = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, runtime.cloneWithAddedContext(callerEc, {
      caller: true
    }));
    const method = new CommandBuffer({ path: 'script.casc' }, shared, null, null, null, runtime.cloneWithAddedContext(methodEc, {
      methodName: 'method'
    }), caller);

    expect(expandedStack(method.getDiagnosticStack()).map(frame => frame.methodName || (frame.caller ? 'caller' : frame.entryName))).to.eql(['method', 'caller']);
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
        label: 'If.Then',
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
      '(macro-stack.njk) [Line 1, Column 96] If.Then (loop={ index: 1, index0: 0, first: true, length: 1, last: true, revindex: 1, revindex0: 0, variables: [item] })',
      'Stack:',
      '  1. (macro-stack.njk) [Line 1, Column 66] Iteration (loop={ index: 1, index0: 0, first: true, length: 1, last: true, revindex: 1, revindex0: 0, variables: [item] })',
      '  2. (macro-stack.njk) [Line 1, Column 66] For (loop variables=[item])',
      '  3. (macro-stack.njk) [Line 1, Column 27] call caller()',
      '  4. (macro-stack.njk) [Line 1, Column 3] macro wrap() (caller block)',
      '  5. (macro-stack.njk) [Line 1, Column 0] Root (entry name=root)'
    ].join('\n'));
  });

  it('labels async loop else branch metadata', async () => {
    const { output, contexts } = await captureTextContexts(async () => {
      const env = new AsyncEnvironment();
      const template = new AsyncTemplate(
        '{% for item in items %}' +
        'body' +
        '{% else %}' +
        '{{ marker }}' +
        '{% endfor %}',
        env,
        'loop-else-stack.njk'
      );
      return template.render({
        items: Promise.resolve([]),
        marker: Promise.resolve('STACK_MARKER')
      });
    });

    expect(output).to.be('STACK_MARKER');
    expect(contexts[contexts.length - 1].path).to.be('loop-else-stack.njk');
    expect(contexts[contexts.length - 1].label).to.be('Loop.Else');
    expect(contexts[contexts.length - 1].branch).to.be(undefined);
  });

  it('labels guard recovery scope buffer metadata', async () => {
    const { output, stacks } = await captureCommandStacks(async () => {
      const env = new AsyncEnvironment();
      return env.renderScriptString([
        'data result',
        'guard result',
        '  result.before = fail()',
        'recover err',
        '  result.recovered = err.message',
        'endguard',
        'return result.snapshot()'
      ].join('\n'), {
        fail() {
          throw new Error('guard boom');
        }
      }, { path: 'guard-recover-stack.casc' });
    }, (command, chainName) => chainName === 'err' && command instanceof runtime.VarCommand);

    expect(output.recovered).to.contain('guard boom');
    expect(stacks.length).to.be(1);
    expect(stacks[0][0].path).to.be('guard-recover-stack.casc');
    expect(stacks[0][0].label).to.be('Guard.Recover');
    expect(stacks[0][0].errorVar).to.be('err');
    expect(stacks[0][1].label).to.be('Guard');
  });

  it('labels if else branch metadata in compiled stacks', async () => {
    const render = () => {
      const env = new AsyncEnvironment();
      const template = new AsyncTemplate(
        '{% if flag %}' +
        'yes' +
        '{% else %}' +
        '{{ marker }}' +
        '{% endif %}',
        env,
        'if-else-stack.njk'
      );
      return template.render({
        flag: Promise.resolve(false),
        marker: Promise.resolve('STACK_MARKER')
      });
    };

    const { output, stacks } = await captureSymbolTextStacks(async () => {
      return render();
    });

    expect(output).to.be('STACK_MARKER');
    expect(stacks[stacks.length - 1][0].label).to.be('If.Else');
    expect(stacks[stacks.length - 1][0].branch).to.be(undefined);

    const command = await captureSymbolTextContexts(async () => {
      return render();
    });
    expect(command.contexts[command.contexts.length - 1].label).to.be('Symbol');
    expect(command.contexts[command.contexts.length - 1].branch).to.be(undefined);
  });

  it('outputs switch boundary metadata in compiled stacks', async () => {
    const render = () => {
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
    };

    const { output, stacks, messages } = await captureSymbolTextStacks(async () => {
      return render();
    });

    expect(output).to.be('STACK_MARKER');
    expect(stacks[stacks.length - 1]).to.eql([
      {
        lineno: 1,
        colno: 10,
        path: 'switch-stack.njk',
        label: 'Switch.Case',
        caseValue: '"a"'
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
      '(switch-stack.njk) [Line 1, Column 10] Switch.Case (case value="a")',
      'Stack:',
      '  1. (switch-stack.njk) [Line 1, Column 0] Root (entry name=root)'
    ].join('\n'));

    const command = await captureSymbolTextContexts(async () => {
      return render();
    });
    expect(command.contexts[command.contexts.length - 1].label).to.be('Symbol');
    expect(command.contexts[command.contexts.length - 1].caseValue).to.be('"a"');
  });

  it('labels numeric switch cases and keeps dynamic cases generic', async () => {
    const numeric = await captureSymbolTextStacks(async () => {
      const env = new AsyncEnvironment();
      const template = new AsyncTemplate(
        '{% switch state %}' +
        '{% case 2 %}{{ marker }}' +
        '{% default %}no' +
        '{% endswitch %}',
        env,
        'switch-number-stack.njk'
      );
      return template.render({
        state: Promise.resolve(2),
        marker: Promise.resolve('STACK_MARKER')
      });
    });

    expect(numeric.output).to.be('STACK_MARKER');
    expect(numeric.stacks[numeric.stacks.length - 1][0].label).to.be('Switch.Case');
    expect(numeric.stacks[numeric.stacks.length - 1][0].caseValue).to.be('2');

    const dynamic = await captureSymbolTextStacks(async () => {
      const env = new AsyncEnvironment();
      const template = new AsyncTemplate(
        '{% switch state %}' +
        '{% case target %}{{ marker }}' +
        '{% default %}no' +
        '{% endswitch %}',
        env,
        'switch-dynamic-stack.njk'
      );
      return template.render({
        state: Promise.resolve(2),
        target: 2,
        marker: Promise.resolve('STACK_MARKER')
      });
    });

    expect(dynamic.output).to.be('STACK_MARKER');
    expect(dynamic.stacks[dynamic.stacks.length - 1][0].label).to.be('Switch.Case');
    expect(dynamic.stacks[dynamic.stacks.length - 1][0].dynamicCase).to.be(true);
  });

  it('labels switch default branch metadata in compiled stacks', async () => {
    const render = () => {
      const env = new AsyncEnvironment();
      const template = new AsyncTemplate(
        '{% switch state %}' +
        '{% case "a" %}no' +
        '{% default %}{{ marker }}' +
        '{% endswitch %}',
        env,
        'switch-default-stack.njk'
      );
      return template.render({
        state: Promise.resolve('missing'),
        marker: Promise.resolve('STACK_MARKER')
      });
    };

    const { output, stacks } = await captureSymbolTextStacks(async () => {
      return render();
    });

    expect(output).to.be('STACK_MARKER');
    expect(stacks[stacks.length - 1][0].label).to.be('Switch.Default');
    expect(stacks[stacks.length - 1][0].branch).to.be(undefined);

    const command = await captureSymbolTextContexts(async () => {
      return render();
    });
    expect(command.contexts[command.contexts.length - 1].label).to.be('Symbol');
    expect(command.contexts[command.contexts.length - 1].branch).to.be(undefined);
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

  it('poisons missing from-import bindings with binding context', async () => {
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
      expect(runtime.isPoisonError(err)).to.be(true);
      const poisonError = err.errors[0];
      expect(err.message).to.contain('cannot import \'missing\'');
      expect(poisonError.kind).to.be('ImportBindingMissing');
      expect(poisonError.context.path).to.be('from-missing.njk');
      expect(poisonError.context.label).to.be('Symbol');
    }
  });

  it('assigns source-specific poison kinds through runtime render paths', async () => {
    const activeKinds = [
      'ContextValueRejected',
      'DivideByZero',
      'ImportBindingMissing',
      'IncompatibleOperands',
      'InvalidConcurrentLimit',
      'InvalidTextValue',
      'IteratorThrew',
      'LoadFailed',
      'LookupThrew',
      'MissingFunction',
      'NaNResult',
      'NotDestructurable',
      'NotAFunction',
      'NotIterable',
      'NullLookup',
      'ScalarLookup',
      'UnknownVariable',
      'UserCallThrew'
    ];
    const seenKinds = new Set();
    const env = new AsyncEnvironment();

    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return missing'),
      'UnknownVariable'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return db!.save()'),
      'UnknownVariable'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return missing()'),
      'MissingFunction'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return value.name', { value: null }),
      'NullLookup'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return value.name', { value: 5 }),
      'ScalarLookup'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return value.name', { value: Symbol('s') }),
      'ScalarLookup'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return value()', { value: undefined }),
      'MissingFunction'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return value()', { value: null }),
      'NotAFunction'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return value()', { value: 1 }),
      'NotAFunction'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return value()', { value: () => { throw new Error('boom'); } }),
      'UserCallThrew'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return getValue().name', {
        async getValue() {
          return Object.defineProperty({}, 'name', {
            get() {
              throw new Error('getter failed');
            }
          });
        }
      }),
      'LookupThrew'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return value.name', {
        value: Promise.resolve(Object.defineProperty({}, 'name', {
          get() {
            throw new Error('getter failed');
          }
        }))
      }),
      'LookupThrew'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString([
        'data result',
        'for item in items of limit',
        '  result.push(item)',
        'endfor',
        'return result.snapshot()'
      ].join('\n'), { items: [1, 2], limit: -1 }),
      'InvalidConcurrentLimit'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString([
        'data result',
        'for item in 5',
        '  result.items.push(item)',
        'else',
        '  result.items.push("else")',
        'endfor',
        'return result.snapshot()'
      ].join('\n')),
      'NotIterable'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString([
        'data result',
        'for key, itemValue in items',
        '  result.push(key)',
        'endfor',
        'return result.snapshot()'
      ].join('\n'), { items: [1] }),
      'NotDestructurable'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderTemplateString('{% for item in items %}{{ item }}{% endfor %}', {
        items: {
          [Symbol.asyncIterator]() {
            return {
              next() {
                throw new Error('iterator failed');
              }
            };
          }
        }
      }),
      'IteratorThrew'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderTemplateString('{{ value }}', {
        value: Promise.reject(new Error('context rejected'))
      }),
      'ContextValueRejected'
    );
    const throwOnUndefinedEnv = new AsyncEnvironment(null, { throwOnUndefined: true });
    await expectSourceKind(
      seenKinds,
      () => throwOnUndefinedEnv.renderTemplateString('{{ missing }}', {}),
      'InvalidTextValue'
    );
    const loader = new StringLoader();
    loader.addTemplate('lib.njk', '{% set present = "ok" %}');
    await expectSourceKind(
      seenKinds,
      () => new AsyncEnvironment(loader).renderTemplateString('{% from "lib.njk" import missing %}{{ missing }}', {}),
      'ImportBindingMissing'
    );
    await expectSourceKind(
      seenKinds,
      () => new AsyncEnvironment(loader, { loadFailFatal: false }).renderTemplateString('{% import "missing.njk" as lib %}{{ lib.x }}', {}),
      'LoadFailed'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return 0 / 0'),
      'NaNResult'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return "5" + 3'),
      'IncompatibleOperands'
    );
    await expectSourceKind(
      seenKinds,
      () => env.renderScriptString('return left / right', { left: 5n, right: 0n }),
      'DivideByZero'
    );

    expect([...seenKinds].sort()).to.eql(activeKinds.sort());
  });

  it('groups multiple render-level poison kinds without dropping later failures', async () => {
    const env = new AsyncEnvironment();

    try {
      await env.renderScriptString('return [missing(), 0 / 0, "5" + 3]');
      throw new Error('Expected render to fail with grouped poison');
    } catch (err) {
      expect(runtime.isPoisonError(err)).to.be(true);
      expect(err.kind).to.be('Multiple');
      expect(err.kinds).to.eql(['IncompatibleOperands', 'MissingFunction', 'NaNResult']);
      expect(err.totalErrorCount).to.be(3);
      expect(err.errors.map(error => error.kind)).to.eql(['MissingFunction', 'NaNResult', 'IncompatibleOperands']);
    }
  });

  it('caps render-level poison group messages while retaining all child errors', async () => {
    const env = new AsyncEnvironment();
    const failures = Array.from({ length: 12 }, (_, index) => `missing${index}()`).join(', ');

    try {
      await env.renderScriptString(`return [${failures}]`);
      throw new Error('Expected render to fail with grouped poison');
    } catch (err) {
      expect(runtime.isPoisonError(err)).to.be(true);
      expect(err.kind).to.be('MissingFunction');
      expect(err.kinds).to.eql(['MissingFunction']);
      expect(err.totalErrorCount).to.be(12);
      expect(err.errors).to.have.length(12);
      expect(err.message).to.contain('PoisonErrorGroup (12 errors, showing 10)');
    }
  });

  it('keeps script scalar strictness scoped away from template loops and optional reads', async () => {
    const env = new AsyncEnvironment();

    expect(await env.renderScriptString('return (5).toFixed(2)')).to.be('5.00');
    expect(await env.renderScriptString('return obj.missing', { obj: {} })).to.be(undefined);
    expect(await env.renderScriptString('return arr[10]', { arr: [] })).to.be(undefined);
    expect(await env.renderScriptString('return "abc"[9]')).to.be(undefined);
    await expectPoisonKind(
      () => env.renderScriptString('return value[0]', { value: 5 }),
      'ScalarLookup'
    );
    expect(await env.renderTemplateString('{{ value.name }}', { value: 5 })).to.be('');
    expect(await env.renderTemplateString('{{ value[0] }}', { value: 5 })).to.be('');
    expect(await env.renderScriptString([
      'var result = "body"',
      'for item in null',
      '  result = item',
      'else',
      '  result = "else"',
      'endfor',
      'return result'
    ].join('\n'))).to.be('else');
    expect(await env.renderTemplateString('{% for item in value %}body{% else %}else{% endfor %}', {
      value: 5
    })).to.be('else');
  });

  it('keeps script loop iterable boundaries explicit', async () => {
    const env = new AsyncEnvironment();

    await expectPoisonKind(
      () => env.renderScriptString([
        'data result',
        'for item in value',
        '  result.push(item)',
        'else',
        '  result.push("else")',
        'endfor',
        'return result.snapshot()'
      ].join('\n'), { value: 'ab' }),
      'NotIterable'
    );

    expect(await env.renderScriptString([
      'data result',
      'for key, item in value',
      '  result[key] = item',
      'endfor',
      'return result.snapshot()'
    ].join('\n'), { value: { a: 1, b: 2 } })).to.eql({ a: 1, b: 2 });

    expect(await env.renderScriptString([
      'data result',
      'for key, item in value',
      '  result[key] = item',
      'endfor',
      'return result.snapshot()'
    ].join('\n'), { value: new Map([['a', 1], ['b', 2]]) })).to.eql({ a: 1, b: 2 });

    expect(await env.renderScriptString([
      'text result',
      'for item in value',
      '  result(item)',
      'endfor',
      'return result.snapshot()'
    ].join('\n'), { value: new Set(['a', 'b']) })).to.be('ab');

    expect(await env.renderScriptString([
      'text result',
      'for item in value',
      '  result(item)',
      'endfor',
      'return result.snapshot()'
    ].join('\n'), {
      value: (async function* values() {
        yield 'a';
        yield 'b';
      })()
    })).to.be('ab');
  });

  it('formats scalar lookup computed keys with diagnostic object details', async () => {
    const env = new AsyncEnvironment();

    try {
      await env.renderScriptString('return value[key]', { value: 5, key: { part: 'name' } });
      throw new Error('Expected scalar lookup to poison');
    } catch (err) {
      expect(runtime.isPoisonError(err)).to.be(true);
      expect(err.errors[0].kind).to.be('ScalarLookup');
      expect(err.errors[0].message).to.contain('Cannot read property { part: name } of 5');
      expect(err.errors[0].message).to.not.contain('[object Object]');
    }
  });

  it('looks up bare call targets on context-like objects without prototype leakage', () => {
    const contextLike = {
      value: 2,
      addOne() {
        return this.value + 1;
      }
    };

    expect(runtime.callWrapAsync(
      runtime.resolveScriptCallTarget(contextLike, 'addOne', TEST_EC),
      'addOne',
      contextLike,
      [],
      TEST_EC
    )).to.be(3);

    const inherited = runtime.resolveScriptCallTarget({}, 'toString', TEST_EC);
    expect(isPoison(inherited)).to.be(true);
    expect(inherited.errors[0].kind).to.be('MissingFunction');

    const missing = runtime.resolveScriptCallTarget(null, 'missing', TEST_EC);
    expect(isPoison(missing)).to.be(true);
    expect(missing.errors[0].kind).to.be('MissingFunction');
  });

  it('allows text.set with multiple text arguments', async () => {
    const env = new AsyncEnvironment();

    const result = await env.renderScriptString([
      'text out',
      'out("before")',
      'out.set("a", "b", 2)',
      'return out.snapshot()'
    ].join('\n'));

    expect(result).to.be('ab2');
  });

  it('poisons NaN at value production sources', async () => {
    const env = new AsyncEnvironment();
    env.addGlobal('identity', (value) => value);
    env.addDataMethods({
      produceNaN() {
        return Number.NaN;
      }
    });

    await expectPoisonKind(
      () => env.renderScriptString('return 0 / 0'),
      'NaNResult'
    );
    await expectPoisonKind(
      () => env.renderTemplateString('{{ value }}', { value: Number.NaN }),
      'NaNResult'
    );
    await expectPoisonKind(
      () => env.renderTemplateString('{{ identity(value) }}', { value: Number.NaN }),
      'NaNResult'
    );
    await expectPoisonKind(
      () => env.renderScriptString([
        'data result',
        'for item in items',
        '  result.push(item)',
        'endfor',
        'return result.snapshot()'
      ].join('\n'), { items: [Number.NaN] }),
      'NaNResult'
    );
    await expectPoisonKind(
      () => env.renderScriptString([
        'data result',
        'for item in items',
        '  result.push(item)',
        'endfor',
        'return result.snapshot()'
      ].join('\n'), { items: [Promise.resolve(Number.NaN)] }),
      'NaNResult'
    );
    await expectPoisonKind(
      () => env.renderScriptString([
        'data result',
        'result.produceNaN()',
        'return result.snapshot()'
      ].join('\n')),
      'NaNResult'
    );
    await expectPoisonKind(
      () => env.renderTemplateString('{{ asyncValue }}', { asyncValue: Promise.resolve(Number.NaN) }),
      'NaNResult'
    );
    await expectPoisonKind(
      () => env.renderScriptString('return value!.toString()', { value: Promise.resolve(Number.NaN) }),
      'NaNResult'
    );
    await expectPoisonKind(
      () => env.renderTemplateString('{{ value }}', {
        value: runtime.createPoison(PoisonError.create('already poisoned', TEST_EC, 'UserCallThrew'))
      }),
      'UserCallThrew'
    );

    expect(await env.renderTemplateString('{{ value }}', { value: Infinity })).to.be('Infinity');
    expect(await env.renderTemplateString('{{ value }}', { value: 'NaN' })).to.be('NaN');
  });

  it('stores buffer stack error context on runtime value boundaries', async () => {
    const root = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
    const boundaryEc = [11, 6, 'FunCall', 'script.casc', null, null];
    let child = null;

    await runValueBoundary(root, null, null, async (currentBuffer) => {
      child = currentBuffer;
    }, runtime.cloneWithAddedContext(boundaryEc, { loadName: 'include source@(11,6)' }));

    expect(child.traceParent).to.be(root);
    expect(child.bufferStackErrorContext).to.eql(runtime.cloneWithAddedContext(boundaryEc, { loadName: 'include source@(11,6)' }));
    expect(child.getDiagnosticStack()).to.eql([child.bufferStackErrorContext, root.bufferStackErrorContext]);
  });

  it('stores buffer stack error context on runtime control-flow boundaries', async () => {
    const root = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
    const boundaryEc = [12, 3, 'If.Condition(Symbol)', 'script.casc', null, null];
    let child = null;

    const renderState = runtime.createRenderState();
    const boundaryContext = runtime.setContextLabel(runtime.cloneContext(boundaryEc), 'If.Then');

    await runControlFlowBoundary(root, null, null, { path: 'script.casc' }, renderState, async (currentBuffer) => {
      child = currentBuffer;
    }, boundaryContext);

    expect(child.traceParent).to.be(root);
    expect(child.bufferStackErrorContext).to.eql(boundaryContext);
    expect(child.getDiagnosticStack()).to.eql([child.bufferStackErrorContext, root.bufferStackErrorContext]);
  });

  it('settles waited control-flow cleanup after fatal state is reported', async () => {
    const renderState = runtime.createRenderState();
    const root = new CommandBuffer(
      { path: 'script.casc' },
      null,
      null,
      null,
      null,
      TEST_DIAGNOSTIC_CONTEXT,
      null,
      renderState
    );
    const waitedChainName = '__waited__test';
    const boundaryEc = [12, 8, 'For', 'script.casc', null, null];
    const pending = new Promise(() => {});

    const boundaryResult = runWaitedControlFlowBoundary(
      root,
      null,
      null,
      { path: 'script.casc' },
      renderState,
      async (currentBuffer) => {
        declareBufferChain(currentBuffer, waitedChainName, 'var', { path: 'script.casc' }, null);
        currentBuffer.addCommand(new runtime.WaitResolveCommand({
          chainName: waitedChainName,
          args: [pending],
          errorContext: boundaryEc
        }), waitedChainName);
        renderState.reportFatalError(RuntimeError.create('waited boundary failed', boundaryEc, currentBuffer));
      },
      waitedChainName,
      boundaryEc
    );

    const outcome = await Promise.race([
      boundaryResult.then(
        () => ({ error: null }),
        (error) => ({ error })
      ),
      new Promise((resolve) => {
        setTimeout(() => resolve({ error: new Error('timed out waiting for fatal cleanup') }), 500);
      })
    ]);

    expect(outcome.error).to.be.ok();
    expect(outcome.error.message).to.contain('waited boundary failed');
    expect(outcome.error.message).to.not.contain('timed out');
    expect(runtime.isRuntimeError(outcome.error)).to.be(true);
  });

  it('requires source context on command-buffer error commands', () => {
    const ec = [13, 2, 'Guard.Condition(Symbol)', 'script.casc', null, null];
    const command = new ErrorCommand(PoisonError.create('guard failed', ec, 'UserCallThrew'), ec);

    expect(command.errorContext).to.eql(ec);
    expect(() => new ErrorCommand(PoisonError.create('guard failed', ec, 'UserCallThrew'))).to.throwError(/ErrorCommand requires a compact errorContext/);
    expect(() => new ErrorCommand(null, ec)).to.throwError(/Expected existing poison errors/);
  });

  it('requires source context for direct text chain invocation', () => {
    const buffer = new CommandBuffer({ path: 'script.casc' }, null, null, null, null, TEST_DIAGNOSTIC_CONTEXT);
    const text = declareBufferChain(buffer, 'text', 'text', { path: 'script.casc' }, null);
    const ec = [14, 4, 'Output(Symbol)', 'script.casc', null, null];

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
      expect(source).to.match(/\[\d+,\d+,\d+,\{"entryName":"root"\}\]/);
      expect(source).to.match(/new runtime\.CommandBuffer\(context, null, null, null, null, __ec\[\d+\], null, renderState\);/);
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

      parent.getErrorContexts = function getObservedErrorContexts(runtimeArg, path, renderState) {
        parentContextPaths.push(path);
        return getParentErrorContexts.call(this, runtimeArg, path, renderState);
      };

      const result = await env.renderTemplate('child.njk', { name: 'Ada' });

      expect(result.trim()).to.be('Parent Ada');
      expect(parentContextPaths).to.contain('parent.njk');
    });

    it('prepares script artifact contexts when invoking inherited script methods', async () => {
      const loader = new StringLoader();
      loader.addTemplate('parent.script', [
        'method build(name)',
        '  return "Parent " ~ name',
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

      parent.getErrorContexts = function getObservedScriptErrorContexts(runtimeArg, path, renderState) {
        parentContextPaths.push(path);
        return getParentErrorContexts.call(this, runtimeArg, path, renderState);
      };

      const child = await env.getScript('child.script', true, null, false);
      const instance = await runtime.InheritanceInstance.create({
        entryTemplateOrScript: child,
        env,
        context: child._createContext({ name: 'Ada' }),
        runtime,
        errorContext: [1, 0, 'Inheritance', 'child.script', null, null],
        renderState: runtime.createRenderState()
      });
      const result = await instance.invoke('build', ['Ada'], [1, 0, 'Call', 'test.script', null, null]);

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
      expect(source).to.match(/runtime\.resolveScriptCallTarget\(context, "fetchUser", __ec\[\d+\]\)/);
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
