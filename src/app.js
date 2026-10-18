/* Tracker UI. Depends on window.TrackerCore and window.TRACKER_SEED. */
(function () {
  'use strict';

  const C = window.TrackerCore;
  const SEED = window.TRACKER_SEED;
  const STAGES = C.STAGES;
  const L = C.STAGE_LABELS;

  const KEY = 'uworldTracker.state.v1';
  const PREV_KEY = KEY + '.prev';
  const META_KEY = 'uworldTracker.meta.v1';
  const CORRUPT_PREFIX = 'uworldTracker.corrupt.';
  const UNDO_LIMIT = 50;
  const QUEUE_DEFAULT = 10;
  const NUDGE_DAYS = 7;
  const NUDGE_CHANGES = 50;
  const STATE_WORD = { todo: 'to do', done: 'done', na: 'N/A' };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hms = (d = new Date()) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtPct = (p) => {
    if (p == null) return '—';
    const f = Math.floor(p * 10) / 10;
    return (Number.isInteger(f) ? f : f.toFixed(1)) + '%';
  };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  const grid = $('grid');
  const ui = {
    search: '',
    hideCompleted: false,
    queueAll: false,
    openNotes: new Set(),
    renaming: null,
    focus: null, // { rowId | sysId, stage }
    restoreFocus: false,
    seedBannerDismissed: false,
  };
  const undoStack = [];
  const redoStack = [];
  const problems = []; // unreadable saved data that was set aside
  let storageOK = true;

  /* ---------- Storage ---------- */

  function storageGet(k) {
    try { return localStorage.getItem(k); } catch (e) { storageOK = false; return null; }
  }
  function storageSet(k, v) { localStorage.setItem(k, v); } // may throw: callers handle it

  function loadMeta() {
    const base = { lastExportAt: null, changesSinceExport: 0 };
    try { return Object.assign(base, JSON.parse(storageGet(META_KEY) || '{}')); } catch (e) { return base; }
  }
  function saveMeta() {
    try { storageSet(META_KEY, JSON.stringify(meta)); } catch (e) { /* shown via save status */ }
  }

  // Unreadable data is copied aside (never deleted) so it can be downloaded later.
  function quarantine(raw, reason) {
    const key = CORRUPT_PREFIX + new Date().toISOString();
    try { storageSet(key, raw); } catch (e) { /* storage full: still kept in memory below */ }
    problems.push({ key, raw, reason });
  }

  function loadState() {
    let recovered = false;
    for (const k of [KEY, PREV_KEY]) {
      const raw = storageGet(k);
      if (raw == null) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { quarantine(raw, 'not valid JSON'); recovered = true; continue; }
      const v = C.validateImport(parsed);
      if (v.ok) return { state: v.data, fresh: false, recovered };
      quarantine(raw, v.errors[0]);
      recovered = true;
    }
    return { state: C.stateFromSeed(SEED), fresh: true, recovered };
  }

  function save() {
    const json = JSON.stringify(state);
    try {
      const old = localStorage.getItem(KEY);
      if (old && old !== json) storageSet(PREV_KEY, old);
      storageSet(KEY, json);
      setSaveStatus(true);
    } catch (e) {
      setSaveStatus(false, e);
    }
  }

  function setSaveStatus(ok, err) {
    const el = $('saveStatus');
    el.classList.toggle('error', !ok);
    el.textContent = ok
      ? `Saved ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
      : `NOT SAVED: ${err && err.name === 'QuotaExceededError' ? 'storage full' : 'storage unavailable'}. Export now!`;
  }

  /* ---------- State changes ---------- */

  // fn mutates the draft, returns a replacement state, or returns false to abort.
  function commit(label, fn, opts = {}) {
    const before = JSON.stringify(state);
    const draft = JSON.parse(before);
    const res = fn(draft);
    if (res === false) return false;
    const next = res && typeof res === 'object' ? res : draft;
    if (JSON.stringify(next) === before) return false;
    if (!opts.keepUpdatedAt) next.updatedAt = new Date().toISOString();
    if (opts.undo !== false) {
      undoStack.push({ label, snap: before });
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
    }
    state = next;
    if (opts.count !== false) bumpChanges();
    save();
    render();
    return true;
  }

  function bumpChanges() {
    meta.changesSinceExport = (meta.changesSinceExport || 0) + 1;
    saveMeta();
  }

  function undo() {
    flushNotes();
    const u = undoStack.pop();
    if (!u) return toast('Nothing to undo');
    redoStack.push({ label: u.label, snap: JSON.stringify(state) });
    state = JSON.parse(u.snap);
    bumpChanges();
    save();
    render();
    toast(`Undid: ${u.label}`);
  }

  function redo() {
    const r = redoStack.pop();
    if (!r) return toast('Nothing to redo');
    undoStack.push({ label: r.label, snap: JSON.stringify(state) });
    state = JSON.parse(r.snap);
    bumpChanges();
    save();
    render();
    toast(`Redid: ${r.label}`);
  }

  const sysById = (s, id) => s.systems.find((x) => x.id === id);

  function cycleCell(rowId, stage) {
    const hit = C.findRow(state, rowId);
    if (!hit) return;
    const to = C.nextCellState(hit.row.stages[stage].state);
    commit(`${L[stage]} → ${STATE_WORD[to]} (${hit.row.name})`, (d) => {
      C.setCell(C.findRow(d, rowId).row.stages[stage], to);
    });
  }

  async function bulkSet(sysId, stage) {
    const sys = sysById(state, sysId);
    if (!sys.rows.length) return toast('This system has no subheadings yet');
    const t = C.tally(sys.rows).perStage[stage];
    const todo = sys.rows.length - t.done - t.na;
    const r = await dialog({
      title: `Set ${L[stage]} for all of ${sys.name}?`,
      html: `<p>This sets the <b>${L[stage]}</b> cell on all ${plural(sys.rows.length, 'subheading')}
        (now ${t.done} done, ${t.na} N/A, ${todo} to do). Ctrl+Z undoes it.</p>`,
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Mark to do', value: 'todo' },
        { label: 'Mark N/A', value: 'na' },
        { label: 'Mark done', value: 'done', kind: 'primary', isDefault: true },
      ],
    });
    if (!C.STATES.includes(r.value)) return;
    const label = `${L[stage]} → ${STATE_WORD[r.value]} for all of ${sys.name}`;
    const now = new Date().toISOString();
    if (commit(label, (d) => { sysById(d, sysId).rows.forEach((row) => C.setCell(row.stages[stage], r.value, now)); })) {
      toast(label, true);
    }
  }

  function setCollapsed(sysIds, collapsed) {
    commit('Collapse', (d) => {
      d.systems.forEach((s) => { if (sysIds.includes(s.id)) s.collapsed = collapsed; });
    }, { undo: false, count: false });
  }

  function togglePin(rowId) {
    const hit = C.findRow(state, rowId);
    commit(hit.row.pinned ? `Unpin ${hit.row.name}` : `Pin ${hit.row.name}`, (d) => {
      const row = C.findRow(d, rowId).row;
      row.pinned = !row.pinned;
    });
  }

  async function addRow(sysId) {
    const sys = sysById(state, sysId);
    const r = await dialog({
      title: `Add subheading to ${sys.name}`,
      input: { placeholder: 'Subheading name' },
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Add', value: 'add', kind: 'primary', isDefault: true }],
    });
    const name = (r.input || '').trim();
    if (r.value !== 'add' || !name) return;
    commit(`Add ${name}`, (d) => {
      const id = C.uniqueId(`${sysId}/${C.slugify(name)}`, C.allRowIds(d));
      sysById(d, sysId).rows.push(C.newRow(id, name));
      sysById(d, sysId).collapsed = false;
      d.deletedRowIds = (d.deletedRowIds || []).filter((x) => x !== id);
    });
  }

  function finishRename(rowId, value, keep) {
    if (ui.renaming !== rowId) return;
    ui.renaming = null;
    const name = (value || '').trim();
    const hit = C.findRow(state, rowId);
    ui.focus = { rowId, stage: STAGES[0] };
    ui.restoreFocus = true;
    if (!keep || !hit || !name || name === hit.row.name) return render();
    // The ID stays the same so merges and re-seeds still match this row.
    commit(`Rename ${hit.row.name} → ${name}`, (d) => { C.findRow(d, rowId).row.name = name; });
  }

  async function deleteRow(rowId) {
    const hit = C.findRow(state, rowId);
    const r = await dialog({
      title: `Delete "${hit.row.name}"?`,
      html: `<p>Removes this subheading and its progress from ${esc(hit.sys.name)}. Ctrl+Z undoes it.
        Re-seeding from the markdown will not bring it back.</p>`,
      buttons: [{ label: 'Cancel', value: 'cancel', isDefault: true }, { label: 'Delete', value: 'delete', kind: 'danger' }],
    });
    if (r.value !== 'delete') return;
    if (commit(`Delete ${hit.row.name}`, (d) => {
      const h = C.findRow(d, rowId);
      h.sys.rows.splice(h.index, 1);
      d.deletedRowIds = Array.from(new Set([...(d.deletedRowIds || []), rowId]));
    })) toast(`Deleted ${hit.row.name}`, true);
  }

  function moveRow(rowId, delta) {
    const hit = C.findRow(state, rowId);
    const to = hit.index + delta;
    if (to < 0 || to >= hit.sys.rows.length) return;
    commit(`Move ${hit.row.name}`, (d) => {
      const rows = C.findRow(d, rowId).sys.rows;
      const [row] = rows.splice(hit.index, 1);
      rows.splice(to, 0, row);
    });
  }

  /* Notes edit in place without re-rendering, so typing is never interrupted.
     One undo entry is recorded per editing session (focus → blur). */
  let notesSession = null;
  let notesTimer = null;
  function onNotesInput(ta) {
    const hit = C.findRow(state, ta.dataset.row);
    if (!hit) return;
    if (!notesSession) notesSession = { rowId: hit.row.id, snap: JSON.stringify(state), name: hit.row.name };
    hit.row.notes = ta.value;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => { state.updatedAt = new Date().toISOString(); save(); }, 300);
  }
  function flushNotes() {
    clearTimeout(notesTimer);
    if (!notesSession) return;
    const s = notesSession;
    notesSession = null;
    if (JSON.stringify(state) === s.snap) return;
    state.updatedAt = new Date().toISOString();
    undoStack.push({ label: `Edit notes (${s.name})`, snap: s.snap });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    bumpChanges();
    save();
    renderTop();
    const tool = grid.querySelector(`tr[data-row="${CSS.escape(s.rowId)}"] [data-act=notes]`);
    if (tool) tool.classList.add('on');
  }

  /* ---------- Import / export ---------- */

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function exportJSON() {
    flushNotes();
    download(`master-tracker-${ymd()}.json`, JSON.stringify(state, null, 2));
    meta.lastExportAt = new Date().toISOString();
    meta.changesSinceExport = 0;
    saveMeta();
    renderTop();
    toast('Exported');
  }

  function downloadBackup(reason) {
    flushNotes();
    download(`master-tracker-backup-${ymd()}-${hms()}-${reason}.json`, JSON.stringify(state, null, 2));
  }

  async function importText(text, fileName) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) {
      return importError(fileName, [`The file is not valid JSON (${e.message}).`]);
    }
    const v = C.validateImport(parsed);
    if (!v.ok) return importError(fileName, v.errors);
    const inc = v.data;
    const o = C.overallProgress(inc);
    const rep = C.mergeStates(state, inc).report;
    const r = await dialog({
      title: `Import ${fileName}`,
      html: `<p>The file is valid: ${plural(inc.systems.length, 'system')}, ${plural(o.totalRows, 'subheading')},
        ${fmtPct(o.pct)} complete, last saved ${esc(fmtDate(inc.updatedAt))}.</p>
        <ul>
          <li><b>Merge</b> keeps everything you have, matches rows by ID and keeps the more advanced state of each cell.
            For this file: ${plural(rep.upgradedCells, 'cell')} would advance, ${plural(rep.addedRows, 'row')} would be added.</li>
          <li><b>Replace</b> swaps your current data for the file exactly.</li>
        </ul>
        <p class="muted small">A backup of your current data downloads first, and Ctrl+Z also undoes the import.</p>`,
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Replace', value: 'replace', kind: 'danger' },
        { label: 'Merge', value: 'merge', kind: 'primary', isDefault: true },
      ],
    });
    if (r.value !== 'replace' && r.value !== 'merge') return;
    downloadBackup('before-import');
    const changed = r.value === 'replace'
      ? commit(`Import ${fileName} (replace)`, () => C.clone(inc), { keepUpdatedAt: true })
      : commit(`Import ${fileName} (merge)`, (d) => C.mergeStates(d, inc).state);
    toast(changed ? `Imported (${r.value})` : 'Nothing changed: the data is already identical', changed);
  }

  function importError(fileName, errors) {
    return dialog({
      title: 'Import cancelled',
      html: `<p><b>${esc(fileName)}</b> was not imported. Your current data has not been changed.</p>
        <ul class="errors">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`,
      buttons: [{ label: 'OK', value: 'ok', kind: 'primary', isDefault: true }],
    });
  }

  function seedState() { return C.stateFromSeed(SEED); }

  function pendingSeedRows() {
    return C.mergeStates(state, seedState(), { respectDeleted: true }).report;
  }

  async function reseed() {
    const rep = pendingSeedRows();
    if (!rep.addedRows) return toast('Your tracker already has every subheading from the seed');
    const r = await dialog({
      title: 'Merge subheadings from seed',
      html: `<p>${plural(rep.addedRows, 'subheading')} from the built-in list ${rep.addedRows === 1 ? 'is' : 'are'} missing from your tracker
        and will be added${rep.addedSystems ? ` (including ${plural(rep.addedSystems, 'new system')})` : ''}. Existing rows and progress stay as they are.
        Rows you deleted stay deleted.</p><p class="muted small">A backup downloads first.</p>`,
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Merge', value: 'merge', kind: 'primary', isDefault: true }],
    });
    if (r.value !== 'merge') return;
    downloadBackup('before-reseed');
    if (commit('Merge from seed', (d) => C.mergeStates(d, seedState(), { respectDeleted: true }).state)) {
      ui.seedBannerDismissed = true;
      toast(`Added ${plural(rep.addedRows, 'subheading')}`, true);
    }
  }

  async function resetToSeed() {
    const r = await dialog({
      title: 'Reset to seed?',
      html: `<p>This erases all progress, notes and custom rows and starts again from the built-in subheading list.
        A backup downloads first. Type <b>RESET</b> to confirm.</p>`,
      input: { placeholder: 'RESET', mustEqual: 'RESET', confirmValue: 'reset' },
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Reset everything', value: 'reset', kind: 'danger', isDefault: true }],
    });
    if (r.value !== 'reset' || r.input !== 'RESET') return;
    downloadBackup('before-reset');
    if (commit('Reset to seed', () => seedState())) toast('Reset to seed', true);
  }

  /* ---------- Rendering ---------- */

  function visibleModel() {
    const q = ui.search.trim().toLowerCase();
    const out = [];
    for (const sys of state.systems) {
      const sysMatch = !q || sys.name.toLowerCase().includes(q);
      const rows = sys.rows.filter((r) =>
        (sysMatch || r.name.toLowerCase().includes(q)) && !(ui.hideCompleted && C.isRowComplete(r)));
      if (!rows.length && (q || (ui.hideCompleted && sys.rows.length))) continue;
      out.push({ sys, rows, expanded: !sys.collapsed || !!q });
    }
    return out;
  }

  function cellHtml(row, st) {
    const c = row.stages[st];
    const warn = C.orderWarning(row, st);
    let title = `${L[st]}: ${STATE_WORD[c.state]}`;
    if (c.doneAt) title += ` (${fmtDate(c.doneAt)})`;
    if (warn.length) title += `. Warning: done before ${warn.map((s) => L[s]).join(', ')}`;
    return `<td><button class="cell s-${c.state}" data-stage="${st}" tabindex="-1" title="${esc(title)}"
      aria-label="${esc(`${row.name}, ${title}`)}"><span class="box"></span>${warn.length ? '<span class="warn" aria-hidden="true">!</span>' : ''}</button></td>`;
  }

  function rowHtml(sys, row) {
    const open = ui.openNotes.has(row.id);
    const nameHtml = ui.renaming === row.id
      ? `<input class="rname-input" value="${esc(row.name)}" aria-label="Rename subheading">`
      : `<span class="rname" title="${esc(row.name)} (double-click to rename)">${esc(row.name)}</span>`;
    const preview = row.notes && !open ? `<span class="note-preview" title="${esc(row.notes)}">${esc(row.notes.split('\n')[0])}</span>` : '';
    let html = `<tr class="row${C.isRowComplete(row) ? ' complete' : ''}" data-row="${esc(row.id)}" data-sys="${esc(sys.id)}" data-nav>
      <th class="col-name" scope="row"><div class="row-line">${nameHtml}
        <button class="tool${row.notes || open ? ' on' : ''}" data-act="notes" title="Notes" aria-expanded="${open}">&#9998;</button>
        <button class="tool${row.pinned ? ' on' : ''}" data-act="pin" title="${row.pinned ? 'Unpin' : 'Pin to top of Next up'}" aria-pressed="${!!row.pinned}">&#9733;</button>
        <button class="tool" data-act="menu" title="Rename, move, delete" aria-haspopup="menu">&#8943;</button>
      </div>${preview}</th>${STAGES.map((st) => cellHtml(row, st)).join('')}</tr>`;
    if (open) {
      html += `<tr class="notes-row"><td colspan="${STAGES.length + 1}"><textarea data-row="${esc(row.id)}"
        placeholder="Notes, e.g. merge with renal acid-base" aria-label="Notes for ${esc(row.name)}">${esc(row.notes)}</textarea></td></tr>`;
    }
    return html;
  }

  function sysHtml({ sys, rows, expanded }) {
    const t = C.tally(sys.rows);
    const tallyText = STAGES.map((st) => `${L[st]} ${t.perStage[st].done}/${t.perStage[st].applicable}`).join(' · ');
    let html = `<tbody><tr class="sys${expanded ? '' : ' collapsed'}" data-sys="${esc(sys.id)}" data-nav>
      <th class="col-name" scope="rowgroup" title="${esc(tallyText)}">
        <div class="sys-line">
          <button class="caret" data-act="toggle" aria-expanded="${expanded}" aria-label="${expanded ? 'Collapse' : 'Expand'} ${esc(sys.name)}">&#9662;</button>
          <span class="sys-name" data-act="toggle" title="${esc(sys.name)}">${esc(sys.name)}</span>
          <span class="muted small">${sys.rows.length}</span>
          <button class="tool" data-act="add" title="Add subheading">+</button>
        </div>
        <div class="sys-prog"><div class="bar"><i style="width:${t.pct || 0}%"></i></div><span class="pct">${fmtPct(t.pct)}</span></div>
      </th>`;
    html += STAGES.map((st) => {
      const p = t.perStage[st];
      const full = p.applicable && p.done === p.applicable;
      return `<td><button class="hcell${full ? ' full' : ''}" data-stage="${st}" tabindex="-1"
        title="${L[st]}: ${p.done}/${p.applicable} done${p.na ? `, ${p.na} N/A` : ''}. Click to set for every subheading."
        aria-label="${esc(sys.name)} ${L[st]}: ${p.done} of ${p.applicable} done. Set for all.">${p.applicable ? `${p.done}/${p.applicable}` : '—'}</button></td>`;
    }).join('');
    html += '</tr>';
    if (expanded) html += rows.map((r) => rowHtml(sys, r)).join('');
    return html + '</tbody>';
  }

  function render() {
    renderTop();
    renderGrid();
    renderQueue();
    renderBanner();
  }

  function renderGrid() {
    const model = visibleModel();
    grid.innerHTML = `<thead><tr><th class="col-name" scope="col">Subheading</th>${STAGES.map((s) => `<th scope="col">${L[s]}</th>`).join('')}</tr></thead>`
      + model.map(sysHtml).join('');
    $('emptyMsg').hidden = model.length > 0;

    // Roving tabindex: exactly one grid cell is in the tab order.
    let target = ui.focus && findCellButton(ui.focus);
    if (!target) target = grid.querySelector('[data-stage]');
    if (target) target.tabIndex = 0;
    if (ui.restoreFocus && target) target.focus({ preventScroll: false });
    ui.restoreFocus = false;

    const input = grid.querySelector('.rname-input');
    if (input) { input.focus(); input.select(); }
  }

  function findCellButton(f) {
    const tr = f.rowId
      ? grid.querySelector(`tr[data-row="${CSS.escape(f.rowId)}"]`)
      : grid.querySelector(`tr.sys[data-sys="${CSS.escape(f.sysId)}"]`);
    return tr && tr.querySelector(`[data-stage="${f.stage}"]`);
  }

  function renderTop() {
    const o = C.overallProgress(state);
    $('overallPct').textContent = fmtPct(o.pct);
    $('overallBar').style.width = `${o.pct || 0}%`;
    $('overallSub').innerHTML = `<b>${o.fullyPrinted}</b>/${o.totalRows} subheadings printed · ${o.done}/${o.applicable} cells`;
    $('stageChips').innerHTML = STAGES.map((st) => {
      const p = o.perStage[st];
      return `<div class="chip" title="${L[st]}: ${p.done}/${p.applicable} done${p.na ? `, ${p.na} N/A` : ''}">
        <b>${L[st]}</b><span>${fmtPct(p.pct)}</span><div class="bar"><i style="width:${p.pct || 0}%"></i></div></div>`;
    }).join('');

    const changes = meta.changesSinceExport || 0;
    const days = meta.lastExportAt ? Math.floor((Date.now() - Date.parse(meta.lastExportAt)) / 864e5) : null;
    let text = days == null ? 'Never exported' : days <= 0 ? 'Last exported: today' : `Last exported: ${plural(days, 'day')} ago`;
    if (changes) text += ` · ${plural(changes, 'change')} since`;
    const nudge = (days == null && changes > 0) || days > NUDGE_DAYS || changes > NUDGE_CHANGES;
    $('exportAge').textContent = text;
    $('exportAge').classList.toggle('nudge', nudge);
    $('btnExport').classList.toggle('nudge', nudge);
    $('btnExport').textContent = nudge ? 'Export (backup due)' : 'Export';

    $('btnUndo').disabled = !undoStack.length;
    $('btnUndo').title = undoStack.length ? `Undo: ${undoStack[undoStack.length - 1].label} (Ctrl+Z)` : 'Nothing to undo';
    $('btnRedo').disabled = !redoStack.length;
    $('btnRedo').title = redoStack.length ? `Redo: ${redoStack[redoStack.length - 1].label} (Ctrl+Shift+Z)` : 'Nothing to redo';
  }

  function renderQueue() {
    const items = C.nextUpQueue(state);
    $('queueCount').textContent = items.length ? `${items.length} open` : '';
    if (!items.length) {
      $('queueList').innerHTML = '<p class="muted">Nothing left to do. Every subheading is complete.</p>';
      return;
    }
    const shown = ui.queueAll ? items : items.slice(0, QUEUE_DEFAULT);
    const groups = [];
    const totals = {};
    items.forEach((it) => { const g = it.pinned ? 'pinned' : it.stage; totals[g] = (totals[g] || 0) + 1; });
    shown.forEach((it) => {
      const g = it.pinned ? 'pinned' : it.stage;
      if (!groups.length || groups[groups.length - 1].key !== g) groups.push({ key: g, items: [] });
      groups[groups.length - 1].items.push(it);
    });
    let html = groups.map((g) => `<h3><span>${g.key === 'pinned' ? 'Pinned' : `Next: ${L[g.key]}`}</span><span>${totals[g.key]}</span></h3>`
      + g.items.map((it) => `<div class="q-item" data-row="${esc(it.rowId)}">
          <button class="q-main" data-act="goto" title="Go to row">
            <span class="q-name">${esc(it.rowName)}${it.pinned ? `<span class="q-stage">${L[it.stage]}</span>` : ''}</span>
            <span class="q-sys">${esc(it.systemName)}</span>
          </button>
          <button class="tool q-pin${it.pinned ? ' on' : ''}" data-act="pin" title="${it.pinned ? 'Unpin' : 'Pin to top'}" aria-pressed="${it.pinned}">&#9733;</button>
        </div>`).join('')).join('');
    if (items.length > QUEUE_DEFAULT) {
      html += `<button class="btn more" data-act="all">${ui.queueAll ? `Show first ${QUEUE_DEFAULT}` : `Show all (${items.length})`}</button>`;
    }
    $('queueList').innerHTML = html;
  }

  function renderBanner() {
    const b = $('banner');
    const parts = [];
    let error = false;
    if (!storageOK) {
      error = true;
      parts.push('<span><b>Browser storage is unavailable.</b> Changes will not survive a refresh. Export often.</span>');
    }
    problems.forEach((p, i) => {
      error = true;
      parts.push(`<span>Some saved data could not be read (${esc(p.reason)}). It was set aside, not deleted.</span>
        <button class="btn" data-act="dl-problem" data-i="${i}">Download it</button>`);
    });
    if (!ui.seedBannerDismissed && !isFresh) {
      const rep = pendingSeedRows();
      if (rep.addedRows) {
        parts.push(`<span>The built-in subheading list has ${plural(rep.addedRows, 'subheading')} that ${rep.addedRows === 1 ? 'is' : 'are'} not in your tracker.</span>
          <button class="btn" data-act="reseed">Review and merge</button><button class="btn ghost" data-act="dismiss-seed">Dismiss</button>`);
      }
    }
    b.hidden = !parts.length;
    b.classList.toggle('error', error);
    b.innerHTML = parts.join('');
  }

  /* ---------- Navigation ---------- */

  function focusButton(btn) {
    const old = grid.querySelector('[data-stage][tabindex="0"]');
    if (old && old !== btn) old.tabIndex = -1;
    btn.tabIndex = 0;
    ui.focus = focusKey(btn);
    btn.focus();
  }

  function focusKey(btn) {
    const tr = btn.closest('tr');
    return tr.dataset.row ? { rowId: tr.dataset.row, stage: btn.dataset.stage } : { sysId: tr.dataset.sys, stage: btn.dataset.stage };
  }

  function gotoRow(rowId) {
    const hit = C.findRow(state, rowId);
    if (!hit) return;
    const visible = () => grid.querySelector(`tr[data-row="${CSS.escape(rowId)}"]`);
    if (hit.sys.collapsed) { hit.sys.collapsed = false; save(); }
    renderGrid();
    if (!visible()) {
      ui.search = '';
      $('search').value = '';
      ui.hideCompleted = false;
      $('hideCompleted').checked = false;
      renderGrid();
    }
    const tr = visible();
    if (!tr) return;
    tr.scrollIntoView({ block: 'center' });
    tr.classList.remove('flash');
    void tr.offsetWidth;
    tr.classList.add('flash');
    const stage = C.nextAction(hit.row) || STAGES[0];
    focusButton(tr.querySelector(`[data-stage="${stage}"]`));
  }

  /* ---------- Menus, dialogs, toasts ---------- */

  function openMenu(menu, anchor, data) {
    closeMenus();
    Object.assign(menu.dataset, data || {});
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    menu.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
    menu.querySelector('button').focus();
    menu._anchor = anchor;
  }
  function closeMenus() {
    document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
  }

  function dialog({ title, html, buttons, input }) {
    return new Promise((resolve) => {
      const dlg = $('dialog');
      const form = $('dialogForm');
      form.innerHTML = `<h2>${esc(title)}</h2>${html || ''}
        ${input ? `<input type="text" name="v" autocomplete="off" spellcheck="false" placeholder="${esc(input.placeholder || '')}">` : ''}
        <div class="actions">${buttons.map((b) => `<button class="btn ${b.kind || ''}" value="${esc(b.value)}"${b.isDefault ? ' data-default' : ''}>${esc(b.label)}</button>`).join('')}</div>`;
      const inp = form.querySelector('input');
      const def = form.querySelector('[data-default]');
      if (inp && input.mustEqual) {
        const btn = form.querySelector(`button[value="${input.confirmValue}"]`);
        btn.disabled = true;
        inp.addEventListener('input', () => { btn.disabled = inp.value !== input.mustEqual; });
      }
      if (inp) {
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (def && !def.disabled) def.click(); }
        });
      }
      dlg.returnValue = '';
      dlg.onclose = () => { resolve({ value: dlg.returnValue, input: inp ? inp.value : null }); };
      dlg.showModal();
      (inp || def || form.querySelector('button')).focus();
    });
  }

  function toast(msg, withUndo) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span>${esc(msg)}</span>${withUndo ? '<button>Undo</button>' : ''}`;
    if (withUndo) el.querySelector('button').onclick = () => { el.remove(); undo(); };
    const box = $('toasts');
    while (box.children.length >= 3) box.firstChild.remove();
    box.appendChild(el);
    setTimeout(() => el.remove(), withUndo ? 6000 : 2500);
  }

  function showHelp() {
    const keys = [
      ['← ↑ → ↓', 'Move between cells'],
      ['Space / Enter', 'Cycle cell: to do → done → N/A (on a system row: set all)'],
      ['/', 'Focus search'],
      ['Esc', 'Clear search / close menus'],
      ['Ctrl+Z', 'Undo (last 50 actions)'],
      ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'],
      ['Double-click a name', 'Rename it'],
    ];
    dialog({
      title: 'Keyboard shortcuts',
      html: `<table>${keys.map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('')}</table>
        <p class="muted small" style="margin-top:10px">A <b style="color:var(--warn)">!</b> on a cell means it was marked done while an earlier stage is still to do.</p>`,
      buttons: [{ label: 'Close', value: 'ok', kind: 'primary', isDefault: true }],
    });
  }

  /* ---------- Events ---------- */

  grid.addEventListener('click', (e) => {
    const el = e.target.closest('button, [data-act]');
    if (!el || el.tagName === 'INPUT') return;
    const tr = el.closest('tr');
    if (!tr) return;
    const rowId = tr.dataset.row;
    const sysId = tr.dataset.sys;
    if (el.classList.contains('cell')) {
      ui.focus = focusKey(el);
      ui.restoreFocus = true;
      return cycleCell(rowId, el.dataset.stage);
    }
    if (el.classList.contains('hcell')) {
      ui.focus = focusKey(el);
      ui.restoreFocus = true;
      return bulkSet(sysId, el.dataset.stage).then(() => { if (ui.restoreFocus) renderGrid(); });
    }
    switch (el.dataset.act) {
      case 'toggle': return setCollapsed([sysId], !sysById(state, sysId).collapsed);
      case 'add': return addRow(sysId);
      case 'pin': return togglePin(rowId);
      case 'notes':
        flushNotes();
        if (ui.openNotes.has(rowId)) ui.openNotes.delete(rowId);
        else ui.openNotes.add(rowId);
        renderGrid();
        if (ui.openNotes.has(rowId)) {
          const ta = grid.querySelector(`textarea[data-row="${CSS.escape(rowId)}"]`);
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
        return;
      case 'menu': return openMenu($('rowMenu'), el, { row: rowId });
      default:
    }
  });

  grid.addEventListener('dblclick', (e) => {
    const name = e.target.closest('.rname');
    if (!name) return;
    ui.renaming = name.closest('tr').dataset.row;
    renderGrid();
  });

  grid.addEventListener('keydown', (e) => {
    const input = e.target.closest('.rname-input');
    if (input) {
      const rowId = input.closest('tr').dataset.row;
      if (e.key === 'Enter') { e.preventDefault(); finishRename(rowId, input.value, true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishRename(rowId, input.value, false); }
      return;
    }
    const btn = e.target.closest('[data-stage]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const col = STAGES.indexOf(btn.dataset.stage);
    const inRow = (i) => tr.querySelectorAll('[data-stage]')[i];
    let target = null;
    switch (e.key) {
      case 'ArrowLeft': target = inRow(Math.max(0, col - 1)); break;
      case 'ArrowRight': target = inRow(Math.min(STAGES.length - 1, col + 1)); break;
      case 'Home': target = inRow(0); break;
      case 'End': target = inRow(STAGES.length - 1); break;
      case 'ArrowUp':
      case 'ArrowDown': {
        const rows = Array.from(grid.querySelectorAll('tr[data-nav]'));
        const next = rows[rows.indexOf(tr) + (e.key === 'ArrowUp' ? -1 : 1)];
        target = next ? next.querySelectorAll('[data-stage]')[col] : btn;
        break;
      }
      default: return; // Space / Enter fall through to the button's native click.
    }
    e.preventDefault();
    if (target) focusButton(target);
  });

  grid.addEventListener('focusout', (e) => {
    if (e.target.classList.contains('rname-input')) {
      const input = e.target;
      finishRename(input.closest('tr').dataset.row, input.value, true);
    } else if (e.target.tagName === 'TEXTAREA') {
      flushNotes();
    }
  });
  grid.addEventListener('input', (e) => { if (e.target.tagName === 'TEXTAREA') onNotesInput(e.target); });
  grid.addEventListener('focusin', (e) => {
    if (e.target.matches('[data-stage]')) ui.focus = focusKey(e.target);
  });

  $('rowMenu').addEventListener('click', (e) => {
    const act = e.target.closest('button') && e.target.closest('button').dataset.act;
    const rowId = $('rowMenu').dataset.row;
    if (!act) return;
    closeMenus();
    if (act === 'rename') { ui.renaming = rowId; renderGrid(); }
    if (act === 'delete') deleteRow(rowId);
    if (act === 'up') moveRow(rowId, -1);
    if (act === 'down') moveRow(rowId, 1);
  });
  $('moreMenu').addEventListener('click', (e) => {
    const act = e.target.closest('button') && e.target.closest('button').dataset.act;
    if (!act) return;
    closeMenus();
    if (act === 'reseed') reseed();
    if (act === 'reset') resetToSeed();
    if (act === 'help') showHelp();
  });
  $('btnMore').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!$('moreMenu').hidden) return closeMenus();
    openMenu($('moreMenu'), $('btnMore'));
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.menu') && !e.target.closest('[data-act=menu]') && e.target !== $('btnMore')) closeMenus();
  });
  $('gridWrap').addEventListener('scroll', closeMenus, { passive: true });

  $('queueList').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'all') { ui.queueAll = !ui.queueAll; return renderQueue(); }
    const rowId = el.closest('.q-item').dataset.row;
    if (el.dataset.act === 'pin') return togglePin(rowId);
    if (el.dataset.act === 'goto') return gotoRow(rowId);
  });

  $('banner').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'reseed') reseed();
    if (el.dataset.act === 'dismiss-seed') { ui.seedBannerDismissed = true; renderBanner(); }
    if (el.dataset.act === 'dl-problem') {
      const p = problems[Number(el.dataset.i)];
      download(`master-tracker-unreadable-${ymd()}-${hms()}.json`, p.raw);
    }
  });

  let searchTimer = null;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { ui.search = e.target.value; renderGrid(); }, 80);
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; ui.search = ''; renderGrid(); e.target.blur(); }
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      ui.search = e.target.value;
      renderGrid();
      const first = grid.querySelector('tr.row [data-stage]') || grid.querySelector('[data-stage]');
      if (first) focusButton(first);
    }
  });
  $('hideCompleted').addEventListener('change', (e) => { ui.hideCompleted = e.target.checked; renderGrid(); });
  $('btnCollapseAll').addEventListener('click', () => setCollapsed(state.systems.map((s) => s.id), true));
  $('btnExpandAll').addEventListener('click', () => setCollapsed(state.systems.map((s) => s.id), false));
  $('btnQueue').addEventListener('click', () => $('queue').scrollIntoView({ behavior: 'smooth' }));
  $('btnExport').addEventListener('click', exportJSON);
  $('btnImport').addEventListener('click', () => $('fileImport').click());
  $('fileImport').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let text;
    try { text = await file.text(); } catch (err) { return importError(file.name, ['Could not read the file.']); }
    importText(text, file.name);
  });
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);

  document.addEventListener('keydown', (e) => {
    if ($('dialog').open) return;
    const t = e.target;
    const typing = t.matches('textarea, input:not([type=checkbox]):not([type=file]), [contenteditable]');
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (e.key === '/' && !typing && !mod) {
      e.preventDefault();
      $('search').focus();
      $('search').select();
    } else if (mod && !typing && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    } else if (mod && !typing && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (e.key === 'Escape') {
      const open = document.querySelector('.menu:not([hidden])');
      if (open) { closeMenus(); if (open._anchor) open._anchor.focus(); }
    }
  });

  // Another tab saved: pick up its state rather than overwrite it later.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY && e.newValue) {
      try {
        const v = C.validateImport(JSON.parse(e.newValue));
        if (v.ok) { state = v.data; render(); toast('Updated from another tab'); }
      } catch (err) { /* ignore: our own copy stays */ }
    } else if (e.key === META_KEY) {
      meta = loadMeta();
      renderTop();
    }
  });
  window.addEventListener('pagehide', flushNotes);
  setInterval(renderTop, 60 * 60 * 1000); // keep "days ago" fresh in a long-open tab

  /* ---------- Boot ---------- */

  let meta = loadMeta();
  const loaded = loadState();
  let state = loaded.state;
  const isFresh = loaded.fresh;
  try {
    localStorage.setItem('uworldTracker.probe', '1');
    localStorage.removeItem('uworldTracker.probe');
  } catch (e) { storageOK = false; }
  if (isFresh && !loaded.recovered) save();
  // Recovered from the previous save: write it back over the unreadable copy (already set aside)
  // so a later save never rotates the bad data into the backup slot.
  if (!isFresh && loaded.recovered) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* shown via save status */ }
  }
  render();
  if (storageOK) setSaveStatus(true);
  $('saveStatus').textContent = storageOK ? 'All changes save automatically' : $('saveStatus').textContent;
})();
