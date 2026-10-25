'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'scripts/r32-presenter-bounds-subtitle-fix.cjs');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const oldLine = "native = replaceSection(native, 'void R32PresentNativeFrame(Player* player, TextureSlot* slot, uint32_t width, uint32_t height) {', 'napi_value ConfigureNativePresenter(', presentReplacement, 'producer-present-only function');";
const newLine = "native = replaceSection(native, 'void R32PresentNativeFrame(Player* player, TextureSlot* slot, uint32_t width, uint32_t height) {', 'bool SetOption(Player* player, const char* key, const char* value, std::string* error) {', presentReplacement, 'producer-present-only function');";
const count = source.split(oldLine).length - 1;
if (count !== 1) throw new Error(`R32 presenter safety old boundary expected once, found ${count}`);
source = source.replace(oldLine, newLine);
if (!source.includes(newLine)) throw new Error('R32 presenter safety SetOption boundary missing after normalization');
fs.writeFileSync(target, source);
console.log('R32_PRESENTER_SAFETY_ANCHOR_OK end=SetOption preserves=SampleTexture+FindPlayer+existing-NAPI');
