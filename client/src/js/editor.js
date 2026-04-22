import { getDoc, updateDoc } from './database';
import Quill from 'quill';
import 'quill/dist/quill.bubble.css';
import html2pdf from 'html2pdf.js';
import { saveAs } from 'file-saver';

// Custom Line Height support
const Parchment = Quill.import('parchment');
const LineHeightStyle = new Parchment.Attributor.Style('lineheight', 'line-height', {
  scope: Parchment.Scope.BLOCK,
  whitelist: ['1', '1.2', '1.5', '2']
});
Quill.register(LineHeightStyle, true);

export default class {
  constructor(docId) {
    this.docId = docId;
    
    const container = document.createElement('div');
    document.querySelector('#editor-container').appendChild(container);

    this.editor = new Quill(container, {
      theme: 'bubble',
      placeholder: 'Start writing...',
      modules: {
        toolbar: [
          [{ 'font': [] }, { 'size': ['small', false, 'large', 'huge'] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ 'color': [] }, { 'background': [] }],
          [{ 'header': 1 }, { 'header': 2 }, { 'header': 3 }, 'blockquote', 'code-block'],
          [{ 'list': 'ordered'}, { 'list': 'bullet' }, { 'indent': '-1'}, { 'indent': '+1' }],
          [{ 'align': [] }, { 'lineheight': ['1', '1.2', '1.5', '2'] }],
          ['link', 'image', 'video'],
          ['clean']
        ]
      }
    });

    getDoc(this.docId).then((doc) => {
      if (doc && doc.content) {
        this.editor.clipboard.dangerouslyPasteHTML(doc.content);
      }
    });

    this.editor.on('text-change', () => {
      // Autosave text
      updateDoc(this.docId, undefined, this.editor.root.innerHTML);
      
      const status = document.getElementById('connection-status');
      if (status) {
        status.innerHTML = '<span class="status-dot" style="background: #fbbf24;"></span> Saving...';
        setTimeout(() => {
          status.innerHTML = '<span class="status-dot" style="background: #10b981;"></span> Saved';
        }, 1000);
      }
    });

    const btnPrint = document.getElementById('btn-print');
    const selectExport = document.getElementById('export-format');

    btnPrint.className = 'btn btn-dark btn-sm';
    btnPrint.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="margin-right: 5px; vertical-align: text-bottom;"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 01-2-2H9a2 2 0 01-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"></path></svg> Print`;
    
    btnPrint.onclick = () => {
      window.print();
    };

    selectExport.addEventListener('change', async (e) => {
      const format = e.target.value;
      if (!format) return;
      
      const doc = await getDoc(this.docId);
      const title = (doc && doc.title) ? doc.title : 'document';
      
      if (format === 'pdf') {
        const element = document.querySelector('.ql-editor');
        const opt = {
          margin:       1,
          filename:     `${title}.pdf`,
          image:        { type: 'jpeg', quality: 0.98 },
          html2canvas:  { scale: 2 },
          jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
        };
        html2pdf().set(opt).from(element).save();
      } else if (format === 'txt') {
        const text = this.editor.getText();
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        saveAs(blob, `${title}.txt`);
      } else if (format === 'html') {
        const html = this.editor.root.innerHTML;
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        saveAs(blob, `${title}.html`);
      } else if (format === 'docx') {
        const html = this.editor.root.innerHTML;
        // Word can read HTML files with a .doc extension
        const docHtml = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
        <head><meta charset='utf-8'><title>${title}</title></head>
        <body>${html}</body></html>`;
        
        const blob = new Blob(['\ufeff', docHtml], {
            type: 'application/msword'
        });
        saveAs(blob, `${title}.doc`);
      }
      
      e.target.value = ''; // Reset selection
    });
  }
}

