import Parser from 'rss-parser';
import sanitizeHtml from 'sanitize-html';

const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', {keepArray: true}],
      ['media:thumbnail', 'mediaThumbnail', {keepArray: true}],
      ['enclosure', 'enclosure', {keepArray: true}],
      ['content:encoded', 'contentEncoded'],
    ]
  }
});

// Configuration constants
const CONFIG = {
  FETCH_TIMEOUT_MS: 8000,
  CACHE_TTL_SECONDS: 600,
  RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000,
  RATE_LIMIT_MAX_REQUESTS: 100,
  MAX_ARTICLES_PER_FEED: 50,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
  CACHE_VERSION: 'v1',
};

// Utility functions
const slugify = str =>
  str.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');

const stripHTML = html =>
  html ? sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim() : '';

async function fetchWithTimeout(url, ms = CONFIG.FETCH_TIMEOUT_MS, retries = 2, fetchOptions = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal, cf: { cacheTtl: CONFIG.CACHE_TTL_SECONDS } });
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    return response;
  } catch (error) {
    if (retries > 0 && error.name === 'AbortError') {
      console.warn(`Retrying fetch for ${url}, retries left: ${retries}`);
      return fetchWithTimeout(url, ms, retries - 1, fetchOptions);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// RSS feed configuration (same as original)
const RSS_FEEDS = [
  { name: 'BBC News - World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'News', description: 'International news, features, and analysis from regions like Africa, Asia-Pacific, Europe, and more.' },
  { name: 'The New York Times - World', url: 'https://www.nytimes.com/svc/collections/v1/publish/www.nytimes.com/section/world/rss.xml', category: 'News', description: 'Breaking news and multimedia on global events, covering Africa, Asia, Europe, and the Middle East.' },
  { name: 'CNN - Top Stories', url: 'https://rss.cnn.com/rss/edition_world.rss', category: 'News', description: 'Top stories and breaking news from a major global news outlet.' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed', category: 'Technology', description: 'Covers startups, internet products, and breaking tech news with in-depth reporting.' },
  { name: 'Wired', url: 'https://www.wired.com/feed/rss', category: 'Technology', description: 'Focuses on emerging technologies, their impact on culture, economy, and politics.' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'Technology', description: 'In-depth reporting on technology, science, art, and culture with product reviews.' },
  { name: 'Apartment Therapy', url: 'https://www.apartmenttherapy.com/main.rss', category: 'Lifestyle', description: 'Covers lifestyle and interior design with DIY tips, home tours, and shopping guides.' },
  { name: 'Cup of Jo', url: 'https://feeds.feedburner.com/blogspot/cupofjo', category: 'Lifestyle', description: 'A daily blog on fashion, beauty, design, food, and parenting with personal stories.' },
  { name: 'Billboard', url: 'https://www.billboard.com/feed', category: 'Entertainment', description: 'Music industry news, charts, and updates with a focus on artists and trends.' },
  { name: 'NME', url: 'https://www.nme.com/feed', category: 'Entertainment', description: 'Music and pop culture news, reviews, videos, and band features.' },
  { name: 'Harvard Business Review', url: 'https://feeds.hbr.org/harvardbusiness', category: 'Business', description: 'Insights on strategy, innovation, and leadership for business professionals.' },
  { name: 'Entrepreneur', url: 'https://www.entrepreneur.com/latest.rss', category: 'Business', description: 'News, tips, and tools for entrepreneurs to build and grow businesses.' },
  { name: 'This American Life', url: 'https://feeds.thisamericanlife.org/talpodcast', category: 'Podcasts', description: 'Storytelling and journalism with a wide range of topics and voices.' },
  { name: 'Science – Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/science', category: 'science', description: 'Serving the Technologist since 1998. News, reviews, and analysis.' },
];

// Extract image from RSS item
function extractImage(item, feedLink) {
  let image = null;

  // media:content with medium=image or type=image/*
  if (item.mediaContent && item.mediaContent.length > 0) {
    const imgMedia = item.mediaContent.find(m => 
      m.$?.medium === 'image' || m.$?.type?.startsWith('image/')
    );
    if (imgMedia) image = imgMedia.$?.url;
  }

  // media:thumbnail
  if (!image && item.mediaThumbnail && item.mediaThumbnail.length > 0) {
    const thumb = item.mediaThumbnail[0];
    if (thumb && thumb.$?.url) image = thumb.$?.url;
  }

  // enclosure with type=image/*
  if (!image && item.enclosure && item.enclosure.length > 0) {
    const imgEnc = item.enclosure.find(e => e.$?.type?.startsWith('image/'));
    if (imgEnc) image = imgEnc.$?.url;
  }

  // Fallback: parse <img> from content:encoded or description
  if (!image) {
    const html = item.contentEncoded || item.description || '';
    const match = html.match(/<img[^>]*src\s*=\s*["']([^"']+)["']/i);
    if (match) image = match[1];
  }

  // Resolve relative URLs
  if (image && feedLink) {
    try {
      image = new URL(image, feedLink).href;
    } catch (e) {
      // If invalid, keep as is
    }
  }

  return image;
}

// Parse and clean RSS feed with image extraction and optional verification
async function parseRSSFeed(feed, verifyImages = false) {
  try {
    const response = await fetchWithTimeout(feed.url);
    const text = await response.text();
    const parsed = await parser.parseString(text);

    let articles = parsed.items.slice(0, CONFIG.MAX_ARTICLES_PER_FEED).map(item => ({
      title: item.title || 'No title',
      link: item.link || '#',
      description: stripHTML(item.description || item.contentSnippet || 'No description'),
      pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      source: feed.name,
      category: feed.category,
      image: extractImage(item, parsed.link),
    }));

    // Optionally verify image URLs exist (HEAD request)
    if (verifyImages) {
      articles = await Promise.all(articles.map(async (article) => {
        if (article.image) {
          try {
            const headRes = await fetchWithTimeout(article.image, CONFIG.FETCH_TIMEOUT_MS, 1, { method: 'HEAD' });
            if (!headRes.ok) article.image = null;
          } catch {
            article.image = null;
          }
        }
        return article;
      }));
    }

    return {
      articles,
      metadata: {
        title: parsed.title || feed.name,
        description: feed.description,
        lastUpdated: parsed.lastBuildDate ? new Date(parsed.lastBuildDate).toISOString() : null,
      },
    };
  } catch (error) {
    console.error(`Error parsing RSS feed ${feed.url}:`, error.message);
    return { articles: [], metadata: { title: feed.name, description: feed.description, lastUpdated: null } };
  }
}

// Rate limiting with enhanced feedback
async function checkRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const path = new URL(request.url).pathname;
  const key = `rate_limit_${ip}_${slugify(path)}`;

  const now = Date.now();
  const windowMs = CONFIG.RATE_LIMIT_WINDOW_MS;
  const maxRequests = CONFIG.RATE_LIMIT_MAX_REQUESTS;

  let data = (await env.KV.get(key, { type: 'json' })) || { count: 0, reset: now + windowMs };
  if (now > data.reset) {
    data = { count: 0, reset: now + windowMs };
  }
  if (data.count >= maxRequests) {
    return new Response(
      JSON.stringify({
        error: 'Rate limit exceeded',
        remaining: 0,
        reset: Math.ceil((data.reset - now) / 1000),
      }),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
  data.count++;
  await env.KV.put(key, JSON.stringify(data), { expirationTtl: Math.floor(windowMs / 1000) });
  return { remaining: maxRequests - data.count, reset: Math.ceil((data.reset - now) / 1000) };
}

// Advanced search with phrase matching and exclusion
function applySearchFilter(articles, search) {
  if (!search) return articles;
  const sanitizedSearch = sanitizeHtml(search, { allowedTags: [], allowedAttributes: {} });
  const terms = sanitizedSearch.toLowerCase().split(/\s+/);
  const includeTerms = terms.filter(t => !t.startsWith('-')).join(' ');
  const excludeTerms = terms.filter(t => t.startsWith('-')).map(t => t.slice(1));

  return articles.filter(a => {
    const text = `${a.title} ${a.description}`.toLowerCase();
    const includesAll = includeTerms ? text.includes(includeTerms) : true;
    const excludesAll = excludeTerms.every(term => !text.includes(term));
    return includesAll && excludesAll;
  });
}

// Date range filtering
function applyDateFilter(articles, startDate, endDate) {
  if (!startDate && !endDate) return articles;
  return articles.filter(a => {
    if (!a.pubDate) return false;
    const date = new Date(a.pubDate).getTime();
    const start = startDate ? new Date(startDate).getTime() : -Infinity;
    const end = endDate ? new Date(endDate).getTime() : Infinity;
    return date >= start && date <= end;
  });
}

// Image filter
function applyImageFilter(articles, withImage) {
  if (!withImage) return articles;
  return articles.filter(a => a.image !== null);
}

// Deduplicate articles
function deduplicateArticles(articles) {
  const seen = new Set();
  return articles.filter(article => {
    const key = `${article.title.toLowerCase()}|${article.source.toLowerCase()}|${article.pubDate || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Sort articles
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

// Paginate articles
function paginate(articles, limit, page) {
  const start = (page - 1) * limit;
  if (start >= articles.length) return [];
  return articles.slice(start, start + limit);
}

// Fetch and cache feeds
async function fetchFeedsAndCache(feeds, env, cacheKey, verifyImages = false) {
  const startTime = Date.now();
  const results = await Promise.allSettled(feeds.map(feed => parseRSSFeed(feed, verifyImages)));
  const articles = results
    .filter(result => result.status === 'fulfilled')
    .flatMap(result => result.value.articles);
  const metadata = results
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value.metadata);

  const deduplicated = deduplicateArticles(articles);
  deduplicated.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  await env.KV.put(
    `${CONFIG.CACHE_VERSION}_${cacheKey}`,
    JSON.stringify({ articles: deduplicated, metadata }),
    { expirationTtl: CONFIG.CACHE_TTL_SECONDS }
  );
  console.log(`Fetched and cached ${cacheKey}: ${deduplicated.length} articles in ${Date.now() - startTime}ms`);
  return { articles: deduplicated, metadata };
}

// Serve cached articles and refresh in background
async function fetchAndCacheFeeds(feeds, env, cacheKey, verifyImages = false) {
  const cached = await env.KV.get(`${CONFIG.CACHE_VERSION}_${cacheKey}`, { type: 'json' });
  if (cached) {
    console.log(`Cache hit for ${cacheKey}`);
    fetchFeedsAndCache(feeds, env, cacheKey, verifyImages).catch(err => console.error(`Background refresh failed for ${cacheKey}:`, err.message));
    return cached;
  }
  console.log(`Cache miss for ${cacheKey}`);
  return await fetchFeedsAndCache(feeds, env, cacheKey, verifyImages);
}

// Clear cache endpoint
async function clearCache(env, cacheKey) {
  await env.KV.delete(`${CONFIG.CACHE_VERSION}_${cacheKey}`);
  console.log(`Cleared cache for ${cacheKey}`);
  return { message: `Cache cleared for ${cacheKey}` };
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS, POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const startTime = Date.now();
    const url = new URL(request.url);
    const path = url.pathname;

    // Rate limit check
    const rateLimitResponse = await checkRateLimit(request, env);
    if (rateLimitResponse instanceof Response) {
      return rateLimitResponse;
    }

    // Parse query params with validation
    const params = url.searchParams;
    const limit = Math.min(Math.max(parseInt(params.get('limit')) || CONFIG.DEFAULT_LIMIT, 1), CONFIG.MAX_LIMIT);
    const page = Math.max(parseInt(params.get('page')) || 1, 1);
    const search = params.get('search') || '';
    const sort = ['title', 'pubDate'].includes(params.get('sort')) ? params.get('sort') : 'pubDate';
    const order = ['asc', 'desc'].includes(params.get('order')?.toLowerCase()) ? params.get('order').toLowerCase() : 'desc';
    const startDate = params.get('startDate') || null;
    const endDate = params.get('endDate') || null;
    const withImage = params.get('with_image') === 'true';
    const verifyImages = params.get('verify_images') === 'true';

    // Route: /api/news/:category?
    if (path.startsWith('/api/news')) {
      const parts = path.split('/');
      const category = parts[3] ? decodeURIComponent(parts[3]).toLowerCase() : null;
      const cacheKey = category ? `news_${slugify(category)}` : 'news_all';

      const feedsToFetch = category
        ? RSS_FEEDS.filter(feed => feed.category.toLowerCase() === category)
        : RSS_FEEDS;

      if (category && feedsToFetch.length === 0) {
        return new Response(
          JSON.stringify({ error: 'Category not found' }),
          { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      const { articles, metadata } = await fetchAndCacheFeeds(feedsToFetch, env, cacheKey, verifyImages);
      let filtered = applySearchFilter(articles, search);
      filtered = applyDateFilter(filtered, startDate, endDate);
      filtered = applyImageFilter(filtered, withImage);
      filtered = applySorting(filtered, sort, order);
      const paginated = paginate(filtered, limit, page);

      console.log(`Request to ${path} processed in ${Date.now() - startTime}ms`);
      return new Response(
        JSON.stringify({
          page,
          limit,
          totalResults: filtered.length,
          totalPages: Math.ceil(filtered.length / limit),
          articles: paginated,
          metadata,
          rateLimit: rateLimitResponse,
        }),
        { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Route: /api/categories
    if (path === '/api/categories') {
      const categories = [...new Set(RSS_FEEDS.map(feed => feed.category))];
      console.log(`Request to ${path} processed in ${Date.now() - startTime}ms`);
      return new Response(JSON.stringify(categories), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Route: /api/source/:source
    if (path.startsWith('/api/source/')) {
      const parts = path.split('/');
      const source = parts[3] ? decodeURIComponent(parts[3]).toLowerCase() : '';
      if (!source) {
        return new Response(
          JSON.stringify({ error: 'Source required' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      const cacheKey = `source_${slugify(source)}`;
      const feed = RSS_FEEDS.find(f => f.name.toLowerCase() === source);

      if (!feed) {
        return new Response(
          JSON.stringify({ error: 'Source not found' }),
          { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }

      const { articles, metadata } = await fetchAndCacheFeeds([feed], env, cacheKey, verifyImages);
      let filtered = applySearchFilter(articles, search);
      filtered = applyDateFilter(filtered, startDate, endDate);
      filtered = applyImageFilter(filtered, withImage);
      filtered = applySorting(filtered, sort, order);
      const paginated = paginate(filtered, limit, page);

      console.log(`Request to ${path} processed in ${Date.now() - startTime}ms`);
      return new Response(
        JSON.stringify({
          page,
          limit,
          totalResults: filtered.length,
          totalPages: Math.ceil(filtered.length / limit),
          articles: paginated,
          metadata,
          rateLimit: rateLimitResponse,
        }),
        { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Route: /api/sources
    if (path === '/api/sources') {
      const sources = RSS_FEEDS.map(feed => ({
        name: feed.name,
        category: feed.category,
        description: feed.description,
      }));
      console.log(`Request to ${path} processed in ${Date.now() - startTime}ms`);
      return new Response(JSON.stringify(sources), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Route: /api/cache/clear/:cacheKey
    if (path.startsWith('/api/cache/clear/')) {
      const parts = path.split('/');
      const cacheKey = parts[3] ? decodeURIComponent(parts[3]) : '';
      if (!cacheKey) {
        return new Response(
          JSON.stringify({ error: 'Cache key required' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      // TODO: Add authentication (e.g., API key) in production
      const result = await clearCache(env, cacheKey);
      console.log(`Request to ${path} processed in ${Date.now() - startTime}ms`);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Not found
    console.log(`Request to ${path} processed in ${Date.now() - startTime}ms`);
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },

  async scheduled(event, env, ctx) {
    console.log(`Scheduled trigger fired at ${new Date(event.scheduledTime).toISOString()}`);
    const startTime = Date.now();
    try {
      // Refresh caches for all categories and sources
      const categories = [...new Set(RSS_FEEDS.map(feed => feed.category))];
      const categoryPromises = categories.map(category => {
        const feeds = RSS_FEEDS.filter(f => f.category.toLowerCase() === category.toLowerCase());
        const cacheKey = `news_${slugify(category.toLowerCase())}`;
        return fetchFeedsAndCache(feeds, env, cacheKey);
      });
      const allFeedsPromise = fetchFeedsAndCache(RSS_FEEDS, env, 'news_all');
      const sourcePromises = RSS_FEEDS.map(feed => {
        const cacheKey = `source_${slugify(feed.name.toLowerCase())}`;
        return fetchFeedsAndCache([feed], env, cacheKey);
      });

      await Promise.all([...categoryPromises, allFeedsPromise, ...sourcePromises]);
      console.log(`Scheduled cache refresh completed in ${Date.now() - startTime}ms`);
    } catch (error) {
      console.error(`Scheduled cache refresh failed: ${error.message}`);
    }
  },
};
