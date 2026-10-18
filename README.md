# UWorld Master Material Pipeline Tracker

A personal progress tracker for the USMLE master-material pipeline. It shows every UWorld system and subheading across six stages: **Draft → Solve → PDF → Merge → Figures → Print**.
It is one self-contained `index.html`: no server, no install, no internet connection needed.

## Opening it

Double-click `index.html`. It opens in your browser and works offline.

- Every change saves automatically to the browser's `localStorage`. The top bar shows "Saved hh:mm".
- Keep opening the **same file in the same browser**. Saved data belongs to that browser (and, in some browsers, to the file's location). If you open the file in a different browser, or after moving it, you will see a fresh tracker. Use **Import** to bring your data across.
- Private/incognito windows throw their storage away when closed. Don't use them for real work.

## Using it

| Action | How |
| --- | --- |
| Cycle a cell | Click it, or press Space. The order is to do (empty) → done (filled) → N/A (dash) → to do |
| Set a stage for a whole system | Click the `x/y` count in the system's header row, then choose Done / N/A / To do |
| Move between cells | Arrow keys (Home/End jump to the first or last stage) |
| Search | `/`, then type. It matches subheading or system names. Enter jumps into the results |
| Undo / redo | Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y). Covers the last 50 actions |
| Notes | The ✎ icon on a row. The first line shows under the name |
| Pin to the top of Next up | The ★ icon on a row or a queue item |
| Rename / move / delete a row | Double-click the name, or use the ⋯ menu |
| Add a row | The + on a system header |

- **N/A cells** (for example a subheading with no figures) are left out of every percentage.
- A small **!** on a done cell means an earlier stage is still to do. It's only a warning; nothing is blocked.
- **Next up** lists each row's next action: its first to-do stage, where every earlier stage is done or N/A. Actions are grouped by stage and follow system order, with pinned rows on top. The first 10 show by default; "Show all" lists the rest. Clicking an item jumps to its row.
- **"Printed"** in the top bar counts subheadings whose Print stage is done.
- Renaming keeps the row's ID (e.g. `cardiovascular-system/miscellaneous`), so imports and re-seeding still match the row.

## Backups (nothing gets lost)

- **Export** downloads `master-tracker-YYYY-MM-DD.json`. The top bar shows "Last exported: N days ago". The Export button turns amber when a backup is due: more than 7 days since the last export, more than 50 changes since then, or never exported.
- **Import** first validates the file (schema version, structure, every cell's state). A bad file is rejected with a list of reasons, and your current data is never touched. A valid file then offers two choices:
  - **Merge**: keeps everything you have and matches rows by ID. For each cell, the more advanced state wins (done > N/A > to do). Rows and systems in the file that you don't have are added. Notes from both sides are kept.
  - **Replace**: loads the file exactly as it is.
- Before any import, merge-from-seed or reset, the app **automatically downloads a backup** of your current state (`master-tracker-backup-…-before-import.json`, etc.). Ctrl+Z also reverses an import.
- **Reset to seed** (⋯ menu) wipes all progress. You must type `RESET` to confirm, and it downloads a backup first.
- The app also keeps the previous save in a second storage slot. If the main save is ever unreadable, it loads the previous one, keeps the unreadable copy aside (it's never deleted), and shows a banner with a button to download it.
- Files from a newer version of the app, or from an older schema with no migration path, are refused rather than guessed at.

Export → Reset → Import (Replace) restores the identical state. The automated tests check this.

## Re-seeding from an updated markdown file

The subheading list comes from `uworld_systems_subheadings.md` (`## System`, then `- Subheading` lines). To update it without losing progress:

1. **Export** a backup from the app.
2. Edit `uworld_systems_subheadings.md`, then rebuild (requires [Node.js](https://nodejs.org), no packages):
   ```sh
   npm run seed    # parses the markdown into src/seed.json and prints the counts
   npm run build   # writes a new index.html
   ```
3. Open the new `index.html` in the same browser. If your progress isn't there (because the file moved or you switched browsers), use **Import → Replace** with the backup from step 1.
4. A banner offers to merge any subheadings that are new in the list. You can also run ⋯ → **Merge subheadings from seed**.

How the merge treats your data:

- Rows are matched by ID: `system-slug/subheading-slug`, for example `renal-urinary-systems-and-electrolytes/miscellaneous`.
- New subheadings are inserted next to their neighbours from the markdown. Existing rows, progress, notes, renames and rows you added yourself are never changed or removed.
- Rows you **deleted** in the app stay deleted. Renaming a subheading in the markdown creates a new ID, so it shows up as a new row; delete the old row if you no longer want it.

## Development

```
uworld_systems_subheadings.md   source list
src/seed.json                   parsed seed (generated by npm run seed)
src/core.js                     pure logic: parsing, progress, next-up, validation, merge
src/app.js                      UI (vanilla JS, no framework)
src/styles.css, template.html   page shell and styles
scripts/build.js                inlines everything into index.html
index.html                      the built app (committed, so it works without building)
test/core.test.js               unit tests (node:test)
scripts/e2e.js                  browser test of the real index.html (Playwright)
```

```sh
npm test            # unit tests, no dependencies
npm run test:e2e    # end-to-end in headless Chromium (needs: npm i -D playwright)
npm run check       # verifies index.html is up to date with src/, then runs both
```

Data model (`schemaVersion: 1`):

```js
{
  schemaVersion: 1,
  updatedAt: "ISO date",
  stages: ["draft","solve","pdf","merge","figures","print"],
  deletedRowIds: [],               // rows you deleted, so re-seeding doesn't bring them back
  systems: [{ id, name, collapsed, rows: [{
    id, name, notes, pinned,
    stages: { draft: { state: "todo" | "done" | "na", doneAt: "ISO date" | null }, ... }
  }] }]
}
```

To change the schema later: bump `SCHEMA_VERSION` in `src/core.js` and add `MIGRATIONS[oldVersion] = (data) => newData`. Older exports will then import cleanly.
