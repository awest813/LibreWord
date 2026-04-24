![Github license](https://img.shields.io/badge/license-MIT-blueviolet.svg)

# LibreWord

A modern, browser-based word processor built as a Progressive Web App (PWA). LibreWord runs entirely in the browser, stores documents in IndexedDB for offline access, and can be installed to your desktop or home screen like a native app.

## Live Links

- 📽️ Deployed app: https://still-everglades-84797.herokuapp.com/
- 🌍 Repository: https://github.com/awest813/LibreWord

## Description

- AS A developer or writer
  - I WANT to create, edit, and export documents with or without an internet connection
  - SO THAT I can reliably access and manage my work from any browser

## Features

- Rich text editing powered by [Quill](https://quilljs.com/)
- Full menu bar (File, Edit, Insert, Format, View, Help) with keyboard shortcuts
- Find & Replace with match highlighting
- Export to **PDF**, **Word (.doc)**, **HTML**, and **Plain Text**
- Import `.docx`, `.txt`, `.md`, and `.html` files
- Table insertion via visual grid picker
- Document dashboard with search, sort by date, and per-card preview
- Auto-save to IndexedDB (debounced, 1 s after last keystroke)
- Online/Offline status indicator
- Zoom (50 %–200 %), Portrait/Landscape orientation, Print Layout / Web Layout modes
- Ruler (cm)
- Keyboard shortcut reference dialog
- PWA installable — works fully offline after first load

## Installation

```bash
# Install all dependencies (root + client)
npm install

# Start in development mode (Express server + webpack-dev-server with HMR)
npm run start:dev

# Build for production and start the server
npm start
```

Requires Node.js ≥ 14.

## Criteria

GIVEN a text editor web application
* WHEN I open my application in my editor
    * THEN I should see a client server folder structure
* WHEN I run `npm run start` from the root directory
    * THEN I find that my application should start up the backend and serve the client
* WHEN I run the text editor application from my terminal
    * THEN I find that my JavaScript files have been bundled using webpack
* WHEN I run my webpack plugins
    * THEN I find that I have a generated HTML file, service worker, and a manifest file
* WHEN I use next-gen JavaScript in my application
    * THEN I find that the text editor still functions in the browser without errors
* WHEN I open the text editor
    * THEN I find that IndexedDB has immediately created a database storage
* WHEN I enter content and subsequently click off of the DOM window
    * THEN I find that the content in the text editor has been saved with IndexedDB
* WHEN I reopen the text editor after closing it
    * THEN I find that the content in the text editor has been retrieved from IndexedDB
* WHEN I click on the Install button
    * THEN I download my web application as an icon on my desktop
* WHEN I load my web application
    * THEN I should have a registered service worker using Workbox
* WHEN I register a service worker
    * THEN I should have my static assets pre-cached upon loading along with subsequent pages and static assets
* WHEN I deploy to Heroku
    * THEN I should have proper build scripts for a webpack application

## Usage

The following animation demonstrates the application functionality:

![Demonstration of LibreWord being used in the browser and then installed.](./Assets/00-demo.gif)

The following image shows the application's `manifest.json` file:

![Demonstration of LibreWord with a manifest file in the browser.](./Assets/01-manifest.png)

The following image shows the application's registered service worker:

![Demonstration of LibreWord with a registered service worker in the browser.](./Assets/02-service-worker.png)

The following image shows the application's IndexedDB storage:

![Demonstration of LibreWord with IndexedDB storage named 'libreword' in the browser.](./Assets/03-idb-storage.png)

## Tech Stack

| Layer | Technology |
|---|---|
| Editor | [Quill 2.x](https://quilljs.com/) |
| Offline storage | IndexedDB via [idb](https://github.com/jakearchibald/idb) |
| PWA / Service Worker | [Workbox 6](https://developer.chrome.com/docs/workbox/) via workbox-webpack-plugin |
| Bundler | [Webpack 5](https://webpack.js.org/) + Babel |
| Server | [Express](https://expressjs.com/) |
| Export | [html2pdf.js](https://github.com/eKoopmans/html2pdf.js), [FileSaver.js](https://github.com/eligrey/FileSaver.js) |
| Import | [Mammoth.js](https://github.com/mwilliamson/mammoth.js) |

## Project Structure

```
LibreWord/
├── client/
│   ├── src/
│   │   ├── js/
│   │   │   ├── index.js      # App bootstrap, dashboard, router
│   │   │   ├── editor.js     # Quill wrapper, toolbar, menus, export
│   │   │   ├── database.js   # IndexedDB CRUD via idb
│   │   │   ├── install.js    # PWA install prompt
│   │   │   └── header.js     # ASCII header / banner
│   │   └── css/style.css
│   ├── src-sw.js             # Custom service worker (Workbox)
│   ├── index.html
│   └── webpack.config.js
└── server/
    ├── server.js             # Express static file server
    └── routes/htmlRoutes.js
```

## License

## MIT License
