const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),zlib=require('node:zlib');
const {selectMiruroServer}=require('../electron/miruro-playback.cjs');
const server=(label,kind='soft',group=1)=>({label,kind,group});
test('actual fast media wins over an answering but slow server and cancels other probes',async()=>{
  let cancelled=false;
  const result=await selectMiruroServer([server('slow'),server('fast'),server('hung')],{priority:s=>s.group,probe:async(s,signal)=>{
    if(s.label==='hung')return new Promise((_,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(Error('cancelled'))}));
    if(s.label==='fast'){await new Promise(r=>setTimeout(r,10));return{speed:2000,requiredSpeed:500}}
    return{speed:100,requiredSpeed:500};
  }});
  assert.equal(result.server.label,'fast');assert.equal(cancelled,true);
});
test('Korean/clean-video priority survives speed racing; automatic original audio never becomes English dub',async()=>{
  const seen=[];
  const result=await selectMiruroServer([server('korean','soft',.5),server('sub','sub',2),server('dub','dub',0)],{priority:s=>s.group,probe:async s=>{seen.push(s.label);return{speed:1000}}});
  assert.equal(result.server.label,'korean');assert.deepEqual(seen,['korean']);
  await assert.rejects(selectMiruroServer([server('original'),server('dub','dub')],{priority:()=>1,probe:async()=>{throw Error('broken')}}),/broken/);
});
test('manual choices are validated, excluded failures are skipped, and a dubbed choice stays dubbed',async()=>{
  const items=[server('manual'),server('other')];
  assert.equal((await selectMiruroServer(items,{preferred:'manual',priority:()=>1,probe:async()=>({speed:10})})).server.label,'manual');
  const dubbed=[server('dub1','dub'),server('dub2','dub'),server('original')];
  const result=await selectMiruroServer(dubbed,{preferred:'dub1',excluded:['dub1'],priority:()=>1,probe:async()=>({speed:1000})});
  assert.equal(result.server.label,'dub2');
});
test('if every playable server is slow, the fastest available one is used',async()=>{
  const result=await selectMiruroServer([server('one'),server('two')],{priority:()=>1,probe:async s=>({speed:s.label==='one'?100:200,requiredSpeed:500})});
  assert.equal(result.server.label,'two');
});
const source=fs.readFileSync(path.resolve(__dirname,'../electron/main.cjs'),'utf8');
function isolate(name,end,fetch){const context=vm.createContext({miruroRequest:async url=>{const response=await fetch(url);return {response,body:Buffer.from(await response.arrayBuffer())}},fetch,AbortSignal,URL,Buffer,zlib,Date,LINKKF_UA:'test',MIRURO_WEB:'https://www.miruro.to',MIRURO_KEY:Buffer.from('miruro/catalog')});const at=source.indexOf(`async function ${name}(`);vm.runInContext(source.slice(at,source.indexOf(end,at)),context);return context[name];}
const encode=value=>{const data=zlib.gzipSync(JSON.stringify(value)),key=Buffer.from('miruro/catalog');for(let i=0;i<data.length;i++)data[i]^=key[i%key.length];return data;};
test('catalog connection failures retry compatible mirrors with the same query; permanent errors do not',async()=>{
  const calls=[];
  const api=isolate('miruroApi','\nfunction miruroText',async url=>{calls.push(String(url));if(calls.length===1)throw Error('offline');return new Response(encode({data:[{id:'same'}]}));});
  assert.equal((await api('anime',{limit:15,genre_all:'Action'})).data[0].id,'same');
  assert.equal(new URL(calls[1]).host,'www.miruro.tv');assert.equal(new URL(calls[1]).searchParams.get('genre_all'),'Action');
  let count=0;const bad=isolate('miruroApi','\nfunction miruroText',async()=>{count++;return new Response('{}',{status:400})});
  await assert.rejects(bad('anime'),/400/);assert.equal(count,1);
});
test('probe checks media segments even when the manifest responds; validates playlists and follows redirects',async()=>{
  const calls=[],manifest='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1920x1080\nmedia/list.m3u8';
  const probe=isolate('hlsProbe','\n// --- 애니24',async url=>{calls.push(String(url));const response=new Response(calls.length===1?manifest:calls.length===2?'#EXTM3U\n#EXTINF:5,\none.ts\n#EXTINF:5,\ntwo.ts':new Uint8Array(10000));Object.defineProperty(response,'url',{value:calls.length===1?'https://cdn.test/redirect/master.m3u8':String(url)});return response;});
  const result=await probe('https://original.test/master.m3u8');
  assert.equal(calls[1],'https://cdn.test/redirect/media/list.m3u8');assert.match(calls[2],/one.ts$/);assert.match(calls[3],/two.ts$/);assert.ok(result.requiredSpeed>140);
  const broken=isolate('hlsProbe','\n// --- 애니24',async()=>new Response('<html>not a playlist</html>'));
  await assert.rejects(broken('https://bad.test'),/HLS/);
});
