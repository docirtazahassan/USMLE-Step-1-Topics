'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../src/core.js');

const root = path.join(__dirname, '..');
const seed = JSON.parse(fs.readFileSync(path.join(root, 'src', 'seed.json'), 'utf8'));

// Build a state from a compact spec: { sysId: { rowName: 'dd-n..' } } where each
// character is one stage: d = done, n = N/A, - = todo.
function makeState(spec) {
  const s = C.stateFromSeed({
    systems: Object.entries(spec).map(([sid, rows]) => ({
      id: sid, name: sid.toUpperCase(),
      rows: Object.keys(rows).map((rn) => ({ id: `${sid}/${rn}`, name: rn })),
    })),
  });
  s.systems.forEach((sys) => sys.rows.forEach((row) => {
    const code = spec[sys.id][row.name];
    C.STAGES.forEach((st, i) => {
      const ch = code[i] || '-';
      C.setCell(row.stages[st], ch === 'd' ? 'done' : ch === 'n' ? 'na' : 'todo', '2026-01-01T00:00:00.000Z');
    });
  }));
  return s;
}

/* ---------- Markdown parsing ---------- */

test('parses the real markdown into 26 systems with system-scoped unique ids', () => {
  const md = fs.readFileSync(path.join(root, 'uworld_systems_subheadings.md'), 'utf8');
  const { systems, warnings } = C.parseMarkdown(md);
  assert.equal(systems.length, 26);
  assert.equal(systems.reduce((n, s) => n + s.rows.length, 0), 169);
  assert.deepEqual(warnings, []);
  const ids = systems.flatMap((s) => s.rows.map((r) => r.id));
  assert.equal(new Set(ids).size, ids.length);
  systems.forEach((s) => s.rows.forEach((r) => assert.ok(r.id.startsWith(`${s.id}/`))));
  assert.ok(ids.includes('cardiovascular-system/miscellaneous'));
  assert.ok(ids.includes('dermatology/miscellaneous'));
});

test('src/seed.json matches the markdown (re-run npm run seed if this fails)', () => {
  const md = fs.readFileSync(path.join(root, 'uworld_systems_subheadings.md'), 'utf8');
  assert.deepEqual(seed.systems, C.parseMarkdown(md).systems);
});

test('parser handles edge cases', () => {
  const md = [
    '# Title is ignored',
    '- orphan bullet',
    '## Heart & Lungs',
    '* Star bullet',
    '+ Plus bullet',
    '- Miscellaneous',
    '- Miscellaneous',
    '   - indented   ',
    '### sub-sub heading ignored',
    'plain text ignored',
    '',
    '## Empty',
    '## Kidney ##',
    '- Miscellaneous',
  ].join('\r\n');
  const { systems, warnings } = C.parseMarkdown(md);
  assert.deepEqual(systems.map((s) => s.id), ['heart-and-lungs', 'empty', 'kidney']);
  assert.deepEqual(systems[0].rows.map((r) => r.id), [
    'heart-and-lungs/star-bullet', 'heart-and-lungs/plus-bullet', 'heart-and-lungs/miscellaneous',
    'heart-and-lungs/miscellaneous-2', 'heart-and-lungs/indented',
  ]);
  assert.equal(systems[2].name, 'Kidney');
  assert.equal(systems[2].rows[0].id, 'kidney/miscellaneous');
  assert.equal(warnings.length, 3); // orphan, duplicate, empty system
});

test('slugify', () => {
  assert.equal(C.slugify('Rheumatology/Orthopedics & Sports'), 'rheumatology-orthopedics-and-sports');
  assert.equal(C.slugify('Ear, Nose & Throat (ENT)'), 'ear-nose-and-throat-ent');
  assert.equal(C.slugify('Café  Ünïcode'), 'cafe-unicode');
  assert.equal(C.slugify('***'), 'item');
});

/* ---------- Cells ---------- */

test('cell cycles todo → done → na → todo and stamps doneAt only when done', () => {
  const cell = { state: 'todo', doneAt: null };
  C.setCell(cell, C.nextCellState(cell.state), '2026-02-02T00:00:00.000Z');
  assert.deepEqual(cell, { state: 'done', doneAt: '2026-02-02T00:00:00.000Z' });
  C.setCell(cell, C.nextCellState(cell.state));
  assert.deepEqual(cell, { state: 'na', doneAt: null });
  C.setCell(cell, C.nextCellState(cell.state));
  assert.deepEqual(cell, { state: 'todo', doneAt: null });
  assert.equal(C.setCell(cell, 'todo'), false);
});

/* ---------- Progress ---------- */

test('progress excludes N/A cells from the maths', () => {
  const s = makeState({ a: { r1: 'dddddd', r2: 'dd--nn', r3: 'nnnnnn' } });
  const t = C.tally(s.systems[0].rows);
  // applicable: r1 6 + r2 4 + r3 0 = 10; done: 6 + 2 = 8
  assert.equal(t.applicable, 10);
  assert.equal(t.done, 8);
  assert.equal(t.pct, 80);
  assert.deepEqual(
    { done: t.perStage.figures.done, applicable: t.perStage.figures.applicable, na: t.perStage.figures.na },
    { done: 1, applicable: 1, na: 2 },
  );
  assert.equal(t.perStage.figures.pct, 100);
  assert.equal(t.perStage.pdf.pct, 50);
});

test('progress with no applicable cells is null, not NaN or 100', () => {
  const s = makeState({ a: { r1: 'nnnnnn' } });
  assert.equal(C.tally(s.systems[0].rows).pct, null);
  assert.equal(C.tally([]).pct, null);
});

test('overall progress counts fully printed and complete rows', () => {
  const s = makeState({ a: { r1: 'dddddd', r2: 'ddddnd', r3: 'd' }, b: { r4: 'nnnnnn', r5: '-----d' } });
  const o = C.overallProgress(s);
  assert.equal(o.totalRows, 5);
  assert.equal(o.fullyPrinted, 3); // r1, r2, r5 have print done
  assert.equal(o.completeRows, 3); // r1, r2, r4 have no todo
  assert.equal(o.applicable, 6 + 5 + 6 + 0 + 6);
  assert.equal(o.done, 6 + 5 + 1 + 0 + 1);
});

test('order warning lists earlier todo stages for a done cell only', () => {
  const s = makeState({ a: { r: 'd-dn-d' } });
  const row = s.systems[0].rows[0];
  assert.deepEqual(C.orderWarning(row, 'pdf'), ['solve']);
  assert.deepEqual(C.orderWarning(row, 'print'), ['solve', 'figures']);
  assert.deepEqual(C.orderWarning(row, 'draft'), []);
  assert.deepEqual(C.orderWarning(row, 'solve'), []); // todo cell: no warning
  assert.deepEqual(C.orderWarning(row, 'merge'), []); // N/A cell: no warning
});

/* ---------- Next up ---------- */

test('next action is the first todo stage, skipping done and N/A', () => {
  const rows = makeState({ a: { r1: '------', r2: 'dn----', r3: 'ddddnd', r4: 'd-d---', r5: 'nnnnnn' } }).systems[0].rows;
  assert.deepEqual(rows.map((r) => C.nextAction(r)), ['draft', 'pdf', null, 'solve', null]);
});

test('queue groups by stage in system order, pinned rows first', () => {
  const s = makeState({
    a: { a1: 'd', a2: '', a3: 'dd' },
    b: { b1: '', b2: 'dddddd', b3: 'd' },
  });
  let q = C.nextUpQueue(s);
  assert.deepEqual(q.map((i) => `${i.rowName}:${i.stage}`), ['a2:draft', 'b1:draft', 'a1:solve', 'b3:solve', 'a3:pdf']);
  C.findRow(s, 'b/b3').row.pinned = true;
  C.findRow(s, 'a/a3').row.pinned = true;
  q = C.nextUpQueue(s);
  assert.deepEqual(q.map((i) => `${i.rowName}:${i.stage}`), ['a3:pdf', 'b3:solve', 'a2:draft', 'b1:draft', 'a1:solve']);
  assert.equal(q[0].pinned, true);
});

/* ---------- Import validation ---------- */

test('a fresh seed state round-trips through validation unchanged', () => {
  const s = C.stateFromSeed(seed);
  const v = C.validateImport(JSON.parse(JSON.stringify(s)));
  assert.equal(v.ok, true);
  assert.deepEqual(v.data, s);
});

test('a worked state round-trips through validation unchanged', () => {
  const s = makeState({ a: { r1: 'dn-d', r2: 'dddddd' } });
  s.systems[0].collapsed = true;
  s.systems[0].rows[0].notes = 'merge with renal acid-base';
  s.systems[0].rows[0].pinned = true;
  s.deletedRowIds = ['a/old'];
  const v = C.validateImport(JSON.parse(JSON.stringify(s)));
  assert.equal(v.ok, true);
  assert.deepEqual(v.data, s);
});

test('rejects corrupted and wrong-shaped files with readable errors', () => {
  const good = makeState({ a: { r1: 'd' } });
  const cases = {
    'not an object': [1, 2, 3],
    'null': null,
    'no schemaVersion': { systems: [] },
    'string schemaVersion': { ...good, schemaVersion: '1' },
    'newer schemaVersion': { ...good, schemaVersion: 2 },
    'older schemaVersion': { ...good, schemaVersion: 0 },
    'missing systems': { ...good, systems: undefined },
    'wrong stages': { ...good, stages: ['draft', 'solve'] },
    'bad cell state': (() => { const x = C.clone(good); x.systems[0].rows[0].stages.pdf.state = 'maybe'; return x; })(),
    'missing cell': (() => { const x = C.clone(good); delete x.systems[0].rows[0].stages.print; return x; })(),
    'duplicate row id': (() => { const x = C.clone(good); x.systems[0].rows.push(C.clone(x.systems[0].rows[0])); return x; })(),
    'duplicate system id': (() => { const x = C.clone(good); x.systems.push(C.clone(x.systems[0])); return x; })(),
    'row without id': (() => { const x = C.clone(good); x.systems[0].rows[0].id = ''; return x; })(),
    'bad doneAt': (() => { const x = C.clone(good); x.systems[0].rows[0].stages.draft.doneAt = 'yesterday-ish'; return x; })(),
    'notes not string': (() => { const x = C.clone(good); x.systems[0].rows[0].notes = 42; return x; })(),
  };
  for (const [name, input] of Object.entries(cases)) {
    const v = C.validateImport(input);
    assert.equal(v.ok, false, `${name} should be rejected`);
    assert.ok(v.errors.length > 0 && v.errors.every((e) => typeof e === 'string'), name);
  }
  assert.match(C.validateImport({ ...good, schemaVersion: 0 }).errors[0], /too old/);
  assert.match(C.validateImport({ ...good, schemaVersion: 2 }).errors[0], /newer/);
});

test('validation never mutates its input', () => {
  const s = makeState({ a: { r1: 'd' } });
  s.systems[0].rows[0].stages.solve.doneAt = '2026-01-01T00:00:00.000Z'; // todo with a stray doneAt
  const before = JSON.stringify(s);
  const v = C.validateImport(s);
  assert.equal(JSON.stringify(s), before);
  assert.equal(v.data.systems[0].rows[0].stages.solve.doneAt, null); // normalised in the copy
});

test('older schema versions are migrated when a migration exists', () => {
  const s = makeState({ a: { r1: 'd' } });
  const v0 = { ...C.clone(s), schemaVersion: 0, legacyStages: s.stages };
  delete v0.stages;
  C.MIGRATIONS[0] = (d) => { const x = { ...d, schemaVersion: 1, stages: d.legacyStages }; delete x.legacyStages; return x; };
  try {
    const v = C.validateImport(v0);
    assert.equal(v.ok, true);
    assert.deepEqual(v.data.systems, s.systems);
  } finally {
    delete C.MIGRATIONS[0];
  }
});

/* ---------- Merge ---------- */

test('merge keeps the more advanced state per cell and earliest doneAt', () => {
  const cur = makeState({ a: { r1: 'd-n-d-', r2: '------' } });
  const inc = makeState({ a: { r1: 'nd-dd-', r2: 'dddddd' } });
  C.findRow(cur, 'a/r1').row.stages.pdf.state = 'na';
  C.findRow(inc, 'a/r1').row.stages.figures.doneAt = '2025-12-01T00:00:00.000Z';
  const { state, report } = C.mergeStates(cur, inc);
  const r1 = C.findRow(state, 'a/r1').row;
  // draft: done vs na → done; solve: todo vs done → done; pdf: na vs todo → na;
  // merge: todo vs done → done; figures: done vs done → earlier doneAt; print: todo vs todo.
  assert.deepEqual(C.STAGES.map((s) => r1.stages[s].state), ['done', 'done', 'na', 'done', 'done', 'todo']);
  assert.equal(r1.stages.figures.doneAt, '2025-12-01T00:00:00.000Z');
  assert.ok(C.findRow(state, 'a/r2').row.stages.print.state === 'done');
  assert.equal(report.upgradedCells, 2 + 6);
  assert.equal(report.addedRows, 0);
});

test('merge adds new rows and systems in place and never removes anything', () => {
  const cur = makeState({ a: { r1: 'd', mine: 'dd' }, c: { c1: '' } });
  const inc = makeState({ a: { r0: '', r1: '', rNew: 'd' }, b: { b1: 'd' }, c: { c1: '' } });
  const { state, report } = C.mergeStates(cur, inc);
  assert.deepEqual(state.systems.map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(state.systems[0].rows.map((r) => r.name), ['r0', 'r1', 'rNew', 'mine']);
  assert.equal(C.findRow(state, 'a/mine').row.stages.solve.state, 'done');
  assert.equal(C.findRow(state, 'a/rNew').row.stages.draft.state, 'done');
  assert.equal(report.addedRows, 3);
  assert.equal(report.addedSystems, 1);
  // inputs untouched
  assert.equal(cur.systems.length, 2);
});

test('merge combines notes and pins without duplicating', () => {
  const cur = makeState({ a: { r1: '', r2: '', r3: '' } });
  const inc = C.clone(cur);
  C.findRow(cur, 'a/r1').row.notes = 'mine';
  C.findRow(inc, 'a/r1').row.notes = 'theirs';
  C.findRow(cur, 'a/r2').row.notes = 'same';
  C.findRow(inc, 'a/r2').row.notes = 'same';
  C.findRow(inc, 'a/r3').row.notes = 'new note';
  C.findRow(inc, 'a/r3').row.pinned = true;
  const { state } = C.mergeStates(cur, inc);
  assert.equal(C.findRow(state, 'a/r1').row.notes, 'mine\n---\ntheirs');
  assert.equal(C.findRow(state, 'a/r2').row.notes, 'same');
  assert.equal(C.findRow(state, 'a/r3').row.notes, 'new note');
  assert.equal(C.findRow(state, 'a/r3').row.pinned, true);
});

test('merging a state with itself changes nothing but updatedAt', () => {
  const s = makeState({ a: { r1: 'dn-d', r2: 'dddddd' } });
  const { state, report } = C.mergeStates(s, C.clone(s));
  assert.deepEqual({ ...state, updatedAt: null }, { ...s, updatedAt: null });
  assert.deepEqual(report, { addedSystems: 0, addedRows: 0, upgradedCells: 0, notesMerged: 0, skippedDeleted: 0 });
});

test('re-seed merge keeps progress, renames and custom rows, and respects deletions', () => {
  const cur = C.stateFromSeed(seed);
  const cv = cur.systems.find((s) => s.id === 'cardiovascular-system');
  C.setCell(cv.rows[0].stages.draft, 'done');
  cv.rows[1].name = 'Renamed by me';
  cv.rows.push(C.newRow('cardiovascular-system/my-split-row', 'My split row'));
  const deleted = cv.rows.splice(2, 1)[0];
  cur.deletedRowIds.push(deleted.id);

  // Updated markdown: one new subheading and one new system.
  const md = fs.readFileSync(path.join(root, 'uworld_systems_subheadings.md'), 'utf8')
    .replace('- Hypertension', '- Hypertension\n- Brand new subheading')
    + '\n## New System\n- Thing\n';
  const newSeed = C.parseMarkdown(md);
  const { state, report } = C.mergeStates(cur, C.stateFromSeed(newSeed), { respectDeleted: true });

  const cv2 = state.systems.find((s) => s.id === 'cardiovascular-system');
  assert.equal(cv2.rows[0].stages.draft.state, 'done');
  assert.equal(cv2.rows[1].name, 'Renamed by me');
  assert.ok(cv2.rows.some((r) => r.id === 'cardiovascular-system/my-split-row'));
  assert.ok(!cv2.rows.some((r) => r.id === deleted.id));
  const idx = cv2.rows.findIndex((r) => r.name === 'Brand new subheading');
  assert.equal(cv2.rows[idx - 1].name, 'Hypertension');
  assert.equal(state.systems[state.systems.length - 1].name, 'New System');
  assert.equal(report.addedRows, 2);
  assert.equal(report.skippedDeleted, 1);

  // A plain import merge (not a re-seed) does bring a deleted row back, because nothing is lost on import.
  const back = C.mergeStates(cur, C.stateFromSeed(seed)).state;
  assert.ok(C.findRow(back, deleted.id));
  assert.ok(!back.deletedRowIds.includes(deleted.id));
});

test('export → reset → import (replace) restores the identical state', () => {
  const s = makeState({ a: { r1: 'dn-d', r2: 'dddddd' }, b: { x: 'n' } });
  s.systems[1].collapsed = true;
  s.systems[0].rows[0].notes = 'note';
  const exported = JSON.stringify(s, null, 2);
  const v = C.validateImport(JSON.parse(exported));
  assert.equal(v.ok, true);
  assert.deepEqual(v.data, s);
});
