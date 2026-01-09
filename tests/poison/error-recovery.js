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

      it('should verify explicit template logic recovery', async () => {
        const template = `
          {% set value = getValue() %}
          {% if heal and value is error %}
            {% set value = "fallback" %}
          {% endif %}
          {{ value }}
        `;

        const context = {
          heal: true,
          getValue: () => Promise.reject(new Error('Value fetch failed'))
        };

        let output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('fallback');
      });
    });

    describe('Loop soft error healing', () => {
      it('should heal soft errors inside script for loops over async iterators', async () => {
        const context = {
          asyncItems: async function* () {
            yield 'one';
            yield new Error('async for soft failure');
            yield 'two';
          }
        };
        const script = `
          :data
          for value in asyncItems()
            if value is error
              value = "healed-async-for"
            endif
            @data.values.push(value)
          endfor
        `;

        const data = await env.renderScriptString(script, context);
        expect(data.values).to.eql(['one', 'healed-async-for', 'two']);
      });

      it('should heal soft errors inside script each loops over async iterators', async () => {
        const context = {
          series: async function* () {
            yield 'uno';
            yield new Error('each async soft failure');
            yield 'dos';
          }
        };
        const script = `
        :data
        each entry in series()
          if entry is error
            entry = "healed-async-each"
          endif
          @data.values.push(entry)
        endeach
        `;

        const data = await env.renderScriptString(script, context);
        expect(data.values).to.eql(['uno', 'healed-async-each', 'dos']);
      });

      it('should heal soft errors inside template for-of loops over async iterators', async () => {
        const context = {
          limitedItems: async function* () {
            yield 'start';
            yield new Error('for-of async soft failure');
            yield 'end';
          }
        };
        const template = `
          {% set cleaned = [] %}
          {% for item in limitedItems() of 2 %}
            {% set normalized = item %}
            {% if normalized is error %}
              {% set normalized = "healed-for-of-async" %}
            {% endif %}
            {% set cleaned = cleaned.concat([normalized]) %}
          {% endfor %}
          {{ cleaned | join(',') }}
        `;

        const output = await env.renderTemplateString(template, context);
        expect(output.trim()).to.equal('start,healed-for-of-async,end');
      });
    });

    // not implemented yet
    describe('@data Output Error Recovery', () => {
      const errorPromise = (msg) => Promise.reject(new Error(msg));

      it('should recover from error in simple assignment', async () => {
        const script = `
          :data
          var value = getValue()
          if heal and value is error
            value = "fallback"
          endif
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
          :data
          var user = getUser()
          if heal and user is error
            user = {name: "Guest", id: 0}
          endif
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
          :data
          var price = getPrice()
          if heal and price is error
            price = 100
          endif
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
          :data
          var text = getText()
          if heal and text is error
            text = "default text"
          endif
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
          :data
          var items = getItems()
          if heal and items is error
            items = ["item1", "item2"]
          endif
          for item in items
            @data.list.push(item)
          endfor
        `;

        const context = {
          heal: true,
          getItems: () => errorPromise('Items fetch failed')
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.list).to.eql(['item1', 'item2']);

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
          :data
          var config = getConfig()
          if heal and config is error
            config = {theme: "light", lang: "en"}
          endif
          @data.settings = { theme: config.theme, language: config.lang, version: "1.0" }
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
          :data
          var validData = getValid()
          var errorData = getError()
          if heal and errorData is error
            errorData = "recovered"
          endif
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

    describe('! Sequential Operator Error Recovery', () => {
      const errorPromise = (msg) => Promise.reject(new Error(msg));
      let callOrder;

      beforeEach(() => {
        callOrder = [];
      });

      it('should recover from error in sequential operation chain', async () => {
        const script = `
          :data
          var step1 = ops!.getStep1()
          ops!!
          if heal and step1 is error
            step1 = "step1-fallback"
          endif
          var step2 = ops!.getStep2(step1)
          @data.result = step2
        `;

        const context = {
          heal: true,
          ops: {
            getStep1: () => errorPromise('Step 1 failed'),
            getStep2: (val) => {
              callOrder.push('step2');
              return Promise.resolve(val + '-processed');
            }
          }
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.result).to.equal('step1-fallback-processed');
        expect(callOrder).to.eql(['step2']);

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
          :data
          var user = db!.createUser()
          if heal and user is error
            user = {id: 999, name: "FallbackUser"}
          endif
          db!!
          var profile = db!.createProfile(user.id)
          @data.user = user
          @data.profile = profile
        `;

        const context = {
          heal: true,
          db: {
            createUser: () => errorPromise('User creation failed'),
            createProfile: (userId) => {
              callOrder.push('profile');
              return Promise.resolve({ userId, bio: 'Default bio' });
            }
          }
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.user.id).to.equal(999);
        expect(data.profile.userId).to.equal(999);
        expect(callOrder).to.eql(['profile']);

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
          :data
          var token = api!.authenticate()
          if heal and token is error
            token = "fallback-token"
          endif
          api!!
          var data = api!.fetchData(token)
          var processed = api!.processData(data)
          @data.result = processed
        `;

        const context = {
          heal: true,
          api: {
            authenticate: () => errorPromise('Auth failed'),
            fetchData: (token) => {
              callOrder.push('fetch');
              return Promise.resolve({ token, value: 'data' });
            },
            processData: (data) => {
              callOrder.push('process');
              return Promise.resolve(data.value.toUpperCase());
            }
          }
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.result).to.equal('DATA');
        expect(callOrder).to.eql(['fetch', 'process']);

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
          :data
          var step1 = ops!.getStep1()
          var step2 = ops!.getStep2()
          if heal and step2 is error
            step2 = "step2-recovered"
          endif
          ops!!
          var step3 = ops!.getStep3(step1, step2)
          @data.result = step3
        `;

        const context = {
          heal: true,
          ops: {
            getStep1: () => {
              callOrder.push('step1');
              return Promise.resolve('step1-success');
            },
            getStep2: () => errorPromise('Step 2 failed'),
            getStep3: (s1, s2) => {
              callOrder.push('step3');
              return Promise.resolve(s1 + '-' + s2);
            }
          }
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.result).to.equal('step1-success-step2-recovered');
        expect(callOrder).to.contain('step1');
        expect(callOrder).to.contain('step3');

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
          :data
          var items = ops!.getItems()
          if heal and items is error
            items = [1, 2, 3]
          endif
          ops!!
          for item in items
            var processed = ops!.processItem(item)
            @data.results.push(processed)
          endfor
        `;

        const context = {
          heal: true,
          ops: {
            getItems: () => errorPromise('Items fetch failed'),
            processItem: (item) => {
              callOrder.push('process-' + item);
              return Promise.resolve(item * 2);
            }
          }
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.results).to.eql([2, 4, 6]);
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
          :data
          var condition = ops!.checkCondition()
          if heal and condition is error
            condition = true
          endif
          ops!!
          var result
          if condition
            result = ops!.executeTrue()
          else
            result = ops!.executeFalse()
          endif
          @data.result = result
        `;

        const context = {
          heal: true,
          ops: {
            checkCondition: () => errorPromise('Condition check failed'),
            executeTrue: () => {
              callOrder.push('true');
              return Promise.resolve('true-branch');
            },
            executeFalse: () => {
              callOrder.push('false');
              return Promise.resolve('false-branch');
            }
          }
        };

        // Test with healing
        let data = await env.renderScriptString(script, context, { output: 'data' });
        expect(data.result).to.equal('true-branch');
        expect(callOrder).to.eql(['true']);

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

    describe('Poison Repair with !!', () => {
      it('should repair a poisoned path using !!', async () => {
        const context = {
          db: {
            _log: [],
            insert: async function (data) {
              if (data === 'bad') {
                throw new Error('Database error');
              }
              this._log.push('insert:' + data);
              return true;
            },
            rollback: async function () {
              this._log.push('rollback');
              return 'rollback';
            },
            getLog: function () {
              return this._log;
            }
          }
        };

        const script = `
:data
var res1 = db!.insert('bad')
var res2 = db!.insert('good')
var res3 = db!!.rollback()
var res4 = db!.insert('after')
@data.log = db.getLog()
@data.res2_poison = res2 is error
@data.res3_poison = res3 is error
@data.res3_val = res3
`;

        const result = await env.renderScriptString(script, context);

        expect(result.res2_poison).to.be(true);
        expect(result.res3_poison).to.be(false);
        expect(result.res3_val).to.be('rollback');
        expect(result.log).to.contain('rollback');
        expect(result.log).to.contain('insert:after');
        expect(result.log).not.to.contain('insert:good');
      });

      it('should support standalone repair expression context.db!!', async () => {
        const context = {
          service: {
            doSomething: function () { throw new Error('fail'); },
            reset: function () { return 'good'; },
            status: 'ok'
          }
        };

        const script = `
        :data

        // Poison the path
        var _ = service!.doSomething()

        // Verify it is poisoned (next call skipped)
        var skip = service!.reset()

        // Standalone repair
        service!!

        // Should work now
        @data.status = service.status
        @data.skipped_is_poison = skip is error
      `;

        const result = await env.renderScriptString(script, context);

        expect(result.skipped_is_poison).to.be(true);
        expect(result.status).to.be('ok');
      });

      it('should execute repair operator on healthy lock without issues (sanity check)', async () => {
        const context = {
          db: {
            status: 'init',
            setStatus: function (val) {
              this.status = val;
              return true;
            }
          }
        };

        // Normal call, then repair call on generic healthy state
        const script = `
        db!.setStatus('step1')
        db!!.setStatus('step2')
        var finalStatus = db.status
      `;

        await env.renderScriptString(script, context);
        expect(context.db.status).to.equal('step2');
      });

      it('should handle cyclic poison and repair sequences', async () => {
        const context = {
          service: {
            state: 'healthy',
            fail: function () {
              throw new Error('fail');
            },
            recover: function () {
              return 'recovered';
            },
            work: function (val) {
              return val;
            }
          }
        };

        // Poison -> Repair -> Work -> Poison -> Repair -> Work
        const script = `
        :data
        // Cycle 1
        var fail1 = service!.fail()
        var rep1 = service!!.recover()
        var work1 = service!.work('working1')

        // Cycle 2
        var fail2 = service!.fail()
        var rep2 = service!!.recover()
        var work2 = service!.work('working2')

        @data.rep1 = rep1
        @data.work1 = work1
        @data.rep2 = rep2
        @data.work2 = work2
      `;

        const result = await env.renderScriptString(script, context);

        expect(result.rep1).to.equal('recovered');
        expect(result.work1).to.equal('working1');
        expect(result.rep2).to.equal('recovered');
        expect(result.work2).to.equal('working2');
      });

      it('should correctly repair locks inside loops', async () => {
        const context = {
          processor: {
            processed: [],
            fail: function () { throw new Error('fail'); },
            recover: function () { return 'recovered'; },
            process: function (val) {
              this.processed.push(val);
              return val;
            }
          }
        };

        // Loop 3 times: Poison -> Repair -> Process
        // Using 'set' or implicit assignment might be safer, but just calling the method is best if allowed.
        // Assuming expression statements are allowed in scripts (which they usually are).
        const script = `
        var items = [1, 2, 3]
        for item in items
          // Just call them for side effects
          processor!.fail()
          processor!!.recover()
          processor!.process(item)
        endfor
      `;

        await env.renderScriptString(script, context);
        expect(context.processor.processed).to.eql([1, 2, 3]);
      });

      it('should handle obj.prop! is error correctly for sequential recovery', async () => {
        const context = {
          service: {
            calls: [],
            badMethod: async function () {
              this.calls.push('badMethod');
              throw new Error('Something went wrong');
            },
            goodMethod: async function () {
              this.calls.push('goodMethod');
              return 'ok';
            },
            reset: function () {
              // Should not be called if lock is poisoned
              this.calls.push('reset');
            }
          }
        };

        const script = `
        :data
        // 1. Call a method that throws, poisoning the sequence lock '!service'
        // We use 'is error' to catch the runtime error and avoid script termination
        @data.initialCallFailed = service!.badMethod() is error

        // 2. Check if the sequence is in error state using obj.prop! is error
        // This confirms the lock '!service' itself is poisoned
        @data.isPoisoned = service! is error

        // 3. Verify normal lookup fails/is skipped (poison propagation)
        // using a standard call without repair. Accessing it directly would throw, so we check 'is error'
        @data.skippedHadError = service!.reset() is error

        // 4. Manual repair to prove we can continue
        service!!

        // 5. Verify we are good again
        @data.finalResult = service!.goodMethod()

        // 6. Verify healthy check returns false
        @data.isPoisonedHealthy = service! is error
      `;

        const result = await env.renderScriptString(script, context);

        expect(result.initialCallFailed).to.be(true);
        expect(result.isPoisoned).to.be(true);
        expect(result.skippedHadError).to.be(true);
        expect(context.service.calls).to.eql(['badMethod', 'goodMethod']); // reset should be skipped
        expect(result.finalResult).to.equal('ok');
        expect(result.isPoisonedHealthy).to.be(false);
      });
    });

    describe('Sequential Syntax Strictness and Logic', () => {
      it('should detect poison on a sequential path after a failure', async () => {
        const script = `
          :data
          service!.fail()

          @data.isErr = service! is error
        `;

        const ctx = {
          service: {
            fail: async () => { throw new Error('database down'); }
          }
        };

        const res = await env.renderScriptString(script, ctx);

        expect(res).to.have.property('isErr', true);
      });

      it('should detect poison on a sequential path via strict property access after failure', async () => {
        const script = `
          :data
          service.db!.fail()

          @data.isErr = service.db! is error
        `;

        const ctx = {
          service: {
            db: {
              fail: async () => { throw new Error('db down'); }
            }
          }
        };

        const res = await env.renderScriptString(script, ctx);
        expect(res).to.have.property('isErr', true);
      });

      it('should throw compilation error for non-existing/unused sequence path', async () => {
        const script = `
          :data
          @data.isErr = service! is error
        `;

        try {
          await env.renderScriptString(script, { service: {} });
          expect().fail('Should have thrown compilation error');
        } catch (e) {
          expect(e.message).to.contain('Sequence path \'!service\' does not exist');
        }
      });

      it('should allow successful sequence operations implicitly (healthy path)', async () => {
        const script = `
          :data
          service!.ok()
          @data.isErr = service! is error
        `;

        const ctx = {
          service: {
            ok: async () => 'success'
          }
        };

        const res = await env.renderScriptString(script, ctx);
        expect(res).to.have.property('isErr', false);
      });

      it('should fail compilation for invalid syntax (buried marker in is error)', async () => {
        // 'service!.val is error' is invalid because '!' is buried.
        const script = `
          service!.method()
          var x = service!.val is error
        `;
        const ctx = { service: { method: async () => { }, val: 1 } };
        try {
          await env.renderScriptString(script, ctx);
          expect().fail('Should have thrown compilation error');
        } catch (e) {
          expect(e.message).to.contain('Sequence marker (!) is not allowed in non-call paths');
        }
      });

      it('should verify scope independence: parent lock is not created by child lock', async () => {
        const script = `
            :data
            service.db!.fail()
            @data.serviceErr = service! is error
          `;

        const ctx = {
          service: {
            db: {
              fail: async () => { throw new Error('db down'); }
            }
          }
        };

        try {
          await env.renderScriptString(script, ctx);
          expect().fail('Should have thrown compilation error for undefined parent lock');
        } catch (e) {
          expect(e.message).to.contain('Sequence path \'!service\' does not exist');
        }
      });

      it('should verify scope independence: child lock IS created and checkable', async () => {
        const script = `
            :data
            service.db!.fail()
            @data.dbErr = service.db! is error
          `;

        const ctx = {
          service: {
            db: {
              fail: async () => { throw new Error('db down'); }
            }
          }
        };

        const res = await env.renderScriptString(script, ctx);
        expect(res).to.have.property('dbErr', true);
      });

      it('should repair a poisoned sequence path using !! operator', async () => {
        // 1. Fail and Poison
        // 2. Check is error -> true
        // 3. Repair with !!
        // 4. Check is error -> false
        const script = `
          :data
          service!.fail()
          @data.step1 = service! is error
          service!!.repair()
          @data.step2 = service! is error
        `;

        const ctx = {
          service: {
            fail: async () => { throw new Error('fail'); },
            repair: async () => 'fixed'
          }
        };

        const res = await env.renderScriptString(script, ctx);
        expect(res.step1).to.be(true);
        expect(res.step2).to.be(false);
      });

      it('should verify scope independence: parent lock defined does not create child lock', async () => {
        const script = `
            :data
            service!.fail()
            // !service is defined, but !service.db is NOT.
            // Docs say !paths are strict.
            @data.dbErr = service.db! is error
        `;

        const ctx = {
          service: {
            fail: async () => { throw new Error('fail'); },
            db: {}
          }
        };

        try {
          await env.renderScriptString(script, ctx);
          expect().fail('Should have thrown compilation error for undefined child lock');
        } catch (e) {
          expect(e.message).to.contain('Sequence path \'!service!db\' does not exist');
        }
      });
    });
  });
}());
