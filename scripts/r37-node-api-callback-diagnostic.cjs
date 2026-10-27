'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const originalBridge = path.join(root, 'electron', 'libmpv-shared-main.cjs');
const diagnosticBridge = path.join(root, 'electron', 'libmpv-shared-main.r37-nodeapi-diagnostic.cjs');
const e2eScript = path.join(root, 'scripts', 'r37-explicit-handoff-e2e-smoke.cjs');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}
function replaceRegexOnce(source, pattern, replacement, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) throw new Error(`${label}: expected exactly one semantic anchor, found ${matches.length}`);
  return source.replace(pattern, replacement);
}

if (!fs.existsSync(originalBridge)) throw new Error(`R37 bridge missing: ${originalBridge}`);
if (!fs.existsSync(e2eScript)) throw new Error(`R37 E2E smoke missing: ${e2eScript}`);

let source = fs.readFileSync(originalBridge, 'utf8').replace(/\r\n/g, '\n');
if (!source.includes('LILAC_R37_EXPLICIT_RENDERER_HANDOFF_ACK')) {
  throw new Error('R37 callback diagnostic requires the post-transform R37 bridge');
}

// The bridge factory signature has evolved across R31-R37. Diagnostic state is
// module-local, so anchor only on the stable CommonJS prologue rather than the
// factory parameter list.
source = replaceOnce(
  source,
  `'use strict';\n`,
  `'use strict';\n\nconst r37NodeApiCallbackDiagnostic = {\n  total: 0,\n  allReferencesReleased: 0,\n  updateTsfn: 0\n};\nfunction r37RecordNodeApiCallbackThrow(source, error) {\n  r37NodeApiCallbackDiagnostic.total += 1;\n  if (source === 'allReferencesReleased') r37NodeApiCallbackDiagnostic.allReferencesReleased += 1;\n  if (source === 'updateTsfn') r37NodeApiCallbackDiagnostic.updateTsfn += 1;\n  const detail = String(error?.stack || error).replace(/\\r?\\n/g, ' | ').slice(0, 4000);\n  console.error(\`R37_NODE_API_CALLBACK_THROW source=\${source} total=\${r37NodeApiCallbackDiagnostic.total} detail=\${detail}\`);\n  if (!process.exitCode) process.exitCode = 86;\n}\nprocess.once('exit', () => {\n  console.error(\`R37_NODE_API_CALLBACK_DIAGNOSTIC_SUMMARY total=\${r37NodeApiCallbackDiagnostic.total} allReferencesReleased=\${r37NodeApiCallbackDiagnostic.allReferencesReleased} updateTsfn=\${r37NodeApiCallbackDiagnostic.updateTsfn}\`);\n});\n`,
  'R37 diagnostic module prologue'
);

source = replaceRegexOnce(
  source,
  /allReferencesReleased\(\)\s*\{\s*releaseNativeFrame\(ownerPlayerId,\s*slotId,\s*frameId\);\s*\}/,
  `allReferencesReleased() {\n            try {\n              return releaseNativeFrame(ownerPlayerId, slotId, frameId);\n            } catch (error) {\n              r37RecordNodeApiCallbackThrow('allReferencesReleased', error);\n            }\n          }`,
  'R37 allReferencesReleased callback wrapper'
);

source = replaceRegexOnce(
  source,
  /addon\.setUpdateCallback\(playerId,\s*wakePumpFromNative\);/,
  `addon.setUpdateCallback(playerId, (...args) => {\n        try {\n          return wakePumpFromNative(...args);\n        } catch (error) {\n          r37RecordNodeApiCallbackThrow('updateTsfn', error);\n        }\n      });`,
  'R37 TSFN wake callback wrapper'
);

if (!source.includes("r37RecordNodeApiCallbackThrow('allReferencesReleased'")) {
  throw new Error('R37 allReferencesReleased diagnostic marker missing');
}
if (!source.includes("r37RecordNodeApiCallbackThrow('updateTsfn'")) {
  throw new Error('R37 update TSFN diagnostic marker missing');
}

fs.writeFileSync(diagnosticBridge, source, 'utf8');
const cleanupDiagnosticBridge = () => {
  try { fs.unlinkSync(diagnosticBridge); } catch {}
};
process.once('exit', cleanupDiagnosticBridge);

if (process.env.R37_NODE_API_DIAGNOSTIC_PREPARE_ONLY === '1') {
  console.log('R37_NODE_API_CALLBACK_DIAGNOSTIC_PREPARE_OK sources=allReferencesReleased,updateTsfn semanticAnchors=1,1 productBytes=unchanged');
  process.exit(0);
}

const originalResolved = require.resolve(originalBridge);
require(diagnosticBridge);
const diagnosticResolved = require.resolve(diagnosticBridge);
const diagnosticModule = require.cache[diagnosticResolved];
if (!diagnosticModule) throw new Error('R37 diagnostic bridge module did not enter require cache');
require.cache[originalResolved] = diagnosticModule;

console.log('R37_NODE_API_CALLBACK_DIAGNOSTIC_INSTALLED sources=allReferencesReleased,updateTsfn productBytes=unchanged forcedPolicy=off');
require(e2eScript);
