// test/test-tally.mjs — verifies the live final-outcome tally
// (deduplicated / compressed / uncompressed) reported by packNup.
//   node test/test-tally.mjs
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWasm, packNup, CHUNK } from "../packer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = join(root, "test", "tmp-tally");
const outPath = join(root, "test", "test-tally-out.nup");
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

async function buildPackages() {
  await fs.rm(tmp, { recursive: true, force: true });
  const write = async (rel, data) => {
    const p = join(tmp, rel);
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  };
  const main = Buffer.alloc(0x80, 0); main.write("NSO0", 0);
  const npdm = Buffer.alloc(0x200, 0); npdm.write("ACI0", 0x100);
  npdm.writeBigUInt64LE(0x0100000000010000n, 0x110);
  await write("base/exefs/main", main);            // tiny, incompressible-ish NSO header zeros -> compressible (zeros)
  await write("base/exefs/main.npdm", npdm);       // mostly zeros -> compressible
  const text = Buffer.from("hello world ".repeat(5000)); // ~60 KB, compressible
  await write("base/romfs/a.txt", text);           // compressed
  await write("base/romfs/b.txt", text);           // dedup of a.txt
  await write("base/romfs/empty.txt", Buffer.alloc(0)); // empty -> raw bucket
  await write("base/romfs/rand.bin", randomBytes(10000)); // incompressible -> raw fallback
  const big = randomBytes(200000);
  await write("base/romfs/big1.bin", big);         // > lowered threshold -> raw
  await write("base/romfs/big2.bin", big);         // > threshold, duplicate -> dedup

  const mkNode = async (dirPath, name) => {
    const st = await fs.stat(join(dirPath));
    if (st.isDirectory()) {
      const kids = [];
      for (const k of await fs.readdir(dirPath)) kids.push(await mkNode(join(dirPath, k), k));
      return { name, children: kids };
    }
    return { name, file: fileSource(dirPath, st.size) };
  };
  const rootNode = await mkNode(join(tmp, "base"), "base");
  return [{
    kind: 0, titleId: 0x0100000000010000n, version: 0,
    root: rootNode,
  }];
}

// Mimic buildTree's expectations: packer builds its own tree from packages'
// root nodes; check test.mjs for the node shape it passes.
const wasm = await loadWasm(await fs.readFile(join(root, "nup.wasm")));

let lastTally = null;
let sawLiveTally = false;
const run = async () => {
  const packages = await buildPackages();
  const out = await fs.open(outPath, "w");
  const output = {
    writeAt: async (pos, bytes) => { await out.write(bytes, 0, bytes.length, pos); },
    truncate: async (size) => { await out.truncate(size); },
    close: async () => { await out.close(); },
  };
  const result = await packNup(wasm, packages, output, {
    level: 3,
    rawThreshold: 64 * 1024, // lowered so big1/big2 take the large-file path
    appMeta: { titleName: "Tally Test", displayVersion: "1.0.0", publisher: null, icon: null },
    onProgress: (pr) => {
      if (pr.tally) {
        lastTally = pr.tally;
        // Invariant: every finished file is in exactly one bucket.
        if (pr.tally.dedup + pr.tally.compressed + pr.tally.raw === pr.filesDone) sawLiveTally = true;
      }
    },
  });
  return result;
};

const r1 = await run();
console.log("run 1 tally:", JSON.stringify(r1.tally), "files:", r1.fileCount);
check(r1.tally.dedup === 2, `dedup == 2 (b.txt + big2.bin), got ${r1.tally.dedup}`);
check(r1.tally.raw === 3, `raw == 3 (empty.txt + rand.bin + big1.bin), got ${r1.tally.raw}`);
check(r1.tally.compressed === r1.fileCount - 5, `compressed == ${r1.fileCount - 5} (rest), got ${r1.tally.compressed}`);
check(r1.tally.dedup + r1.tally.compressed + r1.tally.raw === r1.fileCount, "tally sums to fileCount");
check(sawLiveTally, "live progress tally always summed to filesDone");
check(lastTally && lastTally.dedup === r1.tally.dedup && lastTally.compressed === r1.tally.compressed && lastTally.raw === r1.tally.raw, "final live tally matches result tally");

// Repeated conversion: counters are per-run, must not accumulate.
const r2 = await run();
check(r2.tally.dedup === r1.tally.dedup && r2.tally.compressed === r1.tally.compressed && r2.tally.raw === r1.tally.raw, "second run tally identical (no accumulation)");

await fs.rm(tmp, { recursive: true, force: true });
await fs.rm(outPath, { force: true });
if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("all tally checks passed");
