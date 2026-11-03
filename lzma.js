// lzma.js — JS wrapper for lzma.wasm (LZMA1/LZMA2 streaming decoder).
// DOM-free, like packer.js's loadWasm. One decoder instance decodes one
// folder stream; create a fresh one per folder decode (the packer's
// second pass re-decodes from scratch, so a fresh instance is correct).
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
    createDecoder(isLzma2, props) {
      mem().set(props, inPtr);
      const r = e.lzma_begin(isLzma2 ? 1 : 0, props.length);
      if (r !== 0) throw new Error(`lzma: decoder init failed (code ${r})`);
      let ended = false;
      // Feed one chunk; returns all output produced from it (draining
      // internally until the chunk is fully consumed).
      function feed(chunk) {
        if (ended) throw new Error("lzma: feed after end");
        const out = [];
        for (let off = 0; off < chunk.length; off += inSize) {
          const part = chunk.subarray(off, Math.min(chunk.length, off + inSize));
          mem().set(part, inPtr);
          let n = e.lzma_feed(part.length);
          if (n < 0) throw new Error("lzma: data error while decoding");
          if (n) out.push(mem().slice(outPtr, outPtr + n));
          let guard = 0;
          while (e.lzma_in_consumed() < part.length) {
            if (++guard > 100000) throw new Error("lzma: decoder stalled");
            n = e.lzma_drain();
            if (n < 0) throw new Error("lzma: data error while decoding");
            if (n) out.push(mem().slice(outPtr, outPtr + n));
            else break;
          }
          if (e.lzma_in_consumed() < part.length) {
            throw new Error("lzma: decoder stopped before consuming its input");
          }
        }
        return out;
      }
      function finish() {
        ended = true;
        e.lzma_end();
        return [];
      }
      return { feed, finish, status: () => e.lzma_status() };
    },
  };
}
