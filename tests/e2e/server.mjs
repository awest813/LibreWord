import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { existsSync } from 'node:fs';

// Use CHROME_PATH or a preinstalled Chromium if present; otherwise let
// Playwright use its own download (`npx playwright-core install chromium`).
const PREINSTALLED = '/opt/pw-browsers/chromium';
export const CHROME = process.env.CHROME_PATH || (existsSync(PREINSTALLED) ? PREINSTALLED : undefined);

/** Start `vite preview` on `port` and resolve once it answers. */
export async function startPreview(port) {
  const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'pipe' });
  process.on('exit', () => server.kill());
  const base = `http://localhost:${port}/`;
  for (let i = 0; i < 75; i++) {
    try {
      if ((await fetch(base)).ok) return { base, stop: () => server.kill() };
    } catch { /* not up yet */ }
    await sleep(200);
  }
  server.kill();
  throw new Error('vite preview did not start');
}
