/**
 * Advanced News API Worker
 *
 * Features:
 *  - Optional OpenAI integration for summaries & sentiment (controlled by OPENAI_API_KEY env var)
 *  - Local fallback summarizer / keyword extractor / sentiment analyzer
 *  - API-key auth + per-key rate-limits (stored in KV)
 *  - Trending detection (recency + mention frequency)
 *  - Image extraction (media:content, enclosure, inline <img>)
 *  - Date range, multi-category, exclude-source filters
 *  - Partial feed refresh & caching (KV)
 *
 * Required bindings:
 *  - KV (KV Namespace binding)
 * Optional env:
 *  - OPENAI_API_KEY (if you want AI summaries/sentiment)
 *
 * Notes:
 *  - Ensure your worker's `main` is this file and KV binding name matches your cf config.
 *  - Configure cron to refresh caches periodically (recommended).
 */

import Parser from 'rss-parser';
const parser = new Parser();

// ---------------- CONFIG ----------------
const CONFIG = {
  FETCH_TIMEOUT_MS: 8000,
  CACHE_TTL_SEC: 600,         // seconds (10 min)
  FEED_STALE_SEC: 300,        // when to consider feed stale
  RATE_WINDOW_MS: 15 * 60 * 1000,
  RATE_LIMIT_DEFAULT: 100,
  RATE_LIMIT_PREMIUM: 1000,
  MAX_LIMIT: 100,
  RETRY_ATTEMPTS: 2,
  OPENAI_MODEL: 'gpt-4o-mini', // change as desired
  TRENDING_WINDOW_HOURS: 24,
  TRENDING_WEIGHT_RECENT: 1.5,
};

// ---------------- FEEDS (edit as needed) ----------------
const RSS_FEEDS = [
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'Technology' },
  { name: 'Wired', url: 'https://www.wired.com/feed/rss', category: 'Technology' },
  { name: 'BBC World', url: 'http://feeds.bbci.co.uk/news/world/rss.xml', category: 'World News' },
  { name: 'TMZ', url: 'https://www.tmz.com/rss.xml', category: 'Celebrity Gossip' },
  { name: 'WikiHow', url: 'https://www.wikihow.com/feed.rss', category: 'How-To & DIY' },
  { name: 'OpenAI Blog', url: 'https://openai.com/blog/rss.xml', category: 'AI & Machine Learning' },
  { name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml', category: 'Science' },
  { name: 'Yahoo! Sports', url: 'https://sports.yahoo.com/rss/', category: 'Sports' },
];

// ---------------- HELPERS ----------------
const slugify = s => (s || '').toString().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
const stripHTML = html => html ? html.replace(/<[^>]+>/g, '').trim() : '';
const now = () => Date.now();
const secs = ms => Math.floor(ms / 1000);

async function fetchWithTimeout(url, ms = CONFIG.FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, cf: { cacheTtl: CONFIG.CACHE_TTL_SEC } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function retryFetch(url, retries = CONFIG.RETRY_ATTEMPTS) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchWithTimeout(url);
    } catch (err) {
      lastErr = err;
      console.warn(`fetch attempt ${i + 1} for ${url} failed:`, err.message);
      if (i < retries) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

// ------------------------------------------------------------------
// Lightweight local NLP helpers (fallback if OPENAI not provided)
// ------------------------------------------------------------------

const STOPWORDS = new Set([
  'the','is','at','which','on','and','a','an','of','in','to','for','with','by','from','that','this','it','as','are','was','be','or','will','has','have','but','not'
]);

function extractKeywords(text, n = 6) {
  if (!text) return [];
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);
  const freq = {};
  for (const w of words) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0, n).map(t => t[0]);
}

// Basic sentiment lexicon (tiny) - positive/negative words, fallback only
const POS = new Set(['good','great','positive','improved','win','wins','won','success','benefit','beneficial','best','upgraded','happy','love']);
const NEG = new Set(['bad','worse','worst','loss','lost','fail','failed','danger','problem','negative','angry','hate','decline','drop','crash']);

function naiveSentiment(text) {
  if (!text) return { score: 0, label: 'neutral' };
  const words = text.toLowerCase().split(/\W+/);
  let score = 0;
  for (const w of words) {
    if (POS.has(w)) score += 1;
    if (NEG.has(w)) score -= 1;
  }
  let label = 'neutral';
  if (score > 0) label = 'positive';
  else if (score < 0) label = 'negative';
  return { score, label };
}

// Extract image from item fields / content
function extractImage(item) {
  // media:content, enclosure, thumbnail
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  if (item['media:content'] && item['media:content']['$'] && item['media:content']['$'].url) return item['media:content']['$'].url;
  if (item['media:thumbnail'] && item['media:thumbnail'].url) return item['media:thumbnail'].url;
  // try to parse <img> in content
  const html = item.content || item['content:encoded'] || item.description || '';
  const m = html.match(/<img[^>]+src="([^">]+)"/i);
  if (m) return m[1];
  return null;
}

// ---------------- OpenAI integration (optional) ----------------
// Uses env.OPENAI_API_KEY via fetch to OpenAI (recommended: use official client or keep key safe).
async function openaiRequest(env, prompt, type = 'summary') {
  if (!env.OPENAI_API_KEY) throw new Error('OpenAI key missing');
  // Simple GPT-style call: you may change to new API endpoints as needed.
  const payload = {
    model: CONFIG.OPENAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 200
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  return content || '';
}

// safe wrapper that tries OpenAI and falls back to local methods
async function summarizeArticle(env, item) {
  const text = (item.title || '') + '\n\n' + (item.description || '');
  try {
    if (env.OPENAI_API_KEY) {
      const prompt = `Summarize the following article into 2-3 short sentences (user-facing):\n\n${stripHTML(text)}`;
      const ai = await openaiRequest(env, prompt, 'summary');
      if (ai && ai.trim()) return ai.trim();
    }
  } catch (err) {
    console.warn('OpenAI summarize failed:', err.message);
  }
  // fallback naive summary: first 2 sentences
  const sentences = stripHTML(text).split(/(?<=[.?!])\s+/).filter(Boolean);
  return sentences.slice(0, 2).join(' ').slice(0, 300);
}

async function analyzeSentiment(env, item) {
  const text = (item.title || '') + ' ' + (item.description || '');
  try {
    if (env.OPENAI_API_KEY) {
      const prompt = `Label sentiment (positive/negative/neutral) and give a short score for this text:\n\n${stripHTML(text)}\n\nRespond in JSON: {"label": "...", "score": -1..1}`;
      const ai = await openaiRequest(env, prompt, 'sentiment');
      // try JSON parse
      try {
        const parsed = JSON.parse(ai);
        return parsed;
      } catch { /* fallthrough to naive */ }
    }
  } catch (err) {
    console.warn('OpenAI sentiment failed:', err.message);
  }
  return naiveSentiment(stripHTML(text));
}

// ---------------- RSS parsing ----------------
async function parseRSSFeed(url, sourceName, category) {
  try {
    const xml = await retryFetch(url);
    const feed = await parser.parseString(xml);
    return (feed.items || []).map(item => ({
      id: item.guid || item.id || (item.link || item.title).slice(0, 250),
      title: item.title || 'No title',
      link: item.link || '#',
      description: stripHTML(item.description || item.contentSnippet || item['content:encoded'] || ''),
      pubDate: item.pubDate || item.isoDate || null,
      source: sourceName || feed.title || 'Unknown',
      category: category || 'Uncategorized',
      raw: item,
    }));
  } catch (err) {
    console.error(`parseRSSFeed failed for ${url}:`, err.message);
    return [];
  }
}

// ---------------- CACHING & KV helpers ----------------
async function kvGet(env, key) {
  try {
    return await env.KV.get(key, { type: 'json' });
  } catch (err) {
    console.warn('KV get failed', key, err.message);
    return null;
  }
}
async function kvPut(env, key, value, ttlSec = CONFIG.CACHE_TTL_SEC) {
  try {
    await env.KV.put(key, JSON.stringify(value), { expirationTtl: ttlSec });
  } catch (err) {
    console.warn('KV put failed', key, err.message);
  }
}

// ---------------- RATE LIMIT & API KEY ----------------
// API keys stored in KV with prefix "apikey:{key}" value: { tier: 'default'|'premium', quota: number, resetAt: timestamp }
async function authorize(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth) return { ok: false, code: 401, message: 'Missing Authorization header' };
  const [scheme, key] = auth.split(' ');
  if (!key) return { ok: false, code: 401, message: 'Malformed Authorization header' };

  const rec = await kvGet(env, `apikey:${key}`);
  if (!rec) return { ok: false, code: 403, message: 'Invalid API key' };

  // rate limiting per key
  const tier = rec.tier || 'default';
  const max = tier === 'premium' ? CONFIG.RATE_LIMIT_PREMIUM : CONFIG.RATE_LIMIT_DEFAULT;
  const nowMs = Date.now();
  const windowKey = `rl:${key}:${Math.floor(nowMs / CONFIG.RATE_WINDOW_MS)}`;
  let bucket = await kvGet(env, windowKey) || { count: 0, reset: nowMs + CONFIG.RATE_WINDOW_MS };
  if (bucket.count >= max) {
    return { ok: false, code: 429, message: 'Rate limit exceeded', retryAfter: Math.ceil((bucket.reset - nowMs)/1000) };
  }
  bucket.count++;
  await kvPut(env, windowKey, bucket, Math.ceil(CONFIG.RATE_WINDOW_MS / 1000));
  return { ok: true, key, tier };
}

// ---------------- TRENDING ----------------
// Simple trending: score = sum of recency-weighted occurrences of keywords + recency of article
function computeTrendingScores(articles) {
  const scores = articles.map(a => {
    const pub = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const ageHours = (Date.now() - pub) / (1000 * 60 * 60);
    // recencyScore: more recent = higher, controlled by TRENDING_WINDOW_HOURS
    const recencyScore = Math.max(0, CONFIG.TRENDING_WINDOW_HOURS - ageHours) / CONFIG.TRENDING_WINDOW_HOURS;
    // keywordScore: number of keywords found in title/desc (naive)
    const keywords = extractKeywords((a.title || '') + ' ' + (a.description || ''), 10);
    const keywordScore = keywords.length * 0.1;
    const score = recencyScore * CONFIG.TRENDING_WEIGHT_RECENT + keywordScore;
    return { id: a.id, title: a.title, link: a.link, source: a.source, score, pubDate: a.pubDate };
  });
  return scores.sort((x,y) => y.score - x.score);
}

// ---------------- API Handlers ----------------
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS, POST, PUT, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);
    const pathname = url.pathname;
    try {
      // short-circuit endpoints
      if (pathname === '/api/health') {
        return new Response(JSON.stringify({ ok: true, ts: Date.now() }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // require API key for most endpoints except /api/categories and /api/sources & health
      if (!['/api/categories','/api/sources','/api/health'].includes(pathname)) {
        const auth = await authorize(request, env);
        if (!auth.ok) return new Response(JSON.stringify({ error: auth.message, retryAfter: auth.retryAfter || null }), { status: auth.code || 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // parse query params
      const params = url.searchParams;
      const limit = Math.min(parseInt(params.get('limit') || '20', 10) || 20, CONFIG.MAX_LIMIT);
      const page = Math.max(parseInt(params.get('page') || '1', 10) || 1, 1);
      const search = params.get('search') || '';
      const sort = params.get('sort') || 'pubDate';
      const order = (params.get('order') || 'desc').toLowerCase();
      const from = params.get('from') ? new Date(params.get('from')).getTime() : null;
      const to = params.get('to') ? new Date(params.get('to')).getTime() : null;
      const categories = params.get('categories') ? params.get('categories').split(',').map(s => s.trim().toLowerCase()) : null;
      const exclude = params.get('exclude') ? params.get('exclude').split(',').map(s => s.trim().toLowerCase()) : [];

      if (pathname.startsWith('/api/news')) {
        // optional path /api/news/<category>
        const parts = pathname.split('/').filter(Boolean);
        const pathCat = parts[1] === 'news' && parts[2] ? decodeURIComponent(parts[2]) : null;

        // cache key: news_all or cat_<slug>
        const cacheKey = pathCat ? `news_cat:${slugify(pathCat)}` : 'news_all';
        let articles = await kvGet(env, cacheKey);

        if (!articles) {
          // determine feeds to fetch
          let feeds = RSS_FEEDS;
          if (pathCat) feeds = RSS_FEEDS.filter(f => f.category.toLowerCase() === pathCat.toLowerCase());
          if (categories && categories.length) {
            feeds = RSS_FEEDS.filter(f => categories.includes(f.category.toLowerCase()));
          }
          if (!feeds.length) return new Response(JSON.stringify({ error: 'No feeds for requested category' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

          // fetch in parallel
          const fetched = await Promise.all(feeds.map(f => parseRSSFeed(f.url, f.name, f.category)));
          articles = fetched.flat();

          // enrich each article: image, keywords, (deferred: summary & sentiment)
          articles = articles.map(a => {
            const img = extractImage(a.raw || {});
            const keywords = extractKeywords((a.title||'') + ' ' + (a.description||''), 8);
            return { ...a, image: img, keywords, fetchedAt: Date.now() };
          });

          // deduplicate by id/title+source+pub
          const seen = new Set();
          articles = articles.filter(a => {
            const key = `${(a.id||a.title||'').toString().toLowerCase()}|${(a.source||'').toLowerCase()}|${a.pubDate||''}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          // sort by pubDate desc
          articles.sort((x,y) => (new Date(y.pubDate).getTime()||0) - (new Date(x.pubDate).getTime()||0));

          await kvPut(env, cacheKey, articles, CONFIG.CACHE_TTL_SEC);
        }

        // apply excludes and date range, search
        let filtered = articles.filter(a => !exclude.includes((a.source||'').toLowerCase()));
        if (from || to) filtered = filtered.filter(a => {
          const p = a.pubDate ? new Date(a.pubDate).getTime() : 0;
          if (from && p < from) return false;
          if (to && p > to) return false;
          return true;
        });
        if (search) {
          const s = search.toLowerCase();
          filtered = filtered.filter(a => (a.title||'').toLowerCase().includes(s) || (a.description||'').toLowerCase().includes(s) || (a.keywords||[]).some(k => k.includes(s)));
        }

        // optionally enrich with summary & sentiment on demand (deferred to keep response cheap)
        const enrich = params.get('enrich') === '1' || params.get('enrich') === 'true';
        if (enrich) {
          // enrich only the page articles to reduce cost
          const start = (page - 1) * limit;
          const slice = filtered.slice(start, start + limit);
          // run enrichment in parallel but bounded
          const enriched = await Promise.all(slice.map(async a => {
            try {
              const summary = await summarizeArticle(env, a);
              const sentiment = await analyzeSentiment(env, a);
              const keywords = a.keywords && a.keywords.length ? a.keywords : extractKeywords((a.title||'') + ' ' + (a.description||''), 8);
              return { ...a, summary, sentiment, keywords };
            } catch (err) {
              console.warn('Enrich failed for', a.title, err.message);
              return { ...a, summary: null, sentiment: null };
            }
          }));
          // inject enriched slice into filtered for pagination response
          filtered.splice((page - 1) * limit, enriched.length, ...enriched);
        }

        // sorting
        if (sort) {
          filtered.sort((a,b) => {
            if (sort === 'title') return order === 'asc' ? a.title.localeCompare(b.title) : b.title.localeCompare(a.title);
            // pubDate default
            const da = new Date(a.pubDate).getTime() || 0;
            const db = new Date(b.pubDate).getTime() || 0;
            return order === 'asc' ? da - db : db - da;
          });
        }

        // pagination
        const total = filtered.length;
        const totalPages = Math.ceil(total / limit);
        const start = (page - 1) * limit;
        const pageItems = filtered.slice(start, start + limit);

        return new Response(JSON.stringify({
          success: true,
          page, limit, totalResults: total, totalPages,
          articles: pageItems,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (pathname.startsWith('/api/source')) {
        // /api/source/<sourceName>
        const parts = pathname.split('/').filter(Boolean);
        const sourceName = parts[1] === 'source' && parts[2] ? decodeURIComponent(parts[2]) : null;
        if (!sourceName) return new Response(JSON.stringify({ error: 'Source required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const feed = RSS_FEEDS.find(f => f.name.toLowerCase() === sourceName.toLowerCase());
        if (!feed) return new Response(JSON.stringify({ error: 'Source not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const cacheKey = `src:${slugify(feed.name)}`;
        let articles = await kvGet(env, cacheKey);
        if (!articles) {
          articles = await parseRSSFeed(feed.url, feed.name, feed.category);
          articles = articles.map(a => ({ ...a, image: extractImage(a.raw || {}), keywords: extractKeywords((a.title||'') + ' ' + (a.description||''), 8), fetchedAt: Date.now() }));
          await kvPut(env, cacheKey, articles, CONFIG.CACHE_TTL_SEC);
        }

        // apply search/pagination similar to /api/news
        let filtered = articles;
        if (params.get('search')) {
          const s = params.get('search').toLowerCase();
          filtered = filtered.filter(a => (a.title||'').toLowerCase().includes(s) || (a.description||'').toLowerCase().includes(s));
        }

        // optionally enrich
        if (params.get('enrich') === '1') {
          const slice = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);
          const enriched = await Promise.all(slice.map(async a => {
            const summary = await summarizeArticle(env, a);
            const sentiment = await analyzeSentiment(env, a);
            return { ...a, summary, sentiment };
          }));
          filtered.splice((page - 1) * limit, enriched.length, ...enriched);
        }

        const pageItems = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);
        return new Response(JSON.stringify({ success: true, page, limit, totalResults: filtered.length, totalPages: Math.ceil(filtered.length/limit), articles: pageItems }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/categories') {
        const cats = [...new Set(RSS_FEEDS.map(f => f.category))];
        return new Response(JSON.stringify(cats), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/sources') {
        const srcs = RSS_FEEDS.map(f => ({ name: f.name, category: f.category }));
        return new Response(JSON.stringify(srcs), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/trending') {
        // compute trending from cached 'news_all' or recalc
        let articles = await kvGet(env, 'news_all');
        if (!articles) {
          // try to fetch minimal: parse feeds titles only (faster)
          const fetched = await Promise.all(RSS_FEEDS.map(f => parseRSSFeed(f.url, f.name, f.category)));
          articles = fetched.flat().map(a => ({ ...a, keywords: extractKeywords((a.title||'') + ' ' + (a.description||''), 8) }));
          await kvPut(env, 'news_all', articles, CONFIG.CACHE_TTL_SEC);
        }
        const scores = computeTrendingScores(articles).slice(0, params.get('limit') ? parseInt(params.get('limit')) : 20);
        return new Response(JSON.stringify({ success: true, trending: scores }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (pathname.startsWith('/api/user')) {
        // Example: /api/user/saved (GET/POST), /api/user/prefs
        // We'll use KV keys per API key: user:{apikey}:saved and user:{apikey}:prefs
        const authHeader = request.headers.get('Authorization') || '';
        const key = authHeader.split(' ')[1];
        if (!key) return new Response(JSON.stringify({ error: 'Missing auth' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const userSavedKey = `user:${key}:saved`;
        const userPrefsKey = `user:${key}:prefs`;

        if (pathname === '/api/user/saved') {
          if (request.method === 'GET') {
            const saved = await kvGet(env, userSavedKey) || [];
            return new Response(JSON.stringify({ success: true, saved }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          if (request.method === 'POST') {
            const body = await request.json();
            // simple validation
            if (!body || !body.article) return new Response(JSON.stringify({ error: 'article required in body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
            const saved = await kvGet(env, userSavedKey) || [];
            saved.unshift(body.article);
            await kvPut(env, userSavedKey, saved, 60 * 60 * 24 * 30); // 30 days
            return new Response(JSON.stringify({ success: true, saved }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
        }

        if (pathname === '/api/user/prefs') {
          if (request.method === 'GET') {
            const prefs = await kvGet(env, userPrefsKey) || {};
            return new Response(JSON.stringify({ success: true, prefs }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          if (request.method === 'PUT') {
            const body = await request.json();
            await kvPut(env, userPrefsKey, body || {}, 60 * 60 * 24 * 30);
            return new Response(JSON.stringify({ success: true, prefs: body }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
        }

        return new Response(JSON.stringify({ error: 'User endpoint not found or method not allowed' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (pathname === '/api/stream') {
        // SSE skeleton: simple implementation which will keep connection open and stream events.
        // NOTE: Cloudflare Workers has limitations for long-lived connections, but this gives a basic pattern.
        if (request.method !== 'GET') return new Response(null, { status: 405 });
        const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...corsHeaders };
        const stream = new ReadableStream({
          async start(controller) {
            // Immediately send a comment to keep connection alive
            controller.enqueue(encoder().encode(':ok\n\n'));
            // Example: send a ping every 15s
            const interval = setInterval(() => {
              controller.enqueue(encoder().encode(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`));
            }, 15000);
            // After some time (e.g., 10 minutes) close - avoid truly infinite
            setTimeout(() => {
              clearInterval(interval);
              controller.close();
            }, 10 * 60 * 1000);
          }
        });
        return new Response(stream, { headers });
      }

      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (err) {
      console.error('Unhandled API error:', err.stack || err.message);
      return new Response(JSON.stringify({ error: 'Internal Server Error', details: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }
};

// small helper for encoder inside /api/stream
function encoder() {
  return new TextEncoder();
}
