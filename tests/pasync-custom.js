(function () {
  'use strict';

  var expect;
  var unescape;
  var PAsyncEnvironment;
  //var Environment;
  var lexer;

  if (typeof require !== 'undefined') {
    expect = require('expect.js');
    PAsyncEnvironment = require('../nunjucks/src/environment').PAsyncEnvironment;
    //Environment = require('../nunjucks/src/environment').Environment;
    lexer = require('../nunjucks/src/lexer');
    unescape = require('he').unescape;
  } else {
    expect = window.expect;
    unescape = window.he.unescape;
    PAsyncEnvironment = nunjucks.PAsyncEnvironment;
    //Environment = nunjucks.Environment;
    lexer = nunjucks.lexer;
  }

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  class AsyncExtension {
    constructor(tagName, method, options = {}) {
      this.tags = [tagName, 'separator'];
      this.method = method;
      this.supportsBody = options.supportsBody || false;
      this.doNotResolveArgs = options.doNotResolveArgs || false;
      this.oldAsync = options.oldAsync || false;
      this.numContentArgs = 0; // Will be set during parsing
    }

    parse(parser, nodes) {
      const tok = parser.nextToken(); // Get the tag token

      if (tok.value === this.tags[0]) {
        // Parsing the main tag (e.g., 'wrap')
        return this.parseMainTag(parser, nodes, tok);
      } else {
        parser.fail(`Unexpected tag: ${tok.value}`, tok.lineno, tok.colno);
        return undefined;
      }
    }

    parseMainTag(parser, nodes, tok) {
      const args = parser.parseSignature(null, true); // Parse arguments
      parser.advanceAfterBlockEnd(tok.value); // Move parser past the block end

      let contentArgs = [];
      if (this.supportsBody) {
        contentArgs = this.parseBody(parser, nodes, tok.value);
        this.numContentArgs = contentArgs.length;
      }

      // Return a CallExtension node with arguments and optional content bodies
      if (this.oldAsync) {
        return new nodes.CallExtensionAsync(this, 'run', args, contentArgs, !this.doNotResolveArgs);
      } else {
        return new nodes.CallExtension(this, 'run', args, contentArgs, !this.doNotResolveArgs);
      }
    }

    parseBody(parser, nodes, tagName) {
      const bodies = [];

      while (true) {
        const body = parser.parseUntilBlocks('separator', 'end' + tagName);
        bodies.push(body);

        // After parseUntilBlocks, the parser is at the tag name token (TOKEN_SYMBOL)
        const tagTok = parser.nextToken(); // Should be TOKEN_SYMBOL

        if (tagTok.type !== lexer.TOKEN_SYMBOL) {
          parser.fail('Expected tag name', tagTok.lineno, tagTok.colno);
        }

        const tagNameValue = tagTok.value;

        // Advance after block end (this moves past '%}')
        parser.advanceAfterBlockEnd(tagNameValue);

        if (tagNameValue === 'separator') {
          // Continue parsing the next body
          continue;
        } else if (tagNameValue === 'end' + tagName) {
          // End of the tag block
          break;
        } else {
          parser.fail(
            `Unexpected tag "${tagNameValue}" in extension`,
            tagTok.lineno,
            tagTok.colno
          );
        }
      }

      return bodies; // Return array of bodies
    }

    async run(context, ...args) {
      if (this.doNotResolveArgs) {
        await Promise.all(args);
      }

      let callback = null;
      if (this.oldAsync) {
        //the old async uses a callback as the last argument
        callback = args.pop();
      }

      const bodies = [];
      for (let i = 0; i < this.numContentArgs; i++) {
        let body = args.pop();
        if (!this.doNotResolveArgs) {
          // Render the body content if it's a function
          body = await new Promise((resolve, reject) => {
            body((err, res) => {
              if (err) reject(err);
              else resolve(res);
            });
          });
        }
        else {
          body = await body;
        }
        bodies.unshift(body);
      }

      const bodyContent = await this.method(context, ...args, bodies.length > 1 ? bodies : bodies[0]);

      if (callback) {
        callback(null, bodyContent);
        return undefined;
      }
      else {
        return bodyContent;
      }

      /*if (this.supportsBody && typeof args[args.length - 1] === 'function') {
        const body = args.pop();
        if(this.parallel) {
        bodyContent = body;
        }
        else {
        // Render the body content if it's a function
        bodyContent = await new Promise((resolve, reject) => {
          body((err, res) => {
          if (err) reject(err);
          else resolve(res);
          });
        });
        }
      }*/

      // Call the method with arguments and the rendered body content
      //const result = await this.method(context, ...args, bodyContent);

    }
  }

  describe('Async mode - custom extensions and filters', () => {
    let env;
    beforeEach(() => {
      env = new PAsyncEnvironment();
    });

    describe('Async Custom Extensions', () => {
      it('should handle a simple async extension function', async () => {
        const greetExtension = new AsyncExtension('greet', async (context, name) => {
          await delay(5);
          return `Hello, ${name}!`;
        });

        env.addExtension('GreetExtension', greetExtension);

        const template = '{% greet "John" %}';
        const result = await env.renderString(template);
        expect(result).to.equal('Hello, John!');
      });

      it('should handle a simple callback extension function (old async)', async () => {
        env.addExtension('getName', {
          tags: ['greet'],
          parse(parser, nodes) {
            var tok = parser.nextToken();
            var args = parser.parseSignature(null, true);
            parser.advanceAfterBlockEnd(tok.value);
            return new nodes.CallExtensionAsync(this, 'run', args);
          },
          run(context, name, callback) {
            setTimeout(() => {
              callback(null, `Hello, ${name}!`);
            }, 5);
          }
        });

        const template = '{% greet "John" %}';
        const result = await env.renderString(template);
        expect(result).to.equal('Hello, John!');
      });

      it('should handle a simple old-style extension function (old sync)', async () => {
        env.addExtension('getName', {
          tags: ['greet'],
          parse(parser, nodes) {
            var tok = parser.nextToken();
            var args = parser.parseSignature(null, true);
            parser.advanceAfterBlockEnd(tok.value);
            return new nodes.CallExtension(this, 'run', args);
          },
          run(context, name) {
            return `Hello, ${name}!`;
          }
        });

        const template = '{% greet "John" %}';
        const result = await env.renderString(template);
        expect(result).to.equal('Hello, John!');
      });

      it('should handle an async extension function with multiple arguments', async () => {
        const addExtension = new AsyncExtension('add', async (context, a, b) => {
          await delay(5);
          return a + b;
        });

        env.addExtension('AddExtension', addExtension);

        const template = '{% add 5, 3 %}';
        const result = await env.renderString(template);
        expect(result).to.equal('8');
      });

      it('should handle async extension tags in loops', async () => {
        const getNameExtension = new AsyncExtension('getName', async (context, number) => {
          await delay(5 - number);
          const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
          return names[number % names.length];
        });

        env.addExtension('GetNameExtension', getNameExtension);

        const template = `
        <ul>
          {%- for i in range(5) %}
          <li>{% getName i -%}</li>
          {%- endfor %}
        </ul>`;

        const result = await env.renderString(template);
        const expected = `
        <ul>
          <li>Alice</li>
          <li>Bob</li>
          <li>Charlie</li>
          <li>David</li>
          <li>Eve</li>
        </ul>`;

        expect(result).to.equal(expected);
      });

      it('should handle sync extension tags in loops (old sync)', async () => {
        env.addExtension('getNameSync', {
          tags: ['getName'],
          parse(parser, nodes) {
            var tok = parser.nextToken();
            var args = parser.parseSignature(null, true);
            parser.advanceAfterBlockEnd(tok.value);
            return new nodes.CallExtension(this, 'run', args);
          },
          run(context, number) {
            const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
            return names[number % names.length];
          }
        });

        const template = `
        <ul>
          {%- for i in range(5) %}
          <li>{% getName i -%}</li>
          {%- endfor %}
        </ul>`;

        const result = await env.renderString(template);
        const expected = `
        <ul>
          <li>Alice</li>
          <li>Bob</li>
          <li>Charlie</li>
          <li>David</li>
          <li>Eve</li>
        </ul>`;

        expect(result.trim()).to.equal(expected.trim());
      });

      it('should handle async extension tags in loops (old async)', async () => {
        env.addExtension('getNameAsync', {
          tags: ['getName'],
          parse(parser, nodes) {
            var tok = parser.nextToken();
            var args = parser.parseSignature(null, true);
            parser.advanceAfterBlockEnd(tok.value);
            return new nodes.CallExtensionAsync(this, 'run', args);
          },
          run(context, number, callback) {
            const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
            setTimeout(() => {
              const result = names[number % names.length];
              callback(null, result); // Pass the result back via the callback
            }, 5); // Simulate a small asynchronous delay
          }
        });

        const template = `
        <ul>
          {%- for i in range(5) %}
          <li>{% getName i -%}</li>
          {%- endfor %}
        </ul>`;

        const result = await env.renderString(template);
        const expected = `
        <ul>
          <li>Alice</li>
          <li>Bob</li>
          <li>Charlie</li>
          <li>David</li>
          <li>Eve</li>
        </ul>`;

        expect(result).to.equal(expected);
      });


      it('should properly handle errors thrown in async extension tags', async () => {
        const asyncErrorExtension = new AsyncExtension('asyncError', async () => {
          await delay(10); // Simulate some async operation
          throw new Error('Async extension error');
        });

        env.addExtension('AsyncErrorExtension', asyncErrorExtension);

        const template = '{% asyncError %}';

        try {
          await env.renderString(template);
          // If we reach this point, the test should fail
          expect().fail('Expected an error to be thrown');
        } catch (error) {
          expect(error instanceof Error).to.equal(true);
          expect(error.message).to.contain('Async extension error');
        }
      });

      it('should handle an extension tag with one async parameter', async () => {
        const greetExtension = new AsyncExtension('greet', async (context, namePromise) => {
          const name = await namePromise;
          await delay(5); // simulate some async operation
          return `Hello, ${name}!`;
        });

        env.addExtension('GreetExtension', greetExtension);

        const context = {
          getName: async () => {
            await delay(10);
            return 'Alice';
          },
        };

        const template = '{% greet getName() %}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('Hello, Alice!');
      });

      it('should handle an extension tag with two async parameters', async () => {
        const introduceExtension = new AsyncExtension(
          'introduce',
          async (context, namePromise, rolePromise) => {
            const name = await namePromise;
            const role = await rolePromise;
            await delay(5); // simulate some async operation
            return `This is ${name}, our ${role}.`;
          }
        );

        env.addExtension('IntroduceExtension', introduceExtension);

        const context = {
          getName: async () => {
            await delay(10);
            return 'Bob';
          },
          getRole: async () => {
            await delay(15);
            return 'manager';
          },
        };

        const template = '{% introduce getName(), getRole() %}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('This is Bob, our manager.');
      });

      it('should handle an extension tag with mixed async and non-async parameters', async () => {
        const describeUserExtension = new AsyncExtension(
          'describeUser',
          async (context, namePromise, age, cityPromise) => {
            const name = await namePromise;
            const city = await cityPromise;
            await delay(5); // simulate some async operation
            return `${name}, aged ${age}, lives in ${city}.`;
          }
        );

        env.addExtension('DescribeUserExtension', describeUserExtension);

        const context = {
          getName: async () => {
            await delay(10);
            return 'Charlie';
          },
          getCity: async () => {
            await delay(15);
            return 'New York';
          },
        };

        const template = '{% describeUser getName(), 30, getCity() %}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('Charlie, aged 30, lives in New York.');
      });

      it('should handle an extension with a single content block', async () => {
        const options = [
          { supportsBody: true, extName: 'wrap' }, //the old API, but returning async value
          { supportsBody: true, extName: 'pwrap', doNotResolveArgs: true },
          { supportsBody: true, extName: 'awrap', oldAsync: true },
          { supportsBody: true, extName: 'apwrap', oldAsync: true, doNotResolveArgs: true },
        ];
        for (const option of options) {
          const extName = option.extName;
          const wrapExtension = new AsyncExtension(
            extName,
            async (context, tagName, bodyContent) => {
              if (option.doNotResolveArgs) {
                bodyContent = await bodyContent;
              }
              await delay(5);
              return `<${tagName}>${bodyContent}</${tagName}>`;
            },
            option
          );

          env.addExtension(extName, wrapExtension);

          const context = {
            getExtName: async () => {
              await delay(3);
              return extName;
            }
          };

          const template = `
          {% ${extName} "section" %}
          This is some content in {{getExtName()}}.
          {% end${extName} %}
        `;

          const result = await env.renderString(template, context);
          const expected = `
          <section>
          This is some content in ${extName}.
          </section>
        `;

          expect(unescape(result.trim())).to.equal(expected.trim());
        }
      });

      it('should handle an extension with multiple content blocks', async () => {
        const options = [
          { supportsBody: true, extName: 'wrap' },
          { supportsBody: true, extName: 'pwrap', doNotResolveArgs: true },
          { supportsBody: true, extName: 'awrap', oldAsync: true },
        ];
        for (const option of options) {
          const extName = option.extName;
          const wrapExtension = new AsyncExtension(
            extName,
            async (context, tagName, contentBlocks) => {

              await delay(5);

              // Join the content blocks with a separator if alternative content exists
              const mainContent = contentBlocks[0];
              const altContent = contentBlocks[1] || '';
              const result = `<${tagName}>${mainContent}</${tagName}>` +
                (altContent ? `<alt>${altContent}</alt>` : '');

              return result;
            },
            option
          );

          env.addExtension(extName, wrapExtension);

          const context = {
            getExtName: async () => {
              await delay(3);
              return extName;
            }
          };

          const template = `
          {% ${extName} "section" %}
          This is main content in {{getExtName()}}.
          {% separator %}
          This is alternative content in {{getExtName()}}.
          {% end${extName} %}
        `;

          const result = await env.renderString(template, context);
          const expected = `
          <section>
          This is main content in ${extName}.
          </section><alt>
          This is alternative content in ${extName}.
          </alt>
        `;

          expect(unescape(result.trim())).to.equal(expected.trim());
        }
      });
    });

    describe('Nunjucks Async Filter Tests', () => {
      beforeEach(() => {
        // Add async filter using the standard Nunjucks callback-style API
        env.addFilter('asyncUppercase', (str, callback) => {
          setTimeout(() => {
            callback(null, str.toUpperCase());
          }, 5);
        }, true); // true flag indicates this is an async filter

        env.addFilter('asyncReverse', (str, callback) => {
          setTimeout(() => {
            callback(null, str.split('').reverse().join(''));
          }, 3);
        }, true);
      });

      it('should handle standard async filter', async () => {
        const template = '{{ "hello" | asyncUppercase }}';
        const result = await env.renderString(template);
        expect(result).to.equal('HELLO');
      });

      it('should handle chained standard async filters', async () => {
        const template = '{{ "hello" | asyncUppercase | asyncReverse }}';
        const result = await env.renderString(template);
        expect(result).to.equal('OLLEH');
      });

      it('should handle standard async filter with async value', async () => {
        const context = {
          async getText() {
            await delay(5);
            return 'hello';
          }
        };

        const template = '{{ getText() | asyncUppercase }}';
        const result = await env.renderString(template, context);
        expect(result).to.equal('HELLO');
      });

      it('should handle expression with concatenation and multiple filters', async () => {
        const context = {
          async getText() {
            await delay(5);
            return 'hello';
          },
          suffix: 'world'
        };

        // Template that combines async function, string concatenation, and multiple filters
        const template = '{{ getText() | asyncUppercase + " " + suffix | asyncReverse }}';

        const result = await env.renderString(template, context);
        expect(result).to.equal('HELLO dlrow');  // Fixed expectation
      });

      it('should handle expression with concatenation and multiple filters and grouping', async () => {
        const context = {
          async getText() {
            await delay(5);
            return 'hello';
          },
          suffix: 'world'
        };

        // Template that uses parentheses to group the concatenation before applying the reverse filter
        const template = '{{ (getText() | asyncUppercase + " " + suffix) | asyncReverse }}';

        const result = await env.renderString(template, context);
        expect(result).to.equal('dlrow OLLEH');
      });

      it('should handle errors in standard async filters', async () => {
        env.addFilter('asyncError', (str, callback) => {
          setTimeout(() => {
            callback(new Error('Filter error'));
          }, 5);
        }, true);

        const template = '{{ "test" | asyncError }}';

        try {
          await env.renderString(template);
          expect().fail('Expected an error to be thrown');
        } catch (error) {
          expect(error.message).to.contain('Filter error');
        }
      });

      it('should handle standard async filters in set statements', async () => {
        const template = `
          {% set result = "hello" | asyncUppercase %}
          {{ result }}
        `;

        const result = await env.renderString(template);
        expect(result.trim()).to.equal('HELLO');
      });

      it('should handle standard async filters in if conditions', async () => {
        const template = `
          {% if "yes" | asyncUppercase == "YES" %}
            correct
          {% else %}
            incorrect
          {% endif %}
        `;

        const result = await env.renderString(template);
        expect(result.trim()).to.equal('correct');
      });
    });
  });
}());
