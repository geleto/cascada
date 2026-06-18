import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import he from 'he';
import {marked, Renderer} from 'marked';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// Paths
const DOCS_SOURCE = path.resolve(scriptDir, '../docs/cascada/script.md');
const GENERATED_DOCS_ROOT = path.resolve(scriptDir, '../generated-docs');
const GENERATED_DOCS_SCRIPT_DIR = path.join(GENERATED_DOCS_ROOT, 'script');
const TARGET_README = path.join(GENERATED_DOCS_SCRIPT_DIR, 'README.md');
const TARGET_INDEX = path.join(GENERATED_DOCS_SCRIPT_DIR, 'index.html');
const TARGET_NOJEKYLL = path.join(GENERATED_DOCS_SCRIPT_DIR, '.nojekyll');
const TARGET_ROBOTS = path.join(GENERATED_DOCS_SCRIPT_DIR, 'robots.txt');
const TARGET_SITEMAP = path.join(GENERATED_DOCS_SCRIPT_DIR, 'sitemap.xml');
const GITHUB_REPO_URL = 'https://github.com/geleto/cascada';
const GITHUB_REPO_BRANCH = 'master';
const DOCS_SOURCE_REPO_PATH = 'docs/cascada/script.md';
const DOCS_SITE_URL = 'https://geleto.github.io/cascada-script/';
const DOCS_TITLE = 'Cascada Script Documentation';
const DOCS_DESCRIPTION = 'Cascada Script language reference and documentation for the parallel-first Cascada scripting engine.';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, '');
}

function plainText(value) {
  return he.decode(stripHtml(value));
}

function slugifyHeading(value, slugCounts) {
  const baseSlug = plainText(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
  const count = slugCounts.get(baseSlug) || 0;
  slugCounts.set(baseSlug, count + 1);
  return count === 0 ? baseSlug : `${baseSlug}-${count}`;
}

function createMarkdownRenderer(headings) {
  const renderer = new Renderer();
  const slugCounts = new Map();

  renderer.heading = function ({ tokens, depth, text }) {
    const renderedText = this.parser.parseInline(tokens);
    const slug = slugifyHeading(text, slugCounts);
    headings.push({
      level: depth,
      text: plainText(renderedText),
      slug
    });
    return `<h${depth} id="${slug}"><a href="#${slug}" class="anchor"><span>${renderedText}</span></a></h${depth}>\n`;
  };

  renderer.code = ({ text, lang: language }) => {
    const lang = language ? String(language).trim() : '';
    const languageClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    const dataLang = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    return `<pre${dataLang}><code${languageClass}>${escapeHtml(text)}</code></pre>\n`;
  };

  return renderer;
}

function buildSidebar(headings) {
  const sidebarHeadings = headings.filter(heading => heading.level >= 2 && heading.level <= 3);
  if (sidebarHeadings.length === 0) {
    return '';
  }

  let html = '<ul>';
  let openSection = false;
  let openSubsection = false;

  function sidebarLink(heading) {
    const label = escapeHtml(heading.text);
    return `<a href="#${heading.slug}" title="${label}">${label}</a>`;
  }

  sidebarHeadings.forEach(heading => {
    const level = Math.max(2, Math.min(3, heading.level));

    if (level === 2) {
      if (openSubsection) {
        html += '</ul>';
        openSubsection = false;
      }
      if (openSection) {
        html += '</li>';
      }
      html += `<li>${sidebarLink(heading)}`;
      openSection = true;
      return;
    }

    if (!openSection) {
      html += '<li>';
      openSection = true;
    }
    if (!openSubsection) {
      html += '<ul>';
      openSubsection = true;
    }
    html += `<li>${sidebarLink(heading)}</li>`;
  });

  if (openSubsection) {
    html += '</ul>';
  }
  if (openSection) {
    html += '</li>';
  }

  return `${html}</ul>`;
}

function githubCorner() {
  return `<a href="${GITHUB_REPO_URL}" class="github-corner" aria-label="View source on GitHub">
  <svg viewBox="0 0 250 250" aria-hidden="true">
    <path d="M0,0 L115,115 L130,115 L142,142 L250,250 L250,0 Z"></path>
    <path class="octo-arm" d="M128.3,109.0 C113.8,99.7 119.0,89.6 119.0,89.6 C122.0,82.7 120.5,78.6 120.5,78.6 C119.2,72.0 123.4,76.3 123.4,76.3 C127.3,80.9 125.5,87.3 125.5,87.3 C122.9,97.6 130.6,101.9 134.4,103.2" fill="currentColor" style="transform-origin: 130px 106px;"></path>
    <path class="octo-body" d="M115.0,115.0 C114.9,115.1 118.7,116.5 119.8,115.4 L133.7,101.6 C136.9,99.2 139.9,98.4 142.2,98.6 C133.8,88.0 127.5,74.4 143.8,58.0 C148.3,53.5 154.0,51.2 159.7,51.0 C160.3,49.4 163.2,43.6 171.4,40.1 C171.4,40.1 176.1,42.5 178.8,56.2 C183.1,58.6 187.2,61.8 190.9,65.4 C194.5,69.0 197.7,73.2 200.1,77.6 C213.8,80.2 216.3,84.9 216.3,84.9 C212.7,93.1 206.9,96.0 205.4,96.6 C205.1,102.4 202.8,108.0 198.3,112.5 C181.9,128.9 168.3,122.5 157.7,114.1 C157.9,116.9 156.7,120.9 152.7,124.9 L141.0,136.5 C139.8,137.7 141.6,141.9 141.8,141.8 Z" fill="currentColor"></path>
  </svg>
</a>`;
}

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

const headings = [];
const renderer = createMarkdownRenderer(headings);
const renderedContent = marked(content, {
  gfm: true,
  headerIds: false,
  renderer
});
const sidebarHtml = buildSidebar(headings);

// Create .nojekyll
fs.writeFileSync(TARGET_NOJEKYLL, '');
console.log('Created .nojekyll');

// Create index.html
const indexHtmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${DOCS_TITLE}</title>
  <meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1" />
  <meta name="description" content="${DOCS_DESCRIPTION}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, minimum-scale=1.0">
  <link rel="canonical" href="${DOCS_SITE_URL}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${DOCS_TITLE}">
  <meta property="og:description" content="${DOCS_DESCRIPTION}">
  <meta property="og:url" content="${DOCS_SITE_URL}">
  <link rel="stylesheet" href="//cdn.jsdelivr.net/npm/docsify@4/lib/themes/vue.css">
  <style>
    :root {
      --theme-color: #42b983;
    }

    body {
      background-color: #fff;
    }

    main {
      min-height: 100vh;
    }

    .github-corner {
      z-index: 40;
    }

    .sidebar {
      background-color: #fff;
      position: fixed;
    }

    .sidebar-toggle {
      position: fixed;
      top: 0;
      bottom: auto;
    }

    .content {
      min-height: 100vh;
      position: static;
      margin-left: 300px;
      padding-top: 20px;
    }

    body.close .content {
      margin-left: 0;
    }

    .markdown-section {
      max-width: 960px;
    }

    .markdown-section h1,
    .markdown-section h2,
    .markdown-section h3,
    .markdown-section h4 {
      scroll-margin-top: 24px;
    }

    /* Bold top-level sidebar items (H2) */
    .sidebar-nav > ul > li > a {
      font-weight: bold;
      color: #333; /* Optional: Make it slightly darker */
    }
    /* Normal weight for nested items (H3) */
    .sidebar-nav > ul > li > ul > li > a {
      font-weight: normal;
    }

    @media screen and (max-width: 768px) {
      .content {
        margin-left: 0;
      }

      body.close .content {
        margin-left: 0;
      }
    }
  </style>
</head>
<body class="ready sticky">
  ${githubCorner()}
  <main>
    <aside class="sidebar">
      <h1><a href="${DOCS_SITE_URL}">Cascada Script</a></h1>
      <div class="sidebar-nav">
        ${sidebarHtml}
      </div>
    </aside>
    <button class="sidebar-toggle" type="button" aria-label="Toggle sidebar">
      <div class="sidebar-toggle-button">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </button>
    <section class="content">
      <article class="markdown-section" id="main">
        <h1 id="cascada-script-documentation"><a href="#cascada-script-documentation" class="anchor"><span>Cascada Script Documentation</span></a></h1>
        ${renderedContent}
      </article>
    </section>
  </main>
  <script>
    (function () {
      const body = document.body;
      const sidebar = document.querySelector('.sidebar');
      const toggle = document.querySelector('.sidebar-toggle');
      const links = Array.from(document.querySelectorAll('.sidebar-nav a[href^="#"]'));
      const headings = links
        .map(link => document.getElementById(decodeURIComponent(link.hash.slice(1))))
        .filter(Boolean);

      toggle.addEventListener('click', () => {
        body.classList.toggle('close');
      });

      links.forEach(link => {
        link.addEventListener('click', event => {
          const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
          if (target) {
            event.preventDefault();
            history.pushState(null, '', link.hash);
            scrollToTarget(target);
          }

          if (window.matchMedia('(max-width: 768px)').matches) {
            body.classList.remove('close');
          }
        });
      });

      function scrollToTarget(target) {
        const start = window.pageYOffset;
        const end = Math.max(0, target.getBoundingClientRect().top + start - 24);
        const duration = 450;
        const startTime = performance.now();

        function tick(now) {
          const progress = Math.min(1, (now - startTime) / duration);
          const eased = progress < 0.5
            ? 2 * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;
          window.scrollTo(0, start + (end - start) * eased);
          if (progress < 1) {
            requestAnimationFrame(tick);
          } else {
            setActiveLink();
          }
        }

        requestAnimationFrame(tick);
      }

      function setActiveLink() {
        let activeHeading = headings[0];
        const offset = 32;

        for (const heading of headings) {
          if (heading.getBoundingClientRect().top <= offset) {
            activeHeading = heading;
          } else {
            break;
          }
        }

        links.forEach(link => {
          const isActive = activeHeading && link.hash === '#' + activeHeading.id;
          link.parentElement.classList.toggle('active', isActive);
          if (isActive && sidebar) {
            const itemTop = link.offsetTop;
            const itemBottom = itemTop + link.offsetHeight;
            if (itemTop < sidebar.scrollTop) {
              sidebar.scrollTop = itemTop;
            } else if (itemBottom > sidebar.scrollTop + sidebar.clientHeight) {
              sidebar.scrollTop = itemBottom - sidebar.clientHeight;
            }
          }
        });
      }

      setActiveLink();
      window.addEventListener('scroll', setActiveLink, { passive: true });
      window.addEventListener('hashchange', setActiveLink);
    }());
  </script>
</body>
</html>`;

fs.writeFileSync(TARGET_INDEX, indexHtmlContent);
console.log(`Created ${TARGET_INDEX}`);

fs.writeFileSync(TARGET_ROBOTS, `User-agent: *
Allow: /

Sitemap: ${DOCS_SITE_URL}sitemap.xml
`);
console.log(`Created ${TARGET_ROBOTS}`);

fs.writeFileSync(TARGET_SITEMAP, `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${DOCS_SITE_URL}</loc>
  </url>
</urlset>
`);
console.log(`Created ${TARGET_SITEMAP}`);

console.log('Docs build complete.');
