# TW5-fsa-saver

If you just want to install the plugin, download [example-wiki.html](./example-wiki.html)
and import into your wiki.

On startup, a modal is displayed with file saver settings. Note that it
is recommended to leave the consistency check on. This helps avoid concurrent
writes such as happens when the same wiki is open in separate tabs. If the
file was changed elsewhere, you are asked whether to overwrite it. If you
cancel, nothing is saved and autosave pauses until you save manually.
Reloading the page loads the other changes but discards this page's unsaved
changes.

Browsers only show the file picker in response to a click, so autosave does
nothing until you save manually once (e.g. with the Save button in the
welcome modal). After that, autosave works as normal.

Allowing IndexedDB usage when the wiki is loaded from file:// instead
of a webserver is a potential security issue. Chromium based browsers
consider every page from file:// to be the same origin. This means if you
open an untrusted html file, it could read/write to your wiki file. Note
that this requires you to explicitly download the html page and then
open it from your file system. Merely going to a webpage served via http(s)
is not enough to exploit this vulnerability.

Turning that setting off, or clicking "Reset file save location", removes
this wiki's saved location from IndexedDB. It does not take back file access
the browser has already granted: open pages keep it until they are closed,
and if you chose "Allow on every visit" you need to remove it in the
browser's site settings.

It is recommended to backup the location where you store your wiki regularly.
However, the single file with versioned backup saver style saves each version
of your wiki under /{selected folder}/backups/{wiki filename}/{version hash}.html.

# Updating TW5 Version

This project uses git-subtree to sync with TiddlyWiki 5 as described
in https://www.atlassian.com/git/tutorials/git-subtree.

## Adding Remote

Add the TiddlyWiki5 remote via

```
git remote add tw5 git@github.com:Jermolene/TiddlyWiki5.git
```

## Fetch Changes From Remote

```
git fetch tw5 master
git subtree pull --prefix TiddlyWiki5 tw5 master --squash
```

# Building

1. Run `npm install`
2. Run `node ./build.js`
3. Open `./TiddlyWiki5/editions/tw5.com/output/index.html`
4. Click and drag plugin icon to install in another wiki.
