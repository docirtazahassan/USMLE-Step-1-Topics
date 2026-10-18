#!/usr/bin/env node
// Parse uworld_systems_subheadings.md into src/seed.json and print counts.
// Usage: node scripts/parse-seed.js [path/to/file.md]
'use strict';
const fs = require('fs');
const path = require('path');
const { parseMarkdown } = require('../src/core.js');

const root = path.join(__dirname, '..');
const mdPath = path.resolve(process.argv[2] || path.join(root, 'uworld_systems_subheadings.md'));
const outPath = path.join(root, 'src', 'seed.json');

const { systems, warnings } = parseMarkdown(fs.readFileSync(mdPath, 'utf8'));
const seed = { source: path.basename(mdPath), systems };
fs.writeFileSync(outPath, JSON.stringify(seed, null, 2) + '\n');

const rowCount = systems.reduce((n, s) => n + s.rows.length, 0);
console.log(`Parsed ${path.relative(process.cwd(), mdPath)} -> ${path.relative(process.cwd(), outPath)}`);
console.log(`${systems.length} systems, ${rowCount} subheadings\n`);
systems.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s.name.padEnd(52)} ${String(s.rows.length).padStart(3)}`));
if (warnings.length) {
  console.log('\nWarnings:');
  warnings.forEach((w) => console.log(`  - ${w}`));
}
