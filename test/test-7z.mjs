// test/test-7z.mjs — 7z input for webasm_nup, no browser.
//   node test/test-7z.mjs
// Fixtures (in test/, created with py7zr from the same dump tree as
// test-zip.mjs, wrapped in a single "game/" folder):
//   solid-lzma2.7z  — py7zr default: BCJ (x86) + LZMA2, solid, encoded header
//   solid-lzma.7z   — LZMA only, solid, encoded header
//   solid-copy.7z   — Copy (stored), solid, encoded header
//   solid-delta.7z  — Delta (dist 4) + LZMA2, solid, encoded header
//   solid-encrypted.7z — AES-256, must fail with a clear error
// Each good fixture is packed through sevenz.js + packer.js; all four
// must produce byte-identical .nup files — the coders must not affect
// the output, only the uncompressed bytes do. That cross-coder identity
// is the decode-correctness proof (a wrong BCJ/Delta/LZMA decode would
// change the bytes and break identity), plus direct readAll checks
// against known content. This is a regression check, not a substitute
// for the reference verifier — see test-zip.mjs for `nup verify`.
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWasm, packNup } from "../packer.js";
import { loadLzma } from "../lzma.js";
import { openSevenz } from "../sevenz.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(cond, label) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
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
  const hello = Buffer.from("hello world ".repeat(5000));
  const wasm = await loadWasm(await fs.readFile(join(root, "nup.wasm")));
  const lzma = await loadLzma(await fs.readFile(join(root, "lzma.wasm")));
  const hashes = {};
  for (const label of ["solid-lzma2", "solid-lzma", "solid-copy", "solid-delta"]) {
    const buf = await fs.readFile(join(root, "test", `${label}.7z`));
    const z = await openSevenz(fileLike(`${label}.7z`, buf), lzma);
    check(z.fileCount === 5, `${label}: fileCount == 5 (got ${z.fileCount})`);
    check(z.totalUncompressed === 70640, `${label}: totalUncompressed == 70640 (got ${z.totalUncompressed})`);
    const baseDir = z.root.children.find((c) => c.children && c.name === "base");
    check(!!baseDir, `${label}: base dir found in 7z tree`);
    const exefs = baseDir.children.find((c) => c.children && c.name === "exefs");
    const romfs = baseDir.children.find((c) => c.children && c.name === "romfs");
    const npdmBack = Buffer.from(await exefs.children.find((c) => c.name === "main.npdm").file.readAll());
    check(npdmBack.equals(npdm), `${label}: NPDM readAll matches known bytes`);
    const helloBack = Buffer.from(await romfs.children.find((c) => c.name === "hello.txt").file.readAll());
    check(helloBack.equals(hello), `${label}: hello.txt readAll matches known bytes`);
    const emptyBack = await romfs.children.find((c) => c.name === "empty.txt").file.readAll();
    check(emptyBack.length === 0, `${label}: empty.txt reads back empty`);
    const packages = [{
      kind: 0, titleId: 0x0100000000010000n, version: 0x10000, flags: 0,
      root: { name: "", children: baseDir.children }, npdm, buildId: null, sourceName: "7z-test",
    }];
    const outPath = join(root, "test", `test-7z-${label}.nup`);
    const fh = await fs.open(outPath, "w");
    const output = {
      writeAt: (pos, data) => fh.write(data, 0, data.length, pos),
      truncate: (size) => fh.truncate(size),
      close: () => fh.close(),
    };
    const result = await packNup(wasm, packages, output, { level: 1, appMeta: { titleName: "7z Test", displayVersion: "1.0.0", publisher: null, icon: null } });
    check(result.fileCount === 5, `${label}: packed fileCount == 5`);
    const bytes = await fs.readFile(outPath);
    check(bytes.length === result.fileSize, `${label}: output size matches result`);
    hashes[label] = createHash("sha256").update(bytes).digest("hex");
  }
  const allEqual = Object.values(hashes).every((h) => h === hashes["solid-lzma2"]);
  check(allEqual, `all four coder variants produce byte-identical .nup (sha ${hashes["solid-lzma2"]})`);
  // Encrypted fixture: must fail naming encryption, at open or at pack.
  try {
    const buf = await fs.readFile(join(root, "test", "solid-encrypted.7z"));
    const z = await openSevenz(fileLike("solid-encrypted.7z", buf), lzma);
    const baseDir = z.root.children.find((c) => c.children && c.name === "base");
    const fh = await fs.open(join(root, "test", "test-7z-encrypted.nup"), "w");
    await packNup(wasm, [{
      kind: 0, titleId: 0x0100000000010000n, version: 0x10000, flags: 0,
      root: { name: "", children: baseDir.children }, npdm, buildId: null, sourceName: "7z-test",
    }], {
      writeAt: (pos, data) => fh.write(data, 0, data.length, pos),
      truncate: (size) => fh.truncate(size),
      close: () => fh.close(),
    }, { level: 1 });
    check(false, "encrypted 7z: packing should have thrown");
  } catch (e) {
    check(/encrypt/i.test(e.message), `encrypted 7z: clear encryption error (got: ${e.message})`);
  }
  // Non-7z input.
  try {
    await openSevenz(fileLike("x.7z", Buffer.from("this is not a 7z file at all........")), lzma);
    check(false, "non-7z: openSevenz should have thrown");
  } catch (e) {
    check(/not a 7z/.test(e.message), `non-7z: clear error (got: ${e.message})`);
  }
  console.log(failures ? `${failures} check(s) FAILED` : "all 7z checks passed");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error("7z test failed:", e); process.exit(1); });
