'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
(async()=>{
  const {Updater}=require('../electron/updater.cjs');
  const previousFetch=global.fetch,calls=[];
  const current={tag_name:'libmpv-r2k-v0.5.50-r2',draft:false,prerelease:true,html_url:'https://example.invalid/current',body:'current',assets:[]};
  const older={tag_name:'libmpv-r2k-v0.5.50-r1',draft:false,prerelease:true,html_url:'https://example.invalid/older',body:'older',assets:[]};
  const future={tag_name:'libmpv-r2k-v0.5.50-r3',draft:false,prerelease:true,html_url:'https://example.invalid/future',body:'future',assets:[{name:'LilacAnime-Libmpv-R2S-Setup.exe',browser_download_url:'https://example.invalid/r3.exe',size:4321}]};
  let releases=[current,older];
  global.fetch=async(url,options)=>{calls.push({url:String(url),accept:options?.headers?.Accept||''});return{ok:true,status:200,json:async()=>releases}};
  const fakeApp={getVersion:()=> '0.5.50-libmpv-r2s.rc1',getName:()=> 'LilacAnime Libmpv R2S',getPath:()=>path.resolve(process.cwd(),'.tmp-r2s-updater'),quit:()=>{}};
  try{
    const updater=new Updater({app:fakeApp,broadcast:()=>{}});
    assert.equal(updater.isolatedCandidate,true);
    let checked=await updater.check();assert.equal(checked.status,'latest');assert.equal(checked.customTag,current.tag_name);
    releases=[older,future,current];updater.download=async()=>updater.state;checked=await updater.check();
    assert.equal(checked.status,'available');assert.equal(checked.customTag,future.tag_name);assert.equal(updater.asset.name,'LilacAnime-Libmpv-R2S-Setup.exe');
    console.log(`LIBMPV_R2S_UPDATER_PASS current=${current.tag_name} future=${future.tag_name} calls=${calls.length}`);
  }finally{global.fetch=previousFetch}
})().catch(e=>{console.error(e?.stack||e);process.exitCode=1});
