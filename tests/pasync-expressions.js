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

	describe('Async mode - expressions', () => {
	  let env;
	  beforeEach(() => {
		env = new AsyncEnvironment();
	  });

	  describe('Async Nunjucks Expressions', () => {
		it('should handle mixed parameter types in expressions', async () => {
		  const context = {
			async textFunc() { await delay(10); return 'Hello'; },
			async numFunc() { await delay(6); return 42; },

			get asyncList() { return delay(8).then(() => [1, 2, 'three'].toString()); },
			get asyncObj() { return delay(2).then(() => ({a: 1, b: 2})); },

			staticFlag: true,
			regularFunc: () => 'Regular',
		  };
		  const template = `
			Async function (String): {{ textFunc() }}
			Async function (Number): {{ numFunc() }}
			Async getter (Array): {{ asyncList }}
			Async getter (Object): {{ asyncObj }}
			Static value: {{ staticFlag }}
			Regular function: {{ regularFunc() }}
			Inline value: {{ "Inline" }}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal(`
			Async function (String): Hello
			Async function (Number): 42
			Async getter (Array): 1,2,three
			Async getter (Object): [object Object]
			Static value: true
			Regular function: Regular
			Inline value: Inline
		  `.trim());
		});

		it('should handle mixed parameter types in math operations', async () => {
		  const context = {
			async addAsync(a, b) { await delay(5); return a + b; },

			get asyncNum() { return delay(6).then(() => 5); },

			subtractSync: (a, b) => a - b,

			staticNum: 3,
		  };
		  const template = `
			Async function: {{ addAsync(2, 3) }}
			Async getter: {{ asyncNum }}
			Non-async function: {{ subtractSync(10, 5) }}
			Static value: {{ staticNum }}
			Mixed: {{ addAsync(asyncNum, subtractSync(staticNum, 1)) }}
			With inline: {{ addAsync(2, 3) + 5 }}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal(`
			Async function: 5
			Async getter: 5
			Non-async function: 5
			Static value: 3
			Mixed: 7
			With inline: 10
		  `.trim());
		});

		it('should handle mixed parameter types in comparisons and logic', async () => {
		  const context = {
			async asyncGreaterThan(a, b) { await delay(10); return a > b; },

			get asyncX() { return delay(2).then(() => 5); },

			syncEqual: (a, b) => a === b,

			staticY: 10,
		  };
		  const template = `
			Async function: {{ asyncGreaterThan(staticY, asyncX) }}
			Async getter: {{ asyncX > 3 }}
			Non-async function: {{ syncEqual(asyncX, 5) }}
			Static value comparison: {{ staticY < 15 }}
			Mixed: {{ asyncGreaterThan(asyncX, 3) and syncEqual(staticY, 10) }}
			With inline: {{ asyncX > 3 and 7 < staticY }}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal(`
			Async function: true
			Async getter: true
			Non-async function: true
			Static value comparison: true
			Mixed: true
			With inline: true
		  `.trim());
		});

		it('should handle mixed parameter types in if expressions', async () => {
		  const context = {
			async asyncTrue() { await delay(3); return true; },

			get asyncFalse() { return delay(2).then(() => false); },

			syncTrue: () => true,

			staticFalse: false,
		  };
		  const template = `
			Async function: {{ "yes" if asyncTrue() else "no" }}
			Async getter: {{ "yes" if asyncFalse else "no" }}
			Non-async function: {{ "yes" if syncTrue() else "no" }}
			Static value: {{ "yes" if staticFalse else "no" }}
			Mixed: {{ "yes" if (asyncTrue() and not staticFalse) else "no" }}
			With inline: {{ "yes" if (asyncTrue() and true) else "no" }}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal(`
			Async function: yes
			Async getter: no
			Non-async function: yes
			Static value: no
			Mixed: yes
			With inline: yes
		  `.trim());
		});

		it('should handle mixed parameter types in complex nested expressions', async () => {
		  const context = {
			async fetchUsers() {
			  await delay(5);
			  return [
				{ name: 'Alice', age: 30 },
				{ name: 'Bob', age: 25 },
				{ name: 'Charlie', age: 35 }
			  ];
			},

			get asyncDiscount() { return delay(5).then(() => 0.1); },

			isAdult: (age) => age >= 18,

			adultAge: 18,
		  };
		  const template = `
			{% for user in fetchUsers() -%}
			  {{ user.name }}: {{ ("Adult" if isAdult(user.age) else "Minor") }} (Age: {{ user.age }}, Discount: {{ (asyncDiscount * 100 if user.age > adultAge else 0) }}%)
			{% endfor %}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal(`
			Alice: Adult (Age: 30, Discount: 10%)
			Bob: Adult (Age: 25, Discount: 10%)
			Charlie: Adult (Age: 35, Discount: 10%)
		  `.trim());
		});

		it('should handle simple arithmetic groups', async () => {
		  const context = {
			async fetchNumber() { await delay(5); return 2; },
		  };

		  const template = `
			Result: {{ (1 + 2) * fetchNumber() }}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal(`Result: 6`)
		});

		it('should handle simple group with async values', async () => {
		  const context = {
			fetchA: new Promise(resolve =>
			  setTimeout(() => resolve(1), 3)
			),
			fetchB: new Promise(resolve =>
			  setTimeout(() => resolve(2), 5)
			)
		  };

		  const template = `
			Result: {{ (fetchA + fetchB) + 1 }}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal(`Result: 4`);
		});

		it('should handle groups with async and static values', async () => {
		  const context = {
			async fetchValue() { await delay(5); return 10; },
			staticValue: 5,
		  };

		  const template = `
			Result: {{ (fetchValue() + staticValue) * 2 }}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal(`Result: 30`);
		});

		it('should handle groups with commas and operations', async () => {
		  const context = {
			async fetchNumber() { await delay(5); return 3; },
			staticValue: 4,
		  };

		  const template = `
			Result: {{ (1 + fetchNumber(), staticValue, 5) + 1 }}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal(`Result: 6`);
		});

		//
		it('should handle nested groups with async dependencies', async () => {
		  const context = {
			async fetchA() { await delay(3); return 1; },
			async fetchB() { await delay(5); return 2; },
			async fetchC() { await delay(7); return 3; },
		  };

		  const template = `
			Result: {{ ((fetchA() + fetchB()) * fetchC()) + 1 }}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal(`Result: 10`);
		});

		it('should handle groups in conditional logic', async () => {
		  const context = {
			async fetchFlag() { await delay(3); return true; },
			staticValue: 5,
		  };

		  const template = `
			Result: {{ ("yes" if (fetchFlag() and staticValue > 3) else "no") }}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal(`Result: yes`);
		});

		it('should handle groups with commas and multiple values', async () => {
		  const context = {
			async fetchValue() { await delay(5); return 4; },
			staticValue: 2,
		  };

		  const template = `
			Result: {{ (fetchValue(), staticValue, fetchValue() + staticValue) }}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal(`Result: 6`);
		});

		it('should handle errors inside groups gracefully', async () => {
		  const context = {
			async fetchError() { throw new Error('Test group error'); },
			staticValue: 3,
		  };

		  const template = `Result: {{ (1 + fetchError(), staticValue + 2) }}`;
		  try {
			await env.renderString(template, context);
			// If we reach this point, the test should fail
			expect().fail('Expected an error to be thrown');
		  } catch (error) {
			expect(error instanceof Error).to.equal(true);
			expect(error.message).to.contain('Test group error');
		  }

		});

		it('should handle groups in loops', async () => {
		  const context = {
			async fetchValues() {
			  await delay(5);
			  return [1, 2, 3];
			},
			async increment(x) {
			  await delay(2);
			  return x + 1;
			},
		  };

		  const template = `
			{% for val in fetchValues() %}
			Result: {{ (val, increment(val), val * 2) }}
			{%- endfor %}
		  `;
		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal(`
			Result: 2
			Result: 4
			Result: 6
		  `.trim());
		});
	  });

	  describe('Async Functions in Expressions', () => {
		it('should handle async functions in filter expressions', async () => {
		  env.addFilter('uppercase', async (str) => {
			await delay(5);
			return str.toUpperCase();
		  });// note that this is not declared as async filter with
		  // the regular callback method, it just returns a promise

		  const context = {
			async uppercase(str) {
			  await delay(5);
			  return str.toUpperCase();
			}
		  };
		  const template = '{{ "hello" | uppercase }}';
		  const result = await env.renderString(template, context);
		  expect(result).to.equal('HELLO');
		});

		it('should handle async functions in if expressions', async () => {
		  const context = {
			async isAdmin() {
			  await delay(5);
			  return true;
			}
		  };
		  const template = '{{ "Admin" if isAdmin() else "User" }}';
		  const result = await env.renderString(template, context);
		  expect(result).to.equal('Admin');
		});

		it('should handle async values in "in" operator', async () => {
		  const context = {
			list: (async () => {
			  await delay(5);
			  return [1, 2, 3];
			})(),
			item: (async () => {
			  await delay(5);
			  return 2;
			})()
		  };

		  const result = await env.renderString('{{ item in list }}', context);
		  expect(result).to.equal('true');
		});

		it('should calculate power with async values', async () => {
		  const context = {
			base: (async () => {
			  await delay(5);
			  return 2;
			})(),
			exp: (async () => {
			  await delay(5);
			  return 3;
			})()
		  };

		  const result = await env.renderString('{{ base ** exp }}', context);
		  expect(result).to.equal('8');
		});

		it('should perform floor division with async values', async () => {
		  const context = {
			dividend: (async () => {
			  await delay(5);
			  return 7;
			})(),
			divisor: (async () => {
			  await delay(5);
			  return 2;
			})()
		  };

		  const result = await env.renderString('{{ dividend // divisor }}', context);
		  expect(result).to.equal('3');
		});
	  });

	});
}());