# webasm_nup

A static website that converts a game dump folder into a **`.nup`** file —
entirely locally, in the browser, with WebAssembly. No uploads, no server,
no keys, no decryption: `.nup` holds unencrypted dumps only.

**Live site:** https://nate-santos.github.io/webasm_nup/

To serve it locally instead:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

> Opening `index.html` directly with `file://` will not work: browsers block
> `fetch("nup.wasm")` from a `file://` page. Serve it over HTTP, even locally.

## Use it

1. **Add folder(s)** — a dump bundle (`base/` + `updates/` + `dlc/`), a bare
   content folder (`exefs/` / `romfs/`), or several folders at once.
   Chrome / Edge use `showDirectoryPicker`; other browsers get a file-picker
   fallback, and you can also drop a folder onto the drop zone.
2. **Game details** — edit the game name, the version, and add a JPEG icon
   (exactly 256×256, validated in the browser and shown as a preview).
   The name, version and icon land in the base package's metadata.
3. **Convert** — watch the progress bar (files, bytes, current file, phase),
   then **Save as…** to copy the finished `.nup` to your computer.

Each added folder shows the packages it was scanned into (kind, title ID,
version, file count). Package kind and title ID are editable per package;
update versions are editable too. The base package's version comes from the
game version field above.

### Output and storage

The result is **not** built in RAM. Input files are read in 256 KiB chunks,
and the output is written to browser storage first — the Origin Private File
System (OPFS) — via a streaming writer. After conversion, **Save as…** copies
the OPFS file to a location you pick, again in chunks. If OPFS is unavailable,
the site falls back to writing straight to a file you pick with the save
dialog (still storage, never a whole-file blob in RAM). A **Check structure**
button verifies the finished file's magic, TOC SHA-256, package count and
extent bounds in the browser.

## The .nup format (v1)

Spec and reference implementation: [a55uka/nup](https://github.com/a55uka/nup)
([SPEC.md](https://github.com/a55uka/nup/blob/main/SPEC.md)). The C++
implementation this was cross-checked against lives in
[Eglantine, `src/core/file_sys/nup_*`](https://github.com/Djihads80/Eglantine/tree/nx2/src/core/file_sys)
(`nup_container.cpp`, `nup_writer.cpp`).

Layout, all integers little-endian:

```
superblock (0x80) · TOC · blob region (16-byte-aligned extents) · meta blocks
```

- **Superblock:** magic `NUP\x01`, TOC offset/size + SHA-256, blob offset,
  file size, package count, content UUID (SHA-256 of
  `title_id ‖ version ‖ kind` per package, first 16 bytes).
- **TOC:** package records (0x40), dir records (0x18), file records (0x50),
  a flat children array (node ids, dirs first, then files), and a string pool.
  Children are sorted bytewise by UTF-8 name per directory.
- **Files:** per-file SHA-256 over the uncompressed bytes, codec 0 = raw or
  1 = zstd (one frame per file, content size pledged in the frame header).
  Zero-length files have no extent. Files with equal size + SHA-256 share
  one extent.
- **Packages:** `base` (kind 0), `update` (1), `addon` (2). A container with
  no base flags every update `standalone_update`. Title IDs come from
  `exefs/main.npdm` (the `ACI0` program ID); DLC title IDs come from the
  `dlc/<16-hex>/` folder name. Build IDs come from bytes `0x40..0x60` of
  `exefs/main` (NSO0/NRO0).
- **Meta TLVs** (type u16, reserved u16, size u32, payload, sorted, no
  padding): `0x0001` NPDM, `0x0003` icon, `0x0004` display version,
  `0x0005` title name, `0x0006` publisher, `0x0007` build ID,
  `0x0008` source dump name. Name / icon / display version / publisher go
  to the base package, or the first package when there is no base.
- **Excluded:** `.listing` dump-tool files, like the reference packer.

### Deliberate choices (and where they differ from the references)

- **Base version:** the reference Python packer leaves a base package's
  numeric version at 0 and stores only a display version. Here, the game
  version you type is *both*: the display-version TLV *and* the base
  package's numeric version, encoded per SPEC §3.1.1
  (`(major << 16) | (minor << 8) | micro`, so `1.0.0` → `0x10000`,
  `7.0.0` → `458752`). Update versions still come from their
  `updates/<decimal>/` folder names.
- **Large files are raw:** files over 256 MiB are stored raw, matching
  Eglantine's writer (its reader spills large zstd extents to a temp file,
  so large compressed extents are a poor trade). Smaller files are zstd
  level 3, falling back to raw when compression doesn't shrink them —
  exactly the reference policy, except the reference compresses whole
  files in memory and this site streams them.
- **Compression abort:** a file is hashed + compressed in one streaming
  pass. If compressed output reaches the raw size, compression is
  abandoned and the partial extent is overwritten by a raw pass (any
  compressed tail past the raw extent is zeroed), mirroring Eglantine's
  abort-early streaming writer.
- **No NACP parsing:** the site does not read `control.nacp` from dumps.
  Name, version and icon are the values you type / upload. If a dump
  carries its own NACP, its title is not auto-imported (yet).
- **No v2 features:** no chunked zstd, no delta updates, no sparse files —
  those are explicitly v2 candidates in the spec.

## How the code is laid out

| File | What it does |
|---|---|
| `index.html`, `styles.css`, `app.js` | The site: folder picking / drop, package discovery, game details + icon validation, progress, OPFS output, Save-as copy, structure check. |
| `packer.js` | The .nup writer. No DOM dependency — the Node test uses the same code as the browser. Owns the superblock / TOC / meta layout, dedup, streaming passes and progress reporting. |
| `nup.wasm` | The WebAssembly module: streaming SHA-256 and streaming zstd (level 3, content size pledged, single-threaded for deterministic frames). Built from `wasm-src/`; the site loads it from the same directory, no CDN. |
| `wasm-src/nup_wasm.c`, `wasm-src/build.sh`, `wasm-src/shim/` | WASM source + build script + minimal libc shims (the build is `nostdlib`, so it ships its own `memcpy`/`malloc`/etc.). `build.sh` downloads upstream zstd 1.5.7 sources (BSD licensed) and compiles them with clang's wasm32 target. |
| `test/test.mjs` | End-to-end test: builds a synthetic dump (base + update + DLC, compressible / incompressible / duplicate / empty / over-threshold files), packs it, and checks the output structurally. |

## Build the WASM module

```sh
# needs clang with a wasm32 target (Ubuntu: apt install clang)
sh wasm-src/build.sh   # writes nup.wasm next to index.html
```

The checked-in `nup.wasm` is the build product, so the site works without
rebuilding — rebuild only if you change `wasm-src/nup_wasm.c`.

## Test

```sh
node test/test.mjs
```

That packs a synthetic dump and checks: magic, file size, TOC SHA-256,
package/dir/file counts, sorted children, 16-byte extent alignment, extent
bounds, dedup sharing, zstd-vs-raw codec choices, raw SHA-256 matches, meta
TLVs (title, display version, icon, NPDM) and the UUID.

To verify a generated file with the reference implementation itself:

```sh
pip install ./tools/nup   # from a clone of a55uka/nup
nup verify game.nup       # deep: structure + per-file SHA-256 after decompression
nup info game.nup --tree
nup extract game.nup out_dir
```

The test output in this repo was verified this way: `nup verify` passes
deep, and `nup extract` reproduces the original base tree byte-for-byte.

## Browser support

- Folder picker (`showDirectoryPicker`): Chrome / Edge. Firefox / Safari
  use the `webkitdirectory` file-picker fallback.
- OPFS (`navigator.storage.getDirectory` + writable streams): current
  Chrome, Edge, Firefox and Safari. Without OPFS, the save-dialog fallback
  is used instead.
- WebAssembly + `BigInt` + `DataView.setBigUint64`: any current browser.

## Credits

- NUP format, spec and Python reference: [a55uka/nup](https://github.com/a55uka/nup).
- C++ NUP writer/reader cross-checked: [Eglantine (nx2 branch)](https://github.com/Djihads80/Eglantine/tree/nx2/src/core/file_sys).
- Compression: [zstd](https://github.com/facebook/zstd) by Meta, BSD licensed.
- This site's own code (HTML/CSS/JS, `packer.js`, `wasm-src/nup_wasm.c`) is
  MIT licensed — see `LICENSE` if present, otherwise treat it as MIT.
