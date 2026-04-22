import { openDB } from 'idb';

const initdb = async () =>
  openDB('libreword', 1, {
    upgrade(db) {
      if (db.objectStoreNames.contains('documents')) {
        console.log('documents store already exists');
        return;
      }
      db.createObjectStore('documents', { keyPath: 'id', autoIncrement: true });
      console.log('libreword database created');
    },
  });

export const createDoc = async (title = 'Untitled Document', content = '') => {
  const db = await openDB('libreword', 1);
  const tx = db.transaction('documents', 'readwrite');
  const store = tx.objectStore('documents');
  const timestamp = new Date().getTime();
  const newDoc = { title, content, createdAt: timestamp, updatedAt: timestamp };
  const id = await store.add(newDoc);
  return id;
};

export const updateDoc = async (id, title, content) => {
  const db = await openDB('libreword', 1);
  const tx = db.transaction('documents', 'readwrite');
  const store = tx.objectStore('documents');
  const existingDoc = await store.get(id);
  
  if (!existingDoc) return;
  
  existingDoc.title = title !== undefined ? title : existingDoc.title;
  existingDoc.content = content !== undefined ? content : existingDoc.content;
  existingDoc.updatedAt = new Date().getTime();
  
  await store.put(existingDoc);
};

export const getDoc = async (id) => {
  const db = await openDB('libreword', 1);
  const tx = db.transaction('documents', 'readonly');
  const store = tx.objectStore('documents');
  return await store.get(id);
};

export const getAllDocs = async () => {
  const db = await openDB('libreword', 1);
  const tx = db.transaction('documents', 'readonly');
  const store = tx.objectStore('documents');
  return await store.getAll();
};

export const deleteDoc = async (id) => {
  const db = await openDB('libreword', 1);
  const tx = db.transaction('documents', 'readwrite');
  const store = tx.objectStore('documents');
  await store.delete(id);
};

initdb();

