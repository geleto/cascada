(function () {
  'use strict';

  var expect;
  //var unescape;
  var AsyncEnvironment;
  //var Environment;
  var delay;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
    //Environment = require('../../src/environment/environment').Environment;
    //unescape = require('he').unescape;
    delay = require('../util').delay;
  } else {
    expect = window.expect;
    //unescape = window.he.unescape;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    //Environment = nunjucks.Environment;
    delay = window.util.delay;
  }

  // Helper function to normalize whitespace for consistent test comparisons
  function normalizeWhitespace(str) {
    return str.replace(/\s+/g, ' ').trim();
  }

  describe('Async mode - structures: arrays, dictionaries and lookup keys', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();

      // Add inspectArray function to the environment
      env.addGlobal('inspectArray', (arr) => {
        return `First: ${arr[0]}, Length: ${arr.length}`;
      });
    });

    describe('Arrays, Dictionaries, Lookup keys and Nested Structures', () => {
      it('should handle arrays with elements resolved in parallel', async () => {
        const context = {
          async getItem1() {
            await delay(2);
            return 'Item1';
          },
          async getItem2() {
            await delay(1);
            return 'Item2';
          }
        };
        const template = '{% set myArray = [getItem1(), getItem2()] %}{{ myArray | join(", ") }}';
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Item1, Item2');
      });

      it('should handle dictionaries with values resolved in parallel', async () => {
        const context = {
          async getValue1() {
            await delay(2);
            return 'Value1';
          },
          async getValue2() {
            await delay(1);
            return 'Value2';
          }
        };
        const template = '{% set myDict = {"key1": getValue1(), "key2": getValue2()} %}{{ myDict["key1"] }}, {{ myDict["key2"] }}';
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Value1, Value2');
      });

      it('should handle nested arrays and dictionaries with async elements resolved in parallel', async () => {
        const context = {
          async getValueA() {
            await delay(3);
            return 'A';
          },
          async getValueB() {
            await delay(2);
            return 'B';
          },
          async getValueC() {
            await delay(1);
            return 'C';
          }
        };
        const template = `
            {%- set myData = {
              "list": [getValueA(), getValueB(), getValueC()],
              "dict": {
                "key1": getValueA(),
                "key2": getValueB(),
                "key3": getValueC()
              }
            } -%}
            List: {{ myData.list | join(", ") }}\nDict: {{ myData.dict.key1 }}, {{ myData.dict.key2 }}, {{ myData.dict.key3 }}
          `;
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('List: A, B, C\nDict: A, B, C');
      });

      it('should handle async lookup keys', async () => {
        const context = {
          async getData() {
            await delay(5);
            return { theKey: 'value' };
          },
          async getKey() {
            await delay(5);
            return 'theKey';
          }
        };

        const template = '{% set key = getKey() %}{{ (getData())[key] }}';
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('value');
      });
    });

    describe('Async Dictionary Template Operations', () => {

      it('should handle dictionary creation with async values in template', async () => {
        const context = {
          async getKetchupAmount() {
            await delay(5);
            return '5 tbsp';
          },
          async getMustardAmount() {
            await delay(3);
            return '1 tbsp';
          }
        };

        const template = `
			{%- set recipe = {
			  ketchup: getKetchupAmount(),
			  mustard: getMustardAmount(),
			  pickle: '0 tbsp'
			} -%}
			{%- for ingredient, amount in recipe -%}
			  {{ amount }} of {{ ingredient }}
			{%- endfor -%}
		  `;
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('5 tbsp of ketchup1 tbsp of mustard0 tbsp of pickle');
      });

      it('should handle array of dictionaries creation with async values', async () => {
        const context = {
          async getTitle1() {
            await delay(5);
            return 'foo';
          },
          async getTitle2() {
            await delay(3);
            return 'bar';
          }
        };

        const template = `
			{%- set items = [
			  { title: getTitle1(), id: 1 },
			  { title: getTitle2(), id: 2 }
			] -%}
			{%- for item in items -%}
			  {{ item.title }}:{{ item.id }}
			{%- endfor -%}
		  `;
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('foo:1bar:2');
      });

    });

    describe('Basic Array/Dict Creation and Access', () => {
      it('should handle arrays with elements resolved in parallel for filter', async () => {
        const context = {
          async getItem1() { await delay(2); return 'Item1'; },
          async getItem2() { await delay(1); return 'Item2'; }
        };
        const template = '{% set myArray = [getItem1(), getItem2()] %}{{ myArray | join(", ") }}';
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Item1, Item2');
      });

      it('should handle dictionaries with values resolved in parallel for access', async () => {
        const context = {
          async getValue1() { await delay(2); return 'Value1'; },
          async getValue2() { await delay(1); return 'Value2'; }
        };
        const template = '{% set myDict = {"key1": getValue1(), "key2": getValue2()} %}{{ myDict["key1"] }}, {{ myDict["key2"] }}';
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Value1, Value2');
      });

      it('should handle async lookup keys', async () => {
        const context = {
          async getData() { await delay(5); return { theKey: 'value' }; },
          async getKey() { await delay(5); return 'theKey'; }
        };
        const template = '{% set key = getKey() %}{{ (getData())[key] }}';
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('value');
      });

      it('should handle quoted string keys with async values', async () => {
        const context = {
          async getAmount1() { await delay(5); return '5 tbsp'; },
          async getAmount2() { await delay(3); return '1 tbsp'; }
        };
        const template = `
          {%- set recipe = {
            "ketchup": getAmount1(),
            'mustard': getAmount2(),
            pickle: '0 tbsp'
          } -%}
          {%- for ingredient, amount in recipe -%}
            {{ amount }} of {{ ingredient }}
          {% endfor -%}
        `;
        const result = await env.renderTemplateString(template, context);
        expect(normalizeWhitespace(result)).to.equal('5 tbsp of ketchup 1 tbsp of mustard 0 tbsp of pickle');
      });
    });

    describe('Direct Output', () => {
      it('should handle direct output of an array with async elements', async () => {
        const context = {
          async getItem1() { await delay(2); return 'One'; },
          async getItem2() { await delay(1); return 2; }
        };
        // Default array toString joins with comma
        const template = '{% set myArray = [getItem1(), getItem2(), "Three", null, undefined] %}{{ myArray }}';
        const result = await env.renderTemplateString(template, context);
        // Expect deep resolution before output converts array to string (null/undefined become empty string)
        expect(result.trim()).to.equal('One,2,Three,,');
      });

      // Direct output of {{ myDict }} usually results in '[object Object]'
      // Testing specific stringification requires filters like 'dump' or iteration.
    });

    describe('Filter Interactions', () => {
      it('should handle |length filter on array with async elements without resolving them', async () => {
        const context = {
          async getItem1() { await delay(2); return 'One'; },
          async getItem2() { await delay(1); return 'Two'; }
        };
        // Length should not require resolving the promises inside
        const template = '{% set myArray = [getItem1(), getItem2(), 3] %}{{ myArray | length }}';
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('3');
      });

      it('should handle |sort filter on array with async elements (requires resolution)', async () => {
        const context = {
          async getC() { await delay(3); return 'C'; },
          async getA() { await delay(1); return 'A'; },
          async getB() { await delay(2); return 'B'; }
        };
        // Sort needs the actual values
        const template = '{% set myArray = [getC(), getA(), getB()] %}{{ myArray | sort | join("-") }}';
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('A-B-C');
      });

      it('should handle |sum filter on array with async numbers (requires resolution)', async () => {
        const context = {
          async getNum1() { await delay(3); return 10; },
          async getNum2() { await delay(1); return 5; },
          async getNum3() { await delay(2); return 3; }
        };
        const template = '{% set myNums = [getNum1(), getNum2(), getNum3(), 2] %}{{ myNums | sum }}';
        const result = await env.renderTemplateString(template, context);
        // Sum needs the actual values: 10 + 5 + 3 + 2 = 20
        expect(result.trim()).to.equal('20');
      });
    });

    describe('Function Arguments', () => {
      it('should pass array with async elements to function (expecting deep resolution)', async () => {
        const context = {
          async getItem1() { await delay(2); return 'One'; },
          async getItem2() { await delay(1); return 2; },
          inspectArray(arr) {
            return `First: ${arr[0]}, Length: ${arr.length}`;
          }
        };
        const template = '{% set myArray = [getItem1(), getItem2(), 3] %}{{ inspectArray(myArray) }}';
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('First: One, Length: 3');
      });

      it('should pass dictionary with async values to function (expecting deep resolution)', async () => {
        const context = {
          async getValA() { await delay(2); return 'A'; },
          async getValB() { await delay(1); return 'B'; },
          inspectDict(dict) {
            return `KeyA: ${dict.keyA}, KeyB: ${dict.keyB}`;
          }
        };
        const template = '{% set myDict = {keyA: getValA(), keyB: getValB(), keyC: 3} %}{{ inspectDict(myDict) }}';
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('KeyA: A, KeyB: B');
      });
    });

    describe('Iteration', () => {
      it('should handle iteration over dictionary with async values', async () => {
        const context = {
          async getKetchupAmount() { await delay(5); return '5 tbsp'; },
          async getMustardAmount() { await delay(3); return '1 tbsp'; }
        };
        const template = `
          {%- set recipe = {
            ketchup: getKetchupAmount(),
            mustard: getMustardAmount(),
            pickle: '0 tbsp'
          } -%}
          {%- for ingredient, amount in recipe -%}
            {{ amount }} of {{ ingredient }}.
          {%- endfor -%}
          `;
        const result = await env.renderTemplateString(template, context);
        expect(normalizeWhitespace(result)).to.equal('5 tbsp of ketchup.1 tbsp of mustard.0 tbsp of pickle.');
      });

      it('should handle iteration over array of dictionaries with async values', async () => {
        const context = {
          async getTitle1() { await delay(5); return 'foo'; },
          async getTitle2() { await delay(3); return 'bar'; }
        };
        const template = `
          {%- set items = [
            { title: getTitle1(), id: 1 },
            { title: getTitle2(), id: 2 }
          ] -%}
          {%- for item in items -%}
            {{ item.title }}:{{ item.id }}.
          {%- endfor -%}
          `;
        const result = await env.renderTemplateString(template, context);
        expect(normalizeWhitespace(result)).to.equal('foo:1.bar:2.');
      });
    });

    describe('Nested Structures', () => {
      it('should handle nested arrays and dictionaries with async elements resolved in parallel', async () => {
        const context = {
          async getValueA() { await delay(3); return 'A'; },
          async getValueB() { await delay(2); return 'B'; },
          async getValueC() { await delay(1); return 'C'; }
        };
        const template = `
            {%- set myData = {
              "list": [getValueA(), getValueB(), getValueC()],
              "dict": {
                "key1": getValueA(),
                "key2": getValueB(),
                "key3": getValueC()
              }
            } -%}
            List: {{ myData.list | join(", ") }}\nDict: {{ myData.dict.key1 }}, {{ myData.dict.key2 }}, {{ myData.dict.key3 }}
          `;
        const result = await env.renderTemplateString(template, context);
        expect(normalizeWhitespace(result)).to.equal('List: A, B, C Dict: A, B, C');
      });

      it('should handle access through nested array/dictionary with async values', async () => {
        const context = {
          async getName() { await delay(1); return 'Alice'; },
          async getRole() { await delay(2); return 'Admin'; }
        };
        const template = `
            {%- set data = {
              users: [
                { id: 1, profile: { name: getName(), role: "User" } },
                { id: 2, profile: { name: "Bob", role: getRole() } }
              ]
            } -%}
            User1: {{ data.users[0].profile.name }} ({{ data.users[0].id }})
            User2 Role: {{ data.users[1].profile.role }}
        `;
        const result = await env.renderTemplateString(template, context);
        expect(normalizeWhitespace(result)).to.equal('User1: Alice (1) User2 Role: Admin');
      });

      it('should handle join on nested array within dict with async elements', async () => {
        const context = {
          async getTag1() { await delay(1); return 'async'; },
          async getTag2() { await delay(2); return 'parallel'; }
        };
        const template = `
            {%- set item = {
                id: 123,
                tags: [getTag1(), getTag2(), "test"]
            } -%}
            Tags: {{ item.tags | sort | join(', ') }}
        `;
        const result = await env.renderTemplateString(template, context);
        // Requires sort (and thus join) to handle resolved values
        expect(normalizeWhitespace(result)).to.equal('Tags: async, parallel, test');
      });

      it('should handle array of arrays with async elements', async () => {
        const context = {
          async getA1() { await delay(3); return 'A1'; },
          async getB2() { await delay(1); return 'B2'; }
        };
        const template = `
            {%- set myMatrix = [
              [getA1(), "A2", true],
              ["B1", getB2()],
              ["C1", "C2", null]
            ] -%}
            {# Test direct access after expected deep resolution #}
            Access: {{ myMatrix[0][0] }}, {{ myMatrix[1][1] }}
            {# Test filter on inner array #}
            Inner Join: {{ myMatrix[0] | join('-') }}
            {# Test filter on outer array (relies on inner array toString) #}
            Outer Join: {{ myMatrix | join(' | ') }}
        `;
        const result = await env.renderTemplateString(template, context);
        // Expected results after deep resolution of promises inside the nested arrays
        const expectedOutput = `
            Access: A1, B2
            Inner Join: A1-A2-true
            Outer Join: A1,A2,true | B1,B2 | C1,C2,
        `.trim().replace(/\s+/g, ' '); // Normalize whitespace

        expect(normalizeWhitespace(result)).to.equal(expectedOutput);
      });

      it('should handle direct access in array of objects with async property values', async () => {
        const context = {
          async getTitle1() { await delay(5); return 'Async Foo'; },
          async getTitle2() { await delay(3); return 'Async Bar'; }
        };
        const template = `
            {%- set items = [
              { title: getTitle1(), id: 1, status: "pending" },
              { title: getTitle2(), id: 2, status: "done" }
            ] -%}
            {# Access properties directly via index #}
            Item 1 Title: {{ items[0].title }}
            Item 2 Status: {{ items[1].status }}
            Item 2 ID: {{ items[1].id }}
        `;
        const result = await env.renderTemplateString(template, context);
        const expectedOutput = `
            Item 1 Title: Async Foo
            Item 2 Status: done
            Item 2 ID: 2
        `.trim().replace(/\s+/g, ' '); // Normalize whitespace

        expect(normalizeWhitespace(result)).to.equal(expectedOutput);
      });

    }); // End Nested Structure

    describe('Lazy Deep Resolve Verification', () => {
      it('should handle deeply nested arrays with promises', async () => {
        const context = {
          async getDeep() { await delay(5); return 'DeepValue'; }
        };
        const template = `
          {% set nested = [[[[getDeep()]]]] %}
          {{ nested[0][0][0][0] }}
        `;
        const result = await env.renderTemplateString(template, context);
        expect(normalizeWhitespace(result)).to.equal('DeepValue');
      });

      it('should handle deeply nested objects with promises', async () => {
        const context = {
          async getDeep() { await delay(5); return 'DeepObjectValue'; }
        };
        const template = `
          {% set nested = { a: { b: { c: { d: getDeep() } } } } %}
          {{ nested.a.b.c.d }}
        `;
        const result = await env.renderTemplateString(template, context);
        expect(normalizeWhitespace(result)).to.equal('DeepObjectValue');
      });

      it('should handle mixed structures with multiple async levels', async () => {
        const context = {
          async getL1() { await delay(5); return 'L1'; },
          async getL2() { await delay(10); return 'L2'; },
          async getL3() { await delay(15); return 'L3'; }
        };
        const template = `
          {% set mixed = {
             level1: getL1(),
             deep: [
               { level2: getL2(), deeper: [getL3()] }
             ]
          } %}
          {{ mixed.level1 }}-{{ mixed.deep[0].level2 }}-{{ mixed.deep[0].deeper[0] }}
        `;
        const result = await env.renderTemplateString(template, context);
        expect(normalizeWhitespace(result)).to.equal('L1-L2-L3');
      });

      it('should correctly propagate errors from deep nested promises', async () => {
        const context = {
          async getSuccess() { return 'ok'; },
          async getFail() { throw new Error('DeepFailure'); }
        };
        const template = `
          {% set item = {
             good: getSuccess(),
             bad: {
                nested: {
                   fail: getFail()
                }
             }
          } %}
          {{ item.good }}
        `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown an error');
        } catch (err) {
          expect(err.message).to.contain('DeepFailure');
        }
      });

      it('should collect ALL errors from multiple failing branches', async () => {
        const context = {
          async fail1() { await delay(2); throw new Error('ErrorOne'); },
          async fail2() { await delay(2); throw new Error('ErrorTwo'); }
        };
        const template = `
          {% set item = {
             a: fail1(),
             b: [ fail2() ]
          } %}
          {{ item.a }}
        `;

        try {
          await env.renderTemplateString(template, context);
          expect().fail('Should have thrown an error');
        } catch (err) {
          expect(err.message).to.contain('ErrorOne');
          expect(err.message).to.contain('ErrorTwo');
        }
      });

      it('should resolve lazy structures passed to functions', async () => {
        const context = {
          async val() { return 'lazy'; },
          check(obj) {
            if (obj.prop !== 'lazy') return 'fail';
            return 'pass';
          }
        };
        const template = `{% set o = { prop: val() } %}{{ check(o) }}`;
        const result = await env.renderTemplateString(template, context);
        expect(normalizeWhitespace(result)).to.equal('pass');
      });

      it('should not resolve external context objects deeply', async () => {
        let accessCount = 0;
        const externalObj = {
          get prop() { accessCount++; return 'static'; },
          asyncProp: Promise.resolve('async')
        };
        const context = {
          ext: externalObj,
          async val() { return 'dynamic'; }
        };

        const template = `{% set newObj = { wrapper: ext, val: val() } %}{{ newObj.val }}`;

        const result = await env.renderTemplateString(template, context);
        expect(normalizeWhitespace(result)).to.equal('dynamic');

        expect(accessCount).to.be.lessThan(2);
      });
    });

  });

  describe('Async Structures and Functions in Scripts', function () {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });
    it('should handle promise properties at different levels in script', async () => {
      const context = {
        async getA() { await delay(2); return 'A'; },
        async getB() { await delay(10); return 'B'; },
        async getC() { await delay(5); return 'C'; }
      };
      const script = `
          :data
          var complex = {
             l1: getA(),
             nested: {
                l2: getB(),
                deep: [getC()]
             }
          }

          // Access individual promises (triggers lazy resolve for specific paths if needed,
          // or just standard property access if resolving later)

          // In scripts, 'var' assignment of object literal creates the marked object.
          // Accessing 'complex.nested.l2' should wait for resolution if it's used in an output or operation?
          // Actually, in Cascada Script, variables hold the raw values (promises/markers).
          // They are resolved when:
          // 1. Used in @output commands (like @data, @text)
          // 2. Used in expressions that require values (like math, string concat) - handled by compiler-base expression compilation

          @data.val1 = complex.l1
          @data.val2 = complex.nested.l2
          @data.val3 = complex.nested.deep[0]
        `;

      const result = await env.renderScriptString(script, context);
      expect(result).to.eql({
        val1: 'A',
        val2: 'B',
        val3: 'C'
      });
    });

    it('should pass lazy-resolved structures to functions in script', async () => {
      const context = {
        async getName() { return 'Alice'; },
        async getRole() { return 'Admin'; },

        formatUser(user) {
          // The function receives the object. If the object passed is a Lazy Object,
          // the runtime (resolveArguments) MUST ensure it is resolved before calling this function?
          // OR the function receives the promise/marker?

          // Current design: resolveArguments (used by call usage) triggers resolving of arguments.
          // So 'user' should be a plain object with 'name' and 'role' fully resolved.
          return user.name + ':' + user.role;
        }
      };

      const script = `
           :data
           var user = { name: getName(), role: getRole() }

           // Passing 'user' to formatUser.
           // The compiler generates code that wraps args in runtime.resolveArguments or resolves them before call.
           @data.formatted = formatUser(user)
         `;

      const result = await env.renderScriptString(script, context);
      expect(result).to.eql({ formatted: 'Alice:Admin' });
    });

    it('should handle array iteration in script with lazy elements', async () => {
      const context = {
        async getItems() { return ['i1', 'i2']; }, // async return of array
        async getOne() { return 'one'; },
        async getTwo() { return 'two'; }
      };

      const script = `
            :text
            var list = [getOne(), getTwo()]

            // Loop over lazy array
            for item in list
               @text(item + "-")
            endfor
         `;

      const result = await env.renderScriptString(script, context);
      expect(result).to.equal('one-two-');
    });


    it('should handle deeply nested promises in function calls', async () => {
      const context = {
        async getDeep() { return 'found'; },
        inspect(obj) {
          return obj.a.b.c;
        }
      };

      const script = `
            :data
            var obj = { a: { b: { c: getDeep() } } }
            @data.result = inspect(obj)
          `;

      const result = await env.renderScriptString(script, context);
      expect(result).to.eql({ result: 'found' });
    });
    it('should handle loop with intermediate usage and mixed aggregation', async () => {
      const context = {
        getVal: async (i) => i
      };

      const script = `
         :data
         var data = {}
         var total = 0

         for i in [1, 2, 3]
           var v = getVal(i)
           data[i] = v
         endfor

         @data.res = data
      `;

      const result = await env.renderScriptString(script, context);
      expect(result.res).to.eql({ '1': 1, '2': 2, '3': 3 });
    });
  });
}());
