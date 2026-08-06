'use strict';

// Generates icons/app_icon.ico (and icon_256.png) from the same "K" mark the
// browser tab uses, so the installer, the desktop shortcut and the favicon are
// one identity. No image library: PNG is written directly with zlib, and the
// glyph is a straight-line polygon lifted from public/index.html's inline SVG,
// filled by a supersampled scanline pass.
//
//   node scripts/make-icon.js [outputDir]      # default: ../icons

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const GRID = 16;                        // the SVG viewBox the coordinates below live in
const SS = 4;                           // supersampling factor per axis
const BG = [0x14, 0x12, 0x0f, 0xff];    // --bg-deep
const FG = [0xd4, 0xa9, 0x4e, 0xff];    // --accent
const RADIUS = 3;                       // rounded-rect corner radius, in grid units

// M4 3h2v4l4-4h2.5L8 8l4.5 5H10L6 9v4H4z
const GLYPH = [
  [4, 3], [6, 3], [6, 7], [10, 3], [12.5, 3], [8, 8],
  [12.5, 13], [10, 13], [6, 9], [6, 13], [4, 13],
];

/** True when (x,y) — in grid units — is inside the polygon (even-odd rule). */
function insidePolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when (x,y) is inside the rounded square that fills the whole grid. */
function insideRoundedRect(x, y) {
  const near = (v, edge) => (edge === 0 ? v < RADIUS : v > GRID - RADIUS);
  const cx = near(x, 0) ? RADIUS : near(x, 1) ? GRID - RADIUS : null;
  const cy = near(y, 0) ? RADIUS : near(y, 1) ? GRID - RADIUS : null;
  if (cx === null || cy === null) return x >= 0 && x <= GRID && y >= 0 && y <= GRID;
  return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS ** 2;
}

function blend(base, over, alpha) {
  return Math.round(base * (1 - alpha) + over * alpha);
}

/** Renders one square RGBA bitmap of the mark at `size` pixels. */
function renderRgba(size) {
  const px = Buffer.alloc(size * size * 4);
  const step = GRID / (size * SS);
  const samples = SS * SS;
  for (let py = 0; py < size; py++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const gx = (x * SS + sx + 0.5) * step;
          const gy = (py * SS + sy + 0.5) * step;
          if (!insideRoundedRect(gx, gy)) continue;
          bgHits++;
          if (insidePolygon(GLYPH, gx, gy)) fgHits++;
        }
      }
      const offset = (py * size + x) * 4;
      if (!bgHits) continue;                       // fully outside: leave transparent
      const coverage = bgHits / samples;
      const glyph = fgHits / bgHits;               // glyph coverage within the tile body
      px[offset] = blend(BG[0], FG[0], glyph);
      px[offset + 1] = blend(BG[1], FG[1], glyph);
      px[offset + 2] = blend(BG[2], FG[2], glyph);
      px[offset + 3] = Math.round(255 * coverage);
    }
  }
  return px;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Packs PNG frames into an .ico. Windows has read PNG-in-ICO since Vista. */
function encodeIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);
  const directory = Buffer.alloc(16 * frames.length);
  let offset = header.length + directory.length;
  frames.forEach((frame, i) => {
    const entry = directory.subarray(i * 16);
    entry[0] = frame.size >= 256 ? 0 : frame.size; // 0 means 256
    entry[1] = frame.size >= 256 ? 0 : frame.size;
    entry.writeUInt16LE(1, 4);   // colour planes
    entry.writeUInt16LE(32, 6);  // bits per pixel
    entry.writeUInt32LE(frame.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += frame.png.length;
  });
  return Buffer.concat([header, directory, ...frames.map(f => f.png)]);
}

function main() {
  const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'icons'));
  fs.mkdirSync(outDir, { recursive: true });
  const frames = SIZES.map(size => ({ size, png: encodePng(size, renderRgba(size)) }));
  const ico = path.join(outDir, 'app_icon.ico');
  const png = path.join(outDir, 'icon_256.png');
  fs.writeFileSync(ico, encodeIco(frames));
  fs.writeFileSync(png, frames.at(-1).png);
   
  console.log(`Wrote ${ico} (${SIZES.join(', ')}) and ${png}`);
}

if (require.main === module) main();

module.exports = { encodeIco, encodePng, renderRgba, SIZES };
