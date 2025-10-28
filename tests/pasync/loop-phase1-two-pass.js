(function () {
  'use strict';

  var expect;
  var AsyncEnvironment;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment/environment').AsyncEnvironment;
  } else {
    expect = window.expect;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
  }

  describe('Phase 1: Loop Two-Pass Compilation', () => {
    let env;

    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Test 1.1: Body writes tracked', () => {
      it('should track writes in loop body', async () => {
        const script = `
          :data
          var total = 0
          for i in [1, 2, 3]
            total = total + i
          endfor
          @data.total = total
        `;

        const result = await env.renderScriptString(script);
        expect(result.total).to.be(6);
        // Verifies: bodyWriteCounts collected, loop executes correctly
      });
    });

    describe('Test 1.2: Else writes tracked', () => {
      it('should track writes in else block (Phase 3)', async () => {
        const script = `
          :data
          var total = 0
          for i in []
            total = total + i
          else
            total = 100
          endfor
          @data.total = total
        `;

        const result = await env.renderScriptString(script);
        expect(result.total).to.be(100);
        // Verifies: elseWriteCounts collected, else executes when empty
      });
    });

    describe('Test 1.X: Loop write tracking in Both blocks', () => {

      it('should track writes in both blocks', async () => {
        // @todo - soft and hard iterator error
        // @todo - separate test with output poisoning
        const script = `
          :data
          var sum = 0 // two writes in body, one write in else
          var body = 0 // one write in body
          var els = 0 // one write in else
          var body2 = 2 // two writes in body
          var els2 = 2 // two writes in else
          for i in items
            sum = sum + i // 0+1=1, 1+2=3, 3+3=6
            body = body + sum // 0+1=1, 1+4=5, 5+9=14
            sum = sum + i // 6+1=7, 7+2=9, 9+3=12
            body2 = i+1 // 1+1=2, 2+1=3, 3+1=4
            body2 = body2 + i // 2+1=3, 3+2=5, 4+3=7
          else
            sum = 100
            els = 50
            els2 = sum
            els2 = els2 + 1
          endfor
          @data.sum = sum
          @data.body = body
          @data.els = els
          @data.body2 = body2
          @data.els2 = els2
        `;

        // test body
        const result = await env.renderScriptString(script, {items: [1, 2, 3]});
        expect(result.sum).to.be(12);
        expect(result.body).to.be(14);
        expect(result.els).to.be(0);
        expect(result.body2).to.be(7);
        expect(result.els2).to.be(2);

        // test else
        const result2 = await env.renderScriptString(script, {items: []});
        expect(result2.sum).to.be(100);
        expect(result2.body).to.be(0);
        expect(result2.els).to.be(50);
        expect(result2.body2).to.be(2);
        expect(result2.els2).to.be(101);
        // Verifies: elseWriteCounts collected, else executes when empty
      });
    });

    describe('Test 1.3: Handler collection from body', () => {
      it('should collect handlers from loop body', async () => {
        const script = `
          :data
          for i in [1, 2, 3]
            @data.items.push(i)
          endfor
        `;

        const result = await env.renderScriptString(script);
        expect(result.items).to.eql([1, 2, 3]);
        // Verifies: handlers collected, output produced correctly
      });
    });

    describe('Test 1.4: Handler collection from else', () => {
      it('should collect handlers from else block', async () => {
        const script = `
          :data
          for i in []
            @data.items.push(i)
          else
            @data.empty = true
          endfor
        `;

        const result = await env.renderScriptString(script);
        expect(result.empty).to.be(true);
        // Verifies: else handlers collected, else output correct
      });
    });

    describe('Test 1.5: No regressions', () => {
      it('should handle nested loops', async () => {
        const script = `
          :data
          for i in [1, 2]
            for j in [10, 20]
              @data.results.push(i * j)
            endfor
          endfor
        `;

        const result = await env.renderScriptString(script);
        expect(result.results).to.eql([10, 20, 20, 40]);
      });

      it('should handle while loops', async () => {
        const context = {
          state: {
            count: 0,
            async checkCondition() {
              this.count++;
              return this.count <= 3;
            },
            getValue() {
              return this.count - 1;
            }
          }
        };
        const script = `
          :data
          var total = 0
          while state!.checkCondition()
            total = total + state.getValue()
          endwhile
          @data.total = total
        `;

        const result = await env.renderScriptString(script, context);
        expect(result.total).to.be(3); // 0 + 1 + 2
      });

      it('should handle object iteration', async () => {
        const context = { obj: { a: 1, b: 2, c: 3 } };
        const script = `
          :data
          var sum = 0
          for key, val in obj
            sum = sum + val
          endfor
          @data.sum = sum
        `;

        const result = await env.renderScriptString(script, context);
        expect(result.sum).to.be(6);
      });

      it('should handle sequential loops with writes', async () => {
        const script = `
          :data
          var items = []
          for i in [1, 2, 3]
            items = items.concat([i])
          endfor
          @data.items = items
        `;

        const result = await env.renderScriptString(script);
        expect(result.items).to.eql([1, 2, 3]);
      });

      it('should handle async iterators', async () => {
        async function* gen() {
          yield 1;
          yield 2;
          yield 3;
        }

        const context = { gen };
        const script = `
          :data
          var sum = 0
          for item in gen()
            sum = sum + item
          endfor
          @data.sum = sum
        `;

        const result = await env.renderScriptString(script, context);
        expect(result.sum).to.be(6);
      });

      it('should handle template for loops with async functions', async () => {
        const context = {
          items: [1, 2, 3],
          async getData(id) {
            return `Item ${id}`;
          }
        };

        const template = `
          {%- for item in items %}
            - {{ getData(item) }}
          {%- endfor %}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result).to.contain('Item 1');
        expect(result).to.contain('Item 2');
        expect(result).to.contain('Item 3');
      });

      it('should handle template for loops with else', async () => {
        const context = {
          async getItems() {
            return [];
          }
        };

        const template = `
          {% for item in getItems() %}
            {{ item }}
          {% else %}
            no items
          {% endfor %}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('no items');
      });

      it('should handle template while loops', async () => {
        const context = {
          state: {
            counter: 0,
            async shouldContinue() {
              this.counter++;
              return this.counter <= 3;
            },
            async getValue() {
              return this.counter;
            }
          }
        };

        const template = `
          {%- while state!.shouldContinue() -%}
            {{ state.getValue() }},
          {%- endwhile -%}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('1,2,3,');
      });

      it('should handle nested for loops with async functions', async () => {
        const context = {
          users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
          async getPosts(userId) {
            return [`Post 1 by User ${userId}`, `Post 2 by User ${userId}`];
          }
        };

        const template = `
          {%- for user in users %}
            {{ user.name }}:
            {%- for post in getPosts(user.id) %}
              - {{ post }}
            {%- endfor %}
          {%- endfor %}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result).to.contain('Alice:');
        expect(result).to.contain('Post 1 by User 1');
        expect(result).to.contain('Bob:');
        expect(result).to.contain('Post 1 by User 2');
      });

      it('should handle loops modifying outer scope variables', async () => {
        const context = {
          items: [1, 2, 3],
          async getValue(id) {
            return id * 10;
          }
        };

        const template = `
          {% set total = 0 %}
          {%- for item in items -%}
            {% set total = total + getValue(item) %}
          {%- endfor -%}
          {{ total }}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('60');
      });

      it('should handle array unpacking in loops', async () => {
        const context = {
          users: [
            ['John', 30],
            ['Jane', 25],
            ['Bob', 35]
          ],
          async processUser(name, age) {
            return `${name} is ${age} years old`;
          }
        };

        const template = `
          {%- for name, age in users %}
            {{ processUser(name, age) }}
          {%- endfor %}`;

        const result = await env.renderTemplateString(template, context);
        expect(result).to.contain('John is 30 years old');
        expect(result).to.contain('Jane is 25 years old');
        expect(result).to.contain('Bob is 35 years old');
      });

      it('should handle object unpacking in loops', async () => {
        const context = {
          userAges: {
            John: 30,
            Jane: 25,
            Bob: 35
          },
          async formatUserAge(name, age) {
            return `${name}: ${age} years`;
          }
        };

        const template = `
          {%- for name, age in userAges %}
            {{ formatUserAge(name, age) }}
          {%- endfor %}`;

        const result = await env.renderTemplateString(template, context);
        expect(result).to.contain('John: 30 years');
        expect(result).to.contain('Jane: 25 years');
        expect(result).to.contain('Bob: 35 years');
      });
    });

    describe('Test 1.6: Legacy asyncEach loops', () => {
      it('should handle basic asyncEach loop', async () => {
        const context = {
          items: [1, 2, 3],
          async processItem(id) {
            return `Processed ${id}`;
          }
        };

        const template = `
          {%- asyncEach item in items -%}
            {{ processItem(item) }}
          {%- endeach -%}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Processed 1Processed 2Processed 3');
      });

      it('should handle asyncEach loop with else block', async () => {
        const context = {
          async getItems() {
            return [];
          },
          async getEmptyMessage() {
            return 'No items found';
          }
        };

        const template = `
          {%- asyncEach item in getItems() -%}
            {{ item }}
          {%- else -%}
            {{ getEmptyMessage() }}
          {%- endeach -%}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('No items found');
      });

      it('should handle asyncEach loop with variable accumulation', async () => {
        const context = {
          items: [10, 20, 30],
          async getIncrement(val) {
            return val;
          }
        };

        const template = `
          {% set total = 0 %}
          {%- asyncEach item in items -%}
            {%- set increment = getIncrement(item) -%}
            {%- set total = total + increment -%}
          {%- endeach -%}
          {{ total }}
        `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('60');
      });
    });

    describe('Test 1.7: Complex nested scenarios', () => {
      it('should handle deeply nested loops with writes', async () => {
        const script = `
          :data
          var result = 0
          for i in [1, 2]
            for j in [10, 20]
              for k in [100, 200]
                result = result + (i * j * k)
              endfor
            endfor
          endfor
          @data.result = result
        `;

        const output = await env.renderScriptString(script);
        // (1*10*100) + (1*10*200) + (1*20*100) + (1*20*200) + (2*10*100) + (2*10*200) + (2*20*100) + (2*20*200)
        // = 1000 + 2000 + 2000 + 4000 + 2000 + 4000 + 4000 + 8000 = 27000
        expect(output.result).to.be(27000);
      });

      // @todo - side-effect poisoning is not supported yet
      it.skip('should handle for loop with nested while loop (Phase 3/5)', async () => {
        const context = {
          outerItems: [1, 2],
          state: {
            counter: 0,
            async shouldContinue() {
              this.counter++;
              return this.counter % 3 !== 0;
            },
            reset() {
              this.counter = 0;
            }
          }
        };

        const script = `
          :data
          for outer in outerItems
            @data.results.push(outer)
            while state!.shouldContinue()
              @data.results.push(state.counter)
            endwhile
            state.reset()
          endfor
        `;

        const output = await env.renderScriptString(script, context);
        expect(output.results).to.eql([1, 1, 2, 2, 1, 2]);
      });

      it('should handle while loop with nested for loop', async () => {
        const context = {
          state: {
            counter: 0,
            async shouldContinue() {
              this.counter++;
              return this.counter <= 2;
            }
          }
        };

        const script = `
          :data
          while state!.shouldContinue()
            for i in [10, 20]
              @data.results.push(state.counter * i)
            endfor
          endwhile
        `;

        const output = await env.renderScriptString(script, context);
        expect(output.results).to.eql([10, 20, 20, 40]);
      });
    });

    describe('Test 1.8: Handler collection edge cases', () => {
      it('should collect multiple different handlers from loop body', async () => {
        const script = `
          :data
          for i in [1, 2]
            @data.numbers.push(i)
          endfor
        `;

        const result = await env.renderScriptString(script);
        expect(result.numbers).to.eql([1, 2]);
      });

      it('should collect handlers from nested control structures in loop', async () => {
        const script = `
          :data
          for i in [1, 2, 3]
            if i % 2 == 0
              @data.even.push(i)
            else
              @data.odd.push(i)
            endif
          endfor
        `;

        const result = await env.renderScriptString(script);
        expect(result.even).to.eql([2]);
        expect(result.odd).to.eql([1, 3]);
      });
    });
  });
})();

