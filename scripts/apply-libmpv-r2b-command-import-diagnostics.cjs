'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const found = source.split(needle).length - 1;
  if (found !== 1) throw new Error(`${label}: expected exactly one anchor, found ${found}`);
  return source.replace(needle, replacement);
}

let bridge = read('electron/libmpv-shared-main.cjs');

bridge = replaceOnce(
  bridge,
  `    releaseLatencyTotalMs: 0,\n    releaseLatencyMaxMs: 0,\n    lastReleaseLatencyMs: 0\n  };`,
  `    releaseLatencyTotalMs: 0,\n    releaseLatencyMaxMs: 0,\n    lastReleaseLatencyMs: 0,\n    commandFailures: 0,\n    lastCommandError: null,\n    lastImportError: null,\n    lastSendError: null\n  };`,
  'diagnostic error metrics'
);

bridge = replaceOnce(
  bridge,
  `  function pendingKey(ownerPlayerId, slotId, frameId) {\n    return \`${'${ownerPlayerId}:${slotId}:${frameId}'}\`;\n  }`,
  `  function safeBridgeError(error) {\n    return String(error?.message || error || 'unknown')\n      .replace(/https?:\\/\\/[^\\s\"']+/gi, '[url]')\n      .replace(/[A-Za-z]:\\\\[^\\s\"']+/g, '[path]')\n      .replace(/\\\\\\.\\pipe\\[^\\s\"']+/gi, '[pipe]')\n      .slice(0, 180);\n  }\n\n  function pendingKey(ownerPlayerId, slotId, frameId) {\n    return \`${'${ownerPlayerId}:${slotId}:${frameId}'}\`;\n  }`,
  'safe bridge error helper'
);

bridge = replaceOnce(
  bridge,
  `      } catch (error) {\n        metrics.importFailures += 1;\n        lastError = \`shared texture import failed: ${'${String(error?.message || error).slice(0, 180)}'}\`;\n        releaseNativeFrame(ownerPlayerId, slotId, frameId);\n        return;\n      }`,
  `      } catch (error) {\n        metrics.importFailures += 1;\n        metrics.lastImportError = safeBridgeError(error);\n        lastError = \`shared texture import failed: ${'${metrics.lastImportError}'}\`;\n        releaseNativeFrame(ownerPlayerId, slotId, frameId);\n        return;\n      }`,
  'preserve import failure reason'
);

bridge = replaceOnce(
  bridge,
  `      } catch (error) {\n        metrics.sendFailures += 1;\n        lastError = \`shared texture send failed: ${'${String(error?.message || error).slice(0, 180)}'}\`;\n      } finally {`,
  `      } catch (error) {\n        metrics.sendFailures += 1;\n        metrics.lastSendError = safeBridgeError(error);\n        lastError = \`shared texture send failed: ${'${metrics.lastSendError}'}\`;\n      } finally {`,
  'preserve send failure reason'
);

bridge = replaceOnce(
  bridge,
  `  function command(value) {\n    if (!active || playerId == null || !addon) return { ok: false, error: 'inactive' };\n    if (!Array.isArray(value) || !value.length) return { ok: false, error: 'invalid-command' };\n    const commandArray = value.slice(0, 32).map(item => String(item));\n    addon.command(playerId, commandArray);\n    return { ok: true };\n  }`,
  `  function command(value) {\n    if (!active || playerId == null || !addon) return { ok: false, error: 'inactive' };\n    if (!Array.isArray(value) || !value.length) return { ok: false, error: 'invalid-command' };\n\n    const raw = value.slice(0, 32);\n    const originalName = String(raw[0] || '');\n    let safeCommandName = originalName.slice(0, 48);\n    let safeProperty = null;\n    let commandArray;\n\n    // mpv_command() accepts input.conf commands. set_property is a JSON-IPC\n    // extension and therefore returned MPV_ERROR_INVALID_PARAMETER when we sent\n    // it through the C string command API. Normalize property writes to the\n    // documented input command set <name> <value> and serialize booleans as\n    // mpv's canonical yes/no strings.\n    if (originalName === 'set_property' || originalName === 'set_property_string') {\n      if (raw.length < 3) return { ok: false, error: 'invalid-property-command' };\n      safeCommandName = 'set';\n      safeProperty = String(raw[1] || '').slice(0, 64);\n      const rawValue = raw[2];\n      const encodedValue = typeof rawValue === 'boolean' ? (rawValue ? 'yes' : 'no') : String(rawValue);\n      commandArray = ['set', safeProperty, encodedValue];\n    } else {\n      commandArray = raw.map(item => String(item));\n      if (safeCommandName === 'set' && commandArray.length > 1) safeProperty = String(commandArray[1]).slice(0, 64);\n    }\n\n    try {\n      addon.command(playerId, commandArray);\n      return { ok: true };\n    } catch (error) {\n      metrics.commandFailures += 1;\n      metrics.lastCommandError = {\n        command: safeCommandName,\n        property: safeProperty,\n        error: safeBridgeError(error)\n      };\n      return { ok: false, error: 'mpv-command-failed', command: safeCommandName, property: safeProperty };\n    }\n  }`,
  'mpv property command normalization'
);

bridge = replaceOnce(
  bridge,
  `      receiver: { ...receiverStats },\n      lastError,\n      ...(lastState || {})\n    };`,
  `      receiver: { ...receiverStats },\n      ...(lastState || {}),\n      bridgeLastError: lastError,\n      lastError: lastError || lastState?.lastError || null\n    };`,
  'bridge error precedence'
);

write('electron/libmpv-shared-main.cjs', bridge);

const out = read('electron/libmpv-shared-main.cjs');
for (const marker of [
  'commandFailures',
  'lastCommandError',
  'lastImportError',
  'lastSendError',
  "originalName === 'set_property'",
  "commandArray = ['set', safeProperty, encodedValue]",
  'bridgeLastError: lastError'
]) {
  if (!out.includes(marker)) throw new Error(`R2B marker missing: ${marker}`);
}

console.log('LIBMPV_R2B_COMMAND_IMPORT_DIAGNOSTICS_OK');
