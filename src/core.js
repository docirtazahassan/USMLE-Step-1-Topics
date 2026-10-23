/*
 * Tracker core logic: pure functions, no DOM.
 * Runs in the browser (window.TrackerCore) and in Node (require) for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrackerCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  // One status column per subheading. The code works for any number of columns,
  // so more can be added later (bump SCHEMA_VERSION and add a migration).
  const STAGES = ['done'];
  const STAGE_LABELS = { done: 'Done' };
  const STATES = ['todo', 'done', 'na'];
  // How "advanced" a cell is, used when merging: done beats N/A beats todo.
  const RANK = { todo: 0, na: 1, done: 2 };

  // Migrations from older schema versions: MIGRATIONS[n] turns version n into n + 1.
  // They are defensive: anything malformed is passed through for validation to reject.
  const V1_STAGES = ['draft', 'solve', 'pdf', 'merge', 'figures', 'print'];
  const MIGRATIONS = {
    // v1 had six pipeline columns. A row becomes done when every column was done or N/A
    // (and at least one was done), N/A when all were N/A, otherwise to do.
    1: (d) => {
      const obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
      const migrateRow = (r) => {
        if (!obj(r) || !obj(r.stages)) return r;
        const cells = V1_STAGES.map((k) => r.stages[k]);
        if (!cells.every(obj)) return r;
        const states = cells.map((c) => c.state);
        const state = states.every((x) => x === 'na') ? 'na'
          : states.every((x) => x === 'done' || x === 'na') ? 'done' : 'todo';
        const doneAt = state === 'done'
          ? cells.map((c) => c.doneAt).filter((x) => typeof x === 'string').sort().pop() || null
          : null;
        return { ...r, stages: { done: { state, doneAt } } };
      };
      const systems = Array.isArray(d.systems)
        ? d.systems.map((s) => (obj(s) && Array.isArray(s.rows) ? { ...s, rows: s.rows.map(migrateRow) } : s))
        : d.systems;
      const stagesOk = Array.isArray(d.stages) && d.stages.join() === V1_STAGES.join();
      return { ...d, schemaVersion: 2, stages: stagesOk ? STAGES.slice() : d.stages, systems };
    },
  };

  const clone = (x) => JSON.parse(JSON.stringify(x));

  function slugify(s) {
    const slug = String(s)
      .toLowerCase()
      .replace(/&/g, ' and ')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'item';
  }

  function uniqueId(base, taken) {
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }

  /* ---------- Markdown parsing ---------- */

  // "## System" starts a system; "- Subheading" (or * / +) adds a row to it.
  function parseMarkdown(md) {
    const systems = [];
    const warnings = [];
    const sysIds = new Set();
    let cur = null;
    String(md).split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      let m;
      if ((m = /^##\s+(.+?)\s*#*$/.exec(line))) {
        const name = m[1].trim();
        const id = uniqueId(slugify(name), sysIds);
        if (id !== slugify(name)) warnings.push(`line ${i + 1}: duplicate system "${name}" renamed to id ${id}`);
        sysIds.add(id);
        cur = { id, name, rows: [], ids: new Set() };
        systems.push(cur);
      } else if ((m = /^[-*+]\s+(.+)$/.exec(line))) {
        const name = m[1].trim();
        if (!cur) {
          warnings.push(`line ${i + 1}: subheading "${name}" appears before any system; ignored`);
          return;
        }
        const base = `${cur.id}/${slugify(name)}`;
        if (cur.ids.has(base)) warnings.push(`line ${i + 1}: duplicate subheading "${name}" in ${cur.name}`);
        const id = uniqueId(base, cur.ids);
        cur.ids.add(id);
        cur.rows.push({ id, name });
      }
    });
    systems.forEach((s) => { if (!s.rows.length) warnings.push(`system "${s.name}" has no subheadings`); });
    return { systems: systems.map(({ id, name, rows }) => ({ id, name, rows })), warnings };
  }

  /* ---------- State construction ---------- */

  function emptyCells() {
    const o = {};
    STAGES.forEach((s) => { o[s] = { state: 'todo', doneAt: null }; });
    return o;
  }

  function newRow(id, name) {
    return { id, name, notes: '', pinned: false, stages: emptyCells() };
  }

  function stateFromSeed(seed, now) {
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: (now || new Date()).toISOString(),
      stages: STAGES.slice(),
      deletedRowIds: [],
      systems: seed.systems.map((s) => ({
        id: s.id,
        name: s.name,
        collapsed: false,
        rows: s.rows.map((r) => newRow(r.id, r.name)),
      })),
    };
  }

  function allRowIds(state) {
    const ids = new Set();
    state.systems.forEach((s) => s.rows.forEach((r) => ids.add(r.id)));
    return ids;
  }

  function findRow(state, rowId) {
    for (const sys of state.systems) {
      const idx = sys.rows.findIndex((r) => r.id === rowId);
      if (idx >= 0) return { sys, row: sys.rows[idx], index: idx };
    }
    return null;
  }

  /* ---------- Cell state ---------- */

  function nextCellState(s) {
    return s === 'todo' ? 'done' : s === 'done' ? 'na' : 'todo';
  }

  // Mutates the cell. doneAt is stamped on becoming done and cleared on leaving it.
  function setCell(cell, state, nowIso) {
    if (cell.state === state) return false;
    cell.state = state;
    cell.doneAt = state === 'done' ? nowIso || new Date().toISOString() : null;
    return true;
  }

  /* ---------- Progress ---------- */

  const pct = (done, applicable) => (applicable ? (done / applicable) * 100 : null);

  // N/A cells are excluded entirely: they count as neither done nor applicable.
  function tally(rows, stages) {
    stages = stages || STAGES;
    const perStage = {};
    let done = 0;
    let applicable = 0;
    stages.forEach((st) => { perStage[st] = { done: 0, applicable: 0, na: 0 }; });
    for (const r of rows) {
      for (const st of stages) {
        const c = r.stages[st];
        const p = perStage[st];
        if (c.state === 'na') { p.na++; continue; }
        p.applicable++;
        applicable++;
        if (c.state === 'done') { p.done++; done++; }
      }
    }
    stages.forEach((st) => { perStage[st].pct = pct(perStage[st].done, perStage[st].applicable); });
    return { done, applicable, pct: pct(done, applicable), perStage };
  }

  function isRowComplete(row, stages) {
    return (stages || STAGES).every((st) => row.stages[st].state !== 'todo');
  }

  function overallProgress(state) {
    const rows = state.systems.flatMap((s) => s.rows);
    const t = tally(rows, state.stages);
    t.totalRows = rows.length;
    t.completeRows = rows.filter((r) => isRowComplete(r, state.stages)).length;
    return t;
  }

  /* ---------- Next up ---------- */

  // First todo stage whose earlier stages are all done or N/A.
  // (Any stage before the first todo is by definition done or N/A.)
  function nextAction(row, stages) {
    for (const st of stages || STAGES) {
      if (row.stages[st].state === 'todo') return st;
    }
    return null;
  }

  // Flat queue: pinned items first (in system order), then grouped by stage,
  // each group in system order.
  function nextUpQueue(state) {
    const items = [];
    state.systems.forEach((sys, si) => {
      sys.rows.forEach((row, ri) => {
        const stage = nextAction(row, state.stages);
        if (stage) {
          items.push({
            systemId: sys.id, systemName: sys.name, rowId: row.id, rowName: row.name,
            stage, pinned: !!row.pinned, order: si * 10000 + ri,
          });
        }
      });
    });
    const stageIdx = (s) => state.stages.indexOf(s);
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (!a.pinned && a.stage !== b.stage) return stageIdx(a.stage) - stageIdx(b.stage);
      return a.order - b.order;
    });
    return items;
  }

  /* ---------- Import validation ---------- */

  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const isNonEmptyStr = (x) => typeof x === 'string' && x.trim() !== '';
  const isDateStr = (x) => typeof x === 'string' && !Number.isNaN(Date.parse(x));

  // Returns { ok: true, data } with a normalized copy, or { ok: false, errors }.
  // Never mutates its input.
  function validateImport(input) {
    const fail = (...errors) => ({ ok: false, errors });
    if (!isObj(input)) return fail('File is not a JSON object.');
    if (!('schemaVersion' in input)) return fail('Missing schemaVersion: this does not look like a tracker export.');
    const v = input.schemaVersion;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return fail(`Invalid schemaVersion: ${JSON.stringify(v)}.`);
    if (v > SCHEMA_VERSION) {
      return fail(`File uses schemaVersion ${v}, which is newer than this app supports (${SCHEMA_VERSION}). Use a newer index.html.`);
    }
    let d = clone(input);
    while (d.schemaVersion < SCHEMA_VERSION) {
      const migrate = MIGRATIONS[d.schemaVersion];
      if (!migrate) return fail(`File uses schemaVersion ${d.schemaVersion}, which is too old and has no migration path to ${SCHEMA_VERSION}.`);
      d = migrate(d);
    }

    const errors = [];
    const err = (m) => { if (errors.length < 25) errors.push(m); };

    if (!Array.isArray(d.stages) || d.stages.length !== STAGES.length || d.stages.some((s, i) => s !== STAGES[i])) {
      err(`stages must be exactly ${JSON.stringify(STAGES)}.`);
    }
    if ('updatedAt' in d && !isDateStr(d.updatedAt)) err('updatedAt is not a valid date string.');
    if ('deletedRowIds' in d && (!Array.isArray(d.deletedRowIds) || d.deletedRowIds.some((x) => typeof x !== 'string'))) {
      err('deletedRowIds must be an array of strings.');
    }
    if (!Array.isArray(d.systems)) {
      err('systems must be an array.');
      return fail(...errors);
    }

    const sysIds = new Set();
    const rowIds = new Set();
    const out = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: isDateStr(d.updatedAt) ? d.updatedAt : new Date().toISOString(),
      stages: STAGES.slice(),
      deletedRowIds: Array.isArray(d.deletedRowIds) ? d.deletedRowIds.filter((x) => typeof x === 'string') : [],
      systems: [],
    };

    d.systems.forEach((s, si) => {
      const where = `systems[${si}]`;
      if (!isObj(s)) return err(`${where} is not an object.`);
      if (!isNonEmptyStr(s.id)) return err(`${where}.id is missing.`);
      if (sysIds.has(s.id)) err(`Duplicate system id "${s.id}".`);
      sysIds.add(s.id);
      if (typeof s.name !== 'string') err(`${where}.name must be a string.`);
      if ('collapsed' in s && typeof s.collapsed !== 'boolean') err(`${where}.collapsed must be true/false.`);
      if (!Array.isArray(s.rows)) return err(`${where}.rows must be an array.`);
      const sysOut = { id: s.id, name: String(s.name), collapsed: !!s.collapsed, rows: [] };
      s.rows.forEach((r, ri) => {
        const rw = `${where}.rows[${ri}]`;
        if (!isObj(r)) return err(`${rw} is not an object.`);
        if (!isNonEmptyStr(r.id)) return err(`${rw}.id is missing.`);
        if (rowIds.has(r.id)) err(`Duplicate row id "${r.id}".`);
        rowIds.add(r.id);
        if (typeof r.name !== 'string') err(`${rw}.name must be a string.`);
        if ('notes' in r && typeof r.notes !== 'string') err(`${rw}.notes must be a string.`);
        if ('pinned' in r && typeof r.pinned !== 'boolean') err(`${rw}.pinned must be true/false.`);
        if (!isObj(r.stages)) return err(`${rw}.stages is missing.`);
        const cells = {};
        STAGES.forEach((st) => {
          const c = r.stages[st];
          if (!isObj(c)) return err(`${rw}.stages.${st} is missing.`);
          if (!STATES.includes(c.state)) return err(`${rw}.stages.${st}.state must be one of ${STATES.join('/')}.`);
          if (c.doneAt != null && !isDateStr(c.doneAt)) err(`${rw}.stages.${st}.doneAt is not a valid date.`);
          cells[st] = { state: c.state, doneAt: c.state === 'done' && c.doneAt != null ? c.doneAt : null };
        });
        sysOut.rows.push({ id: r.id, name: String(r.name), notes: r.notes || '', pinned: !!r.pinned, stages: cells });
      });
      out.systems.push(sysOut);
    });

    if (errors.length) return fail(...errors);
    return { ok: true, data: out };
  }

  /* ---------- Merge ---------- */

  function mergeNotes(a, b) {
    if (!b || a === b) return a;
    if (!a) return b;
    if (a.includes(b)) return a;
    if (b.includes(a)) return b;
    return `${a}\n---\n${b}`;
  }

  function mergeRow(cur, inc, report) {
    STAGES.forEach((st) => {
      const a = cur.stages[st];
      const b = inc.stages[st];
      if (RANK[b.state] > RANK[a.state]) {
        cur.stages[st] = { state: b.state, doneAt: b.doneAt };
        report.upgradedCells++;
      } else if (a.state === 'done' && b.state === 'done' && b.doneAt && (!a.doneAt || b.doneAt < a.doneAt)) {
        a.doneAt = b.doneAt; // keep the earliest completion time
      }
    });
    const notes = mergeNotes(cur.notes, inc.notes);
    if (notes !== cur.notes) { cur.notes = notes; report.notesMerged++; }
    cur.pinned = !!(cur.pinned || inc.pinned);
  }

  // Merge `incoming` into a copy of `current`. Rows are matched by ID; the more
  // advanced state wins per cell; new rows and systems are added near their
  // neighbours in the incoming file; nothing in `current` is ever removed.
  // opts.respectDeleted: skip incoming rows the user deliberately deleted
  // (used when re-seeding from the markdown).
  function mergeStates(current, incoming, opts) {
    opts = opts || {};
    const out = clone(current);
    out.deletedRowIds = out.deletedRowIds || [];
    const report = { addedSystems: 0, addedRows: 0, upgradedCells: 0, notesMerged: 0, skippedDeleted: 0 };
    const tomb = new Set(out.deletedRowIds);
    const rowIndex = new Map();
    out.systems.forEach((s) => s.rows.forEach((r) => rowIndex.set(r.id, r)));

    let prevSysId = null;
    for (const inSys of incoming.systems) {
      let sys = out.systems.find((s) => s.id === inSys.id);
      if (!sys) {
        const liveRows = inSys.rows.filter((r) => !(opts.respectDeleted && tomb.has(r.id)) && !rowIndex.has(r.id));
        if (!liveRows.length && inSys.rows.length) {
          inSys.rows.forEach((r) => { if (rowIndex.has(r.id)) mergeRow(rowIndex.get(r.id), r, report); });
          continue;
        }
        sys = { id: inSys.id, name: inSys.name, collapsed: !!inSys.collapsed, rows: [] };
        const at = prevSysId ? out.systems.findIndex((s) => s.id === prevSysId) + 1 : 0;
        out.systems.splice(at, 0, sys);
        report.addedSystems++;
      }
      prevSysId = sys.id;

      let prevRowId = null;
      for (const inRow of inSys.rows) {
        const existing = rowIndex.get(inRow.id);
        if (existing) {
          mergeRow(existing, inRow, report);
          if (sys.rows.includes(existing)) prevRowId = existing.id;
          continue;
        }
        if (opts.respectDeleted && tomb.has(inRow.id)) { report.skippedDeleted++; continue; }
        const r = clone(inRow);
        const at = prevRowId ? sys.rows.findIndex((x) => x.id === prevRowId) + 1 : 0;
        sys.rows.splice(at, 0, r);
        rowIndex.set(r.id, r);
        prevRowId = r.id;
        report.addedRows++;
        if (tomb.has(r.id)) out.deletedRowIds = out.deletedRowIds.filter((x) => x !== r.id);
      }
    }
    out.updatedAt = new Date().toISOString();
    return { state: out, report };
  }

  return {
    SCHEMA_VERSION, STAGES, STAGE_LABELS, STATES, RANK, MIGRATIONS,
    clone, slugify, uniqueId, parseMarkdown, emptyCells, newRow, stateFromSeed,
    allRowIds, findRow, nextCellState, setCell, tally, isRowComplete, overallProgress,
    nextAction, nextUpQueue, validateImport, mergeStates, mergeNotes,
  };
});
