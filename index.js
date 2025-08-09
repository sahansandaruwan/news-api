import Parser from 'rss-parser';
const parser = new Parser();

const slugify = str =>
  str.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

const stripHTML = html =>
  html ? html.replace(/<[^>]+>/g, '').trim() : '';

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
  { name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml', category: 'Science' },
  { name: 'Yahoo! Sports', url: 'https://sports.yahoo.com/rss/', category: 'Sports' },
];

async function parseRSSFeed(url) {
  try {
    const response = await fetchWithTimeout(url, 8000);
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const text = await response.text();
    const feed = await parser.parseString(text);
    return feed.items.map(item => ({
      title: item.title || 'No title',
      link: item.link || '#',
      description: stripHTML(item.description || item.contentSnippet || 'No description'),
      pubDate: item.pubDate || null,
      source: feed.title || 'Unknown source',
    }));
  } catch (error) {
    console.error(`Error parsing RSS feed ${url}:`, error.message);
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
  const lowerSearch = search.toLowerCase();
  return articles.filter(a =>
    a.title.toLowerCase().includes(lowerSearch) ||
    a.description.toLowerCase().includes(lowerSearch)
  );
}

function applySorting(articles, sort, order) {
  const asc = order === 'asc';
  return articles.sort((a, b) => {
    if (sort === 'title') {
      return asc
        ? a.title.localeCompare(b.title)
        : b.title.localeCompare(a.title);
    }
    const dateA = new Date(a.pubDate).getTime() || 0;
    const dateB = new Date(b.pubDate).getTime() || 0;
    return asc ? dateA - dateB : dateB - dateA;
  });
}

function paginate(articles, limit = 20, page = 1) {
  const start = (page - 1) * limit;
  return articles.slice(start, start + limit);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async scheduled(event, env) {
    // Fetch all feeds in parallel
    const promises = RSS_FEEDS.map(async feed => {
      try {
        const articles = await parseRSSFeed(feed.url);
        const enriched = articles.map(article => ({
          ...article,
          category: feed.category,
          source: feed.name,
        }));
        const deduped = deduplicateArticles(enriched);
        deduped.sort((a, b) => {
          const dateA = new Date(a.pubDate).getTime() || 0;
          const dateB = new Date(b.pubDate).getTime() || 0;
          return dateB - dateA;
        });
        await env.KV.put(`feed_${slugify(feed.name)}`, JSON.stringify(deduped), { expirationTtl: 3600 });
      } catch (e) {
        console.error(`Error caching feed ${feed.name}:`, e.message);
      }
    });

    await Promise.all(promises);
  },

  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const params = url.searchParams;

    const limit = Math.min(parseInt(params.get('limit')) || 20, 100);
    const page = Math.max(parseInt(params.get('page')) || 1, 1);
    const search = params.get('search') || '';
    const sort = params.get('sort') || 'pubDate';
    const order = (params.get('order') || 'desc').toLowerCase();

    if (path.startsWith('/api/news')) {
      const parts = path.split('/');
      const category = parts[3] ? decodeURIComponent(parts[3]) : null;

      let cachedArticles = [];

      if (category) {
        const feedsForCategory = RSS_FEEDS.filter(f => f.category.toLowerCase() === category.toLowerCase());
        if (feedsForCategory.length === 0) {
          return new Response(JSON.stringify({ error: 'Category not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
        for (const feed of feedsForCategory) {
          const cached = await env.KV.get(`feed_${slugify(feed.name)}`, { type: 'json' });
          if (cached && Array.isArray(cached)) cachedArticles = cachedArticles.concat(cached);
        }
      } else {
        for (const feed of RSS_FEEDS) {
          const cached = await env.KV.get(`feed_${slugify(feed.name)}`, { type: 'json' });
          if (cached && Array.isArray(cached)) cachedArticles = cachedArticles.concat(cached);
        }
      }

      if (cachedArticles.length === 0) {
        return new Response(JSON.stringify({ error: 'No cached articles available yet. Please try again later.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      cachedArticles = deduplicateArticles(cachedArticles);
      cachedArticles = applySearchFilter(cachedArticles, search);
      cachedArticles = applySorting(cachedArticles, sort, order);
      const paginated = paginate(cachedArticles, limit, page);

      return new Response(JSON.stringify({
        page,
        limit,
        totalResults: cachedArticles.length,
        totalPages: Math.ceil(cachedArticles.length / limit),
        articles: paginated,
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    if (path.startsWith('/api/source')) {
      const parts = path.split('/');
      if (!parts[3]) {
        return new Response(JSON.stringify({ error: 'Source required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      const source = decodeURIComponent(parts[3]);
      const feed = RSS_FEEDS.find(f => f.name.toLowerCase() === source.toLowerCase());
      if (!feed) {
        return new Response(JSON.stringify({ error: 'Source not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      const cachedArticles = await env.KV.get(`feed_${slugify(feed.name)}`, { type: 'json' });
      if (!cachedArticles) {
        return new Response(JSON.stringify({ error: 'No cached articles available yet. Please try again later.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      let articles = cachedArticles;
      articles = applySearchFilter(articles, search);
      articles = applySorting(articles, sort, order);
      const paginated = paginate(articles, limit, page);

      return new Response(JSON.stringify({
        page,
        limit,
        totalResults: articles.length,
        totalPages: Math.ceil(articles.length / limit),
        articles: paginated,
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    if (path === '/api/categories') {
      const categories = [...new Set(RSS_FEEDS.map(f => f.category))];
      return new Response(JSON.stringify(categories), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    if (path === '/api/sources') {
      const sources = RSS_FEEDS.map(f => ({ name: f.name, category: f.category }));
      return new Response(JSON.stringify(sources), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  },
};
