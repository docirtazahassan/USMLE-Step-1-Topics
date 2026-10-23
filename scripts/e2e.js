#!/usr/bin/env node
// End-to-end check of the built index.html in headless Chromium, opened from file://.
// Needs Playwright (npm i -D playwright, or a global install). Usage: npm run test:e2e
// Pass --shots <dir> to save screenshots.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  console.log('Playwright not installed; skipping e2e. (npm i -D playwright)');
  process.exit(0);
}

const root = path.join(__dirname, '..');
const url = 'file://' + path.join(root, 'index.html');
const shotsIdx = process.argv.indexOf('--shots');
const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-e2e-'));
const KEY = 'uworldTracker.state.v1';

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; }
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  const cell = (rowId, stage = 'done') => page.locator(`tr[data-row="${rowId}"] .cell[data-stage="${stage}"]`);
  const cellState = async (rowId, stage = 'done') => (await cell(rowId, stage).getAttribute('class')).match(/s-(\w+)/)[1];
  const download = async (trigger) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), trigger()]);
    const file = path.join(tmp, dl.suggestedFilename());
    await dl.saveAs(file);
    return { name: dl.suggestedFilename(), file, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
  };
  const importFile = (file) => page.setInputFiles('#fileImport', file);
  const dialogButton = (label) => page.locator('#dialog[open] button', { hasText: label });

  await page.goto(url);
  const R1 = 'allergy-and-immunology/anaphylaxis-and-allergic-reactions';
  const R2 = 'allergy-and-immunology/miscellaneous';

  await step('shows every system and subheading', async () => {
    assert.equal(await page.locator('tr.sys').count(), 26);
    assert.equal(await page.locator('tr.row').count(), 169);
    assert.equal(await page.locator('#overallPct').textContent(), '0%');
  });

  await step('there is one Done column', async () => {
    assert.deepEqual(await page.locator('thead th').allTextContents(), ['Subheading', 'Done']);
    assert.equal(await page.locator(`tr[data-row="${R1}"] .cell`).count(), 1);
  });

  await step('clicking cycles todo → done → N/A → todo, and survives refresh', async () => {
    await cell(R2).click();
    assert.equal(await cellState(R2), 'done');
    await cell(R2).click();
    assert.equal(await cellState(R2), 'na');
    await page.reload();
    assert.equal(await cellState(R2), 'na');
    await cell(R2).click();
    assert.equal(await cellState(R2), 'todo');
    await cell(R1).click();
    await page.reload();
    assert.equal(await cellState(R1), 'done');
    assert.equal(await cellState(R2), 'todo');
    const s = await stored();
    assert.ok(s.systems[0].rows[0].stages.done.doneAt);
    assert.equal(s.systems[0].rows[1].stages.done.doneAt, null);
    assert.equal(await page.locator('#overallPct').textContent(), '0.5%');
  });

  await step('keyboard: arrows move, Space cycles, / focuses search, Ctrl+Z undoes', async () => {
    await cell(R1).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement.closest('tr').dataset.row), R2);
    await page.keyboard.press('Space');
    assert.equal(await cellState(R2), 'done');
    // focus stays on the cell after re-render
    assert.equal(await page.evaluate(() => document.activeElement.closest('tr').dataset.row), R2);
    await page.keyboard.press('Control+z');
    assert.equal(await cellState(R2), 'todo');
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await cellState(R2), 'done');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'search');
    await page.keyboard.press('Escape');
  });

  await step('search filters by subheading and by system name', async () => {
    await page.fill('#search', 'miscellaneous');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('tr.row').count(), 20); // 20 systems have a "Miscellaneous" row
    await page.fill('#search', 'cardiovascular');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('tr.sys').count(), 1);
    assert.equal(await page.locator('tr.row').count(), 11);
    await page.fill('#search', '');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('tr.row').count(), 169);
  });

  await step('bulk-set a whole system from its header (with confirmation), then undo', async () => {
    const hcell = page.locator('tr.sys[data-sys="dermatology"] .hcell');
    await hcell.click();
    await dialogButton('Cancel').click();
    assert.equal(await hcell.textContent(), '0/6');
    await hcell.click();
    await dialogButton('Mark N/A').click();
    assert.equal(await hcell.textContent(), '—');
    await hcell.click();
    await dialogButton('Mark done').click();
    assert.equal(await hcell.textContent(), '6/6');
    await page.click('#btnUndo');
    assert.equal(await hcell.textContent(), '—');
    await page.click('#btnUndo');
    assert.equal(await hcell.textContent(), '0/6');
  });

  await step('hide completed hides rows with no todo cells', async () => {
    await page.locator('tr.sys[data-sys="ear-nose-and-throat-ent"] .hcell').click();
    await dialogButton('Mark done').click();
    await page.check('#hideCompleted');
    assert.equal(await page.locator('tr.sys[data-sys="ear-nose-and-throat-ent"]').count(), 0);
    assert.equal(await page.locator('tr.row').count(), 167);
    await page.uncheck('#hideCompleted');
    assert.match(await page.locator('#overallSub').textContent(), /^2\/169 subheadings done/);
  });

  await step('collapse all / expand all persist', async () => {
    await page.click('#btnCollapseAll');
    assert.equal(await page.locator('tr.row').count(), 0);
    await page.reload();
    assert.equal(await page.locator('tr.row').count(), 0);
    await page.click('#btnExpandAll');
    assert.equal(await page.locator('tr.row').count(), 169);
  });

  await step('notes save and survive refresh', async () => {
    await page.locator(`tr[data-row="${R1}"] [data-act=notes]`).click();
    await page.keyboard.type('merge with renal acid-base');
    await cell(R2).focus();
    await page.reload();
    assert.equal((await stored()).systems[0].rows[0].notes, 'merge with renal acid-base');
    assert.equal(await page.locator(`tr[data-row="${R1}"] .note-preview`).textContent(), 'merge with renal acid-base');
  });

  await step('add, rename, move and delete rows', async () => {
    await page.locator('tr.sys[data-sys="dermatology"] [data-act=add]').click();
    await page.keyboard.type('Acne split A');
    await page.keyboard.press('Enter');
    const newId = 'dermatology/acne-split-a';
    assert.equal(await page.locator(`tr[data-row="${newId}"]`).count(), 1);
    await page.locator(`tr[data-row="${newId}"] .rname`).dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Acne (renamed)');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator(`tr[data-row="${newId}"] .rname`).textContent(), 'Acne (renamed)');
    await page.locator(`tr[data-row="${newId}"] [data-act=menu]`).click();
    await page.locator('#rowMenu button[data-act=up]').click();
    const names = await page.locator('tr.row[data-sys="dermatology"] .rname').allTextContents();
    assert.equal(names[names.length - 2], 'Acne (renamed)');
    await page.locator(`tr[data-row="${newId}"] [data-act=menu]`).click();
    await page.locator('#rowMenu button[data-act=delete]').click();
    await dialogButton('Delete').click();
    assert.equal(await page.locator(`tr[data-row="${newId}"]`).count(), 0);
    assert.ok((await stored()).deletedRowIds.includes(newId));
  });

  await step('next-up queue follows the rules', async () => {
    const items = await page.locator('.q-item').evaluateAll((els) => els.map((e) => e.dataset.row));
    assert.equal(items.length, 10);
    assert.equal(items[0], R2); // first row still to do
    assert.ok(!items.includes(R1)); // R1 is done
    const pinTarget = 'pharmacology-general-principles/pharmacokinetics';
    await page.locator(`tr[data-row="${pinTarget}"] [data-act=pin]`).click();
    assert.equal(await page.locator('.q-item').first().getAttribute('data-row'), pinTarget);
    await page.locator('.queue .more').click();
    assert.equal(await page.locator('.q-item').count(), 167);
    await page.locator('.queue .more').click();
    await page.locator('.q-item').nth(3).locator('.q-main').click();
    const target = await page.locator('.q-item').nth(3).getAttribute('data-row');
    assert.equal(await page.evaluate(() => document.activeElement.closest('tr').dataset.row), target);
    assert.equal(await page.locator(`tr[data-row="${target}"].flash`).count(), 1);
  });

  let exported;
  await step('export downloads master-tracker-YYYY-MM-DD.json and resets the nudge', async () => {
    assert.match(await page.locator('#exportAge').textContent(), /Never exported/);
    assert.ok(await page.locator('#exportAge.nudge').count());
    exported = await download(() => page.click('#btnExport'));
    assert.match(exported.name, /^master-tracker-\d{4}-\d{2}-\d{2}\.json$/);
    assert.deepEqual(exported.json, await stored());
    assert.match(await page.locator('#exportAge').textContent(), /Last exported: today/);
    assert.equal(await page.locator('#exportAge.nudge').count(), 0);
  });

  await step('export nudge after 7 days or 50 changes', async () => {
    await page.evaluate(() => {
      const m = JSON.parse(localStorage.getItem('uworldTracker.meta.v1'));
      m.lastExportAt = new Date(Date.now() - 9 * 864e5).toISOString();
      localStorage.setItem('uworldTracker.meta.v1', JSON.stringify(m));
    });
    await page.reload();
    assert.match(await page.locator('#exportAge').textContent(), /9 days ago/);
    assert.ok(await page.locator('#btnExport.nudge').count());
    await page.evaluate(() => {
      localStorage.setItem('uworldTracker.meta.v1', JSON.stringify({ lastExportAt: new Date().toISOString(), changesSinceExport: 51 }));
    });
    await page.reload();
    assert.ok(await page.locator('#btnExport.nudge').count());
    await page.evaluate(() => {
      localStorage.setItem('uworldTracker.meta.v1', JSON.stringify({ lastExportAt: new Date().toISOString(), changesSinceExport: 0 }));
    });
    await page.reload();
  });

  await step('reset to seed requires typing RESET and downloads a backup first', async () => {
    await page.click('#btnMore');
    await page.locator('#moreMenu button[data-act=reset]').click();
    assert.ok(await dialogButton('Reset everything').isDisabled());
    await page.locator('#dialog input').fill('reset');
    assert.ok(await dialogButton('Reset everything').isDisabled());
    await page.locator('#dialog input').fill('RESET');
    const backup = await download(() => dialogButton('Reset everything').click());
    assert.match(backup.name, /before-reset/);
    assert.deepEqual(backup.json, exported.json);
    assert.equal(await page.locator('#overallPct').textContent(), '0%');
    assert.equal((await stored()).systems[0].rows[0].notes, '');
  });

  const before = await stored();
  const corrupt = path.join(tmp, 'corrupt.json');
  fs.writeFileSync(corrupt, fs.readFileSync(exported.file, 'utf8').slice(0, 5000));
  const older = path.join(tmp, 'older.json');
  fs.writeFileSync(older, JSON.stringify({ ...exported.json, schemaVersion: 0 }));
  const newer = path.join(tmp, 'newer.json');
  fs.writeFileSync(newer, JSON.stringify({ ...exported.json, schemaVersion: 7 }));
  const broken = path.join(tmp, 'broken.json');
  const b = JSON.parse(JSON.stringify(exported.json));
  b.systems[3].rows[2].stages.done.state = 'finished';
  fs.writeFileSync(broken, JSON.stringify(b));

  for (const [label, file, re] of [
    ['truncated JSON', corrupt, /not valid JSON/],
    ['older schemaVersion', older, /too old/],
    ['newer schemaVersion', newer, /newer/],
    ['invalid cell state', broken, /state must be one of/],
  ]) {
    await step(`bad import (${label}) is rejected and leaves data untouched`, async () => {
      await importFile(file);
      await page.locator('#dialog[open] h2', { hasText: 'Import cancelled' }).waitFor();
      assert.match(await page.locator('#dialog .errors').textContent(), re);
      await dialogButton('OK').click();
      assert.deepEqual(await stored(), before);
    });
  }

  await step('import → Replace restores the identical exported state (backup downloaded first)', async () => {
    await importFile(exported.file);
    const backup = await download(() => dialogButton('Replace').click());
    assert.match(backup.name, /before-import/);
    assert.deepEqual(backup.json, before);
    assert.deepEqual(await stored(), exported.json);
    await page.reload();
    assert.deepEqual(await stored(), exported.json);
    assert.equal((await stored()).systems[0].rows[0].notes, 'merge with renal acid-base');
  });

  await step('import → Merge keeps local progress and adds the more advanced cells', async () => {
    // local change after the export
    const R3 = 'dermatology/skin-and-soft-tissue-infections';
    await cell(R3).click();
    const other = JSON.parse(JSON.stringify(exported.json));
    other.systems[0].rows[1].stages.done = { state: 'done', doneAt: '2026-01-01T00:00:00.000Z' };
    other.systems[0].rows.push({ id: 'allergy-and-immunology/from-laptop', name: 'From laptop', notes: '', pinned: false,
      stages: { done: { state: 'todo', doneAt: null } } });
    const f = path.join(tmp, 'other.json');
    fs.writeFileSync(f, JSON.stringify(other));
    await importFile(f);
    await download(() => dialogButton('Merge').click());
    assert.equal(await cellState(R3), 'done');
    assert.equal(await cellState(R2), 'done');
    assert.equal(await page.locator('tr[data-row="allergy-and-immunology/from-laptop"]').count(), 1);
    await page.keyboard.press('Control+z');
    assert.equal(await page.locator('tr[data-row="allergy-and-immunology/from-laptop"]').count(), 0);
  });

  const V1 = ['draft', 'solve', 'pdf', 'merge', 'figures', 'print'];
  const toV1 = (st, fill) => {
    const x = JSON.parse(JSON.stringify(st));
    x.schemaVersion = 1;
    x.stages = V1;
    x.systems.forEach((sy) => sy.rows.forEach((r) => {
      const c = r.stages.done;
      r.stages = Object.fromEntries(V1.map((k) => [k, { ...c }]));
    }));
    fill(x);
    return x;
  };

  await step('an old six-column (v1) export imports and migrates to the Done column', async () => {
    const R4 = 'cardiovascular-system/hypertension';
    const R5 = 'cardiovascular-system/heart-failure-and-shock';
    const v1 = toV1(await stored(), (x) => {
      const rows = x.systems.find((sy) => sy.id === 'cardiovascular-system').rows;
      const all = rows.find((r) => r.id === R4).stages;
      V1.forEach((k) => { all[k] = { state: 'done', doneAt: '2026-01-05T00:00:00.000Z' }; });
      rows.find((r) => r.id === R5).stages.draft = { state: 'done', doneAt: '2026-01-05T00:00:00.000Z' }; // partial: stays to do
    });
    const f = path.join(tmp, 'v1.json');
    fs.writeFileSync(f, JSON.stringify(v1));
    await importFile(f);
    await download(() => dialogButton('Merge').click());
    assert.equal(await cellState(R4), 'done');
    assert.equal(await cellState(R5), 'todo');
    assert.equal((await stored()).schemaVersion, 2);
  });

  await step('six-column (v1) data already saved in the browser is upgraded on open', async () => {
    const R6 = 'nervous-system/headache';
    const prevState = await stored();
    await page.evaluate(([k, v]) => { localStorage.setItem(k, v); }, [KEY, JSON.stringify(toV1(prevState, (x) => {
      const r = x.systems.flatMap((sy) => sy.rows).find((row) => row.id === R6);
      V1.forEach((k) => { r.stages[k] = { state: k === 'figures' ? 'na' : 'done', doneAt: k === 'figures' ? null : '2026-01-06T00:00:00.000Z' }; });
    }))]);
    await page.reload();
    assert.equal(await page.locator('#banner.error').count(), 0);
    assert.equal(await cellState(R6), 'done');
    assert.equal(await cellState(R1), 'done');
    await cell(R6).click(); // next save writes v2
    assert.equal((await stored()).schemaVersion, 2);
    await page.keyboard.press('Control+z');
  });

  await step('corrupted saved data is set aside, not wiped, and the app still opens', async () => {
    const prev = await page.evaluate((k) => JSON.parse(localStorage.getItem(k + '.prev')), KEY);
    await page.evaluate((k) => { localStorage.setItem(k, '{"schemaVersion":1, "systems": [garbage'); }, KEY);
    await page.reload();
    assert.ok(await page.locator('#banner.error').isVisible());
    assert.match(await page.locator('#banner').textContent(), /could not be read/);
    // recovered from the previous save (one step behind)
    assert.deepEqual(await stored(), prev);
    assert.equal(await page.locator('tr.row').count(), prev.systems.reduce((n, x) => n + x.rows.length, 0));
    const quarantined = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('uworldTracker.corrupt.')));
    assert.equal(quarantined.length, 1);
  });

  await step('new subheadings in the seed are offered for merge', async () => {
    await page.evaluate((k) => {
      const s = JSON.parse(localStorage.getItem(k));
      s.systems[1].rows.splice(0, 1);
      localStorage.setItem(k, JSON.stringify(s));
    }, KEY);
    await page.reload();
    assert.match(await page.locator('#banner').textContent(), /1 subheading that is not in your tracker/);
    await page.locator('#banner [data-act=reseed]').click();
    await download(() => dialogButton('Merge').click());
    assert.equal(await page.locator('tr.row[data-sys="dermatology"]').first().getAttribute('data-row'), 'dermatology/skin-and-soft-tissue-infections');
  });

  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('corrupt')).forEach((k) => localStorage.removeItem(k)));
    await page.reload();
    await page.screenshot({ path: path.join(shots, 'desktop-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(shots, 'desktop-dark.png') });
    const phone = await context.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(url);
    await phone.screenshot({ path: path.join(shots, 'phone-light.png') });
  }

  await step('no console or page errors', async () => { assert.deepEqual(errors, []); });

  await browser.close();
  console.log(`\n${passed} e2e checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
