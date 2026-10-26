'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

let main = read('electron/main.cjs');
const pkg = JSON.parse(read('package.json'));
if (!main.includes('async function extractCommunityArchive(buffer,dir){') || !main.includes('new AdmZip(buffer)')) {
  throw new Error('community archive baseline missing');
}
if (main.includes('LILAC_R33_COMMUNITY_ARCHIVE_WORKER')) throw new Error('community archive worker already applied');

main = replaceOnce(
  main,
  "const AdmZip = require('adm-zip');\nconst { spawn } = require('child_process');",
  "const { Worker } = require('worker_threads'); // LILAC_R33_COMMUNITY_ARCHIVE_WORKER\nconst { spawn } = require('child_process');",
  'replace main-thread AdmZip import with Worker'
);

const start = main.indexOf('async function extractCommunityArchive(buffer,dir){');
const end = main.indexOf('\n// UTF-16 files (common for SMI)', start);
if (start < 0 || end <= start) throw new Error('community archive function boundary missing');
const replacement = String.raw`let communityArchiveWorker=null,communityArchiveWorkerSeq=1;
const communityArchiveWorkerPending=new Map();
function communityArchiveWorkerFail(error){
  const failure=error instanceof Error?error:new Error(String(error||'자막 압축해제 worker 오류'));
  for(const {reject} of communityArchiveWorkerPending.values())reject(failure);
  communityArchiveWorkerPending.clear();
  communityArchiveWorker=null;
}
function ensureCommunityArchiveWorker(){
  if(communityArchiveWorker)return communityArchiveWorker;
  const worker=new Worker(path.join(__dirname,'community-archive-worker.cjs'));
  worker.unref();
  worker.on('message',message=>{
    const pending=communityArchiveWorkerPending.get(message?.id);if(!pending)return;
    communityArchiveWorkerPending.delete(message.id);
    if(message.ok)pending.resolve(message.files||[]);else pending.reject(new Error(message.error||'자막 압축해제 worker 실패'));
  });
  worker.on('error',communityArchiveWorkerFail);
  worker.on('exit',code=>{if(communityArchiveWorker===worker)communityArchiveWorkerFail(new Error(`자막 압축해제 worker 종료 (${code})`))});
  communityArchiveWorker=worker;
  return worker;
}
function communityArchiveKind(buffer){
  if(buffer?.[0]===0x50&&buffer?.[1]===0x4b)return 'zip';
  if(buffer?.slice?.(0,6).equals(Buffer.from([0x37,0x7a,0xbc,0xaf,0x27,0x1c])))return '7z';
  if(buffer?.slice?.(0,4).toString('latin1')==='Rar!')return 'rar';
  return null;
}
async function extractCommunityArchive(buffer,dir){
  const kind=communityArchiveKind(buffer);if(!kind)return null;
  const id=communityArchiveWorkerSeq++;
  // Network/archive buffers are normally backed by an exact ArrayBuffer. Small pooled
  // buffers are copied before transfer so detaching a slab can never affect neighbors.
  const exact=buffer.byteOffset===0&&buffer.byteLength===buffer.buffer.byteLength;
  const transferable=exact?buffer.buffer:buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength);
  const worker=ensureCommunityArchiveWorker();
  return new Promise((resolve,reject)=>{
    communityArchiveWorkerPending.set(id,{resolve,reject});
    try{worker.postMessage({id,kind,dir,buffer:transferable},[transferable])}
    catch(error){communityArchiveWorkerPending.delete(id);reject(error)}
  });
}
`;
main = main.slice(0,start) + replacement + main.slice(end);

const workerSource = String.raw`'use strict';
const { parentPort } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const COMMUNITY_FILE=/\.(ass|ssa|srt|vtt|smi|ttf|otf|ttc)$/i;
const MAX_FILE=100*1024*1024,MAX_TOTAL=300*1024*1024;
function cleanName(name){return path.basename(String(name).replace(/\\/g,'/')).normalize('NFC').replace(/[^\p{L}\p{N}._ ()\[\]-]/gu,'_')}
function targetFor(dir,name){
  if(!COMMUNITY_FILE.test(name))return null;
  const clean=cleanName(name);if(!clean)return null;
  let out=path.join(dir,clean);for(let n=1;fs.existsSync(out);n++)out=path.join(dir,`${n}_${clean}`);return out;
}
function extractZip(buffer,dir){
  const files=[],zip=new AdmZip(buffer);let total=0;
  for(const entry of zip.getEntries()){
    if(entry.isDirectory)continue;
    const size=Number(entry.header?.size||0);total+=size;
    if(size>MAX_FILE||total>MAX_TOTAL)throw new Error('ZIP 자막 크기 제한을 초과했습니다.');
    const name=entry.header?.flags&0x800?entry.entryName:new TextDecoder('euc-kr').decode(entry.rawEntryName);
    const out=targetFor(dir,name);if(!out)continue;
    fs.writeFileSync(out,entry.getData());files.push(out);
  }
  return files;
}
function bsdtarPath(){
  if(process.platform==='win32')return path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe');
  if(process.platform==='darwin')return '/usr/bin/tar';
  for(const dir of String(process.env.PATH||'').split(path.delimiter)){const candidate=path.join(dir,'bsdtar');if(fs.existsSync(candidate))return candidate}
  return null;
}
function walkFiles(folder,out=[]){for(const item of fs.readdirSync(folder,{withFileTypes:true})){const full=path.join(folder,item.name);if(item.isDirectory())walkFiles(full,out);else if(item.isFile())out.push(full)}return out}
function extractExternal(buffer,dir,kind){
  const tar=bsdtarPath();if(!tar)throw new Error('bsdtar를 찾지 못했습니다.');
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-sub-worker-')),archive=path.join(work,kind==='rar'?'a.rar':'a.7z'),outDir=path.join(work,'x');
  try{
    fs.writeFileSync(archive,buffer);fs.mkdirSync(outDir);
    const result=spawnSync(tar,['-xf',archive,'-C',outDir],{windowsHide:true,stdio:'pipe'});
    if(result.error||result.status!==0)throw result.error||new Error(`tar ${result.status}: ${String(result.stderr||'').slice(0,300)}`);
    const files=[];let total=0;
    for(const source of walkFiles(outDir)){
      const stat=fs.statSync(source);total+=stat.size;if(stat.size>MAX_FILE||total>MAX_TOTAL)throw new Error('압축 자막 크기 제한을 초과했습니다.');
      const target=targetFor(dir,path.basename(source));if(!target)continue;
      fs.copyFileSync(source,target);files.push(target);
    }
    return files;
  }finally{fs.rmSync(work,{recursive:true,force:true})}
}
parentPort.on('message',message=>{
  const id=message?.id;
  try{
    if(!id||!message.dir||!(message.buffer instanceof ArrayBuffer))throw new Error('잘못된 archive worker 요청입니다.');
    fs.mkdirSync(message.dir,{recursive:true});
    const buffer=Buffer.from(message.buffer);
    const files=message.kind==='zip'?extractZip(buffer,message.dir):message.kind==='7z'||message.kind==='rar'?extractExternal(buffer,message.dir,message.kind):null;
    if(!files)throw new Error('지원하지 않는 archive 형식입니다.');
    parentPort.postMessage({id,ok:true,files});
  }catch(error){parentPort.postMessage({id,ok:false,error:String(error?.message||error).slice(0,500)})}
});
`;
write('electron/community-archive-worker.cjs', workerSource);
write('electron/main.cjs', main);

pkg.build ||= {};
const unpack = Array.isArray(pkg.build.asarUnpack) ? pkg.build.asarUnpack : (pkg.build.asarUnpack ? [pkg.build.asarUnpack] : []);
for (const item of ['electron/community-archive-worker.cjs','node_modules/adm-zip/**']) if (!unpack.includes(item)) unpack.push(item);
pkg.build.asarUnpack = unpack;
write('package.json', JSON.stringify(pkg,null,2)+'\n');

const finalMain=read('electron/main.cjs'),finalWorker=read('electron/community-archive-worker.cjs'),finalPkg=JSON.parse(read('package.json'));
if(!finalMain.includes('LILAC_R33_COMMUNITY_ARCHIVE_WORKER')||!finalMain.includes('ensureCommunityArchiveWorker')||finalMain.includes('new AdmZip(buffer)'))throw new Error('main-thread archive extraction survived');
for(const marker of ['parentPort','new AdmZip(buffer)','spawnSync','MAX_TOTAL','copyFileSync'])if(!finalWorker.includes(marker))throw new Error(`archive worker marker missing: ${marker}`);
for(const item of ['electron/community-archive-worker.cjs','node_modules/adm-zip/**'])if(!finalPkg.build.asarUnpack.includes(item))throw new Error(`asarUnpack worker dependency missing: ${item}`);
console.log('R33_COMMUNITY_ARCHIVE_WORKER_OK mainThreadAdmZip=0 workerQueue=1 transfer=ArrayBuffer zip=worker 7zRar=worker limits=100MB+300MB asarUnpack=worker+admzip');
