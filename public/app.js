const $ = (sel) => document.querySelector(sel);
const PAGE_SIZE = 30;
const PERIODS = [
  { id: 'day', label: 'Daily', ms: 864e5 },
  { id: 'week', label: 'Weekly', ms: 7 * 864e5 },
  { id: 'month', label: 'Monthly', ms: 30 * 864e5 },
  { id: 'all', label: 'All', ms: Infinity },
];
const VIEWS = [
  { id: 'all', label: 'Latest' },
  { id: 'saved', label: 'Saved' },
  { id: 'liked', label: 'Liked' },
  { id: 'hidden', label: 'Not interested' },
];

const stored = JSON.parse(localStorage.getItem('dd:prefs') || '{}');
const state = {
  articles: [],
  categories: [],
  sources: {},
  lastRefresh: null,
  feedback: {},
  read: new Set(JSON.parse(localStorage.getItem('dd:read') || '[]')),
  period: stored.period ?? 'week',
  view: 'all',
  category: null,
  query: '',
  sort: stored.sort ?? 'foryou',
  hideRead: stored.hideRead ?? false,
  mutedSources: new Set(stored.mutedSources ?? []),
  limit: PAGE_SIZE,
};

function savePrefs() {
  localStorage.setItem('dd:prefs', JSON.stringify({
    period: state.period, sort: state.sort, hideRead: state.hideRead, mutedSources: [...state.mutedSources],
  }));
}

// ---------- helpers ----------
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function highlight(text, terms) {
  const safe = esc(text);
  if (!terms.length) return safe;
  return safe.replace(new RegExp(`(${terms.map((t) => escRe(esc(t))).join('|')})`, 'gi'), '<mark>$1</mark>');
}
function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = esc(msg);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.hidden = true; };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 4000);
}
let sessionToken = null;
async function api(path, opts = {}) {
  const method = (opts.method ?? 'GET').toUpperCase();
  const headers = { ...(opts.headers ?? {}) };
  if (method !== 'GET') {
    sessionToken ??= (await (await fetch('/api/session')).json()).token;
    Object.assign(headers, { 'Content-Type': 'application/json', 'X-DD-Token': sessionToken });
  }
  const res = await fetch(path, { ...opts, method, headers, body: opts.body ?? (method !== 'GET' ? '{}' : undefined) });
  if (res.status === 403 && method !== 'GET' && !opts.retried) {
    // The server restarted and issued a new token.
    sessionToken = null;
    return api(path, { ...opts, retried: true });
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// ---------- personalization ----------
// Votes fade with a 60-day half-life. Dislikes only count against category and source, at half strength.
// Each signal is capped (tanh), so piling up likes for one source can't take over the feed.
const VOTE_HALF_LIFE_DAYS = 60;
const KEYWORD_MIN_EVIDENCE = 1.5;
const RECENCY_HALF_LIFE_DAYS = 3;
function buildProfile() {
  const p = { cat: {}, src: {}, kw: {}, votes: 0 };
  const current = new Map(state.articles.map((a) => [a.id, a]));
  for (const [id, f] of Object.entries(state.feedback)) {
    if (!f.vote || !f.article) continue;
    p.votes++;
    const a = current.get(id) ?? f.article;
    const ageDays = f.updatedAt ? Math.max(0, (Date.now() - new Date(f.updatedAt)) / 864e5) : 0;
    const w = f.vote * 0.5 ** (ageDays / VOTE_HALF_LIFE_DAYS) * (f.vote < 0 ? 0.5 : 1);
    p.cat[a.category] = (p.cat[a.category] ?? 0) + w;
    p.src[a.source] = (p.src[a.source] ?? 0) + w;
    if (f.vote > 0) for (const k of a.keywords ?? []) p.kw[k] = (p.kw[k] ?? 0) + w;
  }
  return p;
}
function scoreArticle(a, p) {
  const cat = Math.tanh((p.cat[a.category] ?? 0) / 2) * 1.5;
  const src = Math.tanh((p.src[a.source] ?? 0) / 2) * 0.75;
  const kwHits = (a.keywords ?? []).map((k) => [k, p.kw[k] ?? 0]).filter(([, v]) => v >= KEYWORD_MIN_EVIDENCE);
  const kw = Math.tanh(kwHits.reduce((s, [, v]) => s + v, 0) / 3) * 0.75;
  return { score: cat + src + kw, cat, src, kwHits };
}
function recencyScore(a) {
  const ageDays = Math.max(0, (Date.now() - new Date(a.date)) / 864e5);
  return 1.5 * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
}
function reasonFor(a, s) {
  const parts = [];
  if (s.cat > 0.1 && a.category !== 'General') parts.push(a.category);
  if (s.src > 0.1) parts.push(a.source);
  const kws = s.kwHits.sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k]) => k);
  parts.push(...kws);
  return parts.length ? `Because you like ${parts.slice(0, 3).join(', ')}` : '';
}

// ---------- filtering ----------
function allKnownArticles() {
  const map = new Map(state.articles.map((a) => [a.id, a]));
  // Saved and liked articles stay available even after they fall out of the feed history.
  for (const [id, f] of Object.entries(state.feedback)) {
    if (!map.has(id) && f.article) map.set(id, { id, tags: [], ...f.article });
  }
  return [...map.values()];
}
function queryTerms() {
  return state.query.toLowerCase().split(/\s+/).filter(Boolean);
}
function baseFiltered({ ignoreCategory = false } = {}) {
  const period = PERIODS.find((p) => p.id === state.period);
  const now = Date.now();
  const terms = queryTerms();
  return allKnownArticles().filter((a) => {
    const f = state.feedback[a.id] ?? {};
    if (state.view === 'saved' && !f.saved) return false;
    if (state.view === 'liked' && f.vote !== 1) return false;
    if (state.view === 'hidden' && f.vote !== -1) return false;
    if (state.view === 'all') {
      if (f.vote === -1) return false;
      if (state.mutedSources.has(a.source)) return false;
      if (state.hideRead && state.read.has(a.id)) return false;
      if (now - new Date(a.date) > period.ms) return false;
    }
    if (!ignoreCategory && state.category && a.category !== state.category) return false;
    if (terms.length) {
      const hay = `${a.title} ${a.summary} ${a.source} ${a.category} ${a.author ?? ''} ${(a.tags ?? []).join(' ')}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
}

// ---------- rendering ----------
const ICONS = {
  like: '<svg viewBox="0 0 24 24"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Zm0 0 4-8a3 3 0 0 1 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.1 21H7"/></svg>',
  dislike: '<svg viewBox="0 0 24 24"><path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3Zm0 0-4 8a3 3 0 0 1-3-3v-4H4.5a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.9 3H17"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/></svg>',
};

function cardHtml(a, s, terms) {
  const f = state.feedback[a.id] ?? {};
  const why = state.sort === 'foryou' && s && s.score > 0.1 ? reasonFor(a, s) : '';
  const thumb = a.image
    ? `<span class="thumb" style="background-image:url('${esc(a.image).replace(/'/g, '%27')}')" role="img" aria-label=""></span>`
    : `<span class="thumb placeholder" aria-hidden="true">${esc(a.source[0] ?? '·')}</span>`;
  return `
    <article class="card${state.read.has(a.id) ? ' read' : ''}" data-id="${esc(a.id)}">
      ${thumb}
      <div class="body">
        <div class="byline">
          <span class="src">${esc(a.source)}</span><span>·</span><time datetime="${esc(a.date)}"${a.dateEstimated ? ' title="This source didn’t give a publish date; this is when Design Digest first saw it."' : ''}>${a.dateEstimated ? 'found ' : ''}${timeAgo(a.date)}</time>
          <button class="cat" data-cat="${esc(a.category)}" type="button" title="Filter by ${esc(a.category)}">${esc(a.category)}</button>
        </div>
        <h3 class="title"><a href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">${highlight(a.title, terms)}</a></h3>
        ${a.summary ? `<p class="summary">${highlight(a.summary, terms)}</p>` : ''}
        ${why ? `<span class="why">★ ${esc(why)}</span>` : ''}
      </div>
      <div class="actions">
        <button class="icon-btn like" data-act="like" aria-pressed="${f.vote === 1}" title="More like this">${ICONS.like}</button>
        <button class="icon-btn dislike" data-act="dislike" aria-pressed="${f.vote === -1}" title="Less like this">${ICONS.dislike}</button>
        <span class="spacer"></span>
        <button class="icon-btn save" data-act="save" aria-pressed="${!!f.saved}" title="${f.saved ? 'Remove from saved' : 'Save for later'}">${ICONS.save}</button>
      </div>
    </article>`;
}

function renderPeriods() {
  $('#periods').innerHTML = PERIODS.map((p) =>
    `<button role="tab" type="button" data-period="${p.id}" aria-selected="${state.period === p.id}">${p.label}</button>`).join('');
  $('#periods').style.display = state.view === 'all' ? '' : 'none';
}

function renderSidebar() {
  const counts = {};
  for (const a of baseFiltered({ ignoreCategory: true })) counts[a.category] = (counts[a.category] ?? 0) + 1;
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const cats = state.categories.filter((c) => counts[c]).sort((a, b) => counts[b] - counts[a]);
  $('#categories').innerHTML =
    `<li><button type="button" data-cat="" aria-pressed="${!state.category}">All categories <span class="n">${total}</span></button></li>` +
    cats.map((c) => `<li><button type="button" data-cat="${esc(c)}" aria-pressed="${state.category === c}">${esc(c)} <span class="n">${counts[c]}</span></button></li>`).join('');

  const fb = Object.values(state.feedback);
  const viewCounts = { saved: fb.filter((f) => f.saved).length, liked: fb.filter((f) => f.vote === 1).length, hidden: fb.filter((f) => f.vote === -1).length };
  $('#views').innerHTML = VIEWS.map((v) =>
    `<li><button type="button" data-view="${v.id}" aria-pressed="${state.view === v.id}">${v.label}${viewCounts[v.id] ? ` <span class="n">${viewCounts[v.id]}</span>` : ''}</button></li>`).join('');

  const p = buildProfile();
  const entries = [
    ...Object.entries(p.cat).map(([k, v]) => [k, v * 2]),
    ...Object.entries(p.src).map(([k, v]) => [k, v * 1.5]),
    ...Object.entries(p.kw).filter(([, v]) => Math.abs(v) >= KEYWORD_MIN_EVIDENCE),
  ].filter(([k, v]) => Math.abs(v) >= 0.25 && k !== 'General');
  const pos = entries.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const neg = entries.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).slice(0, 5);
  $('#interests').innerHTML =
    pos.map(([k]) => `<span class="chip pos">+ ${esc(k)}</span>`).join('') +
    neg.map(([k]) => `<span class="chip neg">− ${esc(k)}</span>`).join('');
  $('#interestsHint').textContent = p.votes
    ? `Learned from ${p.votes} rating${p.votes === 1 ? '' : 's'}. Articles that match rank higher under "For you".`
    : 'Like or dislike articles to teach the digest what you care about.';
  $('#resetBtn').hidden = !p.votes;

  $('#sources').innerHTML = Object.entries(state.sources).sort(([a], [b]) => a.localeCompare(b)).map(([name, s]) => `
    <li>
      <label><input type="checkbox" data-source="${esc(name)}" ${state.mutedSources.has(name) ? '' : 'checked'}> ${esc(name)}${s.custom ? ' <span class="mine" title="From sources.txt">★</span>' : ''}</label>
      ${s.ok ? '' : `<span class="err" title="${esc(s.error)}${s.nextTry ? ` — will check again ${esc(new Date(s.nextTry).toLocaleDateString())}` : ''}">${s.custom && /No RSS/.test(s.error) ? 'no feed' : 'failed'}</span>`}
    </li>`).join('');
}

function renderList() {
  const terms = queryTerms();
  const p = buildProfile();
  let items = baseFiltered().map((a) => ({ a, s: scoreArticle(a, p) }));
  if (state.sort === 'foryou' && p.votes) {
    const rank = (it) => it.s.score + recencyScore(it.a);
    items.sort((x, y) => rank(y) - rank(x));
  } else {
    items.sort((x, y) => new Date(y.a.date) - new Date(x.a.date));
  }

  // Top picks: highest positive matches, one per source for variety.
  let picks = [];
  if (state.view === 'all' && state.sort === 'foryou' && p.votes && !terms.length) {
    const seen = new Set();
    for (const it of items) {
      if (it.s.score <= 0.1 || state.read.has(it.a.id) || seen.has(it.a.source)) continue;
      seen.add(it.a.source);
      picks.push(it);
      if (picks.length === 3) break;
    }
    if (picks.length < 2) picks = [];
  }
  const pickIds = new Set(picks.map((x) => x.a.id));
  $('#picks').hidden = !picks.length;
  $('#picksGrid').innerHTML = picks.map(({ a, s }) => cardHtml(a, s, terms)).join('');
  items = items.filter((x) => !pickIds.has(x.a.id));

  const viewLabel = VIEWS.find((v) => v.id === state.view).label;
  const periodLabel = { day: 'Today', week: 'This week', month: 'This month', all: 'All articles' }[state.period];
  $('#listTitle').textContent = state.view === 'all'
    ? [state.category, picks.length ? `More from ${periodLabel.toLowerCase().replace('all articles', 'all time')}` : periodLabel].filter(Boolean).join(' · ')
    : [viewLabel, state.category].filter(Boolean).join(' · ');
  $('#count').textContent = `${items.length + picks.length} article${items.length + picks.length === 1 ? '' : 's'}${terms.length ? ` matching “${state.query}”` : ''}`;

  $('#list').innerHTML = items.slice(0, state.limit).map(({ a, s }) => cardHtml(a, s, terms)).join('');
  $('#moreBtn').hidden = items.length <= state.limit;

  const empty = !items.length && !picks.length;
  $('#empty').hidden = !empty;
  if (empty) {
    const msg = {
      saved: ['Nothing saved yet', 'Use the bookmark icon on any article to keep it here.'],
      liked: ['No likes yet', 'Thumbs-up articles you care about and they will show up here.'],
      hidden: ['Nothing hidden', 'Articles you mark as "less like this" end up here.'],
    }[state.view] ?? (terms.length
      ? ['No matches', 'Try a different search, or widen the time period.']
      : ['Nothing here yet', 'Try a wider time period or hit Refresh.']);
    $('#empty').innerHTML = `<strong>${esc(msg[0])}</strong>${esc(msg[1])}`;
  }
}

function renderMeta() {
  const ok = Object.values(state.sources).filter((s) => s.ok).length;
  const total = Object.keys(state.sources).length;
  $('#lastRefresh').textContent = state.lastRefresh
    ? `Updated ${timeAgo(state.lastRefresh)} · ${ok}/${total} sources`
    : 'Not refreshed yet';
}

function render() {
  renderPeriods();
  renderSidebar();
  renderList();
  renderMeta();
  $('#sort').value = state.sort;
  $('#hideRead').checked = state.hideRead;
}

// ---------- actions ----------
function findArticle(id) {
  return allKnownArticles().find((a) => a.id === id);
}
async function sendFeedback(id, patch) {
  const a = findArticle(id);
  const prev = state.feedback[id] ? { ...state.feedback[id] } : null;
  const next = { ...(state.feedback[id] ?? {}), ...patch, article: a, updatedAt: new Date().toISOString() };
  if (!next.vote && !next.saved) delete state.feedback[id]; else state.feedback[id] = next;
  render();
  try {
    const { entry } = await api('/api/feedback', { method: 'POST', body: JSON.stringify({ id, ...patch }) });
    if (entry) state.feedback[id] = entry;
  } catch (e) {
    if (prev) state.feedback[id] = prev; else delete state.feedback[id];
    render();
    toast(`Couldn't save feedback: ${e.message}`);
  }
}

function markRead(id) {
  if (state.read.has(id)) return;
  state.read.add(id);
  localStorage.setItem('dd:read', JSON.stringify([...state.read].slice(-3000)));
  setTimeout(render, 300);
}

document.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  const actBtn = e.target.closest('[data-act]');
  if (actBtn && card) {
    const id = card.dataset.id;
    const f = state.feedback[id] ?? {};
    const act = actBtn.dataset.act;
    if (act === 'like') {
      sendFeedback(id, { vote: f.vote === 1 ? 0 : 1 });
      if (f.vote !== 1) toast('Got it — you’ll see more like this.');
    } else if (act === 'dislike') {
      const was = f.vote ?? 0;
      sendFeedback(id, { vote: was === -1 ? 0 : -1 });
      if (was !== -1) toast('Hidden — you’ll see less like this.', { label: 'Undo', run: () => sendFeedback(id, { vote: was }) });
    } else if (act === 'save') {
      sendFeedback(id, { saved: !f.saved });
    }
    return;
  }
  const catBtn = e.target.closest('[data-cat]');
  if (catBtn) {
    state.category = catBtn.dataset.cat || null;
    state.limit = PAGE_SIZE;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const viewBtn = e.target.closest('[data-view]');
  if (viewBtn) {
    state.view = viewBtn.dataset.view;
    state.category = null;
    state.limit = PAGE_SIZE;
    render();
    return;
  }
  const periodBtn = e.target.closest('[data-period]');
  if (periodBtn) {
    state.period = periodBtn.dataset.period;
    state.limit = PAGE_SIZE;
    savePrefs();
    render();
    return;
  }
  if (card && !e.target.closest('button, input, select, label')) {
    e.preventDefault();
    openArticle(card.dataset.id);
  }
});
document.addEventListener('auxclick', (e) => {
  const card = e.target.closest('.card');
  if (card && e.target.closest('.title a')) markRead(card.dataset.id);
});

// Opens in the system browser via the local server, so it works even where pop-ups are blocked.
async function openArticle(id) {
  markRead(id);
  try {
    await api('/api/open', { method: 'POST', body: JSON.stringify({ id }) });
  } catch {
    const link = safeHttpUrl(findArticle(id)?.link);
    if (!link || !window.open(link, '_blank', 'noopener')) toast('Couldn’t open the article in a new window.');
  }
}
function safeHttpUrl(link) {
  try {
    const u = new URL(link);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}

document.addEventListener('change', (e) => {
  if (e.target.matches('[data-source]')) {
    const name = e.target.dataset.source;
    if (e.target.checked) state.mutedSources.delete(name); else state.mutedSources.add(name);
    savePrefs();
    render();
  }
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = e.target.value.trim(); state.limit = PAGE_SIZE; render(); }, 120);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#search')) { e.preventDefault(); $('#search').focus(); }
  if (e.key === 'Escape' && document.activeElement === $('#search')) { $('#search').value = ''; state.query = ''; render(); }
});
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; savePrefs(); render(); });
$('#hideRead').addEventListener('change', (e) => { state.hideRead = e.target.checked; savePrefs(); render(); });
$('#moreBtn').addEventListener('click', () => { state.limit += PAGE_SIZE; renderList(); });
$('#resetBtn').addEventListener('click', async () => {
  if (!confirm('Clear all likes and dislikes? Saved articles are kept.')) return;
  try {
    await api('/api/feedback/reset-votes', { method: 'POST' });
    state.feedback = await api('/api/feedback');
    render();
    toast('Interests reset.');
  } catch (e) {
    toast(`Couldn't reset: ${e.message}`);
  }
});
$('#refreshBtn').addEventListener('click', async () => {
  const btn = $('#refreshBtn');
  btn.classList.add('loading');
  btn.disabled = true;
  try {
    const before = new Set(state.articles.map((a) => a.id));
    await api('/api/refresh', { method: 'POST' });
    await load();
    const added = state.articles.filter((a) => !before.has(a.id)).length;
    toast(added ? `${added} new article${added === 1 ? '' : 's'}` : 'You’re all caught up.');
  } catch (e) {
    toast(`Refresh failed: ${e.message}`);
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
});

async function load() {
  const [data, feedback] = await Promise.all([api('/api/articles'), api('/api/feedback')]);
  Object.assign(state, { articles: data.articles, categories: data.categories, sources: data.sources, lastRefresh: data.lastRefresh, feedback });
  render();
}

load().catch((e) => {
  $('#empty').hidden = false;
  $('#empty').innerHTML = `<strong>Couldn't load articles</strong>${esc(e.message)}`;
});
setInterval(renderMeta, 60000);
