#!/usr/bin/env node
// Inline src/* into a single standalone index.html (no dependencies).
// Usage: node scripts/build.js [--check]   (--check fails if index.html is stale)
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');

function build() {
  const seed = JSON.stringify(JSON.parse(src('seed.json'))).replace(/</g, '\\u003c');
  const parts = {
    'styles.css': src('styles.css'),
    'seed.json': seed,
    'core.js': src('core.js'),
    'app.js': src('app.js'),
  };
  for (const [name, text] of Object.entries(parts)) {
    if (name !== 'seed.json' && /<\/(script|style)/i.test(text)) throw new Error(`${name} contains a closing </script> or </style> tag`);
  }
  return src('template.html').replace(/\/\*INLINE:([\w.]+)\*\//g, (_, name) => {
    if (!(name in parts)) throw new Error(`Unknown inline target ${name}`);
    return parts[name];
  });
}

const out = path.join(root, 'index.html');
if (require.main === module) {
  const html = build();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (current !== html) {
      console.error('index.html is out of date. Run: npm run build');
      process.exit(1);
    }
    console.log('index.html is up to date.');
  } else {
    fs.writeFileSync(out, html);
    console.log(`Wrote index.html (${(html.length / 1024).toFixed(1)} KB)`);
  }
}
module.exports = { build };
