// node test/test-regressions.mjs (requires 7z and python3)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadLzma } from '../lzma.js';
import { loadWasm, packNup } from '../packer.js';
import { openSevenz } from '../sevenz.js';
import { openZip } from '../zip.js';
const root = new URL('../', import.meta.url);
// Optional differential check against a separate checkout of the old code.
const baseline = process.env.NUP_BASELINE;
let oldLzma, oldOpen, baselineFailures = 0;
if (baseline) {
 const {pathToFileURL} = await import('node:url');
 const load = await import(pathToFileURL(path.join(baseline,'lzma.js')));
 oldOpen = (await import(pathToFileURL(path.join(baseline,'sevenz.js')))).openSevenz;
 oldLzma = await load.loadLzma(await fs.readFile(path.join(baseline,'lzma.wasm')));
}
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nup-regressions-'));
const lzma = await loadLzma();
const wasm = await loadWasm(await fs.readFile(new URL('nup.wasm', root)));
function fileLike(buf) { return { name: 'test.7z', size: buf.length, slice: (s,e) => new Blob([buf.subarray(s,e)]) }; }
function allFiles(n) { return n.children ? n.children.flatMap(allFiles) : [n]; }
const source = (str) => ({ size: str.length, async *chunks() { yield Buffer.from(str); } });
async function pack(children) {
  let data = Buffer.alloc(0), writes = 0;
  const out = { async writeAt(pos,b) { writes++; if(data.length < pos+b.length) { const next=Buffer.alloc(pos+b.length);data.copy(next);data=next; } data.set(b,pos); }, async truncate(n) {data=data.subarray(0,n);}, async close() {} };
  await packNup(wasm,[{kind:0,titleId:1n,version:0,flags:0,root:{name:'',children}}],out);
  return { data, writes };
}
function seven(args) { execFileSync('7z',args,{cwd:tmp,stdio:'pipe'}); }
try {
  const mixed = [{name:'ExeFS',children:[{name:'Main',file:source('abc')}]},{name:'RomFS',children:[{name:'KeepCASE',file:source('xyz')}]}];
  const lower = mixed.map(x=>({...x,name:x.name.toLowerCase()}));
  const a=await pack(mixed), b=await pack(lower);
  assert.deepEqual(a.data,b.data,'mixed case produces byte-identical canonical NUP');
  assert.notEqual(a.data.readUInt32LE(0x80+48+12),0xffffffff);
  assert.notEqual(a.data.readUInt32LE(0x80+48+16),0xffffffff);
  assert.equal(mixed[0].name,'ExeFS','source tree unmodified');
  for(const children of [
    [{name:'x',file:source('a')},{name:'x',children:[]}],
    [{name:'romfs',children:[]},{name:'RomFS',children:[]}],
    [{name:'romfs',children:[{name:'x',file:source('a')},{name:'x',file:source('b')}]}],
  ]) await assert.rejects(pack(children),/duplicate child/);
  await pack([{name:'romfs',children:[{name:'B',file:source('1')},{name:'b',file:source('2')}]}]);
  console.log('ok mixed-case pointers, canonical names, duplicate rejection, legal B/b');
  execFileSync('python3',['-c',`import zipfile,sys
for i,entries in enumerate([['x','x/y'],['x/y','x'],['x','x/']]):
 with zipfile.ZipFile(sys.argv[1]+'/clash'+str(i)+'.zip','w') as z:
  for x in entries:z.writestr(x,b'data')`,tmp]);
  for(let i=0;i<3;i++) await assert.rejects(openZip(fileLike(await fs.readFile(path.join(tmp,`clash${i}.zip`)))),/clash|duplicate/);
  console.log('ok ZIP file/directory clashes in both orders');
  await fs.mkdir(path.join(tmp,'base/romfs'),{recursive:true});
  const expected = new Map();
  // Deterministic bytes, including enough files to exercise encoded headers.
  for(let i=0;i<302;i++) {
    const buf=Buffer.alloc(104857+(i%29));
    for(let j=0;j<buf.length;j++) buf[j]=(i*13+j*7+(j>>8))&255;
    const name=`f${String(i).padStart(4,'0')}.bin`;
    expected.set(name,buf);await fs.writeFile(path.join(tmp,'base/romfs',name),buf);
  }
  seven(['a','solid.7z','base']);seven(['t','solid.7z']);
  const buf=await fs.readFile(path.join(tmp,'solid.7z'));
  let begin=0;const instrumented={...lzma,createDecoder(...args){begin++;return lzma.createDecoder(...args);}};
  const start=performance.now();const archive=await openSevenz(fileLike(buf),instrumented);
  const headerDecodes=begin;
  for(const f of allFiles(archive.root)) assert.deepEqual(Buffer.from(await f.file.readAll()),expected.get(f.name));
  for(const f of allFiles(archive.root)) assert.deepEqual(Buffer.from(await f.file.readRange(10,37)),expected.get(f.name).subarray(10,47));
  assert.equal(begin-headerDecodes,1,'one data decode for 604 reads');
  console.log(`ok 302-file solid archive, two read passes: ${(performance.now()-start).toFixed(0)} ms, one folder decode`);
  await archive.dispose();await assert.rejects(allFiles(archive.root)[0].file.readAll(),/removed/);
  // Different header/name counts reproduce the no-end-marker LZMA1 case.
  for(let i=0;i<30;i++) {
    const name=`archive-${i}.7z`;
    seven(['a',name,...Array.from({length:i+1},(_,j)=>`base/romfs/f${String(j).padStart(4,'0')}.bin`)]);
    seven(['t',name]);
    const archiveBytes = await fs.readFile(path.join(tmp,name));
    if (baseline) { try { await oldOpen(fileLike(archiveBytes),oldLzma); } catch(e) { if(/decoded size mismatch/.test(e.message))baselineFailures++; else throw e; } }
    const z=await openSevenz(fileLike(archiveBytes),lzma);
    for(const f of allFiles(z.root)) assert.deepEqual(Buffer.from(await f.file.readAll()),expected.get(f.name));
    await z.dispose();
  }
  console.log('ok 30 default 7-Zip archives, all payload bytes verified');
  if(baseline) {assert.ok(baselineFailures>0,'corpus must reproduce old header rejection');console.log(`old code rejected ${baselineFailures}/30 of these same archives`);}
  // Large dictionary properties are tested without allocating that dictionary.
  assert.throws(()=>lzma.createDecoder(true,Uint8Array.of(32)),/256 MiB.*128 MiB/);
  assert.throws(()=>lzma.createDecoder(false,Uint8Array.of(93,0,0,0,16)),/256 MiB.*128 MiB/);
  assert.throws(()=>lzma.createDecoder(true,Uint8Array.of(41)),/invalid dictionary/);
  console.log('ok explicit LZMA1/LZMA2 dictionary errors');
  const corrupt=Buffer.from(buf);corrupt[40]^=0x40;
  await assert.rejects(async()=>{const z=await openSevenz(fileLike(corrupt),lzma);try{for(const f of allFiles(z.root))await f.file.readAll();}finally{await z.dispose();}},/CRC|data error|size mismatch/);
  await assert.rejects(openSevenz(fileLike(buf.subarray(0,buf.length-5)),lzma),/truncated|CRC/);
  console.log('ok corrupted and truncated archives rejected');
  // Test OPFS adapter and quota cleanup deterministically, independent of browser quota.
  let deleted=0, written=0;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{getDirectory:async()=>({getDirectoryHandle:async()=>({
    getFileHandle:async()=>({createWritable:async()=>({write:async()=>{written++;throw new Error('quota exceeded');},abort:async()=>{}})}),
    removeEntry:async()=>{deleted++;}
  })})}}});
  const z=await openSevenz(fileLike(buf),lzma);
  await assert.rejects(allFiles(z.root)[0].file.readAll(),/quota exceeded/);
  assert.equal(written,1);assert.equal(deleted,1);await z.dispose();delete globalThis.navigator;
  console.log('ok OPFS write failure aborts and deletes temporary cache');
  console.log('all five-issue regressions passed');
} finally {await fs.rm(tmp,{recursive:true,force:true});}
