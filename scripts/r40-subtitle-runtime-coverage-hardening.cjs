'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, 'r40-native-subtitle-overlay-runtime-smoke.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

if (!source.includes('R40_SUBTITLE_POST_PRESENTER_FOCUS_PROOF')) {
  throw new Error('R40 subtitle coverage hardening requires focus hardening first');
}
if (source.includes('R40_SUBTITLE_DEFERRED_REPLAY_RUNTIME_OK')) {
  throw new Error('R40 subtitle coverage hardening already applied');
}

replaceOnce(
  `      #stack{position:absolute;left:120px;top:405px;width:660px;height:86px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:0}\n      #cue{display:block;color:rgb(255,0,255);font-family:Arial,sans-serif;font-size:42px;font-weight:700;font-style:normal;line-height:50px;letter-spacing:0.5px;text-align:center;white-space:nowrap;text-shadow:2px 2px 0 rgb(0,0,0);-webkit-text-stroke:1px rgb(255,0,255);max-width:660px}\n    </style></head><body><div id="stack"><div id="cue">R40 SAME DOM SUBTITLE</div></div><script>`,
  `      @font-face{font-family:LilacSubtitle;src:local("Arial");font-display:block}\n      #stack{position:absolute;left:170px;top:340px;width:560px;height:130px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:0}\n      #cue{display:block;color:rgb(255,0,255);font-family:LilacSubtitle,Arial,sans-serif;font-size:42px;font-weight:700;font-style:normal;line-height:50px;letter-spacing:0.5px;text-align:center;white-space:normal;overflow-wrap:normal;word-break:normal;text-shadow:2px 2px 0 rgb(0,0,0);-webkit-text-stroke:1px rgb(255,0,255);max-width:520px}\n    </style></head><body><div id="stack"><div id="cue"><b>R40 SAME DOM SUBTITLE WRAPS</b> ON TWO LINES</div></div><script>`,
  'multiline focused DOM reference'
);

replaceOnce(
  `    if(!focusedBox||focusedBox.count<80)throw new Error(\`focused DOM subtitle capturePage pixels missing \${JSON.stringify(focusedBox)}\`);\n    const payload=await owner.webContents.executeJavaScript('window.__r40Payload()');\n    if(!payload?.active||payload?.cues?.length!==1)throw new Error(\`focused DOM payload invalid \${JSON.stringify(payload)}\`);`,
  `    if(!focusedBox||focusedBox.count<80)throw new Error(\`focused DOM subtitle capturePage pixels missing \${JSON.stringify(focusedBox)}\`);\n    if(Number(focusedBox.height||0)<70)throw new Error(\`focused DOM reference did not produce multiline geometry \${JSON.stringify(focusedBox)}\`);\n    const payload=await owner.webContents.executeJavaScript('window.__r40Payload()');\n    if(!payload?.active||payload?.cues?.length!==1)throw new Error(\`focused DOM payload invalid \${JSON.stringify(payload)}\`);\n    const customFontPath=path.join(process.env.WINDIR||'C:\\\\Windows','Fonts','arial.ttf');\n    if(!fs.existsSync(customFontPath))throw new Error(\`R40 custom-font runtime fixture missing \${customFontPath}\`);\n    payload.fontPath=customFontPath;`,
  'multiline and custom-font payload proof'
);

replaceOnce(
  `    await rival.loadURL('data:text/html,<html><body style="margin:0;background:rgb(32,180,64)"></body></html>');\n    const prePresenterFocus=await establishRivalFocus({owner,rival,addon,id,label:'owner blur before native presenter'});`,
  `    await rival.loadURL('data:text/html,<html><body style="margin:0;background:rgb(32,180,64)"></body></html>');\n\n    // Reproduce the real renderer/main focus-order race deliberately: an active\n    // payload arrives while BrowserWindow.isFocused() is still true. It must be\n    // deferred, then replay exactly once after a real rival BrowserWindow owns\n    // focus. This is not a retry loop and must not steal focus back from rival.\n    const deferredState=await controller.update(owner,payload);\n    if(deferredState?.visible!==false||deferredState?.deferredActive!==true||Number(deferredState?.deferredCount||0)<1){\n      throw new Error(\`R40 focused active payload was not deferred \${JSON.stringify(deferredState)}\`);\n    }\n    const raceBlur=await establishRivalFocus({owner,rival,addon,id,label:'deferred subtitle real owner blur'});\n    const raceReplay=await controller.reconcileDeferred(owner,'smoke-owner-blur');\n    if(raceReplay?.visible!==true||raceReplay?.replayed!==true||Number(raceReplay?.deferredReplayCount||0)<1){\n      throw new Error(\`R40 deferred subtitle was not replayed exactly from blur \${JSON.stringify(raceReplay)}\`);\n    }\n    if(owner.isFocused()||!rival.isFocused())throw new Error('R40 deferred replay stole BrowserWindow focus');\n    const raceOverlay=controller.window;\n    if(!raceOverlay||raceOverlay.isDestroyed())throw new Error('R40 deferred replay did not create overlay window');\n    await waitUntil(async()=>await raceOverlay.webContents.executeJavaScript("document.body.dataset.active==='1'&&document.body.dataset.fontReady==='1'&&document.body.dataset.fontCustom==='1'"),5000,'R40 deferred custom-font overlay ready');\n    console.log(\`R40_SUBTITLE_DEFERRED_REPLAY_RUNTIME_OK marker=R40_SUBTITLE_DEFERRED_REPLAY_RUNTIME_OK ownerFocused=\${raceBlur.ownerFocused?1:0} rivalFocused=\${raceBlur.rivalFocused?1:0} deferredCount=\${raceReplay.deferredCount} replayCount=\${raceReplay.deferredReplayCount} customFontReady=1\`);\n\n    // The native-only visibility fix must not let later subtitle mutations revive\n    // an explicitly hidden-to-tray/minimized owner. Exercise the same controller\n    // lifecycle hooks used by main.cjs, then prove owner-show is the only release.\n    controller.hide('owner-hidden');\n    const lifecycleBlocked=await controller.update(owner,payload);\n    if(lifecycleBlocked?.visible!==false||lifecycleBlocked?.ownerLifecycleSuppressed!==true||lifecycleBlocked?.ownerLifecycleReason!=='owner-hidden'){\n      throw new Error(\`R40 explicit owner hide did not suppress later active payload \${JSON.stringify(lifecycleBlocked)}\`);\n    }\n    controller.sync(owner,'owner-show');\n    const lifecycleResumed=await controller.update(owner,payload);\n    if(lifecycleResumed?.visible!==true||lifecycleResumed?.ownerLifecycleSuppressed===true){\n      throw new Error(\`R40 owner-show did not release lifecycle suppression \${JSON.stringify(lifecycleResumed)}\`);\n    }\n    console.log('R40_SUBTITLE_OWNER_LIFECYCLE_RUNTIME_OK hiddenPayloadBlocked=1 ownerShowRelease=1');\n\n    controller.hide('race-smoke-reset');\n    owner.focus();\n    await waitUntil(()=>owner.isFocused(),3000,'owner refocus after deferred-race proof');\n\n    const prePresenterFocus=await establishRivalFocus({owner,rival,addon,id,label:'owner blur before native presenter'});`,
  'deliberate focused-payload deferred replay and lifecycle runtime proof'
);

replaceOnce(
  `    await waitUntil(async()=>await overlayWin.webContents.executeJavaScript("document.body.dataset.active==='1'&&document.body.dataset.revision==='1'"),5000,'R40 overlay DOM active');`,
  `    await waitUntil(async()=>await overlayWin.webContents.executeJavaScript("document.body.dataset.active==='1'&&document.body.dataset.revision==='1'&&document.body.dataset.fontReady==='1'&&document.body.dataset.fontCustom==='1'"),5000,'R40 overlay DOM active with custom font ready');`,
  'custom-font-ready final overlay gate'
);

for (const marker of [
  'R40_SUBTITLE_DEFERRED_REPLAY_RUNTIME_OK',
  'R40_SUBTITLE_OWNER_LIFECYCLE_RUNTIME_OK',
  'focused DOM reference did not produce multiline geometry',
  "payload.fontPath=customFontPath",
  "document.body.dataset.fontReady==='1'",
  "document.body.dataset.fontCustom==='1'",
  "controller.reconcileDeferred(owner,'smoke-owner-blur')",
  "controller.hide('owner-hidden')",
  "controller.sync(owner,'owner-show')"
]) {
  if (!source.includes(marker)) throw new Error(`R40 subtitle coverage marker missing: ${marker}`);
}

fs.writeFileSync(target, source, 'utf8');
console.log('R40_SUBTITLE_RUNTIME_COVERAGE_HARDENING_OK race=focused-payload->real-blur->single-replay lifecycle=explicit-hide-blocked->show-release font=custom-ready multiline=natural-wrap nested-bold=1 geometry=strict');
