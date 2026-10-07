import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// `base: './'` keeps every asset URL relative, so the build in `dist/` can be
// served from any static host or sub-path (GitHub Pages, Netlify, S3, a USB stick…).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: true,
    chunkSizeWarningLimit: 900,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'LibreWord',
        short_name: 'LibreWord',
        description: 'A fast, offline-first word processor that runs entirely in your browser.',
        theme_color: '#185abd',
        background_color: '#f3f2f1',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // "Open with LibreWord" in the Chromebook Files app (and the desktop file
        // manager on Windows, macOS and Linux) once the app is installed.
        file_handlers: [
          {
            action: './',
            accept: {
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
              'text/markdown': ['.md', '.markdown'],
              'text/plain': ['.txt'],
              'text/html': ['.html', '.htm'],
              'application/rtf': ['.rtf'],
            },
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.js'],
  },
});
