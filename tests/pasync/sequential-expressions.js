(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var delay;
  var expectAsyncError;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
    delay = require('../util').delay;
    expectAsyncError = require('../util').expectAsyncError;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    delay = window.util.delay;
    expectAsyncError = window.util.expectAsyncError;
  }

  describe('Sequential Expressions with ! Marker', () => {
    let env;
    let context;

    beforeEach(() => {
      env = new AsyncEnvironment();
      context = {
        logs: [],
        data: {
          item: {
            id: 'item1',
            async op(id, ms = 5) {
              await delay(ms);
              context.logs.push(`op${id} on item`);
              return `result${id}`;
            },
            async op2(id, ms = 5) {
              await delay(ms);
              context.logs.push(`op2${id} on item`);
              return `result2${id}`;
            },
            async op3(id, ms = 5) {
              await delay(ms);
              context.logs.push(`op3${id} on item`);
              return `result3${id}`;
            },
            async opA(id, ms = 5) {
              await delay(ms);
              context.logs.push(`opA${id} on item`);
              return `resultA${id}`;
            },
            async opB(id, ms = 5) {
              await delay(ms);
              context.logs.push(`opB${id} on item`);
              return `resultB${id}`;
            },
            prop: 'static_property'
          },
          itemA: {
            id: 'itemA',
            async op(id, ms = 5) {
              await delay(ms);
              context.logs.push(`op${id} on itemA`);
              return `resultA${id}`;
            }
          },
          itemB: {
            id: 'itemB',
            async op(id, ms = 5) {
              await delay(ms);
              context.logs.push(`op${id} on itemB`);
              return `resultB${id}`;
            }
          },
          A: {
            async x(id, ms = 5) {
              await delay(ms);
              context.logs.push(`A.x${id}`);
              return `A${id}`;
            },
            async y(id, ms = 5) {
              await delay(ms);
              context.logs.push(`A.y${id}`);
              return `A${id}`;
            }
          },
          B: {
            async z(id, ms = 5) {
              await delay(ms);
              context.logs.push(`B.z${id}`);
              return `B${id}`;
            }
          },
          C: {
            async w(id, ms = 5) {
              await delay(ms);
              context.logs.push(`C.w${id}`);
              return `C${id}`;
            }
          },
          obj: {
            prop1: {
              async opA(id, ms = 5) {
                await delay(ms);
                context.logs.push(`opA${id} on obj.prop1`);
                return `resultA${id}`;
              }
            },
            prop2: {
              async opB(id, ms = 5) {
                await delay(ms);
                context.logs.push(`opB${id} on obj.prop2`);
                return `resultB${id}`;
              }
            }
          },
          other: {
            async nonSequentialOp(id, ms = 5) {
              await delay(ms);
              context.logs.push(`nonSeq${id} on other`);
              return `nonSeqResult${id}`;
            }
          },
          unrelated: {
            async opC(id, ms = 5) {
              await delay(ms);
              context.logs.push(`opC${id} on unrelated`);
              return `resultC${id}`;
            },
            async op(id, ms = 5) {
              await delay(ms);
              context.logs.push(`opC${id} on unrelated`);
              return `resultC${id}`;
            }
          }
        },
        other: {
          async nonSequentialOp(id, ms = 5) {
            await delay(ms);
            context.logs.push(`nonSeq${id} on other`);
            return `nonSeqResult${id}`;
          }
        },
        unrelated: {
          async opC(id, ms = 5) {
            await delay(ms);
            context.logs.push(`opC${id} on unrelated`);
            return `resultC${id}`;
          },
          async op(id, ms = 5) {
            await delay(ms);
            context.logs.push(`opC${id} on unrelated`);
            return `resultC${id}`;
          }
        }
      };
    });

    // --- Basic Sequencing Tests ---
    describe('Basic Sequencing', () => {
      it('should sequence operations on the same object path', async () => {
        const template = `{{ data.item!.op("1", 10) + data.item!.op("2", 5) }}`;
        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('result1result2');
        expect(context.logs).to.eql(['op1 on item', 'op2 on item']);
      });

      it('should sequence different operations on the same object path', async () => {
        const template = `{{ data.item!.op("1", 10) + data.item!.op2("2", 5) }}`;
        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('result1result22');
        expect(context.logs).to.eql(['op1 on item', 'op22 on item']);
      });

      it('should sequence all operations on the same object path in complex expressions', async () => {
        const template = `{{ (data.item!.op("1", 10) + data.item!.op2("2", 5)) + data.item!.op3("3", 3) }}`;
        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('result1result22result33');
        expect(context.logs).to.eql(['op1 on item', 'op22 on item', 'op33 on item']);
      });

      it('should allow parallel execution when no sequence markers are used', async () => {
        const template = `{{ data.item.op("1", 10) + data.item.op2("2", 5) }}`;
        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('result1result22');
        expect(context.logs.length).to.equal(2);
      });
    });

    // --- Path and Method Sequencing Tests ---
    describe('Path vs Method Sequencing', () => {
      it('should sequence path lookups but allow method calls to run normally', async () => {
        const template = `{{ data.obj!.prop1.opA("1", 10) + data.obj!.prop1.opA("2", 5) }}`;
        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('resultA1resultA2');
        expect(context.logs).to.eql(['opA1 on obj.prop1', 'opA2 on obj.prop1']);
      });

      it('should sequence method calls on non-sequential paths', async () => {
        const template = `{{ data.obj.prop1.opA!("1", 10) + data.obj.prop1.opA!("2", 5) }}`;

        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('resultA1resultA2');
        expect(context.logs).to.eql(['opA1 on obj.prop1', 'opA2 on obj.prop1']);
      });

      it('should handle mixed object path and method sequencing', async () => {
        const template = `{{ data.item!.op("1", 10) + data.item.op!("2", 5) + data.item!.op("3", 3) }}`;

        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('result1result2result3');
        // Only check order for object path sequencing (data.item!)
        const idx1 = context.logs.indexOf('op1 on item');
        const idx3 = context.logs.indexOf('op3 on item');
        expect(idx1).to.be.lessThan(idx3);
        expect(context.logs).to.contain('op2 on item');
      });
    });

    // --- Independent Paths Tests ---
    describe('Independent Paths', () => {
      it('should allow parallel execution for different object paths', async () => {
        const template = `{{ data.itemA!.op("1", 10) + data.itemB!.op("2", 5) }}`;
        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('resultA1resultB2');
        expect(context.logs).to.contain('op1 on itemA');
        expect(context.logs).to.contain('op2 on itemB');
        expect(context.logs.length).to.equal(2);
      });

      it('should allow parallel execution for different properties under same object', async () => {
        const template = `{{ data.obj.prop1!.opA("1", 10) + data.obj.prop2!.opB("2", 5) }}`;
        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('resultA1resultB2');
        expect(context.logs).to.contain('opA1 on obj.prop1');
        expect(context.logs).to.contain('opB2 on obj.prop2');
        expect(context.logs.length).to.equal(2);
      });

      it('should handle multiple independent sequences correctly', async () => {
        const template = `{{ (data.itemA!.op("1", 10) + data.itemB!.op("2", 5)) + data.itemA!.op("3", 3) }}`;

        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('resultA1resultB2resultA3');
        const idx1 = context.logs.indexOf('op1 on itemA');
        const idx3 = context.logs.indexOf('op3 on itemA');
        expect(idx1).to.be.lessThan(idx3);
        expect(context.logs).to.contain('op2 on itemB');
      });
    });

    // --- Mixed Operations Tests ---
    describe('Mixed Operations', () => {
      it('should allow non-sequential operations to run in parallel with sequential ones', async () => {
        const template = `{{ data.item!.op("1", 10) + other.nonSequentialOp("2", 5) }}`;
        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('result1nonSeqResult2');
        expect(context.logs).to.contain('op1 on item');
        expect(context.logs).to.contain('nonSeq2 on other');
        expect(context.logs.length).to.equal(2);
      });

      it('should sequence operations within grouped expressions', async () => {
        const template = `{{ (data.item!.opA("1", 10) + data.item!.opB("2", 5)) + unrelated.opC("3", 3) }}`;
        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('resultA1resultB2resultC3');
        // Only check order for sequential operations (data.item!)
        const idxA = context.logs.indexOf('opA1 on item');
        const idxB = context.logs.indexOf('opB2 on item');
        expect(idxA).to.be.lessThan(idxB);
        expect(context.logs).to.contain('opC3 on unrelated');
      });

      it('should handle complex expressions with mixed contention levels', async () => {
        const template = `{{ (data.A!.x("1", 10) + data.A!.y("2", 5)) + (data.B!.z("3", 3) + data.C!.w("4", 2)) }}`;

        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('A1A2B3C4');
        expect(context.logs).to.contain('A.x1');
        expect(context.logs).to.contain('A.y2');
        expect(context.logs).to.contain('B.z3');
        expect(context.logs).to.contain('C.w4');
      });
    });

    // --- Shortest Key Coverage Tests ---
    describe('Shortest Key Coverage', () => {
      it('should sequence operations when shortest contended key is at object level', async () => {
        const template = `{{ data.obj!.prop1.opA("1", 10) + data.obj!.prop2.opB("2", 5) }}`;
        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('resultA1resultB2');
        expect(context.logs).to.eql(['opA1 on obj.prop1', 'opB2 on obj.prop2']);
      });

      it('should use shortest contended key for sequencing', async () => {
        const template = `{{ data.obj!.prop1.opA("1", 10) + data.obj!.prop2.opB("2", 5) + data.obj!.commonOp("3", 3) }}`;

        // Add commonOp method to obj
        context.data.obj.commonOp = async function(id, ms) {
          await delay(ms);
          context.logs.push(`commonOp${id} on obj`);
          return `commonResult${id}`;
        };

        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('resultA1resultB2commonResult3');
        expect(context.logs).to.eql(['opA1 on obj.prop1', 'opB2 on obj.prop2', 'commonOp3 on obj']);
      });

      it('should sequence at the specific contended path level', async () => {
        const template = `{{ data.obj.item!.opX("1", 10) + data.obj.item!.opY("2", 5) }}`;

        // Add item with opX and opY methods
        context.data.obj.item = {
          async opX(id, ms) {
            await delay(ms);
            context.logs.push(`opX${id} on obj.item`);
            return `resultX${id}`;
          },
          async opY(id, ms) {
            await delay(ms);
            context.logs.push(`opY${id} on obj.item`);
            return `resultY${id}`;
          }
        };

        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('resultX1resultY2');
        expect(context.logs).to.eql(['opX1 on obj.item', 'opY2 on obj.item']);
      });
    });

    // --- Complex Expression Tests ---
    describe('Complex Expressions', () => {
      it('should handle deeply nested paths with intermediate wrapping', async () => {
        const template = `{{ root.mid!.leafA.op1("1", 10) + root.mid!.leafB.op2("2", 5) }}`;

        // Create deeply nested structure
        context.root = {
          mid: {
            leafA: {
              async op1(id, ms) {
                await delay(ms);
                context.logs.push(`op1${id} on root.mid.leafA`);
                return `result1${id}`;
              }
            },
            leafB: {
              async op2(id, ms) {
                await delay(ms);
                context.logs.push(`op2${id} on root.mid.leafB`);
                return `result2${id}`;
              }
            }
          }
        };

        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('result11result22');
        expect(context.logs).to.eql(['op11 on root.mid.leafA', 'op22 on root.mid.leafB']);
      });

      it('should handle complex expressions with multiple sequence keys', async () => {
        const template = `{{ (A!.op("1", 10) + B!.op("2", 5) + A!.op("3", 3)) + (B!.op("4", 2) + C!.op("5", 1) + B!.op("6", 4)) }}`;

        // Add A, B, C objects
        context.A = {
          async op(id, ms) {
            await delay(ms);
            context.logs.push(`A.op${id}`);
            return `A${id}`;
          }
        };
        context.B = {
          async op(id, ms) {
            await delay(ms);
            context.logs.push(`B.op${id}`);
            return `B${id}`;
          }
        };
        context.C = {
          async op(id, ms) {
            await delay(ms);
            context.logs.push(`C.op${id}`);
            return `C${id}`;
          }
        };

        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('A1B2A3B4C5B6');
        // Only check order within each sequence
        const idxA1 = context.logs.indexOf('A.op1');
        const idxA3 = context.logs.indexOf('A.op3');
        expect(idxA1).to.be.lessThan(idxA3);
        const idxB2 = context.logs.indexOf('B.op2');
        const idxB4 = context.logs.indexOf('B.op4');
        const idxB6 = context.logs.indexOf('B.op6');
        expect(idxB2).to.be.lessThan(idxB4);
        expect(idxB4).to.be.lessThan(idxB6);
        expect(context.logs).to.contain('C.op5');
      });

      it('should handle deeply nested expressions with sequence contention', async () => {
        const template = `{{ (data.item!.op("1", 10) + (data.item!.op("2", 5) + data.item!.op("3", 3))) + data.item!.op("4", 2) }}`;

        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('result1result2result3result4');
        expect(context.logs).to.eql(['op1 on item', 'op2 on item', 'op3 on item', 'op4 on item']);
      });

      it('should not duplicate wrappers for the same key', async () => {
        const template = `{{ data.item!.op("1", 10) + data.item!.op("2", 5) }}`;

        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('result1result2');
        expect(context.logs).to.eql(['op1 on item', 'op2 on item']);
      });

      it('should terminate wrapping when prefix key is already wrapped', async () => {
        const template = `{{ data.obj!.sub.opX("1", 10) + data.obj!.sub.opY("2", 5) }}`;

        // Add sub object with opX and opY methods
        context.data.obj.sub = {
          async opX(id, ms) {
            await delay(ms);
            context.logs.push(`opX${id} on obj.sub`);
            return `resultX${id}`;
          },
          async opY(id, ms) {
            await delay(ms);
            context.logs.push(`opY${id} on obj.sub`);
            return `resultY${id}`;
          }
        };

        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('resultX1resultY2');
        expect(context.logs).to.eql(['opX1 on obj.sub', 'opY2 on obj.sub']);
      });
    });

    // --- Function Call Tests ---
    describe('Function Calls', () => {
      it('should sequence path lookups for function calls', async () => {
        const template = `{{ (data.item!.getHandler())() + (data.item!.getAnotherHandler())() }}`;

        // Add getHandler and getAnotherHandler methods
        context.data.item.getHandler = async function() {
          await delay(5);
          context.logs.push('getHandler called');
          return function() { return 'handler1'; };
        };
        context.data.item.getAnotherHandler = async function() {
          await delay(3);
          context.logs.push('getAnotherHandler called');
          return function() { return 'handler2'; };
        };

        const result = await env.renderTemplateString(template, context);

        expect(result.trim()).to.equal('handler1handler2');
        expect(context.logs).to.eql(['getHandler called', 'getAnotherHandler called']);
      });
    });

    // --- Single Use Tests ---
    describe('Single Use Scenarios', () => {
      it('should still sequence single ! marked operations', async () => {
        const template = `{{ data.item!.op("1", 10) + unrelated.opC("2", 5) }}`;
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('result1resultC2');
        // Only check that both operations completed, not their order
        expect(context.logs).to.contain('op1 on item');
        expect(context.logs).to.contain('opC2 on unrelated');
        expect(context.logs.length).to.equal(2);
      });
    });

    // --- Performance Tests ---
    describe('Performance', () => {
      it('should allow independent sequences to run in parallel', async () => {
        const startTime = Date.now();

        const template = `{{ data.itemA!.op("1", 50) + data.itemB!.op("2", 50) + unrelated.opC("3", 50) }}`;

        const result = await env.renderTemplateString(template, context);
        const endTime = Date.now();

        expect(result.trim()).to.equal('resultA1resultB2resultC3');
        expect(context.logs).to.contain('op1 on itemA');
        expect(context.logs).to.contain('op2 on itemB');
        expect(context.logs).to.contain('opC3 on unrelated');
        expect(context.logs.length).to.equal(3);

        expect(endTime - startTime).to.be.lessThan(100);
      });
    });

    // --- Error Handling Tests ---
    describe('Error Handling', () => {
      it('should error if ! is used on property access', async () => {
        const template = `{{ data.item!.prop + data.item!.op("1", 5) }}`;
        await expectAsyncError(() => env.renderTemplateString(template, context), err => {
          expect(err.message).to.contain('Sequence marker (!) is not allowed in non-call paths');
        });
      });

      it('should not sequence operations on template variables', async () => {
        const template = `
          {% set x = data.item %}
          {{ x!.op("1", 10) + x!.op2("2", 5) }}
        `;

        await expectAsyncError(() => env.renderTemplateString(template, context), err => {
          expect(err.message).to.contain('Sequence marker (!) is not allowed in non-context variable paths');
        });
      });

      it('should reject sequence markers on dynamic path segments', async () => {
        const template = `{{ data[myKey]!.op("1", 5) }}`;

        await expectAsyncError(() => env.renderTemplateString(template, { ...context, myKey: 'item' }), err => {
          expect(err.message).to.contain('cannot be used with dynamic keys');
        });
      });

      it('should reject multiple sequence markers in the same path', async () => {
        const template = `{{ data.item!!op("1", 5) }}`;
        await expectAsyncError(() => env.renderTemplateString(template, context));
      });

      it('should propagate errors from sequential operations', async () => {
        context.data.item.errorOp = async function() {
          await delay(5);
          throw new Error('Sequential operation failed');
        };

        const template = `{{ data.item!.errorOp() + data.item!.op("1", 5) }}`;

        await expectAsyncError(() => env.renderTemplateString(template, context), err => {
          expect(err.message).to.contain('Sequential operation failed');
        });
      });

      it('should reject ! on template variables that shadow context variables', async () => {
        const template = `
          {% set item = data.item %}
          {{ item!.op("1", 5) }}
        `;

        await expectAsyncError(() => env.renderTemplateString(template, context), err => {
          expect(err.message).to.contain('Sequence marker (!) is not allowed in non-context variable paths');
        });
      });

      it('should reject ! on macro parameters', async () => {
        const template = `
          {% macro testMacro(param) %}
            {{ param!.op("1", 5) }}
          {% endmacro %}
          {{ testMacro(data.item) }}
        `;

        await expectAsyncError(() => env.renderTemplateString(template, context), err => {
          expect(err.message).to.contain('not allowed inside macros');
        });
      });
    });

  });

})();
