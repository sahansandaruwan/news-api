import Parser from 'rss-parser';
const parser = new Parser();

// RSS Feeds configuration
const RSS_FEEDS = [
  // Technology
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'Technology' },
  { name: 'Wired', url: 'https://www.wired.com/feed/rss', category: 'Technology' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'Technology' },
  { name: 'Ars Technica', url: 'http://feeds.arstechnica.com/arstechnica/index', category: 'Technology' },
  { name: 'CNET', url: 'https://www.cnet.com/rss/all/', category: 'Technology' },
  // World News
  { name: 'BBC World', url: 'http://feeds.bbci.co.uk/news/world/rss.xml', category: 'World News' },
  { name: 'CNN Top Stories', url: 'http://rss.cnn.com/rss/edition.rss', category: 'World News' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'World News' },
  { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml', category: 'World News' },
  { name: 'AP News', url: 'https://apnews.com/index.rss', category: 'World News' },
  // Celebrity Gossip
  { name: 'TMZ', url: 'https://www.tmz.com/rss.xml', category: 'Celebrity Gossip' },
  { name: 'E! Online', url: 'https://www.eonline.com/syndication/feeds/rssfeeds/topstories.xml', category: 'Celebrity Gossip' },
  { name: 'Perez Hilton', url: 'https://perezhilton.com/feed/', category: 'Celebrity Gossip' },
  { name: 'Hollywood Life', url: 'https://hollywoodlife.com/feed/', category: 'Celebrity Gossip' },
  // How-To & DIY
  { name: 'WikiHow', url: 'https://www.wikihow.com/feed.rss', category: 'How-To & DIY' },
  { name: 'Lifehacker', url: 'https://lifehacker.com/rss', category: 'How-To & DIY' },
  { name: 'How-To Geek', url: 'https://www.howtogeek.com/feed/', category: 'How-To & DIY' },
  // AI & Machine Learning
  { name: 'OpenAI Blog', url: 'https://openai.com/blog/rss.xml', category: 'AI & Machine Learning' },
  { name: 'DeepMind Blog', url: 'https://deepmind.google/discover/blog/feed', category: 'AI & Machine Learning' },
  { name: 'Unite.AI', url: 'https://www.unite.ai/feed/', category: 'AI & Machine Learning' },
  { name: 'AI Trends', url: 'https://www.aitrends.com/feed/', category: 'AI & Machine Learning' },
  // Science
  { name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml', category: 'Science' },
  { name: 'NASA Breaking News', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss', category: 'Science' },
  { name: 'New Scientist', url: 'https://www.newscientist.com/feed/home/', category: 'Science' },
  { name: 'Science News', url: 'https://www.sciencenews.org/feed', category: 'Science' },
  // Sports
  { name: 'Yahoo! Sports', url: 'https://sports.yahoo.com/rss/', category: 'Sports' },
  { name: 'NBC Sports', url: 'https://www.nbcsports.com/rss/feed', category: 'Sports' },
  { name: 'Sporting News', url: 'https://www.sportingnews.com/feed', category: 'Sports' },
  { name: 'Sportsnet', url: 'https://www.sportsnet.ca/feed/', category: 'Sports' },
];

// Helper function to parse RSS feed with error handling
async function parseRSSFeed(url) {
  try {
    const response = await fetch(url, { cf: { cacheTtl: 600 } }); // Cache for 10 minutes
    if (!response.ok) throw new Error(`HTTP error ${response.status}`);
    const text = await response.text();
    const feed = await parser.parseString(text);
    return feed.items.map(item => ({
      title: item.title || 'No title',
      link: item.link || '#',
      description: item.description || item.contentSnippet || 'No description',
      pubDate: item.pubDate || 'Unknown date',
      source: feed.title || 'Unknown source',
    }));
  } catch (error) {
    console.error(`Error parsing RSS feed ${url}:`, error.message);
    return [];
  }
}

// Rate limiting using Workers KV
async function checkRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rate_limit_${ip}`;
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
  data.count += 1;
  await env.KV.put(key, JSON.stringify(data), { expirationTtl: Math.floor(windowMs / 1000) });
  return null;
}

export default {
  async fetch(request, env, ctx) {
    // Enable CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle OPTIONS request for CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Check rate limit
    const rateLimitResponse = await checkRateLimit(request, env);
    if (rateLimitResponse) return rateLimitResponse;

    const url = new URL(request.url);
    const path = url.pathname;

    // Get all news or by category
    if (path.startsWith('/api/news')) {
      const category = path.split('/')[3] ? decodeURIComponent(path.split('/')[3]) : null;
      const cacheKey = category ? `news_${category}` : 'news_all';

      // Check KV cache
      let articles = await env.KV.get(cacheKey, { type: 'json' });
      if (articles) {
        return new Response(JSON.stringify(articles), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      try {
        const feedsToFetch = category
          ? RSS_FEEDS.filter(feed => feed.category.toLowerCase() === category.toLowerCase())
          : RSS_FEEDS;

        if (feedsToFetch.length === 0) {
          return new Response(JSON.stringify({ error: 'Category not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const feedPromises = feedsToFetch.map(async feed => {
          const articles = await parseRSSFeed(feed.url);
          return articles.map(article => ({ ...article, category: feed.category, source: feed.name }));
        });

        articles = (await Promise.all(feedPromises)).flat();
        articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

        // Store in KV cache (10 minutes TTL)
        await env.KV.put(cacheKey, JSON.stringify(articles), { expirationTtl: 600 });

        return new Response(JSON.stringify(articles), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (error) {
        console.error('Error fetching news:', error.message);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // Get news by source
    if (path.startsWith('/api/source')) {
      const source = decodeURIComponent(path.split('/')[3]);
      const cacheKey = `source_${source}`;

      // Check KV cache
      let articles = await env.KV.get(cacheKey, { type: 'json' });
      if (articles) {
        return new Response(JSON.stringify(articles), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      try {
        const feed = RSS_FEEDS.find(f => f.name.toLowerCase() === source.toLowerCase());
        if (!feed) {
          return new Response(JSON.stringify({ error: 'Source not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        articles = await parseRSSFeed(feed.url);
        articles = articles.map(article => ({ ...article, category: feed.category, source: feed.name }));

        // Store in KV cache
        await env.KV.put(cacheKey, JSON.stringify(articles), { expirationTtl: 600 });

        return new Response(JSON.stringify(articles), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (error) {
        console.error(`Error fetching source ${source}:`, error.message);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // List categories
    if (path === '/api/categories') {
      const categories = [...new Set(RSS_FEEDS.map(feed => feed.category))];
      return new Response(JSON.stringify(categories), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // List sources
    if (path === '/api/sources') {
      const sources = RSS_FEEDS.map(feed => ({ name: feed.name, category: feed.category }));
      return new Response(JSON.stringify(sources), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};
