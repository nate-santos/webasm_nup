/* lzma_wasm.c — LZMA1/LZMA2 streaming decoder for webasm_nup's 7z input.
 *
 * Built from Igor Pavlov's LZMA SDK (public domain) LzmaDec.c +
 * Lzma2Dec.c, compiled with clang --target=wasm32 -nostdlib, the same
 * way nup.wasm is built. This is a SEPARATE module from nup.wasm so a
 * 7z decode never disturbs the verified SHA/zstd module.
 *
 * JS interface (mirrors nup.wasm's feed pattern, with one difference
 * forced by decompression: one compressed chunk can expand to far more
 * than the output buffer, so the caller must drain):
 *   lzma_in_ptr() / lzma_out_ptr() / lzma_in_size() / lzma_out_size()
 *   lzma_begin(isLzma2, propsLen)
 *     Props must already be copied into the input buffer: 5 bytes for
 *     LZMA1 (props byte + dict size LE32, as stored in a 7z folder),
 *     1 byte for LZMA2. Returns 0 on success, else an SZ_* code.
 *   lzma_feed(inLen)
 *     Decodes inLen bytes from the input buffer into the output
 *     buffer (at most OUT_SIZE). Returns bytes produced, or -1 on a
 *     data error. After the call, lzma_in_consumed() says how much of
 *     the input was consumed; while it is < inLen, call lzma_drain()
 *     (same return convention, no new input) until it catches up.
 *   lzma_status()
 *     Last ELzmaStatus from the decoder (3 = finished with end marker
 *     for LZMA1/LZMA2 streams that have one; LZMA1 streams in 7z often
 *     have no end marker, so the caller must also stop at the known
 *     unpack size).
 *   lzma_end() — reset for the next folder stream.
 *
 * Allocation: the SDK's ISzAlloc is a bump allocator over a static
 * arena. A decoder's allocations (probability tables + dictionary) are
 * freed in bulk by lzma_end()/lzma_begin(), which just resets the bump
 * pointer — the SDK's Free calls are no-ops here. The arena is 192 MiB
 * in BSS (not in the file); wasm memory must be at least that plus
 * buffers, hence --initial-memory=256MB. A dictionary larger than the
 * arena fails allocation cleanly (SZ_ERROR_MEM) instead of corrupting.
 */
#include <stddef.h>
#include <stdint.h>
#include "LzmaDec.h"
#include "Lzma2Dec.h"
#include "Bra.h"

void *memcpy(void *dst, const void *src, size_t n) {
  unsigned char *d = dst; const unsigned char *s = src;
  while (n--) *d++ = *s++;
  return dst;
}
void *memset(void *dst, int c, size_t n) {
  unsigned char *d = dst;
  while (n--) *d++ = (unsigned char)c;
  return dst;
}
void *memmove(void *dst, const void *src, size_t n) {
  unsigned char *d = dst; const unsigned char *s = src;
  if (d < s) { while (n--) *d++ = *s++; }
  else if (d > s) { d += n; s += n; while (n--) *--d = *--s; }
  return dst;
}

#define IN_SIZE (256u * 1024u)
#define OUT_SIZE (1024u * 1024u)
static unsigned char in_buf[IN_SIZE];
static unsigned char out_buf[OUT_SIZE];

/* Arena: 192 MiB. BSS only — the .wasm file stays small. */
#define ARENA_SIZE (192u * 1024u * 1024u)
static unsigned char arena[ARENA_SIZE];
static size_t arena_pos = 0;

static void *arena_alloc(ISzAllocPtr p, size_t size) {
  (void)p;
  /* Align to 16 for the decoder's tables. */
  size_t pos = (arena_pos + 15u) & ~(size_t)15u;
  if (pos + size > ARENA_SIZE) return NULL;
  void *r = arena + pos;
  arena_pos = pos + size;
  return r;
}
static void arena_free(ISzAllocPtr p, void *address) { (void)p; (void)address; }
static ISzAlloc g_alloc = { arena_alloc, arena_free };

static CLzmaDec dec1;
static CLzma2Dec dec2;
static int is_lzma2 = 0;
static int begun = 0;

static const unsigned char *cur_src = NULL;
static size_t cur_len = 0, cur_pos = 0;
static size_t last_out = 0, last_consumed = 0;
static int last_status = 0, last_res = 0;

unsigned int lzma_in_ptr(void) { return (unsigned int)(uintptr_t)in_buf; }
unsigned int lzma_out_ptr(void) { return (unsigned int)(uintptr_t)out_buf; }
unsigned int lzma_in_size(void) { return IN_SIZE; }
unsigned int lzma_out_size(void) { return OUT_SIZE; }
unsigned int lzma_in_consumed(void) { return (unsigned int)last_consumed; }
int lzma_status(void) { return last_status; }

static SRes decode_step(void) {
  SizeT srcLen = cur_len - cur_pos;
  SizeT destLen = OUT_SIZE;
  ELzmaStatus status = LZMA_STATUS_NOT_SPECIFIED;
  SRes res;
  if (is_lzma2) {
    res = Lzma2Dec_DecodeToBuf(&dec2, out_buf, &destLen, cur_src + cur_pos, &srcLen, LZMA_FINISH_ANY, &status);
  } else {
    res = LzmaDec_DecodeToBuf(&dec1, out_buf, &destLen, cur_src + cur_pos, &srcLen, LZMA_FINISH_ANY, &status);
  }
  last_res = (int)res;
  last_status = (int)status;
  cur_pos += srcLen;
  last_consumed = cur_pos;
  last_out = destLen;
  return res;
}

int lzma_begin(int isLzma2, unsigned int propsLen) {
  is_lzma2 = isLzma2 ? 1 : 0;
  arena_pos = 0;
  cur_src = NULL; cur_len = 0; cur_pos = 0;
  last_out = 0; last_consumed = 0; last_status = 0; last_res = 0;
  SRes res;
  if (is_lzma2) {
    if (propsLen < 1) return SZ_ERROR_DATA;
    Lzma2Dec_Construct(&dec2);
    res = Lzma2Dec_Allocate(&dec2, in_buf[0], &g_alloc);
    if (res != SZ_OK) return (int)res;
    Lzma2Dec_Init(&dec2);
  } else {
    if (propsLen < LZMA_PROPS_SIZE) return SZ_ERROR_DATA;
    LzmaDec_Construct(&dec1);
    res = LzmaDec_Allocate(&dec1, in_buf, LZMA_PROPS_SIZE, &g_alloc);
    if (res != SZ_OK) return (int)res;
    LzmaDec_Init(&dec1);
  }
  begun = 1;
  return 0;
}

int lzma_feed(unsigned int inLen) {
  if (!begun || inLen > IN_SIZE) return -1;
  cur_src = in_buf; cur_len = inLen; cur_pos = 0;
  if (decode_step() != SZ_OK) return -1;
  return (int)last_out;
}

int lzma_drain(void) {
  if (!begun || cur_pos >= cur_len) return 0;
  if (decode_step() != SZ_OK) return -1;
  return (int)last_out;
}

void lzma_end(void) {
  if (is_lzma2) Lzma2Dec_Free(&dec2, &g_alloc);
  else LzmaDec_Free(&dec1, &g_alloc);
  begun = 0;
  arena_pos = 0;
}

/* --- x86 BCJ (branch converter) --------------------------------------- */
/* The SDK converts in place and returns how far it got; the tail (at
 * most a few bytes that could be the start of an E8/E9 opcode) is left
 * unconverted and carried to the next call via the state variable.
 * The JS wrapper keeps that tail and passes the stream position of the
 * buffer start as pc, exactly as 7-Zip's BCJ coder does. */
#define BCJ_SIZE (OUT_SIZE + 64u)
static unsigned char bcj_buf[BCJ_SIZE];
static unsigned int bcj_state = 0;

unsigned int bcj_in_ptr(void) { return (unsigned int)(uintptr_t)bcj_buf; }
unsigned int bcj_in_size(void) { return BCJ_SIZE; }
void bcj_reset(void) { bcj_state = 0; }
int bcj_convert(unsigned int inLen, unsigned int pc) {
  if (inLen > BCJ_SIZE) return -1;
  unsigned char *end = z7_BranchConvSt_X86_Dec(bcj_buf, inLen, pc, &bcj_state);
  return (int)(end - bcj_buf);
}
