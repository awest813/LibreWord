import { Workbox } from 'workbox-window';
import Editor from './editor';
import { getAllDocs, createDoc, deleteDoc, updateDoc } from './database';
import '../css/style.css';

const dashboardView = document.getElementById('dashboard-view');
const editorView = document.getElementById('editor-view');
const docList = document.getElementById('doc-list');
const btnNewDoc = document.getElementById('btn-new-doc');
const btnBack = document.getElementById('btn-back');
const docTitleInput = document.getElementById('doc-title');

let currentEditorInstance = null;
let currentDocId = null;

const renderDashboard = async () => {
  dashboardView.style.display = 'block';
  editorView.style.display = 'none';
  docList.innerHTML = 'Loading...';
  
  const docs = await getAllDocs();
  docList.innerHTML = '';
  
  if (docs.length === 0) {
    docList.innerHTML = '<p>No documents found. Create one!</p>';
  } else {
    docs.forEach(doc => {
      const card = document.createElement('div');
      card.className = 'doc-card';
      card.style.cssText = 'background: #225ca3; padding: 15px; margin-bottom: 10px; cursor: pointer; border-radius: 5px;';
      card.innerHTML = `
        <h3 style="margin: 0 0 10px 0;">${doc.title || 'Untitled Document'}</h3>
        <p style="margin: 0 0 10px 0; font-size: 0.8rem;">Last edited: ${new Date(doc.updatedAt).toLocaleString()}</p>
        <button class="btn btn-sm btn-danger btn-delete" data-id="${doc.id}">Delete</button>
      `;
      card.addEventListener('click', (e) => {
        if (!e.target.classList.contains('btn-delete')) {
          openEditor(doc.id, doc.title);
        }
      });
      card.querySelector('.btn-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteDoc(doc.id);
        renderDashboard();
      });
      docList.appendChild(card);
    });
  }
};

const openEditor = (id, title) => {
  dashboardView.style.display = 'none';
  editorView.style.display = 'block';
  currentDocId = id;
  docTitleInput.value = title || '';
  
  // Clean up old instance if exists
  document.getElementById('editor-container').innerHTML = '';
  
  currentEditorInstance = new Editor(id);
};

btnNewDoc.addEventListener('click', async () => {
  const id = await createDoc('Untitled Document', '');
  openEditor(id, 'Untitled Document');
});

btnBack.addEventListener('click', async () => {
  if (currentDocId) {
    await updateDoc(currentDocId, docTitleInput.value, undefined);
  }
  renderDashboard();
});

docTitleInput.addEventListener('change', async (e) => {
  if (currentDocId) {
    await updateDoc(currentDocId, e.target.value, undefined);
  }
});

// Init
renderDashboard();

if ('serviceWorker' in navigator) {
  const workboxSW = new Workbox('./service-worker.js');
  workboxSW.register();
} else {
  console.error('Service workers are not supported in this browser.');
}

