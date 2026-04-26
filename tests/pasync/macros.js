(function () {
  'use strict';

  var expect;
  //var unescape;
  var AsyncEnvironment;
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

  describe('Async mode - macros', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Nunjucks Async Macro Handling Tests', () => {
      it('should handle async function passed as argument to macro', async () => {
        const context = {
          async getName() {
            await delay(5);
            return 'Alice';
          }
        };

        const script = `
        var result = {}
        function greet(name)
          data greetResult
          greetResult.user.name = name
          greetResult.user.greeted = true
          return greetResult.snapshot()
        endfunction

        var macroResult = greet(getName())
        result.output = macroResult.user

        return result`;

        const output = await env.renderScriptString(script, context);
        expect(output.output).to.eql({
          name: 'Alice',
          greeted: true
        });
      });

      it('should handle async function called within macro (template)', async () => {
        const context = {
          async getName() {
            await delay(5);
            return 'Bob';
          }
        };

        const template = `
          {%- macro greet() -%}
            Hello, {{ getName() }}!
          {%- endmacro -%}
          {{ greet() }}
          `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Hello, Bob!');
      });

      it('should handle async function called within macro (script)', async () => {
        const context = {
          async getName() {
            await delay(5);
            return 'Bob';
          },
          async getUserId() {
            await delay(3);
            return 42;
          }
        };

        const script = `
        var result = {}
        function greet()
          data greetResult
          greetResult.user.name = getName()
          greetResult.user.id = getUserId()
          return greetResult.snapshot()
        endfunction

        var macroResult = greet()
        result.output = macroResult.user

        return result`;

        const output = await env.renderScriptString(script, context);
        expect(output.output).to.eql({
          name: 'Bob',
          id: 42
        });
      });

      it('should handle macro using async variable from context', async () => {
        const context = {
          async getGreetingType() {
            await delay(2);
            return 'formal';
          },
          async getUserScore() {
            await delay(3);
            return 95;
          }
        };

        const script = `
        var result = {}
        function greet()
          data greetResult
          greetResult.greeting.type = getGreetingType()
          greetResult.greeting.score = getUserScore()
          return greetResult.snapshot()
        endfunction

        var macroResult = greet()
        result.output = macroResult.greeting

        return result`;

        const output = await env.renderScriptString(script, context);
        expect(output.output).to.eql({
          type: 'formal',
          score: 95
        });
      });

      it('should handle async logic inside macro', async () => {
        const context = {
          async getTemperature() {
            await delay(2);
            return 72;
          },
          async getHumidity() {
            await delay(3);
            return 65;
          }
        };

        const script = `
        var result = {}
        function getWeather()
          data weatherResult
          weatherResult.weather.temperature = getTemperature()
          weatherResult.weather.humidity = getHumidity()
          return weatherResult.snapshot()
        endfunction

        var weatherData = getWeather()
        result.output = weatherData.weather

        return result`;

        const output = await env.renderScriptString(script, context);
        expect(output.output).to.eql({
          temperature: 72,
          humidity: 65
        });
      });

      it('should handle macros returning numeric calculations', async () => {
        const context = {
          async getPrice() {
            await delay(2);
            return 100;
          },
          async getTaxRate() {
            await delay(3);
            return 0.08;
          }
        };

        const script = `
        var result = {}
        function calculateTotal()
          data calcResult
          var price = getPrice()
          var taxRate = getTaxRate()
          calcResult.calculation.basePrice = price
          calcResult.calculation.tax = price * taxRate
          calcResult.calculation.total = price + (price * taxRate)
          return calcResult.snapshot()
        endfunction

        var macroResult = calculateTotal()
        result.output = macroResult.calculation

        return result`;

        const output = await env.renderScriptString(script, context);
        expect(output.output).to.eql({
          basePrice: 100,
          tax: 8,
          total: 108
        });
      });
    });

    describe('Async operations in macros', () => {
      it('should handle async functions in macro calls', async () => {
        const context = {
          async fetchScore(id) {
            await delay(5);
            return id === 1 ? 95 : 87;
          }
        };

        const script = `
        data result
        function getStats(id)
          var statsResult = {}
          statsResult.id = id
          statsResult.score = fetchScore(id)
          return statsResult
        endfunction

        var stats1 = getStats(1)
        var stats2 = getStats(2)
        result.results.push(stats1)
        result.results.push(stats2)

        return result.snapshot()`;

        const output = await env.renderScriptString(script, context);
        expect(output.results).to.eql([
          { id: 1, score: 95 },
          { id: 2, score: 87 }
        ]);
      });

      it('should handle async functions in macro call arguments', async () => {
        const context = {
          async fetchTitle() {
            await delay(5);
            return 'Async Title';
          },
          async fetchContent() {
            await delay(3);
            return 'Async Content';
          }
        };

        const template = `
          {% macro article(title, content) %}
          <article>
            <h1>{{ title }}</h1>
            <p>{{ content }}</p>
          </article>
          {% endmacro %}

          {{ article(fetchTitle(), fetchContent()) }}
          `;

        const result = await env.renderTemplateString(template, context);
        expect(unescape(result.trim())).to.equal(`
          <article>
            <h1>Async Title</h1>
            <p>Async Content</p>
          </article>
          `.trim());
      });

      it('should handle async macro call arguments with dependent function in macro body', async () => {
        const context = {
          async fetchUser(id) {
            await delay(5);
            return { id, name: `User ${id}` };
          },
          async fetchUserPosts(userId) {
            await delay(3);
            return [`Post 1 by User ${userId}`, `Post 2 by User ${userId}`];
          }
        };

        const template = `
          {%- macro userProfile(user) -%}
          <div class="user-profile">
            <h2>{{ user.name }}</h2>
            <h3>Posts:</h3>
            <ul>
            {%- for post in fetchUserPosts(user.id) %}
              <li>{{ post }}</li>
            {%- endfor %}
            </ul>
          </div>
          {%- endmacro %}

          {{ userProfile(fetchUser(1)) }}
          `;

        const result = await env.renderTemplateString(template, context);
        expect(unescape(result.trim())).to.equal(`
          <div class="user-profile">
            <h2>User 1</h2>
            <h3>Posts:</h3>
            <ul>
              <li>Post 1 by User 1</li>
              <li>Post 2 by User 1</li>
            </ul>
          </div>
          `.trim());
      });

      it('should handle multiple async macro call arguments (template)', async () => {
        const context = {
          async fetchHeader() {
            await delay(5);
            return 'Async Header';
          },
          async fetchFooter() {
            await delay(4);
            return 'Async Footer';
          },
          async fetchContent() {
            await delay(3);
            return 'Async Content';
          }
        };

        const template = `
          {% macro page(header, content, footer) %}
          <div class="page">
            <header>{{ header }}</header>
            <main>{{ content }}</main>
            <footer>{{ footer }}</footer>
          </div>
          {% endmacro %}

          {{ page(fetchHeader(), fetchContent(), fetchFooter()) }}
          `;

        const result = await env.renderTemplateString(template, context);
        expect(unescape(result.trim())).to.equal(`
          <div class="page">
            <header>Async Header</header>
            <main>Async Content</main>
            <footer>Async Footer</footer>
          </div>
          `.trim());
      });

      it('should handle multiple async macro call arguments (script)', async () => {
        const context = {
          async fetchViewCount() {
            await delay(5);
            return 1250;
          },
          async fetchLikeCount() {
            await delay(4);
            return 89;
          },
          async fetchCommentCount() {
            await delay(3);
            return 42;
          }
        };

        const script = `
        var result = {}
        function getPageStats(views, likes, comments)
          data statsResult
          statsResult.stats.views = views
          statsResult.stats.likes = likes
          statsResult.stats.comments = comments
          statsResult.stats.engagement = likes + comments
          return statsResult.snapshot()
        endfunction

        var macroResult = getPageStats(fetchViewCount(), fetchLikeCount(), fetchCommentCount())
        result.output = macroResult.stats

        return result`;

        const output = await env.renderScriptString(script, context);
        expect(output.output).to.eql({
          views: 1250,
          likes: 89,
          comments: 42,
          engagement: 131
        });
      });

      it('should handle nested async macro calls (template)', async () => {
        const context = {
          async fetchUser(id) {
            await delay(5);
            return { id, name: `User ${id}` };
          },
          async fetchUserRole(userId) {
            await delay(3);
            return userId % 2 === 0 ? 'Admin' : 'User';
          }
        };

        const template = `
          {%- macro userRole(userId) -%}
          {{ fetchUserRole(userId) }}
          {%- endmacro -%}

          {%- macro userProfile(user) -%}
          <div class="user-profile">
            <h2>{{ user.name }}</h2>
            <p>Role: {{ userRole(user.id) }}</p>
          </div>
          {%- endmacro %}
          {{ userProfile(fetchUser(1)) }}
          {{ userProfile(fetchUser(2)) }}
          `;

        const result = await env.renderTemplateString(template, context);
        expect(unescape(result.trim())).to.equal(`
          <div class="user-profile">
            <h2>User 1</h2>
            <p>Role: User</p>
          </div>
          <div class="user-profile">
            <h2>User 2</h2>
            <p>Role: Admin</p>
          </div>
          `.trim());
      });

      it('should handle nested async macro calls (script)', async () => {
        const context = {
          async fetchUser(id) {
            await delay(5);
            return { id, name: `User ${id}`, level: id * 10 };
          },
          async fetchPermissions(level) {
            await delay(3);
            return level >= 20 ? ['read', 'write', 'admin'] : ['read'];
          }
        };

        const script = `
        data result
        function getUserPermissions(level)
          var permResult = {}
          permResult.permissions = fetchPermissions(level)
          return permResult
        endfunction

        function userProfile(user)
          data profileResult
          profileResult.profile.id = user.id
          profileResult.profile.name = user.name
          profileResult.profile.level = user.level
          var perms = getUserPermissions(user.level)
          profileResult.profile.permissions = perms.permissions
          return profileResult.snapshot()
        endfunction

        var user1 = userProfile(fetchUser(1))
        var user2 = userProfile(fetchUser(2))
        result.users.push(user1.profile)
        result.users.push(user2.profile)

        return result.snapshot()`;

        const output = await env.renderScriptString(script, context);
        expect(output.users).to.eql([
          { id: 1, name: 'User 1', level: 10, permissions: ['read'] },
          { id: 2, name: 'User 2', level: 20, permissions: ['read', 'write', 'admin'] }
        ]);
      });

      it('should handle macros with array operations', async () => {
        const context = {
          async fetchItems() {
            await delay(5);
            return [10, 20, 30, 40];
          },
          async getMultiplier() {
            await delay(3);
            return 2;
          }
        };

        const script = `
        var result = {}
        function processItems(items, multiplier)
          data procResult
          procResult.original = items
          for item in items
            procResult.processed.push(item * multiplier)
          endfor
          return procResult.snapshot()
        endfunction

        var procData = processItems(fetchItems(), getMultiplier())
        result.output = procData

        return result`;

        const output = await env.renderScriptString(script, context);
        expect(output.output).to.eql({
          original: [10, 20, 30, 40],
          processed: [20, 40, 60, 80]
        });
      });

      it('should handle macros with conditional numeric logic', async () => {
        const context = {
          async getScore(userId) {
            await delay(5);
            return userId === 1 ? 85 : 92;
          },
          async getBonus(userId) {
            await delay(3);
            return userId === 1 ? 10 : 5;
          }
        };

        const script = `
        data result
        function calculateFinalScore(userId)
          var scoreResult = {}
          var score = getScore(userId)
          var bonus = getBonus(userId)
          var total = score + bonus

          scoreResult.userId = userId
          scoreResult.baseScore = score
          scoreResult.bonus = bonus
          scoreResult.totalScore = total
          scoreResult.grade = "A" if total >= 95 else "B"
          scoreResult.passed = total >= 70
          return scoreResult
        endfunction

        var result1 = calculateFinalScore(1)
        var result2 = calculateFinalScore(2)
        result.students.push(result1)
        result.students.push(result2)

        return result.snapshot()`;

        const output = await env.renderScriptString(script, context);
        expect(output.students).to.eql([
          { userId: 1, baseScore: 85, bonus: 10, totalScore: 95, grade: 'A', passed: true },
          { userId: 2, baseScore: 92, bonus: 5, totalScore: 97, grade: 'A', passed: true }
        ]);
      });
    });

    describe('Async Nunjucks Caller Functionality', () => {

      describe('Async Caller Basic Usage', () => {
        it('should handle async value in caller content', async () => {
          const template = `
            {% macro wrapper() %}
            {{ caller() }}
            {% endmacro %}

            {% call wrapper() %}
            {{ asyncValue }}
            {% endcall %}
          `;

          const context = {
            asyncValue: Promise.resolve('async result')
          };

          const rendered = await env.renderTemplateString(template, context);
          expect(rendered.trim()).to.equal('async result');
        });

        it('caller should work in ternary condition', async () => {
          const template = `
            {% macro add(x, y) %}
            {{ caller() if caller else 0 }}: {{ x + y }}
            {% endmacro%}

            {% call add(1, 2) -%}
            The result is
            {%- endcall %}
          `;

          const result = await env.renderTemplateString(template);
          expect(result.trim()).to.equal('The result is: 3');
        });

        it('should handle multiple async values in caller', async () => {
          const template = `
            {%- macro format() -%}
            Results: {{ caller() }}
            {%- endmacro -%}

            {%- call format() -%}
            {{ firstValue }}, {{ secondValue }}
            {%- endcall -%}
          `;

          const context = {
            firstValue: Promise.resolve('first'),
            secondValue: Promise.resolve('second')
          };

          const rendered = await env.renderTemplateString(template, context);
          expect(rendered.trim()).to.equal('Results: first, second');
        });
      });

      describe('Nested Async Callers', () => {
        it('should handle nested async callers', async () => {
          const template = `
            {%- macro outer() -%}
            Outer({{ caller() }})
            {%- endmacro -%}

            {%- macro inner() -%}
            Inner({{ caller() }})
            {%- endmacro -%}

            {%- call outer() -%}
            {%- call inner() -%}
              {{ asyncValue }}
            {%- endcall -%}
            {%- endcall -%}
          `;

          const context = {
            asyncValue: Promise.resolve('content')
          };

          const rendered = await env.renderTemplateString(template, context);
          expect(rendered.trim()).to.equal('Outer(Inner(content))');
        });

        it('should handle multiple caller invocations across loops and conditionals in the same macro', async () => {
          const template = `
            {%- macro wrap(items, includePrefix) -%}
            {%- if includePrefix -%}
              [{{ caller("prefix") }}]
            {%- endif -%}
            {%- for item in items -%}
              [{{ caller(item) }}]
            {%- endfor -%}
            {%- endmacro -%}

            {%- call(value) wrap(asyncItems, showPrefix) -%}
              {{ asyncRender(value) }}
            {%- endcall -%}
          `;

          const context = {
            asyncItems: Promise.resolve(['a', 'b']),
            showPrefix: Promise.resolve(true),
            async asyncRender(value) {
              await delay(value === 'prefix' ? 6 : 2);
              return value.toUpperCase();
            }
          };

          const rendered = await env.renderTemplateString(template, context);
          expect(rendered.replace(/\s+/g, '')).to.equal('[PREFIX][A][B]');
        });
      });

      describe('Async Caller with Control Structures', () => {
        it('should handle async values in if conditions within caller', async () => {
          const template = `
            {% macro wrapper() %}
            {{ caller() }}
            {% endmacro %}

            {% call wrapper() %}
            {% if asyncCondition %}
              {{ asyncValue }}
            {% endif %}
            {% endcall %}
          `;

          const context = {
            asyncCondition: Promise.resolve(true),
            asyncValue: Promise.resolve('shown')
          };

          const rendered = await env.renderTemplateString(template, context);
          expect(rendered.trim()).to.equal('shown');
        });

        it('should handle async values in for loops within caller', async () => {
          const template = `
            {% macro wrapper() %}
            {{ caller() }}
            {% endmacro %}

            {% call wrapper() %}
            {% for item in asyncItems %}
              {{ item }}
            {% endfor %}
            {% endcall %}
          `;

          const context = {
            asyncItems: Promise.resolve(['a', 'b', 'c'])
          };

          const rendered = await env.renderTemplateString(template, context);
          expect(rendered.trim().replace(/\s+/g, ' ')).to.equal('a b c');
        });
      });

      describe('Async Caller with Macro Arguments', () => {
        it('should handle async values in macro arguments', async () => {
          const template = `
            {%- macro format(prefix) -%}
            {{ prefix }}: {{ caller() }}
            {%- endmacro -%}

            {%- call format(asyncPrefix) -%}
            {{ asyncContent }}
            {%- endcall -%}
          `;

          const context = {
            asyncPrefix: Promise.resolve('Result'),
            asyncContent: Promise.resolve('42')
          };

          const rendered = await env.renderTemplateString(template, context);
          expect(rendered.trim()).to.equal('Result: 42');
        });
      });

      describe('Async Caller Error Cases', () => {
        it('should fail cleanly when caller() is used without a call block', async () => {
          const template = `
            {% macro wrapper() %}
            {{ caller() }}
            {% endmacro %}

            {{ wrapper() }}
          `;

          try {
            await env.renderTemplateString(template, {});
            expect().fail('Should have thrown');
          } catch (error) {
            expect(error.message).to.contain('Unable to call `caller`');
          }
        });

        it('should properly handle rejected promises in caller content', async () => {
          const template = `
            {% macro wrapper() %}
            {{ caller() }}
            {% endmacro %}

            {% call wrapper() %}
            {{ getAsyncError() }}
            {% endcall %}
          `;

          const context = {
            //asyncError: Promise.reject(new Error('Async error'))
            async getAsyncError() {
              await delay(5);
              throw new Error('Async error');
            }
          };

          try {
            await env.renderTemplateString(template, context);
          } catch (error) {
            expect(error.message).to.contain('Async error');
          }
        });

        it('should handle async errors in nested callers', async () => {
          const template = `
            {% macro outer() %}
            {{ caller() }}
            {% endmacro %}

            {% macro inner() %}
            {{ caller() }}
            {% endmacro %}

            {% call outer() %}
            {% call inner() %}
              {{ asyncError }}
            {% endcall %}
            {% endcall %}
          `;

          const context = {
            asyncError: Promise.reject(new Error('Nested async error'))
          };

          try {
            await env.renderTemplateString(template, context);
          }
          catch (error) {
            expect(error.message).to.contain('Nested async error');
          }
        });
      });
    });

    describe('Macro binding value semantics', () => {
      it('should allow reassignment of macro argument in async template mode', async () => {
        const template = `
          {%- macro bump(x) -%}
            {% set x = x + 1 %}
            {{ x }}
          {%- endmacro -%}
          {{ bump(2) }}
        `;
        const rendered = await env.renderTemplateString(template, {});
        expect(rendered.trim()).to.equal('3');
      });

      it('should allow reassignment of macro argument in async script mode', async () => {
        const script = `
        function bump(x)
          x = x + 1
          return x
        endfunction

        var result = bump(2)
        return result`;
        const result = await env.renderScriptString(script, {});
        expect(result).to.equal(3);
      });

      it('should keep caller binding assignable inside macro body', async () => {
        const template = `
          {%- macro wrap() -%}
            {% set caller = "override" %}
            {{ caller }}
          {%- endmacro -%}
          {% call wrap() %}ignored{% endcall %}
        `;
        const rendered = await env.renderTemplateString(template, {});
        expect(rendered.trim()).to.equal('override');
      });

      it('should resolve default macro params from earlier params and allow reassignment', async () => {
        const template = `
          {%- macro adjust(a, b=a) -%}
            {% set b = b + 2 %}
            {{ b }}
          {%- endmacro -%}
          {{ adjust(3) }}
        `;
        const rendered = await env.renderTemplateString(template, {});
        expect(rendered.trim()).to.equal('5');
      });

    });
  });
})();
