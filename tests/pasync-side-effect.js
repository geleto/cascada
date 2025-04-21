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
    try {
      await asyncFn();
    } catch (e) {
      error = e;
    }
    expect(error).to.be.an(Error); // Check an error was thrown
    if (checkFn) {
      checkFn(error); // Optional additional checks on the error
    }
  }


  describe('Side effects', () => {
    let env; // Env is used everywhere

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    // --- Original Test ---
    describe('Side effects - variables (Original Test)', () => {
      it('Should not wait resolution for unused variable inside loop', async () => {
        const cont = {
          items: ['a', 'b'],
          logs: [],
          async log(item) {
            await delay(10);
            cont.logs.push(`Logged ${item}`);
            return true;
          }
        };
        const template = `{%- for item in items %}{% set _logged = log(item) %}{%- endfor -%}`;
        await env.renderString(template, cont);
        expect(cont.logs).to.eql([]);
      });
    }); // End Side effects - variables

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
          const template = `
                    {% do sequencer!.runOp('op1', 20) %}
                    {% do sequencer!.runOp('op2', 10) %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['op1 on seq1', 'op2 on seq1']);
        });

        it('should enforce sequence based on object path across different methods', async () => {
          const template = `
                    {% do sequencer!.runOp('op1', 20) %}
                    {% do sequencer!.runOpOther('op2-other', 5) %}
                    {% do sequencer!.runOp('op3', 10) %}
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
                    {% do sequencer!.runOp('op1', 30) %}
                    {% do logAfterDelay('parallel-op', 10) %}
                    {% do sequencer!.runOp('op2', 10) %}
                `;
          await env.renderString(template, cont);
          expect(cont.logs).to.eql(['Log: parallel-op', 'op1 on seq1', 'op2 on seq1']);
        });

        it('should allow unmarked methods on the same object to run in parallel', async () => {
          const template = `
                    {% do sequencer!.runOp('op1', 30) %}
                    {% do sequencer.getStatus('status1', 10) %}
                    {% do sequencer!.runOp('op2', 10) %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['Status status1 on seq1', 'op1 on seq1', 'op2 on seq1']);
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
                    {% do sequencer!.runOp('seq1-op1', 30) %}
                    {% do sequencer2!.runOp('seq2-op1', 10) %}
                    {% do sequencer!.runOp('seq1-op2', 10) %}
                    {% do sequencer2!.runOp('seq2-op2', 5) %}
                `;
          await env.renderString(template, cont);
          expect(cont.logs).to.eql([
            'seq2-op1 on seq2', 'seq2-op2 on seq2',
            'seq1-op1 on seq1', 'seq1-op2 on seq1'
          ]);
        });


        it('should handle multiple object path ! operators (same path) within one expression sequentially', async () => {
          const template = `{{ sequencer!.runOp('exp2-A', 20) ~ sequencer!.runOp('exp2-B', 10) }}`;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['exp2-A on seq1', 'exp2-B on seq1']);
          expect(result).to.equal('exp2-Aexp2-B');
        });

        it('should handle multiple object path ! operators (same object) within one expression sequentially (side-effect enforced)', async () => {
          let op1Done = false;
          const cont = {
            ...context,
            sequencer: {
              id: 'seq1',
              async runOp(id, ms) {
                if (id === 'exp1-A') {
                  await delay(ms);
                  cont.logs.push(`${id} on ${this.id}`);
                  op1Done = true;
                  return id;
                } else if (id === 'exp1-B') {
                  if (!op1Done) throw new Error('exp1-B started before exp1-A finished');
                  await delay(ms);
                  cont.logs.push(`${id} on ${this.id}`);
                  return id;
                }
              }
            }
          };
          const template = `{{ sequencer!.runOp('exp1-A', 30) ~ sequencer!.runOp('exp1-B', 10) }}`;
          const result = await env.renderString(template, cont);
          expect(cont.logs).to.eql(['exp1-A on seq1', 'exp1-B on seq1']);
          expect(result).to.equal('exp1-Aexp1-B');
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
                    {% do data.nestedSequencer!.runOp('nested1', 20) %}
                    {% do data.nestedSequencer!.runOp('nested2', 10) %}
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
            {% do data.level1.level2.deepSequencer!.runOp('deep1', 25) %}
            {% do data.level1.level2.deepSequencer!.runOpOther('deep2-other', 10) %}
            {% do data.level1.level2.deepSequencer!.runOp('deep3', 5) %}
            {# Method-specific sequencing: #}
            {% do worker.processTask!('taskA', 15) %}
            {% do worker.getStatus() %}
            {% do worker.processTask!('taskB', 5) %}
            {% do worker.resetCounter!() %}
            {% do worker.processTask!('taskC', 1) %}
          `;
          await env.renderString(template, cont);
          expect(cont.logs).to.eql([
            'deep1 on deepSeq',
            'deep2-other OTHER on deepSeq',
            'deep3 on deepSeq',
            'taskA processed by worker1',
            'status checked by worker1',
            'taskB processed by worker1',
            'counter reset by worker1',
            'taskC processed by worker1'
          ]);
        });

        it('should enforce object path sequence across loop iterations', async () => {
          const template = `
                    {% for i in [1, 2, 3] %}
                        {% do sequencer!.runOp('loop' + i, 30 - i*10) %}
                    {% endfor %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['loop1 on seq1', 'loop2 on seq1', 'loop3 on seq1']);
        });

        it('should work with object path ! in {% set %}', async () => {
          const template = `
                    {% set res1 = sequencer!.runOp('set1', 20) %}
                    {% set res2 = sequencer!.runOp('set2', 10) %}
                    Results: {{ res1 }}, {{ res2 }}
                `;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['set1 on seq1', 'set2 on seq1']);
          expect(result.trim()).to.equal('Results: set1, set2');
        });

        it('should work with object path ! in {{ }}', async () => {
          const template = `{{ sequencer!.runOp('out1', 20) }} {{ sequencer!.runOp('out2', 10) }}`;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['out1 on seq1', 'out2 on seq1']);
          expect(result.trim()).to.equal('out1 out2');
        });

        it('should maintain object path sequence mixed across {% do %}, {% set %}, {{ }}', async () => {
          const template = `
                    {% do sequencer!.runOp('op1', 30) %}
                    {% set r1 = sequencer!.runOp('op2', 10) %}
                    {{ sequencer!.runOp('op3', 5) }}
                    {% do sequencer!.runOp('op4', 15) %}
                    {{ r1 }}
                `;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['op1 on seq1', 'op2 on seq1', 'op3 on seq1', 'op4 on seq1']);
          expect(result).to.contain('op3');
          expect(result).to.contain('op2');
        });
      }); // End Object-Path Sequencing tests

      // --- Method-Specific Sequencing: object.path.method!() ---
      describe('2. Method-Specific Sequencing (object.path.method!())', () => {

        it('should enforce sequence for the specific marked method', async () => {
          const template = `
                    {% do sequencer.runOp!('op1', 20) %}
                    {% do sequencer.runOp!('op2', 10) %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['op1 on seq1', 'op2 on seq1']);
        });

        it('should allow different marked methods on the same object to run independently', async () => {
          const template = `
                    {% do sequencer.runOp!('opA1', 30) %}
                    {% do sequencer.runOpOther!('opB1', 10) %}
                    {% do sequencer.runOp!('opA2', 10) %}
                    {% do sequencer.runOpOther!('opB2', 5) %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql([
            'opB1 OTHER on seq1', 'opB2 OTHER on seq1',
            'opA1 on seq1', 'opA2 on seq1'
          ]);
        });

        it('should allow unmarked methods to run in parallel with method sequences', async () => {
          const template = `
                    {% do sequencer.runOp!('op1', 30) %}
                    {% do sequencer.getStatus('status1', 10) %}
                    {% do sequencer.runOp!('op2', 10) %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['Status status1 on seq1', 'op1 on seq1', 'op2 on seq1']);
        });

        it('should maintain internal sequence for independent method sequences running concurrently', async () => {
          // Tests that runOp! sequence (A1->A2) and runOpOther! sequence (B1->B2)
          // are maintained internally, even though the sequences run parallel to each other.
          const template = `
            {% do sequencer.runOp!('A1', 40) %}         {# Starts 1st in runOp! seq, takes 40ms #}
            {% do sequencer.runOpOther!('B1', 10) %}  {# Starts 1st in runOpOther! seq, takes 10ms #}
            {% do sequencer.runOp!('A2', 5) %}          {# Starts 2nd in runOp! seq, takes 5ms #}
            {% do sequencer.runOpOther!('B2', 20) %}  {# Starts 2nd in runOpOther! seq, takes 20ms #}
          `;
          await env.renderString(template, context);
          // Expected order IF IMPLEMENTED: B1->B2 and A1->A2, with B finishing before A
          // Correct assertion verifies both sequences completed correctly internally.
          // The exact interleaving isn't strictly asserted, only the final relative order within each sequence.
          // This order assumes B finishes before A starts A2, adjust if needed based on precise scheduler behavior.
          // But crucially, A1 must precede A2, and B1 must precede B2 in the logs.
          expect(context.logs).to.eql([
            'B1 OTHER on seq1', // B seq starts (10ms)
            'B2 OTHER on seq1', // B seq continues (20ms)
            'A1 on seq1',       // A seq starts (40ms)
            'A2 on seq1'        // A seq continues (5ms)
          ]);
          // WITHOUT implementation (parallel): Actual order likely A2(5), B1(10), B2(20), A1(40) -> fails correctly.
        });

        it('should handle multiple method ! operators (same method) within one expression sequentially', async () => {
          const template = `{{ sequencer.runOp!('expA1', 20) ~ sequencer.runOp!('expA2', 10) }}`;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['expA1 on seq1', 'expA2 on seq1']);
          expect(result).to.equal('expA1expA2');
        });

        it('should work with nested static path method sequencing', async () => {
          const cont = {
            ...context,
            data: { nestedSequencer: { id: 'nested', async runOp(id, ms) { await delay(ms); cont.logs.push(`${id} on ${this.id}`); return id; } } }
          };
          const template = `
                    {% do data.nestedSequencer.runOp!('nested1', 20) %}
                    {% do data.nestedSequencer.runOp!('nested2', 10) %}
                `;
          await env.renderString(template, cont);
          expect(cont.logs).to.eql(['nested1 on nested', 'nested2 on nested']);
        });

        it('should work with deeply nested static path method sequencing', async () => {
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
                    {% do data.level1.level2.deepSequencer.runOp!('deepA1', 30) %}
                    {% do data.level1.level2.deepSequencer.runOpOther!('deepB1', 10) %}
                    {% do data.level1.level2.deepSequencer.runOp!('deepA2', 5) %}
                `;
          await env.renderString(template, cont);
          expect(cont.logs).to.eql([
            'deepB1 OTHER on deepSeq',
            'deepA1 on deepSeq',
            'deepA2 on deepSeq'
          ]);
        });

        it('should enforce method sequence across loop iterations', async () => {
          const template = `
                    {% for i in [1, 2, 3] %}
                        {% do sequencer.runOp!('loop' + i, 30 - i*10) %}
                    {% endfor %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['loop1 on seq1', 'loop2 on seq1', 'loop3 on seq1']);
        });

        it('should work with method ! in {% set %}', async () => {
          const template = `
                    {% set res1 = sequencer.runOp!('set1', 20) %}
                    {% set res2 = sequencer.runOp!('set2', 10) %}
                    Results: {{ res1 }}, {{ res2 }}
                `;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['set1 on seq1', 'set2 on seq1']);
          expect(result.trim()).to.equal('Results: set1, set2');
        });

        it('should work with method ! in {{ }}', async () => {
          const template = `{{ sequencer.runOp!('out1', 20) }} {{ sequencer.runOp!('out2', 10) }}`;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['out1 on seq1', 'out2 on seq1']);
          expect(result.trim()).to.equal('out1 out2');
        });

        it('should maintain method sequence mixed across {% do %}, {% set %}, {{ }}', async () => {
          const template = `
                    {% do sequencer.runOp!('op1', 30) %}
                    {% set r1 = sequencer.runOp!('op2', 10) %}
                    {{ sequencer.runOp!('op3', 5) }}
                    {% do sequencer.runOp!('op4', 15) %}
                    {{ r1 }}
                `;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['op1 on seq1', 'op2 on seq1', 'op3 on seq1', 'op4 on seq1']);
          expect(result).to.contain('op3');
          expect(result).to.contain('op2');
        });

        it('should potentially allow object-path and method-specific sequences to interact predictably (verify impl.)', async () => {
          const template = `
                    {% do sequencer!.runOp('objPath1', 30) %}
                    {% do sequencer.runOpOther!('methSpec1', 10) %}
                    {% do sequencer!.runOpOther('objPath2', 5) %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql([
            'methSpec1 OTHER on seq1',
            'objPath1 on seq1',
            'objPath2 OTHER on seq1'
          ]);
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
          await expectAsyncError(() => env.renderString(template, constraintContext));
        });

        it('should REJECT !() on property access (object.path.property!)', async () => {
          const template = `{{ sequencer.value!() }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext));
        });

        it('should REJECT ! on dynamic path segment (array index)', async () => {
          const template = `{{ items[i]!.runOp('dyn1', 10) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext));
        });

        it('should REJECT ! on dynamic path segment (function call)', async () => {
          const template = `{{ getObj()!.runOp('dyn2', 10) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext));
        });

        it('should REJECT double ! (path!.method!())', async () => {
          const template = `{{ sequencer!.runOp!('double', 10) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext));
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
            {% do nested.sequencer!.runOp('deep1', 25) %} {# Takes longer #}
            {% do nested.sequencer!.runOp('deep2', 5) %}  {# Takes shorter #}
          `;
          await env.renderString(template, constraintContext);
          // Expected sequence: deep1, then deep2
          expect(constraintContext.logs).to.eql(['deep1 on nested', 'deep2 on nested']);
          // WITHOUT implementation (parallel): Actual order likely deep2, deep1 -> fails correctly.
        });

        it('should reject ! on a dynamic property (object[expr]!.method)', async () => {
          const template = `{{ items[i]!.runOp('fail', 1) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.match(/static/);
          });
        });

        it('should reject ! on a function call in the path (getObj()!.runOp)', async () => {
          const template = `{{ getObj()!.runOp('fail', 1) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.match(/static/);
          });
        });

        it('should reject ! on property access (object.path!.property)', async () => {
          const template = `{{ sequencer!.value }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.match(/side effects/);
          });
        });

        it('should reject ! on method call with dynamic method name (object.path![dynamicKey]())', async () => {
          const template = `{{ sequencer![dynamicKey]('fail', 1) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.match(/static/);
          });
        });

        it('should reject double ! in the same path (object!.method!())', async () => {
          const template = `{{ sequencer!.runOp!('fail', 1) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.match(/double/);
          });
        });

        it('should enforce method-specific sequence (object.method!())', async () => {
          const template = `
            {% do sequencer.runOp!('meth1', 25) %} {# Takes longer #}
            {% do sequencer.runOp!('meth2', 5) %}  {# Takes shorter #}
          `;
          await env.renderString(template, constraintContext);
          // Expected sequence: meth1, then meth2
          expect(constraintContext.logs).to.eql(['meth1 on seq1', 'meth2 on seq1']);
          // WITHOUT implementation (parallel): Actual order likely meth2, meth1 -> fails correctly.
        });

        it('should reject ! on a literal (123!.runOp)', async () => {
          const template = `{{ 123!.runOp('fail', 1) }}`;
          await expectAsyncError(() => env.renderString(template, constraintContext), err => {
            expect(err.message).to.match(/static/);
          });
        });
      });

    }); // End Side effects - ! feature

  }); // End Side effects
})();
