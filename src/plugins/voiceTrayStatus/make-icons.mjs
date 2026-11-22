// Regenerates the tray glyphs: node make-icons.mjs [--preview]
// Shapes come from measured reference art (@4x = 64px), doubled onto this 128px grid.
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = join(fileURLToPath(import.meta.url), '..');
const SS = 128;             // supersample grid
const OUT = 32;             // shipped tray size
const SCALE = SS / OUT;
const AA = 1.4;             // feather width in grid px

// Fluxer palette (splash tokens) plus the shared "off" red.
const BRAND = [0x46, 0x41, 0xd9];
const BRAND_BRIGHT = [0x74, 0x6f, 0xff];   // speaking: separated by lightness, not transparency
const DEEP = [0x35, 0x30, 0xb4];
const SOFT = [0xc9, 0xc7, 0xff];
const WHITE = [0xff, 0xff, 0xff];
const RED = [0xf0, 0x47, 0x47];
// Lifted off the measured speaking green so it sits with the brighter fill.
const VOICE_GREEN = [0x43, 0xd1, 0x8f];

const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const ring = (x, y, cx, cy, r, w) => Math.abs(circle(x, y, cx, cy, r)) - w / 2;
const segment = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
};
const roundRect = (x, y, x0, y0, x1, y1, r) => {
  const qx = Math.abs(x - (x0 + x1) / 2) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(y - (y0 + y1) / 2) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const arc = (x, y, cx, cy, r, w, a0, a1) => {          // degrees, y-down; a1 may pass 360
  let a = Math.atan2(y - cy, x - cx) * 180 / Math.PI;
  if (a < 0) a += 360;
  if (a < a0) a += 360;                    // angles below horizontal read past the wrap
  return (a >= a0 && a <= a1) ? ring(x, y, cx, cy, r, w) : Infinity;
};

// Shine: arc at radius 26.7, centred upper-left as measured.
const shine = (x, y) => arc(x, y, 64, 64, 26.7, 5.4, 195, 265);

// Mic: capsule plus cradle bowl; nothing joins them, which is what makes it read cleanly.
// Capsule reaches the top border so the glyph fills the icon like the discs do.
function mic(x, y) {
  return Math.min(
    roundRect(x, y, 46, 13, 82, 74, 17),                 // capsule
    arc(x, y, 64, 60, 36, 16, 15, 165),                  // cradle (U): bowl band across grid y≈88–104
    segment(x, y, 64, 100, 64, 116) - 7);                // stem, hanging below that band
}

// Deafened headphones: band ends curve down into the cups so no notch shows.
// DY lifts or drops the whole glyph; set from measured margins (1 icon row = 3.5 grid px).
let DY = 1.5;
function headphones(x, y) {
  const cy = 62 + DY, top = 63 + DY;
  return Math.min(
    arc(x, y, 64, cy, 44, 8, 170, 370),                 // headband; ends buried in the cup tops
    roundRect(x, y, 12, top, 42, top + 47, 13),          // left cup
    roundRect(x, y, 86, top, 116, top + 47, 13));        // right cup
}

// Slash measured ~1.7px@64 at the source size; SLASH_W is the half band in grid px (1 icon col = 3.5).
const SLASH_W = 4.4;
const slash = (x, y) => segment(x, y, 20, 112, 110, 22) - SLASH_W;

const STATES = {
  // Low alpha dims a bright hue but turns dark blue muddy, so connected stays solid and
  // differs from speaking by lightness alone.
  connected: { discR: 46.6, col: BRAND, alpha: 1, rimW: 5.6, shineAlpha: 0.7 },
  // Two near-identical blues read as one state at tray size; the ring carries the difference.
  speaking:  { discR: 54.6, col: BRAND_BRIGHT, alpha: 1, outlineW: 5.0, outlineCol: VOICE_GREEN, shineAlpha: 1 },
  muted:     { glyph: mic },
  deafened:  { glyph: headphones },
};

// Reference disc spans 87.5% of its canvas; Fluxer's logo fills the box, so zoom to match sizes.
const ZOOM = 100 / 87.5;

function draw(state, unread) {
  const cfg = STATES[state];
  const px = new Float64Array(SS * SS * 4);
  for (let y = 0; y < SS; y++) for (let x = 0; x < SS; x++) {
    const i = (y * SS + x) * 4;
    // Sample inward so measured shapes grow by ZOOM around the centre.
    const sx = (x + 0.5 - 64) / ZOOM + 64, sy = (y + 0.5 - 64) / ZOOM + 64;
    if (cfg.discR) {
      put(px, i, circle(sx, sy, 64, 64, cfg.discR), cfg.col, cfg.alpha);
      if (cfg.rimW) put(px, i, ring(sx, sy, 64, 64, 51.8, cfg.rimW), DEEP);
      // Inset, so the outline keeps the measured diameter instead of adding half a stroke.
      if (cfg.outlineW) put(px, i, ring(sx, sy, 64, 64, cfg.discR - cfg.outlineW / 2, cfg.outlineW), cfg.outlineCol);
    }
    if (cfg.discR) put(px, i, shine(sx, sy), SOFT, cfg.shineAlpha);
    if (cfg.glyph) put(px, i, cfg.glyph(sx, sy), WHITE);
    if (cfg.glyph) put(px, i, slash(sx, sy), RED);
    if (unread) put(px, i, dot(x, y), RED);
  }
  return downsample(px);
}

function put(px, i, dist, color, alpha = 1) {   // source-over onto the pixel so far
  if (dist > AA) return;
  const a = Math.min(1, Math.max(0, (AA - dist) / AA)) * alpha;
  px[i] += (color[0] - px[i]) * a;
  px[i + 1] += (color[1] - px[i + 1]) * a;
  px[i + 2] += (color[2] - px[i + 2]) * a;
  px[i + 3] += (255 - px[i + 3]) * a;
}

function downsample(src) {
  const out = Buffer.alloc(OUT * OUT * 4);
  for (let y = 0; y < OUT; y++) for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
      const i = ((y * SCALE + dy) * SS + x * SCALE + dx) * 4;
      r += src[i] * src[i + 3]; g += src[i + 1] * src[i + 3]; b += src[i + 2] * src[i + 3]; a += src[i + 3];
    }
    const o = (y * OUT + x) * 4;
    out[o] = a ? r / a : 0; out[o + 1] = a ? g / a : 0; out[o + 2] = a ? b / a : 0; out[o + 3] = a / (SCALE * SCALE);
  }
  return out;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
  return Buffer.concat([head, Buffer.from(type), data, crc]);
}
function encodePNG(pixels, w, h) {
  const stride = w * 4 + 1, raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) pixels.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4); // filter 0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // RGBA8
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function preview(pixels) {
  const ramp = ' ·:+#*%@&';
  const lines = [];
  for (let y = 0; y < OUT; y++) {
    let row = '';
    for (let x = 0; x < OUT; x++) {
      const i = (y * OUT + x) * 4, a = pixels[i + 3] / 255;
      const lum = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 765;
      row += a < 0.2 ? ' ' : ramp[Math.min(8, Math.round(a * lum * 8))];
    }
    lines.push(row);
  }
  return lines.join('\n');
}

mkdirSync(join(DIR, 'assets'), { recursive: true });
for (const state of Object.keys(STATES)) {
  const pixels = draw(state, false);
  writeFileSync(join(DIR, 'assets', `${state}.png`), encodePNG(pixels, OUT, OUT));
  console.log(`${state}.png written` + (process.argv[2] === '--preview' ? `\n${preview(pixels)}\n` : ''));
}
// The unread dot is composited at runtime by index.js, so no -unread variants exist here.
