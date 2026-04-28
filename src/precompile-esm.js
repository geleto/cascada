
function precompileEsm(templates) {
  let out = 'const templates = {};\n\n';

  for (let i = 0; i < templates.length; i++) {
    const name = JSON.stringify(templates[i].name);
    const template = templates[i].template;

    out += 'templates[' + name + '] = (function() {\n' + template + '\n})();\n\n';
  }

  out += 'export default templates;\n';
  return out;
}

export default precompileEsm;
