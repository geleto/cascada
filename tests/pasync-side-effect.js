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

  describe('Side effects', () => {
    let env;
    let context; // Define context at a higher scope for beforeEach reuse

    beforeEach(() => {
      env = new AsyncEnvironment();
      // Common context setup for side effect tests
      context = {
        logs: [],
        items: ['a', 'b'], // For dynamic path tests (expected to fail)
        i: 0, // For dynamic path tests (expected to fail)
        getObj: () => context.sequencer, // For dynamic path tests (expected to fail)

        // Helper async function to log after a delay (unsequenced)
        async logAfterDelay(id, ms) {
          await delay(ms);
          context.logs.push(`Log: ${id}`);
          return `Logged ${id}`;
        },

        // Object to test sequencing on
        sequencer: {
          id: 'seq1',
          value: 'initial', // Property for testing property access constraint

          // Sequenced method 1
          async runOp(id, ms) {
            await delay(ms);
            const logMsg = `${id} on ${this.id}`;
            context.logs.push(logMsg);
            return id; // Return the ID string
          },

          // Sequenced method 2 (on the same object)
          async runOpOther(id, ms) {
            await delay(ms);
            const logMsg = `${id} OTHER on ${this.id}`;
            context.logs.push(logMsg);
            return id; // Return the ID string
          },

          // Unsequenced method example
          async getStatus(id, ms) {
            await delay(ms);
            const logMsg = `Status ${id} on ${this.id}`;
            context.logs.push(logMsg);
            return `Status ${id}`;
          }
        },

        // Another object for testing independent sequences
        sequencer2: {
          id: 'seq2',
          async runOp(id, ms) {
            await delay(ms);
            const logMsg = `${id} on ${this.id}`;
            context.logs.push(logMsg);
            return id; // Return the ID string
          }
        },

        // Nested object
        data: {
          nestedSequencer: {
            id: 'nested',
            async runOp(id, ms) {
              await delay(ms);
              const logMsg = `${id} on ${this.id}`;
              context.logs.push(logMsg);
              return id; // Return the ID string
            }
          }
        }
      };
    });

    describe('Side effects - variables (Original Test)', () => {
      it('Should not wait resolution for unused variable inside loop', async () => {
        context.log = async function (item) { // Specific override for this test
          await delay(10);
          context.logs.push(`Logged ${item}`);
          return true;
        };
        const template = `{%- for item in items %}{% set _logged = log(item) %}{%- endfor -%}`;
        await env.renderString(template, context);
        // Original expectation: side effect doesn't run if variable _logged is unused.
        expect(context.logs).to.eql([]);
      });
    }); // End Side effects - variables

    describe('Side effects - Controlling sequential execution with !', () => {

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
                    {% do sequencer!.runOpOther('op2-other', 5) %} {# Same path 'sequencer!', different method #}
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
          const template = `
                    {% do sequencer!.runOp('op1', 30) %}
                    {% do logAfterDelay('parallel-op', 10) %} {# Unmarked, runs concurrently #}
                    {% do sequencer!.runOp('op2', 10) %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['Log: parallel-op', 'op1 on seq1', 'op2 on seq1']);
        });

        it('should allow unmarked methods on the same object to run in parallel', async () => {
          const template = `
                    {% do sequencer!.runOp('op1', 30) %}
                    {% do sequencer.getStatus('status1', 10) %} {# Unmarked method #}
                    {% do sequencer!.runOp('op2', 10) %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['Status status1 on seq1', 'op1 on seq1', 'op2 on seq1']);
        });

        it('should allow sequences on different object paths to run in parallel', async () => {
          const template = `
                    {% do sequencer!.runOp('seq1-op1', 30) %}
                    {% do sequencer2!.runOp('seq2-op1', 10) %} {# Different path !, runs concurrently #}
                    {% do sequencer!.runOp('seq1-op2', 10) %}
                    {% do sequencer2!.runOp('seq2-op2', 5) %} {# Different path !, depends only on seq2-op1 #}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql([
            'seq2-op1 on seq2', 'seq2-op2 on seq2', // seq2 finishes first
            'seq1-op1 on seq1', 'seq1-op2 on seq1'  // seq1 finishes second
          ]);
        });

        it('should handle multiple object path ! operators (different paths) within one expression in parallel', async () => {
          const template = `{{ sequencer!.runOp('exp1-A', 30) ~ sequencer2!.runOp('exp1-B', 10) }}`;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['exp1-B on seq2', 'exp1-A on seq1']);
          expect(result).to.equal('exp1-Aexp1-B');
        });

        it('should handle multiple object path ! operators (same path) within one expression sequentially', async () => {
          const template = `{{ sequencer!.runOp('exp2-A', 20) ~ sequencer!.runOp('exp2-B', 10) }}`;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['exp2-A on seq1', 'exp2-B on seq1']);
          expect(result).to.equal('exp2-Aexp2-B');
        });

        it('should work with nested static object paths', async () => {
          const template = `
                    {% do data.nestedSequencer!.runOp('nested1', 20) %}
                    {% do data.nestedSequencer!.runOp('nested2', 10) %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['nested1 on nested', 'nested2 on nested']);
        });

        it('should enforce object path sequence across loop iterations', async () => {
          const template = `
                    {% for i in [1, 2, 3] %}
                        {% do sequencer!.runOp('loop' + i, 30 - i*10) %} {# Delays: 20, 10, 0 #}
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

        // Key test: Method independence
        it('should allow different marked methods on the same object to run independently', async () => {
          const template = `
                    {% do sequencer.runOp!('opA1', 30) %}          {# Starts opA sequence #}
                    {% do sequencer.runOpOther!('opB1', 10) %}     {# Starts opB sequence, runs parallel to opA #}
                    {% do sequencer.runOp!('opA2', 10) %}          {# Waits for opA1 #}
                    {% do sequencer.runOpOther!('opB2', 5) %}      {# Waits for opB1 #}
                `;
          await env.renderString(template, context);
          // t=0: opA1(30ms) starts, opB1(10ms) starts
          // t=10: opB1 finishes, logs 'opB1 OTHER'. opB2(5ms) starts.
          // t=15: opB2 finishes, logs 'opB2 OTHER'.
          // t=30: opA1 finishes, logs 'opA1'. opA2(10ms) starts.
          // t=40: opA2 finishes, logs 'opA2'.
          expect(context.logs).to.eql([
            'opB1 OTHER on seq1', 'opB2 OTHER on seq1', // opB sequence finishes first
            'opA1 on seq1', 'opA2 on seq1'             // opA sequence finishes second
          ]);
        });

        it('should allow unmarked methods to run in parallel with method sequences', async () => {
          const template = `
                    {% do sequencer.runOp!('op1', 30) %}
                    {% do sequencer.getStatus('status1', 10) %} {# Unmarked method #}
                    {% do sequencer.runOp!('op2', 10) %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['Status status1 on seq1', 'op1 on seq1', 'op2 on seq1']);
        });

        it('should handle multiple method ! operators (different methods) within one expression in parallel', async () => {
          const template = `{{ sequencer.runOp!('expA1', 30) ~ sequencer.runOpOther!('expB1', 10) }}`;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['expB1 OTHER on seq1', 'expA1 on seq1']);
          expect(result).to.equal('expA1expB1');
        });

        it('should handle multiple method ! operators (same method) within one expression sequentially', async () => {
          const template = `{{ sequencer.runOp!('expA1', 20) ~ sequencer.runOp!('expA2', 10) }}`;
          const result = await env.renderString(template, context);
          expect(context.logs).to.eql(['expA1 on seq1', 'expA2 on seq1']);
          expect(result).to.equal('expA1expA2');
        });

        it('should work with nested static path method sequencing', async () => {
          const template = `
                    {% do data.nestedSequencer.runOp!('nested1', 20) %}
                    {% do data.nestedSequencer.runOp!('nested2', 10) %}
                `;
          await env.renderString(template, context);
          expect(context.logs).to.eql(['nested1 on nested', 'nested2 on nested']);
        });

        it('should enforce method sequence across loop iterations', async () => {
          const template = `
                    {% for i in [1, 2, 3] %}
                        {% do sequencer.runOp!('loop' + i, 30 - i*10) %} {# Delays: 20, 10, 0 #}
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

        // Interaction between Object-Path and Method-Specific (Hypothetical - behavior might depend on implementation details)
        it('should potentially allow object-path and method-specific sequences to interact predictably (verify impl.)', async () => {
          const template = `
                    {% do sequencer!.runOp('objPath1', 30) %}       {# Locks sequencer! path #}
                    {% do sequencer.runOpOther!('methSpec1', 10) %} {# Different sequence lock #}
                    {% do sequencer!.runOpOther('objPath2', 5) %}   {# Waits for objPath1 #}
                `;
          // Expected: methSpec1 might finish first (t=10). objPath1 finishes (t=30), logs objPath1. objPath2 starts, finishes (t=35), logs objPath2.
          // Parallel execution between the two lock types is expected.
          await env.renderString(template, context);
          expect(context.logs).to.eql([
            'methSpec1 OTHER on seq1', // Method-specific runs independently
            'objPath1 on seq1',        // Object-path sequence
            'objPath2 OTHER on seq1'   // Waits for previous object-path op
          ]);
        });

      }); // End Method-Specific Sequencing tests


      // --- Constraint Tests ---
      describe('3. Constraints', () => {

        it('should REJECT ! on property access (object.path!.property)', async () => {
          const template = `{{ sequencer!.value }}`;
          let errorCaught = false;
          try {
            await env.renderString(template, context);
          } catch (err) {
            errorCaught = true;
            expect(err).to.be.an(Error);
          }
          expect(errorCaught).to.be(true);
        });

        it('should REJECT !() on property access (object.path.property!)', async () => {
          const template = `{{ sequencer.value!() }}`;
          let errorCaught = false;
          try {
            await env.renderString(template, context);
          } catch (err) {
            errorCaught = true;
            expect(err).to.be.an(Error);
          }
          expect(errorCaught).to.be(true);
        });

        it('should REJECT ! on dynamic path segment (array index)', async () => {
          const template = `{% set myItems = [sequencer] %}{{ myItems[0]!.runOp('dyn1', 10) }}`;
          let errorCaught = false;
          try {
            await env.renderString(template, context);
          } catch (err) {
            errorCaught = true;
            expect(err).to.be.an(Error);
          }
          expect(errorCaught).to.be(true);
        });

        it('should REJECT ! on dynamic path segment (function call)', async () => {
          const template = `{{ getObj()!.runOp('dyn2', 10) }}`;
          let errorCaught = false;
          try {
            await env.renderString(template, context);
          } catch (err) {
            errorCaught = true;
            expect(err).to.be.an(Error);
          }
          expect(errorCaught).to.be(true);
        });

        // Note: Testing method!(dynamic) might be harder depending on parser implementation
        // it('should REJECT dynamic method name in method!', async () => {
        //    const methodVar = 'runOp';
        //    const template = `{{ sequencer[methodVar]!('dyn3', 10) }}`; // This syntax itself might be invalid nunjucks
        //    await expect(env.renderString(template, { ...context, methodVar })).to.be.rejectedWith(Error);
        // });

        it('should REJECT double ! (path!.method!())', async () => {
          const template = `{{ sequencer!.runOp!('double', 10) }}`;
          let errorCaught = false;
          try {
            await env.renderString(template, context);
          } catch (err) {
            errorCaught = true;
            expect(err).to.be.an(Error);
          }
          expect(errorCaught).to.be(true);
        });

      }); // End Constraint tests

    }); // End Side effects - ! feature

  }); // End Side effects
})();
