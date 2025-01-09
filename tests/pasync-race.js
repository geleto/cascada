(function () {
  'use strict';

  var expect;
  var unescape;
  var PAsyncEnvironment;
  var StringLoader;
  //var Environment;
  //var lexer;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    PAsyncEnvironment = require('../nunjucks/src/environment').PAsyncEnvironment;
    //Environment = require('../nunjucks/src/environment').Environment;
    //lexer = require('../nunjucks/src/lexer');
    unescape = require('he').unescape;
    StringLoader = require('./pasync-loader');
  } else {
    expect = window.expect;
    unescape = window.he.unescape;
    PAsyncEnvironment = nunjucks.PAsyncEnvironment;
    StringLoader = window.StringLoader;
    //Environment = nunjucks.Environment;
    //lexer = nunjucks.lexer;
  }

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  describe('Async mode race conditions tests', () => {
    let env;
    beforeEach(() => {
      env = new PAsyncEnvironment();
    });

    describe('Simple race conditions with sets', () => {
      it(`Should correctly set a variable from a child 'if' frame `, async () => {
        const template = `
				{%- set x = 1 -%}
				{%- if true -%}
				  {%- set x = 2 -%}
				{%- endif -%}
				{{ x }}`;

        const result = await env.renderString(template);
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
        const result = await env.renderString(template, context);
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
        const result = await env.renderString(template, context);
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
        const result = await env.renderString(template, context);
        expect(result).to.equal('2');
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
        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const resultA = await env.renderString(template, contextA);
        const resultB = await env.renderString(template, contextB);
        const resultC = await env.renderString(template, contextC);

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

        let result = await env.renderString(template, context);
        expect(result.trim()).to.equal('X');

        context.whichCase = (async () => {
          await delay(2);
          return 'caseA';
        })();

        result = await env.renderString(template, context);
        expect(result.trim()).to.equal('ZQ');

        context.extraSlowVar = (async () => {
          await delay(1);
          return 'NOT_SLOW';
        })();

        result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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
        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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
        const result = await env.renderString(template, context);
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
        const result = await env.renderString(template, context);
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
        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
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

        const result = await env.renderString(template, context);
        expect(result.trim()).to.equal('default');
      });
    });

    describe('Race conditions: Async Template Inheritance, Macros, and Super', () => {
      let loader;
      beforeEach(() => {
        loader = new StringLoader();
        env = new PAsyncEnvironment(loader);
      });
      it.skip('should handle extends with async super() and set', async () => {
        const template = `
          {%- extends "base_for_super.njk" -%}
          {%- block content -%}
            {%- set val = getPreSuperVal() -%}
            {{ super()}}
            {%- set val = getPostSuperVal() -%}
            {{ val }}
          {%- endblock -%}
        `;

        loader.addTemplate('base_for_super.njk', `
          Base Content:
          {%- block content -%}
          Base Block: {{ val }}
          {%- endblock -%}
          `);

        const context = {
          async getPreSuperVal() {
            await delay(5);
            return 'PreSuperVal';
          },
          async getPostSuperVal() {
            await delay(10);
            return 'PostSuperVal';
          }
        };

        expect((await env.renderString(template, context)).trim()).to.equal('Base Content:Base Block: PreSuperVal PostSuperVal');
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

        expect((await env.renderString(template, context)).trim()).to.equal('Macro Start: OuterVal Inner: InnerVal Macro End Final val: OuterVal');
      });

      it.skip('should handle async extends with delayed parent template and block overrides', async () => {
        const template = `
          {% extends "parent_delayed.njk" %}
          {% block content %}
            {% set val = getVal() %}
            {{ super() }}
            Child sees value: {{ val }}
          {% endblock %}
        `;

        loader.addTemplate('parent_delayed.njk', `
          Parent Start
          {% block content %}
          Parent sees value: {{ val }}
          {% endblock %}
          Parent End
          `);

        const context = {
          async getVal() {
            await delay(8);
            return 'ChildVal';
          }
        };

        expect((await env.renderString(template, context)).replace(/\s+/g, ' ')).to.equal('Parent Start Parent sees value: ChildVal Child sees value: ChildVal Parent End');
      });

    });

  });
})();
