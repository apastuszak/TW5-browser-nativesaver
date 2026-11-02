/*\
title: $:/plugins/slaymaker1907/browser-nativesaver/saver.js
type: application/javascript
module-type: saver

Main module for saving to a file from a browser. Only Chromium based browsers currently
support the necessary APIs.

\*/
enum SaverCapability {
    Save = "save",
    AutoSave = "autosave",
    Download = "download"
}

enum SaverStyle {
    SingleFileVersionBackup = "single-file-version-backup",
    SingleFile = "single-file"
}

function constructEnumPredicate<RuntimeT extends string, EnumClass extends {[key: string]: RuntimeT}>(enumClass: EnumClass): (maybeEnum: string) => maybeEnum is EnumClass[keyof EnumClass] {
    const reverseMapping: {[key: string]: boolean} = {};

    for (const enumVal in enumClass) {
        const enumStr = enumClass[enumVal];
        reverseMapping[enumStr] = true;
    }

    function result(maybeEnum: any): maybeEnum is EnumClass[keyof EnumClass] {
        return !!reverseMapping[maybeEnum];
    }

    return result;
}

const isSaverStyle = constructEnumPredicate(SaverStyle);
interface SaverInfo {
    name: string;
    priority: number;
    capabilities: SaverCapability[]
}

type TWSaverCB = (err: string|null, info?: string) => void;

interface TWSaver {
    info: SaverInfo;
    save(text: string, method: SaverCapability, callback: TWSaverCB): boolean;
}

interface Tiddler {
    // Always returns a string, but may be blank.
    getFieldString(field: string): string;
}

interface TWModalManager {
    display(tiddlerTitle: string): void;
}

interface TWWiki {
    getTiddler(name: string): Tiddler|undefined;
    addTiddler(tiddler: any): void;
    addEventListener(type: "change", listener: (changes: {[title: string]: unknown}) => void): void;
    getChangeCount(title: string): number;
    // Changes not yet sent to "change" listeners (TiddlyWiki internals).
    changedTiddlers?: {[title: string]: unknown};
    modal: TWModalManager;
}

// Internals of TiddlyWiki's saver handler ($tw.saverHandler) which track unsaved changes.
interface TWSaverHandlerInternals {
    numChanges: number;
    updateDirtyStatus(): void;
    // Compiled filter for which changed tiddlers count as unsaved changes.
    filterFn(source: (iterator: (tiddler: Tiddler | undefined, title: string) => void) => void): string[];
}

interface SaverHandler {
    wiki: TWWiki;
}

declare const module: {exports: any};

const PLUGIN_NAME = "slaymaker1907/browser-nativesaver";
const BASE_TIDDLER_PATH = `$:/plugins/${PLUGIN_NAME}`;
const PLUGIN_SETTINGS_DATA = `${BASE_TIDDLER_PATH}/settings-data`
const PLUGIN_SETTINGS_TIDDLER = `${BASE_TIDDLER_PATH}/settings`
const ENABLE_LOGGING_FIELD = "enable-logging?";
const ENABLE_SAVER_FIELD = "enable-saver?";
const CHECK_CONSISTENCY_FIELD = "check-consistency?";
const SAVER_STYLE_FIELD = "save-style";
const ALLOW_INDEXED_DB_FIELD = "allow-indexedDB?";
const WIKI_FILENAME_FIELD = "wiki-file-name";
const SHOW_WELCOME_MODAL_FIELD = "show-welcome-modal?";
const YES = "yes";
const UNIQUE_PLUGIN_ID = "QqiTNHy4qkN9TtIYbd5i";
const WELCOME_PAGE = "$:/plugins/slaymaker1907/browser-nativesaver/welcome";
const BACKUP_FOLDER_NAME = "backups";
const DEFAULT_WIKI_FILENAME = "index.html";

let logDebug = console.log;

const setupLogging = (wiki: TWWiki) => {
    try {
        const tiddler = wiki.getTiddler(PLUGIN_SETTINGS_DATA);
        if (!tiddler) {
            return;
        }

        const fieldValue = tiddler.getFieldString(ENABLE_LOGGING_FIELD);
        if (fieldValue === YES) {
            logDebug = console.log;
        } else {
            logDebug = () => {};
        }
    } catch (err) {
        console.error("Could not initialize logging due to error: %o", err);
    }
};

const isEnabled = (wiki: TWWiki) => {
    return wiki.getTiddler(PLUGIN_SETTINGS_DATA)!.getFieldString(ENABLE_SAVER_FIELD) === YES;
};

function getSaverStyle(wiki: TWWiki): SaverStyle {
    try {
        const maybeSaverStyle = wiki.getTiddler(PLUGIN_SETTINGS_DATA)!.getFieldString(SAVER_STYLE_FIELD);
        if (isSaverStyle(maybeSaverStyle)) {
            return maybeSaverStyle;
        } else {
            logDebug("Input saver style [%s] is not recognized, using default of SingleFile.", maybeSaverStyle);
            return SaverStyle.SingleFile;
        }
    } catch(err) {
        console.error("Error checking if versioning is enabled, using single file style.");
        console.error(err);
        return SaverStyle.SingleFile;
    }
};

const isServedFromFS = () => {
    try {
        const protocol = window.location.protocol;
        logDebug("TiddlyWiki location protocol is [%o]", protocol);
        return protocol === "file:";
    } catch (err) {
        logDebug("Error occurred trying to determine protocol for TiddlyWiki: %o", err);
        logDebug("Assuming that it is file:/ to maximimize security");
        return true;
    }
};

function canUseIndexedDB(wiki: TWWiki): boolean {
    return !isServedFromFS() || wiki.getTiddler(PLUGIN_SETTINGS_DATA)!.getFieldString(ALLOW_INDEXED_DB_FIELD) === YES;
}

/**
 * Converts an IDBRequest to an equivalent Promise.
 */
function idbRequestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => {
            try {
                resolve(request.result);
            } catch (err) {
                // This is possible only on incorrect API usage, but just want to be safe to avoid
                // infinite loops.
                reject(err);
            }
        };

        request.onerror = () => {
            reject(request.error);
        };
    });
}

/**
 * Return a Promise which will resolve when the transaction succeeds or
 * reject when it faild and/or aborts.
 */
const getTransactionCommitPromise = (transaction: IDBTransaction) => {
    return new Promise<void>((resolve, reject) => {
        let errorSeen = false;
        transaction.oncomplete = () => resolve();
        const errorHandler = () => {
            if (!errorSeen) {
                errorSeen = true;
                reject(transaction.error || "Transaction aborted/failed");
            }
        };
        transaction.onerror = errorHandler;
        transaction.onabort = errorHandler;
    });
};

const DB_VERSION = 1;
const DB_NAME = `FileHandles-${UNIQUE_PLUGIN_ID}`;
const DB_HANDLE_OBJECT_STORE_NAME = "FileHandles";
const HANDLE_KEY_PREFIX = "WIKI_FILE_HANDLE:";
// Keys from before 0.8.0, which hashed the URL differently and so can't be looked up any more.
const LEGACY_HANDLE_KEY_PREFIX = "CURRENT_FILE_HANDLE";
const SAVE_LOCK_NAME = `${PLUGIN_NAME}/save`;
const SAVE_LOCK_TIMEOUT_MS = 30000;
const IDB_READWRITE = "readwrite";
const IDB_READONLY = "readonly";
const IDB_RELAXED = "relaxed";
const tryCreateHandleStore = async (wiki: TWWiki) => {
    if (!window.indexedDB) {
        const message = "Cannot save file handle across browser sessions because your browser does not support IndexedDB.";
        logDebug(message);
        return Promise.reject(message);
    } else if (!canUseIndexedDB(wiki)) {
        const message = "It is not secure to save sensitive data to IndexedDB when using the file:/ protocol.";
        logDebug(message);
        logDebug("This is a security issue because anything served via file:/ share a single origin in Chromium browsers.");
        logDebug("See https://bugs.chromium.org/p/chromium/issues/detail?id=1202597#c3 for details.")
        return Promise.reject(message);
    }

    logDebug("Browser supports IndexedDB so will attempt to create/retrieve a DB for storing a file handle.");
    return openHandleStore();
};

const openHandleStore = async () => {
    const dbOpenRequest = window.indexedDB.open(DB_NAME, DB_VERSION);

    dbOpenRequest.onupgradeneeded = event => {
        logDebug("Initializing file handle DB since received event %o", event);
        const db = dbOpenRequest.result;

        // Don't specify keyPath or autoIncrement so that keys are stored separately from values which lets
        // us store any kind of value.
        const store = db.createObjectStore(DB_HANDLE_OBJECT_STORE_NAME);

        logDebug("Successfully created store %o/%o", DB_NAME, DB_HANDLE_OBJECT_STORE_NAME);
        return store;
    };

    try {
        const db = await idbRequestToPromise(dbOpenRequest);
        logDebug("Successfully opened database for storing file handles %o.", db)
        // Otherwise an open connection blocks deleteDatabase (used by reset) in this or other tabs.
        db.onversionchange = () => {
            logDebug("File handle DB is being deleted or upgraded, closing connection.");
            db.close();
        };
        deleteLegacyHandles(db);
        return db;
    } catch (err) {
        logDebug("Could not open database for storing file handles: %o", err);
        throw err;
    }
};

// Remove handles stored by old versions, since nothing can use them but other pages on the same origin.
const deleteLegacyHandles = (db: IDBDatabase) => {
    try {
        const transaction = db.transaction([DB_HANDLE_OBJECT_STORE_NAME], IDB_READWRITE);
        getTransactionCommitPromise(transaction).catch(err => {
            logDebug("Could not delete legacy file handles: %o", err);
        });
        transaction.objectStore(DB_HANDLE_OBJECT_STORE_NAME)
            .delete(IDBKeyRange.bound(LEGACY_HANDLE_KEY_PREFIX, LEGACY_HANDLE_KEY_PREFIX + "\uffff"));
    } catch (err) {
        logDebug("Could not delete legacy file handles: %o", err);
    }
};

const requestFileHandle = async (startIn?: FileSystemHandle) => {
    for (let i = 0; i < 2; i++) {
        const result = await window.showSaveFilePicker({
            types: [{
                description: "HTML file",
                accept: {
                    "text/html": [
                        ".html",
                        ".htm"
                    ]
                }
            }],
            id: UNIQUE_PLUGIN_ID,
            startIn
        } as any);
        logDebug("Received file handle: %o", result)
        if (result.kind === "file") {
            return result;
        }
        alert("File input must be a file, not a directory.");
    }

    return await Promise.reject("Could not get file for saving.");
}

const requestDirectoryHandle = async (startIn?: FileSystemHandle) => {
    for (let i = 0; i < 2; i++) {
        const result = await window.showDirectoryPicker({
            id: UNIQUE_PLUGIN_ID,
            startIn
        } as any);
        logDebug("Received directory handle: %o", result)
        if (result.kind === "directory") {
            return result;
        }
        alert("File input must be a directory, not a file.");
    }

    return await Promise.reject("Could not get directory for saving.");
}

const getIndexedDBKey = async () => {
    // Ignore the fragment since TiddlyWiki changes it when navigating with permalinks.
    const url = new URL(window.location.href);
    url.hash = "";
    return HANDLE_KEY_PREFIX + (await hashToString(url.href));
}

interface IndexedDBCacheable<T> {
    requestNew(): Promise<T>;
    oldIsValid(old: any): old is T;
}

async function getCachedHandle<T extends FileSystemHandle>(wiki: TWWiki, cacheable: IndexedDBCacheable<T>): Promise<T> {
    let db: IDBDatabase;

    await pendingHandleRemoval;
    const storageKey = await getIndexedDBKey();
    logDebug("Computed storage key to be: [%s]", storageKey);

    try {
        db = await tryCreateHandleStore(wiki);
    } catch (err) {
        logDebug("Could not get handle store due to error, must request file location from user: %o", err);
        return await cacheable.requestNew();
    }

    const requestAndStoreNewFile = async () => {
        const handle = await cacheable.requestNew();

        logDebug("Saving handle %o to object store to avoid requests in the future", handle);
        // Don't await this and just let it execute in background since it isn't really that
        // important.
        try {
            // Have to get a new transaction because requestFileHandle puts us in a new event loop.
            const transaction = db.transaction([DB_HANDLE_OBJECT_STORE_NAME], IDB_READWRITE);
            const commitPromise = getTransactionCommitPromise(transaction);
            transaction.objectStore(DB_HANDLE_OBJECT_STORE_NAME).put(handle, storageKey);
            commitPromise.then(() => {
                logDebug("Successfully saved file handle %o to object store.", handle);
            }, err => {
                logDebug("Could not save file handle %o to object store (user will have to select file once they refresh): %o",
                    handle, err);
            });
        } catch (err) {
            logDebug("Failed to initate save request for file hande due to error: %o", err);
        }

        return handle;
    };

    try {
        const transaction = db.transaction([DB_HANDLE_OBJECT_STORE_NAME], IDB_READONLY);
        const store = transaction.objectStore(DB_HANDLE_OBJECT_STORE_NAME);
        const maybeFileHandle = await idbRequestToPromise(store.get(storageKey));
        if (!cacheable.oldIsValid(maybeFileHandle)) {
            logDebug("No existing file handle found, must request new one");
            return await requestAndStoreNewFile();
        }

        // Explicitly request permission to readwrite to avoid permissions issues later on.
        logDebug("Found a previous file handle so try to avoid duplicate requests to user for file location %o", maybeFileHandle);
        logDebug("Requesting permission for RW on file object.");
        const status = await maybeFileHandle.requestPermission({ mode: IDB_READWRITE }); // These strings happen to be the same for IDB and files.
        logDebug("Requesting permission for RW on file returned status: %o", status);
        if (status !== "granted") {
            throw Error(`RW on file was not granted, status of the permission is: [${status}]`);
        }
        logDebug("Successfully obtained RW permission on file system object.");

        return maybeFileHandle;
    } catch (err) {
        logDebug("Could not get previous handle, must request a new one due to error: %o", err);
        return await requestAndStoreNewFile();
    } finally {
        // Transactions already started still complete after close.
        db.close();
    }
}

const getFileHandle = (wiki: TWWiki, startHandle?: FileSystemHandle) => {
    function isFileHandle(obj: any): obj is FileSystemFileHandle {
        return obj && obj.kind === "file";
    }

    return getCachedHandle(wiki, {
        requestNew: () => requestFileHandle(startHandle),
        oldIsValid: isFileHandle
    });
}

const getDirectoryHandle = async (wiki: TWWiki, startHandle?: FileSystemHandle) => {
    function isDirectoryHandle(obj: any): obj is FileSystemDirectoryHandle {
        return obj && obj.kind === "directory"
    }

    return getCachedHandle(wiki, {
        requestNew: () => requestDirectoryHandle(startHandle),
        oldIsValid: isDirectoryHandle
    });
}

// Removes only this wiki's handle, since every wiki on file:// shares the database. This doesn't revoke
// permission the browser already granted to open pages.
const removeCachedHandle = async () => {
    if (!window.indexedDB) {
        return;
    }
    // Don't create the database just to remove something from it. databases() is missing from the
    // TypeScript 4.2 DOM types.
    const idbFactory = window.indexedDB as IDBFactory & { databases?(): Promise<{ name?: string }[]> };
    if (idbFactory.databases) {
        const databases = await idbFactory.databases();
        if (!databases.some(info => info.name === DB_NAME)) {
            return;
        }
    }

    const storageKey = await getIndexedDBKey();
    const db = await openHandleStore();
    try {
        const transaction = db.transaction([DB_HANDLE_OBJECT_STORE_NAME], IDB_READWRITE);
        const commitPromise = getTransactionCommitPromise(transaction);
        transaction.objectStore(DB_HANDLE_OBJECT_STORE_NAME).delete(storageKey);
        await commitPromise;
        logDebug("Removed cached file handle for this wiki.");
    } finally {
        db.close();
    }
};

// Handle lookups wait for this so that a save right after a reset can't read the old handle.
let pendingHandleRemoval: Promise<void> = Promise.resolve();

const removeCachedHandleInBackground = () => {
    pendingHandleRemoval = pendingHandleRemoval.then(removeCachedHandle).catch(err => {
        logDebug("Failed to remove cached file handle: %o", err);
    });
};

// Other tabs have their own FileSystemSaver, so they need a lock shared between tabs to avoid both
// passing the consistency check before either one writes. Gives up rather than waiting forever, e.g.
// while another tab asks whether to overwrite.
function withSaveLock<T>(callback: () => Promise<T>): Promise<T> {
    const locks = (navigator as any).locks;
    if (!locks) {
        logDebug("Web Locks API not available, saving without a lock.");
        return callback();
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), SAVE_LOCK_TIMEOUT_MS);
    // Errors after the lock is granted come from the save itself, and mustn't cause a second attempt.
    let granted = false;
    const saveWithoutLock = (err: unknown) => {
        window.clearTimeout(timeout);
        logDebug("Browser refused the save lock (%o), saving without it.", err);
        return callback();
    };

    let lockRequest: Promise<T>;
    try {
        lockRequest = locks.request(SAVE_LOCK_NAME, { signal: controller.signal }, () => {
            granted = true;
            window.clearTimeout(timeout);
            return callback();
        });
    } catch (err) {
        if (isSecurityError(err)) {
            return saveWithoutLock(err);
        }
        window.clearTimeout(timeout);
        throw err;
    }

    return lockRequest.catch((err: unknown) => {
        if (granted) {
            throw err;
        }
        if (controller.signal.aborted) {
            throw "Timed out waiting for another tab to finish saving (it may be asking whether to overwrite " +
                "the file). Nothing was saved";
        }
        // E.g. the page has an opaque origin, such as in a sandboxed iframe.
        if (isSecurityError(err)) {
            return saveWithoutLock(err);
        }
        window.clearTimeout(timeout);
        throw err;
    });
}

function isSecurityError(err: unknown): boolean {
    return !!err && (err as { name?: unknown }).name === "SecurityError";
}

function getCoreSaverHandler(): TWSaverHandlerInternals | undefined {
    const tw = (window as any).$tw;
    const handler = tw && tw.saverHandler;
    if (handler && typeof handler.numChanges === "number" && typeof handler.updateDirtyStatus === "function"
            && typeof handler.filterFn === "function") {
        return handler;
    }
    return undefined;
}

// Returns a string hash in hex for easy comparison and printing.
async function hashToString(data: string | ArrayBuffer): Promise<string> {
    let buffer: ArrayBuffer;
    if (typeof data === "string") {
        const encoder = new TextEncoder();
        buffer = encoder.encode(data);
    } else {
        buffer = data;
    }

    // Adapted from example at https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest
    const hashBytes = await window.crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBytes));
    return hashArray.map(byte => byte.toString(16).padStart(2, "0")).join("");
}

// Only replaces what the File System Access API rejects. Changing anything else would make existing
// wikis start saving to a different file. Callers trim names the user typed, but not the opened file's.
function sanitizeFileName(name: string): string {
    const result = name.replace(/[/\\]/g, "_");
    return (result === "" || result === "." || result === "..") ? DEFAULT_WIKI_FILENAME : result;
}

// The name of the file this page was loaded from, if it was loaded from the file system.
function getLoadedFileName(): string | undefined {
    try {
        if (window.location.protocol !== "file:") {
            return undefined;
        }
        // Not trimmed, since spaces are part of the real file name.
        const name = decodeURIComponent(window.location.pathname.split("/").pop() || "");
        return name.trim() === "" ? undefined : name;
    } catch (err) {
        logDebug("Could not get the name of the file this page was loaded from: %o", err);
        return undefined;
    }
}

function getExplicitWikiFileName(wiki: TWWiki): string | undefined {
    const explicitName = wiki.getTiddler(PLUGIN_SETTINGS_DATA)!.getFieldString(WIKI_FILENAME_FIELD);
    return explicitName && explicitName.trim() !== "" ? sanitizeFileName(explicitName.trim()) : undefined;
}

// The file name used when the setting is empty. The caller works this out once per session, so that
// renaming the wiki (which changes the fallback) doesn't switch saving to another, empty file.
function getDefaultWikiFileName(wiki: TWWiki): string {
    // Prefer the file the user opened, which also stays the same across sessions.
    const loadedFileName = getLoadedFileName();

    if (loadedFileName) {
        return sanitizeFileName(loadedFileName);
    } else {
        const wikiButtonFilename = wiki.getTiddler("$:/config/SaveWikiButton/Filename");
        const siteTitle = wiki.getTiddler("$:/SiteTitle");

        if (wikiButtonFilename) {
            return sanitizeFileName(wikiButtonFilename.getFieldString("text").trim());
        } else if (siteTitle) {
            return sanitizeFileName(`${siteTitle.getFieldString("text").trim()}.html`);
        } else {
            return DEFAULT_WIKI_FILENAME;
        }
    }
}

interface FileContents {
    size: number;
    lastModified: number;
    text: string;
    hash: string;
}

async function readContents(handle: FileSystemFileHandle): Promise<FileContents> {
    const file = await handle.getFile();
    const text = await file.text();
    return { size: file.size, lastModified: file.lastModified, text, hash: await hashToString(text) };
}

// Backups are named by the hash of their text, so the same version is only stored once.
async function writeBackup(backupDir: FileSystemDirectoryHandle, text: string, textHash: string, skipIfExists: boolean) {
    const backupFileName = `${textHash}.html`;
    if (skipIfExists) {
        try {
            const existing = await (await backupDir.getFileHandle(backupFileName)).getFile();
            // A failed write can leave an empty or partial file behind, which isn't a backup.
            if (await hashToString(await existing.text()) === textHash) {
                logDebug("Backup %o already exists", backupFileName);
                return;
            }
            logDebug("Backup %o is incomplete, writing it again", backupFileName);
        } catch (err) {
            if (!err || (err as { name?: unknown }).name !== "NotFoundError") {
                throw err;
            }
        }
    }
    logDebug("Backing up wiki file to %o", backupFileName);
    const backupFile = await backupDir.getFileHandle(backupFileName, {
        create: true
    });
    await writeFile(backupFile, text);
}

async function writeFile(handle: FileSystemFileHandle, text: string) {
    const writable = await handle.createWritable();
    try {
        await writable.write(text);
    } catch (err) {
        // Closing would commit a partially written file, so throw away the changes instead.
        try {
            await writable.abort();
        } catch (abortErr) {
            logDebug("Could not abort writing file: %o", abortErr);
        }
        throw err;
    }
    await writable.close();
}

// The handles for one save location, captured when a save starts so that a reset or style change
// doesn't affect saves which are already queued.
interface SaveRequest {
    target: SaveTarget;
    doSave(): Promise<void>;
    callback: TWSaverCB;
    changesIncluded: Promise<number | undefined>;
    // True if this or a save it replaced was a manual save.
    manual: boolean;
}

interface SaveTarget {
    style: SaverStyle;
    // The wiki file name inside the directory, for backup style.
    fileName?: string;
    // Set when the file name changed this session, until the first save to it. The new name may be
    // another existing wiki, which the consistency check would let us overwrite since it was saved before
    // this page loaded.
    confirmReplace?: boolean;
    wikiFile: Promise<FileSystemFileHandle>;
    dirHandle?: Promise<FileSystemDirectoryHandle>;
}

class FileSystemSaver implements TWSaver {
    public info: SaverInfo = {
        name: PLUGIN_NAME,
        priority: 100000,
        capabilities: [SaverCapability.Save, SaverCapability.AutoSave]
    };
    private target?: SaveTarget;
    // Hash of the last text this page successfully wrote, and the file it was written to.
    private prevPageHash?: string;
    private prevWikiFile?: Promise<FileSystemFileHandle>;
    // TiddlyWiki doesn't wait for one save to finish before starting the next, so saves are chained.
    private saveQueue: Promise<void> = Promise.resolve();
    // The newest save waiting for earlier ones to finish. A newer save to the same target replaces its
    // contents, since the newer text includes its changes and each request holds a full copy of the wiki.
    private pendingSave?: SaveRequest;
    // Every change counted the way TiddlyWiki counts unsaved changes, but never reset. TiddlyWiki's own
    // count can't be used for this, since other savers (e.g. while this one is disabled) reset it.
    private totalChanges = 0;
    // Set when the user declines to overwrite a changed file, until their next manual save.
    private autosaveSuspended = false;
    // See getDefaultWikiFileName.
    private defaultWikiFileName: string;
    // The hash of the last text this page wrote to each wiki file name. A file still holding it hasn't been
    // changed by anyone else since. Older versions don't count, since the user may have restored one.
    private lastWrittenHashes = new Map<string, string>();
    // Counts overwrite questions, so a save knows to read the file again after one (see saveFile).
    private questionsAsked = 0;

    constructor(private wiki: TWWiki) {
        setupLogging(wiki);
        logDebug("Constructing a FileSystemSaver");
        this.defaultWikiFileName = getDefaultWikiFileName(wiki);
        wiki.addEventListener("change", changes => {
            const handler = getCoreSaverHandler();
            if (handler) {
                this.totalChanges += handler.filterFn(iterator => {
                    Object.keys(changes).forEach(title => iterator(wiki.getTiddler(title), title));
                }).length;
            }
        });
    }

    // Must be called synchronously from save so that the browser allows showing file pickers.
    userInteractionInit(saverStyle: SaverStyle): SaveTarget {
        const fileName = saverStyle === SaverStyle.SingleFile
            ? undefined
            : getExplicitWikiFileName(this.wiki) || this.defaultWikiFileName;
        const current = this.target;
        if (current && current.style === saverStyle && current.fileName === fileName) {
            return current;
        }

        let target: SaveTarget;
        if (saverStyle === SaverStyle.SingleFile) {
            logDebug("Attempting to get file handle.");

            target = {
                style: saverStyle,
                wikiFile: getFileHandle(this.wiki)
            };
        } else {
            // If only the file name setting changed, reuse the directory, which also needs no picker.
            const dirHandle = current && current.style === saverStyle ? current.dirHandle! : getDirectoryHandle(this.wiki);
            logDebug("Using directory handle for wiki file: %o", fileName);
            target = {
                style: saverStyle,
                fileName,
                confirmReplace: !!current && current.style === saverStyle,
                dirHandle,
                wikiFile: dirHandle.then(actualDirHandle => actualDirHandle.getFileHandle(fileName!, {
                    create: true
                }))
            };
        }

        target.wikiFile.catch(err => {
            logDebug("Could not get file handle due to error: %o", err);
            // Forget the failed request so that the next save asks again.
            if (this.target === target) {
                this.target = undefined;
            }
        });

        this.target = target;
        return target;
    }

    async checkConsistency(wikiFile: Promise<FileSystemFileHandle>, readCurrent: () => Promise<FileContents>) {
        logDebug("Reading current value to check consistency");
        const file = await readCurrent();

        // Also covers a file this page saved before a rename (and its text includes that version).
        if (this.lastWrittenHashes.get((await wikiFile).name) === file.hash) {
            logDebug("File holds what this page last wrote to it, so saving is safe");
            return;
        }

        if (this.prevWikiFile === wikiFile) {
            logDebug("Expected hash to be [%s] but it is currently [%s]", this.prevPageHash, file.hash);
            return this.confirmOverwrite("The wiki file no longer contains what this page last saved");
        }

        // This is the first save to this file, so check the file wasn't saved after this page loaded. This
        // applies even to a file the user just picked, since they will usually re-pick the wiki's own file,
        // which another tab may have saved since.
        if (file.size === 0) {
            logDebug("File is empty, so saving is safe");
        } else if (file.lastModified > performance.timeOrigin) {
            logDebug("File was modified at %o which is after page load at %o", file.lastModified, performance.timeOrigin);
            return this.confirmOverwrite("The wiki file was modified after this page was loaded");
        }
    }

    // Lets the user explicitly overwrite a file which was changed elsewhere, rejecting if they decline.
    confirmOverwrite(problem: string): Promise<void> {
        return this.askToOverwrite(`${problem}, maybe by another tab or program.\n\n` +
            "Overwrite it anyway? Any changes made there will be lost.\n\n" +
            "If you cancel, nothing is saved and autosave pauses until you save manually. Reloading the page " +
            "would load the other changes but discard this page's unsaved changes.", problem);
    }

    // Asks before the first save to a file name changed this session. Returns true if the user agreed to
    // replace the file's current contents. The caller clears target.confirmReplace once the write succeeds,
    // so a failed save asks again.
    async confirmReplace(handle: FileSystemFileHandle, readCurrent: () => Promise<FileContents>): Promise<boolean> {
        const file = await readCurrent();
        const isOurs = file.size === 0 || this.lastWrittenHashes.get(handle.name) === file.hash;
        if (!isOurs) {
            const problem = `"${handle.name}" already exists and wasn't saved by this page`;
            await this.askToOverwrite(`${problem}. It may be a different wiki.\n\n` +
                "Replace it with this wiki? Its current contents are kept in the backups folder.\n\n" +
                "If you cancel, nothing is saved and autosave pauses until you save manually. You can change " +
                "the wiki file name in the saver settings.", problem);
        }
        return !isOurs;
    }

    askToOverwrite(message: string, problem: string): Promise<void> {
        this.questionsAsked++;
        if (window.confirm(message)) {
            logDebug("User chose to overwrite the file");
            return Promise.resolve();
        }
        // Otherwise every autosave would ask again.
        this.autosaveSuspended = true;
        return Promise.reject(`${problem}. Nothing was saved`);
    }

    shouldCheckConsistency() {
        return this.wiki.getTiddler(PLUGIN_SETTINGS_DATA)!.getFieldString(CHECK_CONSISTENCY_FIELD) === YES;
    }

    // beforeWrite runs once the checks have passed, just before the wiki file is overwritten. It gets the
    // file's current contents (read at most once per save) and the hash of the new text.
    async saveFile(target: SaveTarget, text: string,
            beforeWrite?: (readCurrent: () => Promise<FileContents>, textHash: string) => Promise<void>) {
        const wikiFile = target.wikiFile;
        const handle = await wikiFile;
        const textHashProm = hashToString(text);

        await withSaveLock(async () => {
            let current: Promise<FileContents> | undefined;
            const readCurrent = () => current || (current = readContents(handle));
            const questionsBefore = this.questionsAsked;

            // Done regardless of the consistency setting, since this is about replacing a different file.
            const userAgreedToReplace = target.confirmReplace ? await this.confirmReplace(handle, readCurrent) : false;
            if (userAgreedToReplace) {
                logDebug("Skipping consistency check since the user agreed to replace the file");
            } else if (this.shouldCheckConsistency()) {
                await this.checkConsistency(wikiFile, readCurrent);
            } else {
                logDebug("Skipping consistency check");
            }

            if (this.questionsAsked !== questionsBefore) {
                // The file may have changed while the question was open, so back up what is there now.
                current = undefined;
            }
            if (beforeWrite) {
                await beforeWrite(readCurrent, await textHashProm);
            }

            logDebug("Writing wiki file...");
            await writeFile(handle, text);
            logDebug("Wrote wiki file successfully");
            target.confirmReplace = false;
        });

        // Only remember the new hash once the file actually contains this text.
        this.prevPageHash = await textHashProm;
        this.prevWikiFile = wikiFile;
        this.lastWrittenHashes.set(handle.name, this.prevPageHash);
    }

    async saveBackup(target: SaveTarget, text: string, textHash: string, readCurrent: () => Promise<FileContents>) {
        const dirHandle = await target.dirHandle!;
        const wikiFileHandle = await target.wikiFile;
        const backupDir = await dirHandle.getDirectoryHandle(BACKUP_FOLDER_NAME, {
            create: true
        });
        const wikiBackupDir = await backupDir.getDirectoryHandle(wikiFileHandle.name, {
            create: true
        });

        // Also keep what is in the file now, which may not be from this page (e.g. the user agreed to
        // overwrite another tab's changes or to replace another file). Not needed if it still holds what
        // this page last wrote to it, since that save also wrote its backup.
        const current = await readCurrent();
        const unchangedSinceOurSave = this.prevWikiFile === target.wikiFile && current.hash === this.prevPageHash;
        if (current.size > 0 && !unchangedSinceOurSave) {
            await writeBackup(wikiBackupDir, current.text, current.hash, true);
        }
        await writeBackup(wikiBackupDir, text, textHash, false);
        logDebug("Wrote backup successfully");
    }

    async saveWithDirBackup(target: SaveTarget, text: string) {
        // Write the backup only if the user didn't decline overwriting a changed file, but before the wiki
        // file since the backup doesn't overwrite anything.
        await this.saveFile(target, text, (readCurrent, textHash) => this.saveBackup(target, text, textHash, readCurrent));
    }

    save(text: string, method: SaverCapability, callback: TWSaverCB) {
        setupLogging(this.wiki);
        if (!isEnabled(this.wiki)) {
            logDebug("Not saving since this saver is not enabled.");
            return false;
        }

        const saverStyle = getSaverStyle(this.wiki);
        if (method === SaverCapability.AutoSave && (!this.target || this.target.style !== saverStyle || this.autosaveSuspended)) {
            // Browsers only allow file pickers and permission prompts in response to a click, and after a
            // declined overwrite we wait for the user. Claim the save without calling back so the wiki stays
            // dirty and other savers don't take over.
            logDebug("Skipping autosave until the user saves manually.");
            return true;
        }

        logDebug("Saving with method %o", method);
        if (method === SaverCapability.Save) {
            this.autosaveSuspended = false;
        }
        const target = this.userInteractionInit(saverStyle);

        let doSave: () => Promise<void>;
        switch (saverStyle) {
            case SaverStyle.SingleFile:
                doSave = () => this.saveFile(target, text);
                break;
            case SaverStyle.SingleFileVersionBackup:
                doSave = () => this.saveWithDirBackup(target, text);
                break;
            default:
                logDebug("Unsupported SaverStyle: [%s]", saverStyle);
                return false;
        }

        const isManual = method === SaverCapability.Save;
        const changesIncluded = this.snapshotIncludedChanges();
        const pending = this.pendingSave;
        if (pending && pending.target === target) {
            // The old callback is never called, the newer save reports for both. Saves to a different target
            // (after a reset or style change) aren't replaced, since that file wouldn't get its save.
            logDebug("Replaced a save which was still waiting with this newer one");
            pending.doSave = doSave;
            pending.callback = callback;
            pending.changesIncluded = changesIncluded;
            pending.manual = pending.manual || isManual;
        } else {
            const request: SaveRequest = { target, doSave, callback, changesIncluded, manual: isManual };
            this.pendingSave = request;
            // Catch so that an unexpected error can't stop all later saves.
            this.saveQueue = this.saveQueue.then(() => this.runSave(request)).catch(err => {
                console.error("Unexpected error while saving: %o", err);
            });
        }

        return true;
    }

    async runSave(request: SaveRequest) {
        if (this.pendingSave === request) {
            this.pendingSave = undefined;
        }

        if (request.manual) {
            // The user may have declined an overwrite after clicking save, while this was waiting.
            this.autosaveSuspended = false;
        } else if (this.autosaveSuspended) {
            // Checked here too since the user may decline an overwrite while this save is waiting.
            // Like a skipped autosave, don't call back so the wiki stays dirty.
            logDebug("Skipped autosave since the user declined to overwrite a changed file");
            return;
        }

        try {
            await request.doSave();
        } catch (err) {
            logDebug("Encountered error while saving: %o", err);
            request.callback(`Encountered error while saving to file system: [${err}]`);
            return;
        }
        logDebug("Successfully saved to file system");
        this.markSaved(await request.changesIncluded, request.callback);
    }

    // Works out how many changes the text being saved includes, as a total comparable with getTotalChanges.
    // TiddlyWiki counts changes in batches, in a setTimeout after they are made, so changes made just
    // before this save (e.g. by the same button) are queued but not counted yet. They are in the text, but
    // changes queued after this save in the same batch aren't.
    snapshotIncludedChanges(): Promise<number | undefined> {
        const handler = getCoreSaverHandler();
        const totalChanges = this.getTotalChanges();
        if (!handler || totalChanges === undefined || typeof this.wiki.getChangeCount !== "function") {
            return Promise.resolve(totalChanges);
        }

        const queuedTitles = Object.keys(this.wiki.changedTiddlers || {});
        const queuedChanges = handler.filterFn(iterator => {
            queuedTitles.forEach(title => iterator(this.wiki.getTiddler(title), title));
        });
        const changeCounts = queuedChanges.map(title => this.wiki.getChangeCount(title));

        return new Promise(resolve => {
            // This runs after the batch is counted, since that setTimeout was started first.
            window.setTimeout(() => {
                // A batch counts each tiddler once, so a queued tiddler changed again after this save would
                // look saved.
                const changedAgain = queuedChanges.filter((title, i) => this.wiki.getChangeCount(title) > changeCounts[i]);
                resolve(totalChanges + queuedChanges.length - changedAgain.length);
            }, 0);
        });
    }

    getTotalChanges(): number | undefined {
        return getCoreSaverHandler() ? this.totalChanges : undefined;
    }

    // TiddlyWiki's callback marks every change as saved, including ones made after this save's text was
    // rendered (which may be waiting for a later save that could still fail), so mark those unsaved again.
    markSaved(changesIncluded: number | undefined, callback: TWSaverCB) {
        const handler = getCoreSaverHandler();
        const totalChanges = this.getTotalChanges();
        if (!handler || changesIncluded === undefined || totalChanges === undefined) {
            callback(null);
            return;
        }

        // Both counts are changes made since some point: this save's text, and the last save by any saver
        // (which may be a later save by another saver). Only changes after both are still unsaved.
        const unsavedChanges = Math.min(Math.max(0, totalChanges - changesIncluded), handler.numChanges);
        callback(null);
        if (unsavedChanges > 0 && handler.numChanges < unsavedChanges) {
            logDebug("%o changes were made after this save started, keeping them unsaved", unsavedChanges);
            handler.numChanges = unsavedChanges;
            handler.updateDirtyStatus();
        }
    }

    reset() {
        logDebug("Reseting file saver...");
        removeCachedHandleInBackground();
        setupLogging(this.wiki);
        this.target = undefined;
        this.autosaveSuspended = false;
        logDebug("Reset file save location.");
    }
}

let handleCleanupRegistered = false;

// Don't leave a handle readable by other pages once storing it is disallowed. This must run even when
// the saver is disabled, so it is set up from canSave, which TiddlyWiki calls once at startup.
const registerHandleCleanup = (wiki: TWWiki) => {
    if (handleCleanupRegistered) {
        return;
    }
    handleCleanupRegistered = true;

    if (!canUseIndexedDB(wiki)) {
        removeCachedHandleInBackground();
    }
    wiki.addEventListener("change", changes => {
        if (changes[PLUGIN_SETTINGS_DATA] && !canUseIndexedDB(wiki)) {
            removeCachedHandleInBackground();
        }
    });
};

// Has one parameter, wiki if necessary
const canSave = (handler: SaverHandler) => {
    try {
        setupLogging(handler.wiki);
        registerHandleCleanup(handler.wiki);
        // Don't check isEnabled here: core only calls canSave at startup, so the saver couldn't be enabled
        // later without a reload. save() returns false while it is disabled, so other savers are used.
        return (!!window.showSaveFilePicker) && window.isSecureContext;
    } catch(err) {
        logDebug(err);
        return false;
    }
};

let currentSaver: FileSystemSaver | null = null;

// Also has access to wiki if necessary
const create = (wiki: TWWiki) => {
    const result = new FileSystemSaver(wiki);
    currentSaver = result;

    // Wait one event cycle before trying to show the welcome page.
    window.setTimeout(() => {
        if (isEnabled(wiki) && wiki.getTiddler(PLUGIN_SETTINGS_DATA)!.getFieldString(SHOW_WELCOME_MODAL_FIELD) === YES) {
            logDebug("Showing welcome modal.");
            const modal = (window as any).$tw.modal as TWModalManager;
            modal.display(WELCOME_PAGE);
        } else {
            logDebug("Not showing welcome modal since it or the saver is not enabled.");
        }
    }, 0);

    return result;
};

// Works even if the saver was never created (e.g. it was disabled at startup).
const reset = () => {
    if (currentSaver) {
        currentSaver.reset();
    } else {
        removeCachedHandleInBackground();
    }
};

module.exports = {
    canSave,
    create,
    reset,
    getCurrentSaver: () => currentSaver
};
