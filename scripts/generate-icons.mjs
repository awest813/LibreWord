import { chromium } from 'playwright-core';
import fs from 'fs';
const svg = fs.readFileSync('public/favicon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
for (const size of [192, 512]) {
  await page.setViewportSize({ width: size, height: size });
  // Maskable-safe: logo on full-bleed brand background with padding.
  await page.setContent(`<html><body style="margin:0;background:#185abd;display:grid;place-items:center;width:${size}px;height:${size}px">
  <div style="width:${size*0.72}px;height:${size*0.72}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`);
  await page.screenshot({ path: `public/icons/icon-${size}.png` });
}
await browser.close();
