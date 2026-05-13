import expect from 'expect.js';
import {AsyncEnvironment, AsyncTemplate, Script} from '../../src/environment/environment.js';

describe('Inheritance Step 0a surface', function () {
  let env;

  beforeEach(function () {
    env = new AsyncEnvironment();
  });

  it('accepts script extends none through the public script compiler', function () {
    expect(function () {
      new Script('extends none\nmethod buildValue()\n  return 1\nendmethod\nreturn this.buildValue()', env, 'step0a-parentless.script').compileSource();
    }).not.to.throwException();
  });

  it('rejects template extends none through the public template compiler', function () {
    expect(function () {
      new AsyncTemplate('{% extends none %}{% block body %}x{% endblock %}', env, 'step0a-template-none.njk').compile();
    }).to.throwException(/templates do not support extends none/);
  });

  it('rejects script extends after constructor statements', function () {
    expect(function () {
      new Script('var theme = "dark"\nextends none\nreturn theme', env, 'step0a-script-order.script').compileSource();
    }).to.throwException(/only shared declarations are allowed before extends/);
  });
});
