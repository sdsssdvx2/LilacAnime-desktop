const TECH_NUMBERS = new Set([480, 576, 720, 1080, 1440, 2160, 4320]);

export function normalizeTitle(value = '') {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

export function titleTokens(value = '') {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => !/^(1080p?|720p?|2160p?|x26[45]|h26[45]|hevc|avc|web[- ]?dl|webrip|bluray|bd|aac|flac|10bit|8bit)$/i.test(token));
}

export function diceSimilarity(a, b) {
  const x = normalizeTitle(a), y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bigrams = value => {
    if (value.length < 2) return [value];
    const out = [];
    for (let i = 0; i < value.length - 1; i++) out.push(value.slice(i, i + 2));
    return out;
  };
  const left = bigrams(x), right = bigrams(y), counts = new Map();
  for (const gram of left) counts.set(gram, (counts.get(gram) || 0) + 1);
  let overlap = 0;
  for (const gram of right) {
    const count = counts.get(gram) || 0;
    if (count > 0) { overlap++; counts.set(gram, count - 1); }
  }
  return (2 * overlap) / (left.length + right.length);
}

export function extractSeason(value = '') {
  const text = String(value).normalize('NFKC');
  const patterns = [
    /(?:^|[^a-z0-9])s(?:eason)?\s*0?(\d{1,2})(?:[^a-z0-9]|$)/i,
    /(?:^|\D)(\d{1,2})\s*기(?:\D|$)/,
    /season\s*0?(\d{1,2})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

export function extractPart(value = '') {
  const text = String(value).normalize('NFKC');
  const patterns = [/(?:part|pt)\s*0?(\d{1,2})/i, /(?:^|\D)파트\s*0?(\d{1,2})(?:\D|$)/i];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

export function extractYear(value = '') {
  const text = String(value).normalize('NFKC');
  const years = [...text.matchAll(/(?:^|\D)((?:19|20)\d{2})(?=\D|$)/g)].map(match => Number(match[1]));
  return years.length ? years[years.length - 1] : null;
}

export function extractEpisodeKind(value = '') {
  const text = String(value).normalize('NFKC').toLowerCase();
  if (/(?:^|[^a-z0-9])ova(?:[^a-z0-9]|$)|오브이에이/i.test(text)) return 'ova';
  if (/(?:^|[^a-z0-9])oad(?:[^a-z0-9]|$)/i.test(text)) return 'oad';
  if (/(?:^|[^a-z0-9])movie(?:[^a-z0-9]|$)|극장판|영화판/i.test(text)) return 'movie';
  if (/(?:^|[^a-z0-9])specials?(?:[^a-z0-9]|$)|(?:^|[^a-z0-9])sp\s*\d*(?:[^a-z0-9]|$)|스페셜|특별편|특별판|번외편|외전/i.test(text)) return 'special';
  return 'main';
}

export function extractEpisode(value = '') {
  const text = String(value).normalize('NFKC');
  const explicit = [
    /s\d{1,2}\s*e\s*0*(\d{1,3})(?:v\d+)?/i,
    /(?:^|[^a-z0-9])ep(?:isode)?\s*[._ -]*0*(\d{1,3})(?:v\d+)?(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])e\s*0*(\d{1,3})(?:v\d+)?(?:[^a-z0-9]|$)/i,
    /(?:^|\D)0*(\d{1,3})\s*화(?:\D|$)/
  ];
  for (const pattern of explicit) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }

  const candidates = [];
  const loose = /(?:^|[\s._\-\[(])0*(\d{1,3})(?:v\d+)?(?:\s*(?:end|fin))?(?=$|[\s._\-\])])/ig;
  for (const match of text.matchAll(loose)) {
    const number = Number(match[1]);
    if (!number || TECH_NUMBERS.has(number) || (number >= 1900 && number <= 2099)) continue;
    if ([8, 10, 12].includes(number) && /(?:8|10|12)\s*bit/i.test(text)) continue;
    candidates.push(number);
  }
  return candidates.length ? candidates[candidates.length - 1] : null;
}

export function stripEpisodeNoise(value = '') {
  return String(value)
    .normalize('NFKC')
    .replace(/s\d{1,2}\s*e\s*\d{1,3}(?:v\d+)?/ig, ' ')
    .replace(/(?:episode|ep|e)\s*[._ -]*\d{1,3}(?:v\d+)?/ig, ' ')
    .replace(/\b\d{1,3}\s*화\b/ig, ' ')
    .replace(/(?:^|\s)(?:season|s)\s*0?\d{1,2}(?=\s|$)/ig, ' ')
    .replace(/(?:^|\s)\d{1,2}\s*기(?=\s|$)/g, ' ')
    .replace(/(?:^|\s)(?:part|pt|파트)\s*0?\d{1,2}(?=\s|$)/ig, ' ')
    .replace(/(?:^|\s)(?:19|20)\d{2}(?=\s|$)/g, ' ')
    .replace(/\b(?:480|576|720|1080|1440|2160|4320)p\b/ig, ' ')
    .replace(/\b(?:x26[45]|h26[45]|hevc|avc|10bit|8bit|aac|flac|web[- ]?dl|webrip|bluray|bd)\b/ig, ' ')
    .replace(/[\[\](){}]/g, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
