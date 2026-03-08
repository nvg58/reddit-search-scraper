#!/usr/bin/env node
/**
 * generate-icons.js
 *
 * Creates minimal valid PNG icon files (icon48.png and icon128.png) for the
 * Chrome extension using only Node.js built-in modules (no native canvas
 * dependency required).
 *
 * Each icon is an orange (#FF4500) circle with a centered white "R".
 * The "R" is drawn as a simple pixel-art glyph so we can build the image
 * entirely in memory without any external graphics library.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// -- PNG helpers --------------------------------------------------------------

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function buildPNG(width, height, rgbaPixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const ihdrChunk = pngChunk('IHDR', ihdr);

  const rawRows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = 1 + x * 4;
      row[dstIdx]     = rgbaPixels[srcIdx];
      row[dstIdx + 1] = rgbaPixels[srcIdx + 1];
      row[dstIdx + 2] = rgbaPixels[srcIdx + 2];
      row[dstIdx + 3] = rgbaPixels[srcIdx + 3];
    }
    rawRows.push(row);
  }
  const rawData = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = pngChunk('IDAT', compressed);

  const iendChunk = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// -- Drawing helpers ----------------------------------------------------------

function createPixelBuffer(width, height) {
  return Buffer.alloc(width * height * 4);
}

function setPixel(buf, width, height, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const idx = (y * width + x) * 4;
  buf[idx]     = r;
  buf[idx + 1] = g;
  buf[idx + 2] = b;
  buf[idx + 3] = a;
}

function fillRect(buf, width, height, x0, y0, w, h, r, g, b, a) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      setPixel(buf, width, height, x, y, r, g, b, a);
    }
  }
}

function fillCircle(buf, size, cx, cy, radius, r, g, b, a) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(buf, size, size, x, y, r, g, b, a);
      }
    }
  }
}

/**
 * Draw a blocky "R" glyph using filled rectangles.
 * Designed on a 5x7 unit grid and scaled by `unit`.
 */
function drawR(buf, size, originX, originY, unit, r, g, b, a) {
  // Left vertical stroke (full height)
  fillRect(buf, size, size, originX, originY, unit, unit * 7, r, g, b, a);

  // Top horizontal bar
  fillRect(buf, size, size, originX + unit, originY, unit * 3, unit, r, g, b, a);

  // Right side of the bowl (rows 1-2)
  fillRect(buf, size, size, originX + unit * 4, originY + unit, unit, unit * 2, r, g, b, a);

  // Middle horizontal bar (close the bowl)
  fillRect(buf, size, size, originX + unit, originY + unit * 3, unit * 3, unit, r, g, b, a);

  // Diagonal leg
  fillRect(buf, size, size, originX + unit * 2, originY + unit * 4, unit, unit, r, g, b, a);
  fillRect(buf, size, size, originX + unit * 3, originY + unit * 5, unit, unit, r, g, b, a);
  fillRect(buf, size, size, originX + unit * 4, originY + unit * 6, unit, unit, r, g, b, a);
}

// -- Generate an icon ---------------------------------------------------------

function generateIcon(size) {
  const buf = createPixelBuffer(size, size);

  // Draw orange circle
  const cx = Math.floor(size / 2);
  const cy = Math.floor(size / 2);
  const radius = Math.floor(size / 2) - 1;
  fillCircle(buf, size, cx, cy, radius, 0xff, 0x45, 0x00, 0xff);

  // Draw white "R" centered
  const unit = Math.max(1, Math.floor(size / 16));
  const glyphW = unit * 5;
  const glyphH = unit * 7;
  const ox = Math.floor((size - glyphW) / 2);
  const oy = Math.floor((size - glyphH) / 2);
  drawR(buf, size, ox, oy, unit, 0xff, 0xff, 0xff, 0xff);

  return buildPNG(size, size, buf);
}

// -- Main ---------------------------------------------------------------------

const outDir = path.join(__dirname, 'icons');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const sizes = [48, 128];

for (const size of sizes) {
  const png = generateIcon(size);
  const outPath = path.join(outDir, 'icon' + size + '.png');
  fs.writeFileSync(outPath, png);
  console.log('Created ' + outPath + '  (' + png.length + ' bytes, ' + size + 'x' + size + ')');
}

console.log('Done.');
