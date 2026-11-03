import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FEEDS, CATEGORIES, FALLBACK_CATEGORY } from './feeds.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ARTICLES_FILE = path.join(DATA_DIR, 'articles.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
const PORT = Number(process.env.PORT) || 4321;
const RETENTION_DAYS = 120;
const AUTO_REFRESH_MS = 60 * 60 * 1000;

// ---------- storage ----------
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}
// Runs read-modify-write tasks for one file strictly one at a time.
const locks = new Map();
function withLock(key, task) {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(task, task);
  locks.set(key, run.catch(() => {}));
  return run;
}

// ---------- feed parsing ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const unCdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${escRe(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escRe(name)}>`, 'i'));
  return m ? unCdata(m[1]).trim() : '';
}
function tags(xml, name) {
  const re = new RegExp(`<${escRe(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escRe(name)}>`, 'gi');
  return [...xml.matchAll(re)].map((m) => unCdata(m[1]).trim());
}
function attr(xml, tagName, attrName, filter) {
  const re = new RegExp(`<${escRe(tagName)}\\b[^>]*>`, 'gi');
  for (const m of xml.matchAll(re)) {
    if (filter && !filter(m[0])) continue;
    const a = m[0].match(new RegExp(`\\s${escRe(attrName)}\\s*=\\s*["']([^"']+)["']`, 'i'));
    if (a) return decodeEntities(a[1]);
  }
  return '';
}
function stripHtml(html) {
  return decodeEntities(
    decodeEntities(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}
function excerpt(text, max = 320) {
  const cleaned = text
    .replace(/The post .* appeared first on .*$/i, '')
    .replace(/Continue reading.*$/i, '')
    .replace(/\[(…|\.\.\.)\]\s*$/, '')
    .trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return sentenceEnd > max * 0.5 ? cut.slice(0, sentenceEnd + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}
function firstImage(html) {
  const m = decodeEntities(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

const STOPWORDS = new Set('a an the and or but of to in on for with from by at as is are was were be been this that these those it its how why what when who your you our we their they new can will not into about more most than just get got has have had do does make makes using use via over out up all one two vs here there which where while also like after before first year years now said says design designer designers'.split(' '));
function keywordsOf(text) {
  const counts = new Map();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9+-]{2,}/g) ?? []) {
    if (STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w);
}

// Hyphens and punctuation become spaces so "design-system" matches "design system".
const normalizeText = (s) => ` ${String(s).toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim()} `;
const CATEGORY_MATCHERS = CATEGORIES.map((c) => ({
  name: c.name,
  matchers: c.keywords.map((kw) => {
    const k = typeof kw === 'string' ? { term: kw, weight: 1 } : kw;
    const term = normalizeText(k.term).trim();
    const phraseBonus = term.includes(' ') ? 1.5 : 1;
    return { re: new RegExp(`(?<= )${escRe(term)}(?= )`, 'g'), weight: (k.weight ?? 1) * phraseBonus };
  }),
}));
const MIN_CATEGORY_SCORE = 1;
// Title matches count most, then the feed's own tags, then the summary.
function categorize(title, summary, feedCategories) {
  const fields = [[normalizeText(title), 3], [normalizeText(feedCategories.join(' . ')), 2], [normalizeText(summary), 1]];
  const scored = CATEGORY_MATCHERS.map((cat) => {
    let score = 0;
    let titleScore = 0;
    for (const { re, weight } of cat.matchers) {
      fields.forEach(([text, fieldWeight], i) => {
        const hits = text.match(re)?.length ?? 0;
        score += hits * weight * fieldWeight;
        if (i === 0) titleScore += hits * weight;
      });
    }
    return { name: cat.name, score, titleScore };
  }).sort((a, b) => b.score - a.score || b.titleScore - a.titleScore);
  const [best, second] = scored;
  if (best.score < MIN_CATEGORY_SCORE) return FALLBACK_CATEGORY;
  if (second && second.score === best.score && second.titleScore === best.titleScore) return FALLBACK_CATEGORY;
  return best.name;
}

const FUTURE_TOLERANCE_MS = 24 * 3600e3;
// Missing or implausibly future dates fall back to when the article was first seen.
function trustedDate(iso, fallback) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(t) || t > Date.now() + FUTURE_TOLERANCE_MS) return fallback;
  return new Date(t).toISOString();
}
function absoluteUrl(href, base) {
  try {
    const u = new URL(decodeEntities(String(href).trim()), base);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch { return ''; }
}

function parseFeed(rawXml, feed, baseUrl = feed.url) {
  const xml = rawXml.replace(/<(\/?)atom:/gi, '<$1');
  if (!isFeedXml(xml)) throw new Error('Not an RSS/Atom feed (got a web page instead)');
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  return blocks.map((b) => {
    const title = stripHtml(tag(b, 'title'));
    const rawLink = isAtom
      ? attr(b, 'link', 'href', (t) => !/rel=["'](?!alternate)/i.test(t)) || attr(b, 'link', 'href')
      : decodeEntities(tag(b, 'link')) || attr(b, 'link', 'href') || tag(b, 'guid');
    const link = absoluteUrl(rawLink, baseUrl);
    const dateStr = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const date = trustedDate(dateStr, null);
    const rawContent = tag(b, 'content:encoded') || tag(b, 'content');
    const rawSummary = tag(b, 'description') || tag(b, 'summary') || rawContent;
    const summary = excerpt(stripHtml(rawSummary));
    const feedCategories = [
      ...tags(b, 'category').map(stripHtml),
      ...[...b.matchAll(/<category[^>]*term=["']([^"']+)["']/gi)].map((m) => decodeEntities(m[1])),
    ];
    const image = absoluteUrl(
      attr(b, 'media:content', 'url', (t) => !/medium=["'](?!image)/i.test(t)) ||
      attr(b, 'media:thumbnail', 'url') ||
      attr(b, 'enclosure', 'url', (t) => /image/i.test(t)) ||
      firstImage(rawSummary) || firstImage(rawContent), baseUrl);
    const author = stripHtml(tag(b, 'dc:creator') || tag(tag(b, 'author'), 'name') || tag(b, 'author'));
    const cleanTags = [...new Set(feedCategories.map((c) => c.trim()).filter((c) => c && c.length < 40))];
    return {
      id: crypto.createHash('sha1').update(link || title).digest('hex').slice(0, 16),
      title,
      link,
      source: feed.name,
      author,
      date,
      summary,
      image,
      category: categorize(title, summary, cleanTags),
      tags: cleanTags.slice(0, 6),
      keywords: keywordsOf(`${title} ${title} ${cleanTags.join(' ')} ${summary}`),
    };
  }).filter((a) => a.title && a.link);
}

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (DesignDigest personal reader)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*' };
function isFeedXml(text) {
  return /<(rss|feed|rdf:RDF)[\s>]/i.test(text.replace(/<(\/?)atom:/gi, '<$1').slice(0, 4000));
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text(), feed, res.url || feed.url);
}

// ---------- user sources (sources.txt) ----------
const SOURCES_FILE = path.join(ROOT, 'sources.txt');
const DISCOVERED_FILE = path.join(DATA_DIR, 'discovered.json');

async function readUserSources() {
  const text = await fs.readFile(SOURCES_FILE, 'utf8').catch(() => '');
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const [rawUrl, ...rest] = line.split('|');
    let url = rawUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try { url = new URL(url).href; } catch { return null; }
    return { url, name: rest.join('|').trim() || null };
  }).filter(Boolean);
}

const DISCOVERY_TTL_MS = 30 * 864e5;
const DISCOVERY_BUDGET_MS = 30000;
const REDISCOVER_AFTER_FAILURES = 3;
const backoffMs = (failures) => Math.min(864e5 * 2 ** Math.max(0, failures - 1), 7 * 864e5);

// Accepts a feed URL or a normal website URL; for websites, finds the RSS/Atom feed.
// The whole search shares one time budget and probes a few candidates at a time.
async function discoverFeed(siteUrl) {
  const budget = AbortSignal.timeout(DISCOVERY_BUDGET_MS);
  const signal = () => AbortSignal.any([budget, AbortSignal.timeout(12000)]);
  const res = await fetch(siteUrl, { headers: HEADERS, signal: signal() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  const base = res.url || siteUrl;
  if (isFeedXml(body)) return { feedUrl: base, title: stripHtml(tag(body.replace(/<(\/?)atom:/gi, '<$1'), 'title')) };
  const siteTitle = stripHtml(tag(body, 'title')).split(/\s[|–—-]\s/)[0];
  const advertised = [];
  for (const m of body.matchAll(/<link\b[^>]*>/gi)) {
    const t = m[0];
    if (/rel=["'][^"']*alternate/i.test(t) && /type=["']application\/(rss|atom)\+xml/i.test(t)) {
      const href = absoluteUrl(t.match(/href=["']([^"']+)["']/i)?.[1] ?? '', base);
      if (href && !/comments/i.test(href)) advertised.push(href);
    }
  }
  const guesses = ['/feed/', '/rss.xml', '/feed.xml', '/atom.xml', '/rss/', '/index.xml', '/blog/feed/', '/blog/rss.xml'].map((p) => new URL(p, base).href);
  const candidates = [...new Set([...advertised, ...guesses])];
  for (let i = 0; i < candidates.length && !budget.aborted; i += 3) {
    const batch = candidates.slice(i, i + 3);
    const found = await Promise.all(batch.map(async (c) => {
      try {
        const r = await fetch(c, { headers: HEADERS, signal: signal() });
        return r.ok && isFeedXml(await r.text()) ? c : null;
      } catch { return null; }
    }));
    const hit = found.find(Boolean);
    if (hit) return { feedUrl: hit, title: siteTitle };
  }
  if (budget.aborted) throw new Error('Timed out looking for a feed');
  throw new Error('No RSS/Atom feed found on this site');
}

const displayName = (name, title, url) => name || title || new URL(url).hostname.replace(/^www\./, '');

// Resolves one sources.txt entry to a feed (using the cache when fresh) and fetches it.
async function loadUserSource({ url, name }, cache, builtIn) {
  const now = Date.now();
  let entry = cache[url];
  const stale = entry?.feedUrl && (now - new Date(entry.discoveredAt ?? 0) > DISCOVERY_TTL_MS || (entry.feedFailures ?? 0) >= REDISCOVER_AFTER_FAILURES);
  const due = !entry?.feedUrl && (!entry?.nextTry || now >= new Date(entry.nextTry).getTime());
  if (!entry || stale || due) {
    try {
      const found = await discoverFeed(url);
      entry = { ...found, discoveredAt: new Date().toISOString(), feedFailures: 0 };
    } catch (e) {
      // Keep using a previously found feed if rediscovery fails.
      if (entry?.feedUrl) entry = { ...entry, discoveredAt: new Date().toISOString() };
      else {
        const failures = (entry?.failures ?? 0) + 1;
        entry = { error: String(e.message ?? e), failures, lastChecked: new Date().toISOString(), nextTry: new Date(now + backoffMs(failures)).toISOString() };
      }
    }
    cache[url] = entry;
  }
  const label = displayName(name, entry.title, url);
  if (!entry.feedUrl) {
    return { name: label, status: { ok: false, custom: true, site: url, error: entry.error, nextTry: entry.nextTry }, articles: [] };
  }
  if (builtIn.has(entry.feedUrl)) return null;
  try {
    const articles = await fetchFeed({ name: label, url: entry.feedUrl });
    entry.feedFailures = 0;
    return { name: label, status: { ok: true, count: articles.length, custom: true, site: url }, articles };
  } catch (e) {
    entry.feedFailures = (entry.feedFailures ?? 0) + 1;
    return { name: label, status: { ok: false, custom: true, site: url, error: String(e.message ?? e) }, articles: [] };
  }
}

async function loadBuiltIn(feed) {
  try {
    const articles = await fetchFeed(feed);
    return { name: feed.name, status: { ok: true, count: articles.length }, articles };
  } catch (e) {
    return { name: feed.name, status: { ok: false, error: String(e.message ?? e) }, articles: [] };
  }
}

let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const store = await readJson(ARTICLES_FILE, { articles: [], sources: {}, lastRefresh: null });
    const byId = new Map(store.articles.map((a) => [a.id, a]));
    const now = new Date().toISOString();
    const cache = await readJson(DISCOVERED_FILE, {});
    const builtIn = new Set(FEEDS.map((f) => f.url));
    // Built-in feeds and user sources load in parallel so a slow site can't hold up the rest.
    const results = (await Promise.all([
      ...FEEDS.map(loadBuiltIn),
      ...(await readUserSources()).map((s) => loadUserSource(s, cache, builtIn)),
    ])).filter(Boolean);
    await writeJson(DISCOVERED_FILE, cache);

    const sources = {};
    for (const { name, status, articles } of results) {
      sources[name] = status;
      for (const a of articles) {
        const existing = byId.get(a.id);
        const firstSeen = existing?.firstSeen ?? now;
        byId.set(a.id, { ...a, date: a.date ?? existing?.date ?? firstSeen, dateEstimated: !a.date && (existing?.dateEstimated ?? true), firstSeen });
      }
    }
    // Re-check older stored articles so category rule changes and date limits apply to them too.
    for (const a of byId.values()) {
      a.date = trustedDate(a.date, a.firstSeen ?? now);
      a.category = categorize(a.title, a.summary ?? '', a.tags ?? []);
    }
    const cutoff = Date.now() - RETENTION_DAYS * 864e5;
    const articles = [...byId.values()]
      .filter((a) => new Date(a.date).getTime() >= cutoff)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const next = { articles, sources, lastRefresh: now };
    await withLock(ARTICLES_FILE, () => writeJson(ARTICLES_FILE, next));
    const okCount = Object.values(sources).filter((s) => s.ok).length;
    console.log(`[${now}] Refreshed ${okCount}/${Object.keys(sources).length} feeds, ${articles.length} articles stored`);
    return next;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
// Random per run; only pages served from this app can read it (no CORS headers are ever sent).
const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');

// Blocks DNS-rebinding and cross-site requests from other pages in your browser.
function rejectUntrusted(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return 'Unexpected Host header';
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return 'Cross-origin request blocked';
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return 'Cross-site request blocked';
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return 'Expected application/json';
  const token = Buffer.from(String(req.headers['x-dd-token'] ?? ''));
  const expected = Buffer.from(SESSION_TOKEN);
  if (token.length !== expected.length || !crypto.timingSafeEqual(token, expected)) return 'Missing or invalid session token';
  return null;
}

function safeLink(link) {
  try {
    const u = new URL(link);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}
function snapshotOf(a) {
  return {
    title: a.title, link: a.link, source: a.source, category: a.category, keywords: (a.keywords ?? []).slice(0, 12),
    tags: a.tags ?? [], date: a.date ?? null, summary: String(a.summary ?? '').slice(0, 500), image: a.image ?? '',
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e6) throw new Error('Body too large');
  }
  return data ? JSON.parse(data) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const blocked = rejectUntrusted(req);
    if (blocked) return send(res, 403, { error: blocked });

    if (url.pathname === '/api/session' && req.method === 'GET') {
      return send(res, 200, { token: SESSION_TOKEN });
    }
    if (url.pathname === '/api/articles' && req.method === 'GET') {
      let store = await readJson(ARTICLES_FILE, null);
      if (!store) store = await refresh();
      return send(res, 200, { ...store, categories: [...CATEGORIES.map((c) => c.name), FALLBACK_CATEGORY] });
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      const store = await refresh();
      return send(res, 200, { lastRefresh: store.lastRefresh, sources: store.sources, count: store.articles.length });
    }
    if (url.pathname === '/api/open' && req.method === 'POST') {
      const { id } = await readBody(req);
      const store = await readJson(ARTICLES_FILE, { articles: [] });
      const feedback = await readJson(FEEDBACK_FILE, {});
      const link = safeLink(store.articles.find((a) => a.id === id)?.link ?? feedback[id]?.article?.link);
      if (!link) return send(res, 404, { error: 'Unknown article' });
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      await new Promise((resolve, reject) => execFile(opener, [link], (err) => (err ? reject(err) : resolve())));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/feedback' && req.method === 'GET') {
      return send(res, 200, await readJson(FEEDBACK_FILE, {}));
    }
    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      const { id, vote, saved } = await readBody(req);
      if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) return send(res, 400, { error: 'Invalid id' });
      const store = await readJson(ARTICLES_FILE, { articles: [] });
      const stored = store.articles.find((a) => a.id === id);
      const result = await withLock(FEEDBACK_FILE, async () => {
        const feedback = await readJson(FEEDBACK_FILE, {});
        const entry = feedback[id] ?? {};
        // The snapshot always comes from the server's own data, never from the request.
        if (stored && safeLink(stored.link)) entry.article = snapshotOf(stored);
        if (!entry.article) return null;
        if (vote !== undefined) entry.vote = [1, -1].includes(vote) ? vote : 0;
        if (saved !== undefined) entry.saved = Boolean(saved);
        entry.updatedAt = new Date().toISOString();
        if (!entry.vote && !entry.saved) delete feedback[id];
        else feedback[id] = entry;
        await writeJson(FEEDBACK_FILE, feedback);
        return { ok: true, entry: feedback[id] ?? null };
      });
      return result ? send(res, 200, result) : send(res, 404, { error: 'Unknown article' });
    }
    if (url.pathname === '/api/feedback/reset-votes' && req.method === 'POST') {
      await withLock(FEEDBACK_FILE, async () => {
        const feedback = await readJson(FEEDBACK_FILE, {});
        for (const [id, entry] of Object.entries(feedback)) {
          delete entry.vote;
          if (!entry.saved) delete feedback[id];
        }
        await writeJson(FEEDBACK_FILE, feedback);
      });
      return send(res, 200, { ok: true });
    }

    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
    const content = await fs.readFile(file).catch(() => null);
    if (!content) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(content);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

if (process.argv.includes('--refresh-only')) {
  await refresh();
} else {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use — Design Digest is probably already running at http://localhost:${PORT}.\nStop the other copy, or run on another port: PORT=4322 npm start`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Design Digest running at http://localhost:${PORT}`);
    refresh().catch((e) => console.error('Initial refresh failed:', e));
    setInterval(() => refresh().catch((e) => console.error('Refresh failed:', e)), AUTO_REFRESH_MS);
  });
}
