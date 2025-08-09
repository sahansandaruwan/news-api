// index.js - Fast, safe, no rss-parser dependency

const slugify = str => str.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
const stripHTML = html => html ? html.replace(/<[^>]+>/g, '').trim() : '';

async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal, cf: { cacheTtl: 600 } });
  } finally {
    clearTimeout(timeout);
  }
}

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

function parseRSS(xmlText) {
  try {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    const items = [...doc.querySelectorAll("item")];
    return items.map(item => ({
      title: item.querySelector("title")?.textContent || "No title",
      link: item.querySelector("link")?.textContent || "#",
      description: stripHTML(item.querySelector("description")?.textContent || ""),
      pubDate: item.querySelector("pubDate")?.textContent || null,
      source: doc.querySelector("channel > title")?.textContent || "Unknown source",
    }));
  } catch (e) {
    console.error("RSS parse error:", e.message);
    return [];
  }
}

async function parseRSSFeed(url) {
  try {
    const res = await fetchWithTimeout(url, 8000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xmlText = await res.text();
    return parseRSS(xmlText);
  } catch (err) {
    console.error(`Error fetching ${url}:`, err.message);
    return [];
  }
}

function deduplicateArticles(articles) {
  const seen = new Set();
  return articles.filter(article => {
    const key = `${article.title.toLowerCase()}|${article.source.toLowerCase()}|${article.pubDate || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applySearchFilter(articles, search) {
  if (!search) return articles;
  const lower = search.toLowerCase();
  return articles.filter(a =>
    a.title.toLowerCase().includes(lower) ||
    a.description.toLowerCase().includes(lower)
  );
}

function applySorting(articles, sort, order) {
  const asc = order === 'asc';
  return articles.sort((a, b) => {
    if (sort === 'title') {
      return asc ? a.title.localeCompare(b.title) : b.title.localeCompare(a.title);
    }
    const dateA = new Date(a.pubDate).getTime() || 0;
    const dateB = new Date(b.pubDate).getTime() || 0;
    return asc ? dateA - dateB : dateB - dateA;
  });
}

function paginate(articles, limit, page) {
  const start = (page - 1) * limit;
  return articles.slice(start, start + limit);
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 20, 100);
    const page = Math.max(parseInt(url.searchParams.get('page')) || 1, 1);
    const search = url.searchParams.get('search') || '';
    const sort = url.searchParams.get('sort') || 'pubDate';
    const order = (url.searchParams.get('order') || 'desc').toLowerCase();

    if (path.startsWith('/api/news')) {
      const category = path.split('/')[3] ? decodeURIComponent(path.split('/')[3]) : null;
      const cacheKey = category ? `news_${slugify(category)}` : 'news_all';

      let articles;
      try {
        articles = await env.KV.get(cacheKey, { type: 'json' });
      } catch {
        articles = null;
      }

      if (!articles) {
        const feedsToFetch = category
          ? RSS_FEEDS.filter(f => f.category.toLowerCase() === category.toLowerCase())
          : RSS_FEEDS;

        const results = await Promise.allSettled(feedsToFetch.map(async feed => {
          const parsed = await parseRSSFeed(feed.url);
          return parsed.map(a => ({ ...a, category: feed.category, source: feed.name }));
        }));

        articles = results
          .filter(r => r.status === 'fulfilled')
          .flatMap(r => r.value);

        articles = deduplicateArticles(articles);
        articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

        await env.KV.put(cacheKey, JSON.stringify(articles), { expirationTtl: 600 });
      }

      articles = applySearchFilter(articles, search);
      articles = applySorting(articles, sort, order);
      const paginated = paginate(articles, limit, page);

      return new Response(JSON.stringify({
        page, limit,
        totalResults: articles.length,
        totalPages: Math.ceil(articles.length / limit),
        articles: paginated
      }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    if (path === '/api/categories') {
      return new Response(JSON.stringify([...new Set(RSS_FEEDS.map(f => f.category))]), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    if (path.startsWith('/api/source/')) {
      const sourceName = decodeURIComponent(path.split('/')[3] || '');
      if (!sourceName) {
        return new Response(JSON.stringify({ error: 'Source required' }), { status: 400, headers: corsHeaders });
      }

      const cacheKey = `source_${slugify(sourceName)}`;
      let articles;
      try {
        articles = await env.KV.get(cacheKey, { type: 'json' });
      } catch {
        articles = null;
      }

      if (!articles) {
        const feed = RSS_FEEDS.find(f => f.name.toLowerCase() === sourceName.toLowerCase());
        if (!feed) {
          return new Response(JSON.stringify({ error: 'Source not found' }), { status: 404, headers: corsHeaders });
        }

        const parsed = await parseRSSFeed(feed.url);
        articles = deduplicateArticles(parsed.map(a => ({ ...a, category: feed.category, source: feed.name })));
        articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

        await env.KV.put(cacheKey, JSON.stringify(articles), { expirationTtl: 600 });
      }

      articles = applySearchFilter(articles, search);
      articles = applySorting(articles, sort, order);
      const paginated = paginate(articles, limit, page);

      return new Response(JSON.stringify({
        page, limit,
        totalResults: articles.length,
        totalPages: Math.ceil(articles.length / limit),
        articles: paginated
      }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    if (path === '/api/sources') {
      return new Response(JSON.stringify(RSS_FEEDS.map(f => ({ name: f.name, category: f.category }))), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: corsHeaders });
  }
};
