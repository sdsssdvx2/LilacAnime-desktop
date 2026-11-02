# Lilac Companion (MVP)

External companion for **LilacAnime Desktop**. It does not patch Lilac files and does not replace Lilac's existing online subtitle/translation logic.

## Current scope

### Local subtitle automation

- Default subtitle library: `D:\Utility\자막`
- Supported local formats: `.smi`, `.sami`, `.srt`, `.ass`, `.ssa`, `.vtt`
- Reads the current anime/episode from Lilac through Chrome DevTools Protocol (CDP).
- Uses Lilac's own `titleVariants()` bridge first, so Korean/English/romaji title matching follows the same title-resolution path that Lilac already uses.
- Matches local files conservatively by title aliases + season + part + episode.
- A previously chosen Lilac `user` subtitle wins over automatic matching and is remembered in `%LOCALAPPDATA%\LilacCompanion\state.json`.
- If no high-confidence local match exists, Companion does nothing and Lilac keeps its normal online subtitle / translation flow.
- SRT/SMI/ASS are prepared outside Lilac and injected as a VTT/ASS Blob into the renderer; no file picker is required for a confident automatic match.

### Source diagnostics

The source scout currently supports the six Lilac providers:

- Linkkf
- 애니24 (`ohli24`)
- 링크애니 (`linkani`)
- AnimenoSub
- RE:Anime
- Miruro

It uses Lilac's own catalog/detail/episode/`prepareEpisodeStream()` bridge instead of duplicating provider site parsers.

`source-doctor` performs:

1. all-provider quick mapping/probe,
2. HLS master/variant inspection,
3. segment TTFB / throughput / failure measurement,
4. top-provider deep probe,
5. recommendation using **stability gate first, quality second**.

Automatic provider switching is intentionally **not enabled yet**. Runtime mapping/probe results need to be validated on real Lilac playback before the companion is allowed to change the selected provider.

## Runtime requirement

For full automation, Lilac must be started with a local CDP port, currently `9223`.

If `LILAC_EXE` is set, Companion can launch Lilac itself with:

```text
--remote-debugging-port=9223
```

Environment variables:

```text
LILAC_EXE=C:\path\to\LilacAnime.exe
LILAC_SUBTITLE_ROOT=D:\Utility\자막
LILAC_CDP_PORT=9223
```

The CDP endpoint is bound to the local machine by Chromium/Electron defaults; do not expose it to other machines.

If Lilac was already started normally, `doctor` / `source-doctor` cannot attach until Lilac is restarted with the debugging port.

## Commands

From `companion/` with Node.js 22+:

```text
npm test
npm run doctor
npm run source-doctor
npm start
```

- `doctor`: feature probe + current playback + title aliases + best local subtitle candidate.
- `source-doctor`: current episode, six-provider quick scan, top-provider deep scan, recommendation only.
- `npm start`: continuous local-subtitle watcher/auto-attach.

## Safety rules in the MVP

- Never modify Lilac application files.
- Never write to Lilac's own subtitle database.
- Never replace an already selected real local `user` subtitle automatically.
- Never auto-apply an ambiguous local subtitle.
- Never auto-switch video provider yet.
- If Companion cannot confidently help, fall back to Lilac unchanged.

## Next implementation steps

1. Windows Lilac executable auto-discovery and one-click launcher/tray EXE.
2. Real runtime validation of CDP access against the currently installed Lilac build.
3. Validate six-provider cross-mapping with representative shows, including the known RE:Anime-vs-Miruro buffering cases.
4. Add persistent static-quality cache and short-lived network-stability cache.
5. Add rolling look-ahead: current episode final probe, next episode deep prep, following episode quick prep.
6. Only after runtime evidence is clean, enable automatic source selection with manual override priority.
7. Add UI for ambiguous subtitle candidates and per-anime "forget all companion data".
