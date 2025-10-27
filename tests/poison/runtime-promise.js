/**
 * Integration Tests for RuntimePromise Issues
 *
 * These tests demonstrate the 5 places where RuntimePromise wrappers are needed.
 * Without the fixes, these tests will either:
 * - Fail with poor error messages (no line/column/file info)
 * - Pass but not verify proper error context
 *
 * With the fixes, all tests should pass with full error context.
 */

(function () {
  'use strict';

  var expect;
  let AsyncEnvironment;
  let isPoisonError;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment').AsyncEnvironment;
    isPoisonError = require('../../src/runtime/runtime').isPoisonError;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    isPoisonError = nunjucks.runtime.isPoisonError;
  }


  describe('RuntimePromise Integration Tests', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    // ============================================================================
    // TEST GROUP 1: Function Calls (_callWrapAsyncComplex)
    // ============================================================================

    describe('Issue #1: Function calls returning promises (_callWrapAsyncComplex)', () => {

      it('should preserve context when user function returns rejecting promise', async () => {
        // User function returns a promise that rejects asynchronously
        env.addGlobal('delayedReject', () => {
          return new Promise((resolve, reject) => {
            // Simulate async operation (API call, file read, etc.)
            setTimeout(() => {
              reject(new Error('Delayed async error'));
            }, 10);
          });
        });

        const template = `
        {% set result = delayedReject() %}
        {{ result }}
      `;

        try {
          await env.renderTemplateString(template, {});
          expect().fail('Should have thrown PoisonError');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Delayed async error');

          // CRITICAL: These assertions will FAIL without RuntimePromise fix
          expect(err.errors[0].lineno).to.equal(2); // Line with delayedReject()
          expect(err.errors[0].colno).to.be.greaterThan(0);
          // Without fix: lineno/colno will be undefined or incorrect
        }
      });

      it('should preserve context for async function in if condition', async () => {
        env.addGlobal('asyncCheck', () => {
          return Promise.reject(new Error('Check failed'));
        });

        const template = `
        {% if asyncCheck() %}
          <p>Success</p>
        {% endif %}
      `;

        try {
          await env.renderTemplateString(template);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Check failed');
          expect(err.errors[0].lineno).to.equal(2); // Line with asyncCheck()
        }
      });

      it('should preserve context when function returns promise in script', async () => {
        env.addGlobal('fetchData', () => {
          return new Promise((resolve, reject) => {
            setTimeout(() => reject(new Error('Fetch failed')), 5);
          });
        });

        const script = `
        var data = fetchData()
        @data.result = data
      `;

        try {
          await env.renderScriptString(script, {}, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Fetch failed');
          expect(err.errors[0].lineno).to.equal(2); // Line with fetchData()
        }
      });

      it('should preserve context for chained function calls', async () => {
        env.addGlobal('getUser', () => {
          return {
            getProfile: () => {
              return Promise.reject(new Error('Profile load failed'));
            }
          };
        });

        const template = `
        {% set result = getUser().getProfile() %}
        {{ result }}
      `;

        try {
          await env.renderTemplateString(template);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Profile load failed');
          expect(err.errors[0].lineno).to.equal(2); // Line with getUser().getProfile()
        }
      });

      it('should preserve context when macro returns rejecting promise', async () => {
        const template = `
        {% macro asyncMacro() %}
          {{ helperFunc() }}
        {% endmacro %}

        {{ asyncMacro() }}
      `;

        env.addGlobal('helperFunc', () => {
          return Promise.reject(new Error('Helper failed'));
        });

        try {
          await env.renderTemplateString(template);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Helper failed');
        }
      });
    });

    // ============================================================================
    // TEST GROUP 2: Property Access - Template Mode (_memberLookupAsyncComplex)
    // ============================================================================

    describe('Issue #2: Property access in templates (_memberLookupAsyncComplex)', () => {

      it('should preserve context when property is a rejecting promise', async () => {
        const context = {
          user: {
            // Property itself is a promise
            profile: Promise.reject(new Error('Profile promise rejected'))
          }
        };

        const template = `
        {% set result = user.profile %}
        {{ result }}
      `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Profile promise rejected');

          // CRITICAL: Without RuntimePromise fix, these will fail
          expect(err.errors[0].lineno).to.equal(2); // Line with user.profile
          expect(err.errors[0].colno).to.be.greaterThan(0);
        }
      });

      it('should preserve context when getter returns rejecting promise', async () => {
        class User {
          constructor(name) {
            this.name = name;
          }

          // Getter returns a promise that rejects
          get asyncProfile() {
            return new Promise((resolve, reject) => {
              setTimeout(() => {
                reject(new Error('Async profile getter failed'));
              }, 10);
            });
          }
        }

        const context = {
          user: new User('Alice')
        };

        const template = `
        {% set result = user.asyncProfile %}
        {{ result }}
      `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Async profile getter failed');
          expect(err.errors[0].lineno).to.equal(2); // Line with user.asyncProfile
        }
      });

      it('should preserve context for nested property access', async () => {
        const context = {
          data: {
            user: {
              // Deep property is a promise
              settings: Promise.reject(new Error('Settings failed'))
            }
          }
        };

        const template = `
        {% set result = data.user.settings %}
        {{ result }}
      `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Settings failed');
          expect(err.errors[0].lineno).to.equal(2); // Line with data.user.settings
        }
      });

      it('should preserve context in if condition with property access', async () => {
        const context = {
          user: {
            isAdmin: Promise.reject(new Error('Permission check failed'))
          }
        };

        const template = `
        {% if user.isAdmin %}
          <p>Admin panel</p>
        {% endif %}
      `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Permission check failed');
          expect(err.errors[0].lineno).to.equal(2); // Line with user.isAdmin
        }
      });

      it('should preserve context when property in loop iterator fails', async () => {
        const context = {
          data: {
            // Property is a promise that will be used as iterator
            items: Promise.reject(new Error('Items load failed'))
          }
        };

        const template = `
        {% for item in data.items %}
          {{ item }}
        {% endfor %}
      `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Items load failed');
          expect(err.errors[0].lineno).to.equal(2); // Line with data.items
        }
      });
    });

    // ============================================================================
    // TEST GROUP 3: Property Access - Script Mode (_memberLookupScriptAsyncComplex)
    // ============================================================================

    describe('Issue #3: Property access in scripts (_memberLookupScriptAsyncComplex)', () => {

      it('should preserve context when property is rejecting promise in script', async () => {
        const context = {
          config: {
            apiKey: Promise.reject(new Error('API key fetch failed'))
          }
        };

        const script = `
        var key = config.apiKey
        @data.key = key
      `;

        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('API key fetch failed');
          expect(err.errors[0].lineno).to.equal(2); // Line with config.apiKey
        }
      });

      it('should preserve context for getter in script mode', async () => {
        class Config {
          get asyncValue() {
            return Promise.reject(new Error('Config getter failed'));
          }
        }

        const context = {
          config: new Config()
        };

        const script = `
        var value = config.asyncValue
        @data.value = value
      `;

        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Config getter failed');
          expect(err.errors[0].lineno).to.equal(2);
        }
      });

      it('should preserve context in script if condition with property', async () => {
        const context = {
          flags: {
            enabled: Promise.reject(new Error('Feature flag check failed'))
          }
        };

        const script = `
        if flags.enabled
          @data.message = "Enabled"
        endif
      `;

        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Feature flag check failed');
          expect(err.errors[0].lineno).to.equal(2);
        }
      });

      it('should preserve context for nested property in script', async () => {
        const context = {
          api: {
            endpoints: {
              users: Promise.reject(new Error('Endpoint config failed'))
            }
          }
        };

        const script = `
        var endpoint = api.endpoints.users
        @data.endpoint = endpoint
      `;

        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Endpoint config failed');
          expect(err.errors[0].lineno).to.equal(2);
        }
      });
    });

    // ============================================================================
    // TEST GROUP 4: Sequential Property Access - Template (sequentialMemberLookupAsync)
    // ============================================================================

    describe('Issue #4: Sequential property access in templates (sequentialMemberLookupAsync)', () => {

      it('should preserve context for sequential property access with promise', async () => {
        const context = {
          db: {
            connection: () => Promise.reject(new Error('DB connection failed'))
          }
        };

        // Using ! for sequential access
        const template = `
        {% set result = db!.connection() %}
        {{ result }}
      `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('DB connection failed');

          // CRITICAL: Sequential operations must preserve context too
          expect(err.errors[0].lineno).to.equal(2); // Line with db!.connection()
          expect(err.errors[0].colno).to.be.greaterThan(0);
        }
      });

      it('should preserve context for sequential getter access', async () => {
        class Database {
          asyncConnection() {
            return Promise.reject(new Error('Sequential connection failed'));
          }
        }

        const context = {
          db: new Database()
        };

        const template = `
        {% set result = db!.asyncConnection() %}
        {{ result }}
      `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Sequential connection failed');
          expect(err.errors[0].lineno).to.equal(2); // Line with db!.asyncConnection()
        }
      });

      it('should preserve context for chained sequential access', async () => {
        const context = {
          api: {
            client: {
              session: () => Promise.reject(new Error('Session init failed'))
            }
          }
        };

        const template = `
        {% set result = api.client!.session() %}
        {{ result }}
      `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Session init failed');
          expect(err.errors[0].lineno).to.equal(2); // Line with api.client!.session()
        }
      });

      it('should preserve context for sequential access in loop', async () => {
        const context = {
          service: {
            items: () => Promise.reject(new Error('Sequential items failed'))
          }
        };

        const template = `
        {% set items = service!.items() %}
        {% for item in items %}
          {{ item }}
        {% endfor %}
      `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Sequential items failed');
          expect(err.errors[0].lineno).to.equal(2); // Line with service!.items()
        }
      });
    });

    // ============================================================================
    // TEST GROUP 5: Sequential Property Access - Script (sequentialMemberLookupScriptAsync)
    // ============================================================================

    describe('Issue #5: Sequential property access in scripts (sequentialMemberLookupScriptAsync)', () => {

      it('should preserve context for sequential property in script', async () => {
        const context = {
          db: {
            transaction: () => Promise.reject(new Error('Transaction failed'))
          }
        };

        const script = `
        var tx = db!.transaction()
        @data.tx = tx
      `;

        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Transaction failed');
          expect(err.errors[0].lineno).to.equal(2);
        }
      });

      it('should preserve context for sequential getter in script', async () => {
        class Service {
          asyncState() {
            return Promise.reject(new Error('State getter failed'));
          }
        }

        const context = {
          service: new Service()
        };

        const script = `
        var state = service!.asyncState()
        @data.state = state
      `;

        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('State getter failed');
          expect(err.errors[0].lineno).to.equal(2);
        }
      });

      it('should preserve context for chained sequential in script', async () => {
        const context = {
          system: {
            cache: {
              data: () => Promise.reject(new Error('Cache read failed'))
            }
          }
        };

        const script = `
        var cached = system.cache!.data()
        @data.cached = cached
      `;

        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Cache read failed');
          expect(err.errors[0].lineno).to.equal(2);
        }
      });

      it('should preserve context for sequential in script condition', async () => {
        const context = {
          auth: {
            token: () => Promise.reject(new Error('Token validation failed'))
          }
        };

        const script = `
        if auth!.token()
          @data.authorized = true
        endif
      `;

        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Token validation failed');
          expect(err.errors[0].lineno).to.equal(2);
        }
      });
    });

    // ============================================================================
    // EDGE CASES & COMPLEX SCENARIOS
    // ============================================================================

    describe('Edge Cases and Complex Scenarios', () => {

      it('should handle promise rejection in nested function calls', async () => {
        env.addGlobal('outer', () => {
          return {
            inner: () => {
              return Promise.reject(new Error('Nested call failed'));
            }
          };
        });

        const template = `{{ outer().inner() }}`;

        try {
          await env.renderTemplateString(template);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Nested call failed');
          expect(err.errors[0].lineno).to.be.greaterThan(0);
        }
      });

      it('should handle promise in capture block', async () => {
        env.addGlobal('asyncData', () => {
          return Promise.reject(new Error('Capture data failed'));
        });

        const script = `
        var result = capture
          @text(asyncData())
        endcapture
        @text(result)
      `;

        try {
          await env.renderScriptString(script);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Capture data failed');
        }
      });

      it('should handle multiple promise rejections and collect all errors', async () => {
        env.addGlobal('fail1', () => Promise.reject(new Error('Error 1')));
        env.addGlobal('fail2', () => Promise.reject(new Error('Error 2')));

        const template = `{{ fail1() }} {{ fail2() }}`;

        try {
          await env.renderTemplateString(template);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          // Should collect both errors
          expect(err.errors.length).to.be.greaterThan(0);
        }
      });

      it('should preserve context when promise is in filter chain', async () => {
        env.addFilter('asyncFilter', (value) => {
          return Promise.reject(new Error('Filter processing failed'));
        });

        const template = `{{ "test" | asyncFilter }}`;

        try {
          await env.renderTemplateString(template);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Filter processing failed');
        }
      });

      it('should handle promise in macro arguments', async () => {
        env.addGlobal('asyncArg', () => {
          return Promise.reject(new Error('Macro arg failed'));
        });

        const template = `
        {% macro testMacro(value) %}
          {{ value }}
        {% endmacro %}

        {{ testMacro(asyncArg()) }}
      `;

        try {
          await env.renderTemplateString(template);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Macro arg failed');
        }
      });

      // ternary operator not yet implemented completexly
      it.skip('should handle promise in ternary operator', async () => {
        env.addGlobal('asyncValue', () => {
          return Promise.reject(new Error('Ternary value failed'));
        });

        const template = `{{ true ? asyncValue() : "default" }}`;

        try {
          await env.renderTemplateString(template);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('Ternary value failed');
        }
      });

      it('should handle promise in while loop condition', async () => {
        let count = 0;
        env.addGlobal('checkCondition', () => {
          count++;
          if (count > 1) {
            return Promise.reject(new Error('While condition failed'));
          }
          return true;
        });

        const script = `
        var i = 0
        while checkCondition()
          i = i + 1
          if i > 10
            break
          endif
        endwhile
      `;

        try {
          await env.renderScriptString(script, {}, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);
          expect(err.errors[0].message).to.contain('While condition failed');
        }
      });

      it('should only report error from first ! operation when both are poisoned', async () => {
        // Create a context where both operations would fail
        const context = {
          service: {
            firstOp: () => Promise.reject(new Error('First operation failed')),
            secondOp: () => Promise.reject(new Error('Second operation failed'))
          }
        };

        const template = `
        {% set result1 = service!.firstOp() %}
        {% set result2 = service!.secondOp() %}
        {{ result1 }} {{ result2 }}
      `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);

          // Should only have one error - from the first operation
          expect(err.errors.length).to.equal(1);
          expect(err.errors[0].message).to.contain('First operation failed');
          expect(err.errors[0].lineno).to.equal(2); // Line with service!.firstOp()

          // Should NOT contain error from second operation
          expect(err.errors[0].message).to.not.contain('Second operation failed');
        }
      });

      it('should only report error from first ! operation in script when both are poisoned', async () => {
        // Create a context where both operations would fail
        const context = {
          service: {
            firstOp: () => Promise.reject(new Error('First script operation failed')),
            secondOp: () => Promise.reject(new Error('Second script operation failed'))
          }
        };

        const script = `
        var result1 = service!.firstOp()
        var result2 = service!.secondOp()
        @data.result1 = result1
        @data.result2 = result2
      `;

        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (err) {
          expect(isPoisonError(err)).to.be(true);

          // Should only have one error - from the first operation
          expect(err.errors.length).to.equal(1);
          expect(err.errors[0].message).to.contain('First script operation failed');
          expect(err.errors[0].lineno).to.equal(2); // Line with service!.firstOp()

          // Should NOT contain error from second operation
          expect(err.errors[0].message).to.not.contain('Second script operation failed');
        }
      });
    });

    // ============================================================================
    // REGRESSION TESTS (Ensure non-promise values still work)
    // ============================================================================

    describe('Regression Tests - Non-Promise Values', () => {

      it('should not affect synchronous function calls', async () => {
        env.addGlobal('syncFunc', () => 'sync value');

        const result = await env.renderTemplateString('{{ syncFunc() }}');
        expect(result).to.equal('sync value');
      });

      it('should not affect synchronous property access', async () => {
        const context = { user: { name: 'Alice' } };

        const result = await env.renderTemplateString('{{ user.name }}', context);
        expect(result).to.equal('Alice');
      });

      it('should not affect sequential synchronous operations', async () => {
        const context = {
          db: { connection: () => 'connected' }
        };

        const result = await env.renderTemplateString('{{ db!.connection() }}', context);
        expect(result).to.equal('connected');
      });

      it('should handle resolved promises normally', async () => {
        env.addGlobal('asyncFunc', () => Promise.resolve('resolved'));

        const result = await env.renderTemplateString('{{ asyncFunc() }}');
        expect(result).to.equal('resolved');
      });

      it('should handle property that is resolved promise', async () => {
        const context = {
          data: { value: Promise.resolve('resolved') }
        };

        const result = await env.renderTemplateString('{{ data.value }}', context);
        expect(result).to.equal('resolved');
      });
    });
  });
})();
