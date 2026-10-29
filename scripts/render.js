#!/usr/bin/env node
'use strict';

// Renders an HTML or SVG file to PNG with the Playwright Chromium that is
// already installed. Used to produce favicons, the social preview and README
// images from the SVG sources in brand/. Not needed at runtime.
//
//   node scripts/render.js brand/mark.svg public/apple-touch-icon.png --size 180
//   node scripts/render.js brand/social-preview.html brand/social-preview.png --width 1280 --height 640
//   node scripts/render.js public/index.html shot.png --width 1200 --full
//
// Options: --width N --height N (viewport), --size N (square shortcut),
// --scale N (device scale factor, default 1), --full (full-page screenshot),
// --selector CSS (screenshot one element), --transparent (omit background).

const path = require('path');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [input, output] = args._;
  if (!input || !output) {
    console.error('usage: node scripts/render.js <input.html|svg> <output.png> [--width N --height N | --size N] [--scale N] [--full] [--selector CSS] [--transparent]');
    process.exit(2);
  }
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('Playwright is not installed. Install it once with: npm i -D playwright && npx playwright install chromium');
    process.exit(1);
  }
  const size = args.size ? Number(args.size) : null;
  const width = size || Number(args.width || 1200);
  const height = size || Number(args.height || 800);
  const scale = Number(args.scale || 1);
  const src = path.resolve(input);
  const isSvg = /\.svg$/i.test(src);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    if (isSvg) {
      // Show the SVG scaled to the viewport on a transparent canvas. It is
      // inlined as a data URI because a blank page may not load file:// images.
      const data = require('fs').readFileSync(src).toString('base64');
      await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;height:100%;background:transparent}img{display:block;width:100%;height:100%}</style></head><body><img src="data:image/svg+xml;base64,${data}"></body></html>`);
      await page.waitForLoadState('networkidle');
    } else {
      await page.goto(`file://${src}`);
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => document.fonts ? document.fonts.ready : null);
    }
    await page.waitForTimeout(150);
    const opts = { path: path.resolve(output), omitBackground: isSvg || !!args.transparent };
    if (args.selector) {
      await page.locator(args.selector).first().screenshot(opts);
    } else {
      await page.screenshot({ ...opts, fullPage: !!args.full });
    }
    console.log(`wrote ${output} (${width}x${height}${args.full ? ', full page' : ''}${scale !== 1 ? `, @${scale}x` : ''})`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
