/* Minimal errno.h shim for the wasm32 freestanding build: 7zTypes.h only
   needs the ENOMEM/EINVAL constants for its HRESULT macros; nothing in
   the decoder actually reads errno. */
#pragma once
#define EPERM 1
#define ENOENT 2
#define EINTR 4
#define EIO 5
#define EAGAIN 11
#define ENOMEM 12
#define EACCES 13
#define EFAULT 14
#define EBUSY 16
#define EEXIST 17
#define ENODEV 19
#define EINVAL 22
#define ENOSPC 28
#define EPIPE 32
#define ERANGE 34
