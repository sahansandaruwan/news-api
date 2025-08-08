# 🌐 RSS News API Worker

A Cloudflare Worker that fetches, parses, caches, and serves articles from multiple RSS feeds with support for:

- **Categories**
- **Sources**
- **Search**
- **Sorting**
- **Pagination**
- **Rate limiting**

This API acts as a centralized news feed aggregator, pulling articles from popular sources like **TechCrunch**, **Wired**, **BBC**, **TMZ**, and more — with KV caching for performance.

---

## 🚀 Features

- **Fetches news** from multiple predefined RSS feeds
- **Category-based filtering** (e.g., Technology, World News, Sports)
- **Source-based filtering**
- **Search query support** (by title or description)
- **Sorting** by `pubDate` or `title` (ascending or descending)
- **Pagination** (configurable `limit` & `page`)
- **Cloudflare KV caching** to reduce API calls to RSS sources
- **Rate limiting** per IP to prevent abuse
- **CORS enabled** for public API access

---

## 📂 API Endpoints

### 1. **Get News Articles**
```
GET /api/news
GET /api/news/{category}
```
**Query Parameters:**
| Param   | Type   | Default  | Description |
|---------|--------|----------|-------------|
| limit   | int    | 20       | Max results per page (max: 100) |
| page    | int    | 1        | Page number |
| search  | string | -        | Keyword to search in title/description |
| sort    | string | pubDate  | Sort by `pubDate` or `title` |
| order   | string | desc     | Sort order: `asc` or `desc` |

**Example:**
```bash
GET /api/news/Technology?limit=10&page=2&search=AI&sort=title&order=asc
```

---

### 2. **Get Articles by Source**
```
GET /api/source/{sourceName}
```
**Example:**
```bash
GET /api/source/TechCrunch?limit=5
```

---

### 3. **List Categories**
```
GET /api/categories
```
Returns an array of all available categories.

---

### 4. **List Sources**
```
GET /api/sources
```
Returns all sources with their names and categories.

---

## 🛠 Installation & Deployment

### 1. Clone the repo
```bash
git clone https://github.com/yourusername/rss-news-api-worker.git
cd rss-news-api-worker
```

### 2. Install dependencies
```bash
npm install
```

### 3. Set up Cloudflare KV
In your `wrangler.toml`, define the KV namespace:
```toml
kv_namespaces = [
  { binding = "KV", id = "your_kv_namespace_id" }
]
```

### 4. Deploy to Cloudflare Workers
```bash
npx wrangler publish
```

---

## ⚙️ Environment Variables
| Variable | Description |
|----------|-------------|
| `KV`     | Cloudflare KV namespace binding for caching data |

---

## 📌 Notes
- **Cache TTL:** 10 minutes per category/source
- **Rate Limit:** 100 requests per IP every 15 minutes
- **Timeout:** Each feed request has an 8-second timeout

---

## 📰 Default RSS Sources
| Name            | URL                                            | Category              |
|-----------------|------------------------------------------------|-----------------------|
| TechCrunch      | https://techcrunch.com/feed/                   | Technology            |
| Wired           | https://www.wired.com/feed/rss                 | Technology            |
| BBC World       | http://feeds.bbci.co.uk/news/world/rss.xml     | World News            |
| TMZ             | https://www.tmz.com/rss.xml                    | Celebrity Gossip      |
| WikiHow         | https://www.wikihow.com/feed.rss               | How-To & DIY          |
| OpenAI Blog     | https://openai.com/blog/rss.xml                | AI & Machine Learning |
| ScienceDaily    | https://www.sciencedaily.com/rss/all.xml       | Science               |
| Yahoo! Sports   | https://sports.yahoo.com/rss/                  | Sports                |

---

## 📄 License
MIT License © 2025 [Your Name]
