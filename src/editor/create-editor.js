import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyleKit } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import { TableKit } from '@tiptap/extension-table';
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

/**
 * The extension list is shared by the live editor and by tests, so the
 * schema is defined in exactly one place.
 */
export function buildExtensions({ getGeometry = () => null, onLayout = () => {}, getPageOf = null } = {}) {
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
    TableKit.configure({ table: { resizable: true, cellMinWidth: 36, allowTableNodeSelection: true } }),
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
    CommentMark,
    Search,
    Pagination.configure({ getGeometry, onLayout }),
  ];
}

export function createEditor({ element, content, getGeometry, onLayout, getPageOf, onUpdate, onSelectionUpdate, onTransaction, editorProps = {} }) {
  let editor;
  editor = new Editor({
    element,
    content,
    extensions: buildExtensions({
      getGeometry,
      getPageOf,
      onLayout: (info) => {
        onLayout?.(info);
        editor?.emit('pagination', info);
      },
    }),
    autofocus: 'start',
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
  return editor;
}
