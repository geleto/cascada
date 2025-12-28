const fs = require('fs');
const path = require('path');

// Paths
const DOCS_SOURCE = path.resolve(__dirname, '../docs/cascada/script.md');
const GENERATED_DOCS_ROOT = path.resolve(__dirname, '../generated-docs');
const GENERATED_DOCS_SCRIPT_DIR = path.join(GENERATED_DOCS_ROOT, 'script');
const TARGET_README = path.join(GENERATED_DOCS_SCRIPT_DIR, 'README.md');
const TARGET_INDEX = path.join(GENERATED_DOCS_SCRIPT_DIR, 'index.html');
const TARGET_NOJEKYLL = path.join(GENERATED_DOCS_SCRIPT_DIR, '.nojekyll');

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
