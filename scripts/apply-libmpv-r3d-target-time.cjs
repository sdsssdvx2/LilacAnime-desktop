'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '..', 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

if (!source.includes('RenderWorkerLoop') || !source.includes('StartRenderWorker')) {
  throw new Error('R3D target-time pacing requires native render worker first');
}

replaceOnce(
  `  uint32_t renderTargetWidth = 0;\n  uint32_t renderTargetHeight = 0;\n  std::deque<uint32_t> readySlots;`,
  `  uint32_t renderTargetWidth = 0;\n  uint32_t renderTargetHeight = 0;\n  bool renderWorkerBlockForTargetTime = true;\n  std::deque<uint32_t> readySlots;`,
  'worker target-time state');

replaceOnce(
  `    mpv_d3d11_fbo fbo{};\n    fbo.tex = slot->texture.Get();\n    int blockForTargetTime = 0;`,
  `    mpv_d3d11_fbo fbo{};\n    fbo.tex = slot->texture.Get();\n    int blockForTargetTime = player->renderWorkerBlockForTargetTime ? 1 : 0;`,
  'mpv target-time pacing in worker');

replaceOnce(
  `  {\n    std::lock_guard<std::mutex> workerLock(player->renderWorkerMutex);\n    player->renderTargetWidth = width;\n    player->renderTargetHeight = height;\n    player->readySlots.clear();`,
  `  {\n    std::lock_guard<std::mutex> workerLock(player->renderWorkerMutex);\n    char blockTargetEnv[8]{};\n    const DWORD blockTargetLength = GetEnvironmentVariableA(\"LILAC_LIBMPV_WORKER_BLOCK_TARGET\", blockTargetEnv, static_cast<DWORD>(sizeof(blockTargetEnv)));\n    player->renderWorkerBlockForTargetTime = !(blockTargetLength > 0 && std::string(blockTargetEnv) == \"0\");\n    player->renderTargetWidth = width;\n    player->renderTargetHeight = height;\n    player->readySlots.clear();`,
  'target-time env override at worker start');

replaceOnce(
  `  Set(env, out, \"renderWorkerReadyFrames\", Uint32Value(env, static_cast<uint32_t>(ready)));\n  Set(env, out, \"renderWorkerWakeSignals\",`,
  `  Set(env, out, \"renderWorkerReadyFrames\", Uint32Value(env, static_cast<uint32_t>(ready)));\n  Set(env, out, \"renderWorkerBlockForTargetTime\", BoolValue(env, player->renderWorkerBlockForTargetTime));\n  Set(env, out, \"renderWorkerWakeSignals\",`,
  'target-time diagnostic');

for (const marker of [
  'renderWorkerBlockForTargetTime = true',
  'LILAC_LIBMPV_WORKER_BLOCK_TARGET',
  'player->renderWorkerBlockForTargetTime ? 1 : 0',
  '"renderWorkerBlockForTargetTime"'
]) if (!source.includes(marker)) throw new Error(`R3D target-time marker missing: ${marker}`);

fs.writeFileSync(target, source);
console.log('LIBMPV_R3D_TARGET_TIME_OK default=mpv-paced override=LILAC_LIBMPV_WORKER_BLOCK_TARGET=0');
