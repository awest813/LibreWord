import { openDB } from 'idb';

/**
 * Documents are split across two object stores:
 *   meta    – small records used by the document list (title, dates, preview…)
 *   content – the full editor JSON / HTML and per-document settings
 * so the start screen never has to load every document body.
 */
const DB_NAME = 'libreword';
const DB_VERSION = 2;

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
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
};

let dbPromise;

export const getDb = () => {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains('meta')) {
          const meta = db.createObjectStore('meta', { keyPath: 'id' });
          meta.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('content')) {
          db.createObjectStore('content', { keyPath: 'id' });
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
      blocking() {
        // Another tab wants to upgrade; get out of its way.
        dbPromise?.then((db) => db.close());
        dbPromise = null;
      },
    });
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
  };
}

/** Create a document from HTML (templates, imports) or editor JSON. */
export async function createDoc({ title = 'Untitled document', html = '', json = null, settings = {}, comments = {} } = {}) {
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
    }),
    tx.objectStore('content').put({ id, json, html, settings: { ...DEFAULT_SETTINGS, ...settings }, comments }),
  ]);
  await tx.done;
  return id;
}

/**
 * Persist a document. Any of `title`, `json`, `settings`, `comments`, `preview`, `words`
 * may be omitted to leave the stored value untouched.
 */
export async function saveDoc(id, { title, json, settings, comments, preview, words } = {}) {
  const db = await getDb();
  const tx = db.transaction(['meta', 'content'], 'readwrite');
  const metaStore = tx.objectStore('meta');
  const contentStore = tx.objectStore('content');
  const [meta, content] = await Promise.all([metaStore.get(id), contentStore.get(id)]);
  if (!meta) {
    tx.abort();
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
  if (settings !== undefined) nextContent.settings = settings;
  if (comments !== undefined) nextContent.comments = comments;

  await Promise.all([metaStore.put(meta), contentStore.put(nextContent)]);
  await tx.done;
  return true;
}

export async function renameDoc(id, title) {
  return saveDoc(id, { title });
}

export async function deleteDoc(id) {
  const db = await getDb();
  const tx = db.transaction(['meta', 'content'], 'readwrite');
  await Promise.all([tx.objectStore('meta').delete(id), tx.objectStore('content').delete(id)]);
  await tx.done;
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
