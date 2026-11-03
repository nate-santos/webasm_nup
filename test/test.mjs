// test/test.mjs — end-to-end pack + structural verification, no browser.
//   node test/test.mjs
// Builds a small synthetic dump (base + update + DLC, compressible,
// incompressible, duplicate and empty files), packs it with packer.js +
// nup.wasm, then checks the output structurally: superblock, TOC hash,
// sorted children, extent alignment/codecs, dedup sharing, meta TLVs
// (title, display version, icon) and the UUID. This is a regression
// check, not a substitute for the reference verifier — see README for
// running the reference Python tool's `nup verify` on test-out.nup.
import { promises as fs } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWasm, packNup, CHUNK } from "../packer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = join(root, "test", "tmp-dump");
const outPath = join(root, "test", "test-out.nup");
let failures = 0;
function check(cond, label) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function fileSource(path, size) {
  return {
    size,
    async *chunks() {
      const fh = await fs.open(path, "r");
      try {
        const buf = Buffer.alloc(CHUNK);
        let off = 0;
        while (off < size) {
          const n = Math.min(CHUNK, size - off);
          const { bytesRead } = await fh.read(buf, 0, n, off);
          yield new Uint8Array(buf.subarray(0, bytesRead));
          off += bytesRead;
        }
      } finally { await fh.close(); }
    },
  };
}
async function buildDump() {
  await fs.rm(tmp, { recursive: true, force: true });
  const write = async (rel, data) => {
    const p = join(tmp, rel);
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  };
  // Fake NSO main: "NSO0" at 0, build ID bytes 0x40..0x60.
  const main = Buffer.alloc(0x80, 0);
  main.write("NSO0", 0);
  for (let i = 0; i < 32; i++) main[0x40 + i] = 0xab;
  await write("base/exefs/main", main);
  // Fake NPDM: "ACI0" at 0x100, program ID at +0x10.
  const npdm = Buffer.alloc(0x200, 0);
  npdm.write("ACI0", 0x100);
  npdm.writeBigUInt64LE(0x0100000000010000n, 0x110);
  await write("base/exefs/main.npdm", npdm);
  await write("base/romfs/hello.txt", Buffer.from("hello world ".repeat(5000)));
  await write("base/romfs/duplicate.txt", Buffer.from("hello world ".repeat(5000)));
  await write("base/romfs/empty.txt", Buffer.alloc(0));
  await write("base/romfs/random.bin", randomBytes(10000)); // incompressible -> raw fallback
  await write("base/romfs/nested/deep/file.txt", Buffer.from("deep\n".repeat(100)));
  await write("base/data/extra.txt", Buffer.from("extra data"));
  await write("updates/458752/exefs/main.npdm", npdm);
  await write("updates/458752/romfs/patch.txt", Buffer.from("patched! ".repeat(1000)));
  await write("dlc/040074a01bf13001/0/romfs/dlc.txt", Buffer.from("dlc content ".repeat(500)));
  // A >rawThreshold file when the threshold is lowered for the test.
  await write("base/romfs/big.bin", randomBytes(200000));
  // Files over the 4 MiB sampling floor, for the second pack below
  // (default threshold, level 1): random -> raw via sampling, repetitive
  // -> zstd. 6 MiB each keeps the test fast while crossing the floor.
  await write("base/romfs/rand6.bin", randomBytes(6 * 1024 * 1024));
  await write("base/romfs/rep6.bin", Buffer.from("abcd1234 ".repeat((6 * 1024 * 1024) / 9)));
  return { npdm, main };
}
async function scanDir(dir, name) {
  const entries = (await fs.readdir(dir, { withFileTypes: true }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const children = [];
  for (const e of entries) {
    if (e.name === ".listing") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) children.push(await scanDir(p, e.name));
    else children.push({ name: e.name, file: fileSource(p, (await fs.stat(p)).size) });
  }
  return { name, children };
}
// Parse a packed .nup's TOC into packages/dirs/files with pool names.
// Shared by the main pack checks and the sampling-pack checks below.
function parseToc(data) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tocSize = Number(v.getBigUint64(0x10, true));
  const blobOffset = Number(v.getBigUint64(0x38, true));
  const fileSize = Number(v.getBigUint64(0x40, true));
  const toc = data.subarray(0x80, 0x80 + tocSize);
  const tv = new DataView(toc.buffer, toc.byteOffset, toc.byteLength);
  const pkgCount = v.getUint32(0x48, true);
  const dirCount = Number(new DataView(toc.buffer, toc.byteOffset + 8, 8).getBigUint64(0, true));
  const fileCount = Number(new DataView(toc.buffer, toc.byteOffset + 16, 8).getBigUint64(0, true));
  let p = 48;
  const pkgs = [];
  for (let i = 0; i < pkgCount; i++) {
    pkgs.push({
      titleId: tv.getBigUint64(p, true), root: tv.getUint32(p + 8, true),
      exefs: tv.getUint32(p + 12, true), romfs: tv.getUint32(p + 16, true),
      version: tv.getUint32(p + 20, true), kind: toc[p + 24], flags: toc[p + 25],
      metaOff: Number(tv.getBigUint64(p + 32, true)), metaSize: tv.getUint32(p + 40, true),
    });
    p += 64;
  }
  const dirs = [];
  for (let i = 0; i < dirCount; i++) {
    dirs.push({ nameOff: tv.getUint32(p, true), nameLen: tv.getUint32(p + 4, true), first: tv.getUint32(p + 8, true), count: tv.getUint32(p + 12, true) });
    p += 24;
  }
  const files = [];
  for (let i = 0; i < fileCount; i++) {
    files.push({
      nameOff: tv.getUint32(p, true), nameLen: tv.getUint32(p + 4, true),
      size: Number(tv.getBigUint64(p + 8, true)), off: Number(tv.getBigUint64(p + 16, true)),
      stored: Number(tv.getBigUint64(p + 24, true)), sha: Buffer.from(toc.subarray(p + 32, p + 64)),
      codec: toc[p + 64],
    });
    p += 80;
  }
  const poolOff = Number(tv.getBigUint64(24, true));
  const pool = toc.subarray(poolOff);
  const poolName = (off, len) => Buffer.from(pool.subarray(off, off + len)).toString("utf8");
  const fileNames = files.map((f) => poolName(f.nameOff, f.nameLen));
  const slotCount = dirs.reduce((a, d) => a + d.count, 0);
  const childArr = [];
  for (let i = 0; i < slotCount; i++) childArr.push(tv.getUint32(p, true)), p += 4;
  let sortedOk = true;
  for (const d of dirs) {
    const names = childArr.slice(d.first, d.first + d.count).map((cid) =>
      cid < dirCount ? poolName(dirs[cid].nameOff, dirs[cid].nameLen) : poolName(files[cid - dirCount].nameOff, files[cid - dirCount].nameLen));
    const sorted = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    if (JSON.stringify(names) !== JSON.stringify(sorted)) sortedOk = false;
  }
  return { tocSize, blobOffset, fileSize, toc, pkgCount, dirCount, fileCount, pkgs, dirs, files, poolName, fileNames, sortedOk };
}
async function main() {
  const { npdm } = await buildDump();
  const baseRoot = await scanDir(join(tmp, "base"), "");
  const updRoot = await scanDir(join(tmp, "updates", "458752"), "");
  const dlcRoot = await scanDir(join(tmp, "dlc", "040074a01bf13001", "0"), "");
  const titleId = 0x0100000000010000n;
  const packages = [
    { kind: 0, titleId, version: 0x10000, flags: 0, root: baseRoot, npdm, buildId: null, sourceName: "tmp-dump" },
    { kind: 1, titleId, version: 458752, flags: 0, root: updRoot, npdm, buildId: null, sourceName: "tmp-dump" },
    { kind: 2, titleId: 0x040074a01bf13001n, version: 0, flags: 0, root: dlcRoot, npdm: null, buildId: null, sourceName: "tmp-dump" },
  ];
  const wasm = await loadWasm(await fs.readFile(join(root, "nup.wasm")));
  const fh = await fs.open(outPath, "w");
  const output = {
    writeAt: (pos, data) => fh.write(data, 0, data.length, pos),
    truncate: (size) => fh.truncate(size),
    close: () => fh.close(),
  };
  const icon = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // fake JPEG, format-level only
  const result = await packNup(wasm, packages, output, {
    level: 3, rawThreshold: 65536, // force big.bin (200 KiB) down the large-file raw path
    appMeta: { titleName: "Test Game", displayVersion: "1.0.0", publisher: "Acme", icon },
  });
  console.log("packed:", result);

  // --- structural verification ---
  const data = await fs.readFile(outPath);
  check(data[0] === 0x4e && data[1] === 0x55 && data[2] === 0x50 && data[3] === 0x01, "superblock magic NUP\\x01");
  const { tocSize, blobOffset, fileSize, toc, pkgCount, pkgs, files, poolName, fileNames, sortedOk } = parseToc(data);
  check(fileSize === data.length, `file_size ${fileSize} == actual ${data.length}`);
  check(blobOffset % 16 === 0 && blobOffset === 0x80 + tocSize || blobOffset >= 0x80 + tocSize, "blob offset aligned and after TOC");
  const tocSha = createHash("sha256").update(toc).digest();
  check(Buffer.compare(Buffer.from(tocSha), Buffer.from(data.subarray(0x18, 0x38))) === 0, "TOC SHA-256 matches superblock");
  check(toc[0] === 0x54 && toc[1] === 0x4f && toc[2] === 0x43 && toc[3] === 0x01, "TOC magic");
  check(pkgCount === 3, `package count ${pkgCount} == 3`);
  check(fileNames.includes("hello.txt") && fileNames.includes("duplicate.txt"), "hello/duplicate present");
  check(fileNames.includes("big.bin") && fileNames.includes("patch.txt") && fileNames.includes("dlc.txt"), "update + DLC files present");
  const hello = files[fileNames.indexOf("hello.txt")];
  const dup = files[fileNames.indexOf("duplicate.txt")];
  check(hello.off === dup.off && hello.stored === dup.stored && hello.codec === dup.codec, "duplicate shares one extent");
  check(hello.codec === 1, "compressible file uses zstd codec 1");
  const rand = files[fileNames.indexOf("random.bin")];
  check(rand.codec === 0 && rand.stored === rand.size, "incompressible file falls back to raw");
  const big = files[fileNames.indexOf("big.bin")];
  check(big.codec === 0, "over-threshold file stored raw");
  const empty = files[fileNames.indexOf("empty.txt")];
  check(empty.off === 0 && empty.stored === 0 && empty.codec === 0, "empty file has no extent");
  check(files.every((f) => f.size === 0 || f.off % 16 === 0), "all extents 16-aligned");
  check(files.every((f) => f.size === 0 || (f.off >= blobOffset && f.off + f.stored <= fileSize)), "all extents inside file");
  // Raw extents must hash to their stored SHA-256.
  for (const f of files.filter((x) => x.codec === 0 && x.size > 0)) {
    const got = createHash("sha256").update(data.subarray(f.off, f.off + f.size)).digest();
    check(Buffer.compare(got, f.sha) === 0, `raw SHA matches for ${poolName(f.nameOff, f.nameLen)}`);
  }
  // Meta TLVs on the base package: title, display version, icon, NPDM.
  const baseMeta = data.subarray(pkgs[0].metaOff, pkgs[0].metaOff + pkgs[0].metaSize);
  const tlvs = new Map();
  let mp = 0;
  while (mp + 8 <= baseMeta.length) {
    const t = baseMeta.readUInt16LE(mp), sz = baseMeta.readUInt32LE(mp + 4);
    tlvs.set(t, Buffer.from(baseMeta.subarray(mp + 8, mp + 8 + sz)));
    mp += 8 + sz;
  }
  check(tlvs.get(0x0005)?.toString() === "Test Game", "meta title name TLV 0x0005");
  check(tlvs.get(0x0004)?.toString() === "1.0.0", "meta display version TLV 0x0004");
  check(tlvs.get(0x0003)?.equals(icon), "meta icon TLV 0x0003");
  check(tlvs.get(0x0001)?.equals(npdm), "meta NPDM TLV 0x0001");
  // UUID: sha256(titleId||version||kind per package)[0..16]
  const uuidIn = Buffer.concat(pkgs.map((pk) => {
    const b = Buffer.alloc(13);
    b.writeBigUInt64LE(pk.titleId, 0); b.writeUInt32LE(pk.version, 8); b[12] = pk.kind;
    return b;
  }));
  const uuid = createHash("sha256").update(uuidIn).digest().subarray(0, 16);
  check(Buffer.compare(Buffer.from(uuid), Buffer.from(data.subarray(0x50, 0x60))) === 0, "UUID matches §2.1");
  check(sortedOk, "children sorted bytewise per directory");

  // --- second pack: sampling + level 1, default raw threshold ---
  // Same packages, but files over 256 MiB would be raw anyway; here the
  // 6 MiB files take the compress branch, so rand6 must go raw via the
  // 1 MiB sample and rep6 must stay zstd at level 1.
  const outPath2 = join(root, "test", "test-out-sampling.nup");
  const fh2 = await fs.open(outPath2, "w");
  const output2 = {
    writeAt: (pos, data2) => fh2.write(data2, 0, data2.length, pos),
    truncate: (size) => fh2.truncate(size),
    close: () => fh2.close(),
  };
  await packNup(wasm, packages, output2, { level: 1, appMeta: { titleName: "Test Game", displayVersion: "1.0.0", publisher: "Acme", icon } });
  const data2 = await fs.readFile(outPath2);
  const parsed2 = parseToc(data2);
  check(parsed2.fileSize === data2.length, "sampling pack: file_size == actual");
  const rand6 = parsed2.files[parsed2.fileNames.indexOf("rand6.bin")];
  const rep6 = parsed2.files[parsed2.fileNames.indexOf("rep6.bin")];
  check(rand6 && rand6.codec === 0 && rand6.stored === rand6.size, "sampling: random 6 MiB file stored raw");
  check(rep6 && rep6.codec === 1 && rep6.stored < rep6.size, "sampling: repetitive 6 MiB file uses zstd codec 1");
  if (rand6 && rand6.codec === 0) {
    const got = createHash("sha256").update(data2.subarray(rand6.off, rand6.off + rand6.size)).digest();
    check(Buffer.compare(got, rand6.sha) === 0, "sampling: raw SHA matches for rand6.bin");
  }
  console.log(failures ? `${failures} check(s) FAILED` : "all checks passed");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error("test failed:", e); process.exit(1); });
