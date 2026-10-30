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

if (source.includes('R40_SUBTITLE_POST_PRESENTER_FOCUS_PROOF')) {
  throw new Error('R40 subtitle runtime focus hardening already applied');
}

const twoPaints = `async function twoPaints(win) {\n  if (!win || win.isDestroyed()) throw new Error('twoPaints requires live BrowserWindow');\n  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');\n}\n`;
const focusHelper = `${twoPaints}\nasync function establishRivalFocus({ owner, rival, addon, id, label, requirePresenterVisible = false }) {\n  if (!owner || owner.isDestroyed() || !rival || rival.isDestroyed()) throw new Error(\`${'${label}'} requires live owner+rival windows\`);\n  rival.show();\n  try { rival.moveTop(); } catch {}\n  rival.focus();\n  return waitUntil(() => {\n    const presenter = id != null ? addon.nativePresenterStats(id) : null;\n    const ownerFocused = owner.isFocused();\n    const rivalFocused = rival.isFocused();\n    const presenterVisible = presenter?.windowVisible === true;\n    if (ownerFocused || !rivalFocused || (requirePresenterVisible && !presenterVisible)) return null;\n    return {\n      ownerFocused,\n      rivalFocused,\n      presenterVisible,\n      presentedFrames: Number(presenter?.presentedFrames || 0),\n      requestedVisible: presenter?.requestedVisible === true\n    };\n  }, 4000, label);\n}\n`;
replaceOnce(twoPaints, focusHelper, 'insert exact rival-focus proof helper');

replaceOnce(
  `    rival.show();rival.focus();\n    await waitUntil(()=>!owner.isFocused()&&rival.isFocused(),3000,'owner blur');\n    syncBounds();addon.setNativePresenterVisible(id,true);`,
  `    const prePresenterFocus=await establishRivalFocus({owner,rival,addon,id,label:'owner blur before native presenter'});\n    console.log(\`R40_SUBTITLE_PRE_PRESENTER_FOCUS_PROOF ownerFocused=\${prePresenterFocus.ownerFocused?1:0} rivalFocused=\${prePresenterFocus.rivalFocused?1:0} presenterVisible=\${prePresenterFocus.presenterVisible?1:0}\`);\n    syncBounds();addon.setNativePresenterVisible(id,true);`,
  'replace initial blur proof'
);

replaceOnce(
  `    await waitUntil(()=>{const s=addon.nativePresenterStats(id);return s?.windowVisible===true&&Number(s?.presentedFrames||0)>=4?s:null},6000,'R33 native popup visible');\n\n    const overlayState=await controller.update(owner,payload);`,
  `    await waitUntil(()=>{const s=addon.nativePresenterStats(id);return s?.windowVisible===true&&Number(s?.presentedFrames||0)>=4?s:null},6000,'R33 native popup visible');\n\n    // Showing the protected R33 WS_EX_NOACTIVATE presenter must not be assumed to\n    // preserve Electron focus state on every hosted Windows runner. Re-establish\n    // and prove a real rival BrowserWindow focus after the native popup is already\n    // visible/presenting. This is stricter than the old smoke: overlay activation\n    // is attempted only while owner blur, rival focus, and native popup visibility\n    // are simultaneously true.\n    const focusBeforeReproof={\n      ownerFocused:owner.isFocused(),\n      rivalFocused:rival.isFocused(),\n      presenter:addon.nativePresenterStats(id)\n    };\n    const postPresenterFocus=await establishRivalFocus({\n      owner,rival,addon,id,label:'post-presenter real BrowserWindow blur',requirePresenterVisible:true\n    });\n    const presenterAtOverlay=addon.nativePresenterStats(id);\n    if(owner.isFocused()||!rival.isFocused()||presenterAtOverlay?.windowVisible!==true||Number(presenterAtOverlay?.presentedFrames||0)<4){\n      throw new Error(\`R40 exact overlay activation precondition lost ownerFocused=\${owner.isFocused()} rivalFocused=\${rival.isFocused()} presenter=\${JSON.stringify(presenterAtOverlay)}\`);\n    }\n    console.log(\`R40_SUBTITLE_POST_PRESENTER_FOCUS_PROOF marker=R40_SUBTITLE_POST_PRESENTER_FOCUS_PROOF beforeOwnerFocused=\${focusBeforeReproof.ownerFocused?1:0} beforeRivalFocused=\${focusBeforeReproof.rivalFocused?1:0} afterOwnerFocused=\${postPresenterFocus.ownerFocused?1:0} afterRivalFocused=\${postPresenterFocus.rivalFocused?1:0} presenterVisible=\${postPresenterFocus.presenterVisible?1:0} presentedFrames=\${postPresenterFocus.presentedFrames}\`);\n\n    const overlayState=await controller.update(owner,payload);`,
  'prove exact post-presenter blur before overlay activation'
);

for (const marker of [
  'async function establishRivalFocus',
  'R40_SUBTITLE_PRE_PRESENTER_FOCUS_PROOF',
  'R40_SUBTITLE_POST_PRESENTER_FOCUS_PROOF',
  "requirePresenterVisible:true",
  'R40 exact overlay activation precondition lost'
]) {
  if (!source.includes(marker)) throw new Error(`R40 subtitle focus hardening marker missing: ${marker}`);
}

fs.writeFileSync(target, source, 'utf8');
console.log('R40_SUBTITLE_RUNTIME_FOCUS_HARDENING_OK blur=real-rival-before+after-presenter presenter=visible-at-overlay-activation controller=unchanged');
