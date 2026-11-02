export class LilacBridge {
  constructor(session) {
    this.session = session;
  }

  async features() {
    return this.session.evaluate(`(() => ({
      lilac: Boolean(window.lilac),
      titleVariants: typeof window.lilac?.titleVariants === 'function',
      resolveTitles: typeof window.lilac?.resolveTitles === 'function',
      catalogKoreanSearch: typeof window.lilac?.catalogKoreanSearch === 'function',
      providerCatalog: typeof window.lilac?.providerCatalog === 'function',
      providerDetail: typeof window.lilac?.providerDetail === 'function',
      prepareEpisodeStream: typeof window.lilac?.prepareEpisodeStream === 'function',
      linkkfSearch: typeof window.lilac?.linkkfSearch === 'function',
      linkkfEpisodes: typeof window.lilac?.linkkfEpisodes === 'function',
      attachSubtitle: typeof attachSubtitle === 'function',
      playbackContext: typeof currentPlaybackContext !== 'undefined',
      preferAiSubtitle: typeof preferAiSubtitle === 'function',
      resolveIntoPlayer: typeof resolveIntoPlayer === 'function'
    }))()`);
  }

  async waitUntilReady({ timeoutMs = 20000, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.features();
        if (last?.lilac && last?.attachSubtitle && last?.playbackContext) return last;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Lilac renderer did not finish loading (features=${JSON.stringify(last || {})})`);
  }

  async playbackContext() {
    return this.session.evaluate(`(() => {
      if (typeof currentPlaybackContext === 'undefined') return null;
      const c = currentPlaybackContext || {};
      const a = c.anime || {};
      const e = c.episode || {};
      const s = c.stream || {};
      const sub = typeof currentSubtitle !== 'undefined' && currentSubtitle ? currentSubtitle : {};
      const seriesEpisodes = Array.isArray(c.seriesEpisodes) ? c.seriesEpisodes : [];
      const playbackSessionId = Number(typeof playbackRequestId !== 'undefined' ? playbackRequestId : 0) || 0;
      const video = document.querySelector('#video');
      const playerTitle = String(document.querySelector('#playerTitle')?.textContent || '').trim();
      const activePlayer = Boolean(document.querySelector('#playerView')?.classList.contains('active') || document.body?.classList.contains('player-mode'));
      const titleParts = playerTitle.split('·').map(v => v.trim()).filter(Boolean);
      const titleFromDom = titleParts.length > 1 ? titleParts.slice(0, -1).join(' · ') : playerTitle;
      const epText = [e.number, e.name, e.title, titleParts.at(-1)].filter(Boolean).join(' ');
      const epMatch = epText.match(/([0-9]+(?:[.][0-9]+)?)[ ]*(?:화|회|$)/i);
      const episodeNumber = c.resolving ? null : (Number(e.number || epMatch?.[1] || 0) || null);
      const provider = e.provider || a.provider || String(localStorage.getItem('contentSource') || '');
      const fallbackTitle = a.title || a.title_english || a.romaji || c.subtitleTitle || titleFromDom || '';
      const hasPlaybackIdentity = Boolean((a.title || a.title_english || a.romaji || c.subtitleTitle || titleFromDom) && episodeNumber);
      if (!hasPlaybackIdentity && !activePlayer) return null;

      let quality = {};
      try { quality = typeof video?.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : {}; } catch {}
      let bufferedAhead = 0;
      try {
        if (video && video.buffered && video.buffered.length) {
          const now = Number(video.currentTime || 0);
          for (let i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= now && video.buffered.end(i) >= now) { bufferedAhead = Math.max(0, video.buffered.end(i) - now); break; }
          }
        }
      } catch {}
      let currentSrc = '';
      try { currentSrc = String(video?.currentSrc || video?.src || ''); } catch {}
      const compactSeriesEpisodes = seriesEpisodes.slice(0, 300).map(item => ({
        number: item?.number ?? null,
        name: item?.name || '',
        title: item?.title || '',
        special: Boolean(item?.special),
        kind: item?.kind || item?.type || ''
      }));
      return {
        anime: {
          provider: a.provider || provider, id: a.id ?? null, mal_id: a.mal_id ?? null,
          anilistId: a.anilistId ?? null, malId: a.malId ?? null,
          title: a.title || fallbackTitle, title_english: a.title_english || '', title_japanese: a.title_japanese || '',
          romaji: a.romaji || '', synonyms: a.synonyms || '', season: a.season || '', year: a.year || '', type: a.type || '',
          companionSeriesEpisodes: compactSeriesEpisodes
        },
        episode: {
          provider, id: e.id ?? null, number: episodeNumber,
          name: e.name || titleParts.at(-1) || '', title: e.title || '', url: e.url || '', animeId: e.animeId ?? null,
          postId: e.postId ?? null, token: e.token ?? null, slug: e.slug || '', resolveKind: e.resolveKind || '',
          kind: e.kind || '', type: e.type || ''
        },
        seriesEpisodes: compactSeriesEpisodes,
        stream: { url: s.url || c.currentUrl || currentSrc || '', currentSrc, server: s.server || '', kind: s.kind || '', headers: s.headers || null, referer: s.referer || '' },
        subtitle: { source: sub.source || '', path: sub.path || '', label: sub.label || '', companion: Boolean(sub.companion) },
        playing: Boolean(activePlayer && video),
        activePlayer,
        resolving: Boolean(c.resolving),
        playbackSessionId,
        playerTitle,
        currentTime: Number(video?.currentTime || 0),
        playback: {
          width: Number(video?.videoWidth || 0) || null,
          height: Number(video?.videoHeight || 0) || null,
          duration: Number.isFinite(Number(video?.duration)) ? Number(video.duration) : null,
          readyState: Number(video?.readyState || 0),
          networkState: Number(video?.networkState || 0),
          bufferedAhead,
          droppedVideoFrames: Number(quality?.droppedVideoFrames || 0),
          totalVideoFrames: Number(quality?.totalVideoFrames || 0)
        }
      };
    })()`);
  }

  async titleVariants(query) {
    const value = JSON.stringify(String(query || ''));
    return this.session.evaluate(`(async () => {
      if (typeof window.lilac?.titleVariants !== 'function') return [];
      const result = await window.lilac.titleVariants(${value});
      return Array.isArray(result) ? result : [];
    })()`, { timeoutMs: 8000 });
  }

  async resolveTitles(items = []) {
    const payload = JSON.stringify((Array.isArray(items) ? items : []).slice(0, 60));
    return this.session.evaluate(`(async () => {
      if (typeof window.lilac?.resolveTitles !== 'function') return [];
      const result = await window.lilac.resolveTitles(${payload});
      return Array.isArray(result) ? result : [];
    })()`, { timeoutMs: 12000 });
  }

  async searchProvider(provider, query, { timeoutMs = 12000 } = {}) {
    const p = JSON.stringify(String(provider || ''));
    const q = JSON.stringify(String(query || ''));
    return this.session.evaluate(`(async () => {
      const provider = ${p}, query = ${q};
      const list = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : Array.isArray(value?.results) ? value.results : Array.isArray(value?.items) ? value.items : [];
      if (provider === 'linkkf' && typeof window.lilac?.linkkfSearch === 'function') return list(await window.lilac.linkkfSearch(query));
      if (typeof window.lilac?.catalogKoreanSearch === 'function') {
        const found = list(await window.lilac.catalogKoreanSearch(provider, query));
        if (found.length) return found;
      }
      if (typeof window.lilac?.providerCatalog === 'function') return list(await window.lilac.providerCatalog(provider, query, 0, ''));
      return [];
    })()`, { timeoutMs });
  }

  async providerEpisodes(provider, anime) {
    const payload = JSON.stringify({ provider: String(provider || ''), anime });
    return this.session.evaluate(`(async () => {
      const { provider, anime } = ${payload};
      const list = value => Array.isArray(value) ? value : Array.isArray(value?.episodes) ? value.episodes : Array.isArray(value?.data?.episodes) ? value.data.episodes : Array.isArray(value?.data) ? value.data : [];
      if (provider === 'linkkf') {
        if (typeof window.lilac?.linkkfEpisodes !== 'function') return [];
        const servers = list(await window.lilac.linkkfEpisodes(anime.id || anime.postId));
        const flattened = [];
        for (const server of servers) {
          const episodes = Array.isArray(server?.episodes) ? server.episodes : [];
          for (const episode of episodes) flattened.push({ ...episode, __companionServer: server?.name || server?.label || server?.server || '' });
        }
        return flattened.length ? flattened : servers;
      }
      if (typeof window.lilac?.providerDetail !== 'function') return [];
      return list(await window.lilac.providerDetail(anime));
    })()`, { timeoutMs: 12000 });
  }

  async prepareEpisodeStream(episode) {
    const payload = JSON.stringify(episode || {});
    return this.session.evaluate(`(async () => {
      if (typeof window.lilac?.prepareEpisodeStream !== 'function') throw new Error('prepareEpisodeStream is unavailable');
      return await window.lilac.prepareEpisodeStream(${payload});
    })()`, { timeoutMs: 12000 });
  }

  async attachPreparedSubtitle(prepared, { label = 'Lilac Companion · 내 자막' } = {}) {
    const payload = JSON.stringify({
      path: prepared.path,
      vtt: prepared.vtt,
      ass: prepared.ass || null,
      fonts: Array.isArray(prepared.fonts) ? prepared.fonts : [],
      label
    });
    return this.session.evaluate(`(() => {
      if (typeof attachSubtitle !== 'function') throw new Error('attachSubtitle is unavailable');
      const data = ${payload};
      if (typeof subtitleSearchId !== 'undefined') ++subtitleSearchId;
      const old = Array.isArray(window.__lilacCompanionSubtitleUrls) ? window.__lilacCompanionSubtitleUrls : [];
      for (const url of old) { try { URL.revokeObjectURL(url); } catch {} }
      const vttUrl = URL.createObjectURL(new Blob([data.vtt], { type: 'text/vtt;charset=utf-8' }));
      const urls = [vttUrl];
      let assUrl = null;
      if (data.ass) {
        assUrl = URL.createObjectURL(new Blob([data.ass], { type: 'text/plain;charset=utf-8' }));
        urls.push(assUrl);
      }
      window.__lilacCompanionSubtitleUrls = urls;
      if (typeof currentSubtitlePath !== 'undefined') currentSubtitlePath = data.path;
      if (typeof preferAiSubtitle === 'function') preferAiSubtitle(false);
      attachSubtitle(vttUrl, data.label, {
        path: data.path,
        assUrl,
        assPath: data.ass ? data.path : null,
        fonts: data.fonts,
        source: 'user',
        saved: true,
        companion: true
      });
      return { ok: true, path: data.path, ass: Boolean(data.ass), fonts: data.fonts.length };
    })()`);
  }

  async switchToResolvedSource(resolved, { title = '', image = '' } = {}) {
    const payload = JSON.stringify({
      provider: resolved?.provider || resolved?.episode?.provider || '',
      anime: resolved?.anime || {},
      episode: resolved?.episode || {},
      seriesEpisodes: Array.isArray(resolved?.seriesEpisodes) ? resolved.seriesEpisodes : [],
      title: String(title || ''),
      image: String(image || '')
    });
    return this.session.evaluate(`(async () => {
      if (typeof resolveIntoPlayer !== 'function') throw new Error('resolveIntoPlayer is unavailable');
      const data = ${payload};
      const ep = data.episode || {};
      const anime = data.anime || {};
      const number = Number(ep.number || 0) || 1;
      const displayTitle = data.title || anime.title || anime.title_english || 'Anime';
      const context = {
        episode: ep,
        subtitleTitle: displayTitle,
        image: data.image || '',
        anime,
        resolveKind: data.provider === 'linkkf' ? 'linkkf' : undefined,
        seriesEpisodes: Array.isArray(data.seriesEpisodes) ? data.seriesEpisodes : []
      };
      const resolver = () => data.provider === 'linkkf'
        ? window.lilac.linkkfResolve(ep)
        : window.lilac.providerResolve(ep);
      await resolveIntoPlayer(resolver, displayTitle + ' · ' + (ep.name || number + '화'), context, displayTitle, number);
      return { ok: true, provider: data.provider, episode: number, seriesEpisodes: context.seriesEpisodes.length };
    })()`, { timeoutMs: 20000 });
  }
}
