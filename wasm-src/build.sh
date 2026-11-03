#!/bin/sh
# Build nup.wasm from nup_wasm.c + upstream zstd 1.5.7 compression sources.
# Requires clang with a wasm32 target (Ubuntu: apt install clang).
# Output: ../nup.wasm  (checked into the repo; the site loads it locally,
# no CDN, so the converter works fully offline once the page is loaded.)
set -eu
cd "$(dirname "$0")"
Z=zstd-1.5.7/lib
[ -d "$Z" ] || { echo "missing $Z — download zstd-1.5.7.tar.gz first"; exit 1; }
clang --target=wasm32 -O3 -nostdlib -fno-builtin \
  -DNDEBUG \
  -UZSTD_MULTITHREAD \
  -Ishim -I"$Z" -I"$Z/common" -I"$Z/compress" \
  -Wl,--no-entry -Wl,--export-memory \
  -Wl,--export=nup_in_ptr -Wl,--export=nup_out_ptr \
  -Wl,--export=nup_in_size -Wl,--export=nup_out_size \
  -Wl,--export=sha_init -Wl,--export=sha_update -Wl,--export=sha_final \
  -Wl,--export=zstd_begin -Wl,--export=zstd_feed \
  -Wl,--initial-memory=67108864 -Wl,--max-memory=268435456 \
  nup_wasm.c \
  "$Z/common/debug.c" "$Z/common/entropy_common.c" "$Z/common/error_private.c" \
  "$Z/common/fse_decompress.c" "$Z/common/zstd_common.c" "$Z/common/xxhash.c" \
  "$Z/compress/fse_compress.c" "$Z/compress/hist.c" "$Z/compress/huf_compress.c" \
  "$Z/compress/zstd_compress.c" "$Z/compress/zstd_compress_literals.c" \
  "$Z/compress/zstd_compress_sequences.c" "$Z/compress/zstd_compress_superblock.c" \
  "$Z/compress/zstd_double_fast.c" "$Z/compress/zstd_fast.c" \
  "$Z/compress/zstd_lazy.c" "$Z/compress/zstd_ldm.c" "$Z/compress/zstd_opt.c" \
  "$Z/compress/zstd_preSplit.c" \
  -o ../nup.wasm
ls -lh ../nup.wasm
