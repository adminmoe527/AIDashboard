#!/usr/bin/env node
'use strict';

/**
 * Generates every icon the app needs, with zero dependencies:
 *
 *   assets/tray/dot-<status>.png       16x16 menu bar dot
 *   assets/tray/dot-<status>@2x.png    32x32 retina variant
 *   assets/icon.png                    512x512 app icon (electron-builder
 *                                      converts this to .icns for the bundle)
 *
 * Uses a minimal hand-rolled PNG encoder (IHDR/IDAT/IEND + zlib) rather than
 * an image library -- icons are just anti-aliased circles, and keeping the
 * dependency tree empty matters for an always-running background app.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { STATUS, COLOR } = require('../src/core/state');

/* ------------------------------ PNG encoder ----------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** rgba: Buffer of width*height*4 bytes. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // compression 0, filter 0, interlace 0

  // Raw scanlines, each prefixed with filter byte 0 (None).
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------- drawing -------------------------------- */

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Anti-aliased filled circle on transparent ground. */
function drawDot(size, [r, g, b]) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const radius = size * 0.36;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const a = clamp01(radius - d + 0.5);
      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, rgba);
}

/**
 * "AI" wordmark as pixel art, colored by status. Hand-drawn bitmap because we
 * have no font rasterizer -- at menu bar sizes crisp pixels beat blurry text.
 */
const AI_GRID = [
  '.###..###',
  '#...#..#.',
  '#...#..#.',
  '#####..#.',
  '#...#..#.',
  '#...#..#.',
  '#...#.###',
];
const AI_W = AI_GRID[0].length;
const AI_H = AI_GRID.length;

function stampLabel(rgba, size, [r, g, b], scaleFactor) {
  const s = Math.max(1, Math.floor((size * scaleFactor) / AI_W));
  const x0 = Math.floor((size - AI_W * s) / 2);
  const y0 = Math.floor((size - AI_H * s) / 2);
  for (let gy = 0; gy < AI_H; gy++) {
    for (let gx = 0; gx < AI_W; gx++) {
      if (AI_GRID[gy][gx] !== '#') continue;
      for (let dy = 0; dy < s; dy++) {
        for (let dx = 0; dx < s; dx++) {
          const x = x0 + gx * s + dx;
          const y = y0 + gy * s + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const i = (y * size + x) * 4;
          rgba[i] = r;
          rgba[i + 1] = g;
          rgba[i + 2] = b;
          rgba[i + 3] = 255;
        }
      }
    }
  }
}

function drawLabel(size, rgb) {
  const rgba = Buffer.alloc(size * size * 4);
  stampLabel(rgba, size, rgb, 0.95);
  return encodePng(size, size, rgba);
}

/** App icon: dark rounded square with a green status dot. */
function drawAppIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const [br, bg, bb] = hexToRgb('#161b22');
  const [dr, dg, db] = hexToRgb(COLOR[STATUS.OPERATIONAL]);
  const [rr, rg2, rb] = hexToRgb('#30363d');

  const half = size / 2;
  const corner = size * 0.22;
  const boxHalf = size * 0.46;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - half;
      const py = y + 0.5 - half;

      // Signed distance to a rounded square centred on the canvas.
      const qx = Math.abs(px) - (boxHalf - corner);
      const qy = Math.abs(py) - (boxHalf - corner);
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const inside = Math.min(Math.max(qx, qy), 0);
      const sd = outside + inside - corner;
      const boxA = clamp01(-sd + 0.5);

      const i = (y * size + x) * 4;
      if (boxA <= 0) continue;

      let r = br, g = bg, b = bb;

      // Thin ring just inside the edge for a little definition.
      if (sd > -size * 0.02) {
        r = rr; g = rg2; b = rb;
      }

      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = Math.round(boxA * 255);
    }
  }
  // Green "AI" wordmark on the plate.
  stampLabel(rgba, size, [dr, dg, db], 0.62);
  return encodePng(size, size, rgba);
}

/* --------------------------------- main ---------------------------------- */

function main() {
  const trayDir = path.join(__dirname, '..', 'assets', 'tray');
  fs.mkdirSync(trayDir, { recursive: true });

  for (const status of Object.values(STATUS)) {
    const rgb = hexToRgb(COLOR[status]);
    fs.writeFileSync(path.join(trayDir, `dot-${status}.png`), drawDot(16, rgb));
    fs.writeFileSync(path.join(trayDir, `dot-${status}@2x.png`), drawDot(32, rgb));
    fs.writeFileSync(path.join(trayDir, `ai-${status}.png`), drawLabel(16, rgb));
    fs.writeFileSync(path.join(trayDir, `ai-${status}@2x.png`), drawLabel(32, rgb));
  }

  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), drawAppIcon(512));
  console.log(`icons written to ${path.join(__dirname, '..', 'assets')}`);
}

main();
