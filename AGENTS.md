# AGENTS.md

TiddlyWiki 5 plugin (`$:/plugins/slaymaker1907/browser-nativesaver`) that saves a single-file wiki to disk with the File System Access API. Only Chromium-based browsers support that API.

## Layout

- `src/` is the plugin source and the only code you normally edit.
  - `saver.ts`: the `saver` module (all save logic).
  - `saver-controller.ts`: a widget that handles the `ns-reset-file-saver` message.
  - `*.tid`, `plugin.info`: settings UI, default settings, welcome modal, plugin metadata.
- `TiddlyWiki5/` is a git subtree of upstream TiddlyWiki. Don't edit it; update it with the subtree commands in `README.md`.
- `example-wiki.html` is the downloadable demo: an empty TiddlyWiki 5.2.1 with the plugin embedded.
- `build/`, `tw5.html` and `TiddlyWiki5/plugins/slaymaker1907/` are build output and are ignored by git.

## Commands

- `npm install`, then `npm run build` (runs `build.js`). This compiles TypeScript with the local `typescript` package, copies the plugin into `TiddlyWiki5/plugins/slaymaker1907/`, builds the tw5.com edition with the plugin and copies the result to `tw5.html`.
- Type-check only: `npx tsc --noEmit -p .`
- There is no automated test suite (`npm test` is a placeholder). The File System Access API needs a real Chromium browser, so check behaviour by hand in `tw5.html` or `example-wiki.html`.

## Conventions

- **Line endings:** `src/*`, `build.js` and `README.md` use CRLF. Keep CRLF when you edit them. Many scripted edits silently convert to LF.
- **Module format:** `tsconfig.json` uses `"module": "None"`, so source files can't use `import`/`export`. Each file is a TiddlyWiki module: the `/*\ title: ... module-type: ... \*/` header becomes the tiddler, `require` takes TiddlyWiki module titles, and exports go through `module.exports`.
- **Settings:** setting names (`enable-saver?`, `check-consistency?`, `save-style`, ...) are fields on `.../settings-data`. The constants in `saver.ts`, the defaults in `settings-data.tid` and the checkbox `default`s in `settings.tid` must all agree.
- **Versioning:** keep the version in `src/plugin.info` and `package.json` the same. TiddlyWiki only replaces an installed plugin with a newer version, so bump it for every release.

## How saving works (things that are easy to break)

- **Click requirement:** browsers only show file pickers and permission prompts in response to a user click. `userInteractionInit` must run synchronously inside `save()`, never after an `await`. Autosave is skipped, and `save()` returns `true` without calling the callback, until a manual save has set up a location for the current save style, and after the user declines an overwrite until their next manual save (`autosaveSuspended`, also checked when a queued save starts). Returning `false` would let TiddlyWiki hand the save to a lower-priority saver.
- **Return value:** if `save()` returns `true` it owns the callback. If it returns `false`, TiddlyWiki tries the next saver, so don't call the callback in that case.
- **One save at a time:** TiddlyWiki starts saves without waiting for earlier ones to finish. Saves are chained on `saveQueue`. A newer request to the same `SaveTarget` replaces the contents of the waiting `pendingSave`, and the replaced callback is never called, so a stuck tab doesn't pile up copies of the wiki text. Requests to a different target (after a reset or style change) get their own place in the queue, so that file still gets its save. If a replaced request was manual, the replacement counts as manual (`SaveRequest.manual`), so paused autosave can't swallow a click on Save. Running a manual request clears `autosaveSuspended`. Each save captures its `SaveTarget` up front, so a reset or style change doesn't affect saves already queued.
- **Other tabs:** `saveQueue` only covers one tab. The consistency check and the write run inside `withSaveLock` (Web Locks API, shared across tabs of the same origin), so two tabs can't both pass the check before either one writes. If the browser refuses the lock with `SecurityError` before granting it (e.g. opaque origins), the save goes ahead without it; errors after the lock is granted come from the save and are never retried. Waiting for the lock gives up after `SAVE_LOCK_TIMEOUT_MS` with an error, since another tab may hold it while its overwrite question is open (or a hostile local page may hold it forever).
- **Unsaved-changes count:** TiddlyWiki's success callback sets `$tw.saverHandler.numChanges` to 0, which would also mark edits made after the save started as saved. `markSaved` restores the count of changes the save didn't include. That uses the saver's own `totalChanges`, which counts change events with the core `filterFn` but is never reset, because other savers (e.g. while this one is disabled) reset `numChanges`. The count kept after a save is the smaller of the changes since this save's text and `numChanges`, since only changes after both this save and the last save by any saver are unsaved. Core batches change events and counts them in a `setTimeout(0)`, once per tiddler per batch. So `snapshotIncludedChanges` counts what was queued in `wiki.changedTiddlers` when `save()` ran (using the core `filterFn`), not the whole batch. It also treats a queued tiddler whose `getChangeCount` rises before the batch is counted as still unsaved. Otherwise a click that changes A, saves, then changes B would mark B as saved. It relies on `numChanges` and `updateDirtyStatus` from core and does nothing extra if they're missing.
- **Consistency check:**
  - `prevPageHash` is recorded only after a write succeeds, and `lastWrittenHashes` keeps the last hash written to each file name. A file holding that latest hash passes the check. Don't accept older versions this page wrote: the user may have restored one from the backups.
  - Within one save, the wiki file is read and hashed at most once (`readCurrent` in `saveFile`), and that result is shared by the replace check, the consistency check and the backup. After any overwrite question it is read again before the backup, since the file may have changed while the dialog was open.
  - Writes go through `writeFile`, which aborts (rather than closes) the writable on failure, because closing commits a partial file.
  - On the first save to a file, the check compares the file's `lastModified` with `performance.timeOrigin`. It skips this only when the file is empty. Don't exempt files the user just picked: users re-pick the wiki's own file in each new tab, which another tab may have saved since.
  - If the file changed elsewhere, the user is asked to confirm the overwrite (`confirmOverwrite`). Declining saves nothing, not even a backup, and pauses autosave. In backup mode the backup is written through `saveFile`'s `beforeWrite`, after the check but before the wiki file.
- **Backup-style file name:** the `wiki-file-name` setting (`getExplicitWikiFileName`), otherwise `getDefaultWikiFileName`: the name of the file the page was loaded from (on `file://`), then the download saver's name or the site title. Don't put the site title first: renaming the wiki would switch saving to a new, empty file, which passes the first-save check, and a later session opened from the old file would overwrite it. For the same reason the default is worked out once, when the saver is created, and only the setting can change the file mid-session. That is checked on every save, and a change creates a new `SaveTarget` on the same directory handle, which needs no picker. Such a target has `confirmReplace` set: its first save asks before replacing an existing non-empty file that doesn't hold what this page last wrote to that file name (`lastWrittenHashes`), even with the consistency check off. The file name is used untrimmed when it comes from the opened file; only typed names are trimmed.
- **Backups:** named by the SHA-256 of their text. Before the wiki file is overwritten, `saveBackup` also backs up its current contents (`writeBackup` with `skipIfExists`), so an accepted overwrite or replace can be undone. An existing backup is only skipped if its contents match its name, since a failed write leaves an empty or partial file behind. `confirmReplace` is cleared only after the wiki file is written, so a failed save asks again.
- **Remembering the location:** the chosen file or directory handle is cached in IndexedDB, keyed by `WIKI_FILE_HANDLE:` plus a hash of the page URL without its `#fragment`. Close database connections after use, because an open connection blocks deletion and upgrades in other tabs.
- **Removing a saved location:** use `removeCachedHandle`, never `deleteDatabase`. On `file://` every wiki shares one database, so deleting it would wipe other wikis' saved locations. Keys starting with `CURRENT_FILE_HANDLE` come from before 0.8.0, can't be looked up any more, and are deleted whenever the database is opened.
- **Security:** every `file://` page shares one origin in Chromium, so any local HTML file could read the cached handles. IndexedDB is therefore off on `file://` unless the user enables `allow-indexedDB?`, and `isServedFromFS` must fail closed (return `true` on error). When IndexedDB use isn't allowed, this wiki's cached handle is removed at startup and whenever the settings change. That cleanup is registered from `canSave` (`registerHandleCleanup`), not `create`, because core doesn't call `create` when the saver is disabled. Removing a handle doesn't revoke permission the browser has already granted.
- **TiddlyWiki behaviour:** core calls `canSave` only once, at startup, and only creates savers for which it returned true. So `canSave` checks browser support only, not `enable-saver?`; `save()` returns `false` while the saver is disabled, and the welcome modal is only shown when it's enabled. State that should change behaviour at runtime has to be checked in `save()`.

## Updating example-wiki.html

`npm run build` does not update `example-wiki.html`. When releasing, replace only the `$:/plugins/slaymaker1907/browser-nativesaver` tiddler in its `tiddlywiki-tiddler-store` JSON with the one from the freshly built `tw5.html` (escape `<` as `<`, as TiddlyWiki does). Don't re-render the whole file with the subtree's TiddlyWiki, which is an unreleased prerelease version.

## Git

- Default branch is `main`.
- Don't commit build output or `local-config.toml`. `local-config.toml` holds a per-machine override, `[tsc] command`.
