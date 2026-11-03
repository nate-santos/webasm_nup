// packer.js — .nup writer for webasm_nup (NUP v1, SPEC.md from a55uka/nup).
//
// No DOM dependency: the browser UI (app.js) and the Node test harness
// (test/test.mjs) both use it, supplying their own file sources and
// output adapters. The per-byte work — SHA-256 and zstd — runs in the
// WebAssembly module (nup.wasm, built from wasm-src/). Everything else
// here is orchestration and binary layout, in JS.
//
// Format recap (all integers little-endian):
//   superblock 0x80 bytes: magic "NUP\x01", TOC at 0x80, TOC SHA-256,
//     blob offset (16-aligned), file size, package count, content UUID.
//   TOC: header, package records (0x40), dir records (0x18), file
//     records (0x50), children array (u32 node ids), string pool.
//   Blob: per-file extents, 16-byte aligned, codec 0 = raw, 1 = zstd
//     (one frame per file, content size pledged in the frame header).
//   Meta: per-package TLV list after the last extent (type u16,
//     reserved u16, size u32, payload; sorted by type, no padding).
//
// Streaming / storage model:
//   * Input files are read in 1 MiB chunks, never whole in RAM. (The
//     WASM input buffer is 256 KiB; the wrapper in loadWasm splits
//     larger chunks for it, so the wasm call count is unchanged — the
//     saving is in JS slice/arrayBuffer/OPFS-write calls per byte.)
//   * Sampling: for files over 4 MiB, the first 1 MiB is compressed
//     as a sample. If it shrinks by less than 10%, compression is
//     abandoned immediately and the file is written raw in one pass,
//     instead of paying for a full compress pass and then a raw repass.
//     This is a heuristic — a file whose head is incompressible but
//     whose body compresses will end up raw — but raw is always valid,
//     and the old stored>=size backstop still catches files that pass
//     the sample and then stop compressing.
//   * Output goes through an adapter with writeAt(position, bytes) /
//     truncate(size) / close() — in the browser that adapter is an OPFS
//     FileSystemWritableFileStream, i.e. disk, not RAM.
//   * A compressible file is hashed + compressed in ONE pass, writing
//     its zstd extent straight to the output. If compressed output
//     reaches the raw size, compression is abandoned, the partial
//     extent is overwritten by a raw pass, and any compressed tail past
//     the raw extent is zeroed — the file on disk is always a clean .nup.
//   * Files larger than rawThreshold (default 256 MiB, matching
//     Eglantine's reader cache behaviour) are stored raw in a single
//     hash-and-write pass; if the hash then turns out to duplicate an
//     earlier extent, the cursor is rewound and the extent shared.
//     Orphaned bytes from a rewound extent are overwritten by later
//     extents / meta blocks, or removed by the final truncate.
//   * Dedup is by (size, SHA-256): two files share an extent only when
//     both match, exactly as SPEC §3.6 requires.
//
// FileSource interface (supplied by the caller):
//   { size: number, chunks(): AsyncIterable<Uint8Array> }
//   chunks() must yield the file's bytes in order; it may be called a
//   second time only for files whose compression is abandoned.
//
// Package interface (supplied by the caller, built by app.js / test):
//   { kind, titleId (number|bigint), version (number), flags (number),
//     root: DirNode, npdm (Uint8Array|null), buildId (Uint8Array|null),
//     sourceName (string) }
//   DirNode: { name: string, children: Node[] }
//   Node: DirNode | { name: string, file: FileSource }
//   The root node's name is "" and its children are the package tree.
//   Children are re-sorted bytewise here, and ".listing" files are
//   dropped by the caller, matching the reference packer.
//
// App metadata (name / icon / display version / publisher) is attached
// to the base package, or to the first package when there is no base,
// exactly like the reference packer and Eglantine's writer.

export const CHUNK = 1024 * 1024;
export const RAW_THRESHOLD = 256 * 1024 * 1024;
const SAMPLE_BYTES = 1024 * 1024;      // incompressibility sample size
const SAMPLE_MIN_SIZE = 4 * 1024 * 1024; // only sample files larger than this
const SAMPLE_MAX_RATIO = 0.90;         // sample must shrink by >10% to keep compressing
const ALIGN = 16;
const FILE_TAG = 0x80000000;
const NO_DIR = 0xffffffff;
const CODEC_RAW = 0;
const CODEC_ZSTD = 1;
const TLV_NPDM = 0x0001;
const TLV_ICON = 0x0003;
const TLV_DISPLAY_VERSION = 0x0004;
const TLV_TITLE_NAME = 0x0005;
const TLV_PUBLISHER = 0x0006;
const TLV_BUILD_ID = 0x0007;
const TLV_SOURCE_DUMP = 0x0008;

const enc = new TextEncoder();
const dec = new TextDecoder();

function utf8Bytes(s) { return enc.encode(s); }
function cmpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
function align16(n) { return (n + ALIGN - 1) & ~(ALIGN - 1); }
function hex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function concat(arrays) {
  const total = arrays.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// Version strings: "1.2.3" -> (1<<16)|(2<<8)|3, per SPEC §3.1.1.
// A plain decimal ("458752") is used as-is (update-style numeric version).
export function encodeVersion(str) {
  if (str == null || str === "") return 0;
  const m = String(str).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (m) return (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]);
  if (/^\d+$/.test(String(str).trim())) return Number(str.trim());
  return 0;
}

// --- WASM wrapper -------------------------------------------------------
// Each method copies its chunk into the WASM input buffer itself, so the
// packer can interleave sha and zstd calls on the same chunk (the two
// WASM contexts are independent; only the input buffer is shared).
export async function loadWasm(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports;
  const mem = () => new Uint8Array(e.memory.buffer);
  const inPtr = e.nup_in_ptr();
  const outPtr = e.nup_out_ptr();
  const inSize = e.nup_in_size();
  function copyChunk(chunk) {
    // Split chunks larger than the WASM input buffer (callers use CHUNK,
    // but be safe for arbitrary chunk sizes).
    const parts = [];
    for (let off = 0; off < chunk.length; off += inSize) {
      parts.push(chunk.subarray(off, Math.min(chunk.length, off + inSize)));
    }
    return parts.length ? parts : [new Uint8Array(0)];
  }
  return {
    shaInit() { e.sha_init(); },
    shaUpdate(chunk) {
      for (const part of copyChunk(chunk)) {
        mem().set(part, inPtr);
        e.sha_update(part.length);
      }
    },
    shaFinal() {
      e.sha_final();
      return new Uint8Array(mem().slice(outPtr, outPtr + 32));
    },
    async hashStream(chunks) {
      this.shaInit();
      for await (const chunk of chunks) this.shaUpdate(chunk);
      return this.shaFinal();
    },
    async hashBytes(bytes) {
      const gen = (async function* () { yield bytes; })();
      return this.hashStream(gen);
    },
    zstdBegin(totalSize, level) {
      if (e.zstd_begin(BigInt(totalSize), level) !== 0) throw new Error("wasm: zstd_begin failed");
    },
    // Returns the compressed bytes produced by this chunk (may be empty
    // for early chunks; the frame is only complete after isLast).
    zstdFeed(chunk, isLast) {
      const outs = [];
      for (const part of copyChunk(chunk)) {
        mem().set(part, inPtr);
        const n = e.zstd_feed(part.length, 0);
        if (n < 0) throw new Error(`wasm: zstd_feed failed (${n})`);
        if (n) outs.push(new Uint8Array(mem().slice(outPtr, outPtr + n)));
      }
      if (isLast) {
        const n = e.zstd_feed(0, 1);
        if (n < 0) throw new Error(`wasm: zstd_feed (final) failed (${n})`);
        if (n) outs.push(new Uint8Array(mem().slice(outPtr, outPtr + n)));
      }
      return concat(outs);
    },
  };
}

// --- tree assignment (mirrors the reference packer's Tree.assign) --------
function buildTree(packages) {
  const dirs = [];   // {nameBytes, firstChild, childCount}
  const files = [];  // {nameBytes, file, path}
  const children = [];
  const dirIdOf = new Map(); // DirNode object -> dir id
  function rec(node, path) {
    const id = dirs.length;
    dirIdOf.set(node, id);
    dirs.push({ nameBytes: utf8Bytes(node.name), firstChild: 0, childCount: 0 });
    const sorted = [...node.children].sort((a, b) => cmpBytes(utf8Bytes(a.name), utf8Bytes(b.name)));
    const slotBase = children.length;
    for (let i = 0; i < sorted.length; i++) children.push(0);
    sorted.forEach((child, i) => {
      if (!child.children) {
        children[slotBase + i] = FILE_TAG + files.length;
        files.push({
          nameBytes: utf8Bytes(child.name), file: child.file,
          path: path ? `${path}/${child.name}` : child.name,
        });
      }
    });
    sorted.forEach((child, i) => {
      if (child.children) children[slotBase + i] = rec(child, path ? `${path}/${child.name}` : child.name);
    });
    dirs[id].firstChild = slotBase;
    dirs[id].childCount = sorted.length;
    return id;
  }
  for (const pkg of packages) {
    pkg._root = rec(pkg.root, "");
    pkg._exefs = NO_DIR; pkg._romfs = NO_DIR;
    for (const child of pkg.root.children) {
      if (!child.children) continue;
      const id = dirIdOf.get(child);
      if (child.name === "exefs") pkg._exefs = id;
      if (child.name === "romfs") pkg._romfs = id;
    }
  }
  return { dirs, files, children };
}

// String-pool keys: bytes mapped 1:1 to code units (keying only, never decoded).
function poolKey(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
function poolBytes(key) {
  const b = new Uint8Array(key.length);
  for (let i = 0; i < key.length; i++) b[i] = key.charCodeAt(i);
  return b;
}

function tlv(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  const v = new DataView(out.buffer);
  v.setUint16(0, type, true);
  v.setUint16(2, 0, true);
  v.setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

function metaBlock(pkg, appMeta, isAppTarget) {
  const recs = [];
  if (pkg.npdm) recs.push([TLV_NPDM, pkg.npdm]);
  if (pkg.buildId) recs.push([TLV_BUILD_ID, pkg.buildId]);
  if (isAppTarget && appMeta) {
    if (appMeta.icon) recs.push([TLV_ICON, appMeta.icon]);
    if (appMeta.displayVersion) recs.push([TLV_DISPLAY_VERSION, utf8Bytes(appMeta.displayVersion)]);
    if (appMeta.titleName) recs.push([TLV_TITLE_NAME, utf8Bytes(appMeta.titleName)]);
    if (appMeta.publisher) recs.push([TLV_PUBLISHER, utf8Bytes(appMeta.publisher)]);
  }
  recs.push([TLV_SOURCE_DUMP, utf8Bytes(pkg.sourceName || "webasm_nup")]);
  recs.sort((a, b) => a[0] - b[0]);
  const seen = new Set();
  const out = [];
  for (const [t, p] of recs) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(tlv(t, p));
  }
  return concat(out);
}

// --- main pack ----------------------------------------------------------
export async function packNup(wasm, packages, output, options = {}) {
  const { level = 3, rawThreshold = RAW_THRESHOLD, appMeta = null, onProgress = null, shouldCancel = null } = options;
  if (!packages.length) throw new Error("pack: no packages");
  const baseCount = packages.filter((p) => p.kind === 0).length;
  if (baseCount > 1) throw new Error("pack: at most one base package is allowed in NUP v1");
  const standalone = baseCount === 0;
  for (const p of packages) if (p.kind === 1 && standalone) p.flags |= 0x01;

  const { dirs, files, children } = buildTree(packages);
  const dirCount = dirs.length, fileCount = files.length;
  const poolMap = new Map(); let poolSize = 0;
  const intern = (nameBytes) => {
    const key = poolKey(nameBytes);
    let off = poolMap.get(key);
    if (off === undefined) { off = poolSize; poolMap.set(key, off); poolSize += nameBytes.length; }
    return off;
  };
  for (const d of dirs) intern(d.nameBytes);
  for (const f of files) intern(f.nameBytes);

  const tocSize = 48 + packages.length * 64 + dirCount * 24 + fileCount * 80 + children.length * 4 + poolSize;
  const blobOffset = align16(0x80 + tocSize);
  const totalBytes = files.reduce((a, f) => a + f.file.size, 0);

  // Placeholder header + TOC (zero-filled; overwritten at the end).
  const zeroChunk = new Uint8Array(1024 * 1024);
  let pos = 0;
  while (pos < blobOffset) {
    const n = Math.min(zeroChunk.length, blobOffset - pos);
    await output.writeAt(pos, zeroChunk.subarray(0, n));
    pos += n;
  }
  let cursor = blobOffset;

  const dedup = new Map(); // sha hex -> {offset, stored, codec, size}
  const sizesSeen = new Set();
  let bytesDone = 0, filesDone = 0;
  const progress = (phase, currentPath) => {
    if (onProgress) onProgress({ filesDone, filesTotal: fileCount, bytesDone, bytesTotal: totalBytes, phase, currentPath, outputBytes: cursor });
  };
  const checkCancel = () => { if (shouldCancel && shouldCancel()) throw new Error("cancelled"); };
  const fileRecs = files.map(() => ({ size: 0, offset: 0, stored: 0, sha: new Uint8Array(32), codec: CODEC_RAW }));

  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    const rec = fileRecs[fi];
    const size = f.file.size;
    rec.size = size;
    checkCancel();
    if (size === 0) {
      rec.sha = await wasm.hashBytes(new Uint8Array(0));
      rec.offset = 0; rec.stored = 0; rec.codec = CODEC_RAW;
      filesDone++; progress("empty", f.path);
      continue;
    }
    // Dedup pre-check: only a size seen before can be a duplicate.
    if (sizesSeen.has(size)) {
      const sha = await wasm.hashStream((async function* () {
        for await (const c of f.file.chunks()) { bytesDone += c.length; progress("hashing (dedup check)", f.path); yield c; }
      })());
      const hit = dedup.get(hex(sha));
      if (hit && hit.size === size) {
        rec.sha = sha; rec.offset = hit.offset; rec.stored = hit.stored; rec.codec = hit.codec;
        filesDone++; progress("shared extent (duplicate)", f.path);
        continue;
      }
    }

    const start = align16(cursor);
    if (start > cursor) await output.writeAt(cursor, new Uint8Array(start - cursor));
    cursor = start;

    if (size <= rawThreshold) {
      // One pass: hash + compress, writing the extent as we go.
      wasm.zstdBegin(size, level);
      wasm.shaInit();
      let stored = 0, aborted = false, outPos = start;
      let sampleBytes = 0, sampleStored = 0, sampleDecided = false;
      const useSampling = size > SAMPLE_MIN_SIZE;
      for await (const chunk of f.file.chunks()) {
        checkCancel();
        wasm.shaUpdate(chunk);
        const out = wasm.zstdFeed(chunk, false);
        if (out.length) { await output.writeAt(outPos, out); outPos += out.length; stored += out.length; }
        bytesDone += chunk.length;
        progress("compressing", f.path);
        if (useSampling && !sampleDecided) {
          sampleBytes += chunk.length;
          sampleStored += out.length;
          if (sampleBytes >= SAMPLE_BYTES) {
            sampleDecided = true;
            // Note: zstd may buffer the first block, so a 0-output first
            // chunk keeps compression; the stored>=size backstop below
            // still catches a fully incompressible file in that case.
            if (sampleStored > sampleBytes * SAMPLE_MAX_RATIO) { aborted = true; break; }
          }
        }
        if (stored >= size) { aborted = true; break; }
      }
      if (!aborted) {
        const tail = wasm.zstdFeed(new Uint8Array(0), true);
        if (tail.length) { await output.writeAt(outPos, tail); outPos += tail.length; stored += tail.length; }
        aborted = stored >= size;
      }
      if (aborted) {
        // Overwrite the partial extent with raw bytes (second pass, re-hash).
        wasm.shaInit();
        let wpos = start;
        for await (const chunk of f.file.chunks()) {
          checkCancel();
          wasm.shaUpdate(chunk);
          await output.writeAt(wpos, chunk);
          wpos += chunk.length;
          progress("writing raw (incompressible)", f.path);
        }
        rec.sha = wasm.shaFinal();
        // Zero any compressed tail past the raw extent.
        if (stored > size) {
          let zpos = start + size, remaining = stored - size;
          const z = new Uint8Array(1024 * 1024);
          while (remaining > 0) {
            const n = Math.min(z.length, remaining);
            await output.writeAt(zpos, z.subarray(0, n));
            zpos += n; remaining -= n;
          }
        }
        rec.offset = start; rec.stored = size; rec.codec = CODEC_RAW;
        cursor = start + size;
      } else {
        rec.sha = wasm.shaFinal();
        rec.offset = start; rec.stored = stored; rec.codec = CODEC_ZSTD;
        cursor = start + stored;
      }
      dedup.set(hex(rec.sha), { offset: rec.offset, stored: rec.stored, codec: rec.codec, size });
      sizesSeen.add(size);
    } else {
      // Large file: single hash-and-write raw pass.
      wasm.shaInit();
      let wpos = start;
      for await (const chunk of f.file.chunks()) {
        checkCancel();
        wasm.shaUpdate(chunk);
        await output.writeAt(wpos, chunk);
        wpos += chunk.length;
        bytesDone += chunk.length;
        progress("writing raw (large file)", f.path);
      }
      const sha = wasm.shaFinal();
      const hit = dedup.get(hex(sha));
      if (hit && hit.size === size) {
        // Roll the cursor back; bytes just written are orphaned and will
        // be overwritten by the next extent / meta, or truncated.
        rec.sha = sha; rec.offset = hit.offset; rec.stored = hit.stored; rec.codec = hit.codec;
        cursor = start;
      } else {
        rec.sha = sha; rec.offset = start; rec.stored = size; rec.codec = CODEC_RAW;
        cursor = start + size;
        dedup.set(hex(sha), { offset: start, stored: size, codec: CODEC_RAW, size });
      }
      sizesSeen.add(size);
    }
    filesDone++;
    progress("done", f.path);
  }

  // Meta blocks, straight after the last extent (no alignment).
  const appIdx = (() => { const i = packages.findIndex((p) => p.kind === 0); return i >= 0 ? i : 0; })();
  const metaOffsets = [];
  for (let i = 0; i < packages.length; i++) {
    const block = metaBlock(packages[i], appMeta, i === appIdx);
    metaOffsets.push([block.length ? cursor : 0, block.length]);
    if (block.length) { await output.writeAt(cursor, block); cursor += block.length; }
  }
  const fileSize = cursor;

  // TOC.
  const toc = new Uint8Array(tocSize);
  const tv = new DataView(toc.buffer);
  toc.set([0x54, 0x4f, 0x43, 0x01], 0); // "TOC\x01"
  tv.setUint32(4, packages.length, true);
  tv.setBigUint64(8, BigInt(dirCount), true);
  tv.setBigUint64(16, BigInt(fileCount), true);
  let p = 48;
  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    tv.setBigUint64(p + 0x00, BigInt(pkg.titleId || 0), true);
    tv.setUint32(p + 0x08, pkg._root, true);
    tv.setUint32(p + 0x0c, pkg._exefs, true);
    tv.setUint32(p + 0x10, pkg._romfs, true);
    tv.setUint32(p + 0x14, pkg.version || 0, true);
    toc[p + 0x18] = pkg.kind;
    toc[p + 0x19] = pkg.flags || 0;
    tv.setBigUint64(p + 0x20, BigInt(metaOffsets[i][0]), true);
    tv.setUint32(p + 0x28, metaOffsets[i][1], true);
    p += 64;
  }
  for (const d of dirs) {
    tv.setUint32(p + 0x00, intern(d.nameBytes), true);
    tv.setUint32(p + 0x04, d.nameBytes.length, true);
    tv.setUint32(p + 0x08, d.firstChild, true);
    tv.setUint32(p + 0x0c, d.childCount, true);
    tv.setBigUint64(p + 0x10, 0n, true);
    p += 24;
  }
  for (let i = 0; i < files.length; i++) {
    const f = files[i], r = fileRecs[i];
    tv.setUint32(p + 0x00, intern(f.nameBytes), true);
    tv.setUint32(p + 0x04, f.nameBytes.length, true);
    tv.setBigUint64(p + 0x08, BigInt(r.size), true);
    tv.setBigUint64(p + 0x10, BigInt(r.offset), true);
    tv.setBigUint64(p + 0x18, BigInt(r.stored), true);
    toc.set(r.sha, p + 0x20);
    toc[p + 0x40] = r.codec;
    p += 80;
  }
  for (let i = 0; i < children.length; i++) {
    let cid = children[i];
    if (cid >= FILE_TAG) cid = dirCount + (cid - FILE_TAG);
    tv.setUint32(p, cid, true);
    p += 4;
  }
  const poolOff = p;
  for (const [key, off] of poolMap) toc.set(poolBytes(key), poolOff + off);
  tv.setBigUint64(24, BigInt(poolOff), true);
  tv.setBigUint64(32, BigInt(poolSize), true);

  const tocSha = await wasm.hashBytes(toc);
  const uuidInput = concat(packages.map((pkg) => {
    const b = new Uint8Array(13);
    const v = new DataView(b.buffer);
    v.setBigUint64(0, BigInt(pkg.titleId || 0), true);
    v.setUint32(8, pkg.version || 0, true);
    b[12] = pkg.kind;
    return b;
  }));
  const uuid = (await wasm.hashBytes(uuidInput)).slice(0, 16);

  const superblock = new Uint8Array(0x80);
  const sv = new DataView(superblock.buffer);
  superblock.set([0x4e, 0x55, 0x50, 0x01], 0); // "NUP\x01"
  sv.setUint16(4, 0x80, true);
  sv.setUint16(6, 1, true);
  sv.setBigUint64(8, 0x80n, true);
  sv.setBigUint64(16, BigInt(tocSize), true);
  superblock.set(tocSha, 0x18);
  sv.setBigUint64(0x38, BigInt(blobOffset), true);
  sv.setBigUint64(0x40, BigInt(fileSize), true);
  sv.setUint32(0x48, packages.length, true);
  sv.setUint32(0x4c, 0, true);
  superblock.set(uuid, 0x50);
  await output.writeAt(0, superblock);
  await output.writeAt(0x80, toc);
  await output.truncate(fileSize);
  await output.close();
  return { fileSize, blobOffset, tocSize, packageCount: packages.length, dirCount, fileCount, totalBytes, uuid: hex(uuid) };
}
