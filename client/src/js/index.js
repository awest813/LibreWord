import { Workbox } from 'workbox-window';
import Editor from './editor';
import { getAllDocs, createDoc, deleteDoc, updateDoc } from './database';
import * as mammoth from 'mammoth';
import './install';
import '../css/style.css';

const dashboardView = document.getElementById('dashboard-view');
const editorView = document.getElementById('editor-view');
const docList = document.getElementById('doc-list');
const btnNewDoc = document.getElementById('btn-new-doc');
const btnImportDoc = document.getElementById('btn-import-doc');
const fileImport = document.getElementById('file-import');
const btnBack = document.getElementById('btn-back');
const docTitleInput = document.getElementById('doc-title');
const searchInput = document.getElementById('search-docs');
const brandLogo = document.getElementById('brand-logo');

let currentDocId = null;
let allDocs = [];
let currentEditor = null;

window.LW = {
  newDoc: async () => {
    const id = await createDoc('Untitled Document', '');
    openEditor(id, 'Untitled Document');
  },
  importDoc: () => fileImport?.click(),
};

const renderDashboard = async (filter = '') => {
  dashboardView.style.display = 'block';
  editorView.style.display = 'none';
  document.getElementById('search-container').style.display = 'block';
  
  docList.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">Loading documents...</div>';
  
  allDocs = await getAllDocs();
  const filteredDocs = allDocs.filter(doc => 
    doc.title.toLowerCase().includes(filter.toLowerCase()) || 
    (doc.content && doc.content.toLowerCase().includes(filter.toLowerCase()))
  );
  
  docList.innerHTML = '';
  
  if (filteredDocs.length === 0) {
    docList.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 80px; color: var(--text-muted);">
      ${filter ? 'No documents match your search.' : 'Your workspace is empty. Create or import a document to get started!'}
    </div>`;
  } else {
    filteredDocs.sort((a, b) => b.updatedAt - a.updatedAt).forEach(doc => {
      const card = document.createElement('div');
      card.className = 'doc-card';
      
      // Strip HTML for preview
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = doc.content || '';
      const previewText = tempDiv.textContent || tempDiv.innerText || 'No content yet...';
      const safeTitle = document.createElement('span');
      safeTitle.textContent = doc.title || 'Untitled Document';
      const safePreview = document.createElement('span');
      safePreview.textContent = previewText;
      
      card.innerHTML = `
        <div class="doc-card-info">
          <h3 class="doc-title-text"></h3>
          <p>Edited ${new Date(doc.updatedAt).toLocaleDateString()}</p>
          <div class="doc-preview-text"></div>
        </div>
        <div class="doc-card-actions">
          <button class="btn btn-sm btn-danger btn-icon btn-delete" title="Delete Document">
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </div>
      `;
      card.querySelector('.doc-title-text').textContent = doc.title || 'Untitled Document';
      card.querySelector('.doc-preview-text').textContent = previewText;
      
      card.onclick = (e) => {
        if (!e.target.closest('.btn-delete')) {
          openEditor(doc.id, doc.title);
        }
      };
      
      card.querySelector('.btn-delete').onclick = async (e) => {
        e.stopPropagation();
        if(confirm(`Are you sure you want to delete "${doc.title}"?`)) {
          await deleteDoc(doc.id);
          renderDashboard(searchInput.value);
        }
      };
      
      docList.appendChild(card);
    });
  }
};

const openEditor = (id, title) => {
  dashboardView.style.display = 'none';
  editorView.style.display = 'flex';
  document.getElementById('search-container').style.display = 'none';
  
  currentDocId = id;
  docTitleInput.value = title || '';

  if (currentEditor) {
    currentEditor.destroy();
    currentEditor = null;
  }
  
  document.getElementById('editor-container').innerHTML = '';
  document.getElementById('toolbar-container').innerHTML = '';
  document.getElementById('menu-bar').innerHTML = '';
  
  currentEditor = new Editor(id);
};

// Event Listeners
if (brandLogo) brandLogo.onclick = () => renderDashboard();

if (btnNewDoc) {
  btnNewDoc.onclick = () => window.LW.newDoc();
}

if (btnImportDoc && fileImport) {
  btnImportDoc.onclick = () => fileImport.click();

  fileImport.onchange = async (e) => {
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
        htmlContent = text.split('\n').map(line => `<p>${line}</p>`).join('');
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
  };
}

if (btnBack) {
  btnBack.onclick = async () => {
    if (currentDocId) {
      await updateDoc(currentDocId, docTitleInput.value, undefined);
    }
    renderDashboard();
  };
}

if (docTitleInput) {
  docTitleInput.onchange = async (e) => {
    if (currentDocId) {
      await updateDoc(currentDocId, e.target.value, undefined);
    }
  };
}

if (searchInput) {
  searchInput.oninput = (e) => {
    renderDashboard(e.target.value);
  };
}

// Service Worker
if ('serviceWorker' in navigator) {
  const workboxSW = new Workbox('./service-worker.js');
  workboxSW.register();
}

// Connection Status
const connectionStatus = document.getElementById('connection-status');
const updateConnectionStatus = () => {
  if (!connectionStatus) return;
  const online = navigator.onLine;
  connectionStatus.innerHTML = online
    ? '<span class="status-dot"></span> Online'
    : '<span class="status-dot" style="background:#ef4444;box-shadow:0 0 6px #ef4444;"></span> Offline';
};
window.addEventListener('online', updateConnectionStatus);
window.addEventListener('offline', updateConnectionStatus);
updateConnectionStatus();

// Initial Render
renderDashboard();


