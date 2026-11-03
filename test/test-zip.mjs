// test/test-zip.mjs — zip input for webasm_nup, no browser.
//   node test/test-zip.mjs
// Builds small zips in memory (Stored, Deflate, forced-zip64, corrupt,
// unsupported-method, encrypted) with Node's zlib for the Deflate ones,
// packs each good zip through zip.js + packer.js, and checks that the
// three good inputs produce byte-identical .nup files — zip method must
// not affect the output, only the uncompressed bytes do. Corrupt and
// unsupported inputs must fail with a clear error naming the problem.
// This is a regression check, not a substitute for the reference
// verifier — see the main test's README note for `nup verify`.
import { promises as fs } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWasm, packNup } from "../packer.js";
import { openZip } from "../zip.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(cond, label) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xffffffff) >>> 0;
}
// Minimal zip writer: local headers + central directory + EOCD, with
// optional forced zip64 (sentinel sizes + zip64 extra fields + zip64
// EOCD + locator, even for small files — exactly what a zip64 reader
// must handle, without needing a 4 GiB fixture).
function buildZip(entries, { forceZip64 = false } = {}) {
  const parts = [];
  const centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);
    const zip64 = forceZip64;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(e.flags || 0, 6);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? 0xffffffff : data.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localExtra = zip64 ? Buffer.concat([Buffer.from([0x01, 0x00, 0x10, 0x00]), Buffer.alloc(16)]) : Buffer.alloc(0);
    if (zip64) {
      localExtra.writeBigUInt64LE(BigInt(e.data.length), 4);
      localExtra.writeBigUInt64LE(BigInt(data.length), 12);
    }
    local.writeUInt16LE(localExtra.length, 28);
    parts.push(local, name, localExtra, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(zip64 ? 45 : 20, 4);
    central.writeUInt16LE(zip64 ? 45 : 20, 6);
    central.writeUInt16LE(e.flags || 0, 8);
    central.writeUInt16LE(e.method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20);
    // centralUncomp lets a test lie about the recorded size while the
    // actual stream stays honest (and CRC-valid).
    central.writeUInt32LE(zip64 ? 0xffffffff : (e.centralUncomp !== undefined ? e.centralUncomp : e.data.length), 24);
    central.writeUInt16LE(name.length, 28);
    const centralExtra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      centralExtra.writeUInt16LE(0x0001, 0);
      centralExtra.writeUInt16LE(24, 2);
      centralExtra.writeBigUInt64LE(BigInt(e.data.length), 4);
      centralExtra.writeBigUInt64LE(BigInt(data.length), 12);
      centralExtra.writeBigUInt64LE(BigInt(off), 20);
    }
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : off, 42);
    centrals.push(central, name, centralExtra);
    e._localOffset = off;
    off += 30 + name.length + localExtra.length + data.length;
  }
  const cdOffset = off;
  const cd = Buffer.concat(centrals);
  off += cd.length;
  parts.push(cd);
  if (forceZip64) {
    const eocd64 = Buffer.alloc(56);
    eocd64.writeUInt32LE(0x06064b50, 0);
    eocd64.writeBigUInt64LE(44n, 4);
    eocd64.writeUInt16LE(45, 12);
    eocd64.writeUInt16LE(45, 14);
    eocd64.writeBigUInt64LE(BigInt(entries.length), 24);
    eocd64.writeBigUInt64LE(BigInt(entries.length), 32);
    eocd64.writeBigUInt64LE(BigInt(cd.length), 40);
    eocd64.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(off), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(eocd64, loc);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    parts.push(eocd);
  } else {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    parts.push(eocd);
  }
  return { buf: Buffer.concat(parts), entries };
}
function fileLike(name, buf) {
  return {
    name, size: buf.length,
    slice: (s, e) => ({ arrayBuffer: async () => buf.buffer.slice(buf.byteOffset + s, buf.byteOffset + e) }),
  };
}
async function main() {
  const npdm = Buffer.alloc(0x200, 0);
  npdm.write("ACI0", 0x100);
  npdm.writeBigUInt64LE(0x0100000000010000n, 0x110);
  const mainBin = Buffer.alloc(0x80, 0);
  mainBin.write("NSO0", 0);
  const hello = Buffer.from("hello world ".repeat(5000));
  const rand = randomBytes(10000);
  const content = [
    { name: "base/exefs/main", method: 0, data: mainBin },
    { name: "base/exefs/main.npdm", method: 0, data: npdm },
    { name: "base/romfs/hello.txt", method: 0, data: hello },
    { name: "base/romfs/random.bin", method: 0, data: rand },
  ];
  const wasm = await loadWasm(await fs.readFile(join(root, "nup.wasm")));
  const hashes = {};
  async function packZip(label, zipBuf, outName) {
    const z = await openZip(fileLike("game.zip", zipBuf));
    check(z.fileCount === 4, `${label}: fileCount == 4 (got ${z.fileCount})`);
    const baseDir = z.root.children.find((c) => c.children && c.name === "base");
    check(!!baseDir, `${label}: base dir found in zip tree`);
    const packages = [{
      kind: 0, titleId: 0x0100000000010000n, version: 0x10000, flags: 0,
      root: { name: "", children: baseDir.children }, npdm, buildId: null, sourceName: "zip-test",
    }];
    const outPath = join(root, "test", outName);
    const fh = await fs.open(outPath, "w");
    const output = {
      writeAt: (pos, data) => fh.write(data, 0, data.length, pos),
      truncate: (size) => fh.truncate(size),
      close: () => fh.close(),
    };
    const result = await packNup(wasm, packages, output, { level: 1, appMeta: { titleName: "Zip Test", displayVersion: "1.0.0", publisher: null, icon: null } });
    check(result.fileCount === 4, `${label}: packed fileCount == 4`);
    const bytes = await fs.readFile(outPath);
    check(bytes.length === result.fileSize, `${label}: output size matches result`);
    hashes[label] = createHash("sha256").update(bytes).digest("hex");
    return z;
  }
  // Stored, wrapped in a single top-level folder (unwrap path).
  const wrapped = content.map((e) => ({ ...e, name: `game/${e.name}` }));
  const stored = buildZip(wrapped);
  await packZip("stored", stored.buf, "test-zip-stored.nup");
  // Deflate, no wrapper.
  const deflated = buildZip(content.map((e) => ({ ...e, method: 8 })));
  await packZip("deflate", deflated.buf, "test-zip-deflate.nup");
  // Forced zip64, stored.
  const z64 = buildZip(content, { forceZip64: true });
  await packZip("zip64", z64.buf, "test-zip-zip64.nup");
  check(hashes.stored === hashes.deflate && hashes.deflate === hashes.zip64,
    `stored/deflate/zip64 outputs byte-identical (sha ${hashes.stored})`);
  // readRange / readAll on a zip entry (the path packageMeta uses).
  const z = await openZip(fileLike("game.zip", deflated.buf));
  const baseDir = z.root.children.find((c) => c.children && c.name === "base");
  const romfs = baseDir.children.find((c) => c.children && c.name === "romfs");
  const helloFile = romfs.children.find((c) => c.name === "hello.txt").file;
  const head = await helloFile.readRange(0, 5);
  check(Buffer.from(head).toString() === "hello", "zip entry readRange returns first bytes");
  const exefs = baseDir.children.find((c) => c.children && c.name === "exefs");
  const npdmFile = exefs.children.find((c) => c.name === "main.npdm").file;
  const npdmBack = await npdmFile.readAll();
  check(Buffer.from(npdmBack).equals(npdm), "zip entry readAll returns full NPDM");
  // Corrupt: flip a byte in the stored hello.txt data; packing must fail on CRC.
  const corrupt = Buffer.from(stored.buf);
  const helloEntry = stored.entries.find((e) => e.name.endsWith("hello.txt"));
  corrupt[helloEntry._localOffset + 30 + Buffer.from(helloEntry.name, "utf8").length + 10] ^= 0xff;
  try {
    const zc = await openZip(fileLike("game.zip", corrupt));
    const baseC = zc.root.children.find((c) => c.children && c.name === "base");
    const fh = await fs.open(join(root, "test", "test-zip-corrupt.nup"), "w");
    await packNup(wasm, [{
      kind: 0, titleId: 0x0100000000010000n, version: 0x10000, flags: 0,
      root: { name: "", children: baseC.children }, npdm, buildId: null, sourceName: "zip-test",
    }], {
      writeAt: (pos, data) => fh.write(data, 0, data.length, pos),
      truncate: (size) => fh.truncate(size),
      close: () => fh.close(),
    }, { level: 1 });
    check(false, "corrupt zip: packing should have thrown on CRC mismatch");
  } catch (e) {
    check(/CRC32/.test(e.message), `corrupt zip: fails with CRC32 error (got: ${e.message})`);
  }
  // Unsupported method (bzip2 = 12) and encrypted entry must fail at open.
  try {
    await openZip(fileLike("game.zip", buildZip([{ name: "base/romfs/x.bin", method: 12, data: Buffer.from("x") }]).buf));
    check(false, "unsupported method: openZip should have thrown");
  } catch (e) {
    check(/method 12/.test(e.message), `unsupported method: clear error (got: ${e.message})`);
  }
  try {
    await openZip(fileLike("game.zip", buildZip([{ name: "base/romfs/x.bin", method: 0, flags: 1, data: Buffer.from("x") }]).buf));
    check(false, "encrypted entry: openZip should have thrown");
  } catch (e) {
    check(/encrypted/.test(e.message), `encrypted entry: clear error (got: ${e.message})`);
  }
  try {
    await openZip(fileLike("game.zip", Buffer.from("this is not a zip file at all, just text........")));
    check(false, "non-zip: openZip should have thrown");
  } catch (e) {
    check(/not a zip/.test(e.message), `non-zip: clear error (got: ${e.message})`);
  }
  // Lied central-directory sizes: the packer pledges the recorded size
  // to zstd, so an over-yielding stream used to die as the cryptic
  // "zstd_feed failed (-1)". Both directions must now fail clearly,
  // naming the size problem and never mentioning zstd.
  for (const [label, centralUncomp, pattern] of [
    ["lied-smaller", 5000, /decompressed more than its recorded 5000 bytes/],
    ["lied-larger", 20000, /20000/],
  ]) {
    const liedData = Buffer.from("hello world ".repeat(800)); // 9600 bytes
    const lied = buildZip([{ name: "base/romfs/lie.bin", method: 8, data: liedData, centralUncomp }]);
    try {
      const zl = await openZip(fileLike("lie.zip", lied.buf));
      const baseL = zl.root.children.find((c) => c.children && c.name === "base");
      const fh = await fs.open(join(root, "test", "test-zip-lied.nup"), "w");
      await packNup(wasm, [{
        kind: 0, titleId: 0x0100000000010000n, version: 0x10000, flags: 0,
        root: { name: "", children: baseL.children }, npdm, buildId: null, sourceName: "zip-test",
      }], {
        writeAt: (pos, data) => fh.write(data, 0, data.length, pos),
        truncate: (size) => fh.truncate(size),
        close: () => fh.close(),
      }, { level: 1 });
      check(false, `${label}: packing should have thrown`);
    } catch (e) {
      check(pattern.test(e.message) && !/zstd_feed/.test(e.message),
        `${label}: clear size error, no wasm error (got: ${e.message})`);
    }
  }
  console.log(failures ? `${failures} check(s) FAILED` : "all zip checks passed");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error("zip test failed:", e); process.exit(1); });
