// sevenz.js — streaming 7z reader for webasm_nup (DOM-free).
//
// Like zip.js, only metadata is read up front; file data is streamed
// per file through the packer's chunk iterator. The 7z header lives at
// the END of the archive (the signature header points at it) and is
// usually itself LZMA/LZMA2-compressed (kEncodedHeader), so opening an
// archive first decodes the header, then builds the file list from
// StreamsInfo + FilesInfo.
//
// Supported folder coders: Copy, LZMA, LZMA2, and Delta (as a filter
// in front of LZMA/LZMA2). LZMA/LZMA2 decode in lzma.wasm (LZMA SDK,
// public domain); Delta is a few lines of JS. Solid archives are
// decoded once per folder, then cached in browser temporary storage
// (OPFS), with a bounded Blob fallback when OPFS is unavailable. File reads and packer repasses reuse
// the cache. Call dispose() on the returned archive when removing it.
//
// Not supported, with a clear error naming the coder: BCJ/BCJ2 filters,
// PPMd, BZip2, Deflate, AES encryption (including encrypted headers),
// multi-output folders, multi-packed-stream folders, and external
// (stream-backed) folders/names. Split archives (.7z.001) are not
// supported — the first volume alone is not a complete archive.
//
// Format reference: 7-Zip's DOC/7zFormat.txt (varint encoding, property
// IDs, folder/coder layout). Header CRCs (signature + next-header) are
// verified; per-file CRCs from FilesInfo are verified on decode.

import { CHUNK } from "./packer.js";
import { crc32Update, crc32Final } from "./zip.js";

const SIG = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
const ID_END = 0x00, ID_HEADER = 0x01, ID_ARCHIVE_PROPERTIES = 0x02;
const ID_ADDITIONAL_STREAMS = 0x03, ID_MAIN_STREAMS = 0x04, ID_FILES_INFO = 0x05;
const ID_PACK_INFO = 0x06, ID_UNPACK_INFO = 0x07, ID_SUB_STREAMS = 0x08;
const ID_SIZE = 0x09, ID_CRC = 0x0a, ID_FOLDER = 0x0b, ID_CODERS_UNPACK_SIZE = 0x0c;
const ID_NUM_UNPACK_STREAM = 0x0d, ID_EMPTY_STREAM = 0x0e, ID_EMPTY_FILE = 0x0f;
const ID_ANTI = 0x10, ID_NAME = 0x11, ID_ENCODED_HEADER = 0x17;

// Coder IDs (as byte sequences, per 7zFormat / 7-Zip).
const CODER_COPY = "00";
const CODER_LZMA = "030101";
const CODER_LZMA2 = "21";
const CODER_DELTA = "03";
const CODER_BCJ_X86 = "03030103";
const CODER_AES = "06f10701";
const UNSUPPORTED_CODERS = {
  "03030105": "BCJ (ARM)", "03030107": "BCJ (ARM-Thumb)",
  "03030109": "BCJ (IA-64)", "0303010b": "BCJ (PPC)", "0303010d": "BCJ (SPARC)",
  "0303011b": "BCJ2", "030401": "PPMd", "040202": "BZip2", "040108": "Deflate",
  "06f10701": "AES-256 (encrypted)",
};
function hex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""); }

class Reader {
  constructor(buf, base = 0) { this.buf = buf; this.pos = base; this.end = buf.length; }
  u8() {
    if (this.pos >= this.end) throw new Error("7z: unexpected end of header (truncated archive?)");
    return this.buf[this.pos++];
  }
  bytes(n) {
    if (this.pos + n > this.end) throw new Error("7z: unexpected end of header (truncated archive?)");
    const r = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return r;
  }
  u32le() {
    const b = this.bytes(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  u64le() {
    const b = this.bytes(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("7z: 64-bit value too large to handle");
    return Number(v);
  }
  // 7z varint: leading 1-bits of the first byte count the extra bytes.
  // The extra bytes are LITTLE-endian: the first byte holds the HIGH
  // bits, the following bytes the low bits in increasing significance.
  // (Getting this backwards only shows up for values >= 16384, which is
  // why small fixtures pass and large PackPos values don't.)
  varint() {
    const first = this.u8();
    let mask = 0x80;
    let extra = 0;
    while (mask && (first & mask)) { extra++; mask >>= 1; }
    if (extra === 0) return first;
    let v = 0n;
    for (let i = 0; i < extra; i++) v |= BigInt(this.u8()) << BigInt(8 * i);
    if (extra < 7) v |= BigInt(first & (0xff >> (extra + 1))) << BigInt(8 * extra);
    // extra == 7 (0xFE) and extra == 8 (0xFF) carry no high bits in the
    // first byte; the value is exactly the extra bytes, little-endian.
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("7z: 64-bit value too large to handle");
    return Number(v);
  }
  // Bit vector, MSB-first within each byte (7z's convention).
  bits(count) {
    const out = new Array(count).fill(false);
    let byte = 0, bitsLeft = 0;
    for (let i = 0; i < count; i++) {
      if (bitsLeft === 0) { byte = this.u8(); bitsLeft = 8; }
      out[i] = (byte & 0x80) !== 0;
      byte = (byte << 1) & 0xff; bitsLeft--;
    }
    return out;
  }
}

// Digests: AllAreDefined byte, optional bit vector, CRCs for defined.
function readDigests(r, count) {
  const all = r.u8();
  if (all === 1) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(r.u32le());
    return out;
  }
  if (all !== 0) throw new Error("7z: bad digests AllAreDefined byte");
  const defined = r.bits(count);
  const out = new Array(count).fill(null);
  for (let i = 0; i < count; i++) if (defined[i]) out[i] = r.u32le();
  return out;
}

function parseFolder(r) {
  const numCoders = r.varint();
  const coders = [];
  let totalIn = 0, totalOut = 0;
  for (let i = 0; i < numCoders; i++) {
    const flags = r.u8();
    const idSize = flags & 0x0f;
    const isComplex = (flags & 0x10) !== 0;
    const hasAttrs = (flags & 0x20) !== 0;
    if (flags & 0x80) throw new Error("7z: folder coder with alternative methods is not supported");
    if (idSize === 0) throw new Error("7z: folder coder with empty method ID");
    const id = hex(r.bytes(idSize));
    let numIn = 1, numOut = 1, attrs = null;
    if (isComplex) { numIn = r.varint(); numOut = r.varint(); }
    if (hasAttrs) { const n = r.varint(); attrs = r.bytes(n); }
    coders.push({ id, numIn, numOut, attrs });
    totalIn += numIn; totalOut += numOut;
  }
  const numBind = totalOut - 1;
  const binds = [];
  for (let i = 0; i < numBind; i++) binds.push({ in: r.varint(), out: r.varint() });
  const numPacked = totalIn - numBind;
  let packedIndices = null;
  if (numPacked > 1) {
    packedIndices = [];
    for (let i = 0; i < numPacked; i++) packedIndices.push(r.varint());
  }
  return { coders, binds, numPacked, packedIndices, totalIn, totalOut };
}

function parseStreamsInfo(r) {
  const info = { packPos: null, packSizes: [], folders: [], folderUnpackSizes: [], numPerFolder: null, subSizes: null, subCrcs: null };
  for (;;) {
    const id = r.u8();
    if (id === ID_END) break;
    if (id === ID_PACK_INFO) {
      info.packPos = r.varint();
      const numPack = r.varint();
      let next = r.u8();
      if (next === ID_SIZE) {
        for (let i = 0; i < numPack; i++) info.packSizes.push(r.varint());
        next = r.u8();
      }
      if (next === ID_CRC) {
        readDigests(r, numPack);
        next = r.u8();
      }
      if (next !== ID_END) throw new Error("7z: bad PackInfo terminator");
    } else if (id === ID_UNPACK_INFO) {
      const fid = r.u8();
      if (fid !== ID_FOLDER) throw new Error("7z: UnpackInfo without Folder section");
      const numFolders = r.varint();
      const external = r.u8();
      if (external !== 0) throw new Error("7z: external folders are not supported");
      for (let i = 0; i < numFolders; i++) info.folders.push(parseFolder(r));
      const sid = r.u8();
      if (sid !== ID_CODERS_UNPACK_SIZE) throw new Error("7z: UnpackInfo without CodersUnpackSize");
      for (const f of info.folders) {
        const sizes = [];
        for (let i = 0; i < f.totalOut; i++) sizes.push(r.varint());
        f.unpackSizes = sizes;
      }
      let next = r.u8();
      if (next === ID_CRC) {
        const digests = readDigests(r, numFolders);
        info.folders.forEach((f, i) => { f.crc = digests[i]; });
        next = r.u8();
      }
      if (next !== ID_END) throw new Error("7z: bad UnpackInfo terminator");
    } else if (id === ID_SUB_STREAMS) {
      let next = r.u8();
      if (next === ID_NUM_UNPACK_STREAM) {
        info.numPerFolder = [];
        for (let i = 0; i < info.folders.length; i++) info.numPerFolder.push(r.varint());
        next = r.u8();
      }
      if (next === ID_SIZE) {
        const totalSub = (info.numPerFolder || info.folders.map(() => 1)).reduce((a, b) => a + b, 0);
        const count = totalSub - info.folders.length;
        info.subSizes = [];
        for (let i = 0; i < count; i++) info.subSizes.push(r.varint());
        next = r.u8();
      }
      if (next === ID_CRC) {
        const totalSub = (info.numPerFolder || info.folders.map(() => 1)).reduce((a, b) => a + b, 0);
        const per = info.numPerFolder || info.folders.map(() => 1);
        const count = per.reduce((n, count, i) => n + (count === 1 && info.folders[i].crc != null ? 0 : count), 0);
        const digests = readDigests(r, count);
        let j = 0;
        info.subCrcs = per.flatMap((count, i) => count === 1 && info.folders[i].crc != null
          ? [info.folders[i].crc] : Array.from({ length: count }, () => digests[j++]));
        next = r.u8();
      }
      if (next !== ID_END) throw new Error("7z: bad SubStreamsInfo terminator");
    } else {
      throw new Error(`7z: unexpected StreamsInfo section 0x${id.toString(16)}`);
    }
  }
  return info;
}

function parseFilesInfo(r) {
  const numFiles = r.varint();
  const files = Array.from({ length: numFiles }, () => ({
    name: null, emptyStream: false, emptyFile: false, anti: false, crc: null,
  }));
  for (;;) {
    const type = r.u8();
    if (type === ID_END) break;
    const size = r.varint();
    const data = new Reader(r.bytes(size));
    if (type === ID_EMPTY_STREAM) {
      const bits = data.bits(numFiles);
      files.forEach((f, i) => { f.emptyStream = bits[i]; });
    } else if (type === ID_EMPTY_FILE) {
      const nEmpty = files.filter((f) => f.emptyStream).length;
      const bits = data.bits(nEmpty);
      let j = 0;
      files.forEach((f) => { if (f.emptyStream) f.emptyFile = bits[j++]; });
    } else if (type === ID_ANTI) {
      const nEmpty = files.filter((f) => f.emptyStream).length;
      const bits = data.bits(nEmpty);
      let j = 0;
      files.forEach((f) => { if (f.emptyStream) f.anti = bits[j++]; });
    } else if (type === ID_NAME) {
      const external = data.u8();
      if (external !== 0) throw new Error("7z: external file names are not supported");
      const dec = new TextDecoder("utf-16le");
      for (const f of files) {
        const bytes = [];
        for (;;) {
          const lo = data.u8(), hi = data.u8();
          if (lo === 0 && hi === 0) break;
          bytes.push(lo, hi);
        }
        f.name = dec.decode(new Uint8Array(bytes));
      }
    } else if (type === ID_CRC) {
      const digests = readDigests(data, numFiles);
      files.forEach((f, i) => { f.crc = digests[i]; });
    }
    // All other properties (times, attributes, comments) are skipped
    // via the size-delimited slice above — the packer doesn't need them.
  }
  for (const f of files) if (f.name === null) throw new Error("7z: FilesInfo without a Name property");
  return files;
}

function parseHeader(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== ID_HEADER) throw new Error("7z: header does not start with kHeader");
  let mainStreams = null, files = null;
  for (;;) {
    const id = r.u8();
    if (id === ID_END) break;
    if (id === ID_ARCHIVE_PROPERTIES) {
      for (;;) {
        const t = r.u8();
        if (t === ID_END) break;
        r.bytes(r.varint());
      }
    } else if (id === ID_ADDITIONAL_STREAMS) {
      parseStreamsInfo(r); // parsed to advance; not needed for extraction
    } else if (id === ID_MAIN_STREAMS) {
      mainStreams = parseStreamsInfo(r);
    } else if (id === ID_FILES_INFO) {
      files = parseFilesInfo(r);
    } else {
      throw new Error(`7z: unexpected header section 0x${id.toString(16)}`);
    }
  }
  if (!mainStreams || !files) throw new Error("7z: header is missing StreamsInfo or FilesInfo");
  return { mainStreams, files };
}

// --- Folder decoding ----------------------------------------------------
// Resolve a folder's coders into decode order: start at the coder whose
// input is a packed stream, then follow bind pairs to the folder output.
// Returns the coders in packed->output (decode) order.
function decodeOrder(folder) {
  const inOwner = []; // global in-stream index -> coder index
  const outOwner = [];
  folder.coders.forEach((c, ci) => {
    for (let i = 0; i < c.numIn; i++) inOwner.push(ci);
    for (let i = 0; i < c.numOut; i++) outOwner.push(ci);
  });
  const boundIn = new Set(folder.binds.map((b) => b.in));
  const boundOut = new Set(folder.binds.map((b) => b.out));
  const packedIn = inOwner.map((_, i) => i).filter((i) => !boundIn.has(i));
  const outStreams = outOwner.map((_, i) => i).filter((i) => !boundOut.has(i));
  if (packedIn.length !== folder.numPacked) throw new Error("7z: folder packed-stream accounting mismatch");
  if (folder.numPacked !== 1) throw new Error("7z: folders with multiple packed streams are not supported (BCJ2-style)");
  if (outStreams.length !== 1) throw new Error("7z: folders with multiple output streams are not supported");
  // Global out-stream index of each coder, in coder order.
  const outBase = [];
  { let o = 0; folder.coders.forEach((c) => { outBase.push(o); o += c.numOut; }); }
  const order = [];
  let curCoder = inOwner[packedIn[0]];
  const seen = new Set();
  for (;;) {
    if (seen.has(curCoder)) throw new Error("7z: folder coder cycle");
    seen.add(curCoder);
    order.push(folder.coders[curCoder]);
    // Find the bind pair fed by this coder's output stream(s).
    const myOut = [];
    for (let i = 0; i < folder.coders[curCoder].numOut; i++) myOut.push(outBase[curCoder] + i);
    const nextBind = folder.binds.find((b) => myOut.includes(b.out));
    if (!nextBind) break; // this coder produces the folder output
    curCoder = inOwner[nextBind.in];
  }
  if (order.length !== folder.coders.length) throw new Error("7z: folder coder chain does not cover all coders");
  return order;
}

function coderName(c) {
  return UNSUPPORTED_CODERS[c.id] || `method ${c.id}`;
}

// Build a transform for one coder in decode order. A transform is
// { feed(chunk) -> Uint8Array[], finish() -> Uint8Array[] }.
function makeTransform(coder, lzma, unpackSize) {
  if (coder.id === CODER_COPY) {
    return { feed: (c) => [c], finish: () => [] };
  }
  if (coder.id === CODER_LZMA || coder.id === CODER_LZMA2) {
    const isLzma2 = coder.id === CODER_LZMA2;
    const props = coder.attrs;
    if (!props || (isLzma2 ? props.length < 1 : props.length < 5)) {
      throw new Error(`7z: ${isLzma2 ? "LZMA2" : "LZMA"} coder without properties`);
    }
    const dec = lzma.createDecoder(isLzma2, props.subarray(0, isLzma2 ? 1 : 5), unpackSize);
    return { feed: (c) => dec.feed(c), finish: () => dec.finish() };
  }
  if (coder.id === CODER_BCJ_X86) {
    const bcj = lzma.createBcj();
    return { feed: (c) => bcj.feed(c), finish: () => bcj.finish() };
  }
  if (coder.id === CODER_DELTA) {
    // 7z Delta props: one byte, distance - 1 (a filter created with
    // dist 4 stores 0x03). If absent, distance 1.
    const dist = coder.attrs && coder.attrs.length >= 1 ? coder.attrs[0] + 1 : 1;
    if (dist < 1 || dist > 256) throw new Error(`7z: Delta distance ${dist} out of range`);
    const hist = new Uint8Array(dist);
    let pos = 0;
    return {
      feed: (chunk) => {
        const out = new Uint8Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) {
          const v = (chunk[i] + hist[pos]) & 0xff;
          out[i] = v; hist[pos] = v; pos = (pos + 1) % dist;
        }
        return [out];
      },
      finish: () => [],
    };
  }
  if (coder.id === CODER_AES) throw new Error("7z: encrypted archive (AES-256) — password-protected 7z files are not supported");
  throw new Error(`7z: unsupported coder ${coderName(coder)}`);
}

async function readRange(file, off, len) {
  if (off < 0 || len < 0 || off + len > file.size) throw new Error("7z: read past end of file (truncated archive?)");
  return new Uint8Array(await file.slice(off, off + len).arrayBuffer());
}

// Decode one folder's full unpack stream, as an async generator of
// chunks. packedOffset is the absolute file offset of the folder's
// (single) packed stream; packedSize its compressed size.
const decoderQueues = new WeakMap();
async function* decodeFolder(file, folder, packedOffset, packedSize, lzma) {
  // One WASM module has one dictionary and BCJ state. Serialize folder
  // decodes even when callers request several files concurrently.
  const previous = decoderQueues.get(lzma) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  decoderQueues.set(lzma, turn);
  await previous;
  let transforms = [];
  try {
    const order = decodeOrder(folder);
    const outBase = new Map();
    let outIndex = 0;
    for (const c of folder.coders) { outBase.set(c, outIndex); outIndex += c.numOut; }
    for (const c of order) transforms.push(makeTransform(c, lzma, folder.unpackSizes[outBase.get(c)]));
    const run = async function* (chunks) {
      let cur = chunks;
      for (const t of transforms) {
        const next = [];
        for (const c of cur) next.push(...t.feed(c));
        cur = next;
      }
      yield* cur;
    };
    for (let off = 0; off < packedSize; off += CHUNK) {
      const chunk = await readRange(file, packedOffset + off, Math.min(CHUNK, packedSize - off));
      yield* run([chunk]);
    }
    // Finish in pipeline order, propagating tail output downstream.
    let tail = [];
    for (const t of transforms) {
      const next = [];
      for (const c of tail) next.push(...t.feed(c));
      next.push(...t.finish());
      tail = next;
    }
    yield* tail;
  } finally {
    // Early consumer return (readRange/cancellation) must release decoder state.
    for (const t of transforms) t.finish();
    release();
  }
}

function emptySource() {
  return {
    size: 0,
    async *chunks() { /* nothing */ },
    async readRange() { return new Uint8Array(0); },
    async readAll() { return new Uint8Array(0); },
  };
}

// Decode each solid folder once into OPFS when available. The fallback
// Blob cache is limited to 64 MiB per archive, not per folder.
// A rejected promise remains rejected: corrupt data is never served on retry.
function folderCache(file, ctx, size, lzma, memoryBudget) {
  let pending = null, handle = null, directory = null, name = null, disposed = false;
  async function materialize() {
    if (disposed) throw new Error("7z: archive has been removed");
    const parts = [];
    let writer = null, total = 0, crc = 0xffffffff;
    try {
      if (globalThis.navigator?.storage?.getDirectory) {
        const root = await navigator.storage.getDirectory();
        directory = await root.getDirectoryHandle("nup-7z-cache", { create: true });
        name = crypto.randomUUID();
        handle = await directory.getFileHandle(name, { create: true });
        writer = await handle.createWritable();
      } else {
        if (size > memoryBudget.remaining) throw new Error("7z: this archive needs browser temporary storage (OPFS); without it the decoded cache is limited to 64 MiB. Extract the archive and add the folder instead");
        memoryBudget.remaining -= size;
      }
      for await (const c of decodeFolder(file, ctx.folder, ctx.packedOffset, ctx.packedSize, lzma)) {
        if (total + c.length > size) throw new Error("7z: folder decoded size mismatch");
        total += c.length; crc = crc32Update(crc, c);
        if (writer) await writer.write(c); else parts.push(c);
      }
      if (total !== size) throw new Error("7z: folder decoded size mismatch (truncated archive?)");
      if (ctx.folder.crc != null && crc32Final(crc) !== ctx.folder.crc) throw new Error("7z: folder CRC32 mismatch (corrupt archive)");
      if (writer) { await writer.close(); writer = null; }
      return handle ? await handle.getFile() : new Blob(parts);
    } catch (e) {
      if (writer) await writer.abort().catch(() => {});
      if (directory && name) await directory.removeEntry(name).catch(() => {});
      throw e;
    }
  }
  return {
    async get() {
      if (disposed) throw new Error("7z: archive has been removed");
      return pending ||= materialize();
    },
    async dispose() {
      disposed = true;
      if (pending) await pending.catch(() => {});
      if (directory && name) await directory.removeEntry(name).catch(() => {});
    },
  };
}

function sevenzFileSource(cache, prefix, sub) {
  return {
    size: sub.size,
    async *chunks() {
      const blob = await cache.get();
      let crc = 0xffffffff;
      for (let off = 0; off < sub.size; off += CHUNK) {
        const c = new Uint8Array(await blob.slice(prefix + off, prefix + Math.min(sub.size, off + CHUNK)).arrayBuffer());
        crc = crc32Update(crc, c);
        yield c;
      }
      if (sub.crc !== null && crc32Final(crc) !== sub.crc) throw new Error(`7z entry "${sub.name}": CRC32 mismatch (corrupt archive)`);
    },
    async readRange(off, len) {
      // Read through chunks to retain per-file CRC verification, even for
      // partial reads used by NPDM/NSO discovery. The folder is already cached.
      const out = new Uint8Array(Math.min(len, Math.max(0, sub.size - off)));
      let pos = 0;
      for await (const c of this.chunks()) {
        const start = Math.max(off, pos), end = Math.min(off + out.length, pos + c.length);
        if (end > start) out.set(c.subarray(start - pos, end - pos), start - off);
        pos += c.length;
      }
      return out;
    },
    async readAll() { return this.readRange(0, sub.size); },
  };
}

function hasDir(node, lowerName) {
  return node.children.some((c) => c.children && c.name.toLowerCase() === lowerName);
}
function isBundleOrContent(node) {
  return hasDir(node, "base") || hasDir(node, "updates") || hasDir(node, "dlc")
    || hasDir(node, "exefs") || hasDir(node, "romfs");
}

// Debug/test exports (DOM-free utilities, also used by test-7z.mjs).
export { Reader, parseStreamsInfo, parseHeader, decodeOrder, decodeFolder };

// lzma: the loadLzma() module (loaded lazily by the caller — the wasm
// is only fetched when a 7z file is actually added). openSevenz itself
// only parses the header; folder decoding (which needs lzma) happens
// when a file's chunks() runs, except for an encoded header, which is
// decoded here and therefore requires lzma up front.
export async function openSevenz(file, lzma) {
  if (!file || typeof file.size !== "number" || typeof file.slice !== "function") {
    throw new Error("7z: input must be a File-like object with size and slice()");
  }
  if (file.size < 32) throw new Error("not a 7z file (too small for a signature header)");
  const sig = await readRange(file, 0, 32);
  for (let i = 0; i < 6; i++) if (sig[i] !== SIG[i]) throw new Error("not a 7z file (bad signature)");
  const major = sig[6], minor = sig[7];
  if (major !== 0) throw new Error(`7z: unsupported format version ${major}.${minor}`);
  const startCrc = new DataView(sig.buffer, sig.byteOffset, sig.byteLength).getUint32(8, true);
  let crc = 0xffffffff;
  crc = crc32Update(crc, sig.subarray(12, 32));
  if (crc32Final(crc) !== startCrc) throw new Error("7z: signature header CRC mismatch (corrupt archive?)");
  const dv = new DataView(sig.buffer, sig.byteOffset, sig.byteLength);
  const nextOff = Number(dv.getBigUint64(12, true));
  const nextSize = Number(dv.getBigUint64(20, true));
  const nextCrc = dv.getUint32(28, true);
  if (nextOff > Number.MAX_SAFE_INTEGER || nextSize > Number.MAX_SAFE_INTEGER) throw new Error("7z: header offset/size too large");
  const nextBytes = await readRange(file, 32 + nextOff, nextSize);
  crc = 0xffffffff;
  crc = crc32Update(crc, nextBytes);
  if (crc32Final(crc) !== nextCrc) throw new Error("7z: header CRC mismatch (corrupt archive?)");
  let headerBytes = nextBytes;
  if (nextBytes[0] === ID_ENCODED_HEADER) {
    if (!lzma) throw new Error("7z: encoded header needs the LZMA decoder (load it first)");
    const r = new Reader(nextBytes, 1);
    const encInfo = parseStreamsInfo(r);
    if (encInfo.folders.length !== 1 || encInfo.packSizes.length !== 1) {
      throw new Error("7z: encoded header with an unexpected stream layout");
    }
    const folder = encInfo.folders[0];
    const unpackSize = folder.unpackSizes && folder.unpackSizes[0];
    if (unpackSize === undefined) throw new Error("7z: encoded header folder without an unpack size");
    const parts = [];
    let total = 0;
    // PackPos is relative to the end of the signature header (offset
    // 32), not absolute — the packed header sits immediately before
    // the header itself in the file.
    for await (const c of decodeFolder(file, folder, 32 + encInfo.packPos, encInfo.packSizes[0], lzma)) {
      parts.push(c); total += c.length;
    }
    const decoded = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { decoded.set(p, o); o += p.length; }
    if (total !== unpackSize) throw new Error("7z: encoded header decoded size mismatch");
    if (folder.crc != null && crc32Final(crc32Update(0xffffffff, decoded)) !== folder.crc) {
      throw new Error("7z: decoded header CRC32 mismatch (corrupt archive)");
    }
    headerBytes = decoded;
  } else if (nextBytes[0] !== ID_HEADER) {
    throw new Error("7z: header is neither a plain header nor an encoded header");
  }
  const { mainStreams, files } = parseHeader(headerBytes);
  const { packPos, packSizes, folders, numPerFolder, subSizes, subCrcs } = mainStreams;
  if (packPos === null) throw new Error("7z: header has no PackInfo");
  // A folder's unpack size is the size of its OUTPUT stream (the one
  // out-stream not bound to another coder), not necessarily
  // unpackSizes[0] — e.g. a BCJ+LZMA2 folder lists one size per coder.
  function folderOutputSize(folder) {
    const order = decodeOrder(folder); // validates the chain too
    const outBase = [];
    { let o = 0; folder.coders.forEach((c) => { outBase.push(o); o += c.numOut; }); }
    const boundOut = new Set(folder.binds.map((b) => b.out));
    const outIdx = folder.coders.map((_, ci) => outBase[ci] + folder.coders[ci].numOut - 1)
      .find((gi) => !boundOut.has(gi));
    // decodeOrder already guarantees exactly one unbound out-stream;
    // fall back to the last coder's output if the search above missed
    // a multi-output coder (decodeOrder would have thrown instead).
    const idx = outIdx !== undefined ? outIdx : folder.unpackSizes.length - 1;
    const size = folder.unpackSizes && folder.unpackSizes[idx];
    if (size === undefined) throw new Error("7z: folder without an unpack size");
    return size;
  }
  // Global packed-stream offsets. PackPos is relative to offset 32.
  const packOffsets = [];
  { let o = 32 + packPos; for (const s of packSizes) { packOffsets.push(o); o += s; } }
  // Folder packed-stream assignment: packed streams are numbered in
  // folder order, each folder taking numPacked of them.
  const folderCtxs = [];
  let packIdx = 0;
  for (const folder of folders) {
    if (folder.numPacked !== 1) throw new Error("7z: folders with multiple packed streams are not supported (BCJ2-style)");
    const packedOffset = packOffsets[packIdx];
    const packedSize = packSizes[packIdx];
    if (packedOffset === undefined || packedSize === undefined) throw new Error("7z: folder packed-stream index out of range");
    folderCtxs.push({ folder, packedOffset, packedSize });
    packIdx += folder.numPacked;
  }
  if (packIdx !== packSizes.length) throw new Error("7z: packed-stream count does not match PackInfo");
  // Substreams per folder, with sizes (last substream of each folder
  // is derived from the folder unpack size).
  const perFolder = numPerFolder || folders.map(() => 1);
  const memoryBudget = { remaining: 64 * 1024 * 1024 };
  const caches = folders.map((folder, i) => folderCache(file, folderCtxs[i], folderOutputSize(folder), lzma, memoryBudget));
  const substreams = []; // {folderCtx, size, crc, prefix}
  let sizePos = 0;
  folders.forEach((folder, fi) => {
    const n = perFolder[fi];
    const folderSize = folderOutputSize(folder);
    let acc = 0;
    for (let si = 0; si < n; si++) {
      let size;
      if (si < n - 1) {
        if (!subSizes || sizePos >= subSizes.length) throw new Error("7z: missing substream size");
        size = subSizes[sizePos++];
      } else {
        size = folderSize - acc;
      }
      substreams.push({ cache: caches[fi], size, crc: subCrcs ? subCrcs[substreams.length] : (n === 1 ? folder.crc ?? null : null), prefix: acc });
      acc += size;
    }
    if (acc !== folderSize) throw new Error("7z: substream sizes do not add up to the folder unpack size");
  });
  // Files consume substreams in order (skipping empty/anti entries).
  const root = { name: file.name || "archive.7z", children: [] };
  const dirMap = new Map([["", root]]);
  let subIdx = 0;
  let fileCount = 0, totalUncompressed = 0;
  const ensureDir = (path, parts) => {
    let parent = root, p = "";
    for (const part of parts) {
      p = p ? `${p}/${part}` : part;
      let dir = dirMap.get(p);
      if (!dir && parent.children.some((c) => c.name === part)) throw new Error(`7z: file/directory name clash "${p}"`);
      if (!dir) { dir = { name: part, children: [] }; dirMap.set(p, dir); parent.children.push(dir); }
      parent = dir;
    }
    return parent;
  };
  for (const f of files) {
    if (f.anti) continue;
    const parts = f.name.split("/").filter((p) => p !== "" && p !== ".");
    if (!parts.length) continue;
    if (f.emptyStream) {
      if (f.emptyFile) {
        const parent = ensureDir(null, parts.slice(0, -1));
        const leaf = parts[parts.length - 1];
        if (leaf === ".listing") continue;
        if (parent.children.some((c) => c.name === leaf)) throw new Error(`7z: duplicate entry "${f.name}"`);
        parent.children.push({ name: leaf, file: emptySource() });
        fileCount++;
      } else {
        ensureDir(null, parts);
      }
      continue;
    }
    const sub = substreams[subIdx++];
    if (!sub) throw new Error(`7z: file "${f.name}" has no data stream (header/file mismatch)`);
    const parent = ensureDir(null, parts.slice(0, -1));
    const leaf = parts[parts.length - 1];
    if (leaf === ".listing") continue;
    const crc = f.crc !== null ? f.crc : sub.crc;
    if (parent.children.some((c) => c.name === leaf)) throw new Error(`7z: duplicate entry "${f.name}"`);
    parent.children.push({
      name: leaf,
      file: sevenzFileSource(sub.cache, sub.prefix, { size: sub.size, crc, name: f.name }),
    });
    fileCount++;
    totalUncompressed += sub.size;
  }
  if (subIdx !== substreams.length) throw new Error("7z: header has data streams with no file");
  const sortRec = (n) => {
    n.children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    n.children.forEach((c) => { if (c.children) sortRec(c); });
  };
  sortRec(root);
  let cur = root;
  while (cur.children.length === 1 && cur.children[0].children
    && !cur.children.some((c) => !c.children) && !isBundleOrContent(cur)) {
    cur = cur.children[0];
  }
  return {
    name: file.name || "archive.7z",
    root: { name: file.name || "archive.7z", children: cur.children },
    fileCount,
    totalUncompressed,
    dispose: async () => { await Promise.all(caches.map((c) => c.dispose())); },
  };
        }
