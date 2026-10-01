import {
  Bold, Italic, Underline, Strikethrough, Subscript, Superscript, Baseline, Highlighter,
  List, ListOrdered, ListTodo, ListIndentIncrease, ListIndentDecrease,
  TextAlignStart, TextAlignCenter, TextAlignEnd, TextAlignJustify,
  Undo2, Redo2, Scissors, Copy, ClipboardPaste, Paintbrush, Eraser, Search, Replace,
  Table, Image, Link, Link2Off, Minus, CalendarDays, FilePlus, FolderOpen, Save, Printer, Download,
  Upload, ZoomIn, ZoomOut, Moon, Sun, PanelLeft, Ruler, Quote, Code, Trash2, Plus, X, ChevronDown,
  ChevronUp, ChevronLeft, ChevronRight, Check, Keyboard, Info, Maximize, Pilcrow, Omega, CaseSensitive,
  WholeWord, Regex, Volume2, Square, FileText, House, Ellipsis, TableOfContents, SeparatorHorizontal,
  BetweenHorizontalStart, BetweenHorizontalEnd, BetweenVerticalStart, BetweenVerticalEnd, TableCellsMerge,
  TableCellsSplit, Rows3, Columns3, ArrowLeft, Type, AArrowUp, AArrowDown, CaseUpper, BookOpen,
  Monitor, Focus, Files, PanelTop, PanelBottom, Hash, SpellCheck, Sigma, ScrollText, FileDown, SquareDashed,
  Pencil, LayoutTemplate, Clock,
} from 'lucide';

const ICONS = {
  bold: Bold, italic: Italic, underline: Underline, strike: Strikethrough, subscript: Subscript,
  superscript: Superscript, textColor: Baseline, highlight: Highlighter, bulletList: List,
  orderedList: ListOrdered, taskList: ListTodo, indent: ListIndentIncrease, outdent: ListIndentDecrease,
  alignLeft: TextAlignStart, alignCenter: TextAlignCenter, alignRight: TextAlignEnd, alignJustify: TextAlignJustify,
  undo: Undo2, redo: Redo2, cut: Scissors, copy: Copy, paste: ClipboardPaste, painter: Paintbrush, eraser: Eraser,
  search: Search, replace: Replace, table: Table, image: Image, link: Link, unlink: Link2Off, hr: Minus,
  date: CalendarDays, newDoc: FilePlus, open: FolderOpen, save: Save, print: Printer, download: Download,
  upload: Upload, zoomIn: ZoomIn, zoomOut: ZoomOut, moon: Moon, sun: Sun, panelLeft: PanelLeft, ruler: Ruler,
  quote: Quote, code: Code, trash: Trash2, plus: Plus, close: X, chevronDown: ChevronDown, chevronUp: ChevronUp,
  chevronLeft: ChevronLeft, chevronRight: ChevronRight, check: Check, keyboard: Keyboard, info: Info,
  fullscreen: Maximize, pilcrow: Pilcrow, symbol: Omega, matchCase: CaseSensitive, wholeWord: WholeWord,
  regex: Regex, readAloud: Volume2, square: Square, file: FileText, home: House, more: Ellipsis,
  toc: TableOfContents, pageBreak: SeparatorHorizontal, rowAbove: BetweenHorizontalStart,
  rowBelow: BetweenHorizontalEnd, colLeft: BetweenVerticalStart, colRight: BetweenVerticalEnd,
  merge: TableCellsMerge, split: TableCellsSplit, rows: Rows3, columns: Columns3, back: ArrowLeft, type: Type,
  growFont: AArrowUp, shrinkFont: AArrowDown, changeCase: CaseUpper, readMode: BookOpen, printLayout: FileText,
  webLayout: Monitor, focus: Focus, files: Files, header: PanelTop, footer: PanelBottom, pageNumber: Hash,
  spell: SpellCheck, wordCount: Sigma, outline: ScrollText, fileDown: FileDown, margins: SquareDashed,
  rename: Pencil, template: LayoutTemplate, clock: Clock,
};

const cache = new Map();

const ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

function nodeToString([tag, attrs, children]) {
  const a = Object.entries(attrs || {}).map(([k, v]) => `${k}="${v}"`).join(' ');
  const inner = Array.isArray(children) ? children.map(nodeToString).join('') : '';
  return `<${tag} ${a}>${inner}</${tag}>`;
}

/** SVG markup for an icon name (falls back to an empty square). */
export function icon(name, cls = 'icon') {
  const key = `${name}|${cls}`;
  if (!cache.has(key)) {
    const def = ICONS[name] || Square;
    cache.set(key, `<svg ${ATTRS} class="${cls}">${def.map(nodeToString).join('')}</svg>`);
  }
  return cache.get(key);
}
