// AlignedGov Cloudflare Worker
// Fetches link + editor data from Google Sheets, enriches with OG metadata,
// caches in KV, and serves JSON API to the frontend.

const MERGED_CACHE_KEY = "merged_dataset_v1";
const MERGED_CACHE_TTL = 86400; // 24 hours in seconds
const OG_STALE_DAYS = 30;
const SCRAPE_TIMEOUT = 5000; // 5 seconds per URL
const MAX_REDIRECTS = 2;

// CORS origins — update to alignedgov.org after domain cutover
const ALLOWED_ORIGINS = [
  "https://alignedgov.pages.dev",
  "https://alignedgov.org",
  "https://www.alignedgov.org",
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return handleCors(request, new Response(null, { status: 204 }));
    }

    let response;

    if (url.pathname === "/api/links") {
      response = await handleLinks(env, ctx);
    } else if (url.pathname === "/api/purge") {
      response = await handlePurge(url, env);
    } else {
      response = new Response("Not Found", { status: 404 });
    }

    return handleCors(request, response);
  },
};

// ─── CORS ───────────────────────────────────────────────────────────────────

function handleCors(request, response) {
  const origin = request.headers.get("Origin") || "";
  const headers = new Headers(response.headers);

  // Allow any *.pages.dev subdomain for testing, plus production domains
  if (
    ALLOWED_ORIGINS.includes(origin) ||
    origin.endsWith(".pages.dev") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1")
  ) {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ─── GET /api/links ─────────────────────────────────────────────────────────

async function handleLinks(env, ctx) {
  // Check KV cache first
  const cached = await env.KV.get(MERGED_CACHE_KEY, "json");
  if (cached) {
    return jsonResponse(cached);
  }

  // Cache miss — full fetch + enrichment cycle
  const [linksCSV, editorsCSV] = await Promise.all([
    fetchText(env.LINKS_CSV_URL),
    fetchText(env.EDITORS_CSV_URL),
  ]);

  const links = parseCSV(linksCSV);
  const editors = parseCSV(editorsCSV);

  // Process approved links
  const processedLinks = [];
  const scrapePromises = [];

  for (let i = 0; i < links.length; i++) {
    const row = links[i];
    const url = (row.url || "").trim();

    // Skip rows with blank URL
    if (!url) continue;

    const rowId = i + 1; // 1-based, excluding header
    const category = (row.category || "").trim() || "Uncategorized";
    const power = parseInt(row.power, 10) || 0;
    const notes = (row.notes || "").trim() || null;
    const submitter = (row.submitter || "").trim() || null;

    // Look up OG enrichment from KV
    const kvKey = await hashUrl(url);
    const ogData = await env.KV.get(kvKey, "json");

    let title = null;
    let description = null;
    let og_image = null;
    let date_scraped = null;

    if (ogData) {
      title = ogData.title || null;
      description = ogData.description || null;
      og_image = ogData.og_image || null;
      date_scraped = ogData.date_scraped || null;

      // Update row_id if it changed (row moved in sheet)
      if (ogData.row_id !== rowId) {
        const updated = { ...ogData, row_id: rowId };
        ctx.waitUntil(env.KV.put(kvKey, JSON.stringify(updated)));
      }
    }

    // Check if we need to scrape (missing or stale > 30 days)
    const needsScrape =
      !ogData || !date_scraped || isStale(date_scraped, OG_STALE_DAYS);

    if (needsScrape) {
      // Scrape asynchronously — don't block response
      scrapePromises.push(
        scrapeAndStore(env, kvKey, url, rowId)
      );
    }

    processedLinks.push({
      url,
      category,
      power,
      notes,
      submitter,
      title,
      description,
      og_image,
      row_id: rowId,
    });
  }

  // Fire off all scrapes asynchronously via waitUntil
  if (scrapePromises.length > 0) {
    ctx.waitUntil(Promise.allSettled(scrapePromises));
  }

  // Sort: power descending, then row_id ascending for tiebreak
  processedLinks.sort((a, b) => {
    if (b.power !== a.power) return b.power - a.power;
    return a.row_id - b.row_id;
  });

  // Process editors
  const processedEditors = [];
  for (const row of editors) {
    const name = (row.name || "").trim();
    if (!name) continue; // Skip rows with blank name

    processedEditors.push({
      name,
      email: (row.email || "").trim() || null,
      role: (row.role || "").trim() || null,
      bio: (row.bio || "").trim() || null,
      url: (row.url || "").trim() || null,
      photo_url: (row.photo_url || "").trim() || null,
    });
  }

  const dataset = {
    links: processedLinks,
    editors: processedEditors,
  };

  // Cache merged dataset with 24hr TTL
  ctx.waitUntil(
    env.KV.put(MERGED_CACHE_KEY, JSON.stringify(dataset), {
      expirationTtl: MERGED_CACHE_TTL,
    })
  );

  return jsonResponse(dataset);
}

// ─── GET /api/purge?key=SECRET ──────────────────────────────────────────────

async function handlePurge(url, env) {
  const key = url.searchParams.get("key");

  if (!key || key !== env.PURGE_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  await env.KV.delete(MERGED_CACHE_KEY);
  return jsonResponse({ success: true, message: "Cache purged" });
}

// ─── OG Scraper ─────────────────────────────────────────────────────────────

async function scrapeAndStore(env, kvKey, url, rowId) {
  try {
    const ogData = await scrapeOG(url);
    const entry = {
      title: ogData.title || null,
      description: ogData.description || null,
      og_image: ogData.og_image || null,
      date_scraped: new Date().toISOString(),
      row_id: rowId,
    };
    await env.KV.put(kvKey, JSON.stringify(entry));
  } catch (e) {
    // Store entry with nulls + date_scraped to prevent infinite retry loops
    const entry = {
      title: null,
      description: null,
      og_image: null,
      date_scraped: new Date().toISOString(),
      row_id: rowId,
    };
    await env.KV.put(kvKey, JSON.stringify(entry));
  }
}

async function scrapeOG(targetUrl) {
  let currentUrl = targetUrl;
  let redirectCount = 0;

  while (redirectCount <= MAX_REDIRECTS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT);

    try {
      const resp = await fetch(currentUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; AlignedGovBot/1.0; +https://alignedgov.org)",
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "manual",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle redirects manually to enforce limit
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("Location");
        if (!location) break;
        currentUrl = new URL(location, currentUrl).href;
        redirectCount++;
        continue;
      }

      if (!resp.ok) {
        return { title: null, description: null, og_image: null };
      }

      const html = await resp.text();
      return parseOGFromHTML(html);
    } catch (e) {
      clearTimeout(timeoutId);
      return { title: null, description: null, og_image: null };
    }
  }

  return { title: null, description: null, og_image: null };
}

function parseOGFromHTML(html) {
  const result = { title: null, description: null, og_image: null };

  // Parse og:title
  const ogTitleMatch = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*?)["']/i
  ) ||
    html.match(
      /<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']og:title["']/i
    );
  if (ogTitleMatch) {
    result.title = decodeHTMLEntities(ogTitleMatch[1]);
  }

  // Parse og:description
  const ogDescMatch = html.match(
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*?)["']/i
  ) ||
    html.match(
      /<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']og:description["']/i
    );
  if (ogDescMatch) {
    result.description = decodeHTMLEntities(ogDescMatch[1]);
  }

  // Parse og:image
  const ogImageMatch = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*?)["']/i
  ) ||
    html.match(
      /<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']og:image["']/i
    );
  if (ogImageMatch) {
    result.og_image = decodeHTMLEntities(ogImageMatch[1]);
  }

  // Fallback: <title> tag if og:title missing
  if (!result.title) {
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (titleMatch) {
      result.title = decodeHTMLEntities(titleMatch[1].trim());
    }
  }

  // Fallback: meta description if og:description missing
  if (!result.description) {
    const metaDescMatch = html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*?)["']/i
    ) ||
      html.match(
        /<meta[^>]+content=["']([^"']*?)["'][^>]+name=["']description["']/i
      );
    if (metaDescMatch) {
      result.description = decodeHTMLEntities(metaDescMatch[1]);
    }
  }

  return result;
}

function decodeHTMLEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

// ─── CSV Parser ─────────────────────────────────────────────────────────────

function parseCSV(csvText) {
  if (!csvText || !csvText.trim()) return [];

  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return []; // Need header + at least one data row

  const headers = parseCSVLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (values[j] || "").trim();
    }
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // Skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }
  }

  result.push(current);
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function hashUrl(url) {
  const encoder = new TextEncoder();
  const data = encoder.encode(url);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex.slice(0, 16);
}

function isStale(dateString, days) {
  const scraped = new Date(dateString);
  const now = new Date();
  const diffMs = now - scraped;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= days;
}

async function fetchText(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  }
  return resp.text();
}

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}
