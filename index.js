import Parser from 'rss-parser';
const parser = new Parser();

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
  // News
  {
    name: 'BBC News - World',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    category: 'News',
    description: 'International news, features, and analysis from regions like Africa, Asia-Pacific, Europe, and more.'
  },
  {
    name: 'The New York Times - World',
    url: 'https://www.nytimes.com/svc/collections/v1/publish/www.nytimes.com/section/world/rss.xml',
    category: 'News',
    description: 'Breaking news and multimedia on global events, covering Africa, Asia, Europe, and the Middle East.'
  },
  {
    name: 'CNN - Top Stories',
    url: 'https://rss.cnn.com/rss/edition_world.rss',
    category: 'News',
    description: 'Top stories and breaking news from a major global news outlet.'
  },

  // Technology
  {
    name: 'TechCrunch',
    url: 'https://techcrunch.com/feed',
    category: 'Technology',
    description: 'Covers startups, internet products, and breaking tech news with in-depth reporting.'
  },
  {
    name: 'Wired',
    url: 'https://www.wired.com/feed/rss',
    category: 'Technology',
    description: 'Focuses on emerging technologies, their impact on culture, economy, and politics.'
  },
  {
    name: 'The Verge',
    url: 'https://www.theverge.com/rss/index.xml',
    category: 'Technology',
    description: 'In-depth reporting on technology, science, art, and culture with product reviews.'
  },

  // Lifestyle
  {
    name: 'Apartment Therapy',
    url: 'https://www.apartmenttherapy.com/main.rss',
    category: 'Lifestyle',
    description: 'Covers lifestyle and interior design with DIY tips, home tours, and shopping guides.'
  },
  {
    name: 'Cup of Jo',
    url: 'https://feeds.feedburner.com/blogspot/cupofjo',
    category: 'Lifestyle',
    description: 'A daily blog on fashion, beauty, design, food, and parenting with personal stories.'
  },

  // Entertainment
  {
    name: 'Billboard',
    url: 'https://www.billboard.com/feed',
    category: 'Entertainment',
    description: 'Music industry news, charts, and updates with a focus on artists and trends.'
  },
  {
    name: 'NME',
    url: 'https://www.nme.com/feed',
    category: 'Entertainment',
    description: 'Music and pop culture news, reviews, videos, and band features.'
  },

  // Business
  {
    name: 'Harvard Business Review',
    url: 'https://feeds.hbr.org/harvardbusiness',
    category: 'Business',
    description: 'Insights on strategy, innovation, and leadership for business professionals.'
  },
  {
    name: 'Entrepreneur',
    url: 'https://www.entrepreneur.com/latest.rss',
    category: 'Business',
    description: 'News, tips, and tools for entrepreneurs to build and grow businesses.'
  },

  // Podcasts (note: mostly not public RSS feeds)
  // Joe Rogan is not public; This American Life has an RSS:
  {
    name: 'This American Life',
    url: 'https://feeds.thisamericanlife.org/talpodcast',
    category: 'Podcasts',
    description: 'Storytelling and journalism with a wide range of topics and voices.'
  },
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
    // Default sort by pubDate descending
    const dateA = new Date(a.pubDate).getTime() || 0;
    const dateB = new Date(b.pubDate).getTime() || 0;
    return asc ? dateA - dateB : dateB - dateA;
  });
}

function paginate(articles, limit = 20, page = 1) {
  const start = (page - 1) * limit;
  return articles.slice(start, start + limit);
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Rate limit check
    const rateLimitResponse = await checkRateLimit(request, env);
    if (rateLimitResponse) return rateLimitResponse;

    const url = new URL(request.url);
    const path = url.pathname;

    // Parse query params for pagination, search, sort
    const params = url.searchParams;
    const limit = Math.min(parseInt(params.get('limit')) || 20, 100);
    const page = Math.max(parseInt(params.get('page')) || 1, 1);
    const search = params.get('search') || '';
    const sort = params.get('sort') || 'pubDate'; // pubDate or title
    const order = (params.get('order') || 'desc').toLowerCase(); // asc or desc

    if (path.startsWith('/api/news')) {
      const category = path.split('/')[3] ? decodeURIComponent(path.split('/')[3]) : null;
      const cacheKey = category ? `news_${slugify(category)}` : 'news_all';

      let articles = await env.KV.get(cacheKey, { type: 'json' });
      if (!articles) {
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
            source: feed.name,
          }));
        });

        articles = (await Promise.all(feedPromises)).flat();

        articles = deduplicateArticles(articles);

        articles.sort((a, b) => {
          const dateA = new Date(a.pubDate).getTime() || 0;
          const dateB = new Date(b.pubDate).getTime() || 0;
          return dateB - dateA;
        });

        await env.KV.put(cacheKey, JSON.stringify(articles), { expirationTtl: 600 });
      }

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
      const categories = [...new Set(RSS_FEEDS.map(feed => feed.category))];
      return new Response(JSON.stringify(categories), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    if (path.startsWith('/api/source/')) {
      const source = decodeURIComponent(path.split('/')[3] || '');
      if (!source) {
        return new Response(JSON.stringify({ error: 'Source required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      const cacheKey = `source_${slugify(source)}`;

      let articles = await env.KV.get(cacheKey, { type: 'json' });
      if (!articles) {
        const feed = RSS_FEEDS.find(f => f.name.toLowerCase() === source.toLowerCase());
        if (!feed) {
          return new Response(JSON.stringify({ error: 'Source not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }

        articles = await parseRSSFeed(feed.url);
        articles = articles.map(article => ({
          ...article,
          category: feed.category,
          source: feed.name,
        }));

        articles = deduplicateArticles(articles);

        articles.sort((a, b) => {
          const dateA = new Date(a.pubDate).getTime() || 0;
          const dateB = new Date(b.pubDate).getTime() || 0;
          return dateB - dateA;
        });

        await env.KV.put(cacheKey, JSON.stringify(articles), { expirationTtl: 600 });
      }

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

    if (path === '/api/sources') {
      const sources = RSS_FEEDS.map(feed => ({ name: feed.name, category: feed.category }));
      return new Response(JSON.stringify(sources), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  },
};
