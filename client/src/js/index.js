import { Workbox } from 'workbox-window';
import Editor from './editor';
import { getAllDocs, createDoc, deleteDoc, updateDoc } from './database';
import * as mammoth from 'mammoth';
import '../css/style.css';

const dashboardView = document.getElementById('dashboard-view');
const editorView = document.getElementById('editor-view');
const docList = document.getElementById('doc-list');
const btnNewDoc = document.getElementById('btn-new-doc');
const btnImportDoc = document.getElementById('btn-import-doc');
const fileImport = document.getElementById('file-import');
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
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <h3>${doc.title || 'Untitled Document'}</h3>
            <p>Last edited: ${new Date(doc.updatedAt).toLocaleDateString()}</p>
          </div>
          <button class="btn btn-sm btn-danger btn-delete" data-id="${doc.id}">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </div>
      `;
      card.addEventListener('click', (e) => {
        if (!e.target.closest('.btn-delete')) {
          openEditor(doc.id, doc.title);
        }
      });
      card.querySelector('.btn-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if(confirm('Are you sure you want to delete this document?')) {
          await deleteDoc(doc.id);
          renderDashboard();
        }
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

if (btnImportDoc && fileImport) {
  btnImportDoc.addEventListener('click', () => fileImport.click());

  fileImport.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const fileName = file.name.split('.').slice(0, -1).join('.') || file.name;
    let htmlContent = '';

    try {
      if (file.name.endsWith('.docx')) {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer });
        htmlContent = result.value;
      } else if (file.name.endsWith('.txt') || file.name.endsWith('.md')) {
        const text = await file.text();
        htmlContent = `<p>${text.replace(/\n/g, '<br>')}</p>`;
      } else if (file.name.endsWith('.html') || file.name.endsWith('.htm')) {
        htmlContent = await file.text();
      } else {
        alert('Unsupported file format for import.');
        return;
      }

      const id = await createDoc(fileName, htmlContent);
      openEditor(id, fileName);
    } catch (err) {
      console.error('Import error:', err);
      alert('Failed to import document.');
    }
    
    e.target.value = ''; // Reset input
  });
}

// Update the New Doc button class
btnNewDoc.className = 'btn btn-primary';
btnNewDoc.innerHTML = `
  <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
  New Document
`;

btnBack.className = 'btn btn-dark';
btnBack.innerHTML = `
  <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
  Back
`;

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

