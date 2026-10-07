import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyleKit } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import { TableKit, TableCell, TableHeader } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import Typography from '@tiptap/extension-typography';
import { Placeholder } from '@tiptap/extensions';

import { ParagraphFormat } from './paragraph-format.js';
import { PageBreak } from './page-break.js';
import { Pagination } from './pagination.js';
import { Search } from './search.js';
import { TableOfContents } from './toc.js';
import { WordCommands } from './word-commands.js';
import { CommentMark } from './comments.js';
import { PasteFormatting } from './paste-formatting.js';

// Cell shading (Table > Shading, and Word's w:shd on import/export).
const shading = {
  backgroundColor: {
    default: null,
    parseHTML: (el) => el.style.backgroundColor || null,
    renderHTML: (attrs) => (attrs.backgroundColor ? { style: `background-color: ${attrs.backgroundColor}` } : {}),
  },
};
const ShadedCell = TableCell.extend({ addAttributes() { return { ...this.parent?.(), ...shading }; } });
const ShadedHeader = TableHeader.extend({ addAttributes() { return { ...this.parent?.(), ...shading }; } });

/**
 * The extension list is shared by the live editor and by tests, so the
 * schema is defined in exactly one place.
 */
export function buildExtensions({ getGeometry = () => null, onLayout = () => {}, getPageOf = null, isKnownComment = null, onPasteReport = null, inlinePastedImages = false } = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null } },
      undoRedo: { depth: 500, newGroupDelay: 600 },
      dropcursor: { color: 'var(--accent)', width: 2 },
    }),
    TextStyleKit.configure({ lineHeight: false, backgroundColor: false }),
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
    Highlight.configure({ multicolor: true }),
    TableKit.configure({ table: { resizable: true, cellMinWidth: 36, allowTableNodeSelection: true }, tableCell: false, tableHeader: false }),
    ShadedCell,
    ShadedHeader,
    Image.configure({
      inline: true,
      allowBase64: true,
      resize: { enabled: true, minWidth: 24, minHeight: 24, alwaysPreserveAspectRatio: true },
    }),
    Subscript,
    Superscript,
    TaskList,
    TaskItem.configure({ nested: true }),
    Typography.configure({ oneHalf: false, oneQuarter: false, threeQuarters: false, plusMinus: false, notEqual: false, laquo: false, raquo: false }),
    Placeholder.configure({
      placeholder: ({ editor }) => (editor.isEmpty ? 'Start typing…' : ''),
      showOnlyCurrent: true,
    }),
    ParagraphFormat,
    PageBreak,
    TableOfContents.configure({ getPageOf }),
    WordCommands,
    CommentMark.configure({ isKnown: isKnownComment }),
    Search,
    PasteFormatting.configure({ onReport: onPasteReport, inlineImages: inlinePastedImages }),
    Pagination.configure({ getGeometry, onLayout }),
  ];
}

export function createEditor({ element, content, getGeometry, onLayout, getPageOf, isKnownComment, onPasteReport, onUpdate, onSelectionUpdate, onTransaction, onContentError, editorProps = {} }) {
  let editor;
  editor = new Editor({
    element,
    content,
    extensions: buildExtensions({
      getGeometry,
      getPageOf,
      isKnownComment,
      onPasteReport,
      inlinePastedImages: true,
      onLayout: (info) => {
        onLayout?.(info);
        editor?.emit('pagination', info);
      },
    }),
    autofocus: 'start',
    // Stored documents (JSON) must fit the schema exactly; a node this build
    // doesn't know would otherwise be dropped silently, then saved over.
    // Imported HTML is parsed leniently as usual.
    enableContentCheck: Boolean(onContentError) && typeof content === 'object',
    onContentError: onContentError || (() => {}),
    editorProps: {
      attributes: {
        class: 'lw-document',
        spellcheck: 'true',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Document',
      },
      ...editorProps,
    },
    onUpdate,
    onSelectionUpdate,
    onTransaction,
  });
  // Only the initial content is checked; later setContent calls (pasted or
  // imported HTML, restored versions) parse leniently.
  editor.setOptions({ enableContentCheck: false });
  return editor;
}
