![License: MIT](https://img.shields.io/badge/license-MIT-blueviolet.svg)
![Node.js ≥ 14](https://img.shields.io/badge/node-%E2%89%A514-brightgreen.svg)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

# LibreWord

> A modern, browser-based word processor built as a Progressive Web App (PWA).

LibreWord runs entirely in the browser, persists documents locally with IndexedDB for full offline access, and can be installed to your desktop or home screen like a native app — no account or cloud subscription required.

🌍 **Repository:** <https://github.com/awest813/LibreWord>

---

## Features

| Category | What's included |
|---|---|
| **Editing** | Rich text editing powered by [Quill 2.x](https://quilljs.com/); full menu bar (File, Edit, Insert, Format, View, Help) with keyboard shortcuts |
| **Find & Replace** | In-document search with match highlighting |
| **Export** | PDF, Word (.doc), HTML, and Plain Text |
| **Import** | `.docx`, `.txt`, `.md`, and `.html` files via [Mammoth.js](https://github.com/mwilliamson/mammoth.js) |
| **Tables** | Visual grid picker for fast table insertion |
| **Dashboard** | Document list with full-text search, date sorting, and per-card content preview |
| **Auto-save** | Debounced save to IndexedDB (1 s after last keystroke) |
| **PWA** | Installable to desktop/home screen; works fully offline after first load |
| **Layout** | Zoom (50 %–200 %), Portrait/Landscape orientation, Print Layout / Web Layout, cm ruler |
| **UX extras** | Online/Offline status indicator, keyboard shortcut reference dialog |

---

## Screenshots

![LibreWord in use — demo](./Assets/00-demo.gif)

<details>
<summary>More screenshots</summary>

**manifest.json**
![manifest.json in browser DevTools](./Assets/01-manifest.png)

**Service Worker**
![Registered service worker in browser DevTools](./Assets/02-service-worker.png)

**IndexedDB Storage**
![IndexedDB storage named 'libreword' in browser DevTools](./Assets/03-idb-storage.png)

</details>

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 14

### Install & run

```bash
# 1. Install all dependencies (root, client, and server)
npm run install:all

# 2a. Development mode — Express + webpack-dev-server with HMR
npm run start:dev

# 2b. Production mode — build then serve
npm start
```

The app will be available at `http://localhost:3000` (or the port printed in your terminal).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Editor | [Quill 2.x](https://quilljs.com/) |
| Offline storage | IndexedDB via [idb](https://github.com/jakearchibald/idb) |
| PWA / Service Worker | [Workbox 7](https://developer.chrome.com/docs/workbox/) via workbox-webpack-plugin |
| Bundler | [Webpack 5](https://webpack.js.org/) + Babel |
| Server | [Express](https://expressjs.com/) |
| Export | [html2pdf.js](https://github.com/eKoopmans/html2pdf.js), [FileSaver.js](https://github.com/eligrey/FileSaver.js) |
| Import | [Mammoth.js](https://github.com/mwilliamson/mammoth.js) |

---

## Project Structure

```
LibreWord/
├── client/
│   ├── src/
│   │   ├── js/
│   │   │   ├── index.js      # App bootstrap, dashboard, router
│   │   │   ├── editor.js     # Quill wrapper, toolbar, menus, export/import
│   │   │   ├── database.js   # IndexedDB CRUD via idb
│   │   │   ├── install.js    # PWA install prompt handler
│   │   │   └── header.js     # ASCII header / banner
│   │   └── css/style.css
│   ├── src-sw.js             # Custom service worker (Workbox)
│   ├── index.html
│   └── webpack.config.js
└── server/
    ├── server.js             # Express static file server
    └── routes/htmlRoutes.js
```

---

## Contributing

Pull requests are welcome! Please open an issue first to discuss what you'd like to change.

---

## License

Released under the [MIT License](./LICENSE).
