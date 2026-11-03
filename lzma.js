// lzma.js — JS wrapper for lzma.wasm (LZMA1/LZMA2 streaming decoder).
// DOM-free, like packer.js's loadWasm. One decoder instance decodes one
// folder stream. sevenz.js serializes folder decodes and caches the output.
export async function loadLzma(wasmBytes) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const e = instance.exports;
  const mem = () => new Uint8Array(e.memory.buffer);
  const inPtr = e.lzma_in_ptr(), outPtr = e.lzma_out_ptr();
  const inSize = e.lzma_in_size(), outSize = e.lzma_out_size();
  const bcjPtr = e.bcj_in_ptr(), bcjSize = e.bcj_in_size();
  return {
    // x86 BCJ decoder (7-Zip's Bra86, compiled in). The SDK converts
    // in place and leaves a short tail unconverted; the wrapper keeps
    // that tail and prepends it to the next chunk, passing the stream
    // position of the buffer start as pc.
    createBcj() {
      e.bcj_reset();
      let pending = new Uint8Array(0);
      let streamPos = 0;
      return {
        feed(chunk) {
          const combined = new Uint8Array(pending.length + chunk.length);
          combined.set(pending, 0);
          combined.set(chunk, pending.length);
          if (combined.length > bcjSize) throw new Error("lzma: BCJ chunk too large for buffer");
          mem().set(combined, bcjPtr);
          const converted = e.bcj_convert(combined.length, streamPos);
          if (converted < 0) throw new Error("lzma: BCJ conversion failed");
          const out = mem().slice(bcjPtr, bcjPtr + converted);
          pending = combined.subarray(converted);
          streamPos += converted;
          return out.length ? [out] : [];
        },
        finish() {
          const tail = pending;
          pending = new Uint8Array(0);
          return tail.length ? [tail] : [];
        },
      };
    },
    // isLzma2: boolean; props: 5 bytes (LZMA1) or 1 byte (LZMA2), as
    // stored in the 7z folder's coder attributes.
    createDecoder(isLzma2, props, unpackSize = Infinity) {
      // The checked-in WASM has a 192 MiB arena, shared by dictionary
      // and probability tables. Reject oversized dictionaries explicitly.
      const dictSize = isLzma2
        ? (props[0] > 40 ? NaN : props[0] === 40 ? 0xffffffff : (2 + (props[0] & 1)) * 2 ** ((props[0] >> 1) + 11))
        : new DataView(props.buffer, props.byteOffset, props.byteLength).getUint32(1, true);
      if (!Number.isFinite(dictSize)) throw new Error("lzma: invalid dictionary properties");
      if (dictSize > 128 * 1024 * 1024) {
        throw new Error(`lzma: archive requires a ${Math.ceil(dictSize / 1048576)} MiB dictionary; this browser decoder supports up to 128 MiB. Repack with a dictionary of 128 MiB or less, or extract the archive and add the folder.`);
      }
      let remaining = unpackSize;
      mem().set(props, inPtr);
      const r = e.lzma_begin(isLzma2 ? 1 : 0, props.length);
      if (r !== 0) throw new Error(r === 2
        ? "lzma: not enough decoder memory for this archive; use a smaller dictionary or extract it first"
        : `lzma: decoder init failed (code ${r})`);
      if (Number.isFinite(unpackSize)) {
        if (!Number.isSafeInteger(unpackSize) || unpackSize < 0) throw new Error("lzma: invalid unpack size");
        e.lzma_set_output_size(BigInt(unpackSize));
      }
      let ended = false;
      // Feed one chunk; returns all output produced from it (draining
      // internally until the chunk is fully consumed).
      function feed(chunk) {
        if (ended) throw new Error("lzma: feed after end");
        const out = [];
        const append = (n) => {
          if (n > remaining) throw new Error("lzma: decoder exceeded declared unpack size");
          const take = n;
          if (take) out.push(mem().slice(outPtr, outPtr + take));
          remaining -= take;
        };
        for (let off = 0; off < chunk.length; off += inSize) {
          if (remaining === 0) break;
          const part = chunk.subarray(off, Math.min(chunk.length, off + inSize));
          mem().set(part, inPtr);
          let n = e.lzma_feed(part.length);
          if (n < 0) throw new Error("lzma: data error while decoding");
          append(n);
          let guard = 0;
          while (remaining > 0 && e.lzma_in_consumed() < part.length) {
            if (++guard > 100000) throw new Error("lzma: decoder stalled");
            n = e.lzma_drain();
            if (n < 0) throw new Error("lzma: data error while decoding");
            append(n);
            if (!n) break;
          }
          if (remaining > 0 && e.lzma_in_consumed() < part.length) {
            throw new Error("lzma: decoder stopped before consuming its input");
          }
        }
        return out;
      }
      function finish() {
        if (ended) return [];
        ended = true;
        e.lzma_end();
        return [];
      }
      return { feed, finish, status: () => e.lzma_status() };
    },
  };
}
