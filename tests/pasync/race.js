(function () {
  'use strict';

  var expect;
  var unescape;
  var AsyncEnvironment;
  var StringLoader;
  //var Environment;
  //var lexer;
  var delay;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    AsyncEnvironment = require('../../src/environment').AsyncEnvironment;
    //Environment = require('../../src/environment').Environment;
    //lexer = require('../../src/lexer');
    unescape = require('he').unescape;
    StringLoader = require('../util').StringLoader;
    delay = require('../util').delay;
  } else {
    expect = window.expect;
    unescape = window.he.unescape;
    AsyncEnvironment = nunjucks.AsyncEnvironment;
    StringLoader = window.util.StringLoader;
    //Environment = nunjucks.Environment;
    //lexer = nunjucks.lexer;
    delay = window.util.delay;
  }

  describe('Async mode race conditions tests', () => {
    let env;
    beforeEach(() => {
      env = new AsyncEnvironment();
    });

    describe('Simple race conditions with sets', () => {
      it(`Should correctly set a variable from a child 'if' frame `, async () => {
        const template = `
				{%- set x = 1 -%}
				{%- if true -%}
				  {%- set x = 2 -%}
				{%- endif -%}
				{{ x }}`;

        const result = await env.renderTemplateString(template);
        expect(result).to.equal('2');
      });

      it('should correctly handle assignments irrespective if an async block is delayed ', async () => {
        const context = {
          slowCondition: (async () => {
            await delay(5);
            return true;
          })()
        };

        const template = `
				{%- set value = 1 -%}
				{%- if slowCondition -%}
				  {%- set value = 2 -%}
				{%- endif -%}
				{{ value }}`;
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('2');
      });

      it('Should handle assignments in order despite different delays ', async () => {
        const context = {
          slowCondition: (async () => {
            await delay(6);
            return true;
          })(),
          anotherSlowCondition: (async () => {
            await delay(3);
            return true;
          })()
        };

        const template = `
				{%- set value = 1 -%}
				{%- if slowCondition -%}
				  {%- set value = 2 -%}
				{%- endif -%}
				{%- if anotherSlowCondition -%}
				  {%- set value = 3 -%}
				{%- endif -%}
				{{ value }}
				{%- set value = 4 -%}`;
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('3');
      });
    });

    describe('Async If/Switch Tests', () => {

      it('Should snapshot current vars before starting async block ', async () => {
        const context = {
          slowCondition: (async () => {
            await delay(6);
            return true;
          })(),
          anotherSlowCondition: (async () => {
            await delay(3);
            return true;
          })()
        };

        const template = `
				{%- set value = 1 -%}
				{%- if slowCondition -%}
				  {%- set value = 2 -%}
				{%- endif -%}
				{%- if anotherSlowCondition -%}
				  {{ value }}
				{%- endif -%}
				{%- set value = 3 -%}`;
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('2');
      });

      it('Should handle a simple nested if race condition', async () => {
        const template = `
          {% set x = 1 %}
          {%- if x -%}
            {%- if x -%}
              {{ x }}
            {%- endif -%}
            {%- set x = x + 1 -%}
          {%- endif -%}
          {%- set x = x + 1 -%}
        `;

        const result = await env.renderTemplateString(template);
        expect(result.trim()).to.equal('1');
      });

      it('Should write-snapshot (because of idle else branch) current vars before starting async block', async () => {
        const context = {
          slowCondition: (async () => {
            await delay(6);
            return true;
          })(),
          anotherSlowCondition: (async () => {
            await delay(3);
            return true;
          })()
        };

        const template = `
				{%- set value = 1 -%}
				{%- if anotherSlowCondition -%}
				  {{ value }}
				{%- else -%}
				  {%- set value = 100 -%}
				{%- endif -%}
				{%- set value = 3 -%}`;
        const result = await env.renderTemplateString(template, context);
        expect(result).to.equal('1');
      });

      it('should skip writes from the else branch when if is truthy', async () => {
        const context = {
          slowTruth: (async () => {
            await delay(10);
            return true;
          })(),
        };

        const template = `
				{%- set value = 1 -%}
				{%- if slowTruth -%}
				  {%- set value = 2 -%}
				{%- else -%}
				  {%- set value = 3 -%}
				{%- endif -%}
				{{ value }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('2');
      });

      it('should handle nested async if statements with concurrency', async () => {
        const context = {
          outer: (async () => {
            await delay(5);
            return true;
          })(),
          inner: (async () => {
            await delay(3);
            return true;
          })()
        };

        const template = `
				{%- set x = 1 -%}
				{%- if outer -%}
				  {%- set x = 10 -%}
				  {%- if inner -%}
					{%- set x = 20 -%}
				  {%- endif -%}
				{%- endif -%}
				{{ x }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('20');
      });

      it('should handle nested async if statements with concurrency, and else blocks', async () => {
        const context = {
          outer: (async () => {
            await delay(5);
            return true;
          })(),
          inner: (async () => {
            await delay(3);
            return true;
          })()
        };

        const template = `
				{%- set x = 1 -%}
				{%- if outer -%}
				  {%- set x = 10 -%}
				  {%- if inner -%}
					{%- set x = 20 -%}
				  {%- else -%}
					{%- set x = 100 -%}
				  {%- endif -%}
				{%- else -%}
				  {%- set x = 200 -%}
				{%- endif -%}
				{{ x }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('20');
      });

      it('should skip all but the first truthy branch', async () => {
        const template = `
				{%- set value = 1 -%}
				{%- if cond1 -%}
				  {%- set value = 2 -%}
				{%- else -%}
				  {%- if cond2 -%}
					{%- set value = 3 -%}
				  {%- else -%}
					{%- set value = 4 -%}
				  {%- endif -%}
				{%- endif -%}
				{{ value }}
			  `;

        const contextA = {
          cond1: (async () => { await delay(5); return true; })(),
          cond2: (async () => { await delay(1); return false; })(),
        };

        const contextB = {
          cond1: (async () => { await delay(2); return false; })(),
          cond2: (async () => { await delay(3); return true; })(),
        };

        const contextC = {
          cond1: Promise.resolve(false),
          cond2: Promise.resolve(false),
        };

        const resultA = await env.renderTemplateString(template, contextA);
        const resultB = await env.renderTemplateString(template, contextB);
        const resultC = await env.renderTemplateString(template, contextC);

        expect(resultA.trim()).to.equal('2');
        expect(resultB.trim()).to.equal('3');
        expect(resultC.trim()).to.equal('4');
      });

      it('should handle switch with nested if and async conditions', async () => {
        const context = {
          whichCase: (async () => {
            await delay(3);
            return 'caseB';
          })(),
          extraSlowVar: (async () => {
            await delay(10);
            return 'SLOW';
          })()
        };

        const template = `
				{%- set value = 'initial' -%}
				{%- switch whichCase -%}
				  {%- case 'caseA' -%}
					{%- set value = 'A' -%}
					{%- if extraSlowVar == 'NOT_SLOW' -%}
					  {%- set value = 'Y' -%}
					{%- else -%}
					  {%- set value = 'Z' -%}
					  {{ value }}
					  {%- set value = 'Q' -%}
					{%- endif -%}
				  {%- case 'caseB' -%}
					{%- set value = 'B' -%}
					{%- if extraSlowVar == 'SLOW' -%}
					  {%- set value = 'X' -%}
					{%- endif -%}
				  {%- case 'caseC' -%}
					{%- set value = 'C' -%}
				  {%- default -%}
					{%- set value = 'D' -%}
				{%- endswitch -%}
				{{ value }}
			  `;

        let result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('X');

        context.whichCase = (async () => {
          await delay(2);
          return 'caseA';
        })();

        result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('ZQ');

        context.extraSlowVar = (async () => {
          await delay(1);
          return 'NOT_SLOW';
        })();

        result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('Y');
      });

      it('should skip writes from all but one switch case', async () => {
        const context = {
          switchKey: (async () => {
            await delay(4);
            return 'blue';
          })(),
          redSlowVar: (async () => { await delay(10); return 'RED'; })(),
          blueSlowVar: (async () => { await delay(1); return 'BLUE'; })(),
          greenSlowVar: (async () => { await delay(5); return 'GREEN'; })()
        };

        const template = `
				{%- set color = 'none' -%}
				{%- switch switchKey -%}
				  {%- case 'red' -%}
					{%- if redSlowVar == 'RED' -%}
					  {%- set color = redSlowVar + '_COLOR' -%}
					{%- endif -%}
				  {%- case 'blue' -%}
					{%- if blueSlowVar == 'BLUE' -%}
					  {%- set color = blueSlowVar + '_COLOR'  -%}
					{%- else -%}
					  {%- set color = 'Not blue' -%}
					{%- endif -%}
				  {%- case 'green' -%}
					{%- if greenSlowVar == 'GREEN' -%}
					  {%- set color = greenSlowVar + '_COLOR'  -%}
					{%- else -%}
					  {%- set color = 'Not green' -%}
					{%- endif -%}
				  {%- default -%}
					{%- set color = 'other' -%}
				{%- endswitch -%}
				{{ color }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('BLUE_COLOR');
      });

      it('should use default if no case matches', async () => {
        const context = {
          switchKey: (async () => {
            await delay(2);
            return 'not-a-match';
          })()
        };

        const template = `
				{%- set val = 1 -%}
				{%- switch switchKey -%}
				  {%- case 'foo' -%}
					{%- set val = 2 -%}
				  {%- case 'bar' -%}
					{%- set val = 3 -%}
				  {%- default -%}
					{%- set val = 99 -%}
				{%- endswitch -%}
				{{ val }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('99');
      });

      it('should reflect final assignment despite parallel async conditions', async () => {
        const context = {
          cond1: (async () => {
            await delay(8);
            return true;
          })(),
          cond2: (async () => {
            await delay(3);
            return true;
          })(),
          cond3: (async () => {
            await delay(6);
            return true;
          })()
        };

        const template = `
				{%- set value = 'start' -%}
				{%- if cond1 -%}
				  {%- set value = 'cond1' -%}
				{%- endif -%}
				{%- if cond2 -%}
				  {%- set value = 'cond2' -%}
				{%- endif -%}
				{%- if cond3 -%}
				  {%- set value = 'cond3' -%}
				{%- endif -%}
				{{ value }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('cond3');
      });

      it('should demonstrate snapshots in consecutive if blocks', async () => {
        const context = {
          slowCondition: (async () => {
            await delay(5);
            return true;
          })(),
          anotherSlowCondition: (async () => {
            await delay(2);
            return true;
          })()
        };

        const template = `
				{%- set value = 1 -%}
				{%- if slowCondition -%}
				  {%- set value = 2 -%}
				{%- endif -%}
				{%- if anotherSlowCondition -%}
				  {{ value }}
				{%- endif -%}
				{%- set value = 3 -%}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('2');
      });
    });

    describe('Advanced Async If/Switch Tests', () => {
      it('should correctly handle deeply nested async if-else structures', async () => {
        const context = {
          conditionA: (async () => {
            await delay(5);
            return true;
          })(),
          conditionB: (async () => {
            await delay(10);
            return false;
          })(),
          conditionC: (async () => {
            await delay(2);
            return true;
          })()
        };

        const template = `
				{%- set result = 'start' -%}
				{%- if conditionA -%}
				  {%- set result = 'A1' -%}
				  {%- if conditionB -%}
					{%- set result = 'A1-B1' -%}
				  {%- else -%}
					{%- set result = 'A1-B0' -%}
					{%- if conditionC -%}
					  {%- set result = 'A1-B0-C1' -%}
					{%- endif -%}
				  {%- endif -%}
				{%- else -%}
				  {%- set result = 'A0' -%}
				{%- endif -%}
				{{ result }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('A1-B0-C1');
      });

      it('should handle mixed async switch cases with nested if statements', async () => {
        const context = {
          key: (async () => {
            await delay(5);
            return 'case2';
          })(),
          slowCondition1: (async () => {
            await delay(7);
            return true;
          })(),
          slowCondition2: (async () => {
            await delay(3);
            return false;
          })()
        };

        const template = `
				{%- set result = 'none' -%}
				{%- switch key -%}
				  {%- case 'case1' -%}
					{%- set result = 'case1' -%}
				  {%- case 'case2' -%}
					{%- set result = 'case2' -%}
					{%- if slowCondition1 -%}
					  {%- set result = 'case2-true' -%}
					  {%- if slowCondition2 -%}
						{%- set result = 'case2-true-true' -%}
					  {%- else -%}
						{%- set result = 'case2-true-false' -%}
					  {%- endif -%}
					{%- endif -%}
				  {%- case 'case3' -%}
					{%- set result = 'case3' -%}
				  {%- default -%}
					{%- set result = 'default' -%}
				{%- endswitch -%}
				{{ result }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('case2-true-false');
      });

      it('should handle overlapping async writes in multiple branches', async () => {
        const context = {
          condA: (async () => {
            await delay(3);
            return true;
          })(),
          condB: (async () => {
            await delay(6);
            return true;
          })(),
          condC: (async () => {
            await delay(2);
            return false;
          })()
        };

        const template = `
				{%- set shared = 'start' -%}
				{%- if condA -%}
				  {%- set shared = 'condA' -%}
				{%- endif -%}
				{%- if condB -%}
				  {%- set shared = 'condB' -%}
				{%- endif -%}
				{%- if condC -%}
				  {%- set shared = 'condC' -%}
				{%- endif -%}
				{{ shared }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('condB');
      });

      it('should correctly skip writes in a nested switch-case within an async if', async () => {
        const context = {
          outerCondition: (async () => {
            await delay(8);
            return true;
          })(),
          innerSwitchKey: (async () => {
            await delay(4);
            return 'caseY';
          })()
        };

        const template = `
				{%- set result = 'initial' -%}
				{%- if outerCondition -%}
				  {%- switch innerSwitchKey -%}
					{%- case 'caseX' -%}
					  {%- set result = 'outer-true-caseX' -%}
					{%- case 'caseY' -%}
					  {%- set result = 'outer-true-caseY' -%}
					{%- case 'caseZ' -%}
					  {%- set result = 'outer-true-caseZ' -%}
					{%- default -%}
					  {%- set result = 'outer-true-default' -%}
				  {%- endswitch -%}
				{%- else -%}
				  {%- set result = 'outer-false' -%}
				{%- endif -%}
				{{ result }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('outer-true-caseY');
      });

      it('should process multiple async nested blocks with shared variable updates', async () => {
        const context = {
          asyncCondition1: (async () => {
            await delay(3);
            return true;
          })(),
          asyncCondition2: (async () => {
            await delay(6);
            return true;
          })(),
          asyncCondition3: (async () => {
            await delay(2);
            return true;
          })()
        };

        const template = `
				{%- set state = 'initial' -%}
				{%- if asyncCondition1 -%}
				  {%- set state = 'condition1' -%}
				  {%- if asyncCondition2 -%}
					{%- set state = 'condition1-2' -%}
				  {%- endif -%}
				{%- endif -%}
				{%- if asyncCondition3 -%}
				  {%- set state = 'condition3' -%}
				{%- endif -%}
				{{ state }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('condition3');
      });

      it('should handle conflicting writes from async if and switch cases', async () => {
        const context = {
          conditionIf: (async () => {
            await delay(5);
            return true;
          })(),
          conditionSwitchKey: (async () => {
            await delay(3);
            return 'case2';
          })()
        };

        const template = `
				{%- set result = 'start' -%}
				{%- if conditionIf -%}
				  {%- set result = 'if-branch' -%}
				{%- endif -%}
				{%- switch conditionSwitchKey -%}
				  {%- case 'case1' -%}
					{%- set result = 'switch-case1' -%}
				  {%- case 'case2' -%}
					{%- set result = 'switch-case2' -%}
				  {%- case 'case3' -%}
					{%- set result = 'switch-case3' -%}
				  {%- default -%}
					{%- set result = 'switch-default' -%}
				{%- endswitch -%}
				{{ result }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('switch-case2');
      });

      it('should handle variable snapshots across nested if blocks with async conditions', async () => {
        const context = {
          conditionA: (async () => {
            await delay(5);
            return true;
          })(),
          conditionB: (async () => {
            await delay(3);
            return false;
          })(),
          conditionC: (async () => {
            await delay(6);
            return true;
          })()
        };

        const template = `
				{%- set result = 'initial' -%}
				{%- if conditionA -%}
				  {%- set result = 'A' -%}
				  {%- if conditionB -%}
					{%- set result = 'A-B' -%}
				  {%- else -%}
					{%- set result = 'A-B-not' -%}
				  {%- endif -%}
				{%- endif -%}
				{%- if conditionC -%}
				  {{ result }}
				{%- endif -%}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('A-B-not');
      });
    });

    describe('Complex Async If/Switch Concurrency Tests 2', () => {
      function makeAsyncValue(value, ms = 10) {
        return (async () => {
          await delay(ms);
          return value;
        })();
      }

      it('should handle deeply nested if statements with concurrency', async () => {
        const context = {
          outerIf1: makeAsyncValue(true, 15),
          nestedIf: makeAsyncValue(true, 5),
          outerIf2: makeAsyncValue(true, 1)
        };

        const template = `
				{%- set x = 0 -%}
				{%- set y = 0 -%}
				{%- if outerIf1 -%}
				  {%- set x = 1 -%}
				  {%- if nestedIf -%}
					{%- set x = 2 -%}
				  {%- endif -%}
				{%- endif -%}

				{%- if outerIf2 -%}
				  {%- set y = x * 10 -%}
				{%- endif -%}
				X={{ x }} Y={{ y }}
			  `;

        // Explanation:
        // - outerIf1 => true => x=1
        // - nestedIf => true => x=2
        // - outerIf2 => true => y = x * 10 = 2 * 10 = 20
        // Final => x=2, y=20
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('X=2 Y=20');
      });

      /**
       * 3) Multiple if blocks & a final set:
       *    - Tests that final set is *logically after* earlier if blocks,
       *      even if earlier ifs finish "late" in real time.
       */
      it('should preserve template order with dependent async ifs and final set', async () => {
        const context = {
          cond1: makeAsyncValue(true, 20),  // finishes late
          cond2: makeAsyncValue(true, 5),   // finishes sooner
          cond3: makeAsyncValue(true, 10)   // finishes in between
        };

        const template = `
				{%- set result = 'start' -%}
				{%- if cond1 -%}
				  {%- set result = result + ' > cond1' -%}
				{%- endif -%}
				{%- if result.indexOf('cond1') >= 0 and cond2 -%}
				  {%- set result = result + ' > cond2' -%}
				{%- endif -%}
				{%- if result.indexOf('cond2') >= 0 and cond3 -%}
				  {%- set result = result + ' > cond3' -%}
				{%- endif -%}
				{%- set result = result + ' > final' -%}
				{{ result }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(unescape(result.trim())).to.equal('start > cond1 > cond2 > cond3 > final');
      });

      it('should skip multiple variable writes in non-matching switch cases', async () => {
        const context = {
          which: makeAsyncValue('B', 8),
        };

        const template = `
				{%- set x = 0 -%}
				{%- set y = 0 -%}
				{%- switch which -%}
				  {%- case 'A' -%}
					{%- set x = 10 -%}
					{%- set y = 100 -%}
				  {%- case 'B' -%}
					{%- set x = 20 -%}
					{%- set y = 200 -%}
				  {%- default -%}
					{%- set x = 30 -%}
					{%- set y = 300 -%}
				{%- endswitch -%}
				X={{ x }} Y={{ y }}
			  `;

        // Should pick case 'B' => x=20, y=200
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('X=20 Y=200');
      });

      /**
       * 5) Complex concurrency: nested if inside each switch case,
       *    each modifies a shared variable in a different way
       */
      it('should skip nested if writes for non-chosen switch case', async () => {
        const context = {
          mainKey: makeAsyncValue('green', 5),
          conditionRed: makeAsyncValue(true, 10),    // won't matter if switch picks green
          conditionBlue: makeAsyncValue(false, 8),
          conditionGreen: makeAsyncValue(true, 1)    // relevant only in "green" case
        };

        const template = `
				{%- set color = 'none' -%}
				{%- switch mainKey -%}
				  {%- case 'red' -%}
					{%- set color = 'red' -%}
					{%- if conditionRed -%}
					  {%- set color = 'dark-red' -%}
					{%- endif -%}
				  {%- case 'blue' -%}
					{%- set color = 'blue' -%}
					{%- if conditionBlue -%}
					  {%- set color = 'light-blue' -%}
					{%- endif -%}
				  {%- case 'green' -%}
					{%- set color = 'green' -%}
					{%- if conditionGreen -%}
					  {%- set color = 'lime-green' -%}
					{%- endif -%}
				  {%- default -%}
					{%- set color = 'other' -%}
				{%- endswitch -%}
				{{ color }}
			  `;
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('lime-green');
      });

      it('should handle multiple variables set in multiple async ifs and read them in another if', async () => {
        const context = {
          condA: makeAsyncValue(true, 6),
          condB: makeAsyncValue(true, 3),
          condC: makeAsyncValue(true, 10)
        };

        const template = `
				{%- set varA = 0 -%}
				{%- set varB = 0 -%}

				{%- if condA -%}
				  {%- set varA = 5 -%}
				{%- endif -%}

				{%- if condB -%}
				  {%- set varB = 10 -%}
				{%- endif -%}

				{%- if condC -%}
				  {{ varA + varB }}
				{%- endif -%}
			  `;
        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('15');
      });

      it('should finalize the value from the last if but preserve correct order of assignment', async () => {
        const context = {
          c1: makeAsyncValue(true, 12),
          c2: makeAsyncValue(true, 2),
          c3: makeAsyncValue(false, 9) // last if won't execute
        };

        const template = `
				{%- set counter = 0 -%}
				{%- if c1 -%}
				  {%- set counter = counter + 10 -%}
				{%- endif -%}

				{%- if c2 -%}
				  {%- set counter = counter + 100 -%}
				{%- endif -%}

				{%- if c3 -%}
				  {%- set counter = counter + 1000 -%}
				{%- endif -%}
				{{ counter }}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('110');
      });

      it('should allow default in switch, then a subsequent if to pick up the new value', async () => {
        const context = {
          switchVal: makeAsyncValue('unknown', 5),
          checkVar: makeAsyncValue(true, 2)
        };

        const template = `
				{%- set chosen = 'none' -%}
				{%- switch switchVal -%}
				  {%- case 'alpha' -%}
					{%- set chosen = 'A' -%}
				  {%- case 'beta' -%}
					{%- set chosen = 'B' -%}
				  {%- default -%}
					{%- set chosen = 'default' -%}
				{%- endswitch -%}

				{%- if checkVar -%}
				  {{ chosen }}
				{%- endif -%}
			  `;

        const result = await env.renderTemplateString(template, context);
        expect(result.trim()).to.equal('default');
      });
    });

    describe('Race conditions: Async Template Inheritance, Macros, and Super', () => {
      let loader;
      beforeEach(() => {
        loader = new StringLoader();
        env = new AsyncEnvironment(loader);
      });

      it('should handle macro with async caller block', async () => {
        const template = `
          {%- import "macros_caller.njk" as m -%}
          {%- set val = 1 -%}
          {%- if slowCondition -%}
            {%- set val = getOuterVal() -%}
          {%- endif -%}
          {%- call m.show(val) -%}
            {%- set val = getInnerVal() -%}
            Inner: {{ val }}
          {%- endcall %} Final val: {{ val }}`;

        loader.addTemplate('macros_caller.njk', `
          {%- macro show(value) -%}
          Macro Start: {{ value }} {{ caller() }} Macro End {%- endmacro -%}
          `);

        const context = {
          slowCondition: (async () => { await delay(2); return true; })(),
          async getOuterVal() {
            await delay(5);
            return 'OuterVal';
          },
          async getInnerVal() {
            await delay(3);
            return 'InnerVal';
          }
        };

        expect((await env.renderTemplateString(template, context)).trim()).to.equal('Macro Start: OuterVal Inner: InnerVal Macro End Final val: OuterVal');
      });

    });

  });

  describe('Promise Chaining Tests', function() {
    let env;

    beforeEach(function() {
      env = new AsyncEnvironment();
    });

    // Test Case 1: Simple promise resolution
    it('should properly handle simple promises', async function() {
      const template = `{{ asyncValue }}`;
      const context = {
        asyncValue: Promise.resolve(42)
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.equal('42');
    });

    // Test Case 2: Chained promise operations
    it('should properly handle chained promise operations', async function() {
      const template = `{% set x = firstPromise %}
  {% set y = secondPromise %}
  First: {{ x }}, Second: {{ y }}`;

      const context = {
        firstPromise: Promise.resolve('Value 1'),
        secondPromise: Promise.resolve('Value 2')
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('First: Value 1');
      expect(result).to.contain('Second: Value 2');
    });

    // Test Case 3: Async blocks that don't modify variables
    it('should properly resolve when async blocks don\'t modify variables', async function() {
      const template = `{% set x = initialPromise %}
  {% if condition %}
    {% set y = "not changing x" %}
  {% endif %}
  Result: {{ x }}`;

      const context = {
        initialPromise: Promise.resolve('Original Value'),
        condition: true
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Result: Original Value');
    });

    // Test Case 4: Nested async blocks with promise values
    it('should properly handle nested async blocks with promise values', async function() {
      const template = `{% set x = initialPromise %}
  {% if outerCondition %}
    {% if innerCondition %}
      {% set x = newPromise %}
    {% endif %}
  {% endif %}
  Final Value: {{ x }}`;

      const context = {
        initialPromise: Promise.resolve('Original Value'),
        newPromise: Promise.resolve('New Value'),
        outerCondition: true,
        innerCondition: true
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Final Value: New Value');
    });

    // Test Case 5: Multiple blocks modifying the same variable
    it('should correctly handle multiple blocks modifying the same variable', async function() {
      const template = `{% set x = "initial" %}
  {% if condition1 %}
    {% set x = firstPromise %}
  {% endif %}
  {% if condition2 %}
    {% set x = secondPromise %}
  {% endif %}
  {% if condition3 %}
    {% set x = x + " (modified)" %}
  {% endif %}
  Result: {{ x }}`;

      const context = {
        firstPromise: Promise.resolve('Value 1'),
        secondPromise: Promise.resolve('Value 2'),
        condition1: true,
        condition2: true,
        condition3: true
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Result: Value 2 (modified)');
    });

    // Test Case 6: Async function returning a promise
    it('should handle async functions returning promises', async function() {
      const template = `{% set x = asyncFunction() %}
  Result: {{ x }}`;

      const context = {
        asyncFunction: () => Promise.resolve('Function Result')
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Result: Function Result');
    });

    // Test Case 7: Conditional branches with different variable handling
    it('should correctly handle conditional branches with different promise operations', async function() {
      const template = `{% set x = initial %}
  {% if condition %}
    {% set x = promiseA %}
  {% else %}
    {% set x = promiseB %}
  {% endif %}
  Result: {{ x }}`;

      // Test with condition = true
      let context = {
        initial: 'Initial Value',
        promiseA: Promise.resolve('Value A'),
        promiseB: Promise.resolve('Value B'),
        condition: true
      };

      let result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Result: Value A');

      // Test with condition = false
      context.condition = false;
      result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Result: Value B');
    });

    // Test Case 9: Async loops with promise values
    it('should correctly handle async loops with promise values', async function() {
      const template = `{% set items = asyncItems %}
  {% for item in items %}
  - {{ item }}
  {% endfor %}`;

      const context = {
        asyncItems: Promise.resolve(['Item 1', 'Item 2', 'Item 3'])
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('- Item 1');
      expect(result).to.contain('- Item 2');
      expect(result).to.contain('- Item 3');
    });

    // Test Case 10: Complex promise dependency chains
    it('should handle complex promise dependency chains', async function() {
      const template = `{% set x = firstPromise %}
  {% set y = makeSecondPromise(x) %}
  First: {{ x }}, Second: {{ y }}`;

      const makeSecondPromise = async (value) => {
        return `Based on ${await value}`;
      };

      const context = {
        firstPromise: Promise.resolve('First Value'),
        makeSecondPromise
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('First: First Value');
      expect(result).to.contain('Second: Based on First Value');
    });

    it('should correctly unwrap promises in nested async contexts', async function() {
      // Add an async filter to force async block creation
      env.addFilter('async_identity', (val) => Promise.resolve(val));

      const template = `
      {% set x = initialPromise %}
      {% if asyncCondition %}
        {# Force this block to be async and just read x #}
        {{ x | async_identity }}
      {% endif %}
      {% set y = dependentFunction(x) %}
      Result: {{ y }}`;

      const context = {
        initialPromise: Promise.resolve('Initial Value'),
        asyncCondition: Promise.resolve(true),
        dependentFunction: async (val) => {
          // With original code, val would be a promise-of-a-promise
          const resolved = await val;
          return `Based on ${resolved}`;
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Result: Based on Initial Value');
    });
  });

  describe('Cascada Promise Nesting Bug Tests', function () {
    let env;

    beforeEach(function () {
      env = new AsyncEnvironment();
      // Add async filters to force async block creation
      env.addFilter('async_identity', (val) => Promise.resolve(val));
      env.addFilter('async_transform', (val, suffix) => Promise.resolve(`${val}${suffix}`));
    });

    // Test 1: The timing out test - basic promise nesting bug
    it('should correctly unwrap promises in nested async contexts', async function () {
      const template = `
    {% set x = initialPromise %}
    {% if asyncCondition %}
      {# Force this block to be async and just read x #}
      {{ x | async_identity }}
    {% endif %}
    {% set y = dependentFunction(x) %}
    Result: {{ y }}`;

      const context = {
        initialPromise: Promise.resolve('Initial Value'),
        asyncCondition: Promise.resolve(true),
        dependentFunction: async (val) => {
          // With original code, val would be a promise-of-a-promise
          const resolved = await val;
          return `Based on ${resolved}`;
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Result: Based on Initial Value');
    }); // Increase timeout to demonstrate the issue

    // Test 2: Error propagation through promise chains
    it('should properly propagate errors in promise chains', async function () {
      const template = `
    {% set x = errorPromise %}
    {% if asyncCondition %}
      {# Force this block to be async and just read x #}
      {{ "Reading: " + x | async_identity }}
    {% endif %}
    Value: {{ x }}`;

      const context = {
        errorPromise: Promise.reject(new Error('Test Error')),
        asyncCondition: Promise.resolve(true)
      };

      try {
        await env.renderTemplateString(template, context);
        expect().fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).to.contain('Test Error');
      }
    });

    // Test 3: Observable promise nesting with console debugging
    it('should not create nested promises that require multiple awaits', async function () {
      const template = `
    {% set x = initialPromise %}
    {% if asyncCondition %}
      {# Force this block to be async and just read x #}
      {{ x | async_identity }}
    {% endif %}
    {% set debugInfo = debugPromise(x) %}
    Debug: {{ debugInfo }}`;

      const promiseDepth = (p) => {
        //let depth = 0;
        let current = p;

        // Check if it's a promise
        while (current && typeof current.then === 'function') {
          //depth++;
          // This is just for testing - we manually unwrap one level
          // to check if there's another promise inside
          current = current.then(v => {
            // Store the value for inspection
            return { value: v, isPromise: v && typeof v.then === 'function' };
          });
          break; // We only need to go one level to detect nesting
        }

        return current;
      };

      const context = {
        initialPromise: Promise.resolve('Initial Value'),
        asyncCondition: Promise.resolve(true),
        debugPromise: (p) => {
          return promiseDepth(p);
        }
      };

      const result = await env.renderTemplateString(template, context);
      // The debug info should show only one level of promise
      // and the value shouldn't be a promise itself
      const debugValue = result.match(/Debug: (.+)/)[1].trim();
      expect(debugValue).to.equal('Initial Value');
    });

    // Test 4: Multiple async blocks reading the same promise
    it('should handle multiple async blocks reading the same promise', async function () {
      const template = `
    {% set x = initialPromise %}

    {# First block reads but doesn't modify x #}
    {% if condition1 %}
      {{ x | async_identity }}
    {% endif %}

    {# Second block reads but doesn't modify x #}
    {% if condition2 %}
      {{ x | async_transform(" - read again") }}
    {% endif %}

    {# Final verification that x is still a simple promise #}
    {% set promiseType = checkPromiseType(x) %}
    Promise type: {{ promiseType }}
    Final value: {{ x }}`;

      const context = {
        initialPromise: Promise.resolve('Promise Value'),
        condition1: Promise.resolve(true),
        condition2: Promise.resolve(true),
        checkPromiseType: async (val) => {
          // This function helps us see if we have nested promises
          if (val && typeof val.then === 'function') {
            try {
              const resolved = await val;
              if (resolved && typeof resolved.then === 'function') {
                return 'nested-promise';
              } else {
                return 'simple-promise';
              }
            } catch (e) {
              return 'rejected-promise';
            }
          }
          return 'not-a-promise';
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Promise type: not-a-promise');
      expect(result).to.contain('Final value: Promise Value');
    });

    // Test 5: Async function returning a promise after async block
    it('should handle async functions after async blocks with promise arguments', async function () {
      const template = `
    {% set x = initialPromise %}

    {# Read x in an async block #}
    {% if condition %}
      {{ x | async_identity }}
    {% endif %}

    {# Now call an async function with x #}
    {% set result = asyncFunction(x) %}
    Result: {{ result }}`;

      const context = {
        initialPromise: Promise.resolve({ id: 123, name: 'Test Item' }),
        condition: Promise.resolve(true),
        asyncFunction: async (item) => {
          // With nested promises, we'd get a Promise<{id,name}> instead of {id,name}
          try {
            const resolved = await item;
            return `Item ${resolved.id}: ${resolved.name}`;
          } catch (e) {
            return `Error: ${e.message}`;
          }
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Result: Item 123: Test Item');
    });

    // Test 6: Nested async blocks with promise dependencies
    it('should correctly handle nested async blocks with promise dependencies', async function () {
      const template = `
    {% set x = outerPromise %}

    {% if outerCondition %}
      {# Outer async block reads x #}
      {{ x | async_identity }}

      {% if innerCondition %}
        {# Inner async block also reads x #}
        {{ x | async_transform(" - inner block") }}
      {% endif %}
    {% endif %}

    {# Now use x with another async operation #}
    Final: {{ finalProcessor(x) }}`;

      const context = {
        outerPromise: Promise.resolve('Outer Promise Value'),
        outerCondition: Promise.resolve(true),
        innerCondition: Promise.resolve(true),
        finalProcessor: async (val) => {
          // With nested promises, this would either timeout or fail
          const resolved = await val;
          return `Processed: ${resolved}`;
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Final: Processed: Outer Promise Value');
    });
  });

  describe('Cascada Promise Nesting Tests Without Async Filters', function () {
    let env;
    let loader;

    beforeEach(() => {
      loader = new StringLoader();
      env = new AsyncEnvironment(loader);
    });

    // Test 1: Using async functions to create async blocks
    it('should correctly handle promise variables with async functions', async function () {
      const template = `
    {% set x = initialPromise %}

    {# Use async function to force async block #}
    {% if asyncCondition %}
      {{ asyncEcho(x) }}
    {% endif %}

    {# Now use the variable in a dependent function #}
    {% set result = dependentFunction(x) %}
    Result: {{ result }}`;

      const context = {
        initialPromise: Promise.resolve('Initial Value'),
        asyncCondition: Promise.resolve(true),
        asyncEcho: async (val) => {
          // Force this to be async
          await new Promise(resolve => setTimeout(resolve, 10));
          return val;
        },
        dependentFunction: async (val) => {
          // With the bug, val would be a promise-of-a-promise
          const resolved = await val;
          return `Based on ${resolved}`;
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Result: Based on Initial Value');
    });

    // Test 2: Using promise-based operations in set tags
    it('should correctly handle promise variables with promise-based set operations', async function () {
      const template = `
    {% set x = initialPromise %}

    {# Create an async block with a set operation #}
    {% set y = asyncOperation(123) %}

    {# This outputs x without modifying it, in an async block #}
    {{ x }}

    {# Now use x in another async function #}
    {% set result = processValue(x) %}
    Result: {{ result }}`;

      const context = {
        initialPromise: Promise.resolve('Value from promise'),
        asyncOperation: async (num) => {
          // Force async behavior
          await new Promise(resolve => setTimeout(resolve, 10));
          return `Async result ${num}`;
        },
        processValue: async (val) => {
          // With the bug, val would be a nested promise
          const resolved = await val;
          return `Processed: ${resolved}`;
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Result: Processed: Value from promise');
    });

    // Test 3: Using async control structures
    it('should correctly handle promise variables with async control structures', async function () {
      const template = `
    {% set x = initialPromise %}

    {# Create an async block with async condition #}
    {% if getAsyncCondition() %}
      {# Just read x without modifying it #}
      Value is: {{ x }}
    {% endif %}

    {# Now try to use x #}
    {% set result = processPromise(x) %}
    Result: {{ result }}`;

      const context = {
        initialPromise: Promise.resolve('Promise Content'),
        getAsyncCondition: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return true;
        },
        processPromise: async (val) => {
          // With the bug, val would be a nested promise
          try {
            const resolved = await val;
            return `Successfully processed: ${resolved}`;
          } catch (e) {
            return `Error: ${e.message}`;
          }
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Result: Successfully processed: Promise Content');
    });

    // Test 4: Using async collections in for loops
    it('should correctly handle promise variables in async for loops', async function () {
      const template = `
    {% set x = initialPromise %}

    {# Create an async block with async collection #}
    {% for item in getAsyncItems() %}
      Item: {{ item }}
      {# Just read x without modifying it #}
      Current x: {{ x }}
    {% endfor %}

    {# Now try to use x #}
    Final value: {{ finalTransform(x) }}`;

      const context = {
        initialPromise: Promise.resolve('Initial X Value'),
        getAsyncItems: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return ['Item 1', 'Item 2', 'Item 3'];
        },
        finalTransform: async (val) => {
          // With the bug, val would be a nested promise
          const resolved = await val;
          return `Transformed: ${resolved}`;
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Final value: Transformed: Initial X Value');
    });

    // Test 5: Using async includes
    it('should correctly handle promise variables with async includes', async function () {
      // Add an included template
      loader.addTemplate('included.html', 'Included template with access to x: {{ x }}');

      const template = `
    {% set x = initialPromise %}

    {# Create an async block with async include operation #}
    {% include asyncTemplateSelector() %}

    {# Now try to use x #}
    {% set result = processFinal(x) %}
    Result: {{ result }}`;

      const context = {
        initialPromise: Promise.resolve('X Promise Value'),
        asyncTemplateSelector: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return 'included.html';
        },
        processFinal: async (val) => {
          // With the bug, val would be a nested promise
          const resolved = await val;
          return `Final: ${resolved}`;
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Result: Final: X Promise Value');
    });

    // Test 6: Direct promise nesting detection
    it('should not create nested promises in async blocks', async function () {
      const template = `
    {% set x = initialPromise %}

    {# Create async block with async operation #}
    {% if asyncCondition %}
      {{ asyncEcho(x) }}
    {% endif %}

    {# Check if x has become a nested promise #}
    Promise type: {{ checkPromiseType(x) }}`;

      const context = {
        initialPromise: Promise.resolve('Test Value'),
        asyncCondition: Promise.resolve(true),
        asyncEcho: async (val) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return val;
        },
        checkPromiseType: async (val) => {
          if (val && typeof val.then === 'function') {
            const resolved = await val;
            if (resolved && typeof resolved.then === 'function') {
              return 'NESTED PROMISE - BUG DETECTED';
            } else {
              return 'CORRECT - Single-level promise';
            }
          }
          return 'Not a promise';
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Promise type: Not a promise');
      expect(result).not.to.contain('NESTED PROMISE - BUG DETECTED');
    });

    // Test 7: Using async iterator
    it('should correctly handle promise variables with async iterators', async function () {
      // Create an async iterator
      function createAsyncIterator() {
        let i = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            async next() {
              await new Promise(resolve => setTimeout(resolve, 10));
              return i < 3 ? { value: `Item ${++i}`, done: false } : { done: true };
            }
          })
        };
      }

      const template = `
    {% set x = initialPromise %}

    {# Use async iterator to force async block #}
    {% for item in asyncItems %}
      {{ item }}
      Current x: {{ x }}
    {% endfor %}

    {# Now check x after the loop #}
    After loop: {{ finalCheck(x) }}`;

      const context = {
        initialPromise: Promise.resolve('Promise Value'),
        asyncItems: createAsyncIterator(),
        finalCheck: async (val) => {
          try {
            const resolved = await val;
            return `Success: ${resolved}`;
          } catch (e) {
            return `Error: ${e}`;
          }
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('After loop: Success: Promise Value');
    });

    // Test 8: Multiple async blocks reading the same promise
    it('should handle multiple sequential async blocks reading the same promise', async function () {
      const template = `
    {% set x = initialPromise %}

    {# First async block #}
    {% if firstCondition() %}
      First: {{ x }}
    {% endif %}

    {# Second async block #}
    {% for item in secondCollection() %}
      Item: {{ item }}, X: {{ x }}
    {% endfor %}

    {# Third async block #}
    {% set z = thirdOperation() %}
    X again: {{ x }}

    {# Final check #}
    Final: {{ finalProcess(x) }}`;

      const context = {
        initialPromise: Promise.resolve('Original X'),
        firstCondition: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return true;
        },
        secondCollection: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return [1, 2];
        },
        thirdOperation: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return 'Third op result';
        },
        finalProcess: async (val) => {
          // With the bug, this would be a deeply nested promise
          try {
            const resolved = await val;
            return `Final value: ${resolved}`;
          } catch (e) {
            return `Error: ${e}`;
          }
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Final: Final value: Original X');
    });
  });

  describe('Practical Promise Nesting Tests for Cascada', function () {
    let env;
    let loader;

    beforeEach(() => {
      loader = new StringLoader();
      env = new AsyncEnvironment(loader);
    });

    // Conditional processing dependent on promise values
    it('2should correctly handle conditional logic dependent on promise values', async function () {
      const template = `
    {% set config = fetchConfig() %}

    {# First async block reads config #}
    {% if shouldShowDebugInfo() %}
      Debug info: {{ config.apiEndpoint }} ({{ config.apiVersion }})
    {% endif %}

    {# Second block uses config in different ways #}
    {% if config.features.advanced %}
      {# Here we use config in conditional logic #}
      {% set advancedData = fetchAdvancedData(config.apiEndpoint) %}
      Advanced data: {{ advancedData | truncate(100) }}
    {% else %}
      Basic mode active
    {% endif %}`;

      const context = {
        fetchConfig: () => Promise.resolve({
          apiEndpoint: 'https://api.example.com/v2',
          apiVersion: 'v2',
          features: { advanced: true }
        }),
        shouldShowDebugInfo: () => Promise.resolve(true),
        fetchAdvancedData: async (endpoint) => {
          // With nested promises, this would fail because endpoint would be a Promise<string>
          // not a string
          try {
            // Simulate API call with the endpoint
            if (typeof endpoint === 'string' && endpoint.includes('api.example.com')) {
              return 'Detailed data from the API that would be truncated in the template';
            } else {
              return `Invalid endpoint: ${endpoint}`;
            }
          } catch (e) {
            return `Error: ${e.toString()}`;
          }
        },
        truncate: (str, length) => {
          if (typeof str !== 'string') return `Not a string: ${typeof str}`;
          return str.length > length ? str.substring(0, length) + '...' : str;
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('Debug info: https://api.example.com/v2 (v2)');
      expect(result).to.contain('Advanced data: Detailed data from the API that would be truncated in the template');
      expect(result).not.to.contain('Invalid endpoint');
      expect(result).not.to.contain('Not a string');
    });

    // Complicated async data chain with error potential
    it('should correctly resolve multi-step async data chains', async function () {
      const template = `
    {% set initialData = fetchInitialData() %}

    {# Use initialData in a function that returns another promise #}
    {% set user = getUser(initialData.userId) %}

    {# Read user in an async operation without modifying it #}
    {% for permission in getUserPermissions(user.role) %}
      - {{ permission }}
    {% endfor %}

    {# Now use user in a dependent async operation #}
    {% set userContent = getUserContent(user) %}

    User {{ user.name }} has {{ userContent.items.length }} items:
    {% for item in userContent.items %}
      * {{ item.title }}
    {% endfor %}`;

      const context = {
        fetchInitialData: () => Promise.resolve({ userId: 42, timestamp: Date.now() }),
        getUser: (userId) => Promise.resolve({
          id: userId,
          name: 'Alice',
          role: 'editor'
        }),
        getUserPermissions: (role) => Promise.resolve([
          'read:content',
          'edit:own-content',
          role === 'editor' ? 'publish:content' : null
        ].filter(Boolean)),
        getUserContent: async (user) => {
          // With nested promises, this would fail because user would be a Promise<{id,name,role}>
          // not {id,name,role}
          try {
            const resolvedUser = await user;
            return {
              owner: resolvedUser.name,
              items: [
                { id: 1, title: 'First article by ' + resolvedUser.name },
                { id: 2, title: 'Second article by ' + resolvedUser.name }
              ]
            };
          } catch (e) {
            return { owner: 'ERROR', items: [] };
          }
        }
      };

      const result = await env.renderTemplateString(template, context);
      expect(result).to.contain('- read:content');
      expect(result).to.contain('- edit:own-content');
      expect(result).to.contain('- publish:content');
      expect(result).to.contain('User Alice has 2 items:');
      expect(result).to.contain('* First article by Alice');
      expect(result).to.contain('* Second article by Alice');
    });
  });
})();
