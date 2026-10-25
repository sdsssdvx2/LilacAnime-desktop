'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '..', 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}
if (!source.includes('nativeRenderMs') || !source.includes('nextFramePresent')) throw new Error('GPU drain probe requires R3D + frameinfo baseline');

replaceOnce(
  '  ComPtr<ID3D11DeviceContext> context;\n',
  '  ComPtr<ID3D11DeviceContext> context;\n  ComPtr<ID3D11Query> gpuDrainQuery;\n',
  'Player GPU drain query');
replaceOnce(
  '    for (auto& slot : slots) slot.Reset();\n    context.Reset();\n',
  '    for (auto& slot : slots) slot.Reset();\n    gpuDrainQuery.Reset();\n    context.Reset();\n',
  'GPU drain query cleanup');
replaceOnce(
  'std::unordered_map<uint32_t, std::unique_ptr<Player>> gPlayers;\n',
  `std::unordered_map<uint32_t, std::unique_ptr<Player>> gPlayers;\n\nbool GpuDrainProbeEnabled() {\n  const char* value = std::getenv("LILAC_LIBMPV_TEST_GPU_DRAIN");\n  return value && value[0] == '1';\n}\n`,
  'GPU drain environment gate');

const anchor = '  Set(env, out, "nativeRenderMs", DoubleValue(env, nativeRenderMs));\n  if (rc < 0) {';
const replacement = `  Set(env, out, "nativeRenderMs", DoubleValue(env, nativeRenderMs));\n  const bool gpuDrainProbe = GpuDrainProbeEnabled();\n  Set(env, out, "gpuDrainProbe", BoolValue(env, gpuDrainProbe));\n  double gpuDrainWaitMs = 0;\n  uint32_t gpuDrainPolls = 0;\n  if (rc >= 0 && gpuDrainProbe) {\n    if (!player->gpuDrainQuery) {\n      D3D11_QUERY_DESC queryDesc{};\n      queryDesc.Query = D3D11_QUERY_EVENT;\n      queryDesc.MiscFlags = 0;\n      HRESULT queryHr = player->device->CreateQuery(&queryDesc, &player->gpuDrainQuery);\n      if (FAILED(queryHr)) {\n        Throw(env, "CreateQuery(D3D11_QUERY_EVENT) failed " + HrHex(queryHr));\n        return nullptr;\n      }\n    }\n    const auto drainStarted = std::chrono::steady_clock::now();\n    player->context->End(player->gpuDrainQuery.Get());\n    player->context->Flush();\n    BOOL completed = FALSE;\n    while (true) {\n      HRESULT dataHr = player->context->GetData(\n        player->gpuDrainQuery.Get(), &completed, sizeof(completed), D3D11_ASYNC_GETDATA_DONOTFLUSH);\n      gpuDrainPolls += 1;\n      if (dataHr == S_OK && completed) break;\n      if (FAILED(dataHr)) {\n        Throw(env, "GetData(D3D11_QUERY_EVENT) failed " + HrHex(dataHr));\n        return nullptr;\n      }\n      const double elapsed = std::chrono::duration<double, std::milli>(\n        std::chrono::steady_clock::now() - drainStarted).count();\n      if (elapsed > 5000.0) {\n        Throw(env, "D3D11 GPU drain timeout");\n        return nullptr;\n      }\n      if (gpuDrainPolls < 100) Sleep(0); else Sleep(1);\n    }\n    gpuDrainWaitMs = std::chrono::duration<double, std::milli>(\n      std::chrono::steady_clock::now() - drainStarted).count();\n  }\n  Set(env, out, "gpuDrainWaitMs", DoubleValue(env, gpuDrainWaitMs));\n  Set(env, out, "gpuDrainPolls", Uint32Value(env, gpuDrainPolls));\n  if (rc < 0) {`;
replaceOnce(anchor, replacement, 'post-render GPU drain timing');

for (const m of ['gpuDrainQuery','LILAC_LIBMPV_TEST_GPU_DRAIN','D3D11_QUERY_EVENT','gpuDrainWaitMs','gpuDrainPolls','D3D11_ASYNC_GETDATA_DONOTFLUSH']) {
  if (!source.includes(m)) throw new Error(`GPU drain marker missing: ${m}`);
}
fs.writeFileSync(target, source);
console.log('LIBMPV_R3D_GPU_DRAIN_PROBE_OK query=event wait=GetData-DONOTFLUSH timeoutMs=5000');
