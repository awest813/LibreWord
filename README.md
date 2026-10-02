![License: MIT](https://img.shields.io/badge/license-MIT-blueviolet.svg)
![Static site](https://img.shields.io/badge/hosting-any%20static%20host-brightgreen.svg)
![Offline](https://img.shields.io/badge/works-offline-blue.svg)

# LibreWord

> A fast, offline-first word processor that runs entirely in your browser — no server, no account, your documents stay on your device.

LibreWord looks and works like a desktop word processor: a ribbon, real pages with margins, headers and footers, styles, tables, a table of contents and `.docx` export that opens cleanly in Microsoft Word, Google Docs, LibreOffice and Pages. The whole app is a static site — build it once and host the `dist/` folder anywhere.

---

## Features

| Area | What you get |
|---|---|
| **Pages** | True print layout: text, list items and table rows flow across Letter, Legal, A4, A5 or Executive pages with Word's margin presets, portrait/landscape, hard page breaks, headers, footers and page numbers |
| **Ribbon** | Home, Insert, Layout, References, Review, View and a contextual **Table** tab, plus a **File** backstage (New, Open, Info, Save a Copy, Print) |
| **Text** | Font family & size, grow/shrink, bold/italic/underline/strike, sub/superscript, font color, highlighter, change case, clear formatting, format painter |
| **Paragraphs** | Styles gallery (Normal, No Spacing, Title, Subtitle, Heading 1–6, Quote, Intense Quote, Caption), alignment, line & paragraph spacing, indents, first-line/hanging indents, bullets, numbering, checklists |
| **Insert** | Tables (grid picker, merge/split, header rows, shading, resizable columns), pictures (file, paste, drag & drop, URL; resizable), links, symbols, date & time, horizontal lines, code blocks, live **table of contents** with page numbers |
| **Review & navigation** | Find & replace (match case, whole word, regex), navigation pane (outline + search results), word count, browser spell check, read aloud, go to page |
| **View** | Print/Web layout, ruler with draggable margins and indent, zoom 10–500 % (Ctrl + wheel, one page, page width), formatting marks, focus mode, dark mode, full screen |
| **Files** | Export **.docx** (styles, lists, tables, images, comments, TOC with page numbers, page setup, headers/footers), **PDF** (vector, via the print dialog), **HTML**, **Markdown**, **plain text**. Import **.docx** with formatting preserved — fonts, sizes, colours, alignment, spacing, lists, merged table cells, images, links, page setup, headers/footers, threaded comments, footnotes — plus **.md**, **.html**, **.txt**, **.rtf**. Or just drop a file on the window; paste from Word keeps lists |
| **Review** | Comments with replies, resolve and delete, exported as native Word comments; version history with restore; backup/restore of all documents |
| **Save to your files** | In Chrome and Edge, a document opened from your computer stays linked to its file: **Save** (Ctrl+S) writes your changes back in the same format (.docx, .md, .html, .txt), **Save As** (Ctrl+Shift+S) saves to a new file and keeps saving there. A title-bar indicator shows unsaved changes; LibreWord asks before closing with unsaved changes, warns if another app changed the file, and notes what Markdown, HTML or text can't keep. Other browsers download a copy instead |
| **Storage** | Auto-save to IndexedDB, document list with search, rename, duplicate and delete; multi-tab change detection; documents from LibreWord v1 are migrated automatically |
| **PWA** | Installable, works fully offline after the first visit, and registers as a handler for `.docx`/`.md`/`.txt`/`.html` files |

Keyboard shortcuts follow Word (Ctrl+B/I/U, Ctrl+L/E/R/J, Ctrl+Enter, Ctrl+K, Ctrl+]/[, Shift+F3, Ctrl+Alt+1…6, Ctrl+F/H, Ctrl+S, Ctrl+P…). Press **Ctrl+/** in the editor for the full list.

## Performance

Pagination is incremental: after an edit LibreWord re-measures only from the changed block and stops as soon as the layout converges with the previous pass. On a 100-page document (`npm run bench`):

| | |
|---|---|
| Load + full pagination | ~220 ms |
| Pagination work per keystroke | ~0.3 ms |
| Total transaction cost per keystroke | ~3 ms |

Heavy code is loaded on demand: the `.docx` writer, `.docx` reader, Markdown parser and dialogs are separate chunks fetched only when used.

## Getting started

Requires Node.js 20+.

```bash
npm install
npm run dev        # development server with hot reload
npm run build      # production build in dist/
npm run preview    # serve the production build locally
```

### Deploying

`dist/` is plain static files with relative URLs, so it works from any host or sub-path — GitHub Pages, Netlify, Cloudflare Pages, S3, `python -m http.server`, or a USB stick.

The included workflow (`.github/workflows/deploy.yml`) runs the tests and publishes to **GitHub Pages** on every push to `main`. Enable it under *Settings → Pages → Build and deployment → Source: GitHub Actions*.

## Testing

```bash
npm test                         # unit tests (Vitest): converters, search, parsing
npm run build && npm run test:e2e   # end-to-end tests in headless Chromium
npm run build && npm run bench      # editing benchmark on a large document
npm run build && npm run test:a11y   # axe-core accessibility audit of every screen
npm run build && npm run test:files  # saving back to files on the device
```

The end-to-end suite drives the real app: typing and formatting, the ribbon, undo/redo, pagination invariants (every rendered line must fall inside a page's content area, before and after edits), find & replace, persistence across reloads, `.docx` and Markdown export (the `.docx` is parsed back to verify it), Markdown import and page setup. It uses `playwright-core`; set `CHROME_PATH` to point at a Chromium binary, or run `npx playwright-core install --no-shell chromium` first (full Chromium is needed: the stripped-down headless shell lacks the File System Access features the app uses).

## Project structure

```
index.html                 App shell
src/
  main.js                  Router (#/ start screen, #/doc/:id editor), file drop, PWA
  editor/
    create-editor.js       TipTap/ProseMirror schema and extensions
    pagination.js          Page layout engine (spacer decorations, incremental)
    paragraph-format.js    Line/paragraph spacing, indents, named paragraph styles
    page-break.js, toc.js  Page break node, live table of contents
    search.js              Find & replace with highlighting
    word-commands.js       Change case, grow/shrink font, Word shortcuts
    page-setup.js          Paper sizes, margins, units
  io/
    docx.js                Native .docx writer (styles, numbering, tables, images, comments)
    docx-import.js         Native .docx reader (OOXML → LibreWord HTML, settings, comments)
    paste.js               Clean-up of HTML pasted from Word
    import.js              .md / .html / .txt / .rtf import, HTML sanitizing
    markdown.js, export.js Markdown, HTML, text and print/PDF export
  storage/db.js            IndexedDB (metadata + content stores, v1 migration)
  ui/                      Ribbon, start screen, backstage, dialogs, panels, ruler
  styles/                  App chrome and document styles
tests/
  unit/                    Vitest (converters, Word fixture files, search, parsing)
  e2e/                     Playwright smoke tests and benchmark
  fixtures/word/           Word-authored sample documents (from mammoth.js, BSD-2)
```

The previous Quill/Express implementation lives in `client/` and `server/`; it is no longer used by the build and can be deleted.

## Privacy

Documents never leave your browser unless you export them. There is no backend, no analytics and no account.

## License

Released under the [MIT License](./LICENSE).
