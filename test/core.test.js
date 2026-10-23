'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../src/core.js');

const root = path.join(__dirname, '..');
const seed = JSON.parse(fs.readFileSync(path.join(root, 'src', 'seed.json'), 'utf8'));

// Build a state from a compact spec: { sysId: { rowName: code } } where the code is
// one character per column: d = done, n = N/A, - (or empty) = todo.
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

// A v1 (six-column) export row, for migration tests.
const V1 = ['draft', 'solve', 'pdf', 'merge', 'figures', 'print'];
function v1Row(id, code, doneAts = {}) {
  const stages = {};
  V1.forEach((st, i) => {
    const state = code[i] === 'd' ? 'done' : code[i] === 'n' ? 'na' : 'todo';
    stages[st] = { state, doneAt: state === 'done' ? doneAts[st] || '2026-01-01T00:00:00.000Z' : null };
  });
  return { id, name: id, notes: '', stages };
}

test('there is a single Done column', () => {
  assert.deepEqual(C.STAGES, ['done']);
  assert.equal(C.STAGE_LABELS.done, 'Done');
  assert.equal(C.SCHEMA_VERSION, 2);
});

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

test('progress excludes N/A rows from the maths', () => {
  const s = makeState({ a: { r1: 'd', r2: 'd', r3: '-', r4: 'n', r5: 'n' } });
  const t = C.tally(s.systems[0].rows);
  assert.equal(t.applicable, 3);
  assert.equal(t.done, 2);
  assert.equal(Math.round(t.pct * 100) / 100, 66.67);
  assert.deepEqual(
    { done: t.perStage.done.done, applicable: t.perStage.done.applicable, na: t.perStage.done.na },
    { done: 2, applicable: 3, na: 2 },
  );
});

test('progress with no applicable rows is null, not NaN or 100', () => {
  const s = makeState({ a: { r1: 'n', r2: 'n' } });
  assert.equal(C.tally(s.systems[0].rows).pct, null);
  assert.equal(C.tally([]).pct, null);
});

test('overall progress across systems', () => {
  const s = makeState({ a: { r1: 'd', r2: '-', r3: 'n' }, b: { r4: 'd', r5: 'd', r6: '-' } });
  const o = C.overallProgress(s);
  assert.equal(o.totalRows, 6);
  assert.equal(o.applicable, 5);
  assert.equal(o.done, 3);
  assert.equal(o.pct, 60);
  assert.equal(o.completeRows, 4); // done or N/A
});

/* ---------- Next up ---------- */

test('next action is Done for todo rows and nothing for done or N/A rows', () => {
  const rows = makeState({ a: { r1: '-', r2: 'd', r3: 'n' } }).systems[0].rows;
  assert.deepEqual(rows.map((r) => C.nextAction(r)), ['done', null, null]);
});

test('queue lists todo rows in system order, pinned rows first', () => {
  const s = makeState({ a: { a1: 'd', a2: '', a3: '' }, b: { b1: '', b2: 'n', b3: '' } });
  let q = C.nextUpQueue(s);
  assert.deepEqual(q.map((i) => i.rowName), ['a2', 'a3', 'b1', 'b3']);
  C.findRow(s, 'b/b3').row.pinned = true;
  C.findRow(s, 'a/a3').row.pinned = true;
  q = C.nextUpQueue(s);
  assert.deepEqual(q.map((i) => i.rowName), ['a3', 'b3', 'a2', 'b1']);
  assert.equal(q[0].pinned, true);
  C.setCell(C.findRow(s, 'a/a3').row.stages.done, 'done');
  assert.ok(!C.nextUpQueue(s).some((i) => i.rowName === 'a3')); // pinned but done: leaves the queue
});

/* ---------- Import validation ---------- */

test('a fresh seed state round-trips through validation unchanged', () => {
  const s = C.stateFromSeed(seed);
  const v = C.validateImport(JSON.parse(JSON.stringify(s)));
  assert.equal(v.ok, true);
  assert.deepEqual(v.data, s);
});

test('a worked state round-trips through validation unchanged', () => {
  const s = makeState({ a: { r1: 'd', r2: 'n', r3: '' } });
  s.systems[0].collapsed = true;
  s.systems[0].rows[0].notes = 'merge with renal acid-base';
  s.systems[0].rows[2].pinned = true;
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
    'string schemaVersion': { ...good, schemaVersion: '2' },
    'newer schemaVersion': { ...good, schemaVersion: 3 },
    'older schemaVersion with no migration': { ...good, schemaVersion: 0 },
    'missing systems': { ...good, systems: undefined },
    'wrong stages': { ...good, stages: ['draft', 'solve'] },
    'bad cell state': (() => { const x = C.clone(good); x.systems[0].rows[0].stages.done.state = 'maybe'; return x; })(),
    'missing cell': (() => { const x = C.clone(good); delete x.systems[0].rows[0].stages.done; return x; })(),
    'duplicate row id': (() => { const x = C.clone(good); x.systems[0].rows.push(C.clone(x.systems[0].rows[0])); return x; })(),
    'duplicate system id': (() => { const x = C.clone(good); x.systems.push(C.clone(x.systems[0])); return x; })(),
    'row without id': (() => { const x = C.clone(good); x.systems[0].rows[0].id = ''; return x; })(),
    'bad doneAt': (() => { const x = C.clone(good); x.systems[0].rows[0].stages.done.doneAt = 'yesterday-ish'; return x; })(),
    'notes not string': (() => { const x = C.clone(good); x.systems[0].rows[0].notes = 42; return x; })(),
    'v1 file with a broken row': { schemaVersion: 1, stages: V1, systems: [{ id: 'a', name: 'A', rows: [{ id: 'a/x', name: 'x', stages: { draft: 'oops' } }] }] },
  };
  for (const [name, input] of Object.entries(cases)) {
    const v = C.validateImport(input);
    assert.equal(v.ok, false, `${name} should be rejected`);
    assert.ok(v.errors.length > 0 && v.errors.every((e) => typeof e === 'string'), name);
  }
  assert.match(C.validateImport({ ...good, schemaVersion: 0 }).errors[0], /too old/);
  assert.match(C.validateImport({ ...good, schemaVersion: 3 }).errors[0], /newer/);
});

test('validation never mutates its input', () => {
  const s = makeState({ a: { r1: '-' } });
  s.systems[0].rows[0].stages.done.doneAt = '2026-01-01T00:00:00.000Z'; // todo with a stray doneAt
  const before = JSON.stringify(s);
  const v = C.validateImport(s);
  assert.equal(JSON.stringify(s), before);
  assert.equal(v.data.systems[0].rows[0].stages.done.doneAt, null); // normalised in the copy
});

test('v1 (six-column) files migrate to the single Done column', () => {
  const v1 = {
    schemaVersion: 1,
    updatedAt: '2026-03-01T00:00:00.000Z',
    stages: V1,
    systems: [{
      id: 'a', name: 'A', collapsed: true, rows: [
        v1Row('a/all-done', 'dddddd', { pdf: '2026-02-10T00:00:00.000Z', print: '2026-02-20T00:00:00.000Z' }),
        v1Row('a/done-with-na', 'ddddnd'),
        v1Row('a/all-na', 'nnnnnn'),
        v1Row('a/partial', 'ddd---'),
        v1Row('a/out-of-order', '-----d'),
        v1Row('a/untouched', '------'),
      ],
    }],
  };
  v1.systems[0].rows[0].notes = 'keep me';
  const before = JSON.stringify(v1);
  const v = C.validateImport(v1);
  assert.equal(v.ok, true, v.errors && v.errors.join('; '));
  assert.equal(JSON.stringify(v1), before);
  assert.equal(v.data.schemaVersion, 2);
  assert.deepEqual(v.data.stages, ['done']);
  const rows = v.data.systems[0].rows;
  assert.deepEqual(rows.map((r) => r.stages.done.state), ['done', 'done', 'na', 'todo', 'todo', 'todo']);
  assert.equal(rows[0].stages.done.doneAt, '2026-02-20T00:00:00.000Z'); // latest stage completion
  assert.equal(rows[3].stages.done.doneAt, null);
  assert.equal(rows[0].notes, 'keep me');
  assert.equal(v.data.systems[0].collapsed, true);
  assert.equal(v.data.updatedAt, '2026-03-01T00:00:00.000Z');
});

/* ---------- Merge ---------- */

test('merge keeps the more advanced state per row and the earliest doneAt', () => {
  const cur = makeState({ a: { r1: 'd', r2: '-', r3: 'n', r4: 'd', r5: '-' } });
  const inc = makeState({ a: { r1: 'n', r2: 'd', r3: '-', r4: 'd', r5: 'n' } });
  C.findRow(inc, 'a/r4').row.stages.done.doneAt = '2025-12-01T00:00:00.000Z';
  const { state, report } = C.mergeStates(cur, inc);
  const st = (id) => C.findRow(state, id).row.stages.done;
  // done beats N/A beats todo
  assert.deepEqual(['r1', 'r2', 'r3', 'r4', 'r5'].map((r) => st(`a/${r}`).state), ['done', 'done', 'na', 'done', 'na']);
  assert.equal(st('a/r4').doneAt, '2025-12-01T00:00:00.000Z');
  assert.equal(report.upgradedCells, 2);
  assert.equal(report.addedRows, 0);
});

test('merge adds new rows and systems in place and never removes anything', () => {
  const cur = makeState({ a: { r1: 'd', mine: 'd' }, c: { c1: '' } });
  const inc = makeState({ a: { r0: '', r1: '', rNew: 'd' }, b: { b1: 'd' }, c: { c1: '' } });
  const { state, report } = C.mergeStates(cur, inc);
  assert.deepEqual(state.systems.map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(state.systems[0].rows.map((r) => r.name), ['r0', 'r1', 'rNew', 'mine']);
  assert.equal(C.findRow(state, 'a/mine').row.stages.done.state, 'done');
  assert.equal(C.findRow(state, 'a/r1').row.stages.done.state, 'done');
  assert.equal(C.findRow(state, 'a/rNew').row.stages.done.state, 'done');
  assert.equal(report.addedRows, 3);
  assert.equal(report.addedSystems, 1);
  assert.equal(cur.systems.length, 2); // inputs untouched
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
  const s = makeState({ a: { r1: 'd', r2: 'n', r3: '' } });
  const { state, report } = C.mergeStates(s, C.clone(s));
  assert.deepEqual({ ...state, updatedAt: null }, { ...s, updatedAt: null });
  assert.deepEqual(report, { addedSystems: 0, addedRows: 0, upgradedCells: 0, notesMerged: 0, skippedDeleted: 0 });
});

test('merging an old v1 export into current data works after migration', () => {
  const cur = makeState({ a: { r1: '-', r2: 'd' } });
  const v1 = { schemaVersion: 1, stages: V1, systems: [{ id: 'a', name: 'A', rows: [v1Row('a/r1', 'dddddd'), v1Row('a/r2', '------')] }] };
  const v = C.validateImport(v1);
  assert.equal(v.ok, true);
  const { state } = C.mergeStates(cur, v.data);
  assert.equal(C.findRow(state, 'a/r1').row.stages.done.state, 'done');
  assert.equal(C.findRow(state, 'a/r2').row.stages.done.state, 'done'); // local progress kept
});

test('re-seed merge keeps progress, renames and custom rows, and respects deletions', () => {
  const cur = C.stateFromSeed(seed);
  const cv = cur.systems.find((s) => s.id === 'cardiovascular-system');
  C.setCell(cv.rows[0].stages.done, 'done');
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
  assert.equal(cv2.rows[0].stages.done.state, 'done');
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
  const s = makeState({ a: { r1: 'd', r2: 'n' }, b: { x: '' } });
  s.systems[1].collapsed = true;
  s.systems[0].rows[0].notes = 'note';
  const exported = JSON.stringify(s, null, 2);
  const v = C.validateImport(JSON.parse(exported));
  assert.equal(v.ok, true);
  assert.deepEqual(v.data, s);
});
