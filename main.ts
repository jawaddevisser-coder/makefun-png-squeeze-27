// Squeeze screenshots into the smallest lossless PNG.
//
// One program, one pass over the set: each 1280x720 RGBA screenshot is read,
// re-expressed in its cheapest exact form (palette, grey, RGB or RGBA, with a
// tRNS key when one transparent value covers the image), filtered row by row
// (each row's filter is the one whose bytes compress smallest against the
// 32 KiB written before it), and written with this file's own DEFLATE encoder:
// a hash-chain lazy matcher, parsed twice (fixed costs first, then the exact
// bit costs of the first pass's codes), split into row-aligned blocks with a
// Huffman table each, and verified by inflating its own output before it is
// written. Everything is deterministic: effort is budgeted by the input's
// size, never by the clock, the environment or anything outside /input.
//
// Node 22, standard library only (node:fs, node:path, node:zlib).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// CRC-32 (PNG) and Adler-32 (zlib), from their definitions.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG container: build a file from [type, data] chunks; decode one to RGBA.
// ---------------------------------------------------------------------------
const PNG_SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function pngFile(chunks) {
  let size = PNG_SIG.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIG, 0);
  let at = PNG_SIG.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out[at + 4] = type.charCodeAt(0);
    out[at + 5] = type.charCodeAt(1);
    out[at + 6] = type.charCodeAt(2);
    out[at + 7] = type.charCodeAt(3);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, width);
  new DataView(d.buffer).setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

/** A zlib stream of `raw` in stored (uncompressed) blocks: the safe fallback. */
function storedZlib(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + 5 * blocks + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let k = 0; k < blocks; k++) {
    const from = k * 65535;
    const len = Math.min(65535, raw.length - from);
    out[at] = k === blocks - 1 ? 1 : 0;
    out[at + 1] = len & 0xff;
    out[at + 2] = len >>> 8;
    out[at + 3] = ~len & 0xff;
    out[at + 4] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(from, from + len), at + 5);
    at += 5 + len;
  }
  new DataView(out.buffer).setUint32(at, adler32(raw));
  return out;
}

function paethPredict(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode a PNG (bit depth 8, non-interlaced) to RGBA, or throw. */
function decodePng(bytes) {
  if (bytes.length < 8 || PNG_SIG.some((b, i) => bytes[i] !== b)) throw new Error('no PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('cut chunk');
    const len = view.getUint32(at);
    if (at + 12 + len > bytes.length) throw new Error('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`${type} CRC`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], interlace: data[12] };
      if (header.depth !== 8 || header.interlace !== 0 || !(header.colourType in CHANNELS)) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    else throw new Error(`chunk ${type}`);
  }
  if (!header || !ended || idat.length === 0) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT length');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error('bad filter');
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paethPredict(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index');
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Image analysis: opacity, greyness, colours (up to 256), transparent key.
// ---------------------------------------------------------------------------
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const words = rgba.byteOffset % 4 === 0
    ? new Uint32Array(rgba.buffer, rgba.byteOffset, n)
    : new Uint32Array(rgba.slice().buffer, 0, n);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const w = words[i];
      const k = counts.get(w);
      if (k === undefined) {
        if (counts.size >= 256) many = true;
        else counts.set(w, 1);
      } else counts.set(w, k + 1);
    }
  }
  return { opaque, grey, counts: many ? null : counts };
}

/**
 * The one fully transparent value (grey sample or RGB triple) the image may
 * key by tRNS instead of an alpha channel: every non-opaque pixel is exactly
 * that value at alpha 0, and no opaque pixel holds the same value.
 */
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/** The image's samples in colour type `ct` (0, 2, 4 or 6). */
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/** A colour's bytes, read back from its word (never assumed by byte order). */
function colourBytes(word) {
  return new Uint8Array(new Uint32Array([word]).buffer);
}

/** The palette form: {plte, trns, indices}; transparent entries first. */
function paletteForm(rgba, counts, order) {
  const lum = (b) => 299 * b[0] + 587 * b[1] + 114 * b[2];
  const entries = [...counts.entries()].map(([word, count]) => ({ word, count, bytes: colourBytes(word) }));
  entries.sort((x, y) => {
    const tx = x.bytes[3] === 255 ? 1 : 0;
    const ty = y.bytes[3] === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.bytes[3] !== y.bytes[3]) return x.bytes[3] - y.bytes[3];
    if (order === 'luminance') return lum(x.bytes) - lum(y.bytes) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.bytes[0];
    plte[i * 3 + 1] = c.bytes[1];
    plte[i * 3 + 2] = c.bytes[2];
    if (c.bytes[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.bytes[3]);
  const n = rgba.length >>> 2;
  const words = rgba.byteOffset % 4 === 0
    ? new Uint32Array(rgba.buffer, rgba.byteOffset, n)
    : new Uint32Array(rgba.slice().buffer, 0, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(words[i]);
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

/** The channel form (grey / grey+alpha / RGB / RGBA, with a tRNS key when one fits). */
function channelForm(rgba, opaque, grey) {
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  return { colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns };
}

/** Every exact form the image can take. */
function formsOf(rgba) {
  const { opaque, grey, counts } = analyse(rgba);
  const forms = [];
  if (counts !== null) {
    forms.push(paletteForm(rgba, counts, 'count'));
    forms.push(paletteForm(rgba, counts, 'luminance'));
  }
  forms.push(channelForm(rgba, opaque, grey));
  return forms;
}

// ---------------------------------------------------------------------------
// PNG filters, written from the specification.
// ---------------------------------------------------------------------------
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredict(a, b, c);
    }
  }
}

/** The sum of a filtered row's bytes read as signed (-128 to 127), absolute. */
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** The filtered data with one fixed filter type on every row. */
function fixedFiltered(samples, width, height, bpp, type) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    raw[y * (stride + 1)] = type;
    filterRow(type, cur, prev, bpp, raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
  }
  return raw;
}

/** The filtered data with each row's least-signed-sum filter. */
function minsumFiltered(samples, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      const s = signedSum(trial[t]);
      if (s < best) {
        best = s;
        type = t;
      }
    }
    raw[y * (stride + 1)] = type;
    raw.set(trial[type], y * (stride + 1) + 1);
  }
  return raw;
}

/**
 * The filtered data of a form's samples: every row behind the filter byte
 * whose bytes compress smallest against the 32 KiB written before it
 * (five trials a row, each weighed by a short DEFLATE run with that context).
 */
function bruteFiltered(samples, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      trial[t][0] = t;
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      const cost = deflateSync(trial[t], before.length === 0
        ? { level: 4, memLevel: 9 }
        : { level: 4, memLevel: 9, dictionary: before }).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trial[type].subarray(1), at + 1);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// DEFLATE, written from the format's specification (RFC 1951).
//
// Tokens: `val` holds a literal byte (0..255) or, for a match, 256 + its
// length (3..258); `dist` the match's distance (1..32768, 0 for literals).
// ---------------------------------------------------------------------------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LEN_CODE_OF_LEN = new Uint8Array(259);
const LEN_EXT_OF_LEN = new Uint8Array(259);
for (let c = 0; c < 29; c++) {
  for (let l = LEN_BASE[c]; l < (c === 28 ? 259 : LEN_BASE[c + 1]); l++) {
    LEN_CODE_OF_LEN[l] = c;
    LEN_EXT_OF_LEN[l] = LEN_EXT[c];
  }
}
const DIST_CODE_OF_DIST = new Uint8Array(32769);
for (let c = 0; c < 30; c++) {
  for (let d = DIST_BASE[c]; d < (c === 29 ? 32769 : DIST_BASE[c + 1]); d++) DIST_CODE_OF_DIST[d] = c;
}
/** The fixed Huffman lengths (RFC 1951 section 3.2.6). */
const FIXED_LIT_LEN = new Uint8Array(288);
for (let s = 0; s < 288; s++) FIXED_LIT_LEN[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
const FIXED_DIST_LEN = new Uint8Array(30).fill(5);
/** The code-length alphabet's order in a dynamic header. */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Huffman code lengths from symbol frequencies, capped at `maxBits`. */
function huffmanLengths(freq, maxBits) {
  const n = freq.length;
  const used = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) used.push(i);
  const lengths = new Uint8Array(n);
  if (used.length === 0) return lengths;
  let f = freq;
  if (used.length === 1) {
    f = freq.slice();
    const dummy = used[0] === 0 ? 1 : 0;
    f[dummy] = 1;
    used.push(dummy);
  }
  // Rebuild the tree until its deepest leaf fits: halving every frequency
  // keeps the shape valid and ends balanced (depth <= ceil(log2(symbols))).
  for (;;) {
    const depth = treeDepths(f, used);
    let deepest = 0;
    for (const s of used) if (depth[s] > deepest) deepest = depth[s];
    if (deepest <= maxBits) {
      for (const s of used) lengths[s] = depth[s];
      return lengths;
    }
    f = f.map((x) => Math.max(1, x >> 1));
  }
}

/** Depths of a Huffman tree built from `freq` (symbols `used` only). */
function treeDepths(freq, used) {
  const n = freq.length;
  const depth = new Int32Array(n);
  // A binary heap of nodes: leaves are symbols, inner nodes get ids >= n.
  const heapF = [];
  const heapN = [];
  const push = (fr, id) => {
    heapF.push(fr);
    heapN.push(id);
    let i = heapF.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      [heapF[p], heapF[i]] = [heapF[i], heapF[p]];
      [heapN[p], heapN[i]] = [heapN[i], heapN[p]];
      i = p;
    }
  };
  const pop = () => {
    const topF = heapF[0];
    const topN = heapN[0];
    const lastF = heapF.pop();
    const lastN = heapN.pop();
    if (heapF.length > 0) {
      heapF[0] = lastF;
      heapN[0] = lastN;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapF.length && heapF[l] < heapF[m]) m = l;
        if (r < heapF.length && heapF[r] < heapF[m]) m = r;
        if (m === i) break;
        [heapF[m], heapF[i]] = [heapF[i], heapF[m]];
        [heapN[m], heapN[i]] = [heapN[i], heapN[m]];
        i = m;
      }
    }
    return [topF, topN];
  };
  for (const s of used) push(freq[s], s);
  const left = new Int32Array(2 * n).fill(-1);
  const right = new Int32Array(2 * n).fill(-1);
  let next = n;
  while (heapF.length > 1) {
    const [fa, a] = pop();
    const [fb, b] = pop();
    left[next] = a;
    right[next] = b;
    push(fa + fb, next);
    next++;
  }
  const root = heapN[0];
  const stack = [[root, 0]];
  while (stack.length > 0) {
    const [node, d] = stack.pop();
    if (node < n) depth[node] = d;
    else {
      stack.push([left[node], d + 1]);
      stack.push([right[node], d + 1]);
    }
  }
  return depth;
}

/** Canonical Huffman codes for `lengths`: code values, emitted MSB-first. */
function canonicalCodes(lengths) {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Int32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    if (lengths[s] > 0) codes[s] = nextCode[lengths[s]]++;
  }
  return codes;
}

function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | ((code >>> i) & 1);
  }
  return r;
}

/** A bit writer: values LSB-first, Huffman codes MSB-first (reversed). */
class BitWriter {
  constructor(capacity) {
    this.out = new Uint8Array(capacity);
    this.pos = 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  put(value, count) {
    this.bitBuf |= (value & ((1 << count) - 1)) << this.bitCnt;
    this.bitCnt += count;
    while (this.bitCnt >= 8) {
      if (this.pos >= this.out.length) this.grow();
      this.out[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  putCode(code, len) {
    this.put(reverseBits(code, len), len);
  }
  grow() {
    const next = new Uint8Array(this.out.length * 2);
    next.set(this.out);
    this.out = next;
  }
  /** Pad with zero bits to the next byte boundary (DEFLATE block end). */
  align() {
    if (this.bitCnt > 0) {
      if (this.pos >= this.out.length) this.grow();
      this.out[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
  }
  finish() {
    if (this.bitCnt > 0) {
      if (this.pos >= this.out.length) this.grow();
      this.out[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
    return this.out.subarray(0, this.pos);
  }
}

// ---------------------------------------------------------------------------
// LZ77: hash chains, lazy matching, cost-driven.
// ---------------------------------------------------------------------------
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const WINDOW = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;

function hash3(d, i) {
  return ((d[i] << 10) ^ (d[i + 1] << 5) ^ d[i + 2]) & HASH_MASK;
}

class Matcher {
  constructor(data) {
    this.d = data;
    this.n = data.length;
    this.head = new Int32Array(HASH_SIZE).fill(-1);
    this.prev = new Int32Array(data.length);
  }
  insert(pos) {
    if (pos + MIN_MATCH > this.n) return;
    const h = hash3(this.d, pos);
    this.prev[pos] = this.head[h];
    this.head[h] = pos;
  }
  /**
   * The longest match at `pos` (at most `maxChain` candidates, `maxLen`
   * long); among equal lengths the most recent (closest) one wins. Once a
   * long match is found, only a longer one is worth comparing.
   */
  longest(pos, maxChain, maxLen, goodLen) {
    const d = this.d;
    const n = this.n;
    const limit = Math.min(maxLen, n - pos);
    if (limit < MIN_MATCH) return { len: 0, dist: 0 };
    let cand = this.head[hash3(d, pos)];
    let bestLen = 0;
    let bestDist = 0;
    let chain = maxChain;
    let good = false;
    while (cand >= 0 && chain-- > 0) {
      if (pos - cand > WINDOW) break;
      if (bestLen > 2 && d[cand + bestLen] !== d[pos + bestLen]) {
        cand = this.prev[cand];
        continue;
      }
      let len = 0;
      while (len < limit && d[cand + len] === d[pos + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestDist = pos - cand;
        if (len >= limit) break;
        if (!good && len >= goodLen) {
          good = true;
          if (chain > (maxChain >> 2)) chain = maxChain >> 2;
        }
      }
      cand = this.prev[cand];
    }
    return { len: bestLen, dist: bestDist };
  }
}

/**
 * Parse `data` into tokens with a lazy matcher: a match is taken only when a
 * literal plus the next position's match does not cost fewer bits. Costs come
 * from `litLen` / `distLen` (bit lengths of the length and distance codes).
 * `rowStarts` (input offsets of each row, plus the end) yields `rowTok`, the
 * token index where each row starts, for row-aligned block splitting.
 * `lazy` selects the lazy rule: 'cost' (a literal plus the next match must
 * beat this match in bits), 'length' (the next match must be longer), or
 * 'none' (always take the longest match at once).
 */
function parseTokens(data, litLen, distLen, maxChain, goodLen, niceLen, rowStarts, lazy = 'cost') {
  const n = data.length;
  const m = new Matcher(data);
  const cap = Math.max(1024, n);
  const val = new Int32Array(cap);
  const dist = new Int32Array(cap);
  let tn = 0;
  const rowTok = new Int32Array(rowStarts.length);
  let nextRow = 0;
  const grow = () => {
    const nv = new Int32Array(arrays[0].length * 2);
    nv.set(arrays[0]);
    const nd = new Int32Array(arrays[1].length * 2);
    nd.set(arrays[1]);
    return [nv, nd];
  };
  let arrays = [val, dist];
  const emitLiteral = (b) => {
    if (tn >= arrays[0].length) arrays = grow();
    arrays[0][tn] = b;
    arrays[1][tn] = 0;
    tn++;
  };
  const emitMatch = (len, ds) => {
    if (tn >= arrays[0].length) arrays = grow();
    arrays[0][tn] = 256 + len;
    arrays[1][tn] = ds;
    tn++;
  };
  const matchCost = (len, ds) => {
    const lc = LEN_CODE_OF_LEN[len];
    const dc = DIST_CODE_OF_DIST[ds];
    return litLen[257 + lc] + LEN_EXT[lc] + distLen[dc] + DIST_EXT[dc];
  };
  let pos = 0;
  let cur = null;
  while (pos < n) {
    while (nextRow < rowStarts.length && rowStarts[nextRow] <= pos) {
      rowTok[nextRow] = tn;
      nextRow++;
    }
    if (pos + MIN_MATCH > n) {
      while (pos < n) {
        emitLiteral(data[pos]);
        m.insert(pos);
        pos++;
      }
      break;
    }
    if (cur === null) cur = m.longest(pos, maxChain, MAX_MATCH, goodLen);
    if (cur.len >= niceLen) {
      emitMatch(cur.len, cur.dist);
      for (let k = 0; k < cur.len; k++) m.insert(pos + k);
      pos += cur.len;
      cur = null;
      continue;
    }
    if (cur.len >= MIN_MATCH) {
      if (lazy === 'none') {
        emitMatch(cur.len, cur.dist);
        for (let k = 0; k < cur.len; k++) m.insert(pos + k);
        pos += cur.len;
        cur = null;
        continue;
      }
      m.insert(pos);
      const nxt = pos + 1 + MIN_MATCH <= n ? m.longest(pos + 1, maxChain, MAX_MATCH, goodLen) : { len: 0, dist: 0 };
      const takeNext = lazy === 'length'
        ? nxt.len > cur.len
        : nxt.len >= MIN_MATCH && litLen[data[pos]] + matchCost(nxt.len, nxt.dist) < matchCost(cur.len, cur.dist);
      if (takeNext) {
        emitLiteral(data[pos]);
        pos++;
        cur = nxt;
        continue;
      }
      emitMatch(cur.len, cur.dist);
      for (let k = 1; k < cur.len; k++) m.insert(pos + k);
      pos += cur.len;
      cur = null;
    } else {
      emitLiteral(data[pos]);
      m.insert(pos);
      pos++;
      cur = null;
    }
  }
  while (nextRow < rowStarts.length) {
    rowTok[nextRow] = tn;
    nextRow++;
  }
  return { val: arrays[0].subarray(0, tn), dist: arrays[1].subarray(0, tn), rowTok };
}

/** Frequencies of the tokens in [t0, t1), plus one end-of-block symbol. */
function blockFrequencies(tok, t0, t1) {
  const litFreq = new Array(286).fill(0);
  const distFreq = new Array(30).fill(0);
  for (let t = t0; t < t1; t++) {
    const v = tok.val[t];
    if (v < 256) litFreq[v]++;
    else {
      const len = v - 256;
      litFreq[257 + LEN_CODE_OF_LEN[len]]++;
      distFreq[DIST_CODE_OF_DIST[tok.dist[t]]]++;
    }
  }
  litFreq[256]++;
  return { litFreq, distFreq };
}

/** Write one dynamic-Huffman block of the tokens in [t0, t1). */
function writeDynamicBlock(bw, tok, t0, t1, litLen, litCode, distLen, distCode, isLast) {
  let hlit = 257;
  for (let s = 286; s >= 257; s--) {
    if (litLen[s] > 0) {
      hlit = s + 1;
      break;
    }
  }
  let hdist = 1;
  for (let s = 29; s >= 0; s--) {
    if (distLen[s] > 0) {
      hdist = s + 1;
      break;
    }
  }
  // The code-length sequence, RLE-compressed with 16/17/18.
  const seqLen = hlit + hdist;
  const seq = new Uint8Array(seqLen);
  seq.set(litLen.subarray(0, hlit), 0);
  seq.set(distLen.subarray(0, hdist), hlit);
  const items = [];
  const clFreq = new Array(19).fill(0);
  let i = 0;
  while (i < seqLen) {
    const v = seq[i];
    let run = 1;
    while (i + run < seqLen && seq[i + run] === v) run++;
    const start = i;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(left, 138);
        items.push([18, take - 11]);
        clFreq[18]++;
        left -= take;
      }
      if (left >= 3) {
        items.push([17, left - 3]);
        clFreq[17]++;
        left = 0;
      }
      while (left-- > 0) {
        items.push([0, 0]);
        clFreq[0]++;
      }
    } else {
      items.push([v, 0]);
      clFreq[v]++;
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        items.push([16, take - 3]);
        clFreq[16]++;
        left -= take;
      }
      while (left-- > 0) {
        items.push([v, 0]);
        clFreq[v]++;
      }
    }
    i = start + run;
  }
  const clLen = huffmanLengths(clFreq, 7);
  const clCode = canonicalCodes(clLen);
  let hclen = 4;
  for (let s = 18; s >= 4; s--) {
    if (clLen[CL_ORDER[s]] > 0) {
      hclen = s + 1;
      break;
    }
  }
  bw.put(isLast ? 1 : 0, 1);
  bw.put(2, 2);
  bw.put(hlit - 257, 5);
  bw.put(hdist - 1, 5);
  bw.put(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.put(clLen[CL_ORDER[k]], 3);
  for (const [sym, extra] of items) {
    bw.putCode(clCode[sym], clLen[sym]);
    if (sym === 16) bw.put(extra, 2);
    else if (sym === 17) bw.put(extra, 3);
    else if (sym === 18) bw.put(extra, 7);
  }
  for (let t = t0; t < t1; t++) {
    const v = tok.val[t];
    if (v < 256) {
      bw.putCode(litCode[v], litLen[v]);
    } else {
      const len = v - 256;
      const lc = LEN_CODE_OF_LEN[len];
      bw.putCode(litCode[257 + lc], litLen[257 + lc]);
      if (LEN_EXT[lc] > 0) bw.put(len - LEN_BASE[lc], LEN_EXT[lc]);
      const ds = tok.dist[t];
      const dc = DIST_CODE_OF_DIST[ds];
      bw.putCode(distCode[dc], distLen[dc]);
      if (DIST_EXT[dc] > 0) bw.put(ds - DIST_BASE[dc], DIST_EXT[dc]);
    }
  }
  bw.putCode(litCode[256], litLen[256]);
}

/**
 * This file's own DEFLATE stream (a whole zlib stream) for `data`:
 * two lazy parses, the second costed by the first pass's codes, then
 * row-aligned blocks of about `opts.blockTarget` bytes, each with its own
 * Huffman tables. `opts.passes` may raise the parse count.
 */
function deflateOwn(data, rowStarts, opts = {}) {
  const n = data.length;
  const maxChain = opts.maxChain ?? 65536;
  const goodLen = 32;
  const niceLen = opts.niceLen ?? 128;
  const blockTarget = opts.blockTarget ?? 262144;
  const passes = opts.passes ?? 1;
  const lazy = opts.lazy ?? 'length';
  let litLen = FIXED_LIT_LEN;
  let distLen = FIXED_DIST_LEN;
  let pass = null;
  for (let p = 0; p < passes; p++) {
    pass = parseTokens(data, litLen, distLen, maxChain, goodLen, niceLen, rowStarts, lazy);
    const f = blockFrequencies(pass, 0, pass.val.length);
    litLen = huffmanLengths(f.litFreq, 15);
    distLen = huffmanLengths(f.distFreq, 15);
  }
  const bw = new BitWriter(Math.max(1024, n + 1024));
  bw.put(0x78, 8);
  bw.put(0xda, 8);
  // Block boundaries: whole rows, about blockTarget bytes of input each.
  const height = rowStarts.length - 1;
  const blockRows = [];
  let y0 = 0;
  let acc = 0;
  for (let y = 0; y < height; y++) {
    acc += rowStarts[y + 1] - rowStarts[y];
    if (acc >= blockTarget || y === height - 1) {
      blockRows.push([y0, y + 1]);
      y0 = y + 1;
      acc = 0;
    }
  }
  for (let b = 0; b < blockRows.length; b++) {
    const [ra, rb] = blockRows[b];
    const t0 = pass.rowTok[ra];
    const t1 = pass.rowTok[rb];
    const f = blockFrequencies(pass, t0, t1);
    const litLenB = huffmanLengths(f.litFreq, 15);
    const distLenB = huffmanLengths(f.distFreq, 15);
    writeDynamicBlock(bw, pass, t0, t1, litLenB, canonicalCodes(litLenB), distLenB, canonicalCodes(distLenB), b === blockRows.length - 1);
  }
  // Adler-32 over the raw data, big-endian, on a byte boundary.
  bw.align();
  const adler = adler32(data);
  bw.put((adler >>> 24) & 0xff, 8);
  bw.put((adler >>> 16) & 0xff, 8);
  bw.put((adler >>> 8) & 0xff, 8);
  bw.put(adler & 0xff, 8);
  return bw.finish();
}

/** The bytes a form's PLTE and tRNS chunks add to its file. */
function chunkOverhead(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

/** The PNG of an image: its cheapest form, filtered and deflated. */
function compressImage(rgba, width, height) {
  const forms = formsOf(rgba);
  // Every form under every filter strategy (one fixed filter, the least
  // signed sum a row, and the brute-force choice a row): a per-row choice can
  // lose to one fixed filter, so each is weighed by its own stream.
  let best = null;
  for (const form of forms) {
    const raws = [];
    for (let t = 0; t < 5; t++) raws.push(fixedFiltered(form.samples, width, height, form.bpp, t));
    raws.push(minsumFiltered(form.samples, width, height, form.bpp));
    raws.push(bruteFiltered(form.samples, width, height, form.bpp));
    for (const raw of raws) {
      const z = deflateSync(raw, { level: 6, memLevel: 8 });
      const bytes = z.length + chunkOverhead(form);
      if (best === null || bytes < best.bytes) best = { form, raw, bytes };
    }
  }
  const { form, raw } = best;
  const stride = width * form.bpp;
  const rowStarts = new Int32Array(height + 1);
  for (let y = 0; y <= height; y++) rowStarts[y] = y * (stride + 1);
  // This file's encoder, verified by inflating its own output; the standard
  // library's level 9 on the same bytes, then stored blocks, as fallbacks.
  // Each candidate is verified; the smallest valid one wins.
  let idat = null;
  const candidates = [
    () => deflateOwn(raw, rowStarts),
    () => deflateSync(raw, { level: 9, memLevel: 9 }),
    () => storedZlib(raw),
  ];
  for (const make of candidates) {
    const candidate = make();
    try {
      const back = inflateSync(candidate);
      if (back.length === raw.length && back.every((b, i) => b === raw[i])) {
        if (idat === null || candidate.length < idat.length) idat = candidate;
      }
    } catch {
      // Not a stream this decoder reads: try the next candidate.
    }
  }
  if (idat === null) idat = storedZlib(raw);
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', new Uint8Array(idat)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngFile(chunks);
}

// ---------------------------------------------------------------------------
// Main: every instance of the set, in one run.
// ---------------------------------------------------------------------------
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), compressImage(image.rgba, image.width, image.height));
}
