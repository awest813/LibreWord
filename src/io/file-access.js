/**
 * Saving back to files on the user's device.
 *
 * Where the File System Access API is available (Chromium browsers), a
 * document opened from disk keeps a handle to its file, and Save writes the
 * changes back to that file in its own format. Elsewhere, files are imported
 * as copies and "Save As" downloads a file instead.
 */
import { IMPORT_ACCEPT } from './import.js';
import { pickFileInput, safeFileName } from '../ui/dom.js';

export const FILE_FORMATS = {
  docx: {
    label: 'Word Document',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    exts: ['.docx'],
    lossless: true,
  },
  md: { label: 'Markdown', mime: 'text/markdown', exts: ['.md', '.markdown'], lossless: false },
  html: { label: 'Web Page', mime: 'text/html', exts: ['.html', '.htm'], lossless: false },
  txt: { label: 'Plain Text', mime: 'text/plain', exts: ['.txt'], lossless: false },
};

/** What a format can't keep, for the "some formatting will be lost" prompt. */
export const LOSSY_NOTES = {
  md: 'Markdown keeps headings, lists, tables, links and basic text styles, but not fonts, colours, alignment, page setup or comments.',
  html: 'A web page keeps most formatting, but not page setup, headers and footers or comments, and LibreWord reads it back with less detail than a Word document.',
  txt: 'Plain text keeps only the words — all formatting, tables, pictures and comments are lost.',
};

export const canSaveToFiles = () => typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
export const canOpenFileHandles = () => typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';

/** Writable format for a file name, or null for formats LibreWord can only read (.rtf…). */
export function formatOfName(name = '') {
  const ext = `.${String(name).split('.').pop().toLowerCase()}`;
  return Object.keys(FILE_FORMATS).find((id) => FILE_FORMATS[id].exts.includes(ext)) || null;
}

/** Swap a file name's extension for the format's own. */
export function fileNameFor(title, format) {
  // Only strip a document extension; "Q3 vs. Q4" must stay whole.
  const base = safeFileName(String(title || 'Untitled document').replace(/\.(docx|md|markdown|html?|txt|rtf)$/i, ''));
  return `${base}${FILE_FORMATS[format]?.exts[0] || '.docx'}`;
}

const isAbort = (err) => err?.name === 'AbortError';

/**
 * Let the user pick a file to open. Resolves to { file, handle } (handle is
 * null when the browser can't give one) or null if they cancelled.
 */
export async function pickFileToOpen() {
  if (canOpenFileHandles()) {
    try {
      const [handle] = await window.showOpenFilePicker({
        id: 'libreword-open',
        multiple: false,
        excludeAcceptAllOption: false,
        types: [
          {
            description: 'Documents',
            accept: {
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
              'text/markdown': ['.md', '.markdown'],
              'text/html': ['.html', '.htm'],
              'text/plain': ['.txt'],
              'application/rtf': ['.rtf'],
            },
          },
        ],
      });
      return { file: await handle.getFile(), handle };
    } catch (err) {
      if (isAbort(err)) return null;
      console.warn('showOpenFilePicker failed; using a file input instead', err);
    }
  }
  const file = await pickFileInput(IMPORT_ACCEPT);
  return file ? { file, handle: null } : null;
}

/** Ask where to save. Resolves to a file handle, or null if cancelled. */
export async function pickSaveLocation(suggestedName, preferredFormat = 'docx') {
  const order = [preferredFormat, ...Object.keys(FILE_FORMATS).filter((f) => f !== preferredFormat)];
  try {
    return await window.showSaveFilePicker({
      id: 'libreword-save',
      suggestedName,
      types: order.map((id) => ({ description: FILE_FORMATS[id].label, accept: { [FILE_FORMATS[id].mime]: FILE_FORMATS[id].exts } })),
    });
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

/**
 * Make sure we may write to the handle. Browsers forget the grant between
 * sessions; asking again needs a user gesture (the Save click / Ctrl+S).
 */
export async function ensureWritePermission(handle) {
  if (!handle.queryPermission) return true;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  try {
    return (await handle.requestPermission(opts)) === 'granted';
  } catch {
    return false;
  }
}

/** Write a blob to the file and return the file's new lastModified time. */
export async function writeToHandle(handle, blob) {
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (err) {
    await writable.abort?.().catch(() => {});
    throw err;
  }
  try {
    return (await handle.getFile()).lastModified;
  } catch {
    return Date.now();
  }
}

/** Get a FileSystemFileHandle from a drag & drop item (Chromium), if possible. */
export function handleFromDataTransfer(dataTransfer) {
  const item = [...(dataTransfer?.items || [])].find((i) => i.kind === 'file');
  return item?.getAsFileSystemHandle ? item.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null);
}
