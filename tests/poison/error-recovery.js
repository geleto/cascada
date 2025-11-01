(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;
  var runtime;
  var isPoisonError;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
    runtime = require('../../src/runtime/runtime');
    isPoisonError = runtime.isPoisonError;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    runtime = nunjucks.runtime;
    isPoisonError = nunjucks.runtime.isPoisonError;
  }

  describe('Poisoning Tests', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    it('should test for error', async () => {
      const p = Promise.reject(new Error('REJECTED'));
      const output = await env.renderTemplateString('{{ val is error }}', { val: p });
      expect(output).to.equal('true');
    });

    it('should test for error (negative case)', async () => {
      const p = Promise.resolve('hello');
      const output = await env.renderTemplateString('{{ val is error }}', {
        val: p
      });
      expect(output).to.equal('false');
    });

    it('should test for error (poisoned)', async () => {
      function CustomError(message) {
        this.name = 'CustomError';
        this.message = message;
      }
      CustomError.prototype = new Error();
      const err = new CustomError('test error');
      const p = runtime.createPoison(err, { lineno: 1, colno: 1 });

      const output = await env.renderTemplateString('{{ val is error }}', { val: p });
      expect(output).to.equal('true');
    });

    it('should test for error (non-error)', async () => {
      const output = await env.renderTemplateString('{{ val is error }}', {
        val: 'hello'
      });
      expect(output).to.equal('false');
    });

    it('should poison render if LHS of "is" is poisoned', async () => {
      const err = new Error('test error');
      const p = runtime.createPoison(err, { lineno: 1, colno: 1 });
      try {
        await env.renderTemplateString('{{ val is defined }}', { val: p });
        expect().fail('Should have thrown');
      } catch (e) {
        expect(isPoisonError(e)).to.be(true);
        expect(e.message).to.contain('test error');
      }
    });

    it('should poison render if RHS of "is" is poisoned', async () => {
      const p = Promise.reject(new Error('REJECTED'));
      try {
        await env.renderTemplateString('{{ 8 is divisibleby(val) }}', { val: p });
        expect().fail('Should have thrown');
      } catch (e) {
        expect(isPoisonError(e)).to.be(true);
        expect(e.message).to.contain('REJECTED');
      }
    });

    // Error recovery tests for different Cascada functionality
    describe('Error Recovery Tests', () => {
      const errorPromise = (msg) => Promise.reject(new Error(msg));

      it('should recover from error in variable assignment and property access', async () => {
        const template = `
          {% set user = getUser() %}
          {% if heal and user is error %}
            {% set user = {name: "Guest", id: 0} %}
          {% endif %}
          {{ user.name }}
        `;

        const context = {
          heal: true,
          getUser: () => errorPromise('User fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('Guest');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(isPoisonError(e)).to.be(true);
          expect(e.message).to.contain('User fetch failed');
        }
      });

      it('should recover from error in filter application', async () => {
        const template = `
          {% set data = getData() %}
          {% if heal and data is error %}
            {% set data = "fallback" %}
          {% endif %}
          {{ data | upper }}
        `;

        const context = {
          heal: true,
          getData: () => errorPromise('Data fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('FALLBACK');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(isPoisonError(e)).to.be(true);
          expect(e.message).to.contain('Data fetch failed');
        }
      });

      it('should recover from error in loop iteration', async () => {
        const template = `
          {% set items = getItems() %}
          {% if heal and items is error %}
            {% set items = ["default1", "default2"] %}
          {% endif %}
          {% for item in items %}{{ item }}{% if not loop.last %},{% endif %}{% endfor %}
        `;

        const context = {
          heal: true,
          getItems: () => errorPromise('Items fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('default1,default2');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(isPoisonError(e)).to.be(true);
          expect(e.message).to.contain('Items fetch failed');
        }
      });

      it('should recover from error in conditional expression', async () => {
        const template = `
          {% set status = getStatus() %}
          {% if heal and status is error %}
            {% set status = "unknown" %}
          {% endif %}
          {% if status == "active" %}Active{% else %}Inactive{% endif %}
        `;

        const context = {
          heal: true,
          getStatus: () => errorPromise('Status fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('Inactive');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(isPoisonError(e)).to.be(true);
          expect(e.message).to.contain('Status fetch failed');
        }
      });

      it('should recover from error in array access', async () => {
        const template = `
          {% set arr = getArray() %}
          {% if heal and arr is error %}
            {% set arr = [1, 2, 3] %}
          {% endif %}
          {{ arr[0] }}
        `;

        const context = {
          heal: true,
          getArray: () => errorPromise('Array fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('1');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(isPoisonError(e)).to.be(true);
          expect(e.message).to.contain('Array fetch failed');
        }
      });

      it('should recover from error in mathematical operations', async () => {
        const template = `
          {% set num = getNumber() %}
          {% if heal and num is error %}
            {% set num = 10 %}
          {% endif %}
          {{ num * 2 }}
        `;

        const context = {
          heal: true,
          getNumber: () => errorPromise('Number fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('20');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Number fetch failed');
        }
      });

      it('should recover from error in string concatenation', async () => {
        const template = `
          {% set prefix = getPrefix() %}
          {% if heal and prefix is error %}
            {% set prefix = "Hello" %}
          {% endif %}
          {{ prefix ~ " World" }}
        `;

        const context = {
          heal: true,
          getPrefix: () => errorPromise('Prefix fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('Hello World');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Prefix fetch failed');
        }
      });

      it('should recover from error in comparison operations', async () => {
        const template = `
          {% set age = getAge() %}
          {% if heal and age is error %}
            {% set age = 25 %}
          {% endif %}
          {% if age > 18 %}Adult{% else %}Minor{% endif %}
        `;

        const context = {
          heal: true,
          getAge: () => errorPromise('Age fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('Adult');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Age fetch failed');
        }
      });

      it('should recover from error in nested property access', async () => {
        const template = `
          {% set config = getConfig() %}
          {% if heal and config is error %}
            {% set config = {settings: {theme: "dark"}} %}
          {% endif %}
          {{ config.settings.theme }}
        `;

        const context = {
          heal: true,
          getConfig: () => errorPromise('Config fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('dark');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Config fetch failed');
        }
      });

      it('should recover from error in chained filters', async () => {
        const template = `
          {% set text = getText() %}
          {% if heal and text is error %}
            {% set text = "hello world" %}
          {% endif %}
          {{ text | upper | replace("WORLD", "THERE") }}
        `;

        const context = {
          heal: true,
          getText: () => errorPromise('Text fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('HELLO THERE');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Text fetch failed');
        }
      });

      it('should recover from error in ternary expressions', async () => {
        const template = `
          {% set flag = getFlag() %}
          {% if heal and flag is error %}
            {% set flag = true %}
          {% endif %}
          {{ "yes" if flag else "no" }}
        `;

        const context = {
          heal: true,
          getFlag: () => errorPromise('Flag fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('yes');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Flag fetch failed');
        }
      });

      it('should recover from error in object literal creation', async () => {
        const template = `
          {% set value = getValue() %}
          {% if heal and value is error %}
            {% set value = 42 %}
          {% endif %}
          {% set obj = {key: value} %}
          {{ obj.key }}
        `;

        const context = {
          heal: true,
          getValue: () => errorPromise('Value fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('42');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Value fetch failed');
        }
      });

      it('should recover from error in loop with filter', async () => {
        const template = `
          {% set numbers = getNumbers() %}
          {% if heal and numbers is error %}
            {% set numbers = [1, 2, 3, 4, 5] %}
          {% endif %}
          {% for num in numbers | select("odd") %}{{ num }}{% endfor %}
        `;

        const context = {
          heal: true,
          getNumbers: () => errorPromise('Numbers fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('135');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Numbers fetch failed');
        }
      });

      it('should recover from error in default filter fallback', async () => {
        const template = `
          {% set val = getVal() %}
          {% if heal and val is error %}
            {% set val = undefined %}
          {% endif %}
          {{ val | default("fallback value") }}
        `;

        const context = {
          heal: true,
          getVal: () => errorPromise('Val fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('fallback value');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Val fetch failed');
        }
      });

      it('should recover from error in logical operations', async () => {
        const template = `
          {% set a = getA() %}
          {% if heal and a is error %}
            {% set a = true %}
          {% endif %}
          {{ a and true }}
        `;

        const context = {
          heal: true,
          getA: () => errorPromise('A fetch failed')
        };

        // Test with healing
        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('true');

        // Test without healing
        context.heal = false;
        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('A fetch failed');
        }
      });
    });

    // not implemented yet
    describe.skip('@data Output Error Recovery', () => {
      const errorPromise = (msg) => Promise.reject(new Error(msg));

      it('should recover from error in simple @data output assignment', async () => {
        const script = `
          {% set value = getValue() %}
          {% if heal and value is error %}
            {% set value = "fallback" %}
          {% endif %}
          @data.result = value
        `;

        const context = {
          heal: true,
          getValue: () => errorPromise('Value fetch failed')
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.result).to.equal('fallback');

        // Test without healing
        context.heal = false;
        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Value fetch failed');
        }
      });

      it('should recover from error in nested @data output assignment', async () => {
        const script = `
          {% set user = getUser() %}
          {% if heal and user is error %}
            {% set user = {name: "Guest", id: 0} %}
          {% endif %}
          @data.user.name = user.name
          @data.user.id = user.id
        `;

        const context = {
          heal: true,
          getUser: () => errorPromise('User fetch failed')
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.user.name).to.equal('Guest');
        expect(data.user.id).to.equal(0);

        // Test without healing
        context.heal = false;
        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('User fetch failed');
        }
      });

      it('should recover from error in @data output with computed expression', async () => {
        const script = `
          {% set price = getPrice() %}
          {% if heal and price is error %}
            {% set price = 100 %}
          {% endif %}
          @data.total = price * 1.2
          @data.currency = "USD"
        `;

        const context = {
          heal: true,
          getPrice: () => errorPromise('Price fetch failed')
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.total).to.equal(120);
        expect(data.currency).to.equal('USD');

        // Test without healing
        context.heal = false;
        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Price fetch failed');
        }
      });

      it('should recover from error in @data output with filter', async () => {
        const script = `
          {% set text = getText() %}
          {% if heal and text is error %}
            {% set text = "default text" %}
          {% endif %}
          @data.message = text | upper
        `;

        const context = {
          heal: true,
          getText: () => errorPromise('Text fetch failed')
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.message).to.equal('DEFAULT TEXT');

        // Test without healing
        context.heal = false;
        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Text fetch failed');
        }
      });

      it('should recover from error in @data array output', async () => {
        const script = `
          {% set items = getItems() %}
          {% if heal and items is error %}
            {% set items = ["item1", "item2"] %}
          {% endif %}
          {% for item in items %}
            @data.list.push(item)
          {% endfor %}
        `;

        const context = {
          heal: true,
          getItems: () => errorPromise('Items fetch failed')
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.list).to.deep.equal(['item1', 'item2']);

        // Test without healing
        context.heal = false;
        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Items fetch failed');
        }
      });

      it('should recover from error in @data output with object construction', async () => {
        const script = `
          {% set config = getConfig() %}
          {% if heal and config is error %}
            {% set config = {theme: "light", lang: "en"} %}
          {% endif %}
          @data.settings = {
            theme: config.theme,
            language: config.lang,
            version: "1.0"
          }
        `;

        const context = {
          heal: true,
          getConfig: () => errorPromise('Config fetch failed')
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.settings.theme).to.equal('light');
        expect(data.settings.language).to.equal('en');
        expect(data.settings.version).to.equal('1.0');

        // Test without healing
        context.heal = false;
        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Config fetch failed');
        }
      });

      it('should recover from error in multiple @data outputs with partial errors', async () => {
        const script = `
          {% set validData = getValid() %}
          {% set errorData = getError() %}
          {% if heal and errorData is error %}
            {% set errorData = "recovered" %}
          {% endif %}
          @data.valid = validData
          @data.recovered = errorData
        `;

        const context = {
          heal: true,
          getValid: () => Promise.resolve('success'),
          getError: () => errorPromise('Error data failed')
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.valid).to.equal('success');
        expect(data.recovered).to.equal('recovered');

        // Test without healing
        context.heal = false;
        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Error data failed');
        }
      });
    });

    // not implemented yet
    describe.skip('! Sequential Operator Error Recovery', () => {
      const errorPromise = (msg) => Promise.reject(new Error(msg));
      let callOrder;

      beforeEach(() => {
        callOrder = [];
      });

      it('should recover from error in sequential operation chain', async () => {
        const script = `
          {% set step1 = getStep1() %}
          {% if heal and step1 is error %}
            {% set step1 = "step1-fallback" %}
          {% endif %}
          {% set step2 = getStep2(step1) %}
          @data.result = step2
        `;

        const context = {
          heal: true,
          getStep1: () => errorPromise('Step 1 failed'),
          getStep2: (val) => {
            callOrder.push('step2');
            return Promise.resolve(val + '-processed');
          }
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.result).to.equal('step1-fallback-processed');
        expect(callOrder).to.deep.equal(['step2']);

        // Test without healing
        callOrder = [];
        context.heal = false;
        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Step 1 failed');
        }
      });

      it('should recover from error in sequential database writes', async () => {
        const script = `
          {% set user = createUser() %}
          {% if heal and user is error %}
            {% set user = {id: 999, name: "FallbackUser"} %}
          {% endif %}
          {% set profile = createProfile(user.id) %}
          @data.user = user
          @data.profile = profile
        `;

        const context = {
          heal: true,
          createUser: () => errorPromise('User creation failed'),
          createProfile: (userId) => {
            callOrder.push('profile');
            return Promise.resolve({ userId, bio: 'Default bio' });
          }
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.user.id).to.equal(999);
        expect(data.profile.userId).to.equal(999);
        expect(callOrder).to.deep.equal(['profile']);

        // Test without healing
        callOrder = [];
        context.heal = false;
        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('User creation failed');
        }
      });

      it('should recover from error in sequential API calls', async () => {
        const script = `
          {% set token = authenticate() %}
          {% if heal and token is error %}
            {% set token = "fallback-token" %}
          {% endif %}
          {% set data = fetchData(token) %}
          {% set processed = processData(data) %}
          @data.result = processed
        `;

        const context = {
          heal: true,
          authenticate: () => errorPromise('Auth failed'),
          fetchData: (token) => {
            callOrder.push('fetch');
            return Promise.resolve({ token, value: 'data' });
          },
          processData: (data) => {
            callOrder.push('process');
            return Promise.resolve(data.value.toUpperCase());
          }
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.result).to.equal('DATA');
        expect(callOrder).to.deep.equal(['fetch', 'process']);

        // Test without healing
        callOrder = [];
        context.heal = false;
        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Auth failed');
        }
      });

      it('should recover from error in middle of sequential chain', async () => {
        const script = `
          {% set step1 = getStep1() %}
          {% set step2 = getStep2() %}
          {% if heal and step2 is error %}
            {% set step2 = "step2-recovered" %}
          {% endif %}
          {% set step3 = getStep3(step1, step2) %}
          @data.result = step3
        `;

        const context = {
          heal: true,
          getStep1: () => {
            callOrder.push('step1');
            return Promise.resolve('step1-success');
          },
          getStep2: () => errorPromise('Step 2 failed'),
          getStep3: (s1, s2) => {
            callOrder.push('step3');
            return Promise.resolve(s1 + '-' + s2);
          }
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.result).to.equal('step1-success-step2-recovered');
        expect(callOrder).to.include('step1');
        expect(callOrder).to.include('step3');

        // Test without healing
        callOrder = [];
        context.heal = false;
        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Step 2 failed');
        }
      });

      it('should recover from error in sequential loop iterations', async () => {
        const script = `
          {% set items = getItems() %}
          {% if heal and items is error %}
            {% set items = [1, 2, 3] %}
          {% endif %}
          {% for item in items %}
            {% set processed = processItem(item) %}
            @data.results.push(processed)
          {% endfor %}
        `;

        const context = {
          heal: true,
          getItems: () => errorPromise('Items fetch failed'),
          processItem: (item) => {
            callOrder.push('process-' + item);
            return Promise.resolve(item * 2);
          }
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.results).to.deep.equal([2, 4, 6]);
        expect(callOrder.length).to.equal(3);

        // Test without healing
        callOrder = [];
        context.heal = false;
        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Items fetch failed');
        }
      });

      it('should recover from error in conditional sequential operations', async () => {
        const script = `
          {% set condition = checkCondition() %}
          {% if heal and condition is error %}
            {% set condition = true %}
          {% endif %}
          {% if condition %}
            {% set result = executeTrue() %}
          {% else %}
            {% set result = executeFalse() %}
          {% endif %}
          @data.result = result
        `;

        const context = {
          heal: true,
          checkCondition: () => errorPromise('Condition check failed'),
          executeTrue: () => {
            callOrder.push('true');
            return Promise.resolve('true-branch');
          },
          executeFalse: () => {
            callOrder.push('false');
            return Promise.resolve('false-branch');
          }
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.result).to.equal('true-branch');
        expect(callOrder).to.deep.equal(['true']);

        // Test without healing
        callOrder = [];
        context.heal = false;
        try {
          await env.renderScriptString(script, context, { output: 'data' });
          expect().fail('Should have thrown');
        } catch (e) {
          expect(e.message).to.contain('Condition check failed');
        }
      });
    });
  });
}());
