// app.js — browser UI for webasm_nup. No build step, no framework.
// Folder scanning, package discovery, OPFS output and the save-as copy
// live here; the .nup writer itself is packer.js, and hashing/zstd are
// in nup.wasm. Everything runs locally; nothing is uploaded.
import { loadWasm, packNup, encodeVersion, CHUNK } from "./packer.js";
import { openZip } from "./zip.js";
import { loadLzma } from "./lzma.js";
import { openSevenz } from "./sevenz.js";

// lzma.wasm is only fetched when the first .7z file is added — zip and
// folder inputs never load it.
let lzmaPromise = null;
function getLzma() {
  if (!lzmaPromise) {
    lzmaPromise = fetch("lzma.wasm").then(async (res) => {
      if (!res.ok) throw new Error(`could not load lzma.wasm (${res.status})`);
      return loadLzma(new Uint8Array(await res.arrayBuffer()));
    });
  }
  return lzmaPromise;
}

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
function cmpStr(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let v = n, i = -1;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
function sanitizeName(name) {
  const s = (name || "game").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "game";
}
function hex16(n) {
  return BigInt(n || 0).toString(16).toUpperCase().padStart(16, "0");
}

// --- File sources -------------------------------------------------------
function sourceFromFile(file) {
  return {
    size: file.size,
    async *chunks() {
      for (let off = 0; off < file.size; off += CHUNK) {
        yield new Uint8Array(await file.slice(off, Math.min(file.size, off + CHUNK)).arrayBuffer());
      }
    },
    async readRange(off, len) {
      return new Uint8Array(await file.slice(off, Math.min(file.size, off + len)).arrayBuffer());
    },
    async readAll() {
      const parts = [];
      for await (const c of this.chunks()) parts.push(c);
      const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
      let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    },
  };
}
function sourceFromHandle(handle) {
  let cached = null;
  const getFile = async () => { if (!cached) cached = await handle.getFile(); return cached; };
  return {
    size: 0, // filled in by the walker (handle.getFile().size)
    async *chunks() {
      const file = await getFile();
      for (let off = 0; off < file.size; off += CHUNK) {
        yield new Uint8Array(await file.slice(off, Math.min(file.size, off + CHUNK)).arrayBuffer());
      }
    },
    async readRange(off, len) {
      const file = await getFile();
      return new Uint8Array(await file.slice(off, Math.min(file.size, off + len)).arrayBuffer());
    },
    async readAll() {
      const file = await getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
  };
}

// --- Folder walking -----------------------------------------------------
async function walkPicker(handle) {
  const node = { name: handle.name, children: [] };
  const entries = [];
  for await (const h of handle.values()) entries.push(h);
  entries.sort((a, b) => cmpStr(a.name, b.name));
  for (const h of entries) {
    if (h.kind === "directory") {
      node.children.push(await walkPicker(h));
    } else if (h.name !== ".listing") {
      const src = sourceFromHandle(h);
      src.size = (await h.getFile()).size;
      node.children.push({ name: h.name, file: src });
    }
  }
  return node;
}
function treeFromWebkit(files, folderName) {
  const root = { name: folderName, children: [] };
  const dirMap = new Map([[folderName, root]]);
  const sorted = [...files].sort((a, b) => cmpStr(a.webkitRelativePath, b.webkitRelativePath));
  for (const file of sorted) {
    const parts = file.webkitRelativePath.split("/");
    if (parts[0] !== folderName) continue;
    let parent = root, parentPath = folderName;
    for (let i = 1; i < parts.length - 1; i++) {
      const p = `${parentPath}/${parts[i]}`;
      let dir = dirMap.get(p);
      if (!dir) { dir = { name: parts[i], children: [] }; dirMap.set(p, dir); parent.children.push(dir); }
      parent = dir; parentPath = p;
    }
    const leaf = parts[parts.length - 1];
    if (leaf !== ".listing") parent.children.push({ name: leaf, file: sourceFromFile(file) });
  }
  const sortRec = (n) => { n.children.sort((a, b) => cmpStr(a.name, b.name)); n.children.forEach((c) => { if (c.children) sortRec(c); }); };
  sortRec(root);
  return root;
}

// --- Package discovery (mirrors the reference packer's discover()) ------
function findChildDir(node, lowerName) {
  return node.children.find((c) => c.children && c.name.toLowerCase() === lowerName) || null;
}
function findChildFile(node, lowerName) {
  return node.children.find((c) => !c.children && c.name.toLowerCase() === lowerName) || null;
}
function isContentDir(node) { return !!(findChildDir(node, "exefs") || findChildDir(node, "romfs")); }
function parseNpdmProgramId(bytes) {
  if (!bytes) return null;
  for (let i = 0; i + 0x18 <= bytes.length; i++) {
    if (bytes[i] === 0x41 && bytes[i + 1] === 0x43 && bytes[i + 2] === 0x49 && bytes[i + 3] === 0x30) {
      const v = new DataView(bytes.buffer, bytes.byteOffset + i + 0x10, 8);
      return v.getBigUint64(0, true);
    }
  }
  return null;
}
async function packageMeta(pkgRoot) {
  // pkgRoot is a DirNode whose children are the package tree.
  const exefs = findChildDir(pkgRoot, "exefs");
  let npdm = null, buildId = null;
  const npdmFile = (exefs && findChildFile(exefs, "main.npdm")) || findChildFile(pkgRoot, "main.npdm");
  if (npdmFile && npdmFile.file.size < 16 * 1024 * 1024) npdm = await npdmFile.file.readAll();
  const mainFile = (exefs && findChildFile(exefs, "main")) || findChildFile(pkgRoot, "main");
  if (mainFile && mainFile.file.size >= 0x60) {
    const head = await mainFile.file.readRange(0, 0x60);
    const isNso = head[0] === 0x4e && head[1] === 0x53 && head[2] === 0x4f && head[3] === 0x30;
    const isNro = head[0x10] === 0x4e && head[0x11] === 0x52 && head[0x12] === 0x4f && head[0x13] === 0x30;
    if (isNso || isNro) buildId = head.slice(0x40, 0x60);
  }
  return { npdm, buildId };
}
function pkgRootFrom(dirNode) { return { name: "", children: dirNode.children }; }

async function discover(folderNode) {
  const packages = [];
  const baseDir = findChildDir(folderNode, "base");
  const updatesDir = findChildDir(folderNode, "updates");
  const dlcDir = findChildDir(folderNode, "dlc");
  let baseTitleId = 0n;
  const addPkg = async (kind, dirNode, version, titleId, sourceName) => {
    const root = pkgRootFrom(dirNode);
    const meta = await packageMeta(root);
    const pkg = {
      kind, version, flags: 0, root,
      titleId: titleId != null ? titleId : (meta.npdm ? (parseNpdmProgramId(meta.npdm) ?? 0n) : 0n),
      npdm: meta.npdm, buildId: meta.buildId, sourceName,
    };
    packages.push(pkg);
    return pkg;
  };
  if (baseDir) {
    const base = await addPkg(0, baseDir, 0, null, folderNode.name);
    baseTitleId = BigInt(base.titleId || 0);
    if (updatesDir) {
      const updDirs = updatesDir.children.filter((c) => c.children && /^\d+$/.test(c.name))
        .sort((a, b) => Number(a.name) - Number(b.name));
      for (const d of updDirs) {
        if (!isContentDir(d)) continue;
        const pkg = await addPkg(1, d, Number(d.name), null, folderNode.name);
        if (!pkg.titleId) pkg.titleId = baseTitleId;
      }
    }
    if (dlcDir) {
      const titles = dlcDir.children.filter((c) => c.children && /^[0-9a-fA-F]{16}$/.test(c.name))
        .sort((a, b) => cmpStr(a.name, b.name));
      for (const t of titles) {
        const idxDirs = t.children.filter((c) => c.children && isContentDir(c))
          .sort((a, b) => cmpStr(a.name, b.name));
        for (const d of idxDirs) await addPkg(2, d, 0, BigInt(`0x${t.name}`), folderNode.name);
      }
    }
  } else if (updatesDir) {
    const updDirs = updatesDir.children.filter((c) => c.children && /^\d+$/.test(c.name))
      .sort((a, b) => Number(a.name) - Number(b.name));
    for (const d of updDirs) {
      if (!isContentDir(d)) continue;
      await addPkg(1, d, Number(d.name), null, folderNode.name);
    }
    if (dlcDir) {
      const titles = dlcDir.children.filter((c) => c.children && /^[0-9a-fA-F]{16}$/.test(c.name))
        .sort((a, b) => cmpStr(a.name, b.name));
      for (const t of titles) {
        const idxDirs = t.children.filter((c) => c.children && isContentDir(c))
          .sort((a, b) => cmpStr(a.name, b.name));
        for (const d of idxDirs) await addPkg(2, d, 0, BigInt(`0x${t.name}`), folderNode.name);
      }
    }
    if (!packages.length) return { packages, error: "Folder has updates/ but no usable update packages (each needs exefs/ or romfs/)." };
  } else if (isContentDir(folderNode)) {
    await addPkg(0, folderNode, 0, null, folderNode.name);
  } else {
    return { packages, error: "Not a dump: expected base/ + updates/ + dlc/, an updates/ folder, or a content folder with exefs/ or romfs/." };
  }
  if (!packages.length) return { packages, error: "No packages found in this folder." };
  return { packages, error: null };
}

// --- State --------------------------------------------------------------
let folderSeq = 0;
const folders = []; // {id, name, node, packages, error}
let iconBytes = null, iconError = null;
let wasmPromise = null;
let cancelFlag = false;
let lastOpfsName = null;

function allPackages() { return folders.flatMap((f) => f.packages); }
function countTree(node) {
  let files = 0, bytes = 0;
  const walk = (n) => { for (const c of n.children) { if (c.children) walk(c); else { files++; bytes += c.file.size; } } };
  walk(node);
  return { files, bytes };
}
function validate() {
  const errors = [];
  const pkgs = allPackages();
  if (!folders.length) errors.push("Add at least one input folder, zip, or 7z file.");
  if (folders.some((f) => f.error)) errors.push("One or more inputs failed to scan — remove or replace them.");
  if (!pkgs.length) errors.push("No packages found.");
  if (pkgs.filter((p) => p.kind === 0).length > 1) errors.push("More than one base package — change the extra ones to Update or Addon, or remove a folder.");
  const name = $("gameName").value.trim();
  if (!name) errors.push("Enter a game name.");
  const ver = $("gameVersion").value.trim();
  if (!ver || (!/^\d+\.\d+\.\d+$/.test(ver) && !/^\d+$/.test(ver))) errors.push("Version must look like 1.0.0 or a plain number.");
  if (iconError) errors.push(`Icon: ${iconError}`);
  return { ok: errors.length === 0, errors, pkgs };
}
function refresh() {
  renderFolders();
  const { ok, errors } = validate();
  const pkgs = allPackages();
  let files = 0, bytes = 0;
  for (const p of pkgs) { const c = countTree(p.root); files += c.files; bytes += c.bytes; }
  $("folderSummary").textContent = pkgs.length
    ? `${pkgs.length} package(s) · ${files} file(s) · ${fmtBytes(bytes)} total`
    : "No packages yet.";
  $("convertBtn").disabled = !ok;
  $("outputNamePreview").textContent = `${sanitizeName($("gameName").value)}${$("gameName").value.trim() ? "" : ""}.nup`.replace(/\.nup\.nup$/, ".nup");
  if (!ok && folders.length) {
    // Keep the reason visible without shouting on first load.
    $("convertError").hidden = false;
    $("convertError").textContent = errors.join("\n");
  } else {
    $("convertError").hidden = true;
    $("convertError").textContent = "";
  }
}

// --- Rendering ----------------------------------------------------------
function kindLabel(k) { return ["base", "update", "addon"][k] ?? `kind ${k}`; }
function renderFolders() {
  const list = $("folderList");
  list.innerHTML = "";
  for (const f of folders) {
    const card = document.createElement("div");
    card.className = "folder-card";
    const h = document.createElement("h3");
    h.textContent = f.kind === "folder" ? `📁 ${f.name}` : `🗜️ ${f.name}`;
    card.appendChild(h);
    if (f.error) {
      const e = document.createElement("p");
      e.className = "error"; e.textContent = f.error;
      card.appendChild(e);
    }
    for (const pkg of f.packages) {
      const row = document.createElement("div");
      row.className = "row";
      const badge = document.createElement("span");
      badge.className = "badge-kind"; badge.textContent = kindLabel(pkg.kind);
      row.appendChild(badge);
      const kindSel = document.createElement("select");
      kindSel.setAttribute("aria-label", "Package kind");
      for (const [v, label] of [[0, "base"], [1, "update"], [2, "addon"]]) {
        const o = document.createElement("option"); o.value = v; o.textContent = label; if (pkg.kind === v) o.selected = true; kindSel.appendChild(o);
      }
      kindSel.addEventListener("change", () => { pkg.kind = Number(kindSel.value); refresh(); });
      row.appendChild(kindSel);
      const tid = document.createElement("input");
      tid.type = "text"; tid.value = hex16(pkg.titleId); tid.setAttribute("aria-label", "Title ID (hex)");
      tid.title = "Title ID, 16 hex digits (auto-detected from main.npdm)";
      tid.addEventListener("change", () => {
        const v = tid.value.trim().replace(/^0x/i, "");
        if (/^[0-9a-fA-F]{16}$/.test(v)) pkg.titleId = BigInt(`0x${v}`);
        else tid.value = hex16(pkg.titleId);
        refresh();
      });
      row.appendChild(tid);
      if (pkg.kind === 1) {
        const ver = document.createElement("input");
        ver.type = "number"; ver.value = String(pkg.version); ver.setAttribute("aria-label", "Update version (decimal)");
        ver.title = "Update version, decimal (from the updates/<version>/ folder name)";
        ver.addEventListener("change", () => { pkg.version = Number(ver.value) || 0; refresh(); });
        row.appendChild(ver);
      } else if (pkg.kind === 0) {
        const span = document.createElement("span");
        span.className = "hint"; span.textContent = "version: game version above";
        row.appendChild(span);
      }
      const c = countTree(pkg.root);
      const meta = document.createElement("span");
      meta.className = "hint"; meta.textContent = `${c.files} file(s) · ${fmtBytes(c.bytes)}`;
      row.appendChild(meta);
      card.appendChild(row);
    }
    const rm = document.createElement("button");
    rm.className = "remove"; rm.textContent = f.kind === "folder" ? "Remove folder" : "Remove archive";
    rm.addEventListener("click", () => { folders.splice(folders.indexOf(f), 1); refresh(); });
    card.appendChild(rm);
    list.appendChild(card);
  }
}

async function addFolderNode(node) {
  const { packages, error } = await discover(node);
  folders.push({ id: ++folderSeq, name: node.name, node, packages, error, kind: "folder" });
  if (!$("gameName").value.trim()) $("gameName").value = node.name;
  refresh();
}

async function addZipFile(file) {
  try {
    const z = await openZip(file);
    const { packages, error } = await discover(z.root);
    folders.push({ id: ++folderSeq, name: z.name, node: z.root, packages, error, kind: "zip" });
    if (!$("gameName").value.trim()) $("gameName").value = z.name.replace(/\.zip$/i, "");
  } catch (e) {
    // openZip failed (not a zip, encrypted, unsupported method,
    // corrupt): keep it as a failed card so the reason stays visible,
    // the same way a failed folder scan does.
    folders.push({ id: ++folderSeq, name: file.name, node: { name: file.name, children: [] }, packages: [], error: e.message, kind: "zip" });
  }
  refresh();
}

async function addSevenzFile(file) {
  try {
    const lzma = await getLzma();
    const z = await openSevenz(file, lzma);
    // discover() reads main.npdm/main through the 7z file sources, so
    // an unsupported coder (BCJ2, PPMd, AES…) surfaces here as a
    // failed card instead of failing the whole page.
    const { packages, error } = await discover(z.root);
    folders.push({ id: ++folderSeq, name: z.name, node: z.root, packages, error, kind: "7z" });
    if (!$("gameName").value.trim()) $("gameName").value = z.name.replace(/\.7z$/i, "");
  } catch (e) {
    folders.push({ id: ++folderSeq, name: file.name, node: { name: file.name, children: [] }, packages: [], error: e.message, kind: "7z" });
  }
  refresh();
}

async function addArchiveFile(file) {
  if (/\.7z$/i.test(file.name)) await addSevenzFile(file);
  else await addZipFile(file);
}

// --- Output adapters ----------------------------------------------------
class StreamWriter {
  constructor(writable) { this.w = writable; }
  async writeAt(pos, data) { await this.w.write({ type: "write", position: pos, data }); }
  async truncate(size) { await this.w.truncate(size); }
  async close() { await this.w.close(); }
}
async function opfsWriter(name) {
  const dir = await navigator.storage.getDirectory();
  const handle = await dir.getFileHandle(name, { create: true });
  return { writer: new StreamWriter(await handle.createWritable()), handle, kind: "opfs" };
}
async function savePickerWriter(name) {
  const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "NUP file", accept: { "application/octet-stream": [".nup"] } }] });
  return { writer: new StreamWriter(await handle.createWritable()), handle, kind: "savepicker" };
}

// --- WASM ---------------------------------------------------------------
function getWasm() {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const res = await fetch("nup.wasm");
      if (!res.ok) throw new Error(`could not load nup.wasm (${res.status})`);
      const wasm = await loadWasm(new Uint8Array(await res.arrayBuffer()));
      $("wasmStatus").textContent = "WASM: ready";
      return wasm;
    })().catch((e) => {
      $("wasmStatus").textContent = `WASM: failed — ${e.message}`;
      throw e;
    });
  }
  return wasmPromise;
}

// --- Convert ------------------------------------------------------------
$("convertBtn").addEventListener("click", async () => {
  const v = validate();
  if (!v.ok) return;
  cancelFlag = false;
  $("cancelBtn").disabled = false;
  $("convertBtn").disabled = true;
  $("result").hidden = true;
  $("progressWrap").hidden = false;
  const startTime = performance.now();
  let maxPct = 0;
  try {
    // --- Pre-flight storage check ---
    // Worst-case output = total input (raw, no compression gain) + a
    // small allowance for TOC/meta. Output mode "auto" (the default)
    // writes directly to a file the user picks when the input is over
    // 2 GiB, skipping the OPFS copy at the end; it also switches to
    // direct save when OPFS quota cannot hold the worst case. A direct
    // save is not bound by the origin quota, only by free space on the
    // destination disk. An explicit "OPFS" choice is honoured even when
    // quota looks short, with a warning, because that is what the user
    // asked for.
    const DIRECT_SAVE_THRESHOLD = 2 * 1024 * 1024 * 1024;
    let totalInput = 0;
    for (const p of v.pkgs) totalInput += countTree(p.root).bytes;
    const outputMode = $("outputMode").value || "auto";
    let storageMode = "opfs";
    try {
      const est = (navigator.storage && navigator.storage.estimate)
        ? await navigator.storage.estimate() : null;
      let persisted = false;
      try {
        if (navigator.storage && navigator.storage.persist) persisted = await navigator.storage.persist();
      } catch { /* persist is best-effort; not granting it is not fatal */ }
      const available = (est && est.quota) ? Math.max(0, est.quota - (est.usage || 0)) : null;
      const quotaShort = available !== null && available < totalInput + 1024 * 1024;
      const persistNote = `Persistent storage: ${persisted ? "granted" : "not granted — keep the tab open; storage could be evicted under disk pressure"}.`;
      if (outputMode === "direct") {
        storageMode = "savepicker";
        $("preflightStatus").textContent = `Direct save chosen: ${fmtBytes(totalInput)} of input will be written straight to the file you pick, skipping the OPFS copy.`;
      } else if (quotaShort && outputMode === "opfs") {
        storageMode = "opfs";
        $("preflightStatus").textContent = `Warning: OPFS chosen explicitly, but only ${fmtBytes(available)} is available in browser storage for ${fmtBytes(totalInput)} of input — this run may fail on quota. ${persistNote}`;
      } else if (quotaShort) {
        storageMode = "savepicker";
        $("preflightStatus").textContent = `Storage check: ${fmtBytes(available)} available in browser storage, but the input is ${fmtBytes(totalInput)} — writing directly to a file you pick instead of OPFS, so this run is not limited by the browser quota. (This also avoids the extra OPFS copy.)`;
      } else if (outputMode === "auto" && totalInput > DIRECT_SAVE_THRESHOLD) {
        storageMode = "savepicker";
        $("preflightStatus").textContent = `Large input (${fmtBytes(totalInput)}): writing directly to a file you pick to skip the OPFS copy at the end. ${persistNote}`;
      } else if (available !== null) {
        $("preflightStatus").textContent = `Storage check: ${fmtBytes(available)} available in browser storage for ${fmtBytes(totalInput)} of input (worst-case output). ${persistNote}`;
      } else {
        $("preflightStatus").textContent = `Storage check: browser quota unknown, proceeding with OPFS output for ${fmtBytes(totalInput)} of input.`;
      }
    } catch {
      $("preflightStatus").textContent = `Storage check unavailable — proceeding with OPFS output for ${fmtBytes(totalInput)} of input.`;
    }
    const wasm = await getWasm();
    const outName = `${sanitizeName($("gameName").value)}.nup`;
    let out;
    if (storageMode === "savepicker") {
      try { out = await savePickerWriter(outName); }
      catch (e) {
        if (e.name === "AbortError") throw e;
        // Save dialog unavailable (browser without File System Access):
        // fall back to OPFS rather than failing the whole conversion.
        out = await opfsWriter(outName);
        $("preflightStatus").textContent += " (Save dialog unavailable, fell back to OPFS.)";
      }
    } else {
      try { out = await opfsWriter(outName); }
      catch (e) {
        // OPFS unavailable (older Safari, private mode, …): write straight
        // to a user-picked file instead — still storage, never RAM.
        out = await savePickerWriter(outName);
      }
    }
    lastOpfsName = out.kind === "opfs" ? outName : null;
    const pkgs = v.pkgs.map((p) => ({
      ...p,
      titleId: BigInt(p.titleId || 0),
      version: p.kind === 0 ? encodeVersion($("gameVersion").value.trim()) : p.version,
    }));
    const level = Number($("compressLevel").value || 1);
    let lastDomUpdate = 0;
    const result = await packNup(wasm, pkgs, out.writer, {
      level,
      appMeta: {
        titleName: $("gameName").value.trim(),
        displayVersion: $("gameVersion").value.trim(),
        publisher: $("publisher").value.trim() || null,
        icon: iconBytes,
      },
      shouldCancel: () => cancelFlag,
      onProgress: (pr) => {
        const pct = pr.bytesTotal ? Math.min(100, (pr.bytesDone / pr.bytesTotal) * 100) : 0;
        maxPct = Math.max(maxPct, pct);
        // DOM writes are the expensive part at 1 MiB chunks on a 30 GB
        // run (~30,000 calls): throttle them to ~10/s, always showing
        // the final 100%. The packer still reports every chunk; only
        // the rendering is throttled.
        const now = performance.now();
        if (now - lastDomUpdate < 100 && maxPct < 100) return;
        lastDomUpdate = now;
        $("progressFill").style.width = `${maxPct}%`;
        $("progressPct").textContent = `${maxPct.toFixed(1)}%`;
        $("progressFiles").textContent = `${pr.filesDone}/${pr.filesTotal} files`;
        $("progressBytes").textContent = `${fmtBytes(pr.bytesDone)} / ${fmtBytes(pr.bytesTotal)}`;
        $("progressTime").textContent = fmtTime(now - startTime);
        $("progressPhase").textContent = pr.phase || "";
        $("progressPath").textContent = pr.currentPath || "";
      },
    });
    $("progressFill").style.width = "100%";
    $("progressPct").textContent = "100%";
    const res = $("result");
    res.hidden = false;
    res.innerHTML = "";
    const h = document.createElement("h3"); h.textContent = "✅ Conversion complete"; res.appendChild(h);
    const lines = [
      `Output: ${outName} (${fmtBytes(result.fileSize)}) — ${result.packageCount} package(s), ${result.dirCount} dirs, ${result.fileCount} files.`,
      `Compression: zstd level ${level} for files up to 256 MiB (larger files are stored raw; files that don't shrink are stored raw).`,
      `UUID: ${result.uuid}`,
      out.kind === "opfs"
        ? "Stored in browser storage (OPFS). Use Save as… to copy it to your computer — the copy streams in chunks, it is not loaded into RAM."
        : "Written directly to the file you picked.",
    ];
    for (const line of lines) { const p = document.createElement("p"); p.textContent = line; res.appendChild(p); }
    const actions = document.createElement("div"); actions.className = "actions";
    if (out.kind === "opfs") {
      const saveBtn = document.createElement("button"); saveBtn.className = "primary"; saveBtn.textContent = "Save as…";
      saveBtn.addEventListener("click", () => saveOpfsCopy(outName));
      actions.appendChild(saveBtn);
      const checkBtn = document.createElement("button"); checkBtn.textContent = "Check structure";
      checkBtn.addEventListener("click", () => checkStructure(outName));
      actions.appendChild(checkBtn);
      const delBtn = document.createElement("button"); delBtn.textContent = "Delete OPFS copy";
      delBtn.addEventListener("click", async () => {
        const dir = await navigator.storage.getDirectory();
        await dir.removeEntry(outName);
        const p = document.createElement("p"); p.textContent = "OPFS copy deleted."; res.appendChild(p);
      });
      actions.appendChild(delBtn);
    }
    res.appendChild(actions);
    const note = document.createElement("p"); note.className = "hint";
    note.textContent = "Verify a finished file with the reference tool: nup verify game.nup (see test/README in the repo).";
    res.appendChild(note);
  } catch (e) {
    if (e.message === "cancelled") {
      $("convertError").hidden = false;
      $("convertError").textContent = "Conversion cancelled. A partial output file may remain in browser storage; convert again to overwrite it, or delete it from the result section.";
    } else if (e.name === "AbortError") {
      // Only reachable from the save picker before conversion starts.
      $("progressWrap").hidden = true;
      $("convertError").hidden = false;
      $("convertError").textContent = "Conversion not started: the save dialog was closed without picking a file.";
    } else if (e.name === "QuotaExceededError" || /quota/i.test(e.message || "")) {
      $("convertError").hidden = false;
      $("convertError").textContent = "Conversion ran out of browser storage mid-run (quota exceeded). A partial output file may remain in browser storage — delete it, free up disk space, and try again. If browser quota is the limit, the pre-flight check should have switched this run to direct-to-file output; if it did not, the quota changed during the run (for example, another tab using storage).";
    } else {
      $("convertError").hidden = false;
      $("convertError").textContent = `Conversion failed: ${e.message}`;
    }
  } finally {
    $("convertBtn").disabled = false;
    $("cancelBtn").disabled = true;
  }
});
$("cancelBtn").addEventListener("click", () => { cancelFlag = true; });

// --- Save-as copy + structure check -------------------------------------
async function saveOpfsCopy(name) {
  try {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    const saveHandle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "NUP file", accept: { "application/octet-stream": [".nup"] } }] });
    const w = await saveHandle.createWritable();
    for (let off = 0; off < file.size; off += 1024 * 1024) {
      const chunk = await file.slice(off, Math.min(file.size, off + 1024 * 1024)).arrayBuffer();
      await w.write(chunk);
    }
    await w.close();
    alert("Saved.");
  } catch (e) {
    if (e.name !== "AbortError") alert(`Save failed: ${e.message}`);
  }
}
async function checkStructure(name) {
  const res = $("result");
  const p = document.createElement("p"); p.textContent = "Checking structure…"; res.appendChild(p);
  try {
    const wasm = await getWasm();
    const dir = await navigator.storage.getDirectory();
    const file = await (await dir.getFileHandle(name)).getFile();
    const head = new Uint8Array(await file.slice(0, 0x80).arrayBuffer());
    const v = new DataView(head.buffer);
    const problems = [];
    if (!(head[0] === 0x4e && head[1] === 0x55 && head[2] === 0x50 && head[3] === 0x01)) problems.push("bad magic");
    const tocSize = Number(v.getBigUint64(0x10, true));
    const blobOffset = Number(v.getBigUint64(0x38, true));
    const fileSize = Number(v.getBigUint64(0x40, true));
    const pkgCount = v.getUint32(0x48, true);
    if (fileSize !== file.size) problems.push(`header file_size ${fileSize} != actual ${file.size}`);
    const toc = new Uint8Array(await file.slice(0x80, 0x80 + tocSize).arrayBuffer());
    const tocSha = await wasm.hashBytes(toc);
    const headerSha = head.slice(0x18, 0x38);
    if (tocSha.some((b, i) => b !== headerSha[i])) problems.push("TOC SHA-256 mismatch");
    p.textContent = problems.length
      ? `Structure check FAILED: ${problems.join("; ")}`
      : `Structure check OK: magic NUP\\x01, ${pkgCount} package(s), TOC ${fmtBytes(tocSize)} @ 0x80, blobs @ 0x${blobOffset.toString(16)}, file ${fmtBytes(fileSize)}. (This checks structure and the TOC hash, not per-file content hashes.)`;
  } catch (e) {
    p.textContent = `Structure check failed: ${e.message}`;
  }
}

// --- Inputs -------------------------------------------------------------
$("addFolderBtn").addEventListener("click", async () => {
  try {
    if ("showDirectoryPicker" in window) {
      const handle = await window.showDirectoryPicker();
      await addFolderNode(await walkPicker(handle));
    } else {
      $("webkitInput").click();
    }
  } catch (e) {
    if (e.name !== "AbortError") { $("convertError").hidden = false; $("convertError").textContent = `Could not add folder: ${e.message}`; }
  }
});
$("addFilesBtn").addEventListener("click", () => $("webkitInput").click());
$("addZipBtn").addEventListener("click", () => $("zipInput").click());
$("zipInput").addEventListener("change", async () => {
  const files = [...$("zipInput").files];
  $("zipInput").value = "";
  for (const f of files) await addArchiveFile(f);
});
$("webkitInput").addEventListener("change", async () => {
  const files = [...$("webkitInput").files];
  $("webkitInput").value = "";
  const groups = new Map();
  for (const f of files) {
    const top = f.webkitRelativePath.split("/")[0];
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(f);
  }
  for (const [name, group] of groups) await addFolderNode(treeFromWebkit(group, name));
});
const dz = $("dropZone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", async (e) => {
  e.preventDefault(); dz.classList.remove("over");
  for (const item of e.dataTransfer.items) {
    const handle = typeof item.getAsFileSystemHandle === "function" ? await item.getAsFileSystemHandle() : null;
    if (handle && handle.kind === "directory") await addFolderNode(await walkPicker(handle));
    else if (handle && handle.kind === "file") {
      const f = await handle.getFile();
      if (/\.(zip|7z)$/i.test(f.name)) await addArchiveFile(f);
    } else {
      const f = typeof item.getAsFile === "function" ? item.getAsFile() : null;
      if (f && /\.(zip|7z)$/i.test(f.name)) await addArchiveFile(f);
    }
  }
});
$("gameName").addEventListener("input", refresh);
$("gameVersion").addEventListener("input", refresh);
$("publisher").addEventListener("input", refresh);
$("iconInput").addEventListener("change", async () => {
  const file = $("iconInput").files[0];
  iconBytes = null; iconError = null;
  $("iconPreview").hidden = true;
  if (!file) { $("iconStatus").textContent = "No icon chosen. The icon is stored as TLV 0x0003."; refresh(); return; }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!(bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
      throw new Error("not a JPEG (must start with FF D8 FF)");
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    const dims = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
      img.onerror = () => reject(new Error("could not decode the JPEG"));
      img.src = url;
    });
    if (dims[0] !== 256 || dims[1] !== 256) {
      URL.revokeObjectURL(url);
      throw new Error(`must be exactly 256×256, got ${dims[0]}×${dims[1]}`);
    }
    iconBytes = bytes;
    $("iconImg").src = url;
    $("iconPreview").hidden = false;
    $("iconStatus").textContent = `OK: 256×256 JPEG, ${fmtBytes(bytes.length)}.`;
    $("iconStatus").style.color = "";
  } catch (e) {
    iconError = e.message;
    $("iconStatus").textContent = `Invalid icon: ${e.message}. Pick a 256×256 JPEG, or remove the icon.`;
    $("iconStatus").style.color = "var(--danger)";
  }
  refresh();
});

// --- Init ---------------------------------------------------------------
$("pickerNote").textContent = ("showDirectoryPicker" in window)
  ? "Folder picker supported in this browser."
  : "No folder picker in this browser — use the file-picker fallback.";
getWasm().catch(() => {});
refresh();
