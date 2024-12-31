(function() {
	'use strict';

	var expect;
	//var unescape;
	var AsyncEnvironment;
	//var Environment;

	if (typeof require !== 'undefined') {
	  expect = require('expect.js');
	  AsyncEnvironment = require('../nunjucks/src/environment').AsyncEnvironment;
	  //Environment = require('../nunjucks/src/environment').Environment;
	  //unescape = require('he').unescape;
	} else {
	  expect = window.expect;
	  //unescape = window.he.unescape;
	  AsyncEnvironment = nunjucks.AsyncEnvironment;
	  //Environment = nunjucks.Environment;
	}

	const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

	describe('Async mode - structures: arrays, dictionaries and lookup keys', () => {
	  let env;
	  beforeEach(() => {
		env = new AsyncEnvironment();
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
          const result = await env.renderString(template, context);
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
          const result = await env.renderString(template, context);
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
          const result = await env.renderString(template, context);
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
			const result = await env.renderString(template, context);
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
		  const result = await env.renderString(template, context);
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
		  const result = await env.renderString(template, context);
		  expect(result).to.equal('foo:1bar:2');
		});

		it('should handle quoted string keys with async values', async () => {
		  const context = {
			async getAmount1() {
			  await delay(5);
			  return '5 tbsp';
			},
			async getAmount2() {
			  await delay(3);
			  return '1 tbsp';
			}
		  };

		  const template = `
			{%- set recipe = {
			  "ketchup": getAmount1(),
			  'mustard': getAmount2(),
			  pickle: '0 tbsp'
			} -%}
			{%- for ingredient, amount in recipe -%}
			  {{ amount }} of {{ ingredient }}
			{%- endfor -%}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result).to.equal('5 tbsp of ketchup1 tbsp of mustard0 tbsp of pickle');
		});

	  });

	});
}());