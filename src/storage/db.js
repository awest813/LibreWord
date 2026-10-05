import { openDB } from 'idb';

/**
 * Documents are split across two object stores:
 *   meta    – small records used by the document list (title, dates, preview…)
 *   content – the full editor JSON / HTML and per-document settings
 *   versions – periodic snapshots for version history
 * so the start screen never has to load every document body.
 */
const DB_NAME = 'libreword';
const DB_VERSION = 3;
const MAX_VERSIONS = 40;

export const DEFAULT_SETTINGS = Object.freeze({
  pageSize: 'letter',
  orientation: 'portrait',
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
  header: '',
  footer: '',
  pageNumbers: false,
});

export const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

const htmlToText = (html = '') => {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  // Keep words apart where lines and blocks meet ("Name<br>Street" → "Name Street").
  doc.body.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
  doc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th, div').forEach((el) => el.append(' '));
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
};

let dbPromise;

const notify = (type) => globalThis.dispatchEvent?.(new CustomEvent(type));

export const getDb = () => {
  if (!dbPromise) {
    const forget = () => {
      if (dbPromise === opening) dbPromise = null;
    };
    const opening = openDB(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains('meta')) {
          const meta = db.createObjectStore('meta', { keyPath: 'id' });
          meta.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('content')) {
          db.createObjectStore('content', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('versions')) {
          const versions = db.createObjectStore('versions', { keyPath: 'vid', autoIncrement: true });
          versions.createIndex('docId', 'docId');
        }

        // v1 (the original Quill-based LibreWord) kept HTML in a single
        // auto-increment "documents" store. Carry those documents over.
        if (oldVersion >= 1 && db.objectStoreNames.contains('documents')) {
          const legacy = tx.objectStore('documents');
          const docs = await legacy.getAll();
          for (const doc of docs) {
            const id = `legacy-${doc.id}`;
            const text = htmlToText(doc.content);
            await tx.objectStore('meta').put({
              id,
              title: doc.title || 'Untitled document',
              createdAt: doc.createdAt || Date.now(),
              updatedAt: doc.updatedAt || Date.now(),
              preview: text.slice(0, 280),
              words: text ? text.split(/\s+/).length : 0,
            });
            await tx.objectStore('content').put({
              id,
              html: doc.content || '',
              json: null,
              settings: { ...DEFAULT_SETTINGS },
            });
          }
          db.deleteObjectStore('documents');
        }
      },
      blocked() {
        // An older tab is holding the database open and won't let go.
        notify('libreword:db-blocked');
      },
      blocking() {
        // Another tab (a newer version) wants to upgrade; get out of its way.
        // This tab can no longer reopen the database, so it needs a reload.
        opening.then((db) => db.close()).catch(() => {});
        forget();
        notify('libreword:db-outdated');
      },
      terminated() {
        // The browser closed the connection (e.g. site data cleared): reopen on next use.
        forget();
      },
    });
    dbPromise = opening;
    // Never cache a failed open: let the next call retry.
    opening.catch(forget);
  }
  return dbPromise;
};

export async function listDocs() {
  const db = await getDb();
  const docs = await db.getAll('meta');
  return docs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDocMeta(id) {
  const db = await getDb();
  return db.get('meta', id);
}

export async function getDoc(id) {
  const db = await getDb();
  const tx = db.transaction(['meta', 'content'], 'readonly');
  const [meta, content] = await Promise.all([tx.objectStore('meta').get(id), tx.objectStore('content').get(id)]);
  await tx.done;
  if (!meta) return null;
  return {
    ...meta,
    json: content?.json ?? null,
    html: content?.html ?? '',
    settings: { ...DEFAULT_SETTINGS, ...(content?.settings || {}), margins: { ...DEFAULT_SETTINGS.margins, ...(content?.settings?.margins || {}) } },
    comments: content?.comments || {},
    // Link to a file on the user's device: { handle, name, format, lastModified }.
    file: content?.file?.handle ? content.file : null,
  };
}

/** Create a document from HTML (templates, imports) or editor JSON. */
export async function createDoc({ title = 'Untitled document', html = '', json = null, settings = {}, comments = {}, file = null } = {}) {
  const db = await getDb();
  const id = newId();
  const now = Date.now();
  const text = json ? '' : htmlToText(html);
  const tx = db.transaction(['meta', 'content'], 'readwrite');
  await Promise.all([
    tx.objectStore('meta').put({
      id,
      title,
      createdAt: now,
      updatedAt: now,
      preview: text.slice(0, 280),
      words: text ? text.split(/\s+/).length : 0,
      fileName: file?.name || null,
    }),
    tx.objectStore('content').put({ id, json, html, settings: { ...DEFAULT_SETTINGS, ...settings }, comments, file }),
  ]);
  await tx.done;
  return id;
}

/**
 * Persist a document. Any of `title`, `json`, `settings`, `comments`, `file`, `preview`, `words`
 * may be omitted to leave the stored value untouched.
 */
export async function saveDoc(id, { title, json, html, settings, comments, file, preview, words } = {}) {
  const db = await getDb();
  const tx = db.transaction(['meta', 'content'], 'readwrite');
  const metaStore = tx.objectStore('meta');
  const contentStore = tx.objectStore('content');
  const [meta, content] = await Promise.all([metaStore.get(id), contentStore.get(id)]);
  if (!meta) {
    // Deleted (perhaps in another tab). Nothing was written, so just let the transaction finish.
    await tx.done;
    return false;
  }
  if (title !== undefined) meta.title = title;
  if (preview !== undefined) meta.preview = preview;
  if (words !== undefined) meta.words = words;
  meta.updatedAt = Date.now();

  const nextContent = content || { id, json: null, html: '', settings: { ...DEFAULT_SETTINGS } };
  if (json !== undefined) {
    nextContent.json = json;
    nextContent.html = '';
  }
  if (html !== undefined) {
    // Replace the body with freshly imported HTML (parsed when next opened).
    nextContent.html = html;
    nextContent.json = null;
  }
  if (settings !== undefined) nextContent.settings = settings;
  if (comments !== undefined) nextContent.comments = comments;
  if (file !== undefined) {
    nextContent.file = file; // null unlinks
    meta.fileName = file?.name || null;
  }

  await Promise.all([metaStore.put(meta), contentStore.put(nextContent)]);
  await tx.done;
  return true;
}

export async function renameDoc(id, title) {
  return saveDoc(id, { title });
}

export async function deleteDoc(id) {
  const db = await getDb();
  const tx = db.transaction(['meta', 'content', 'versions'], 'readwrite');
  const versionKeys = await tx.objectStore('versions').index('docId').getAllKeys(id);
  await Promise.all([
    tx.objectStore('meta').delete(id),
    tx.objectStore('content').delete(id),
    ...versionKeys.map((k) => tx.objectStore('versions').delete(k)),
  ]);
  await tx.done;
}

// ---------------------------------------------------------------------------
// Backup & restore
// ---------------------------------------------------------------------------

export const BACKUP_FORMAT = 'libreword-backup';

/** Every document (metadata + content) as one JSON-serialisable object. */
export async function exportBackup() {
  const db = await getDb();
  const tx = db.transaction(['meta', 'content'], 'readonly');
  const [metas, contents] = await Promise.all([tx.objectStore('meta').getAll(), tx.objectStore('content').getAll()]);
  const byId = new Map(contents.map((c) => [c.id, c]));
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    // File handles only make sense on this device, so backups leave them out.
    documents: metas.map((m) => {
      const { file: _file, ...content } = byId.get(m.id) || { id: m.id, json: null, html: '' };
      return { meta: { ...m, fileName: null }, content };
    }),
  };
}

/**
 * Restore documents from a backup. Documents whose id already exists are
 * kept unless the backup copy is newer. Returns { added, updated, skipped }.
 */
export async function importBackup(data) {
  if (!data || data.format !== BACKUP_FORMAT || !Array.isArray(data.documents)) {
    throw new Error('This file is not a LibreWord backup.');
  }
  const db = await getDb();
  const tx = db.transaction(['meta', 'content'], 'readwrite');
  const meta = tx.objectStore('meta');
  const content = tx.objectStore('content');
  const result = { added: 0, updated: 0, skipped: 0 };
  for (const doc of data.documents) {
    const m = doc?.meta;
    if (!m?.id || typeof m.title !== 'string') {
      result.skipped++;
      continue;
    }
    const updatedAt = Number.isFinite(m.updatedAt) ? m.updatedAt : Date.parse(m.updatedAt) || 0;
    const createdAt = Number.isFinite(m.createdAt) ? m.createdAt : Date.parse(m.createdAt) || updatedAt || Date.now();
    const existing = await meta.get(m.id);
    if (existing && existing.updatedAt >= updatedAt) {
      result.skipped++;
      continue;
    }
    await meta.put({ ...m, updatedAt: updatedAt || Date.now(), createdAt });
    await content.put({ id: m.id, json: doc.content?.json ?? null, html: doc.content?.html ?? '', settings: doc.content?.settings, comments: doc.content?.comments || {} });
    result[existing ? 'updated' : 'added']++;
  }
  await tx.done;
  return result;
}

/** The document already linked to this file on disk, if any. */
export async function findDocByFile(handle) {
  if (!handle?.isSameEntry) return null;
  const db = await getDb();
  // Only documents linked to a file of the same name can match; check those.
  const candidates = (await db.getAll('meta')).filter((m) => m.fileName === handle.name).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const m of candidates) {
    const c = await db.get('content', m.id);
    try {
      if (c?.file?.handle && (await c.file.handle.isSameEntry(handle))) return { id: c.id, title: m.title, file: c.file };
    } catch {
      /* stale handle */
    }
  }
  return null;
}

/** The stored file link of a document (fresh from the database). */
export async function getDocFile(id) {
  const db = await getDb();
  return (await db.get('content', id))?.file || null;
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

/** Store a snapshot; keeps the newest MAX_VERSIONS per document. */
export async function addVersion(docId, { title, json, html = '', settings, comments, words = 0, createdAt = Date.now(), reason = 'auto' }) {
  const db = await getDb();
  const tx = db.transaction('versions', 'readwrite');
  const store = tx.objectStore('versions');
  await store.add({ docId, title, json, html, settings, comments, words, createdAt, reason });
  const keys = await store.index('docId').getAllKeys(docId);
  if (keys.length > MAX_VERSIONS) {
    keys.sort((a, b) => a - b);
    for (const k of keys.slice(0, keys.length - MAX_VERSIONS)) await store.delete(k);
  }
  await tx.done;
}

/** Version summaries, newest first (without the document bodies). */
export async function listVersions(docId) {
  const db = await getDb();
  const all = await db.getAllFromIndex('versions', 'docId', docId);
  return all
    .map(({ vid, title, words, createdAt, reason }) => ({ vid, title, words, createdAt, reason }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getVersion(vid) {
  const db = await getDb();
  return db.get('versions', vid);
}

export async function duplicateDoc(id) {
  const doc = await getDoc(id);
  if (!doc) return null;
  const newDocId = await createDoc({
    title: `${doc.title} (copy)`,
    html: doc.html,
    json: doc.json,
    settings: doc.settings,
    comments: doc.comments,
  });
  await saveDoc(newDocId, { preview: doc.preview, words: doc.words });
  return newDocId;
}
