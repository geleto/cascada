(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var StringLoader;
  var delay;
  var expectAsyncError;
  var runtime;
  var isPoisonError;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
    StringLoader = require('../util').StringLoader;
    delay = require('../util').delay;
    expectAsyncError = require('../util').expectAsyncError;
    runtime = require('../../src/runtime/runtime');
    isPoisonError = runtime.isPoisonError;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    StringLoader = window.util.StringLoader;
    delay = window.util.delay;
    expectAsyncError = window.util.expectAsyncError;
    runtime = nunjucks.runtime;
    isPoisonError = nunjucks.runtime.isPoisonError;
  }


  describe('Side effects', () => {
    let env; // Env is used everywhere

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Side effects - template render lifecycle', () => {
      it('Template should wait resolution of unused variable', async () => {
        const cont = {
          logs: [],
          async log(item) {
            await delay(10);
            cont.logs.push(`Logged ${item}`);
            return true;
          }
        };
        const template = `{% set _dummy = log('hi') %}`;
        await env.renderTemplateString(template, cont);
        expect(cont.logs).to.eql(['Logged hi']);
      });

      it('Template should capture an unused throwing an error', async () => {
        const cont = {
          logs: [],
          async err(ms) {
            await delay(ms);
            throw new Error('Dummy error');
          },
          async infoWait(ms) {
            await delay(ms);
            return 'Hi';
          }
        };
        const template = `{{ infoWait(2) }}{% set dummy = err(5) %}{{ dummy }}`;
        await expectAsyncError(() => env.renderTemplateString(template, cont), err => {
          expect(err.message).to.contain('Dummy error');
        });
      });;

      it('Should wait for unused var if assigned from side-effect sequence function and process Error', async () => {
        const cont = {
          async run(id, ms) {
            await delay(ms);
            //the template should not finish rendering before this error is thrown
            //in a sequence operation (unused vars are for instance not awaited when finishing template)
            throw new Error('Failed to run operation');
          }
        };
        const template = `{% set dummy = run!('exp1-A', 10) %}{{ dummy }}`;
        await expectAsyncError(() => env.renderTemplateString(template, cont), err => {
          expect(err.message).to.contain('Failed to run operation');
        });
      });

      //todo - test wait for side effect to finish before template rendering

      //todo - test {% do run() %} - template should wait for the call to finish

      //todo - test {% do run() %} - template should wait for the call to finish and catch errors

    });//End Side effects - template waits

    // --- Tests for the '!' feature ---
    describe('Side effects - Controlling sequential execution with !', () => {
      let context; // Base context for logs and the primary sequencer

      beforeEach(() => {
        context = {
          logs: [],
          sequencer: {
            id: 'seq1',
            async runOp(id, ms) {
              await delay(ms);
              context.logs.push(`${id} on ${this.id}`);
              return id;
            },
            async runOpOther(id, ms) {
              await delay(ms);
              context.logs.push(`${id} OTHER on ${this.id}`);
              return id;
            },
            async getStatus(id, ms) {
              await delay(ms);
              context.logs.push(`Status ${id} on ${this.id}`);
              return `Status ${id}`;
            }
          }
        };
      });

      // --- Object-Path Sequencing: object.path!.method() ---
      describe('1. Object-Path Sequencing (object.path!.method())', () => {

        it('should enforce sequence based on object path for the same method', async () => {
          let callOrder = [];
          const cont = {
            ...context,
            sequencer: {
              ...context.sequencer,
              async runOp(id, ms) {
                callOrder.push(id);
                await delay(ms);
                cont.logs.push(`${id} on ${this.id}`);
                return id;
              }
            }
          };
          const template = `
                    {% do sequencer!.runOp('op1', 10) %}
                    {% do sequencer!.runOp('op2', 5) %}
                `;
          await env.renderTemplateString(template, cont);
          expect(callOrder).to.eql(['op1', 'op2']); // Verify sequence
          expect(cont.logs).to.eql(['op1 on seq1', 'op2 on seq1']);
        });

        it('should enforce sequence based on object path across different methods', async () => {
          const template = `
                    {% do sequencer!.runOp('op1', 10) %}
                    {% do sequencer!.runOpOther('op2-other', 5) %}
                    {% do sequencer!.runOp('op3', 2) %}
                `;
          await env.renderTemplateString(template, context);
          expect(context.logs).to.eql([
            'op1 on seq1',
            'op2-other OTHER on seq1',
            'op3 on seq1'
          ]);
        });

        it('should allow unmarked operations to run in parallel with object path sequences', async () => {
          const cont = {
            ...context,
            async logAfterDelay(id, ms) {
              await delay(ms);
              cont.logs.push(`Log: ${id}`);
              return `Logged ${id}`;
            }
          };
          const template = `
                    {% do sequencer!.runOp('op1', 10) %}
                    {% do logAfterDelay('parallel-op', 5) %}
                    {% do sequencer!.runOp('op2', 2) %}
                `;
          await env.renderTemplateString(template, cont);
          expect(cont.logs).to.contain('Log: parallel-op');
          expect(cont.logs).to.contain('op1 on seq1');
          expect(cont.logs).to.contain('op2 on seq1');
          expect(cont.logs.indexOf('op1 on seq1')).to.be.lessThan(cont.logs.indexOf('op2 on seq1')); // Sequence preserved
        });

        it('should allow unmarked methods on the same object to run in parallel', async () => {
          const template = `
                    {% do sequencer!.runOp('op1', 10) %}
                    {% do sequencer.getStatus('status1', 5) %}
                    {% do sequencer!.runOp('op2', 2) %}
                `;
          await env.renderTemplateString(template, context);
          expect(context.logs).to.contain('Status status1 on seq1');
          expect(context.logs).to.contain('op1 on seq1');
          expect(context.logs).to.contain('op2 on seq1');
          expect(context.logs.indexOf('op1 on seq1')).to.be.lessThan(context.logs.indexOf('op2 on seq1')); // Sequence preserved
        });

        it('should allow sequences on different object paths to run in parallel', async () => {
          const cont = {
            ...context,
            sequencer2: {
              id: 'seq2',
              async runOp(id, ms) { await delay(ms); cont.logs.push(`${id} on ${this.id}`); return id; }
            }
          };
          const template = `
                    {% do sequencer!.runOp('seq1-op1', 10) %}
                    {% do sequencer2!.runOp('seq2-op1', 5) %}
                    {% do sequencer!.runOp('seq1-op2', 3) %}
                    {% do sequencer2!.runOp('seq2-op2', 2) %}
                `;
          await env.renderTemplateString(template, cont);
          expect(cont.logs).to.contain('seq1-op1 on seq1');
          expect(cont.logs).to.contain('seq1-op2 on seq1');
          expect(cont.logs).to.contain('seq2-op1 on seq2');
          expect(cont.logs).to.contain('seq2-op2 on seq2');
          expect(cont.logs.indexOf('seq1-op1 on seq1')).to.be.lessThan(cont.logs.indexOf('seq1-op2 on seq1')); // Seq1 sequence
          expect(cont.logs.indexOf('seq2-op1 on seq2')).to.be.lessThan(cont.logs.indexOf('seq2-op2 on seq2')); // Seq2 sequence
        });

        it('should handle multiple object path ! operators (same path) within one expression sequentially', async () => {
          const template = `{{ sequencer!.runOp('exp2-A', 10) ~ sequencer!.runOp('exp2-B', 5) }}`;
          const result = await env.renderTemplateString(template, context);
          expect(context.logs).to.eql(['exp2-A on seq1', 'exp2-B on seq1']);
          expect(result.trim()).to.equal('exp2-Aexp2-B');
        });

        it('should work with nested static object paths', async () => {
          const cont = {
            ...context,
            data: {
              nestedSequencer: {
                id: 'nested',
                async runOp(id, ms) { await delay(ms); cont.logs.push(`${id} on ${this.id}`); return id; }
              }
            }
          };
          const template = `
                    {% do data.nestedSequencer!.runOp('nested1', 10) %}
                    {% do data.nestedSequencer!.runOp('nested2', 5) %}
                `;
          await env.renderTemplateString(template, cont);
          expect(cont.logs).to.eql(['nested1 on nested', 'nested2 on nested']);
        });

        it('should work with deeply nested static object paths and method-specific sequencing', async () => {
          const cont = {
            ...context,
            data: {
              level1: {
                id: 'l1', level2: {
                  id: 'l2', deepSequencer: {
                    id: 'deepSeq',
                    async runOp(id, ms) { await delay(ms); cont.logs.push(`${id} on ${this.id}`); return id; },
                    async runOpOther(id, ms) { await delay(ms); cont.logs.push(`${id} OTHER on ${this.id}`); return id; }
                  }
                }
              }
            },
            worker: {
              id: 'worker1',
              async processTask(id, ms) { await delay(ms); cont.logs.push(`${id} processed by ${this.id}`); return id; },
              async getStatus() { cont.logs.push(`status checked by ${this.id}`); return 'ok'; },
              async resetCounter() { cont.logs.push(`counter reset by ${this.id}`); return 'reset'; }
            }
          };
          const template = `
            {% do data.level1.level2.deepSequencer!.runOp('deep1', 10) %}
            {% do data.level1.level2.deepSequencer!.runOpOther('deep2-other', 5) %}
            {% do data.level1.level2.deepSequencer!.runOp('deep3', 2) %}
            {# Method-specific sequencing: #}
            {% do worker.processTask!('taskA', 5) %}
            {% do worker.getStatus() %}
            {% do worker.processTask!('taskB', 3) %}
            {% do worker.resetCounter!() %}
            {% do worker.processTask!('taskC', 2) %}
          `;
          await env.renderTemplateString(template, cont);
          expect(cont.logs).to.contain('deep1 on deepSeq');
          expect(cont.logs).to.contain('deep2-other OTHER on deepSeq');
          expect(cont.logs).to.contain('deep3 on deepSeq');
          expect(cont.logs.indexOf('deep1 on deepSeq')).to.be.lessThan(cont.logs.indexOf('deep3 on deepSeq')); // Sequence preserved
          expect(cont.logs).to.contain('taskA processed by worker1');
          expect(cont.logs).to.contain('status checked by worker1');
          expect(cont.logs).to.contain('taskB processed by worker1');
          expect(cont.logs).to.contain('counter reset by worker1');
          expect(cont.logs).to.contain('taskC processed by worker1');
          // Note: method!() tests may fail without parser support
        });

        it('should enforce object path sequence across loop iterations', async () => {
          const template = `
                    {% for i in [1, 2, 3] %}
                        {% do sequencer!.runOp('loop' + i, 10 - i*2) %}
                    {% endfor %}
                `;
          await env.renderTemplateString(template, context);
          expect(context.logs).to.eql(['loop1 on seq1', 'loop2 on seq1', 'loop3 on seq1']);
        });

        it('should work with object path ! in {% set %}', async () => {
          const template = `
                    {% set res1 = sequencer!.runOp('set1', 10) %}
                    {% set res2 = sequencer!.runOp('set2', 5) %}
                    Results: {{ res1 }}, {{ res2 }}
                `;
          const result = await env.renderTemplateString(template, context);
          expect(context.logs).to.eql(['set1 on seq1', 'set2 on seq1']);
          expect(result.trim()).to.equal('Results: set1, set2');
        });

        it('should work with object path ! in {{ }}', async () => {
          const template = `{{ sequencer!.runOp('out1', 10) }} {{ sequencer!.runOp('out2', 5) }}`;
          const result = await env.renderTemplateString(template, context);
          expect(context.logs).to.eql(['out1 on seq1', 'out2 on seq1']);
          expect(result.trim()).to.equal('out1 out2');
        });

        it('should maintain object path sequence mixed across {% do %}, {% set %}, {{ }}', async () => {
          const template = `
                    {%- do sequencer!.runOp('op1', 10) -%}
                    {%- set r1 = sequencer!.runOp('op2', 5) -%}
                    {{ sequencer!.runOp('op3', 3) }}
                    {%- do sequencer!.runOp('op4', 2) -%}
                    {{ r1 }}
                `;
          const result = await env.renderTemplateString(template, context);
          expect(context.logs).to.eql(['op1 on seq1', 'op2 on seq1', 'op3 on seq1', 'op4 on seq1']);
          expect(result.trim()).to.equal('op3op2');
        });

        it('should handle nested sequencing expressions', async () => {
          const cont = {
            ...context,
            sequencer: {
              id: 'seq1',
              async runOp(id, ms) {
                await delay(ms);
                cont.logs.push(`${id} on ${this.id}`);
                return id;
              },
              async wrapOp(id, ms) {
                return this.runOp(`wrapped-${id}`, ms);
              }
            }
          };
          const template = `{{ sequencer!.wrapOp(sequencer!.runOp('inner', 5), 10) }}`;
          const result = await env.renderTemplateString(template, cont);
          expect(cont.logs).to.eql(['inner on seq1', 'wrapped-inner on seq1']);
          expect(result.trim()).to.equal('wrapped-inner');
        });
      }); // End Object-Path Sequencing tests

      // --- Method-Specific Sequencing: object.path.method!() ---
      describe('2. Method-Specific Sequencing (object.path.method!())', () => {

        it('should enforce sequence for the specific marked method', async () => {
          // Parser does not yet support setting .sequential on FunCall nodes for method!()
          const template = `
                    {% do sequencer.runOp!('op1', 10) %}
                    {% do sequencer.runOp!('op2', 5) %}
                `;
          await env.renderTemplateString(template, context);
          expect(context.logs).to.eql(['op1 on seq1', 'op2 on seq1']);
        });

        it('should allow different marked methods on the same object to run independently', async () => {
          // Parser does not yet support method!()
          const template = `
                    {% do sequencer.runOp!('opA1', 10) %}
                    {% do sequencer.runOpOther!('opB1', 5) %}
                    {% do sequencer.runOp!('opA2', 3) %}
                    {% do sequencer.runOpOther!('opB2', 2) %}
                `;
          await env.renderTemplateString(template, context);
          expect(context.logs).to.contain('opA1 on seq1');
          expect(context.logs).to.contain('opA2 on seq1');
          expect(context.logs).to.contain('opB1 OTHER on seq1');
          expect(context.logs).to.contain('opB2 OTHER on seq1');
          expect(context.logs.indexOf('opA1 on seq1')).to.be.lessThan(context.logs.indexOf('opA2 on seq1')); // runOp sequence
          expect(context.logs.indexOf('opB1 OTHER on seq1')).to.be.lessThan(context.logs.indexOf('opB2 OTHER on seq1')); // runOpOther sequence
        });

        it('should allow unmarked methods to run in parallel with method sequences', async () => {
          // Parser does not yet support method!()
          const template = `
                    {% do sequencer.runOp!('op1', 10) %}
                    {% do sequencer.getStatus('status1', 5) %}
                    {% do sequencer.runOp!('op2', 2) %}
                `;
          await env.renderTemplateString(template, context);
          expect(context.logs).to.contain('Status status1 on seq1');
          expect(context.logs).to.contain('op1 on seq1');
          expect(context.logs).to.contain('op2 on seq1');
          expect(context.logs.indexOf('op1 on seq1')).to.be.lessThan(context.logs.indexOf('op2 on seq1')); // Sequence preserved
        });

        it('should maintain internal sequence for independent method sequences running concurrently', async () => {
          // Parser does not yet support method!()
          const template = `
            {% do sequencer.runOp!('A1', 10) %}
            {% do sequencer.runOpOther!('B1', 5) %}
            {% do sequencer.runOp!('A2', 3) %}
            {% do sequencer.runOpOther!('B2', 2) %}
          `;
          await env.renderTemplateString(template, context);
          expect(context.logs).to.contain('A1 on seq1');
          expect(context.logs).to.contain('A2 on seq1');
          expect(context.logs).to.contain('B1 OTHER on seq1');
          expect(context.logs).to.contain('B2 OTHER on seq1');
          expect(context.logs.indexOf('A1 on seq1')).to.be.lessThan(context.logs.indexOf('A2 on seq1')); // runOp sequence
          expect(context.logs.indexOf('B1 OTHER on seq1')).to.be.lessThan(context.logs.indexOf('B2 OTHER on seq1')); // runOpOther sequence
        });

        it('should handle multiple method ! operators (same method) within one expression sequentially', async () => {
          // Parser does not yet support method!()
          const template = `{{ sequencer.runOp!('expA1', 10) ~ sequencer.runOp!('expA2', 5) }}`;
          const result = await env.renderTemplateString(template, context);
          expect(context.logs).to.eql(['expA1 on seq1', 'expA2 on seq1']);
          expect(result.trim()).to.equal('expA1expA2');
        });

        it('should work with nested static path method sequencing', async () => {
          // Parser does not yet support method!()
          const cont = {
            ...context,
            data: { nestedSequencer: { id: 'nested', async runOp(id, ms) { await delay(ms); cont.logs.push(`${id} on ${this.id}`); return id; } } }
          };
          const template = `
                    {% do data.nestedSequencer.runOp!('nested1', 10) %}
                    {% do data.nestedSequencer.runOp!('nested2', 5) %}
                `;
          await env.renderTemplateString(template, cont);
          expect(cont.logs).to.eql(['nested1 on nested', 'nested2 on nested']);
        });

        it('should work with deeply nested static path method sequencing', async () => {
          // Parser does not yet support method!()
          const cont = {
            ...context,
            data: {
              level1: {
                id: 'l1', level2: {
                  id: 'l2', deepSequencer: {
                    id: 'deepSeq',
                    async runOp(id, ms) { await delay(ms); cont.logs.push(`${id} on ${this.id}`); return id; },
                    async runOpOther(id, ms) { await delay(ms); cont.logs.push(`${id} OTHER on ${this.id}`); return id; }
                  }
                }
              }
            }
          };
          const template = `
                    {% do data.level1.level2.deepSequencer.runOp!('deepA1', 10) %}
                    {% do data.level1.level2.deepSequencer.runOpOther!('deepB1', 5) %}
                    {% do data.level1.level2.deepSequencer.runOp!('deepA2', 2) %}
                `;
          await env.renderTemplateString(template, cont);
          expect(cont.logs).to.contain('deepA1 on deepSeq');
          expect(cont.logs).to.contain('deepA2 on deepSeq');
          expect(cont.logs).to.contain('deepB1 OTHER on deepSeq');
          expect(cont.logs.indexOf('deepA1 on deepSeq')).to.be.lessThan(cont.logs.indexOf('deepA2 on deepSeq')); // runOp sequence
        });

        it('should enforce method sequence across loop iterations', async () => {
          // Parser does not yet support method!()
          const template = `
                    {% for i in [1, 2, 3] %}
                        {% do sequencer.runOp!('loop' + i, 10 - i*2) %}
                    {% endfor %}
                `;
          await env.renderTemplateString(template, context);
          expect(context.logs).to.eql(['loop1 on seq1', 'loop2 on seq1', 'loop3 on seq1']);
        });

        it('should work with method ! in {% set %}', async () => {
          // Parser does not yet support method!()
          const template = `
                    {% set res1 = sequencer.runOp!('set1', 10) %}
                    {% set res2 = sequencer.runOp!('set2', 5) %}
                    Results: {{ res1 }}, {{ res2 }}
                `;
          const result = await env.renderTemplateString(template, context);
          expect(context.logs).to.eql(['set1 on seq1', 'set2 on seq1']);
          expect(result.trim()).to.equal('Results: set1, set2');
        });

        it('should work with method ! in {{ }}', async () => {
          // Parser does not yet support method!()
          const template = `{{ sequencer.runOp!('out1', 10) }} {{ sequencer.runOp!('out2', 5) }}`;
          const result = await env.renderTemplateString(template, context);
          expect(context.logs).to.eql(['out1 on seq1', 'out2 on seq1']);
          expect(result.trim()).to.equal('out1 out2');
        });

        it('should maintain method sequence mixed across {% do %}, {% set %}, {{ }}', async () => {
          // Parser does not yet support method!()
          const template = `
                    {%- do sequencer.runOp!('op1', 10) -%}
                    {%- set r1 = sequencer.runOp!('op2', 5) -%}
                    {{ sequencer.runOp!('op3', 3) }}
                    {%- do sequencer.runOp!('op4', 2) -%}
                    {{ r1 }}
                `;
          const result = await env.renderTemplateString(template, context);
          expect(context.logs).to.eql(['op1 on seq1', 'op2 on seq1', 'op3 on seq1', 'op4 on seq1']);
          expect(result.trim()).to.equal('op3op2');
        });

        it('should potentially allow object-path and method-specific sequences to interact predictably', async () => {
          // Parser does not yet support method!()
          const template = `
                    {% do sequencer!.runOp('objPath1', 10) %}
                    {% do sequencer.runOpOther!('methSpec1', 5) %}
                    {% do sequencer!.runOpOther('objPath2', 2) %}
                `;
          await env.renderTemplateString(template, context);
          expect(context.logs).to.contain('methSpec1 OTHER on seq1');
          expect(context.logs).to.contain('objPath1 on seq1');
          expect(context.logs).to.contain('objPath2 OTHER on seq1');
          expect(context.logs.indexOf('objPath1 on seq1')).to.be.lessThan(context.logs.indexOf('objPath2 OTHER on seq1')); // Object path sequence
        });
      }); // End Method-Specific Sequencing tests


      // --- Constraint Tests ---
      describe('3. Constraints', () => {
        let constraintContext; // Use a separate context variable for this section

        beforeEach(() => {
          // Create context specific to constraint tests, including base sequencer but adding necessary items
          constraintContext = {
            ...context, // Include logs from parent beforeEach if needed, or redefine logs:[]
            sequencer: { // Ensure sequencer exists for path tests
              ...context.sequencer, // Copy methods if needed by templates
              value: 'initial' // Property needed for prop access tests
            },
            items: [context.sequencer], // Use the sequencer from the base context
            i: 0,
            getObj: () => context.sequencer // Use the sequencer from the base context
          };
        });

        it('should REJECT ! on property access (object.path!.property)', async () => {
          const template = `
            {% do sequencer!.runOp('def', 0) %}
            {{ sequencer!.value }}
          `;
          await expectAsyncError(() => env.renderTemplateString(template, constraintContext), err => {
            expect(err.message).to.contain('Sequence marker (!) is not allowed in non-call paths');
          });
        });

        it('should REJECT ! on dynamic path segment (array index)', async () => {
          const template = `{{ items[i]!.runOp('dyn1', 5) }}`;
          await expectAsyncError(() => env.renderTemplateString(template, constraintContext), err => {
            expect(err.message).to.contain('cannot be used with dynamic key');
          });
        });

        it('should REJECT ! on dynamic path segment (function call)', async () => {
          const template = `{{ getObj()!.runOp('dyn2', 5) }}`;
          await expectAsyncError(() => env.renderTemplateString(template, constraintContext), err => {
            expect(err.message).to.contain(`The sequence marker '!' cannot be applied directly to a`);
          });
        });

        it('should REJECT ! on dynamic path segment (function call followed by lookup)', async () => {
          const template = `{{ getObj().dynamicKey!.runOp('dyn2', 5) }}`;
          await expectAsyncError(() => env.renderTemplateString(template, constraintContext), err => {
            expect(err.message).to.contain('Sequence Error');
          });
        });

        it('should REJECT double ! (path!.method!())', async () => {
          const template = `{{ sequencer!.runOp!('double', 5) }}`;
          await expectAsyncError(() => env.renderTemplateString(template, constraintContext), err => {
            expect(err.message).to.contain('Cannot use more than one sequence marker (!)');
          });
        });

      }); // End Constraint tests

      // --- Additional tests for _getSequentialPath and ! marker constraints ---
      describe('4. _getSequentialPath and ! marker constraint edge cases', () => {
        let constraintContext;
        beforeEach(() => {
          constraintContext = {
            logs: [],
            sequencer: {
              id: 'seq1',
              async runOp(id, ms) { await delay(ms); constraintContext.logs.push(`${id} on ${this.id}`); return id; },
              async runOpOther(id, ms) { await delay(ms); constraintContext.logs.push(`${id} OTHER on ${this.id}`); return id; },
              value: 'should-not-allow'
            },
            items: [{ id: 'item1', async runOp() { } }],
            i: 0,
            getObj: () => constraintContext.sequencer,
            dynamicKey: 'runOp',
            nested: {
              sequencer: {
                id: 'nested',
                async runOp(id, ms) { await delay(ms); constraintContext.logs.push(`${id} on ${this.id}`); return id; }
              }
            }
          };
        });

        it('should enforce sequence on a deeply nested static path (object.path!.method)', async () => {
          const template = `
            {% do nested.sequencer!.runOp('deep1', 10) %} {# Takes longer #}
            {% do nested.sequencer!.runOp('deep2', 5) %}  {# Takes shorter #}
          `;
          await env.renderTemplateString(template, constraintContext);
          expect(constraintContext.logs).to.eql(['deep1 on nested', 'deep2 on nested']);
        });

        //@todo - fix some duplication with Constraint tests
        it('should reject ! on a dynamic property (object[expr]!.method)', async () => {
          const template = `{{ items[i]!.runOp('fail', 5) }}`;
          await expectAsyncError(() => env.renderTemplateString(template, constraintContext), err => {
            expect(err.message).to.contain('cannot be used with dynamic keys');
          });
        });

        it('should reject ! on a function call in the path (getObj()!.runOp)', async () => {
          const template = `{{ getObj()!.runOp('fail', 5) }}`;
          await expectAsyncError(() => env.renderTemplateString(template, constraintContext), err => {
            expect(err.message).to.contain(`The sequence marker '!' cannot be applied directly`);
          });
        });

        it('should reject ! on property access (object.path!.property)', async () => {
          const template = `
            {% do sequencer!.runOp('def', 0) %}
            {{ sequencer!.value }}
          `;
          await expectAsyncError(() => env.renderTemplateString(template, constraintContext), err => {
            expect(err.message).to.contain('Sequence marker (!) is not allowed in non-call paths');
          });
        });

        it('should reject ! on method call with dynamic method name (object.path![dynamicKey]())', async () => {
          const template = `{{ sequencer![dynamicKey]('fail', 5) }}`;
          await expectAsyncError(() => env.renderTemplateString(template, constraintContext), err => {
            expect(err.message).to.contain('requires the entire path preceding it to consist of static string literal segments');
          });
        });

        it('should enforce method-specific sequence (object.method!())', async () => {
          // Parser does not yet support method!()
          const template = `
            {% do sequencer.runOp!('meth1', 10) %} {# Takes longer #}
            {% do sequencer.runOp!('meth2', 5) %}  {# Takes shorter #}
          `;
          await env.renderTemplateString(template, constraintContext);
          expect(constraintContext.logs).to.eql(['meth1 on seq1', 'meth2 on seq1']);
        });
      });

      // --- Tests specifically targeting Path Analysis ---
      describe('5. Path Analysis Constraints', () => {
        let analysisContext;

        beforeEach(() => {
          analysisContext = {
            logs: [],
            // A standard context object for valid paths
            ctxSequencer: {
              id: 'ctxSeq',
              async runOp(id, ms) { await delay(ms); analysisContext.logs.push(`${id} on ${this.id}`); return id; }
            },
            // Another context object for shadowing tests
            shadowVar: {
              id: 'ctxShadow',
              async runOp(id, ms) { await delay(ms); analysisContext.logs.push(`${id} on ${this.id}`); return id; }
            }
          };
        });

        it('should ALLOW sequencing for valid static path starting from context', async () => {
          const template = `
                  {% do ctxSequencer!.runOp('ctxA', 10) %}
                  {% do ctxSequencer!.runOp('ctxB', 5) %}
                `;
          await env.renderTemplateString(template, analysisContext);
          expect(analysisContext.logs).to.eql(['ctxA on ctxSeq', 'ctxB on ctxSeq']);
        });

        it('should REJECT sequencing for path starting with a template variable {% set %}', async () => {
          const template = `
                  {% set tplSequencer = ctxSequencer %}
                  {% do tplSequencer!.runOp('tplA', 10) %}
                  {% do tplSequencer!.runOp('tplB', 5) %}
                `;
          await expectAsyncError(() => env.renderTemplateString(template, analysisContext), err => {
            expect(err.message).to.contain('Sequence marker (!) is not allowed in non-context variable paths');
          });
        });

        it('should REJECT sequencing(at root) for path starting with a macro parameter (compileSymbol)', async () => {
          const template = `
                  {% macro testMacro(mcSequencer) %}
                    {% do mcSequencer!.runOp('mcA', 10) %}
                    {% do mcSequencer!.runOp('mcB', 5) %}
                  {% endmacro %}
                  {{ testMacro(ctxSequencer) }}
                `;
          await expectAsyncError(() => env.renderTemplateString(template, analysisContext), err => {
            expect(err.message).to.contain('not allowed inside macros');
          });
        });

        it('should REJECT sequencing for path starting with a macro parameter (compileLookupVal)', async () => {
          const template = `
                  {% macro testMacro(mcSequencer) %}
                    {% do mcSequencer.runOp!('mcA', 10) %}
                    {% do mcSequencer.runOp!('mcB', 5) %}
                  {% endmacro %}
                  {{ testMacro(ctxSequencer) }}
                `;
          await expectAsyncError(() => env.renderTemplateString(template, analysisContext), err => {
            expect(err.message).to.contain('not allowed inside macros');
          });
        });

        it('should REJECT sequencing when template var shadows context var', async () => {
          const template = `
                  {% set shadowVar = ctxSequencer %} {# Shadowing context.shadowVar #}
                  {% do shadowVar!.runOp('shA', 10) %}
                  {% do shadowVar!.runOp('shB', 5) %}
                `;
          await expectAsyncError(() => env.renderTemplateString(template, analysisContext), err => {
            expect(err.message).to.contain(`Sequence marker (!) is not allowed in non-context variable paths`);
          });
        });

        it('[Placeholder] should treat object.method!() as needing a method-specific lock key', async () => {
          // Parser does not yet support method!()
          const template = `
                   {% do ctxSequencer.runOp!('mA', 10) %}
                   {% do ctxSequencer.runOp!('mB', 5) %}
                 `;
          await env.renderTemplateString(template, analysisContext);
          expect(analysisContext.logs).to.eql(['mA on ctxSeq', 'mB on ctxSeq']);
        });

        it('Should treat path!.method() and path.method!() differently', async () => {
          const template = `
                   {% do ctxSequencer!.runOp('pathOp1', 10) %}
                   {% do ctxSequencer.runOp!('methodOp1', 5) %}
                   {% do ctxSequencer!.runOp('pathOp2', 3) %}
                   {% do ctxSequencer.runOp!('methodOp2', 2) %}
                 `;
          await env.renderTemplateString(template, analysisContext);
          expect(analysisContext.logs).to.contain('pathOp1 on ctxSeq');
          expect(analysisContext.logs).to.contain('pathOp2 on ctxSeq');
          expect(analysisContext.logs).to.contain('methodOp1 on ctxSeq');
          expect(analysisContext.logs).to.contain('methodOp2 on ctxSeq');
          expect(analysisContext.logs.indexOf('pathOp1 on ctxSeq')).to.be.lessThan(analysisContext.logs.indexOf('pathOp2 on ctxSeq')); // Path sequence
          expect(analysisContext.logs.indexOf('methodOp1 on ctxSeq')).to.be.lessThan(analysisContext.logs.indexOf('methodOp2 on ctxSeq')); // Method sequence
        });

        it('should REJECT sequencing for path starting with a template variable set by {% set %}', async () => {
          const template = `
                  {% set tplSequencer = ctxSequencer %}
                  {% do tplSequencer!.runOp('tplA', 10) %}
                  {% do tplSequencer!.runOp('tplB', 5) %}
                `;
          await expectAsyncError(() => env.renderTemplateString(template, analysisContext), err => {
            expect(err.message).to.contain('Sequence marker (!) is not allowed in non-context variable paths');
          });
        });

        it('should REJECT sequencing for path starting with a macro parameter', async () => {
          const template = `
                  {% macro testMacro(mcSequencer) %}
                    {% do mcSequencer!.runOp('mcA', 10) %}
                    {% do mcSequencer!.runOp('mcB', 5) %}
                  {% endmacro %}
                  {{ testMacro(ctxSequencer) }}
                `;
          await expectAsyncError(() => env.renderTemplateString(template, analysisContext), err => {
            expect(err.message).to.contain('not allowed inside macros');
          });
        });

        it('should REJECT sequencing for path starting with a for-loop variable', async () => {
          const template = `
                  {% for loopSequencer in [ctxSequencer] %}
                    {% do loopSequencer!.runOp('loopA', 10) %}
                    {% do loopSequencer!.runOp('loopB', 5) %}
                  {% endfor %}
                `;
          await expectAsyncError(() => env.renderTemplateString(template, analysisContext), err => {
            expect(err.message).to.contain('Sequence marker (!) is not allowed in non-context variable paths');
          });
        });

        it('should REJECT sequencing for path starting with an imported namespace as the path root', async () => {
          // lib_for_import_as.njk will export 'actualSequencerExport' which is assigned ctxSequencer
          // from the importing template's context.
          const loader = new StringLoader();
          loader.addTemplate('lib_for_import_as.njk', `
                  {# 'ctxSequencer' here comes from the context of the template that imports this file #}
                  {% set actualSequencerExport = ctxSequencer %}
                `);
          const template = `
                  {# 'analysisContext' (containing 'ctxSequencer') is provided to this renderTemplateString call #}
                  {% import "lib_for_import_as.njk" as myImportedLib %}
                  {# The path is 'myImportedLib.actualSequencerExport'.
                     The compiler should identify 'myImportedLib' as the root of this path.
                     'myImportedLib' is a template-scoped variable. #}
                  {% do myImportedLib.actualSequencerExport!.runOp('importAsA', 10) %}
                `;
          await expectAsyncError(() => env.renderTemplateString(template, analysisContext), err => {
            expect(err.message).to.contain('Sequence marker (!) is not allowed in non-context variable paths');
          });
        });

        it('should REJECT sequencing for path starting with a specifically imported variable alias', async () => {
          const loader = new StringLoader();
          loader.addTemplate('lib_for_from_import.njk', `
                  {# 'ctxSequencer' here comes from the context of the template that imports this file #}
                  {% set exportedSequencer = ctxSequencer %}
                `);
          const template = `
                  {% from "lib_for_from_import.njk" import exportedSequencer as aliasedSequencer %}
                  {# 'aliasedSequencer' is the template-scoped variable. #}
                  {% do aliasedSequencer!.runOp('fromImportA', 10) %}
                `;
          await expectAsyncError(() => env.renderTemplateString(template, analysisContext), err => {
            expect(err.message).to.contain('Sequence marker (!) is not allowed in non-context variable paths');
          });
        });

        it('should REJECT sequencing for path starting with a variable assigned the result of super()', async () => {
          const loader = new StringLoader();
          loader.addTemplate('parent_for_super.njk', `
                  {% block content_block %}
                    {# This content will be captured by super() in the child.
                       For the test, what's rendered here doesn't strictly matter as much as
                       the fact that super() is assigned to a variable. #}
                    Parent Content
                  {% endblock %}
                `);
          const template = `
                  {% extends "parent_for_super.njk" %}
                  {% block content_block %}
                    {% set resultFromSuper = super() %}
                    {# 'resultFromSuper' is a template-scoped variable.
                       Even if it's a string, the attempt to use !.runOp implies
                       the user treats it as an object. The sequence check should occur
                       based on 'resultFromSuper' being a template variable. #}
                    {% do resultFromSuper!.runOp('superA', 10) %}
                  {% endblock %}
                `;
          await expectAsyncError(() => env.renderTemplateString(template, analysisContext), err => {
            expect(err.message).to.contain('Sequence marker (!) is not allowed in non-context variable paths');
          });
        });

        it('should REJECT sequencing for path starting with a variable assigned an async (expression) filter result', async () => {
          env.addFilter('getAsSequencerFilter', async (input) => {
            // This filter returns the actual sequencer object from the context
            return analysisContext.ctxSequencer;
          });
          const template = `
                  {% set resultOfFilter = "dummy_value" | getAsSequencerFilter %}
                  {# 'resultOfFilter' is the template-scoped variable. #}
                  {% do resultOfFilter!.runOp('filterExpA', 10) %}
                `;
          await expectAsyncError(() => env.renderTemplateString(template, analysisContext), err => {
            expect(err.message).to.contain('Sequence marker (!) is not allowed in non-context variable paths');
          });
        });

      }); // End Path Analysis Constraint tests

    }); // End Side effects - ! feature

  }); // End Side effects

  describe('Side effects - Additional Tests for ! Feature', () => {
    let env, context;

    beforeEach(() => {
      env = new AsyncEnvironment();
      context = {
        logs: [],
        seq: {
          id: 's1',
          async runOp(id, ms) {
            await delay(ms); context.logs.push(id); return id;
          }
        },
        sequencer: {
          id: 'seq1',
          async runOp(id, ms) { await delay(ms); context.logs.push(`${id} on ${this.id}`); return id; },
          value: 'initial'
        }
      };
    });

    describe('Error Handling and Edge Cases', () => {
      it('should reject invalid static path segments (object.123!.method())', async () => {
        const template = `{% do sequencer.123!.runOp('op', 10) %}`;
        await expectAsyncError(() => env.renderTemplateString(template, context));
      });

      //@todo - line numbering
      it('should provide detailed error message for invalid ! usage', async () => {
        const template = `Line 1\n{% do sequencer!.runOp('def', 0) %}\n{% do sequencer!.value %}`;
        await expectAsyncError(() => env.renderTemplateString(template, context), err => {
          expect(err.message).to.contain('Line 3'); // Adjusted line number
          expect(err.message).to.contain('not allowed in non-call paths');
        });
      });
    });

    describe('Concurrency and Performance', () => {
      it('should handle multiple concurrent sequences without interference', async () => {
        const cont = {
          logs: [],
        };
        const numSequences = 5;
        const delayMs = 10; // Use a slightly longer delay to observe concurrency better

        // Create context properties s0, s1, ... s4 directly on the context
        for (let i = 0; i < numSequences; i++) {
          const seqId = `s${i}`;
          cont[seqId] = {
            id: seqId,
            // Use an arrow function to capture 'seqId' or ensure 'this' is correct
            // Direct access to cont.logs is simplest
            async runOp(opId) {
              const currentSeqId = this.id; // 'this' should refer to the cont[seqId] object
              await delay(delayMs);
              cont.logs.push(`${opId} on ${currentSeqId}`);
            }
          };
        }

        // Create template string using valid static paths for sequencing
        const templateParts = [];
        for (let i = 0; i < numSequences; i++) {
          // Use the static key s0!, s1!, etc.
          templateParts.push(`{% do s${i}!.runOp('op${i}') %}`);
        }
        const template = templateParts.join(''); // e.g., "{% do s0!.runOp('op0') %}{% do s1!.runOp('op1') %}"

        // Render the template - renderTemplateString completes after all async ops triggered by 'do' finish
        await env.renderTemplateString(template, cont);

        // Assertions
        expect(cont.logs).to.have.length(numSequences);

        // Check that all expected operations completed (order might vary due to concurrency)
        const expectedLogs = new Set();
        for (let i = 0; i < numSequences; i++) {
          expectedLogs.add(`op${i} on s${i}`);
        }
        // Convert actual logs to a Set for order-independent comparison
        expect(new Set(cont.logs)).to.eql(expectedLogs, 'All operations should have logged exactly once');
        // Optional: Check for potential interleaving (difficult to guarantee exact order)
        // console.log("Execution Logs:", cont.logs);
      });
    });

    describe('Integration and Scope', () => {
      it('should work with async filters', async () => {
        env.addFilterAsync('delayLog', async (val, ms) => {
          await delay(ms); return `${val}-delayed`;
        }, true);
        const cont = {
          logs: [], seq: {
            id: 's1',
            async runOp(id, ms) {
              await delay(ms); cont.logs.push(id);
              return id;
            }
          }
        };

        const template = `{% do seq!.runOp('f1', 10) %}{{ seq!.runOp('f2', 2)|delayLog(2) }}`;
        const result = await env.renderTemplateString(template, cont);
        expect(cont.logs).to.eql(['f1', 'f2']);
        expect(result).to.equal('f2-delayed');
      });

      it('should reject sequencing when shadowed in a loop', async () => {
        const cont = { logs: [], seq: { id: 's1', async runOp(id, ms) { await delay(ms); cont.logs.push(id); } } };
        const template = `
          {% for seq in [seq] %}
            {% set seq = seq %}
            {% do seq!.runOp('l1', 8) %}
            {% do seq!.runOp('l2', 4) %}
          {% endfor %}
        `;
        await expectAsyncError(() => env.renderTemplateString(template, cont), err => {
          expect(err.message).to.contain('not allowed in non-context variable paths');
        });
      });

      it('should REJECT sequence marker ! on a template variable that shadows an eligible context variable', async () => {
        const cont = {
          logs: [],
          seq: {
            id: 's1',
            async runOp(id, ms) { await delay(ms); cont.logs.push(`ctx.seq-${id}`); }
          }
        };
        const template = `
          {% set seq = { id: 's2', someData: 'newValue' } %}
          {% do seq!.runOp('o2', 5) %} {# ! on template var 'seq' should error #}
        `;

        await expectAsyncError(
          () => env.renderTemplateString(template, cont),
          err => {
            expect(err.message).to.contain('not allowed in non-context variable paths');
          }
        );
      });

      it('should REJECT sequence marker ! in the path of a template variable that shadows an eligible context variable', async () => {
        const cont = {
          logs: [],
          seq: {
            id: 's1',
            async runOp(id, ms) { await delay(ms); cont.logs.push(`ctx.seq-${id}`); }
          }
        };
        //          {% do seq!.runOp('o1', 20) %}
        const template = `

          {% set seq = { id: 's2', someData: 'newValue' } %}
          {% do seq.someData!.runOp('o2', 5) %} {# ! on path from template var 'seq' should error #}
        `;

        await expectAsyncError(
          () => env.renderTemplateString(template, cont),
          err => {
            expect(err.message).to.contain(`Sequence marker (!) is not allowed in non-context variable paths`);
          }
        );
      });

      it('should handle spaced syntax for !', async () => {
        const cont = { logs: [], seq: { id: 's1', async runOp(id, ms) { await delay(ms); cont.logs.push(id); } } };
        const template = `{% do seq ! . runOp('s1', 8) %}{% do seq ! .runOp('s2', 4) %}`;
        await env.renderTemplateString(template, cont);
        expect(cont.logs).to.eql(['s1', 's2']);
      });
      it('should support object path repair (e.g. obj!!.method)', async () => {
        const logs = [];
        const ctx = {
          obj: {
            async init(id, ms) {
              await delay(ms);
              return 1;
              //throw new Error('Init failed');
            },
            async repair(id, ms) {
              await delay(ms);
              logs.push(`repaired ${id}`);
              return `repaired ${id}`;
            },
            async after(id, ms) {
              await delay(ms);
              logs.push(`after ${id}`);
              return `after ${id}`;
            }
          }
        };

        const script = `
                var a = obj!.init('A', 5)
                var b = obj!!.repair('B', 5)
                var c = obj!.after('C', 5)
                @data = c
             `;
        const result = await env.renderScriptString(script, ctx);
        expect(logs).to.eql(['repaired B', 'after C']);
        expect(result.data).to.eql('after C');
      });
    });
  });
  //End additional side effect tests

  describe('Cascada Sequencing with Macro and Caller', function () {
    let env;

    beforeEach(function () {
      env = new AsyncEnvironment(null, { autoescape: false });
    });

    it('should execute sequential operations within caller() in order', async function () {
      const callOrder = [];
      const context = {
        // This will be our context object with a method to sequence
        sequentialService: {
          name: 'ServiceA',
          // A method with a side effect (pushing to callOrder) and a delay
          async processItem(item) {
            await delay(item === 'item1' ? 10 : 5); // item1 takes longer
            callOrder.push(`${this.name}:${item}`);
            return `Processed ${item}`;
          }
        }
      };

      const templateString = `
        {% macro myBox(title) %}
          <div class="box">
            <h3>{{ title }}</h3>
            <div class="content">
              {{ caller() }}
            </div>
          </div>
        {% endmacro %}

        {% call myBox("Task Box") %}
          <p>Starting tasks...</p>
          {# These two operations on the same object path should be sequential #}
          {% do sequentialService!.processItem("item1") %}
          {% do sequentialService!.processItem("item2") %}
          <p>Tasks initiated.</p>
        {% endcall %}
      `;

      // Expected output isn't the primary focus here, but the order of side effects.
      // We'll check callOrder.
      const result = await env.renderTemplateString(templateString, context);

      // console.log('Rendered Output:', result);
      // console.log('Call Order:', callOrder);

      // Verify the order of operations
      expect(callOrder).to.eql([
        'ServiceA:item1', // Should be first despite potentially finishing later if not sequential
        'ServiceA:item2'
      ]);

      // Optional: Check if the output contains expected parts
      expect(result).to.contain('<h3>Task Box</h3>');
      expect(result).to.contain('<p>Starting tasks...</p>');
      expect(result).to.contain('<p>Tasks initiated.</p>');
    });


    it('should handle multiple sequential calls on different path segments within caller()', async function () {
      const eventLog = [];
      const context = {
        dataStore: {
          async update(key, value) {
            await delay(10);
            eventLog.push(`update:${key}=${value}`);
            return `updated ${key}`;
          }
        },
        logger: {
          async log(message) {
            await delay(5);
            eventLog.push(`log:${message}`);
            return `logged ${message}`;
          }
        }
      };

      const templateString = `
        {% macro section(name) %}
          <section>
            <h4>{{ name }}</h4>
            {{ caller() }}
          </section>
        {% endmacro %}

        {% call section("Processing") %}
          {% do dataStore!.update("alpha", 100) %} {# Sequence for dataStore! path #}
          {% do logger!.log("Alpha updated") %}     {# Sequence for logger! path (independent of dataStore!) #}
          {% do dataStore!.update("beta", 200) %}  {# Waits for previous dataStore! call #}
          {% do logger!.log("Beta updated") %}      {# Waits for previous logger! call #}
        {% endcall %}
      `;

      await env.renderTemplateString(templateString, context);
      // console.log(eventLog);

      // Check relative order for dataStore operations
      expect(eventLog.indexOf('update:alpha=100')).to.be.lessThan(eventLog.indexOf('update:beta=200'));
      // Check relative order for logger operations
      expect(eventLog.indexOf('log:Alpha updated')).to.be.lessThan(eventLog.indexOf('log:Beta updated'));

      // We can't guarantee absolute interleaving order between dataStore! and logger! paths
      // as they are independent sequences. But we can check all events are present.
      expect(eventLog).to.contain('update:alpha=100');
      expect(eventLog).to.contain('update:beta=200');
      expect(eventLog).to.contain('log:Alpha updated');
      expect(eventLog).to.contain('log:Beta updated');
      expect(eventLog.length).to.be(4);
    });
    //End additional macro/caller tests
  });

  describe('Cascada Sequential Operations', () => {
    let cont;
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
      cont = {
        logs: [],
        dataStore: { val: 'initial' },
        seqObj: {
          idGen: 0,
          async updateAndGet(key, value, delayMs = 2) {
            await delay(delayMs);
            const newId = ++this.idGen; // Critical shared resource
            cont.logs.push(`updateAndGet: ${key}=${value} (id: ${newId})`);
            cont.dataStore[key] = `${value}-${newId}`;
            return cont.dataStore[key];
          },
          async simpleLog(message, delayMs = 2) {
            await delay(delayMs);
            cont.logs.push(`simpleLog: ${message}`);
            return message;
          }
        }
      };
    });

    it('should ensure sequence order for multiple direct async calls to the same sequential object path', async () => {
      const template = `
        {% set r1 = seqObj!.updateAndGet("k1", "opA", 9) %}
        {% set r2 = seqObj!.updateAndGet("k2", "opB", 3) %}
        {{ r1 }} | {{ r2 }}`;
      // Expected: opA (id:1) completes, then opB (id:2) completes.
      const result = await env.renderTemplateString(template, cont);
      expect(result.trim()).to.equal('opA-1 | opB-2');
      expect(cont.logs).to.eql([
        'updateAndGet: k1=opA (id: 1)',
        'updateAndGet: k2=opB (id: 2)'
      ]);
    });

    it('should ensure sequence order for mixed operations on the same sequential object path', async () => {
      const template = `
        {%- do seqObj!.updateAndGet("k1", "valX", 9) -%}
        {{- seqObj!.simpleLog("after valX update", 5) -}}
        {%- set finalVal = seqObj!.updateAndGet("k1", "valY", 3) %}
        Final: {{ finalVal -}}`;
      // Expected: updateAndGet(valX) -> simpleLog -> updateAndGet(valY)
      const result = await env.renderTemplateString(template, cont);
      expect(result.trim()).to.equal('after valX update\n        Final: valY-2');
      expect(cont.logs).to.eql([
        'updateAndGet: k1=valX (id: 1)',
        'simpleLog: after valX update',
        'updateAndGet: k1=valY (id: 2)'
      ]);
    });

    it('should handle sequence across an output and a set tag', async () => {
      const template = `Output1: {{ seqObj!.updateAndGet("k1", "Out", 9) }}
  {%- set setVal = seqObj!.updateAndGet("k2", "Set", 3) %}
  Output2: {{ setVal }}`;
      // Expected: "Out" (id:1), then "Set" (id:2)
      const result = await env.renderTemplateString(template, cont);
      const lines = result.trim().split('\n').map(s => s.trim());
      expect(lines[0]).to.equal('Output1: Out-1');
      expect(lines[1]).to.equal('Output2: Set-2');
      expect(cont.logs).to.eql([
        'updateAndGet: k1=Out (id: 1)',
        'updateAndGet: k2=Set (id: 2)'
      ]);
    });

    // This test is the most direct analogy to the failing filter test
    it('should fail with idGen collision if sequence counts are not aggregated (THIS SHOULD FAIL WITH CURRENT BUG)', async () => {
      // This template structure is similar to the failing filter test:
      // Two separate top-level template elements (Output tags in this case)
      // each containing an async block that uses the same sequence key.
      // If the parent frame (of the root NodeList's children) doesn't aggregate
      // writeCounts for "!seqObj" to 2, each Output will get its own lock instance.
      const template = `{{ seqObj!.updateAndGet("k1", "firstCall", 9) }} | {{ seqObj!.updateAndGet("k2", "secondCall", 3) }}`;
      // Expected if correct: firstCall-1 | secondCall-2
      // Expected if buggy: firstCall-1 | secondCall-1  (due to idGen collision)
      const result = await env.renderTemplateString(template, cont);

      // WITH THE BUG, THIS WILL LIKELY BE:
      // expect(result.trim()).to.equal('firstCall-1 | secondCall-1');
      // expect(cont.logs).to.eql([
      //   'updateAndGet: k2=secondCall (id: 1)', // or k1 first, race condition
      //   'updateAndGet: k1=firstCall (id: 1)'
      // ]);

      // WITH THE FIX, THIS SHOULD BE:
      expect(result.trim()).to.equal('firstCall-1 | secondCall-2');
      expect(cont.logs).to.eql([
        'updateAndGet: k1=firstCall (id: 1)',
        'updateAndGet: k2=secondCall (id: 2)'
      ]);
    });
  });

  describe('Cascada Filters with Sequential Operations (!)', () => {
    let cont;
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
      cont = {
        logs: [],
        dataStore: { val: 'initial' },
        // Sequential object
        seqObj: {
          idGen: 0,
          async updateAndGet(key, value, delayMs = 2) {
            await delay(delayMs);
            const newId = ++this.idGen;
            cont.logs.push(`updateAndGet: ${key}=${value} (id: ${newId})`);
            cont.dataStore[key] = `${value}-${newId}`;
            return cont.dataStore[key];
          },
          async getValue(key, delayMs = 2) {
            await delay(delayMs);
            cont.logs.push(`getValue: ${key}`);
            return cont.dataStore[key] || `undefined_${key}`;
          }
        },
        // Async function for context
        async getAsyncSuffix(delayMs = 2) {
          await delay(delayMs);
          cont.logs.push('getAsyncSuffix');
          return '_asyncSuffix';
        }
      };

      // Custom synchronous filter
      env.addFilter('customSyncSuffix', (str, suffix) => {
        cont.logs.push(`customSyncSuffix: adding '${suffix}' to '${str}'`);
        return str + suffix;
      });

      // Custom asynchronous filter (Promise-based)
      env.addFilter('customAsyncPrefix', async (str, prefix) => {
        await delay(2);
        cont.logs.push(`customAsyncPrefix: adding '${prefix}' to '${str}'`);
        return prefix + str;
      });
    });

    // --- Tests for Synchronous Filters (Filter node) with Sequential/Async Arguments ---

    it('should handle sync filter with sequential async arg', async () => {
      // `upper` is sync, but its input comes from a sequential async op.
      const template = `{{ seqObj!.updateAndGet("k1", "valA", 8) | upper }}`;
      // Expected: updateAndGet runs first, then its result is uppercased.
      const result = await env.renderTemplateString(template, cont);
      expect(result).to.equal('VALA-1');
      expect(cont.logs).to.eql(['updateAndGet: k1=valA (id: 1)']);
    });

    it('should chain sync filters with a sequential async arg at the start', async () => {
      const template = `{{ seqObj!.updateAndGet("k1", "valB", 8) | upper | customSyncSuffix("_chained") }}`;
      // Expected: updateAndGet -> upper -> customSyncSuffix
      const result = await env.renderTemplateString(template, cont);
      expect(result).to.equal('VALB-1_chained');
      expect(cont.logs).to.eql([
        'updateAndGet: k1=valB (id: 1)',
        'customSyncSuffix: adding \'_chained\' to \'VALB-1\''
      ]);
    });

    it('should handle sync filter with multiple args, one sequential and async', async () => {
      // `replace` is sync. `seqObj!.updateAndGet` is sequential. `getAsyncSuffix` is async.
      const template = `{{ "start" | replace("s", seqObj!.updateAndGet("k1", "REP", 8)) | customSyncSuffix(getAsyncSuffix(2)) }}`;
      // Expected:
      // 1. getAsyncSuffix can start.
      // 2. seqObj!.updateAndGet("k1", "REP", 20) runs and completes (value: "REP-1").
      // 3. "start" is replaced with "REP-1" => "REP-1tart".
      // 4. customSyncSuffix adds "_asyncSuffix".
      const result = await env.renderTemplateString(template, cont);
      expect(result).to.equal('REP-1tart_asyncSuffix');
      expect(cont.logs).to.eql([
        'getAsyncSuffix', // Could be here or after updateAndGet depending on Promise.all behavior
        'updateAndGet: k1=REP (id: 1)',
        'customSyncSuffix: adding \'_asyncSuffix\' to \'REP-1tart\''
      ]);
      // To make the order more deterministic for logs if needed for such a test:
      // You could make getAsyncSuffix depend on a dummy var set after the sequential op.
    });

    it('should ensure sequence order with sync filters and multiple sequential ops', async () => {
      const template = `{{ seqObj!.updateAndGet("k1", "first", 9) | upper }} BEFORE {{ seqObj!.updateAndGet("k2", "second", 3) | lower }}`;
      // Expected: "first" op completes, then "second" op completes.
      const result = await env.renderTemplateString(template, cont);
      expect(result).to.equal('FIRST-1 BEFORE second-2');
      expect(cont.logs).to.eql([
        'updateAndGet: k1=first (id: 1)',
        'updateAndGet: k2=second (id: 2)'
      ]);
    });

    it('should handle sync filter within an expression involving sequential op', async () => {
      const template = `Value: {{ (seqObj!.updateAndGet("k1", "expVal", 8) | customSyncSuffix("_sync")) + seqObj!.getValue("k1", 2) }}`;
      // Expected:
      // 1. updateAndGet("k1", "expVal") -> "expVal-1"
      // 2. "expVal-1" | customSyncSuffix("_sync") -> "expVal-1_sync"
      // 3. getValue("k1") -> "expVal-1" (because updateAndGet ran first due to sequence)
      // 4. Concatenate: "expVal-1_sync" + "expVal-1"
      const result = await env.renderTemplateString(template, cont);
      expect(result).to.equal('Value: expVal-1_syncexpVal-1');
      expect(cont.logs).to.eql([
        'updateAndGet: k1=expVal (id: 1)',
        'customSyncSuffix: adding \'_sync\' to \'expVal-1\'',
        'getValue: k1'
      ]);
    });


    // --- Tests for Asynchronous Filters (FilterAsync node) with Sequential/Async Arguments ---

    it('should handle async filter with sequential async arg', async () => {
      const template = `{{ seqObj!.updateAndGet("k1", "valC", 8) | customAsyncPrefix("PREFIX_") }}`;
      // Expected: updateAndGet runs first, then its result is prefixed.
      const result = await env.renderTemplateString(template, cont);
      expect(result).to.equal('PREFIX_valC-1');
      expect(cont.logs).to.eql([
        'updateAndGet: k1=valC (id: 1)',
        'customAsyncPrefix: adding \'PREFIX_\' to \'valC-1\''
      ]);
    });

    it('should chain async filters with a sequential async arg at the start', async () => {
      const template = `{{ seqObj!.updateAndGet("k1", "valD", 8) | customAsyncPrefix("P1_") | customAsyncPrefix("P2_") }}`;
      const result = await env.renderTemplateString(template, cont);
      expect(result).to.equal('P2_P1_valD-1');
      expect(cont.logs).to.eql([
        'updateAndGet: k1=valD (id: 1)',
        'customAsyncPrefix: adding \'P1_\' to \'valD-1\'',
        'customAsyncPrefix: adding \'P2_\' to \'P1_valD-1\''
      ]);
    });

    it('should handle async filter with multiple args, one sequential/async', async () => {
      // Adding a dummy async filter that takes multiple args for this test
      env.addFilter('customAsyncJoin', async (str1, str2, sep) => {
        await delay(2);
        cont.logs.push(`customAsyncJoin: joining '${str1}', '${str2}' with '${sep}'`);
        return str1 + sep + str2;
      });
      const template = `{{ "start" | customAsyncJoin(seqObj!.updateAndGet("k1", "JOIN_PART", 8), getAsyncSuffix(2)) }}`;
      // Expected:
      // 1. getAsyncSuffix can start.
      // 2. seqObj!.updateAndGet("k1", "JOIN_PART", 20) runs (value: "JOIN_PART-1").
      // 3. customAsyncJoin joins "start", "JOIN_PART-1", and "_asyncSuffix".
      const result = await env.renderTemplateString(template, cont);
      expect(result).to.equal('start_asyncSuffixJOIN_PART-1'); // Order of async suffix and join part might vary if not explicitly sequential
      expect(cont.logs).to.contain('getAsyncSuffix');
      expect(cont.logs).to.contain('updateAndGet: k1=JOIN_PART (id: 1)');
      expect(cont.logs).to.contain('customAsyncJoin: joining \'start\', \'JOIN_PART-1\' with \'_asyncSuffix\'');
      // To ensure logs order for such a test, one might need to enforce sequence between getAsyncSuffix and updateAndGet too
    });

    it('should ensure sequence order with async filters and multiple sequential ops', async () => {
      const template = `{{ seqObj!.updateAndGet("k1", "asyncFirst", 9) | customAsyncPrefix("A_") }} BEFORE {{ seqObj!.updateAndGet("k2", "asyncSecond", 3) | customAsyncPrefix("B_") }}`;
      const result = await env.renderTemplateString(template, cont);
      expect(result).to.equal('A_asyncFirst-1 BEFORE B_asyncSecond-2');

      // The sequential operations should run in order, but async filters can run in parallel
      // once their inputs are ready. The exact order of filter execution may vary.
      expect(cont.logs).to.contain('updateAndGet: k1=asyncFirst (id: 1)');
      expect(cont.logs).to.contain('updateAndGet: k2=asyncSecond (id: 2)');
      expect(cont.logs).to.contain('customAsyncPrefix: adding \'A_\' to \'asyncFirst-1\'');
      expect(cont.logs).to.contain('customAsyncPrefix: adding \'B_\' to \'asyncSecond-2\'');

      // Ensure the sequential operations run in order
      const updateLogs = cont.logs.filter(log => log.startsWith('updateAndGet:'));
      expect(updateLogs[0]).to.contain('k1=asyncFirst');
      expect(updateLogs[1]).to.contain('k2=asyncSecond');
    });


    // --- Mixed Sync/Async Filters and Complex Expressions ---

    it('should chain mixed sync and async filters with sequential op', async () => {
      const template = `{{ seqObj!.updateAndGet("k1", "mixed", 8) | upper | customAsyncPrefix("ASYNC_") | customSyncSuffix("_SYNC") }}`;
      // Expected: updateAndGet -> upper (sync) -> customAsyncPrefix (async) -> customSyncSuffix (sync)
      const result = await env.renderTemplateString(template, cont);
      expect(result).to.equal('ASYNC_MIXED-1_SYNC');
      expect(cont.logs).to.eql([
        'updateAndGet: k1=mixed (id: 1)',
        // upper is built-in, no log from it
        'customAsyncPrefix: adding \'ASYNC_\' to \'MIXED-1\'',
        'customSyncSuffix: adding \'_SYNC\' to \'ASYNC_MIXED-1\''
      ]);
    });

    it('should handle sequential op as arg to sync filter, result used by async filter', async () => {
      const template = `{{ "prefix-" | customSyncSuffix(seqObj!.updateAndGet("k1", "valE", 8)) | customAsyncPrefix("FINAL_") }}`;
      // Expected: updateAndGet -> customSyncSuffix -> customAsyncPrefix
      const result = await env.renderTemplateString(template, cont);
      expect(result).to.equal('FINAL_prefix-valE-1');
      expect(cont.logs).to.eql([
        'updateAndGet: k1=valE (id: 1)',
        'customSyncSuffix: adding \'valE-1\' to \'prefix-\'',
        'customAsyncPrefix: adding \'FINAL_\' to \'prefix-valE-1\''
      ]);
    });

    it('should correctly apply sequence lock across filter arguments and standalone expressions', async () => {
      const template = `
      {% set r1 = seqObj!.updateAndGet("k1", "A", 10) %}
      {{ "ignored" | customSyncSuffix(seqObj!.updateAndGet("k1", "B", 4)) }}
      {%- set r2 = seqObj!.getValue("k1") %},{{ r1 }},{{ r2 }}`;
      // Expected:
      // 1. seqObj!.updateAndGet("k1", "A", 40) -> r1 = "A-1"
      // 2. seqObj!.updateAndGet("k1", "B", 10) -> (filter arg, result: "B-2")
      // 3. seqObj!.getValue("k1") -> r2 = "B-2" (because B was the last update to k1)
      // Output: "ignored_SYNC_SUFFIX_B-2,A-1,B-2"
      // Note: The filter's output is part of the main output string.
      const result = await env.renderTemplateString(template, cont);
      expect(result.trim()).to.equal('ignoredB-2,A-1,B-2');
      expect(cont.logs).to.eql([
        'updateAndGet: k1=A (id: 1)',
        'updateAndGet: k1=B (id: 2)',
        'customSyncSuffix: adding \'B-2\' to \'ignored\'',
        'getValue: k1'
      ]);
    });

    it('should handle filter result as part of complex expression with other sequential op', async () => {
      const template = `Result: {{ (seqObj!.updateAndGet("k1", "FILTER_IN", 8) | upper) + "---" + seqObj!.updateAndGet("k2", "OTHER_OP", 3) }}`;
      // Expected:
      // 1. updateAndGet("k1", "FILTER_IN") -> "FILTER_IN-1" -> "FILTER_IN-1" (upper)
      // 2. updateAndGet("k2", "OTHER_OP") -> "OTHER_OP-2"
      // Concatenate: "FILTER_IN-1" + "---" + "OTHER_OP-2"
      const result = await env.renderTemplateString(template, cont);
      expect(result).to.equal('Result: FILTER_IN-1---OTHER_OP-2');
      expect(cont.logs).to.eql([
        'updateAndGet: k1=FILTER_IN (id: 1)',
        'updateAndGet: k2=OTHER_OP (id: 2)'
      ]);
    });

    it('should handle errors originating from sequential argument to a filter gracefully', async () => {
      env.addFilter('erroringSeqArgUser', (str) => 'PREFIX:' + str);
      cont.seqObj.erroringOp = async (key) => {
        await delay(5);
        cont.logs.push(`erroringOp for ${key} about to throw`);
        throw new Error(`ErrorFrom!${key}`);
      };
      const template = `{{ "input" | erroringSeqArgUser(seqObj!.erroringOp("kErr")) }}`;
      try {
        await env.renderTemplateString(template, cont);
        expect().fail('Error should have been propagated');
      } catch (e) {
        expect(isPoisonError(e)).to.be(true);
        expect(e.message).to.contain('ErrorFrom!kErr');
        expect(cont.logs).to.eql(['erroringOp for kErr about to throw']);
      }
    });

    it('your original failing test (adapted)', async () => {
      // Using a Cascada-style async filter (returns Promise)
      env.addFilter('delayLog', async (val, ms) => {
        await delay(ms);
        cont.logs.push(`delayLog: ${val} after ${ms}ms`);
        return `${val}-delayed`;
      });

      // seqObj is already defined with updateAndGet, using it instead of seq.runOp
      // The key is that updateAndGet logs, so we can see its execution order.
      const template = `{% do seqObj!.updateAndGet('f1', 'op1_result', 10) %}{{ seqObj!.updateAndGet('f2', 'op2_result', 2) | delayLog(2) }}`;
      const result = await env.renderTemplateString(template, cont);

      // Expected logs:
      // 1. updateAndGet for f1
      // 2. updateAndGet for f2
      // 3. delayLog for result of f2
      expect(cont.logs).to.eql([
        'updateAndGet: f1=op1_result (id: 1)',
        'updateAndGet: f2=op2_result (id: 2)',
        'delayLog: op2_result-2 after 2ms'
      ]);
      expect(result).to.equal('op2_result-2-delayed');
    });

  });

})();
