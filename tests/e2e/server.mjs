import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

// Use CHROME_PATH or a preinstalled Chromium if present; otherwise let
// Playwright use its own download (`npx playwright-core install chromium`).
const PREINSTALLED = '/opt/pw-browsers/chromium';
export const CHROME = process.env.CHROME_PATH || (existsSync(PREINSTALLED) ? PREINSTALLED : undefined);

// Without an explicit binary, run full Chromium (new headless mode), the
// browser users actually have, rather than Playwright's stripped-down
// chrome-headless-shell.
export const LAUNCH = CHROME ? { executablePath: CHROME } : { channel: 'chromium' };

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

/** Start `vite preview` on a free port and resolve once it answers. */
export async function startPreview() {
  const port = await freePort();
  const viteBin = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));
  const server = spawn(process.execPath, [viteBin, 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
  const stop = () => server.kill();
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(1); });
  const base = `http://localhost:${port}/`;
  for (let i = 0; i < 75; i++) {
    try {
      if ((await fetch(base)).ok) return { base, stop };
    } catch { /* not up yet */ }
    await sleep(200);
  }
  stop();
  throw new Error('vite preview did not start');
}
