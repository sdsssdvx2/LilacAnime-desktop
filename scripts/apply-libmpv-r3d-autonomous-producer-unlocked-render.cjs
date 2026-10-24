'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, '..', 'native', 'libmpv-d3d11-bridge', 'player_addon.cc');
let s = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(needle, replacement, label) {
  const count = s.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  s = s.replace(needle, replacement);
}

if (!s.includes('StartAutonomousProbeWorker') || !s.includes('autonomousStop.store(true, std::memory_order_release)')) {
  throw new Error('unlocked-render transform requires autonomous probe + stopfix-v2');
}

const oldBlock = `        std::lock_guard<std::mutex> lock(player->autonomousMutex);\n        TextureSlot* slot = nullptr;\n        uint32_t slotId = 0;\n        for (uint32_t i = 0; i < player->slots.size(); i += 1) {\n          if (!player->slots[i].inFlight) {\n            slot = &player->slots[i];\n            slotId = i;\n            break;\n          }\n        }\n        if (!slot) {\n          player->autonomousBackpressure += 1;\n          break;\n        }\n\n        std::string error;\n        const auto textureStarted = std::chrono::steady_clock::now();\n        const bool textureReady = EnsureTexture(\n          player, slot, player->autonomousWidth, player->autonomousHeight, &error);\n        const double textureMs = std::chrono::duration<double, std::milli>(\n          std::chrono::steady_clock::now() - textureStarted).count();\n        player->autonomousTextureTotalMs += textureMs;\n        player->autonomousTextureMaxMs = std::max(player->autonomousTextureMaxMs, textureMs);\n        if (!textureReady) {\n          player->lastError = error;\n          break;\n        }\n\n        mpv_d3d11_fbo fbo{};\n        fbo.tex = slot->texture.Get();\n        int blockForTargetTime = 0;\n        mpv_render_param params[] = {\n          {MPV_RENDER_PARAM_D3D11_FBO, &fbo},\n          {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &blockForTargetTime},\n          {MPV_RENDER_PARAM_INVALID, nullptr}\n        };\n        const auto renderStarted = std::chrono::steady_clock::now();\n        const int rc = gMpv.render_context_render(player->render, params);\n        const double renderMs = std::chrono::duration<double, std::milli>(\n          std::chrono::steady_clock::now() - renderStarted).count();\n        player->autonomousRenderCalls += 1;\n        player->autonomousRenderTotalMs += renderMs;\n        player->autonomousRenderMaxMs = std::max(player->autonomousRenderMaxMs, renderMs);\n        if (rc < 0) {\n          player->lastError = MpvError(rc);\n          break;\n        }\n\n        slot->inFlight = true;\n        slot->frameId = player->nextFrameId++;\n        player->renderedFrames += 1;\n        const auto now = std::chrono::steady_clock::now().time_since_epoch();\n        const double timestampUs = static_cast<double>(\n          std::chrono::duration_cast<std::chrono::microseconds>(now).count());\n        player->autonomousReady.push_back({\n          slotId, slot->frameId, player->autonomousWidth, player->autonomousHeight,\n          timestampUs, updateMs, textureMs, renderMs\n        });\n        player->autonomousProducedFrames += 1;`;

const newBlock = `        TextureSlot* slot = nullptr;\n        uint32_t slotId = 0;\n        uint64_t reservedFrameId = 0;\n        uint32_t renderWidth = 0;\n        uint32_t renderHeight = 0;\n        double textureMs = 0.0;\n        {\n          // Reserve one slot under the producer mutex, then release the mutex\n          // before the potentially slow libmpv/D3D11 render call. JS may pop,\n          // release and read producer stats while this render is in progress.\n          std::lock_guard<std::mutex> lock(player->autonomousMutex);\n          for (uint32_t i = 0; i < player->slots.size(); i += 1) {\n            if (!player->slots[i].inFlight) {\n              slot = &player->slots[i];\n              slotId = i;\n              break;\n            }\n          }\n          if (!slot) {\n            player->autonomousBackpressure += 1;\n            break;\n          }\n          renderWidth = player->autonomousWidth;\n          renderHeight = player->autonomousHeight;\n          std::string error;\n          const auto textureStarted = std::chrono::steady_clock::now();\n          const bool textureReady = EnsureTexture(player, slot, renderWidth, renderHeight, &error);\n          textureMs = std::chrono::duration<double, std::milli>(\n            std::chrono::steady_clock::now() - textureStarted).count();\n          player->autonomousTextureTotalMs += textureMs;\n          player->autonomousTextureMaxMs = std::max(player->autonomousTextureMaxMs, textureMs);\n          if (!textureReady) {\n            player->lastError = error;\n            break;\n          }\n          reservedFrameId = player->nextFrameId++;\n          slot->inFlight = true;\n          slot->frameId = reservedFrameId;\n        }\n\n        mpv_d3d11_fbo fbo{};\n        fbo.tex = slot->texture.Get();\n        int blockForTargetTime = 0;\n        mpv_render_param params[] = {\n          {MPV_RENDER_PARAM_D3D11_FBO, &fbo},\n          {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &blockForTargetTime},\n          {MPV_RENDER_PARAM_INVALID, nullptr}\n        };\n        const auto renderStarted = std::chrono::steady_clock::now();\n        const int rc = gMpv.render_context_render(player->render, params);\n        const double renderMs = std::chrono::duration<double, std::milli>(\n          std::chrono::steady_clock::now() - renderStarted).count();\n\n        {\n          std::lock_guard<std::mutex> lock(player->autonomousMutex);\n          player->autonomousRenderCalls += 1;\n          player->autonomousRenderTotalMs += renderMs;\n          player->autonomousRenderMaxMs = std::max(player->autonomousRenderMaxMs, renderMs);\n          if (rc < 0 || player->autonomousStop.load(std::memory_order_acquire)) {\n            if (slot->inFlight && slot->frameId == reservedFrameId) slot->inFlight = false;\n            if (rc < 0) player->lastError = MpvError(rc);\n            player->autonomousCv.notify_one();\n            break;\n          }\n          player->renderedFrames += 1;\n          const auto now = std::chrono::steady_clock::now().time_since_epoch();\n          const double timestampUs = static_cast<double>(\n            std::chrono::duration_cast<std::chrono::microseconds>(now).count());\n          player->autonomousReady.push_back({\n            slotId, reservedFrameId, renderWidth, renderHeight,\n            timestampUs, updateMs, textureMs, renderMs\n          });\n          player->autonomousProducedFrames += 1;\n        }`;

replaceOnce(oldBlock, newBlock, 'move render outside producer mutex');

for (const marker of [
  'before the potentially slow libmpv/D3D11 render call',
  'reservedFrameId = player->nextFrameId++',
  'slot->inFlight = true',
  'gMpv.render_context_render(player->render, params)',
  'slot->frameId == reservedFrameId'
]) if (!s.includes(marker)) throw new Error(`unlocked-render marker missing: ${marker}`);

const renderIndex = s.indexOf('const int rc = gMpv.render_context_render(player->render, params);', s.indexOf('StartAutonomousProbeWorker'));
const precedingLock = s.lastIndexOf('std::lock_guard<std::mutex> lock(player->autonomousMutex);', renderIndex);
const closingBeforeRender = s.lastIndexOf('        }\n\n        mpv_d3d11_fbo fbo{};', renderIndex);
if (renderIndex < 0 || precedingLock < 0 || closingBeforeRender < precedingLock) {
  throw new Error('failed to prove producer mutex is released before render');
}

fs.writeFileSync(target, s);
console.log('LIBMPV_R3D_AUTONOMOUS_UNLOCKED_RENDER_OK mutex=reserve+queue render=outside jsDrain=independent');
