// zip.js — streaming ZIP reader for webasm_nup (DOM-free).
//
// Reads a .zip file as an input for the .nup packer, without loading
// the archive (or any entry) whole into RAM. Only the central directory
// — entry metadata, not file data — is read up front; entry data is
// streamed per entry through the packer's chunk iterator.
//
// Input contract: a File-like object with `name`, `size`, and
// `slice(start, end)` returning a Blob-like with `arrayBuffer()`.
// Browser File satisfies this directly; the Node test wraps fs the
// same way.
//
// Supported: Stored (method 0) and Deflate (method 8, via the
// platform's DecompressionStream, i.e. native code, not a JS inflate).
// Zip64 is fully supported — required for archives over 4 GiB, and for
// any archive whose central directory uses 64-bit fields.
// Not supported, with a clear error naming the entry: encrypted
// entries, other compression methods (bzip2, LZMA, zstd, PPMd, …),
// and multi-disk / split archives.
//
// Correctness notes:
//   * Sizes, CRCs and data offsets always come from the central
//     directory, not the local headers. Local headers from streaming
//     writers leave those fields zero (data-descriptor flag) and are
//     only used to find where the data starts.
//   * Each entry's decompressed bytes are CRC32-checked against the
//     central directory, so a corrupt archive fails with the entry
//     name instead of producing a bad .nup.
//   * chunks() is re-runnable: every call opens a fresh decompression
//     stream from the entry's compressed range. The packer relies on
//     this when it abandons compression and re-reads a file raw.
//   * ".listing" files are dropped, matching the folder inputs and
//     SPEC's exclusion. A single top-level folder wrapping the dump
//     (game/base/…, game/exefs/…) is unwrapped so discovery works.

import { CHUNK } from "./packer.js";

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const dec = new TextDecoder("utf-8");

function u16(d, o) { return d.getUint16(o, true); }
function u32(d, o) { return d.getUint32(o, true); }
function u64(d, o) {
  const v = d.getBigUint64(o, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("zip: 64-bit value too large to handle");
  return Number(v);
}
async function readRange(file, off, len) {
  if (off < 0 || len < 0 || off + len > file.size) throw new Error("zip: read past end of file (truncated archive?)");
  return new Uint8Array(await file.slice(off, off + len).arrayBuffer());
}

// --- CRC-32 (IEEE, as used by ZIP) ---------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32Update(crc, bytes) {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}
export function crc32Final(crc) { return (crc ^ 0xffffffff) >>> 0; }

// --- Central directory --------------------------------------------------
async function findEocd(file) {
  if (file.size < 22) throw new Error("not a zip file (too small for an end-of-central-directory record)");
  const tailLen = Math.min(file.size, 65535 + 22);
  const tail = await readRange(file, file.size - tailLen, tailLen);
  const d = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let i = tailLen - 22; i >= 0; i--) {
    if (u32(d, i) !== SIG_EOCD) continue;
    if (u16(d, i + 20) !== tailLen - 22 - i) continue; // comment length must match
    return { fileOff: file.size - tailLen + i, d, i };
  }
  throw new Error("not a zip file (no end-of-central-directory record found)");
}

async function parseCentral(file) {
  const { fileOff, d, i } = await findEocd(file);
  let disk = u16(d, i + 4), cdDisk = u16(d, i + 6);
  let totalEntries = u16(d, i + 10);
  let cdSize = u32(d, i + 12), cdOffset = u32(d, i + 16);
  const needsZip64 = disk === 0xffff || cdDisk === 0xffff || totalEntries === 0xffff
    || cdSize === 0xffffffff || cdOffset === 0xffffffff;
  if (needsZip64) {
    if (fileOff < 20) throw new Error("zip: truncated zip64 locator");
    const loc = await readRange(file, fileOff - 20, 20);
    const ld = new DataView(loc.buffer, loc.byteOffset, loc.byteLength);
    if (u32(ld, 0) !== SIG_EOCD64_LOC) throw new Error("zip: zip64 end-of-central-directory locator not found");
    const eocd64Off = u64(ld, 8);
    const rec = await readRange(file, eocd64Off, 56);
    const rd = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
    if (u32(rd, 0) !== SIG_EOCD64) throw new Error("zip: zip64 end-of-central-directory record not found");
    disk = u32(rd, 16); cdDisk = u32(rd, 20);
    totalEntries = u64(rd, 32); cdSize = u64(rd, 40); cdOffset = u64(rd, 48);
  }
  if (disk !== 0 || cdDisk !== 0) throw new Error("zip: multi-disk archives are not supported");
  const cd = await readRange(file, cdOffset, cdSize);
  const cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries = [];
  let p = 0;
  while (p + 46 <= cdSize) {
    if (u32(cdv, p) !== SIG_CENTRAL) throw new Error("zip: corrupt central directory (bad entry signature)");
    const flags = u16(cdv, p + 8), method = u16(cdv, p + 10);
    const crc = u32(cdv, p + 16);
    let compSize = u32(cdv, p + 20), uncompSize = u32(cdv, p + 24);
    const nameLen = u16(cdv, p + 28), extraLen = u16(cdv, p + 30), commentLen = u16(cdv, p + 32);
    let diskStart = u16(cdv, p + 34);
    let localOffset = u32(cdv, p + 42);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    const name = dec.decode(nameBytes);
    // Zip64 extra field (0x0001): values appear in order uncomp,
    // comp, local offset, disk — only for fields that were sentinel.
    let ep = p + 46 + nameLen, extraEnd = ep + extraLen;
    while (ep + 4 <= extraEnd) {
      const id = u16(cdv, ep), size = u16(cdv, ep + 2);
      if (id === 0x0001) {
        let q = ep + 4;
        if (uncompSize === 0xffffffff) { uncompSize = u64(cdv, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cdv, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(cdv, q); q += 8; }
        if (diskStart === 0xffff) { diskStart = u16(cdv, q); q += 2; }
      }
      ep += 4 + size;
    }
    if (diskStart !== 0) throw new Error("zip: multi-disk archives are not supported");
    const isDir = name.endsWith("/");
    if (!isDir) {
      if (flags & 0x01) throw new Error(`zip entry "${name}" is encrypted — encrypted zips are not supported`);
      if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
        throw new Error(`zip entry "${name}" uses compression method ${method} — only Stored (0) and Deflate (8) are supported`);
      }
    }
    entries.push({ name, method, flags, crc, compSize, uncompSize, localOffset, isDir });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (entries.length !== totalEntries) throw new Error(`zip: central directory entry count mismatch (found ${entries.length}, expected ${totalEntries})`);
  return entries;
}

// --- Per-entry streaming source -----------------------------------------
function zipEntrySource(file, entry) {
  let dataOffset = null;
  async function resolveDataOffset() {
    if (dataOffset !== null) return dataOffset;
    const head = await readRange(file, entry.localOffset, 30);
    const hd = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (u32(hd, 0) !== SIG_LOCAL) throw new Error(`zip entry "${entry.name}": bad local header (truncated archive?)`);
    dataOffset = entry.localOffset + 30 + u16(hd, 26) + u16(hd, 28);
    return dataOffset;
  }
  return {
    size: entry.uncompSize,
    async *chunks() {
      const start = await resolveDataOffset();
      let crc = 0xffffffff, produced = 0;
      // Over-yield guard: if the stream produces more than the central
      // directory promises, fail HERE naming the entry. Without this,
      // the packer feeds the excess to zstd (pledged at the declared
      // size) and fails with a cryptic "zstd_feed failed (-1)" instead.
      const checkOver = (n) => {
        if (produced + n > entry.uncompSize) {
          throw new Error(`zip entry "${entry.name}": decompressed more than its recorded ${entry.uncompSize} bytes (central directory size is wrong or the archive is corrupt)`);
        }
      };
      if (entry.method === METHOD_STORED) {
        for (let off = 0; off < entry.compSize; off += CHUNK) {
          const chunk = new Uint8Array(await file.slice(start + off, start + Math.min(entry.compSize, off + CHUNK)).arrayBuffer());
          checkOver(chunk.length);
          crc = crc32Update(crc, chunk); produced += chunk.length;
          yield chunk;
        }
      } else {
        const ds = new DecompressionStream("deflate-raw");
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        let pumpError = null;
        const pump = (async () => {
          try {
            for (let off = 0; off < entry.compSize; off += CHUNK) {
              const chunk = new Uint8Array(await file.slice(start + off, start + Math.min(entry.compSize, off + CHUNK)).arrayBuffer());
              await writer.write(chunk);
            }
            await writer.close();
          } catch (e) {
            pumpError = e;
            try { await writer.abort(e); } catch { /* already closed */ }
          }
        })();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            checkOver(value.length);
            crc = crc32Update(crc, value); produced += value.length;
            yield value;
          }
        } catch (e) {
          try { await reader.cancel(); } catch { /* already closed */ }
          await pump;
          // Errors already naming the entry (e.g. the over-yield guard
          // above) pass through unwrapped; anything else is a genuine
          // decompression failure.
          if (e.message.startsWith("zip entry ")) throw e;
          throw new Error(`zip entry "${entry.name}": decompression failed (${e.message})`);
        }
        await pump;
        if (pumpError) throw new Error(`zip entry "${entry.name}": failed reading compressed data (${pumpError.message})`);
      }
      if (produced !== entry.uncompSize) {
        throw new Error(`zip entry "${entry.name}": decompressed ${produced} bytes, expected ${entry.uncompSize}`);
      }
      if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) {
        throw new Error(`zip entry "${entry.name}": CRC32 mismatch (corrupt zip)`);
      }
    },
    async readRange(off, len) {
      const out = new Uint8Array(Math.min(len, Math.max(0, entry.uncompSize - off)));
      let pos = 0, filled = 0;
      for await (const c of this.chunks()) {
        if (pos + c.length <= off) { pos += c.length; continue; }
        const s = Math.max(0, off - pos);
        const take = Math.min(c.length - s, out.length - filled);
        out.set(c.subarray(s, s + take), filled);
        filled += take; pos += c.length;
        if (filled >= out.length) break;
      }
      return out.subarray(0, filled);
    },
    async readAll() {
      const parts = [];
      let total = 0;
      for await (const c of this.chunks()) { parts.push(c); total += c.length; }
      const out = new Uint8Array(total);
      let o = 0;
      for (const part of parts) { out.set(part, o); o += part.length; }
      return out;
    },
  };
}

// --- Tree + single-folder unwrap ----------------------------------------
function hasDir(node, lowerName) {
  return node.children.some((c) => c.children && c.name.toLowerCase() === lowerName);
}
function isBundleOrContent(node) {
  return hasDir(node, "base") || hasDir(node, "updates") || hasDir(node, "dlc")
    || hasDir(node, "exefs") || hasDir(node, "romfs");
}
function buildTree(file, entries) {
  const root = { name: "", children: [] };
  const dirMap = new Map([["", root]]);
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of sorted) {
    const parts = entry.name.split("/").filter((p) => p !== "" && p !== ".");
    if (!parts.length) continue;
    if (entry.isDir) {
      let parent = root, path = "";
      for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        let dir = dirMap.get(path);
        if (!dir && parent.children.some((c) => c.name === part)) throw new Error(`zip: file/directory name clash "${path}"`);
        if (!dir) { dir = { name: part, children: [] }; dirMap.set(path, dir); parent.children.push(dir); }
        parent = dir;
      }
      continue;
    }
    const leaf = parts[parts.length - 1];
    if (leaf === ".listing") continue;
    let parent = root, path = "";
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? `${path}/${parts[i]}` : parts[i];
      let dir = dirMap.get(path);
      if (!dir && parent.children.some((c) => c.name === parts[i])) throw new Error(`zip: file/directory name clash "${path}"`);
      if (!dir) { dir = { name: parts[i], children: [] }; dirMap.set(path, dir); parent.children.push(dir); }
      parent = dir;
    }
    if (parent.children.some((c) => c.name === leaf)) {
      throw new Error(`zip: duplicate entry "${entry.name}"`);
    }
    parent.children.push({ name: leaf, file: zipEntrySource(file, entry) });
  }
  const sortRec = (n) => {
    n.children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    n.children.forEach((c) => { if (c.children) sortRec(c); });
  };
  sortRec(root);
  return root;
}

// Open a zip and return a folder node that discover() can scan, plus
// entry metadata for display/testing. The node's name is the zip file
// name (used as the packages' source name); its children are the dump
// tree, unwrapped past any single-folder wrappers.
export async function openZip(file) {
  if (!file || typeof file.size !== "number" || typeof file.slice !== "function") {
    throw new Error("zip: input must be a File-like object with size and slice()");
  }
  const entries = await parseCentral(file);
  const tree = buildTree(file, entries);
  let cur = tree;
  while (cur.children.length === 1 && cur.children[0].children
    && !cur.children.some((c) => !c.children) && !isBundleOrContent(cur)) {
    cur = cur.children[0];
  }
  const files = entries.filter((e) => !e.isDir);
  return {
    name: file.name || "archive.zip",
    root: { name: file.name || "archive.zip", children: cur.children },
    entries,
    fileCount: files.length,
    totalUncompressed: files.reduce((a, e) => a + e.uncompSize, 0),
  };
}
