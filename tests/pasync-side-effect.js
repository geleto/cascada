(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../nunjucks/src/environment').AsyncEnvironment;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
  }

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // Helper function for async rejection tests with expect.js
  async function expectAsyncError(asyncFn, checkFn) {
    let error = null;
    let res = null;
    try {
      res = await asyncFn();
    } catch (e) {
      error = e;
    }

    expect(error).to.be.an(Error); // Check an error was thrown
    expect(res).to.equal(null); // Check no result was returned
    if (checkFn) {
      checkFn(error); // Optional additional checks on the error
    }
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
        await env.renderString(template, cont);
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
        const template = `{{ infoWait(1) }}{% set _dummy = err(5) %}`;
        await expectAsyncError(() => env.renderString(template, cont), err => {
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
        const template = `{% set _dummy = run!('exp1-A', 100) %}`;
        await expectAsyncError(() => env.renderString(template, cont), err => {
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
                    {% do sequencer!.runOp('op1', 100) %}
                    {% do sequencer!.runOp('op2', 50) %}
                `;
          await env.renderString(template, cont);
          expect(callOrder).to.eql(['op1', 'op2']); // Verify sequence
          expect(cont.logs).to.eql(['op1 on seq1', 'op2 on seq1']);
        });

        it('should enforce sequence based on object path across different methods', async () => {
          const template = `
                    {% do sequencer!.runOp('op1', 100) %}
                    {% do sequencer!.runOpOther('op2-other', 50) %}
                    {% do sequencer!.runOp('op3', 20) %}
                `;
          await env.renderString(template, context);
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
                    {% do sequencer!.runOp('op1', 100) %}
                    {% do logAfterDelay('parallel-op', 50) %}
                    {% do sequencer!.runOp('op2', 20) %}
                `;
          await env.renderString(template, cont);
          expect(cont.logs).to.contain('Log: parallel-op');
          expect(cont.logs).to.contain('op1 on seq1');
          expect(cont.logs).to.contain('op2 on seq1');
          expect(cont.logs.indexOf('op1 on seq1')).to.be.lessThan(cont.logs.indexOf('op2 on seq1')); // Sequence preserved
        });

        it('should allow unmarked methods on the same object to run in parallel', async () => {
          const template = `
                    {% do sequencer!.runOp('op1', 100) %}
                    {% do sequencer.getStatus('status1', 50) %}
                    {% do sequencer!.runOp('op2', 20) %}
                `;
          await env.renderString(template, context);
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
                    {% do sequencer!.runOp('seq1-op1', 100) %}
                    {% do sequencer2!.runOp('seq2-op1', 50) %}
                    {% do sequencer!.runOp('seq1-op2', 20) %}
                    {% do sequencer2!.runOp('seq2-op2', 10) %}
                `;
          await env.renderString(template, cont);
          expect(cont.logs).to.contain('seq1-op1 on seq1');
          expect(cont.logs).to.contain('seq1-op2 on seq1');
          expect(cont.logs).to.contain('seq2-op1 on seq2');
          expect(cont.logs).to.contain('seq2-op2 on seq2');
          expect(cont.logs.indexOf('seq1-op1 on seq1')).to.be.lessThan(cont.logs.indexOf('seq1-op2 on seq1')); // Seq1 sequence
          expect(cont.logs.indexOf('seq2-op1 on seq2')).to.be.lessThan(cont.logs.indexOf('seq2-op2 on seq2')); // Seq2 sequence
        });

        it('should handle multiple object path ! operators (same path) within one expression sequentially', async () => {
          const template = `{{ sequencer!.runOp('exp2-A', 100) ~ sequencer!.runOp('exp2-B', 50) }}`;
          const result = await env.renderString(template, context);
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
                    {% do data.nestedSequencer!.runOp('nested1', 100) %}
                    {% do data.nestedSequencer!.runOp('nested2', 50) %}
                `;
          await env.renderString(template, cont);
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
            {% do data.level1.level2.deepSequencer!.runOp('deep1', 100) %}
            {% do data.level1.level2.deepSequencer!.runOpOther('deep2-other', 50) %}
            {% do data.level1.level2.deepSequencer!.runOp('deep3', 20) %}
            {# Method-specific sequencing: #}
            {% do worker.processTask!('taskA', 50) %}
            {% do worker.getStatus() %}
            {% do worker.processTask!('taskB', 20) %}
            {% do worker.resetCounter!() %}
            {% do worker.processTask!('taskC', 10) %}
          `;
          await env.renderString(template, cont);
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
                        {% do sequencer!.runOp('loop' + i, 100 - i*30) %}
                    {% endfor %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['loop1 on seq1', 'loop2 on seq1', 'loop3 on seq1']);
        });

        it('should work with object path ! in {% set %}', async () => {
          const template = `
                    {% set res1 = sequencer!.runOp('set1', 100) %}
                    {% set res2 = sequencer!.runOp('set2', 50) %}
                    Results: {{ res1 }}, {{ res2 }}
                `;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['set1 on seq1', 'set2 on seq1']);
          expect(result.trim()).to.equal('Results: set1, set2');
        });

        it('should work with object path ! in {{ }}', async () => {
          const template = `{{ sequencer!.runOp('out1', 100) }} {{ sequencer!.runOp('out2', 50) }}`;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['out1 on seq1', 'out2 on seq1']);
          expect(result.trim()).to.equal('out1 out2');
        });

        it('should maintain object path sequence mixed across {% do %}, {% set %}, {{ }}', async () => {
          const template = `
                    {%- do sequencer!.runOp('op1', 100) -%}
                    {%- set r1 = sequencer!.runOp('op2', 50) -%}
                    {{ sequencer!.runOp('op3', 20) }}
                    {%- do sequencer!.runOp('op4', 10) -%}
                    {{ r1 }}
                `;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['op1 on seq1', 'op2 on seq1', 'op3 on seq1', 'op4 on seq1']);
          expect(result.trim()).to.equal('op3op2');
        });

        it('should release lock on error in sequenced call', async () => {
          const cont = {
            ...context,
            sequencer: {
              id: 'seq1',
              async runOp(id, ms) {
                if (id === 'op1') throw new Error('Operation failed');
                await delay(ms);
                cont.logs.push(`${id} on ${this.id}`);
                return id;
              }
            }
          };
          const template = `
            {% do sequencer!.runOp('op1', 50) %}
            {% do sequencer!.runOp('op2', 20) %}
          `;
          await expectAsyncError(() => env.renderString(template, cont), err => {
            expect(err.message).to.contain('Error: Operation failed');
          });
          expect(cont.logs).to.eql(['op2 on seq1']); // op2 should run after lock release
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
          const template = `{{ sequencer!.wrapOp(sequencer!.runOp('inner', 50), 100) }}`;
          const result = await env.renderString(template, cont);
          expect(cont.logs).to.eql(['inner on seq1', 'wrapped-inner on seq1']);
          expect(result.trim()).to.equal('wrapped-inner');
        });
      }); // End Object-Path Sequencing tests

      // --- Method-Specific Sequencing: object.path.method!() ---
      describe('2. Method-Specific Sequencing (object.path.method!())', () => {

        it('should enforce sequence for the specific marked method', async () => {
          // Parser does not yet support setting .sequenced on FunCall nodes for method!()
          const template = `
                    {% do sequencer.runOp!('op1', 100) %}
                    {% do sequencer.runOp!('op2', 50) %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['op1 on seq1', 'op2 on seq1']);
        });

        it('should allow different marked methods on the same object to run independently', async () => {
          // Parser does not yet support method!()
          const template = `
                    {% do sequencer.runOp!('opA1', 100) %}
                    {% do sequencer.runOpOther!('opB1', 50) %}
                    {% do sequencer.runOp!('opA2', 20) %}
                    {% do sequencer.runOpOther!('opB2', 10) %}
                `;
          await env.renderString(template, context);
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
                    {% do sequencer.runOp!('op1', 100) %}
                    {% do sequencer.getStatus('status1', 50) %}
                    {% do sequencer.runOp!('op2', 20) %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.contain('Status status1 on seq1');
          expect(context.logs).to.contain('op1 on seq1');
          expect(context.logs).to.contain('op2 on seq1');
          expect(context.logs.indexOf('op1 on seq1')).to.be.lessThan(context.logs.indexOf('op2 on seq1')); // Sequence preserved
        });

        it('should maintain internal sequence for independent method sequences running concurrently', async () => {
          // Parser does not yet support method!()
          const template = `
            {% do sequencer.runOp!('A1', 100) %}
            {% do sequencer.runOpOther!('B1', 50) %}
            {% do sequencer.runOp!('A2', 20) %}
            {% do sequencer.runOpOther!('B2', 10) %}
          `;
          await env.renderString(template, context);
          expect(context.logs).to.contain('A1 on seq1');
          expect(context.logs).to.contain('A2 on seq1');
          expect(context.logs).to.contain('B1 OTHER on seq1');
          expect(context.logs).to.contain('B2 OTHER on seq1');
          expect(context.logs.indexOf('A1 on seq1')).to.be.lessThan(context.logs.indexOf('A2 on seq1')); // runOp sequence
          expect(context.logs.indexOf('B1 OTHER on seq1')).to.be.lessThan(context.logs.indexOf('B2 OTHER on seq1')); // runOpOther sequence
        });

        it('should handle multiple method ! operators (same method) within one expression sequentially', async () => {
          // Parser does not yet support method!()
          const template = `{{ sequencer.runOp!('expA1', 100) ~ sequencer.runOp!('expA2', 50) }}`;
          const result = await env.renderString(template, context);
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
                    {% do data.nestedSequencer.runOp!('nested1', 100) %}
                    {% do data.nestedSequencer.runOp!('nested2', 50) %}
                `;
          await env.renderString(template, cont);
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
                    {% do data.level1.level2.deepSequencer.runOp!('deepA1', 100) %}
                    {% do data.level1.level2.deepSequencer.runOpOther!('deepB1', 50) %}
                    {% do data.level1.level2.deepSequencer.runOp!('deepA2', 20) %}
                `;
          await env.renderString(template, cont);
          expect(cont.logs).to.contain('deepA1 on deepSeq');
          expect(cont.logs).to.contain('deepA2 on deepSeq');
          expect(cont.logs).to.contain('deepB1 OTHER on deepSeq');
          expect(cont.logs.indexOf('deepA1 on deepSeq')).to.be.lessThan(cont.logs.indexOf('deepA2 on deepSeq')); // runOp sequence
        });

        it('should enforce method sequence across loop iterations', async () => {
          // Parser does not yet support method!()
          const template = `
                    {% for i in [1, 2, 3] %}
                        {% do sequencer.runOp!('loop' + i, 100 - i*30) %}
                    {% endfor %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['loop1 on seq1', 'loop2 on seq1', 'loop3 on seq1']);
        });

        it('should work with method ! in {% set %}', async () => {
          // Parser does not yet support method!()
          const template = `
                    {% set res1 = sequencer.runOp!('set1', 100) %}
                    {% set res2 = sequencer.runOp!('set2', 50) %}
                    Results: {{ res1 }}, {{ res2 }}
                `;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['set1 on seq1', 'set2 on seq1']);
          expect(result.trim()).to.equal('Results: set1, set2');
        });

        it('should work with method ! in {{ }}', async () => {
          // Parser does not yet support method!()
          const template = `{{ sequencer.runOp!('out1', 100) }} {{ sequencer.runOp!('out2', 50) }}`;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['out1 on seq1', 'out2 on seq1']);
          expect(result.trim()).to.equal('out1 out2');
        });

        it('should maintain method sequence mixed across {% do %}, {% set %}, {{ }}', async () => {
          // Parser does not yet support method!()
          const template = `
                    {%- do sequencer.runOp!('op1', 100) -%}
                    {%- set r1 = sequencer.runOp!('op2', 50) -%}
                    {{ sequencer.runOp!('op3', 20) }}
                    {%- do sequencer.runOp!('op4', 10) -%}
                    {{ r1 }}
                `;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['op1 on seq1', 'op2 on seq1', 'op3 on seq1', 'op4 on seq1']);
          expect(result.trim()).to.equal('op3op2');
        });

        it('should potentially allow object-path and method-specific sequences to interact predictably', async () => {
          // Parser does not yet support method!()
          const template = `
                    {% do sequencer!.runOp('objPath1', 100) %}
                    {% do sequencer.runOpOther!('methSpec1', 50) %}
                    {% do sequencer!.runOpOther('objPath2', 20) %}
                `;
          await env.renderString(template, context);
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
          const template = `{{ sequencer!.value }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.contain('Sequence marker (!) is not allowed in non-call paths');
          });
        });

        it('should REJECT ! on dynamic path segment (array index)', async () => {
          const template = `{{ items[i]!.runOp('dyn1', 50) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.contain('cannot be used with dynamic key');
          });
        });

        it('should REJECT ! on dynamic path segment (function call)', async () => {
          const template = `{{ getObj()!.runOp('dyn2', 50) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.contain(`The sequence marker '!' cannot be applied directly to a`);
          });
        });

        it('should REJECT ! on dynamic path segment (function call followed by lookup)', async () => {
          const template = `{{ getObj().dynamicKey!.runOp('dyn2', 50) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.contain('Sequence Error');
          });
        });

        it('should REJECT double ! (path!.method!())', async () => {
          const template = `{{ sequencer!.runOp!('double', 50) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.contain('Can not use more than one sequence marker (!) in a path');
          });
        });

      }); // End Constraint tests

      // --- Additional tests for _getSequencedPath and ! marker constraints ---
      describe('4. _getSequencedPath and ! marker constraint edge cases', () => {
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
            items: [{ id: 'item1', async runOp() {} }],
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
            {% do nested.sequencer!.runOp('deep1', 100) %} {# Takes longer #}
            {% do nested.sequencer!.runOp('deep2', 50) %}  {# Takes shorter #}
          `;
          await env.renderString(template, constraintContext);
          expect(constraintContext.logs).to.eql(['deep1 on nested', 'deep2 on nested']);
        });

        it('should reject ! on a dynamic property (object[expr]!.method)', async () => {
          const template = `{{ items[i]!.runOp('fail', 50) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.contain('cannot be used with dynamic keys');
          });
        });

        it('should reject ! on a function call in the path (getObj()!.runOp)', async () => {
          const template = `{{ getObj()!.runOp('fail', 50) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.contain(`The sequence marker '!' cannot be applied directly`);
          });
        });

        it('should reject ! on property access (object.path!.property)', async () => {
          const template = `{{ sequencer!.value }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.contain('Sequence marker (!) is not allowed in non-call paths');
          });
        });

        it('should reject ! on method call with dynamic method name (object.path![dynamicKey]())', async () => {
          const template = `{{ sequencer![dynamicKey]('fail', 50) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.contain('requires the entire path preceding it to consist of static string literal segments');
          });
        });

        it('should reject double ! in the same path (object!.method!())', async () => {
          const template = `{{ sequencer!.runOp!('fail', 50) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.contain('Can not use more than one sequence marker (!) in a path');
          });
        });

        it('should enforce method-specific sequence (object.method!())', async () => {
          // Parser does not yet support method!()
          const template = `
            {% do sequencer.runOp!('meth1', 100) %} {# Takes longer #}
            {% do sequencer.runOp!('meth2', 50) %}  {# Takes shorter #}
          `;
          await env.renderString(template, constraintContext);
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
                  {% do ctxSequencer!.runOp('ctxA', 100) %}
                  {% do ctxSequencer!.runOp('ctxB', 50) %}
                `;
          await env.renderString(template, analysisContext);
          expect(analysisContext.logs).to.eql(['ctxA on ctxSeq', 'ctxB on ctxSeq']);
        });

        it('should REJECT sequencing (run in parallel) for path starting with a template variable {% set %}', async () => {
          const template = `
                  {% set tplSequencer = ctxSequencer %}
                  {% do tplSequencer!.runOp('tplA', 100) %} {# ! should be ignored #}
                  {% do tplSequencer!.runOp('tplB', 50) %}  {# ! should be ignored #}
                `;
          await env.renderString(template, analysisContext);
          expect(analysisContext.logs).to.contain('tplA on ctxSeq');
          expect(analysisContext.logs).to.contain('tplB on ctxSeq');
          expect(analysisContext.logs.indexOf('tplB on ctxSeq')).to.be.lessThan(
            analysisContext.logs.indexOf('tplA on ctxSeq')
          ); // Parallel: shorter delay first
        });

        it('should REJECT sequencing (run in parallel) for path starting with a macro parameter', async () => {
          const template = `
                  {% macro testMacro(mcSequencer) %}
                    {% do mcSequencer!.runOp('mcA', 100) %} {# ! should be ignored #}
                    {% do mcSequencer!.runOp('mcB', 50) %} {# ! should be ignored #}
                  {% endmacro %}
                  {{ testMacro(ctxSequencer) }}
                `;
          await env.renderString(template, analysisContext);
          expect(analysisContext.logs).to.contain('mcA on ctxSeq');
          expect(analysisContext.logs).to.contain('mcB on ctxSeq');
          expect(analysisContext.logs.indexOf('mcB on ctxSeq')).to.be.lessThan(
            analysisContext.logs.indexOf('mcA on ctxSeq')
          ); // Parallel: shorter delay first
        });

        it('should REJECT sequencing (run in parallel) when template var shadows context var', async () => {
          const template = `
                  {% set shadowVar = ctxSequencer %} {# Shadowing context.shadowVar #}
                  {% do shadowVar!.runOp('shA', 100) %} {# ! applies to template var, should be ignored #}
                  {% do shadowVar!.runOp('shB', 50) %} {# ! should be ignored #}
                `;
          await env.renderString(template, analysisContext);
          expect(analysisContext.logs).to.contain('shA on ctxSeq');
          expect(analysisContext.logs).to.contain('shB on ctxSeq');
          expect(analysisContext.logs.indexOf('shB on ctxSeq')).to.be.lessThan(
            analysisContext.logs.indexOf('shA on ctxSeq')
          ); // Parallel: shorter delay first
        });

        it('[Placeholder] should treat object.method!() as needing a method-specific lock key', async () => {
          // Parser does not yet support method!()
          const template = `
                   {% do ctxSequencer.runOp!('mA', 100) %}
                   {% do ctxSequencer.runOp!('mB', 50) %}
                 `;
          await env.renderString(template, analysisContext);
          expect(analysisContext.logs).to.eql(['mA on ctxSeq', 'mB on ctxSeq']);
        });

        it('[Placeholder] should treat path!.method() and path.method!() differently', async () => {
          // Parser does not yet support method!()
          const template = `
                   {% do ctxSequencer!.runOp('pathOp1', 100) %}
                   {% do ctxSequencer.runOp!('methodOp1', 50) %}
                   {% do ctxSequencer!.runOp('pathOp2', 20) %}
                   {% do ctxSequencer.runOp!('methodOp2', 10) %}
                 `;
          await env.renderString(template, analysisContext);
          expect(analysisContext.logs).to.contain('pathOp1 on ctxSeq');
          expect(analysisContext.logs).to.contain('pathOp2 on ctxSeq');
          expect(analysisContext.logs).to.contain('methodOp1 on ctxSeq');
          expect(analysisContext.logs).to.contain('methodOp2 on ctxSeq');
          expect(analysisContext.logs.indexOf('pathOp1 on ctxSeq')).to.be.lessThan(analysisContext.logs.indexOf('pathOp2 on ctxSeq')); // Path sequence
          expect(analysisContext.logs.indexOf('methodOp1 on ctxSeq')).to.be.lessThan(analysisContext.logs.indexOf('methodOp2 on ctxSeq')); // Method sequence
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
          async runOp(id, ms) { await delay(ms); context.logs.push(id); return id; }
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
        await expectAsyncError(() => env.renderString(template, context));
      });

      //@todo - line numbering
      it.skip('should provide detailed error message for invalid ! usage', async () => {
        const template = `Line 1\n{% do sequencer!.value %}`;
        await expectAsyncError(() => env.renderString(template, context), err => {
          expect(err.message).to.contain('Line 2');
          expect(err.message).to.contain('side effects');
        });
      });
    });

    describe('Concurrency and Performance', () => {
      it('should handle multiple concurrent sequences without interference', async () => {
        const cont = {
          logs: [],
        };
        const numSequences = 5;
        const delayMs = 50; // Use a slightly longer delay to observe concurrency better

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

        // Render the template - renderString completes after all async ops triggered by 'do' finish
        await env.renderString(template, cont);

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
      it('should enforce sequence across macro calls', async () => {
        const cont = { logs: [], seq: { id: 's1', async runOp(id, ms) { await delay(ms); cont.logs.push(id); } } };
        const template = `
          {% macro runSeq(id, ms) %}{% do seq!.runOp(id, ms) %}{% endmacro %}
          {{ runSeq('m1', 20) }}{{ runSeq('m2', 10) }}
        `;
        await env.renderString(template, cont);
        expect(cont.logs).to.eql(['m1', 'm2']);
      });

      it('should work with async filters', async () => {
        env.addFilter('delayLog', async (val, ms) => { await delay(ms); return `${val}-delayed`; }, true);
        const cont = { logs: [], seq: { id: 's1', async runOp(id, ms) { await delay(ms); cont.logs.push(id); } } };
        const template = `{% do seq!.runOp('f1', 20) %}{{ seq!.runOp('f2', 10)|delayLog(5) }}`;
        const result = await env.renderString(template, cont);
        expect(cont.logs).to.eql(['f1', 'f2']);
        expect(result).to.equal('f2-delayed');
      });

      it('should reject sequencing when shadowed in a loop', async () => {
        const cont = { logs: [], seq: { id: 's1', async runOp(id, ms) { await delay(ms); cont.logs.push(id); } } };
        const template = `
          {% for seq in [seq] %}
            {% set seq = seq %}
            {% do seq!.runOp('l1', 20) %}
            {% do seq!.runOp('l2', 5) %}
          {% endfor %}
        `;
        await env.renderString(template, cont);
        expect(cont.logs).to.eql(['l2', 'l1']);
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
          () => env.renderString(template, cont),
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
          () => env.renderString(template, cont),
          err => {
            expect(err.message).to.match(
              /Sequence marker '!' can only be used on paths starting directly from a context variable.*not a template variable/i
            );
          }
        );
      });

      it('should handle spaced syntax for !', async () => {
        const cont = { logs: [], seq: { id: 's1', async runOp(id, ms) { await delay(ms); cont.logs.push(id); } } };
        const template = `{% do seq ! . runOp('s1', 20) %}{% do seq ! .runOp('s2', 10) %}`;
        await env.renderString(template, cont);
        expect(cont.logs).to.eql(['s1', 's2']);
      });
    });
  });
  //End additional side effect tests
})();
