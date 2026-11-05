# Lilac Companion 1.1.0

External companion for **LilacAnime Desktop**. It keeps official Lilac files untouched and attaches through the local Chrome DevTools Protocol (CDP) bridge.

## What 1.1.0 does

### Local subtitle automation

- Default subtitle library: `D:\Utility\자막`
- Supported formats: `.smi`, `.sami`, `.srt`, `.ass`, `.ssa`, `.vtt`
- Conservative title/season/episode matching using Lilac's own title/catalog resolution plus local folder structure.
- Remembers real user-selected local subtitles and reuses them safely.
- Rejects stale previous-episode user subtitles when a strong episode number disagrees.
- Converts SMI/SAMI to WebVTT while preserving `<br>`, physical line breaks and common SMI class variants.
- Reapplies local subtitles after a safe provider switch.
- If no high-confidence local match exists, Companion does nothing and Lilac keeps its normal online subtitle/translation flow.

State is stored outside Lilac in `%LOCALAPPDATA%\LilacCompanion\state.json`.

### Source diagnosis and safe automatic selection

The source scout supports all six Lilac providers:

- Linkkf
- 애니24 (`ohli24`)
- 링크애니 (`linkani`)
- AnimenoSub
- RE:Anime
- Miruro

The scout uses Lilac's own provider/catalog/episode/stream resolution instead of maintaining a second set of site parsers.

Diagnosis uses:

1. all-provider quick mapping/probe,
2. resolution, declared bitrate and codec-aware quality evidence,
3. HLS segment TTFB / throughput / failure measurement,
4. top-provider deep probe,
5. conservative visual-frame comparison only when metadata evidence is ambiguous,
6. stability gates before automatic switching.

Unknown resolution/bitrate stays unknown and is never treated as `0p` or `0 Mbps`.

Recent deep decisions are cached for 15 minutes, quick decisions for 2 minutes, provider mappings for 30 minutes and provider misses for 10 minutes. A cached winner can therefore be applied quickly when the same episode is reopened from a different provider, while network quality is still periodically re-evaluated rather than permanently pinned.

Automatic switches preserve the current playback position through Lilac's `resumeSeconds` / `resumeProgress` path. Manual provider changes made while an active scan is running are treated as a user override and are not fought by the scanner.

For Miruro streams that reject Node HTTP probes (for example Cloudflare/CDN HTTP 403), Companion first uses the fast Node probe, then falls back only when needed to a protected-HLS probe through Lilac's Chromium renderer. If the currently playing stream is the only reliable evidence, live playback metrics are used instead of falsely marking the source unavailable.

### Dynamic source discovery and source management

Lilac Companion reads the **video source controls in the running official Lilac renderer** over local CDP.
It compares the live source IDs and labels with a separate inventory on first connection and every 30
minutes while Companion is running. On its first successful discovery, it establishes a baseline;
on later checks, additions, removals, restorations and label changes appear in Companion's log.
Opening Companion after a Lilac update also runs this check. No scheduled runner or source-site
scraper is installed. If the Lilac UI cannot be read reliably, the saved inventory is preserved and
automatic source probing pauses rather than falsely declaring providers removed.

The separate inventory lives at `%LOCALAPPDATA%\LilacCompanion\source-registry.json`.
Existing subtitle preferences and the official Lilac installation are not changed.

From the Companion installation directory, use the portable EXE (or `node src/main.mjs` in source checkout):

```powershell
.\LilacCompanion.exe sources list
.\LilacCompanion.exe sources sync
.\LilacCompanion.exe sources focus reanime
.\LilacCompanion.exe sources normal miruro
.\LilacCompanion.exe sources off linkkf
.\LilacCompanion.exe sources reset linkkf
.\LilacCompanion.exe sources undo
.\LilacCompanion.exe source-doctor
```

- `list`: works offline and shows sources, presence, mode, last probe outcome and any cooldown.
- `sync`: rechecks the already-running Lilac through CDP **without launching or restarting Lilac**.
- `focus` / `normal` / `off`: intensive deep-scan priority, normal scan, or exclusion from probing and automatic selection.
- `reset`: restore the default mode for that source; `undo`: restore the previous manual change.
- `source-doctor`: perform the managed quality/stability scan against an episode already open in Lilac.

RE:Anime, Miruro and 애니24 start in focused mode; other detected sources default to normal.
All enabled sources receive a light quick scan. A focused source is preferred for detailed measurement
only when its quick quality evidence is reasonably comparable; a clearly superior ordinary source
is not displaced. Users' explicit source selection always takes precedence over automatic switching.

Sources missing from the live UI are retained as history, not erased. A failed anime match or
temporary site error is **not proof of a shutdown**. Three consecutive failed probes cause a
30-minute temporary cooldown; a successful probe clears it. A source selected manually in Lilac
is never forcibly changed just because it has been excluded from Companion diagnostics.
Newly discovered providers are tried through Lilac's existing generic provider API. If the
upstream API is incompatible, their probe reports failure instead of inventing a result or
automatically switching on weak evidence.

Optional inventory poll interval: `LILAC_SOURCE_DISCOVERY_MS=1800000` (minimum 60000 ms).
Changing source modes does not require changing, reinstalling, or rebuilding official Lilac.

### Resource policy

- Normal watch mode polls lightweight playback state about once per second.
- Source decisions are cached; full scans do not run continuously.
- Provider mapping is cached across episodes.
- Quick scans use bounded concurrency and deep scans are limited to the top providers.
- FFmpeg frame analysis is bounded by time/output limits and is used only for close quality comparisons.
- Subtitle filesystem changes are watched directly. When watching works, the full safety re-index defaults to once every 10 minutes; if watching is unavailable, it falls back to a 60-second safety scan.

## Windows installation

Use `LilacCompanion-Setup-1.1.0.exe`. The installer is per-user, needs no administrator rights, creates an uninstaller, and installs by default to:

```text
%LOCALAPPDATA%\Programs\LilacCompanion
```

A portable `LilacCompanion.exe` is included for users who prefer it.

The installer does not modify or replace LilacAnime files and does not delete Companion state when updating the executable.

Build artifacts are uploaded to GitHub Actions for CI inspection, and stable versioned binaries are also published as GitHub Release assets so the final installer is not dependent on temporary Actions artifact retention.

## Runtime and shutdown behavior

Companion initially launches the remembered/discovered `LilacAnime.exe` with local CDP port `9223` when needed. If Lilac is already running without that port, Companion does not kill or reset it automatically.

After Companion has successfully connected to Lilac once, it never automatically relaunches Lilac during that Companion session. If the Lilac process is still alive but CDP temporarily disconnects, Companion retries the CDP attachment without restarting Lilac. If the Lilac process has actually exited, Companion closes its subtitle watcher and CDP session, then terminates its own process. This means closing Lilac normally also closes the Companion terminal instead of reopening Lilac or leaving an idle terminal process behind.

Optional environment overrides:

```text
LILAC_EXE=C:\path\to\LilacAnime.exe
LILAC_SUBTITLE_ROOT=D:\Utility\자막
LILAC_CDP_PORT=9223
LILAC_SOURCE_AUTO=safe
LILAC_SOURCE_DECISION_CACHE_MS=900000
LILAC_SOURCE_QUICK_CACHE_MS=120000
LILAC_SOURCE_RETRY_MS=300000
LILAC_SOURCE_SWITCH_MAX_SECONDS=120
LILAC_SUBTITLE_SAFETY_SCAN_MS=600000
```

## Commands

From `companion/` with Node.js 22+:

```text
npm test
npm run doctor
npm run source-doctor
npm start
```

The packaged EXE uses `watch` by default. `LilacCompanion.exe version` prints the installed build version.

## Safety model

- Never patch official Lilac application files.
- Never reset/uninstall Lilac or clear its profile to recover Companion.
- Never auto-apply ambiguous local subtitles.
- Never replace an explicitly selected real local user subtitle with an uncertain match.
- Never auto-switch on weak/unknown quality evidence.
- Preserve playback position when Companion changes provider.
- Treat an in-scan manual provider change as a user override.
- Do not relaunch Lilac after a previously connected Lilac process has been closed.
- Fall back to normal Lilac behavior when Companion cannot establish high-confidence evidence.

## Validation gates

The branch CI covers Windows and Ubuntu unit/syntax tests, including the lifecycle policy for initial launch, transient reattach and user shutdown. The Windows workflow builds and runs the portable EXE, builds the installer, performs a silent install into a temporary directory, runs the installed EXE, runs the generated uninstaller and verifies removal. Stable binaries are then published to a versioned GitHub Release. A separate integration workflow launches the latest official Lilac build and probes the CDP bridge, playback-entry identity, source-switch resume context and protected-HLS Chromium fallback.
