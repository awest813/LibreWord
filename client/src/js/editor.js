import { getDoc, updateDoc } from './database';
import Quill from 'quill';
import 'quill/dist/quill.bubble.css';
import html2pdf from 'html2pdf.js';

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
          ['bold', 'italic', 'underline', 'strike'],
          [{ 'header': 1 }, { 'header': 2 }, { 'header': 3 }],
          [{ 'list': 'ordered'}, { 'list': 'bullet' }],
          ['link', 'blockquote', 'code-block', 'image', 'video']
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
    });

    // Setup Print Button
    document.getElementById('btn-print').onclick = () => {
      window.print();
    };

    // Setup PDF Export Button
    document.getElementById('btn-export-pdf').onclick = async () => {
      const doc = await getDoc(this.docId);
      const title = (doc && doc.title) ? doc.title : 'document';
      
      const element = document.querySelector('.ql-editor');
      const opt = {
        margin:       1,
        filename:     `${title}.pdf`,
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2 },
        jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
      };

      html2pdf().set(opt).from(element).save();
    };
  }
}

