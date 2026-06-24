import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import expect from 'expect.js';
import {AsyncEnvironment} from '../../src/environment/environment.js';
import {StringLoader} from '../util.js';

async function expectRejects(operation, messagePart) {
  try {
    await operation();
    expect().fail(`Expected operation to reject with ${messagePart}`);
  } catch (err) {
    expect(err.message).to.contain(messagePart);
  }
}

describe('Async declaration conflict visibility', function () {
  let loader;
  let env;

  beforeEach(function () {
    loader = new StringLoader();
    env = new AsyncEnvironment(loader);
  });

  it('rejects template call_assign var declarations that reuse a visible name', async function () {
    const template = `
      {% macro wrap() %}{{ caller() }}{% endmacro %}
      {% var result = 1 %}
      {% call_assign var result = wrap() %}
        2
      {% endcall_assign %}
      {{ result }}
    `;

    await expectRejects(
      () => env.renderTemplateString(template),
      'Identifier \'result\' has already been declared.'
    );
  });

  it('rejects script call assignment declarations that reuse a visible name', async function () {
    const script = `
      function wrap()
        return caller()
      endfunction

      var result = 1
      var result = call wrap()
        return 2
      endcall

      return result
    `;

    await expectRejects(
      () => env.renderScriptString(script),
      'Identifier \'result\' has already been declared.'
    );
  });

  it('rejects template declarations that reuse a later macro name', async function () {
    const template = `
      {% set label = "local" %}
      {% macro label() %}macro{% endmacro %}
      {{ label }}
    `;

    await expectRejects(
      () => env.renderTemplateString(template),
      'Identifier \'label\' has already been declared.'
    );
  });

  it('rejects script declarations that reuse a later function name', async function () {
    const script = `
      var label = "local"

      function label()
        return "macro"
      endfunction

      return label
    `;

    await expectRejects(
      () => env.renderScriptString(script),
      'Identifier \'label\' has already been declared.'
    );
  });

  it('rejects clean-scope callable declarations that reuse an outer callable name', async function () {
    const template = `
      {% macro label() %}outer{% endmacro %}
      {% macro wrapper() %}
        {% macro label() %}inner{% endmacro %}
        {{ label() }}
      {% endmacro %}
      {{ wrapper() }}
    `;

    await expectRejects(
      () => env.renderTemplateString(template),
      'Identifier \'label\' has already been declared.'
    );
  });

  it('rejects duplicate template import namespaces before loading the target', async function () {
    const template = `
      {% import "missing.njk" as lib %}
      {% import "missing.njk" as lib %}
      {{ lib.value }}
    `;

    await expectRejects(
      () => env.renderTemplateString(template),
      'Identifier \'lib\' has already been declared.'
    );
  });

  it('rejects duplicate template from-import bindings before loading the target', async function () {
    const template = `
      {% from "missing.njk" import value %}
      {% from "missing.njk" import value %}
      {{ value }}
    `;

    await expectRejects(
      () => env.renderTemplateString(template),
      'Identifier \'value\' has already been declared.'
    );
  });

  it('rejects duplicate template from-import bindings in the same import list before loading the target', async function () {
    const template = `
      {% from "missing.njk" import first as value, second as value %}
      {{ value }}
    `;

    await expectRejects(
      () => env.renderTemplateString(template),
      'Identifier \'value\' has already been declared.'
    );
  });

  it('rejects template imports that reuse an outer visible name inside a non-clean block', async function () {
    const template = `
      {% set lib = "outer" %}
      {% if true %}
        {% import "missing.njk" as lib %}
      {% endif %}
    `;

    await expectRejects(
      () => env.renderTemplateString(template),
      'Identifier \'lib\' has already been declared.'
    );
  });

  it('rejects template from-imports that reuse an outer visible name inside a non-clean block', async function () {
    const template = `
      {% set value = "outer" %}
      {% if true %}
        {% from "missing.njk" import value %}
      {% endif %}
    `;

    await expectRejects(
      () => env.renderTemplateString(template),
      'Identifier \'value\' has already been declared.'
    );
  });

  it('rejects duplicate component aliases before loading the target script', async function () {
    loader.addTemplate('Main.script', [
      'component "Missing.script" as ns',
      'component "Missing.script" as ns',
      'return ns'
    ].join('\n'));

    await expectRejects(
      () => env.renderScript('Main.script'),
      'Identifier \'ns\' has already been declared.'
    );
  });

  it('rejects component aliases that reuse an outer visible name inside a non-clean block', async function () {
    loader.addTemplate('Main.script', [
      'var ns = "outer"',
      'if true',
      '  component "Missing.script" as ns',
      'endif',
      'return ns'
    ].join('\n'));

    await expectRejects(
      () => env.renderScript('Main.script'),
      'Identifier \'ns\' has already been declared.'
    );
  });

  it('rejects script loop targets that reuse an outer visible name', async function () {
    const script = `
      var item = "outer"
      for item in [1, 2]
        var seen = item
      endfor
      return item
    `;

    await expectRejects(
      () => env.renderScriptString(script),
      'Identifier \'item\' has already been declared.'
    );
  });

  it('rejects template loop targets that reuse an outer visible name', async function () {
    const template = `
      {% set item = "outer" %}
      {% for item in [1, 2] %}
        {{ item }}
      {% endfor %}
    `;

    await expectRejects(
      () => env.renderTemplateString(template),
      'Identifier \'item\' has already been declared.'
    );
  });

  it('rejects script each targets that reuse an outer visible name', async function () {
    const script = `
      var item = "outer"
      each item in [1, 2]
        var seen = item
      endeach
      return item
    `;

    await expectRejects(
      () => env.renderScriptString(script),
      'Identifier \'item\' has already been declared.'
    );
  });

  it('rejects template asyncEach targets that reuse an outer visible name', async function () {
    const template = `
      {% set item = "outer" %}
      {% asyncEach item in [1, 2] %}
        {{ item }}
      {% endeach %}
    `;

    await expectRejects(
      () => env.renderTemplateString(template),
      'Identifier \'item\' has already been declared.'
    );
  });

  it('keeps visible template set as mutation instead of a new declaration', async function () {
    const template = `
      {% set status = "outer" %}
      {% if true %}
        {% set status = "updated" %}
      {% endif %}
      {{ status }}
    `;

    const result = await env.renderTemplateString(template);
    expect(result.trim()).to.be('updated');
  });

  it('rejects user declarations of compiler waited and return names', async function () {
    await expectRejects(
      () => env.renderScriptString('var __waited__ = 1\nreturn __waited__'),
      'reserved'
    );
    await expectRejects(
      () => env.renderTemplateString('{% set __return__ = 1 %}{{ __return__ }}'),
      'reserved'
    );
  });

  it('allows macro parameters to reuse outer names because macros are clean scopes', async function () {
    const script = `
      var item = "outer"

      function echo(item)
        return item
      endfunction

      return { outer: item, inner: echo("inner") }
    `;

    const result = await env.renderScriptString(script);
    expect(result).to.eql({ outer: 'outer', inner: 'inner' });
  });

  it('keeps fixed waited lanes isolated across nested and adjacent waited buffers', async function () {
    const script = `
      data out

      for outer in [1, 2] of 1
        if allow(outer)
          out.items.push(outer * 10)
        endif
        for inner in [1, 2] of 1
          if allow(inner)
            out.items.push(outer * 10 + inner)
          endif
        endfor
      endfor

      for tail in [3, 4] of 1
        out.items.push(tail)
      endfor

      return out.snapshot()
    `;

    const result = await env.renderScriptString(script, {
      async allow() {
        return true;
      }
    });
    expect(result).to.eql({ items: [10, 11, 12, 20, 21, 22, 3, 4] });
  });

  it('rejects duplicate caller argument names in the caller producer list', async function () {
    const script = `
      function wrap()
        return caller(1, 2)
      endfunction

      var result = call wrap() (value, value)
        return value
      endcall

      return result
    `;

    await expectRejects(
      () => env.renderScriptString(script),
      'Identifier \'value\' has already been declared.'
    );
  });

  it('keeps call-block returns isolated from the enclosing callable return lane', async function () {
    const script = `
      function run()
        return caller()
      endfunction

      function outer()
        var callerResult = call run()
          return "caller"
        endcall

        return { callerResult: callerResult, outerResult: "outer" }
      endfunction

      return outer()
    `;

    const result = await env.renderScriptString(script);
    expect(result).to.eql({ callerResult: 'caller', outerResult: 'outer' });
  });

  it('keeps nested compiler return lanes isolated when scopes reuse __return__ internally', async function () {
    const script = `
      function wrap()
        return caller()
      endfunction

      function outer()
        function inner()
          return "inner"
        endfunction

        var callerResult = call wrap()
          return inner()
        endcall

        return { innerResult: inner(), callerResult: callerResult, outerResult: "outer" }
      endfunction

      return outer()
    `;

    const result = await env.renderScriptString(script);
    expect(result).to.eql({
      innerResult: 'inner',
      callerResult: 'inner',
      outerResult: 'outer'
    });
  });

  it('does not pair clean scope boundaries with parentReadOnly analyzers', function () {
    const compilerDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src/compiler'
    );
    const offenders = [];

    fs.readdirSync(compilerDir)
      .filter((filename) => filename.endsWith('.js'))
      .forEach((filename) => {
        const source = fs.readFileSync(path.join(compilerDir, filename), 'utf8');
        const cleanThenReadonly = /scopeBoundary:\s*true[\s\S]{0,180}parentReadOnly:\s*true/.test(source);
        const readonlyThenClean = /parentReadOnly:\s*true[\s\S]{0,180}scopeBoundary:\s*true/.test(source);
        if (cleanThenReadonly || readonlyThenClean) {
          offenders.push(filename);
        }
      });

    expect(offenders).to.eql([]);
  });
});
