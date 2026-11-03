#!/bin/sh
# Build lzma.wasm from lzma_wasm.c + LZMA SDK LzmaDec/Lzma2Dec/Bra86.
# Requires clang with a wasm32 target (Ubuntu: apt install clang).
# Output: ../lzma.wasm (checked into the repo via the browser upload
# page, like nup.wasm — snapshot push cannot carry binary files).
set -eu
cd "$(dirname "$0")"
clang --target=wasm32 -O3 -nostdlib -fno-builtin \
  -DNDEBUG \
  -Ilzma-sdk -Ishim \
  -Wl,--strip-all -Wl,--no-entry -Wl,--export-memory \
  -Wl,--export=lzma_in_ptr -Wl,--export=lzma_out_ptr \
  -Wl,--export=lzma_in_size -Wl,--export=lzma_out_size \
  -Wl,--export=lzma_in_consumed -Wl,--export=lzma_status \
  -Wl,--export=lzma_set_output_size -Wl,--export=lzma_begin -Wl,--export=lzma_feed \
  -Wl,--export=lzma_drain -Wl,--export=lzma_end \
  -Wl,--export=bcj_in_ptr -Wl,--export=bcj_in_size \
  -Wl,--export=bcj_reset -Wl,--export=bcj_convert \
  -Wl,--initial-memory=268435456 -Wl,--max-memory=268435456 \
  lzma_wasm.c lzma-sdk/LzmaDec.c lzma-sdk/Lzma2Dec.c lzma-sdk/Bra86.c \
  -o ../lzma.wasm
ls -lh ../lzma.wasm

# Publishable text asset: keep lzma.js and the compiled module in sync.
python3 - <<'PYTHON'
from pathlib import Path
import base64, re
p = Path("../lzma.js")
s = p.read_text()
s = re.sub(r'const BUNDLED_WASM = "[^"]*";',
    'const BUNDLED_WASM = "' + base64.b64encode(Path("../lzma.wasm").read_bytes()).decode() + '";', s)
p.write_text(s)
PYTHON
