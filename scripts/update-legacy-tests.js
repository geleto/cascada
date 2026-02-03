const fs = require('fs');
const path = require('path');
const { parseTemplateLine, TOKEN_TYPES, TOKEN_SUBTYPES } = require('../src/script/script-lexer');
const scriptUpdater = require('../src/script/script-updater');

const LEGACY_REGEX = /@(?:data|text|value)\b/;

function usage() {
  console.log('Usage: node scripts/update-legacy-tests.js <path> [--dry-run] [--preview]');
}

function isTemplateLiteralWithExpr(tokenValue) {
  return tokenValue.startsWith('`') && tokenValue.includes('${');
}

function decodeStringLiteral(tokenValue) {
  const quote = tokenValue[0];
  if (quote !== '\'' && quote !== '"' && quote !== '`') {
    return null;
  }
  if (tokenValue[tokenValue.length - 1] !== quote) {
    return null;
  }
  if (quote === '`') {
    // Keep raw content for template literals (no eval to avoid execution)
    const inner = tokenValue.slice(1, -1);
    return { quote, value: inner, isTemplate: true };
  }
  try {
    // Use Function to parse JS escapes for single/double quotes
    // eslint-disable-next-line no-new-func
    const value = Function(`"use strict"; return (${tokenValue});`)();
    return { quote, value, isTemplate: false };
  } catch (err) {
    return null;
  }
}

function encodeStringLiteral(value, quote, isTemplate) {
  if (quote === '`') {
    // Escape backticks and ${ in template literals
    const escaped = value.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    return '`' + escaped + '`';
  }
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '\\"' : "\\'");
  return quote + escaped + quote;
}

function convertScriptString(rawScript) {
  try {
    const result = scriptUpdater.scriptToTemplateAndScript(rawScript, { injectReturnedOutputsOnly: true });
    return result.script;
  } catch (err) {
    return null;
  }
}

function getIndentPrefix(script) {
  const lines = script.split('\n');
  let prefix = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^[ \t]*/);
    if (!match) continue;
    const indent = match[0];
    if (prefix === null) {
      prefix = indent;
      continue;
    }
    while (prefix && !indent.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix || '';
}

function stripIndent(script, prefix) {
  if (!prefix) return script;
  const lines = script.split('\n');
  const stripped = lines.map((line) => {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length);
    }
    return line;
  });
  return stripped.join('\n');
}

function addIndent(script, prefix) {
  if (!prefix) return script;
  const lines = script.split('\n');
  const indented = lines.map((line) => {
    if (!line.trim()) return line;
    return prefix + line;
  });
  return indented.join('\n');
}

function shouldConvertString(decoded) {
  if (!decoded || !decoded.value) return false;
  if (!decoded.value.includes('\n')) return false;
  return LEGACY_REGEX.test(decoded.value);
}

function processTemplateLiterals(content) {
  if (!content.includes('`') || !LEGACY_REGEX.test(content)) {
    return { changed: false, content };
  }

  const lines = content.split('\n');
  const lineOffsets = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  const replacements = [];
  const state = { inMultiLineComment: false, stringState: null };
  let openTemplate = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parsed = parseTemplateLine(line, state.inMultiLineComment, state.stringState);

    for (const token of parsed.tokens || []) {
      if (token.type !== TOKEN_TYPES.STRING || token.subtype !== TOKEN_SUBTYPES.TEMPLATE) {
        continue;
      }

      const tokenStartsTemplate = token.value.startsWith('`');
      const tokenEndsTemplate = token.value.endsWith('`') && token.incomplete !== true;

      if (!openTemplate && tokenStartsTemplate) {
        openTemplate = {
          startAbs: lineOffsets[i] + token.start
        };
      }

      if (openTemplate && tokenEndsTemplate) {
        const endAbs = lineOffsets[i] + token.end;
        replacements.push({ start: openTemplate.startAbs, end: endAbs });
        openTemplate = null;
      }
    }

    state.inMultiLineComment = parsed.inMultiLineComment;
    state.stringState = parsed.stringState;
  }

  if (!replacements.length) {
    return { changed: false, content };
  }

  let changed = false;
  let updated = content;

  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end } = replacements[i];
    const rawLiteral = updated.slice(start, end);
    if (!rawLiteral.startsWith('`') || !rawLiteral.endsWith('`')) {
      continue;
    }
    if (rawLiteral.includes('${')) {
      continue;
    }
    const inner = rawLiteral.slice(1, -1);
    if (!shouldConvertString({ value: inner })) {
      continue;
    }

    const prefix = getIndentPrefix(inner);
    const normalized = stripIndent(inner, prefix);
    const converted = convertScriptString(normalized);
    if (!converted) {
      continue;
    }

    const reindented = addIndent(converted, prefix);
    const newLiteral = encodeStringLiteral(reindented, '`', true);
    updated = updated.slice(0, start) + newLiteral + updated.slice(end);
    changed = true;
  }

  return { changed, content: updated };
}

function processContent(content) {
  if (!LEGACY_REGEX.test(content)) {
    return { changed: false, content };
  }

  const templateResult = processTemplateLiterals(content);
  let workingContent = templateResult.content;

  const lines = content.split('\n');
  const outLines = [];
  const state = { inMultiLineComment: false, stringState: null };
  let changed = false;

  const workingLines = workingContent.split('\n');
  for (let i = 0; i < workingLines.length; i++) {
    const line = workingLines[i];
    const parsed = parseTemplateLine(line, state.inMultiLineComment, state.stringState);
    const tokens = parsed.tokens || [];

    const newTokens = tokens.map((token) => {
      if (token.type !== TOKEN_TYPES.STRING) return token.value;
      if (!LEGACY_REGEX.test(token.value)) return token.value;
      if (isTemplateLiteralWithExpr(token.value)) return token.value;

      const decoded = decodeStringLiteral(token.value);
      if (!decoded) return token.value;

      if (!shouldConvertString(decoded)) return token.value;

      const updated = convertScriptString(decoded.value);
      if (!updated) return token.value;
      const encoded = encodeStringLiteral(updated, decoded.quote, decoded.isTemplate);
      changed = true;
      return encoded;
    });

    outLines.push(newTokens.join(''));

    state.inMultiLineComment = parsed.inMultiLineComment;
    state.stringState = parsed.stringState;
  }

  return { changed: changed || templateResult.changed, content: outLines.join('\n') };
}

function walkFiles(targetPath) {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return [targetPath];

  const results = [];
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const fullPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function isTestFile(filePath) {
  return filePath.endsWith('.js') && filePath.includes(path.sep + 'tests' + path.sep);
}

function runMocha(filePath) {
  const { spawnSync } = require('child_process');
  const runner = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(runner, ['mocha', filePath, '--timeout', '5000'], { stdio: 'inherit' });
  return result.status === 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    usage();
    process.exit(1);
  }

  const targetPath = path.resolve(process.cwd(), args[0]);
  const dryRun = args.includes('--dry-run');
  const preview = args.includes('--preview');

  const files = walkFiles(targetPath).filter(isTestFile);
  if (!files.length) {
    console.log('No test files found.');
    return;
  }

  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    if (!LEGACY_REGEX.test(original)) {
      continue;
    }

    const processed = processContent(original);
    if (!processed.changed) {
      continue;
    }

    const tempPath = filePath + '.tmp';
    fs.writeFileSync(tempPath, processed.content, 'utf8');

    if (dryRun) {
      console.log(`[dry-run] ${filePath}`);
      if (!preview) {
        fs.unlinkSync(tempPath);
      }
      continue;
    }

    console.log(`[run] ${filePath}`);
    const ok = runMocha(tempPath);
    if (ok) {
      if (preview) {
        console.log(`  preview ok - keeping temp file`);
      } else {
        fs.writeFileSync(filePath, processed.content, 'utf8');
        fs.unlinkSync(tempPath);
        console.log(`  updated`);
      }
    } else {
      console.log(`  failed - keeping temp file`);
    }
  }
}

main();
