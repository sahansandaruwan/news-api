import Parser from 'rss-parser';
const parser = new Parser();

// Slugify helper for cache keys
const slugify = str => str.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

// HTML stripping helper
const stripHTML = html => html ? html.replace(/<[^>]+>/g, '').trim() : '';

// Fetch with timeout helper
async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal, cf: { cacheTtl: 600 } });
  } finally {
    clearTimeout(timeout);
  }
}

// RSS Feeds configuration
const RSS_FEEDS = [
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'Technology' },
  { name: 'Wired', url: 'https://www.wired.com/feed/rss', category: 'Technology' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'Technology' },
  { name: 'BBC World', url: 'http://feeds.bbci.co.uk/news/world/rss.xml', category: 'World News' },
  { name: 'CNN Top Stories', url: 'http://rss.cnn.com/rss/edition.rss', category: 'World News' },
  { name: 'TMZ', url: 'https://www.tmz.com/rss.xml', category: 'Celebrity Gossip' },
  { name: 'WikiHow', url: 'https://www.wikihow.com/feed.rss', category: 'How-To & DIY' },
  { name: 'OpenAI Blog', url: 'https://openai.com/blog/rss.xml', category: 'AI & Machine Learning' },
  { name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml', category: 'Science' },
  { name: 'Yahoo! Sports', url: 'https://sports.yahoo.com/rss/', category: 'Sports' },
];

// Parse RSS feed safely
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

// Per-endpoint rate limiting
async function checkRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const path = new URL(request.url).pathname;
  const key = `rate_limit_${ip}_${slugify(path)}`;
  
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxRequests = 100;

  let data = await env.KV.get(key, { type: 'json' }) || { count: 0, reset: now + windowMs };
  if (now > data.reset) {
    data = { count: 0, reset: now + windowMs };
  }
  if (data.count >= maxRequests) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  data.count++;
  await env.KV.put(key, JSON.stringify(data), { expirationTtl: Math.floor(windowMs / 1000) });
  return null;
}

export default {
  async fetch(request, env) {
    // CORS setup
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Rate limit check
    const rateLimitResponse = await checkRateLimit(request, env);
    if (rateLimitResponse) return rateLimitResponse;

    const url = new URL(request.url);
    const path = url.pathname;

    // Get all news or by category
    if (path.startsWith('/api/news')) {
      const category = path.split('/')[3] ? decodeURIComponent(path.split('/')[3]) : null;
      const cacheKey = category ? `news_${slugify(category)}` : 'news_all';

      let articles = await env.KV.get(cacheKey, { type: 'json' });
      if (articles) {
        return new Response(JSON.stringify(articles), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      const feedsToFetch = category
        ? RSS_FEEDS.filter(feed => feed.category.toLowerCase() === category.toLowerCase())
        : RSS_FEEDS;

      if (!feedsToFetch.length) {
        return new Response(JSON.stringify({ error: 'Category not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      const feedPromises = feedsToFetch.map(async feed => {
        const parsedArticles = await parseRSSFeed(feed.url);
        return parsedArticles.map(article => ({
          ...article,
          category: feed.category,
          source: feed.name
        }));
      });

      articles = (await Promise.all(feedPromises)).flat();

      // Sort by date with fallback
      articles.sort((a, b) => {
        const dateA = new Date(a.pubDate).getTime() || 0;
        const dateB = new Date(b.pubDate).getTime() || 0;
        return dateB - dateA;
      });

      await env.KV.put(cacheKey, JSON.stringify(articles), { expirationTtl: 600 });
      return new Response(JSON.stringify(articles), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // Get news by source
    if (path.startsWith('/api/source')) {
      const source = decodeURIComponent(path.split('/')[3]);
      const cacheKey = `source_${slugify(source)}`;

      let articles = await env.KV.get(cacheKey, { type: 'json' });
      if (articles) {
        return new Response(JSON.stringify(articles), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      const feed = RSS_FEEDS.find(f => f.name.toLowerCase() === source.toLowerCase());
      if (!feed) {
        return new Response(JSON.stringify({ error: 'Source not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      articles = await parseRSSFeed(feed.url);
      articles = articles.map(article => ({
        ...article,
        category: feed.category,
        source: feed.name
      }));

      await env.KV.put(cacheKey, JSON.stringify(articles), { expirationTtl: 600 });
      return new Response(JSON.stringify(articles), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // List categories
    if (path === '/api/categories') {
      const categories = [...new Set(RSS_FEEDS.map(feed => feed.category))];
      return new Response(JSON.stringify(categories), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // List sources
    if (path === '/api/sources') {
      const sources = RSS_FEEDS.map(feed => ({ name: feed.name, category: feed.category }));
      return new Response(JSON.stringify(sources), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
};
