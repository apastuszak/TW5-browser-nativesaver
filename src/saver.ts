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
    modal: TWModalManager;
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
const CURRENT_FILE_HANDLE_NAME = "CURRENT_FILE_HANDLE";
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
        return db;
    } catch (err) {
        logDebug("Could not open database for storing file handles: %o", err);
        throw err;
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
    return CURRENT_FILE_HANDLE_NAME + (await hashToString(url.href));
}

interface IndexedDBCacheable<T> {
    requestNew(): Promise<T>;
    oldIsValid(old: any): old is T;
}

interface CachedHandle<T> {
    handle: T;
    // True if the user just picked this handle rather than it coming from IndexedDB.
    isNew: boolean;
}

async function getCachedHandle<T extends FileSystemHandle>(wiki: TWWiki, cacheable: IndexedDBCacheable<T>): Promise<CachedHandle<T>> {
    let db: IDBDatabase;

    const storageKey = await getIndexedDBKey();
    logDebug("Computed storage key to be: [%s]", storageKey);

    try {
        db = await tryCreateHandleStore(wiki);
    } catch (err) {
        logDebug("Could not get handle store due to error, must request file location from user: %o", err);
        return { handle: await cacheable.requestNew(), isNew: true };
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

        return { handle, isNew: true };
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

        return { handle: maybeFileHandle, isNew: false };
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

const deleteHandleStore = () => {
    try {
        window.indexedDB.deleteDatabase(DB_NAME);
    } catch(err) {
        logDebug("Failed to delete file save location: %o", err);
    }
};

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
// wikis start saving to a different file.
function sanitizeFileName(name: string): string {
    const result = name.replace(/[/\\]/g, "_").trim();
    return (result === "" || result === "." || result === "..") ? DEFAULT_WIKI_FILENAME : result;
}

async function getWikiFileName(wiki: TWWiki): Promise<string> {
    const explicitName = wiki.getTiddler(PLUGIN_SETTINGS_DATA)!.getFieldString(WIKI_FILENAME_FIELD);

    if (!explicitName || explicitName.trim() === "") {
        const wikiButtonFilename = wiki.getTiddler("$:/config/SaveWikiButton/Filename");
        const siteTitle = wiki.getTiddler("$:/SiteTitle");

        if (wikiButtonFilename) {
            return sanitizeFileName(wikiButtonFilename.getFieldString("text"));
        } else if (siteTitle) {
            return sanitizeFileName(`${siteTitle.getFieldString("text").trim()}.html`);
        } else {
            return DEFAULT_WIKI_FILENAME;
        }
    } else {
        return sanitizeFileName(explicitName);
    }
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

// Lets the user explicitly overwrite a file which was changed elsewhere, rejecting if they decline.
function confirmOverwrite(problem: string): Promise<void> {
    const message = `${problem}, maybe by another tab or program.\n\n` +
        "Overwrite it anyway? Any changes made there will be lost. Cancel and reload the page to keep them.";
    if (window.confirm(message)) {
        logDebug("User chose to overwrite the changed file");
        return Promise.resolve();
    }
    return Promise.reject(`${problem}. Reload the page to get the latest version before saving`);
}

interface WikiFile {
    handle: FileSystemFileHandle;
    // True if the user picked this exact file this session, confirming it may be overwritten.
    pickedByUser: boolean;
}

// The handles for one save location, captured when a save starts so that a reset or style change
// doesn't affect saves which are already queued.
interface SaveTarget {
    style: SaverStyle;
    wikiFile: Promise<WikiFile>;
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
    private prevWikiFile?: Promise<WikiFile>;
    // TiddlyWiki doesn't wait for one save to finish before starting the next, so saves are chained.
    private saveQueue: Promise<void> = Promise.resolve();

    constructor(private wiki: TWWiki) {
        setupLogging(wiki);
        logDebug("Constructing a FileSystemSaver");
    }

    // Must be called synchronously from save so that the browser allows showing file pickers.
    userInteractionInit(saverStyle: SaverStyle): SaveTarget {
        if (this.target && this.target.style === saverStyle) {
            return this.target;
        }

        let target: SaveTarget;
        if (saverStyle === SaverStyle.SingleFile) {
            logDebug("Attempting to get file handle.");

            target = {
                style: saverStyle,
                wikiFile: getFileHandle(this.wiki).then(cached => ({
                    handle: cached.handle,
                    pickedByUser: cached.isNew
                }))
            };
        } else {
            logDebug("Attempting to get directory handle.");

            const dirHandle = getDirectoryHandle(this.wiki).then(cached => cached.handle);
            target = {
                style: saverStyle,
                dirHandle,
                wikiFile: dirHandle.then(async actualDirHandle => {
                    const wikiFileName = await getWikiFileName(this.wiki);
                    logDebug("Filename of wiki is: %o", wikiFileName);
                    const handle = await actualDirHandle.getFileHandle(wikiFileName, {
                        create: true
                    });
                    return { handle, pickedByUser: false };
                })
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

    async checkConsistency(wikiFile: Promise<WikiFile>) {
        const { handle, pickedByUser } = await wikiFile;
        logDebug("Reading current value to check consistency");
        const file = await handle.getFile();

        if (this.prevPageHash !== undefined) {
            const currentHash = await hashToString(await file.text());
            if (currentHash === this.prevPageHash) {
                logDebug("Previous value matches the current value so saving is safe");
                return;
            }

            if (this.prevWikiFile === wikiFile) {
                logDebug("Expected hash to be [%s] but it is currently [%s]", this.prevPageHash, currentHash);
                return confirmOverwrite("The wiki file no longer contains what this page last saved");
            }
        }

        // This is the first save to this file, so check the file wasn't saved after this page loaded.
        if (pickedByUser) {
            logDebug("User picked this file, so overwriting it is expected");
        } else if (file.size === 0) {
            logDebug("File is empty, so saving is safe");
        } else if (file.lastModified > performance.timeOrigin) {
            logDebug("File was modified at %o which is after page load at %o", file.lastModified, performance.timeOrigin);
            return confirmOverwrite("The wiki file was modified after this page was loaded");
        }
    }

    shouldCheckConsistency() {
        return this.wiki.getTiddler(PLUGIN_SETTINGS_DATA)!.getFieldString(CHECK_CONSISTENCY_FIELD) === YES;
    }

    async saveFile(wikiFile: Promise<WikiFile>, text: string) {
        const { handle } = await wikiFile;
        const textHashProm = hashToString(text);

        if (this.shouldCheckConsistency()) {
            await this.checkConsistency(wikiFile);
        } else {
            logDebug("Skipping consistency check");
        }

        logDebug("Writing wiki file...");
        await writeFile(handle, text);
        logDebug("Wrote wiki file successfully");

        // Only remember the new hash once the file actually contains this text.
        this.prevPageHash = await textHashProm;
        this.prevWikiFile = wikiFile;
    }

    async saveBackup(target: SaveTarget, text: string) {
        const textHashProm = hashToString(text);
        const dirHandle = await target.dirHandle!;
        const backupDir = await dirHandle.getDirectoryHandle(BACKUP_FOLDER_NAME, {
            create: true
        });
        const wikiFileName = (await target.wikiFile).handle.name;
        const wikiBackupDir = await backupDir.getDirectoryHandle(wikiFileName, {
            create: true
        });

        const textHash = await textHashProm;
        const backupFileName = `${textHash}.html`;
        logDebug("Backing up wiki file to %o", backupFileName);
        const backupFile = await wikiBackupDir.getFileHandle(backupFileName, {
            create: true
        });

        await writeFile(backupFile, text);
        logDebug("Wrote backup successfully");
    }

    async saveWithDirBackup(target: SaveTarget, text: string) {
        // Save to the backup folder first since that doesn't overwrite anything.
        await this.saveBackup(target, text);
        await this.saveFile(target.wikiFile, text);
    }

    save(text: string, method: SaverCapability, callback: TWSaverCB) {
        setupLogging(this.wiki);
        if (!isEnabled(this.wiki)) {
            logDebug("Not saving since this saver is not enabled.");
            return false;
        }

        const saverStyle = getSaverStyle(this.wiki);
        if (method === SaverCapability.AutoSave && (!this.target || this.target.style !== saverStyle)) {
            // Browsers only allow file pickers and permission prompts in response to a click. Claim the
            // save without calling back so the wiki stays dirty and other savers don't take over.
            logDebug("Skipping autosave until the save location is set up by a manual save.");
            return true;
        }

        logDebug("Saving with method %o", method);
        const target = this.userInteractionInit(saverStyle);

        let doSave: () => Promise<void>;
        switch (saverStyle) {
            case SaverStyle.SingleFile:
                doSave = () => this.saveFile(target.wikiFile, text);
                break;
            case SaverStyle.SingleFileVersionBackup:
                doSave = () => this.saveWithDirBackup(target, text);
                break;
            default:
                logDebug("Unsupported SaverStyle: [%s]", saverStyle);
                return false;
        }

        const savePromise = this.saveQueue.then(doSave);
        // Keep the queue going even if this save fails.
        this.saveQueue = savePromise.catch(() => {});

        savePromise.then(() => {
            logDebug("Successfully saved to file system");
            callback(null);
        }, err => {
            logDebug("Encountered error while saving: %o", err);
            callback(`Encountered error while saving to file system: [${err}]`);
        });

        return true;
    }

    reset() {
        logDebug("Reseting file saver...");
        deleteHandleStore();
        setupLogging(this.wiki);
        this.target = undefined;
        logDebug("Reset file save location.");
    }
}

// Has one parameter, wiki if necessary
const canSave = (handler: SaverHandler) => {
    try {
        setupLogging(handler.wiki);
        return isEnabled(handler.wiki) && (!!window.showSaveFilePicker) && window.isSecureContext;
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
        if (wiki.getTiddler(PLUGIN_SETTINGS_DATA)!.getFieldString(SHOW_WELCOME_MODAL_FIELD) === YES) {
            logDebug("Showing welcome modal.");
            const modal = (window as any).$tw.modal as TWModalManager;
            modal.display(WELCOME_PAGE);
        } else {
            logDebug("Not showing welcome modal since it is not enabled.");
        }
    }, 0);

    return result;
};

// Works even if the saver was never created (e.g. it was disabled at startup).
const reset = () => {
    if (currentSaver) {
        currentSaver.reset();
    } else {
        deleteHandleStore();
    }
};

module.exports = {
    canSave,
    create,
    reset,
    getCurrentSaver: () => currentSaver
};
