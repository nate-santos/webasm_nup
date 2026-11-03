/* nup_wasm.c — WebAssembly worker for the webasm_nup packer.
 *
 * Provides, in WASM, the two per-byte jobs of a .nup pack:
 *   1. streaming SHA-256 (SPEC §3.4, per-file hash over uncompressed bytes)
 *   2. streaming zstd compression, level 3 by default, one frame per file,
 *      content size pledged in the frame header (SPEC §4.1)
 *
 * The host (JS) owns all file I/O: it copies input chunks into the input
 * buffer, calls sha_update / zstd_feed, and writes the output buffer to
 * storage (OPFS in the browser). No file ever has to sit whole in RAM:
 * chunks are 256 KiB, and the output buffer is drained after every call.
 * A small free-list allocator backs zstd's malloc/free. This matters:
 * zstd reallocs its workspace whenever the pledged source size changes
 * (it derives window/parameters from it), so a bump allocator that
 * never frees leaks one workspace per size change and exhausts the
 * heap after enough varying-size files — which surfaced as
 * "zstd_feed failed (-1)" (a memory error) partway through large
 * conversions. The free list reuses freed blocks, so heap use stays
 * bounded no matter how many files are packed.
 *
 * zstd sources are the upstream 1.5.7 lib/ (BSD licensed), compiled in
 * from ../wasm-src/zstd-1.5.7/lib — see build.sh. This file itself is
 * the only code written for this project in the WASM module.
 */

#include <stdint.h>
#include <stddef.h>

/* ---- minimal libc shims (nostdlib build) ---- */
void *memcpy(void *dst, const void *src, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    for (size_t i = 0; i < n; i++) d[i] = s[i];
    return dst;
}
void *memset(void *dst, int c, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    for (size_t i = 0; i < n; i++) d[i] = (unsigned char)c;
    return dst;
}
void *memmove(void *dst, const void *src, size_t n) {
    unsigned char *d = (unsigned char *)dst;
    const unsigned char *s = (const unsigned char *)src;
    if (d < s) { for (size_t i = 0; i < n; i++) d[i] = s[i]; }
    else { for (size_t i = n; i-- > 0;) d[i] = s[i]; }
    return dst;
}
size_t strlen(const char *s) { size_t n = 0; while (s[n]) n++; return n; }
void abort(void) { __builtin_trap(); }
int memcmp(const void *a, const void *b, size_t n) {
    const unsigned char *x = (const unsigned char *)a, *y = (const unsigned char *)b;
    for (size_t i = 0; i < n; i++) { if (x[i] != y[i]) return (int)x[i] - (int)y[i]; }
    return 0;
}

/* Free-list allocator: 48 MiB heap, first-fit with splitting and
   coalescing. Block layout: 16-byte header (payload size, free-list
   link, padding) followed by a 16-aligned payload. The free list is
   kept sorted by address so neighbours can be merged on free. */
#define HEAP_SIZE (48u * 1024u * 1024u)
static _Alignas(16) unsigned char heap[HEAP_SIZE];
static size_t heap_top = 0; /* bump pointer for fresh blocks */
typedef struct Hdr {
    size_t size; /* payload bytes */
    struct Hdr *next; /* free-list link (only valid while free) */
    size_t pad1, pad2;
} Hdr;
static Hdr *free_list = 0;
#define HDR_SIZE 16u
#define ALIGN16(n) (((n) + 15u) & ~(size_t)15u)
static Hdr *hdr_of(void *p) { return (Hdr *)((unsigned char *)p - HDR_SIZE); }
static void *payload_of(Hdr *h) { return (unsigned char *)h + HDR_SIZE; }
/* Insert h into the address-sorted free list and merge with any
   adjacent free neighbours. */
static void free_insert(Hdr *h) {
    Hdr **pp = &free_list, *prev = 0;
    while (*pp && *pp < h) { prev = *pp; pp = &(*pp)->next; }
    h->next = *pp;
    *pp = h;
    /* Merge with successor if it directly follows h. */
    if (h->next && (unsigned char *)h + HDR_SIZE + h->size == (unsigned char *)h->next) {
        Hdr *s = h->next;
        h->size += HDR_SIZE + s->size;
        h->next = s->next;
    }
    /* Merge with predecessor if h directly follows it. */
    if (prev && (unsigned char *)prev + HDR_SIZE + prev->size == (unsigned char *)h) {
        prev->size += HDR_SIZE + h->size;
        prev->next = h->next;
    }
}
static void free_remove(Hdr *h) {
    Hdr **pp = &free_list;
    while (*pp && *pp != h) pp = &(*pp)->next;
    if (*pp) *pp = h->next;
}
void *malloc(size_t n) {
    if (n == 0) n = 1;
    size_t need = ALIGN16(n);
    /* First fit in the free list. */
    for (Hdr *h = free_list; h; h = h->next) {
        if (h->size >= need) {
            free_remove(h);
            if (h->size >= need + HDR_SIZE + 16u) {
                /* Split off the remainder as a new free block. */
                Hdr *r = (Hdr *)((unsigned char *)h + HDR_SIZE + need);
                r->size = h->size - need - HDR_SIZE;
                h->size = need;
                free_insert(r);
            }
            return payload_of(h);
        }
    }
    /* Fresh block from the top of the heap. */
    size_t total = HDR_SIZE + need;
    if (heap_top + total > HEAP_SIZE) return 0;
    Hdr *h = (Hdr *)(heap + heap_top);
    heap_top += total;
    h->size = need;
    return payload_of(h);
}
void *calloc(size_t n, size_t sz) {
    if (sz && n > (size_t)-1 / sz) return 0; /* overflow */
    size_t t = n * sz;
    void *p = malloc(t);
    if (p) memset(p, 0, t);
    return p;
}
void free(void *p) {
    if (!p) return;
    /* Ignore pointers that did not come from this heap. */
    if ((unsigned char *)p < heap + HDR_SIZE || (unsigned char *)p >= heap + HEAP_SIZE) return;
    free_insert(hdr_of(p));
}
void *realloc(void *p, size_t n) {
    if (!p) return malloc(n);
    if (n == 0) { free(p); return 0; }
    Hdr *h = hdr_of(p);
    size_t old = h->size, need = ALIGN16(n);
    if (need <= old) {
        /* Shrink in place, freeing the tail if it makes a whole block. */
        if (old >= need + HDR_SIZE + 16u) {
            Hdr *r = (Hdr *)((unsigned char *)h + HDR_SIZE + need);
            r->size = old - need - HDR_SIZE;
            h->size = need;
            free_insert(r);
        }
        return p;
    }
    /* Try to grow into the physically following block if it is free. */
    Hdr *next = (Hdr *)((unsigned char *)h + HDR_SIZE + old);
    int next_free = 0;
    for (Hdr *f = free_list; f; f = f->next) if (f == next) { next_free = 1; break; }
    if (next_free && old + HDR_SIZE + next->size >= need) {
        size_t combined = old + HDR_SIZE + next->size;
        free_remove(next);
        if (combined >= need + HDR_SIZE + 16u) {
            Hdr *r = (Hdr *)((unsigned char *)h + HDR_SIZE + need);
            r->size = combined - need - HDR_SIZE;
            h->size = need;
            free_insert(r);
        } else {
            h->size = combined;
        }
        return p;
    }
    /* Move: copy only the bytes that actually exist. */
    void *q = malloc(n);
    if (!q) return 0;
    memcpy(q, p, old < n ? old : n);
    free(p);
    return q;
}

/* ---- chunk buffers ---- */
#define IN_SIZE  (256u * 1024u)
#define OUT_SIZE (512u * 1024u)
static unsigned char in_buf[IN_SIZE];
static unsigned char out_buf[OUT_SIZE];

unsigned char *nup_in_ptr(void) { return in_buf; }
unsigned char *nup_out_ptr(void) { return out_buf; }
unsigned int nup_in_size(void) { return IN_SIZE; }
unsigned int nup_out_size(void) { return OUT_SIZE; }

/* ---- SHA-256 (FIPS 180-4), streaming ---- */
typedef struct {
    uint32_t h[8];
    uint64_t len;
    unsigned char buf[64];
    size_t buflen;
} Sha256;

static const uint32_t K256[64] = {
    0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
    0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
    0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
    0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
    0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
    0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
    0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
    0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
};
#define ROR(x,n) (((x) >> (n)) | ((x) << (32 - (n))))
static void sha_block(Sha256 *c, const unsigned char *p) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
        w[i] = ((uint32_t)p[i*4] << 24) | ((uint32_t)p[i*4+1] << 16) |
               ((uint32_t)p[i*4+2] << 8) | (uint32_t)p[i*4+3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = ROR(w[i-15],7) ^ ROR(w[i-15],18) ^ (w[i-15] >> 3);
        uint32_t s1 = ROR(w[i-2],17) ^ ROR(w[i-2],19) ^ (w[i-2] >> 10);
        w[i] = w[i-16] + s0 + w[i-7] + s1;
    }
    uint32_t a=c->h[0],b=c->h[1],d=c->h[3],e=c->h[4],f=c->h[5],g=c->h[6],h=c->h[7],cc=c->h[2];
    for (int i = 0; i < 64; i++) {
        uint32_t S1 = ROR(e,6) ^ ROR(e,11) ^ ROR(e,25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t t1 = h + S1 + ch + K256[i] + w[i];
        uint32_t S0 = ROR(a,2) ^ ROR(a,13) ^ ROR(a,22);
        uint32_t mj = (a & b) ^ (a & cc) ^ (b & cc);
        uint32_t t2 = S0 + mj;
        h=g; g=f; f=e; e=d+t1; d=cc; cc=b; b=a; a=t1+t2;
    }
    c->h[0]+=a; c->h[1]+=b; c->h[2]+=cc; c->h[3]+=d;
    c->h[4]+=e; c->h[5]+=f; c->h[6]+=g; c->h[7]+=h;
}
static Sha256 sha;
void sha_init(void) {
    static const uint32_t init[8] = {0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,
        0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};
    memcpy(sha.h, init, sizeof(init));
    sha.len = 0; sha.buflen = 0;
}
void sha_update(unsigned int len) {
    const unsigned char *p = in_buf;
    sha.len += len;
    while (len > 0) {
        size_t take = 64 - sha.buflen;
        if (take > len) take = len;
        memcpy(sha.buf + sha.buflen, p, take);
        sha.buflen += take; p += take; len -= (unsigned int)take;
        if (sha.buflen == 64) { sha_block(&sha, sha.buf); sha.buflen = 0; }
    }
}
/* writes the 32-byte digest into out_buf; returns 32 */
int sha_final(void) {
    uint64_t bits = sha.len * 8u;
    unsigned char pad = 0x80;
    /* feed padding through the block machinery using a scratch copy of the tail */
    unsigned char tail[128];
    size_t tl = sha.buflen;
    memcpy(tail, sha.buf, tl);
    tail[tl++] = pad;
    while ((tl % 64) != 56) tail[tl++] = 0;
    for (int i = 7; i >= 0; i--) tail[tl++] = (unsigned char)(bits >> (i * 8));
    /* process tail blocks directly (do not touch sha.len again) */
    for (size_t off = 0; off < tl; off += 64) sha_block(&sha, tail + off);
    for (int i = 0; i < 8; i++) {
        out_buf[i*4]   = (unsigned char)(sha.h[i] >> 24);
        out_buf[i*4+1] = (unsigned char)(sha.h[i] >> 16);
        out_buf[i*4+2] = (unsigned char)(sha.h[i] >> 8);
        out_buf[i*4+3] = (unsigned char)(sha.h[i]);
    }
    return 32;
}

/* ---- streaming zstd (one frame per file) ---- */
#include "zstd.h"
static ZSTD_CCtx *cctx = 0;
int zstd_begin(unsigned long long total_size, int level) {
    if (!cctx) {
        cctx = ZSTD_createCCtx();
        if (!cctx) return -1;
    }
    if (ZSTD_isError(ZSTD_CCtx_reset(cctx, ZSTD_reset_session_only))) return -1;
    if (ZSTD_isError(ZSTD_CCtx_setParameter(cctx, ZSTD_c_compressionLevel, level))) return -1;
    if (ZSTD_isError(ZSTD_CCtx_setParameter(cctx, ZSTD_c_nbWorkers, 0))) return -1;
    if (ZSTD_isError(ZSTD_CCtx_setParameter(cctx, ZSTD_c_contentSizeFlag, 1))) return -1;
    if (ZSTD_isError(ZSTD_CCtx_setParameter(cctx, ZSTD_c_checksumFlag, 0))) return -1;
    if (ZSTD_isError(ZSTD_CCtx_setParameter(cctx, ZSTD_c_dictIDFlag, 0))) return -1;
    if (ZSTD_isError(ZSTD_CCtx_setPledgedSrcSize(cctx, (unsigned long long)total_size))) return -1;
    return 0;
}
/* Feed in_buf[0..len). is_last=1 flushes the frame end.
   Returns bytes written to out_buf, or -1 on zstd error, -2 if out_buf filled. */
int zstd_feed(unsigned int len, int is_last) {
    ZSTD_inBuffer in = { in_buf, (size_t)len, 0 };
    size_t produced = 0;
    while (1) {
        if (produced >= OUT_SIZE) return -2;
        ZSTD_outBuffer out = { out_buf + produced, OUT_SIZE - produced, 0 };
        size_t r = ZSTD_compressStream2(cctx, &out, &in,
            is_last ? ZSTD_e_end : ZSTD_e_continue);
        if (ZSTD_isError(r)) return -1;
        produced += out.pos;
        if (is_last) { if (r == 0) break; }
        else { if (in.pos == in.size) break; }
        if (out.pos == 0 && in.pos == in.size && !is_last) break;
        if (produced >= OUT_SIZE) return -2;
    }
    return (int)produced;
}
