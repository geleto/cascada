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

		  const template = `
			{%- macro greet(name) -%}
			  Hello, {{ name }}!
			{%- endmacro -%}
			{{ greet(getName()) }}
		  `;

		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal('Hello, Alice!');
		});

		it('should handle async function called within macro', async () => {
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

		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal('Hello, Bob!');
		});

		it('should handle macro using async variable from context', async () => {
		  const context = {
			async greeting() {
			  await delay(2);
			  return 'Hi';
			},
			async name() {
			  await delay(3);
			  return 'Eve';
			}
		  };

		  const template = `
			{%- macro greet() -%}
			  {{ greeting() }}, {{ name() }}!
			{%- endmacro -%}
			{{ greet() }}
		  `;

		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal('Hi, Eve!');
		});

		it('should handle async logic inside macro', async () => {
		  const context = {
			async getGreeting() {
			  await delay(2);
			  return 'Greetings';
			},
			async getName() {
			  await delay(3);
			  return 'Frank';
			}
		  };

		  const template = `
			{%- macro greet() -%}
			  {{ getGreeting() }}, {{ getName() }}!
			{%- endmacro -%}
			{{ greet() }}
		  `;

		  const result = await env.renderString(template, context);
		  expect(result.trim()).to.equal('Greetings, Frank!');
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

			const rendered = await env.renderString(template, context);
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

			const result = await env.renderString(template);
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

			const rendered = await env.renderString(template, context);
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

			const rendered = await env.renderString(template, context);
			expect(rendered.trim()).to.equal('Outer(Inner(content))');
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

			const rendered = await env.renderString(template, context);
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

			const rendered = await env.renderString(template, context);
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

			const rendered = await env.renderString(template, context);
			expect(rendered.trim()).to.equal('Result: 42');
		  });
		});

		describe('Async Caller Error Cases', () => {
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
			  await env.renderString(template, context);
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
			  await env.renderString(template, context);
			}
			catch (error) {
			  expect(error.message).to.contain('Nested async error');
			}
		  });
		});
	  });

	});
})();