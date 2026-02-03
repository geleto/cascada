const scriptUpdater = require('../src/script/script-updater');
const expect = require('expect.js');

describe('Script Updater', () => {
  it('removes root focus directive and preserves indentation', () => {
    const script = '  data data\n  data.user.name = "Alice"\n  return data.snapshot()';
    const result = scriptUpdater.scriptToTemplateAndScript(script);
    const lines = result.script.split('\n');

    expect(lines[0]).to.equal('  data data');
    expect(lines[1]).to.equal('  data.user.name = "Alice"');
    expect(lines[2]).to.equal('  return data.snapshot()');
  });

  it('rejects focus directives on a new line (macro continuation)', () => {
    const script = [
      'macro buildUser()',
      ': data',
      '  @data.user.id = 1',
      'endmacro'
    ].join('\n');

    expect(() => scriptUpdater.scriptToTemplateAndScript(script)).to.throwError(/Output focus directives are not supported/);
  });

  it('injects only used outputs and keeps each declaration on its own line', () => {
    const script = [
      '@data.user.name = "Alice"',
      '@text("Hello")'
    ].join('\n');

    const result = scriptUpdater.scriptToTemplateAndScript(script, { injectReturnedOutputsOnly: true });
    const lines = result.script.split('\n');

    expect(lines).to.contain('data data');
    expect(lines).to.contain('text text');
    expect(lines).to.not.contain('value value');

    const dataIndex = lines.indexOf('data data');
    const textIndex = lines.indexOf('text text');
    expect(dataIndex >= 0).to.be.ok();
    expect(textIndex >= 0).to.be.ok();
    expect(dataIndex).to.not.equal(textIndex);
  });

  it('reuses indentation of the next non-empty line for injected declarations', () => {
    const script = [
      '// Header comment',
      '  @data.user.name = "Alice"'
    ].join('\n');

    const result = scriptUpdater.scriptToTemplateAndScript(script);
    const lines = result.script.split('\n');

    expect(lines[0]).to.equal('// Header comment');
    expect(lines[1]).to.equal('  data data');
    expect(lines[2]).to.equal('  text text');
    expect(lines[3]).to.equal('  value value');
    expect(lines[4]).to.equal('  data.user.name = "Alice"');
  });
});
