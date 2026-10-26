'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname, 'r33-owned-popup-visible-focus-smoke.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function once(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  source = source.replace(needle, replacement);
}

once("app.commandLine.appendSwitch('disable-renderer-backgrounding');\n", '', 'remove renderer backgrounding test override');
once("app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');\n", '', 'remove occluded-window test override');

once(
  "function statsRect(stats) {\n  return {\n    left: Number(stats?.screenLeft),\n    top: Number(stats?.screenTop),\n    width: Number(stats?.screenWidth),\n    height: Number(stats?.screenHeight)\n  };\n}\n",
  "function statsRect(stats) {\n  return {\n    left: Number(stats?.screenLeft),\n    top: Number(stats?.screenTop),\n    width: Number(stats?.screenWidth),\n    height: Number(stats?.screenHeight)\n  };\n}\n\nfunction assertCleanPresentStatus(stats, label) {\n  const occluded = Number(stats?.presentOccludedFrames || 0);\n  const other = Number(stats?.presentOtherStatusFrames || 0);\n  if (occluded !== 0 || other !== 0) {\n    throw new Error(`${label} saw non-S_OK native presents occluded=${occluded} other=${other} last=${stats?.lastPresentHr}`);\n  }\n}\n",
  'present-status assertion helper'
);

once(
  "    const afterBlock = addon.nativePresenterStats(id);\n    const presentedDelta = Number(afterBlock.presentedFrames || 0) - presentedBefore;",
  "    const afterBlock = addon.nativePresenterStats(id);\n    assertCleanPresentStatus(afterBlock, '900ms autonomous block');\n    const presentedDelta = Number(afterBlock.presentedFrames || 0) - presentedBefore;",
  'block present status gate'
);

once(
  "      const stats = addon.nativePresenterStats(id);\n      const capture = await capturePrimary();",
  "      const stats = addon.nativePresenterStats(id);\n      assertCleanPresentStatus(stats, `DWM sample ${i}`);\n      const capture = await capturePrimary();",
  'sample present status gate'
);

once(
  "    const afterMove = addon.nativePresenterStats(id);\n    if (Math.abs((Number(afterMove.screenLeft) - Number(beforeMove.screenLeft)) - 28) > 3 ||",
  "    const afterMove = addon.nativePresenterStats(id);\n    assertCleanPresentStatus(afterMove, 'owner move');\n    if (Math.abs((Number(afterMove.screenLeft) - Number(beforeMove.screenLeft)) - 28) > 3 ||",
  'move present status gate'
);

once(
  "    console.log(`R33_VISIBLE_FOCUS_SMOKE_OK mode=owned-popup ownerMatches=1 child=0 dwmRedSamples=${redSamples.length + 1} mainBlockMs=900 autonomousPresented=${presentedDelta} autonomousNativeOnly=${nativeOnlyDelta} moved=28x22 focusRecovery=hidden deviceMode=${created.deviceMode}`);",
  "    console.log(`R33_VISIBLE_FOCUS_SMOKE_OK mode=owned-popup ownerMatches=1 child=0 dwmRedSamples=${redSamples.length + 1} mainBlockMs=900 autonomousPresented=${presentedDelta} autonomousNativeOnly=${nativeOnlyDelta} presentOccluded=0 presentOther=0 backgroundOverrides=none moved=28x22 focusRecovery=hidden deviceMode=${created.deviceMode}`);",
  'strict smoke proof marker'
);

fs.writeFileSync(target, source);
console.log('R33_VISIBLE_SMOKE_HARDENING_OK backgroundOverrides=removed presentOccludedRequired=0 presentOtherRequired=0 productBackgroundThrottlingOnly=1');
