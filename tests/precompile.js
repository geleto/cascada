import expect from 'expect.js';
import {
  precompile,
  precompileString,
  precompileScriptString,
  precompileTemplateAsync,
  precompileTemplateStringAsync
} from '../src/precompile.js';

(function() {

  describe('precompile', function() {
    it('should return a string', function() {
      expect(precompileString('{{ test }}', {
        name: 'test.njk'
      })).to.be.an('string');
    });

    it('should support an ESM template map wrapper', function() {
      const output = precompileString('{{ test }}', {
        name: 'test.njk',
        format: 'esm'
      });

      expect(output).to.contain('const templates = {};');
      expect(output).to.contain('templates["test.njk"] =');
      expect(output).to.contain('export default templates;');
    });

    it('should preserve async mode for precompileTemplateStringAsync', function() {
      const output = precompileTemplateStringAsync('{{ test }}', {
        name: 'async-test.njk'
      });

      expect(output).to.contain('function root(env, context, runtime, cb');
      expect(output).to.not.contain('function root(env, context, frame, runtime, cb');
    });

    it('should preserve async mode for precompileTemplateAsync', function() {
      const output = precompileTemplateAsync('./tests/templates/item.njk');

      expect(output).to.contain('function root(env, context, runtime, cb');
      expect(output).to.not.contain('function root(env, context, frame, runtime, cb');
    });

    it('should compile script strings as Cascada script syntax', function() {
      const output = precompileScriptString('var result = {}\nresult.x = 1\nreturn result', {
        name: 'script-test.casc'
      });

      expect(output).to.contain('function root(env, context, runtime, cb');
      expect(output).to.not.contain('var result = {}\\nresult.x = 1\\nreturn result');
      expect(output).to.contain('runtime.declareBufferChannel(output, "result", "var"');
      expect(output).to.contain('new runtime.VarCommand');
    });

    describe('templates', function() {
      it('should return *NIX path seperators', function() {
        var fileName;

        precompile('./tests/templates/item.njk', {
          wrapper: function(templates) {
            fileName = templates[0].name;
          }
        });

        expect(fileName).to.equal('./tests/templates/item.njk');
      });

      it('should return *NIX path seperators, when name is passed as option', function() {
        var fileName;

        precompile('<span>test</span>', {
          name: 'path\\to\\file.j2',
          isString: true,
          wrapper: function(templates) {
            fileName = templates[0].name;
          }
        });

        expect(fileName).to.equal('path/to/file.j2');
      });
    });
  });
}());
