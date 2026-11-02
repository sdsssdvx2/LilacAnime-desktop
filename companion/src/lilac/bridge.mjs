export class LilacBridge {
  constructor(session) {
    this.session = session;
  }

  async features() {
    return this.session.evaluate(`(() => ({
      lilac: Boolean(window.lilac),
      titleVariants: typeof window.lilac?.titleVariants === 'function',
      catalogKoreanSearch: typeof window.lilac?.catalogKoreanSearch === 'function',
      providerCatalog: typeof window.lilac?.providerCatalog === 'function',
      providerDetail: typeof window.lilac?.providerDetail === 'function',
      prepareEpisodeStream: typeof window.lilac?.prepareEpisodeStream === 'function',
      linkkfSearch: typeof window.lilac?.linkkfSearch === 'function',
      linkkfEpisodes: typeof window.lilac?.linkkfEpisodes === 'function',
      attachSubtitle: typeof attachSubtitle === 'function',
      playbackContext: typeof currentPlaybackContext !== 'undefined',
      preferAiSubtitle: typeof preferAiSubtitle === 'function'
    }))()`);
  }

  async playbackContext() {
    return this.session.evaluate(`(() => {
      if (typeof currentPlaybackContext === 'undefined' || !currentPlaybackContext) return null;
      const c = currentPlaybackContext;
      const a = c.anime || {};
      const e = c.episode || {};
      const s = c.stream || {};
      const sub = typeof currentSubtitle !== 'undefined' && currentSubtitle ? currentSubtitle : {};
      return {
        anime: {
          provider: a.provider || '', id: a.id ?? null, mal_id: a.mal_id ?? null,
          anilistId: a.anilistId ?? null, malId: a.malId ?? null,
          title: a.title || '', title_english: a.title_english || '', title_japanese: a.title_japanese || '',
          romaji: a.romaji || '', synonyms: a.synonyms || '', season: a.season || '', year: a.year || '', type: a.type || ''
        },
        episode: {
          provider: e.provider || '', id: e.id ?? null, number: Number(e.number || 0) || null,
          name: e.name || '', url: e.url || '', animeId: e.animeId ?? null,
          postId: e.postId ?? null, token: e.token ?? null, slug: e.slug || '', resolveKind: e.resolveKind || ''
        },
        stream: { url: s.url || '', server: s.server || '', kind: s.kind || '', headers: s.headers || null },
        subtitle: { source: sub.source || '', path: sub.path || '', label: sub.label || '' },
        playing: Boolean(document.querySelector('#video')),
        currentTime: Number(document.querySelector('#video')?.currentTime || 0)
      };
    })()`);
  }

  async titleVariants(query) {
    const value = JSON.stringify(String(query || ''));
    return this.session.evaluate(`(async () => {
      if (typeof window.lilac?.titleVariants !== 'function') return [];
      const result = await window.lilac.titleVariants(${value});
      return Array.isArray(result) ? result : [];
    })()`);
  }

  async searchProvider(provider, query) {
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
    })()`);
  }

  async providerEpisodes(provider, anime) {
    const payload = JSON.stringify({ provider: String(provider || ''), anime });
    return this.session.evaluate(`(async () => {
      const { provider, anime } = ${payload};
      const list = value => Array.isArray(value) ? value : Array.isArray(value?.episodes) ? value.episodes : Array.isArray(value?.data?.episodes) ? value.data.episodes : Array.isArray(value?.data) ? value.data : [];
      if (provider === 'linkkf') {
        if (typeof window.lilac?.linkkfEpisodes !== 'function') return [];
        return list(await window.lilac.linkkfEpisodes(anime.id || anime.postId));
      }
      if (typeof window.lilac?.providerDetail !== 'function') return [];
      return list(await window.lilac.providerDetail(anime));
    })()`);
  }

  async prepareEpisodeStream(episode) {
    const payload = JSON.stringify(episode || {});
    return this.session.evaluate(`(async () => {
      if (typeof window.lilac?.prepareEpisodeStream !== 'function') throw new Error('prepareEpisodeStream is unavailable');
      return await window.lilac.prepareEpisodeStream(${payload});
    })()`);
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
}
