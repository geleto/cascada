import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// Paths
const DOCS_SOURCE = path.resolve(scriptDir, '../docs/cascada/script.md');
const GENERATED_DOCS_ROOT = path.resolve(scriptDir, '../generated-docs');
const GENERATED_DOCS_SCRIPT_DIR = path.join(GENERATED_DOCS_ROOT, 'script');
const TARGET_README = path.join(GENERATED_DOCS_SCRIPT_DIR, 'README.md');
const TARGET_INDEX = path.join(GENERATED_DOCS_SCRIPT_DIR, 'index.html');
const TARGET_NOJEKYLL = path.join(GENERATED_DOCS_SCRIPT_DIR, '.nojekyll');
const GITHUB_REPO_URL = 'https://github.com/geleto/cascada';
const GITHUB_REPO_BRANCH = 'master';
const DOCS_SOURCE_REPO_PATH = 'docs/cascada/script.md';

function splitMarkdownLinkTarget(target) {
  const trimmed = target.trim();
  if (trimmed.startsWith('<')) {
    const closeIndex = trimmed.indexOf('>');
    if (closeIndex !== -1) {
      return {
        href: trimmed.slice(1, closeIndex),
        title: trimmed.slice(closeIndex + 1)
      };
    }
  }

  const match = trimmed.match(/^(\S+)(.*)$/);
  return {
    href: match ? match[1] : '',
    title: match ? match[2] : ''
  };
}

function isRelativeLink(href) {
  return href !== ''
    && !href.startsWith('#')
    && !href.startsWith('/')
    && !href.startsWith('//')
    && !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href);
}

function githubLinkForRelativePath(href, sourceRepoPath) {
  const suffixIndex = href.search(/[?#]/);
  const filePath = suffixIndex === -1 ? href : href.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : href.slice(suffixIndex);
  const repoPath = path.posix.normalize(path.posix.join(path.posix.dirname(sourceRepoPath), filePath));
  return `${GITHUB_REPO_URL}/blob/${GITHUB_REPO_BRANCH}/${repoPath}${suffix}`;
}

function prefixRelativeMarkdownLinks(markdown, sourceRepoPath) {
  return markdown.replace(/(!?\[[^\]]*\])\(([^)\r\n]+)\)/g, (match, label, target) => {
    const { href, title } = splitMarkdownLinkTarget(target);
    if (!isRelativeLink(href)) {
      return match;
    }

    return `${label}(${githubLinkForRelativePath(href, sourceRepoPath)}${title})`;
  });
}

// Ensure directory exists
if (fs.existsSync(GENERATED_DOCS_SCRIPT_DIR)) {
  fs.rmSync(GENERATED_DOCS_SCRIPT_DIR, { recursive: true, force: true });
}
fs.mkdirSync(GENERATED_DOCS_SCRIPT_DIR, { recursive: true });

// Copy Markdown
// Copy Markdown (modify to remove H1)
let content = fs.readFileSync(DOCS_SOURCE, 'utf8');
// Remove the first H1 heading (# Tile)
content = content.replace(/^#\s+.+\r?\n/, '');
content = prefixRelativeMarkdownLinks(content, DOCS_SOURCE_REPO_PATH);
fs.writeFileSync(TARGET_README, content);
console.log(`Processed and copied ${DOCS_SOURCE} to ${TARGET_README}`);

// Create .nojekyll
fs.writeFileSync(TARGET_NOJEKYLL, '');
console.log('Created .nojekyll');

// Create index.html
const indexHtmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Cascada Script Documentation</title>
  <meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1" />
  <meta name="description" content="Cascada Script Documentation">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0">
  <link rel="stylesheet" href="//cdn.jsdelivr.net/npm/docsify@4/lib/themes/vue.css">
  <style>
    /* Bold top-level sidebar items (H2) */
    .sidebar-nav > ul > li > a {
      font-weight: bold;
      color: #333; /* Optional: Make it slightly darker */
    }
    /* Normal weight for nested items (H3) */
    .sidebar-nav > ul > li > ul > li > a {
      font-weight: normal;
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    window.$docsify = {
      name: 'Cascada Script',
      repo: 'https://github.com/geleto/cascada',
      loadSidebar: false,
      subMaxLevel: 3,
      maxLevel: 3,
      auto2top: true
    }
  </script>
  <!-- Docsify v4 -->
  <script src="//cdn.jsdelivr.net/npm/docsify@4"></script>
</body>
</html>`;

fs.writeFileSync(TARGET_INDEX, indexHtmlContent);
console.log(`Created ${TARGET_INDEX}`);

console.log('Docs build complete.');
