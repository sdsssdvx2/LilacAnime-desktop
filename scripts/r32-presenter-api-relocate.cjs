'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'native/libmpv-d3d11-bridge/player_addon.cc');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

const apiStartMarker = 'napi_value ConfigureNativePresenter(napi_env env, napi_callback_info info) {';
const releaseMarker = 'napi_value ReleaseFrame(napi_env env, napi_callback_info info) {';
const initMarker = 'napi_value Init(napi_env env, napi_value exports) {';
const findMarker = 'Player* FindPlayer(uint32_t id) {';
const sampleMarker = 'bool SampleTexture(Player* player, TextureSlot* slot, uint8_t* r, uint8_t* g, uint8_t* b, uint8_t* a, std::string* error) {';

const apiStart = source.indexOf(apiStartMarker);
const releaseAt = source.indexOf(releaseMarker, apiStart + apiStartMarker.length);
const initAtBefore = source.indexOf(initMarker);
if (apiStart < 0 || releaseAt <= apiStart || initAtBefore <= releaseAt) {
  throw new Error(`R32 presenter API relocation anchors invalid api=${apiStart} release=${releaseAt} init=${initAtBefore}`);
}

const apiBlock = source.slice(apiStart, releaseAt);
if (!apiBlock.includes('SetNativePresenterBounds') || !apiBlock.includes('NativePresenterStats')) {
  throw new Error('R32 presenter API block is incomplete before relocation');
}

source = source.slice(0, apiStart) + source.slice(releaseAt);
const initAt = source.indexOf(initMarker);
if (initAt < 0) throw new Error('R32 Init anchor disappeared during relocation');
source = source.slice(0, initAt) + apiBlock + source.slice(initAt);

const findAt = source.indexOf(findMarker);
const sampleAt = source.indexOf(sampleMarker);
const relocatedApiAt = source.indexOf(apiStartMarker);
const relocatedInitAt = source.indexOf(initMarker);
if (findAt < 0 || sampleAt < 0 || relocatedApiAt < 0 || relocatedInitAt < 0) {
  throw new Error('R32 relocated source ordering markers missing');
}
if (!(sampleAt < relocatedApiAt && findAt < relocatedApiAt && relocatedApiAt < relocatedInitAt)) {
  throw new Error(`R32 presenter API ordering invalid sample=${sampleAt} find=${findAt} api=${relocatedApiAt} init=${relocatedInitAt}`);
}
if (source.indexOf(apiStartMarker, relocatedApiAt + apiStartMarker.length) >= 0) {
  throw new Error('R32 presenter API duplicated during relocation');
}

fs.writeFileSync(target, source);
console.log(`R32_PRESENTER_API_RELOCATE_OK sample=${sampleAt} find=${findAt} api=${relocatedApiAt} init=${relocatedInitAt}`);
