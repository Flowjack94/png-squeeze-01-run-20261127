// png-squeeze-01 — lossless PNG re-encoder (@flowjack94).
//
// Every 1280x720 RGBA screenshot is re-encoded in the smallest form that
// reproduces it exactly: palette, grey, grey+alpha, RGB or RGBA, with a tRNS
// transparency key when one transparent value covers all transparent pixels.
// Each row's filter is chosen by screening — fixed filters, minimum-sum,
// fewest-distinct byte pairs, or per-row brute force scored with real deflate
// against the previous 32 KiB — and the three best form/filter pairs are
// written at zlib level 9, default and Z_FILTERED strategies, plus the best
// one at level 6. The smallest whole file wins.
// Node 22 stdlib only. Deterministic by construction: fixed effort, no clock,
// no randomness, and no environment reads beyond MAKEFUN_INPUT_DIR /
// MAKEFUN_OUTPUT_DIR.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

// ------------------------------------------------------------- fixed effort
// Every tuning number lives here so the search below reads as one policy:
// screening runs at zlib level 6, brute-force rows are scored at level 4
// against a 32 KiB sliding window, finals are written at level 9, and a
// palette is only tried when the image holds at most 256 distinct colours.
const POLICY = {
  crcPolynomial: 0xedb88320,
  screening: { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
  bruteWindowBytes: 32768,
  bruteLevel: 4,
  bruteMemLevel: 9,
  finalLevel: 9,
  finalMemLevel: 8,
  maxPaletteColours: 256,
};

// ---------------------------------------------------------------- PNG codec
const PNG_MAGIC = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const SAMPLES_PER_PIXEL: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_LOOKUP = (() => {
  const table = new Int32Array(256);
  for (let value = 0; value < 256; value++) {
    let remainder = value;
    for (let bit = 0; bit < 8; bit++) {
      remainder = remainder & 1 ? POLICY.crcPolynomial ^ (remainder >>> 1) : remainder >>> 1;
    }
    table[value] = remainder;
  }
  return table;
})();

function crc32Of(bytes: Uint8Array, from: number, to: number): number {
  let checksum = -1;
  for (let i = from; i < to; i++) {
    checksum = CRC_LOOKUP[(checksum ^ bytes[i]) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ -1) >>> 0;
}

function buildChunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  view.setUint32(8 + payload.length, crc32Of(out, 4, 8 + payload.length));
  return out;
}

function ihdrPayload(width: number, height: number, colourType: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8; // bit depth, always 8 here
  data[9] = colourType;
  // bytes 10-12 (compression, filter, interlace) stay 0.
  return data;
}

function assemblePng(chunks: Array<[string, Uint8Array]>): Uint8Array {
  let total = PNG_MAGIC.length;
  for (const [, payload] of chunks) total += 12 + payload.length;
  const out = new Uint8Array(total);
  out.set(PNG_MAGIC, 0);
  let cursor = PNG_MAGIC.length;
  for (const [type, payload] of chunks) {
    out.set(buildChunk(type, payload), cursor);
    cursor += 12 + payload.length;
  }
  return out;
}

function paethPredictor(left: number, above: number, aboveLeft: number): number {
  const estimate = left + above - aboveLeft;
  const distLeft = Math.abs(estimate - left);
  const distAbove = Math.abs(estimate - above);
  const distDiagonal = Math.abs(estimate - aboveLeft);
  if (distLeft <= distAbove && distLeft <= distDiagonal) return left;
  return distAbove <= distDiagonal ? above : aboveLeft;
}

function applyFilter(kind: number, current: Uint8Array, previous: Uint8Array | null, bpp: number, target: Uint8Array): void {
  const n = current.length;
  if (kind === 0) {
    target.set(current);
    return;
  }
  for (let i = 0; i < n; i++) {
    const left = i >= bpp ? current[i - bpp] : 0;
    const up = previous === null ? 0 : previous[i];
    if (kind === 1) {
      target[i] = current[i] - left;
    } else if (kind === 2) {
      target[i] = current[i] - up;
    } else if (kind === 3) {
      target[i] = current[i] - ((left + up) >> 1);
    } else {
      const upLeft = previous !== null && i >= bpp ? previous[i - bpp] : 0;
      target[i] = current[i] - paethPredictor(left, up, upLeft);
    }
  }
}

// Cost of a filtered row for the minimum-sum heuristic: bytes near 0 are
// cheap, bytes near 128 are expensive, so signed magnitudes are summed.
function smallValueCost(row: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < row.length; i++) {
    const byte = row[i];
    total += byte < 128 ? byte : 256 - byte;
  }
  return total;
}

/** Decode any PNG the contest reads into RGBA (throws on unread input). */
function readPng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || PNG_MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG');
  let cursor = 8;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (cursor < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(cursor);
    const type = String.fromCharCode(bytes[cursor + 4], bytes[cursor + 5], bytes[cursor + 6], bytes[cursor + 7]);
    if (crc32Of(bytes, cursor + 4, cursor + 8 + len) !== view.getUint32(cursor + 8 + len)) throw new Error(type + ' CRC');
    const data = bytes.subarray(cursor + 8, cursor + 8 + len);
    cursor += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else {
      throw new Error('unexpected chunk ' + type);
    }
  }
  if (header === null || !ended || idat.length === 0) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = SAMPLES_PER_PIXEL[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT inflates to the wrong size');
  // Undo the per-row filters to recover the raw sample rows.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paethPredictor(a, b, c);
      }
    } else throw new Error('bad filter type ' + ft);
  }
  // Expand whatever colour type the file used into plain RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
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
    if (palette === null) throw new Error('palette PNG without PLTE');
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ------------------------------------------------------------ image analysis
interface PaletteColour {
  rgba: number[];
  word: number;
  count: number;
}

// View the RGBA bytes as 32-bit words so whole pixels can be counted and
// compared with one map lookup each. Copy first when the view is unaligned.
function asUint32Words(rgba: Uint8Array): Uint32Array {
  const aligned = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.length >>> 2);
}

// One pass over the pixels: is every alpha 255, is every pixel grey, and —
// when the image holds few enough colours — how often each colour appears.
function inspectPixels(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: PaletteColour[] | null } {
  const n = rgba.length >>> 2;
  const words = asUint32Words(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let tooMany = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!tooMany) {
      const colour = words[i];
      const seen = counts.get(colour);
      if (seen === undefined) {
        if (counts.size === POLICY.maxPaletteColours) tooMany = true;
        else counts.set(colour, 1);
      } else counts.set(colour, seen + 1);
    }
  }
  const colours = tooMany
    ? null
    : [...counts.keys()].map((c) => {
        const bytes = new Uint8Array(Uint32Array.of(c).buffer);
        return { rgba: [bytes[0], bytes[1], bytes[2], bytes[3]], word: c, count: counts.get(c) as number };
      });
  return { opaque, grey, colours };
}

/**
 * The one fully transparent value the image may key by tRNS, or null.
 * Valid only when every non-opaque pixel is fully transparent, every
 * transparent pixel shares the same value, and no opaque pixel uses it.
 */
function findTransparencyKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const alpha = rgba[d + 3];
    if (alpha === 255) continue;
    if (alpha !== 0) return null;
    const value = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = value;
    else if (key !== value) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const value = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (value === key) return null;
  }
  return key;
}

// Pull the sample bytes for one colour type out of RGBA (a no-op for RGBA).
function extractSamples(rgba: Uint8Array, colourType: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (colourType === 6) return rgba;
  const channels = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(n * channels);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += channels) {
    if (colourType === 0) {
      out[s] = rgba[d];
    } else if (colourType === 4) {
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

interface CandidateForm {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: Array<number | string>;
}

// Order palette entries so transparent ones come first (opaque last, and
// among transparent ones by rising alpha), then by the chosen key: most
// frequent first, or darkest first by luminance. Ties break on the pixel word
// so the order is fully deterministic.
function sortPalette(colours: PaletteColour[], order: string): PaletteColour[] {
  const luminance = (c: PaletteColour): number => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const xOpaque = x.rgba[3] === 255 ? 1 : 0;
    const yOpaque = y.rgba[3] === 255 ? 1 : 0;
    if (xOpaque !== yOpaque) return xOpaque - yOpaque;
    if (xOpaque === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return luminance(x) - luminance(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

// Build PLTE (+ tRNS when some entries are transparent) and the index map.
function buildPaletteForm(rgba: Uint8Array, colours: PaletteColour[], order: string): { plte: Uint8Array; trns: Uint8Array | null; indices: Uint8Array } {
  const entries = sortPalette(colours, order);
  const index = new Map<number, number>(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparentThrough = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparentThrough = i + 1;
  });
  const trns = transparentThrough === 0 ? null : Uint8Array.from(entries.slice(0, transparentThrough), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const words = asUint32Words(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(words[i]) as number;
  return { plte, trns, indices };
}

// Every exact form this image could be written in, in the order they are
// screened. Palette forms come first when the image is small enough in
// colours (count order, then luminance order); a non-grey image with too many
// colours gets palette forms only. Grey images also get a grey/grey+alpha form.
function candidateForms(rgba: Uint8Array): CandidateForm[] {
  const { opaque, grey, colours } = inspectPixels(rgba);
  const forms: CandidateForm[] = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0]],
      ['luminance', [0, 'minsum', 'brute']],
    ] as Array<[string, Array<number | string>]>) {
      const p = buildPaletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : findTransparencyKey(rgba, grey);
  let colourType: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    colourType = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    colourType = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType] as number;
  forms.push({ colourType, bpp, samples: extractSamples(rgba, colourType), plte: null, trns, filters: [0, 1, 2, 4, 'minsum', 'pairs', 'brute'] });
  return forms;
}

// ------------------------------------------------------------------ filtering
// Count how many distinct adjacent byte pairs a filtered row contains, using
// a stamp array so the counter resets in O(1) per row instead of clearing
// 64 Ki entries.
function countNewPairs(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let fresh = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      fresh++;
    }
  }
  return fresh;
}

// Filter every row of one form's samples under one filter choice. A numeric
// choice applies the same filter to all rows; a named choice picks the best
// filter per row — by minimum signed-magnitude sum, by fewest distinct byte
// pairs, or by brute force: deflate each candidate row against the previous
// window of filtered bytes and keep the shortest. Ties keep the earliest
// filter type, so the choice is deterministic.
function filterImageRows(samples: Uint8Array, width: number, height: number, bpp: number, choice: number | string, raw: Uint8Array): Uint8Array {
  const stride = width * bpp;
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      applyFilter(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - POLICY.bruteWindowBytes), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      applyFilter(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = smallValueCost(trial[t].subarray(1));
      else if (choice === 'pairs') cost = countNewPairs(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(trial[t], before.length === 0 ? { level: POLICY.bruteLevel, memLevel: POLICY.bruteMemLevel } : { level: POLICY.bruteLevel, memLevel: POLICY.bruteMemLevel, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// Bytes the PLTE/tRNS chunks add to a file, on top of the IDAT payload.
const auxiliaryChunkBytes = (form: CandidateForm): number =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

interface Finalist {
  form: CandidateForm;
  choice: number | string;
  data: Uint8Array;
  bytes: number;
}

/**
 * Screen every form/filter choice at zlib level 6 and keep the three
 * smallest (by deflated size plus PLTE/tRNS overhead). The losers' buffers
 * are recycled as scratch so the search allocates almost nothing.
 */
function screenCandidates(rgba: Uint8Array, width: number, height: number): Finalist[] {
  const top: Finalist[] = [];
  let spare: Uint8Array | null = null;
  for (const form of candidateForms(rgba)) {
    const size = height * (width * form.bpp + 1);
    const overhead = auxiliaryChunkBytes(form);
    for (const choice of form.filters) {
      const data = filterImageRows(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : new Uint8Array(size));
      spare = null;
      const zlib = deflateSync(data, POLICY.screening);
      const bytes = zlib.length + overhead;
      const cand: Finalist = { form, choice, data, bytes };
      if (top.length < 3 || bytes < top[top.length - 1].bytes) {
        // Insert sorted by bytes; drop the worst (its buffer becomes the spare).
        let at = top.findIndex((c) => bytes < c.bytes);
        if (at === -1) at = top.length;
        top.splice(at, 0, cand);
        if (top.length > 3) {
          const dropped = top.pop() as Finalist;
          spare = dropped.data;
        }
      } else {
        spare = data;
      }
    }
  }
  return top;
}

function encodeCandidate(width: number, height: number, form: CandidateForm, idat: Uint8Array): Uint8Array {
  const chunks: Array<[string, Uint8Array]> = [['IHDR', ihdrPayload(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return assemblePng(chunks);
}

// ---------------------------------------------------------------------- main
const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  const { width, height, rgba } = readPng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  const finalists = screenCandidates(rgba, width, height);
  // Final write: each of the three screened finalists at zlib level 9,
  // memLevel 8 (measured better than 9 on the big images here), with both
  // the default and Z_FILTERED strategies, plus the best finalist once more
  // at level 6 — level 9 is not always smaller than level 6 on the same
  // data. The smallest whole file is the entry.
  let bestFile: Uint8Array | null = null;
  for (let k = 0; k < finalists.length; k++) {
    const { form, data } = finalists[k];
    for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
      const z = deflateSync(data, { level: POLICY.finalLevel, memLevel: POLICY.finalMemLevel, strategy });
      const file = encodeCandidate(width, height, form, z);
      if (bestFile === null || file.length < bestFile.length) bestFile = file;
    }
    if (k === 0) {
      const z = deflateSync(data, POLICY.screening);
      const file = encodeCandidate(width, height, form, z);
      if (file.length < (bestFile as Uint8Array).length) bestFile = file;
    }
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), bestFile as Uint8Array);
}
