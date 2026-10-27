'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value, 'utf8');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

const releaseTag = String(process.env.RELEASE_TAG || '').trim();
if (!/^libmpv-r2k-v\d+\.\d+\.\d+-r\d+$/i.test(releaseTag)) {
  throw new Error(`R38 RELEASE_TAG is not a valid custom updater tag: ${releaseTag || '<empty>'}`);
}

// The updater compares releases against package.json.lilacCustomTag, not app.version.
// R34+ repackaging updated version/appId/productName/artifactName but accidentally
// stopped updating this field, so the installed custom channel identity could drift.
const pkg = JSON.parse(read('package.json'));
pkg.lilacCustomTag = releaseTag;
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

let updater = read('electron/updater.cjs');
for (const marker of ['CUSTOM_RELEASES_API', 'CUSTOM_CURRENT_TAG', 'async checkCustom()', 'compareCustom']) {
  if (!updater.includes(marker)) throw new Error(`R38 requires existing custom updater marker: ${marker}`);
}
if (updater.includes('LILAC_R38_CUSTOM_UPDATE_CHANNEL')) {
  throw new Error('R38 updater channel repair already applied');
}

const classAnchor = '\nclass Updater {';
const classAt = updater.indexOf(classAnchor);
if (classAt < 0) throw new Error('R38 updater class anchor missing');

const discoveryHelpers = `

// LILAC_R38_CUSTOM_UPDATE_CHANNEL: keep the custom channel independent from the
// official Lilac stable updater, but make discovery resilient to unauthenticated
// GitHub API rate limits/transient errors. API is preferred for release notes/size;
// GitHub's public release HTML is a token-free fallback.
const CUSTOM_RELEASES_HTML = 'https://github.com/sdsssdvx2/LilacAnime-desktop/releases';
const CUSTOM_RETRYABLE_STATUS = new Set([403, 408, 429, 500, 502, 503, 504]);
function customUserAgent(app) { return \`LilacAnime-Libmpv/\${app.getVersion()}\`; }
function htmlDecode(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
async function discoverCustomReleaseFromHtml(userAgent) {
  const response = await fetch(CUSTOM_RELEASES_HTML, {
    signal: AbortSignal.timeout(15000),
    headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgent }
  });
  if (!response.ok) throw new Error(\`GitHub releases HTML HTTP \${response.status}\`);
  const html = await response.text();
  const tags = [...new Set([...html.matchAll(/\\/sdsssdvx2\\/LilacAnime-desktop\\/releases\\/tag\\/(libmpv-r2k-v\\d+\\.\\d+\\.\\d+-r\\d+)/gi)].map(match => match[1]))]
    .filter(tag => customParts(tag))
    .sort((a, b) => compareCustom(b, a));
  const tag = tags[0];
  if (!tag) return null;

  const assetsResponse = await fetch(\`https://github.com/sdsssdvx2/LilacAnime-desktop/releases/expanded_assets/\${encodeURIComponent(tag)}\`, {
    signal: AbortSignal.timeout(15000),
    headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgent }
  });
  if (!assetsResponse.ok) throw new Error(\`GitHub expanded assets HTTP \${assetsResponse.status}\`);
  const assetsHtml = await assetsResponse.text();
  const hrefs = [...assetsHtml.matchAll(/href="([^"]*\\/releases\\/download\\/[^"]+?\\.exe(?:\\?[^"]*)?)"/gi)].map(match => htmlDecode(match[1]));
  const href = hrefs.find(value => /setup/i.test(value)) || hrefs[0];
  if (!href) return { tag_name: tag, html_url: \`https://github.com/sdsssdvx2/LilacAnime-desktop/releases/tag/\${tag}\`, body: '', assets: [], r38Discovery: 'html' };
  const url = new URL(href, 'https://github.com');
  const name = decodeURIComponent(url.pathname.split('/').pop() || 'LilacAnime-Libmpv-Setup.exe');
  return {
    tag_name: tag,
    html_url: \`https://github.com/sdsssdvx2/LilacAnime-desktop/releases/tag/\${tag}\`,
    body: '',
    assets: [{ name, browser_download_url: url.href, size: 0 }],
    r38Discovery: 'html'
  };
}
async function discoverCustomRelease(app) {
  const userAgent = customUserAgent(app);
  let apiError = null;
  try {
    const response = await fetch(CUSTOM_RELEASES_API, {
      signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': userAgent, 'Cache-Control': 'no-cache' }
    });
    if (!response.ok) {
      const error = new Error(\`GitHub HTTP \${response.status}\`);
      error.status = Number(response.status) || 0;
      throw error;
    }
    const releases = (await response.json()).filter(item => !item.draft && customParts(item.tag_name));
    releases.sort((a, b) => compareCustom(b.tag_name, a.tag_name));
    if (releases[0]) return { ...releases[0], r38Discovery: 'api' };
  } catch (error) {
    apiError = error;
  }

  try {
    const fallback = await discoverCustomReleaseFromHtml(userAgent);
    if (fallback) return fallback;
  } catch (htmlError) {
    const status = Number(apiError?.status) || 0;
    if (!apiError || CUSTOM_RETRYABLE_STATUS.has(status)) throw htmlError;
  }
  if (apiError) throw apiError;
  return null;
}
`;
updater = updater.slice(0, classAt) + discoveryHelpers + updater.slice(classAt);

const checkStart = updater.indexOf('  async checkCustom() {');
const checkEnd = updater.indexOf('\n\n  async check() {', checkStart);
if (checkStart < 0 || checkEnd <= checkStart) throw new Error('R38 checkCustom boundary missing');
const checkCustom = `  async checkCustom() {
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    this.set({ status: 'checking', error: null, customChannel: true, customTag: CUSTOM_CURRENT_TAG });
    try {
      if (!customParts(CUSTOM_CURRENT_TAG)) throw new Error('현재 커스텀 업데이트 태그가 올바르지 않습니다.');
      const release = await discoverCustomRelease(this.app);
      if (!release || compareCustom(release.tag_name, CUSTOM_CURRENT_TAG) <= 0) {
        return this.set({
          status: 'latest', latest: this.app.getVersion(), notes: '', url: release?.html_url || '',
          customChannel: true, customTag: CUSTOM_CURRENT_TAG, discovery: release?.r38Discovery || 'none'
        });
      }
      const asset = installerAsset(release.assets || []);
      if (!asset) throw new Error('커스텀 릴리스에 Windows 설치 파일(.exe)이 없습니다.');
      this.asset = asset;
      this.set({
        status: 'available', latest: String(release.tag_name), notes: String(release.body || '').slice(0, 20000),
        url: release.html_url || '', size: Number(asset.size) || 0, customChannel: true,
        customTag: String(release.tag_name), discovery: release.r38Discovery || 'api'
      });
      void this.download();
      return this.state;
    } catch (error) {
      return this.set({ status: 'error', error: error.message || '커스텀 업데이트 확인 실패', customChannel: true, customTag: CUSTOM_CURRENT_TAG });
    }
  }`;
updater = updater.slice(0, checkStart) + checkCustom + updater.slice(checkEnd);

if (!updater.includes('LILAC_R38_CUSTOM_UPDATE_CHANNEL') || !updater.includes('discoverCustomReleaseFromHtml') || !updater.includes("void this.download();")) {
  throw new Error('R38 updater repair markers missing after transform');
}
write('electron/updater.cjs', updater);

let main = read('electron/main.cjs');
const startupOld = "if(app.isPackaged){setTimeout(()=>updater.check(),5000);setInterval(()=>updater.check(),3*60*60*1000).unref?.()}";
const startupNew = `if(app.isPackaged){
    // LILAC_R38_UPDATER_STARTUP_RETRY: the first check used to fail silently until
    // the 3-hour interval when GitHub briefly returned an error. Keep one bounded
    // retry timer so launch-time update discovery recovers without polling hard.
    let updaterRetryTimer=null;
    const checkForUpdates=async()=>{
      const state=await updater.check();
      if(state?.status==='error'){
        if(!updaterRetryTimer){
          updaterRetryTimer=setTimeout(()=>{updaterRetryTimer=null;void checkForUpdates()},60*1000);
          updaterRetryTimer.unref?.();
        }
      }else if(updaterRetryTimer){clearTimeout(updaterRetryTimer);updaterRetryTimer=null}
      return state;
    };
    const initialUpdateTimer=setTimeout(()=>{void checkForUpdates()},5000);initialUpdateTimer.unref?.();
    setInterval(()=>{void checkForUpdates()},3*60*60*1000).unref?.();
  }`;
main = replaceOnce(main, startupOld, startupNew, 'startup updater retry');
if (!main.includes('LILAC_R38_UPDATER_STARTUP_RETRY') || !main.includes('60*1000')) throw new Error('R38 startup updater retry marker missing');
write('electron/main.cjs', main);

const finalPkg = JSON.parse(read('package.json'));
if (finalPkg.lilacCustomTag !== releaseTag) throw new Error(`R38 package custom tag mismatch: ${finalPkg.lilacCustomTag}`);
const finalUpdater = read('electron/updater.cjs');
for (const marker of ['LILAC_R38_CUSTOM_UPDATE_CHANNEL', 'discoverCustomReleaseFromHtml', 'r38Discovery', 'CUSTOM_CURRENT_TAG']) {
  if (!finalUpdater.includes(marker)) throw new Error(`R38 final updater marker missing: ${marker}`);
}
console.log(`R38_UPDATER_CHANNEL_FIX_OK tag=${releaseTag} discovery=github-api+html-fallback startup=5s+60s-retry+3h install=background-download+quit`);
