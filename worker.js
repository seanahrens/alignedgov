// AlignedGov Cloudflare Worker
// Fetches link + editor data from Google Sheets, enriches with OG metadata,
// caches in KV, and serves JSON API to the frontend.

const MERGED_CACHE_KEY = "merged_dataset_v1";
const MERGED_CACHE_TTL = 86400; // 24 hours in seconds
const OG_STALE_DAYS = 7;
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
    } else if (url.pathname === "/api/purge" || url.pathname === "/bust") {
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
  const [linksCSV, editorsCSV, configCSV, orgsCSV] = await Promise.all([
    fetchText(env.LINKS_CSV_URL),
    fetchText(env.EDITORS_CSV_URL),
    fetchText(env.CONFIG_CSV_URL).catch(() => ""),
    fetchText(env.ORGS_CSV_URL).catch(() => ""),
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

    // Skip soft-deleted rows
    if ((row.deleted_at || "").trim()) continue;

    const rowId = i + 1; // 1-based, excluding header
    const category = (row.category || "").trim() || "Uncategorized";
    const power = parseInt(row.power, 10) || 0;
    const notes = (row.notes || "").trim() || null;
    const org = (row.org || "").trim() || null;

    // Sheet-level overrides (if non-blank, take precedence over scraped OG data)
    const titleOverride = (row.title || "").trim() || null;
    const descOverride = (row.description || "").trim() || null;

    // Look up OG enrichment from KV
    const kvKey = await hashUrl(url);
    const ogData = await env.KV.get(kvKey, "json");

    let title = titleOverride;
    let description = descOverride;
    let og_image = null;
    let site_name = null;
    let date_scraped = null;

    if (ogData) {
      if (!title) title = ogData.title || null;
      if (!description) description = ogData.description || null;
      og_image = ogData.og_image || null;
      site_name = ogData.site_name || null;
      date_scraped = ogData.date_scraped || null;

      // Update row_id if it changed (row moved in sheet)
      if (ogData.row_id !== rowId) {
        const updated = { ...ogData, row_id: rowId };
        ctx.waitUntil(env.KV.put(kvKey, JSON.stringify(updated)));
      }
    }

    // Check if we need to scrape (missing, stale > 30 days, or missing site_name from old scrape)
    const needsScrape =
      !ogData || !date_scraped || isStale(date_scraped, OG_STALE_DAYS) ||
      (!ogData.site_name && !ogData._v2);

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
      org,
      title,
      description,
      og_image,
      site_name,
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

  // Process config (key/value pairs from Config sheet)
  const configRows = parseCSV(configCSV);
  const config = {};
  for (const row of configRows) {
    const key = (row.key || "").trim();
    const value = (row.value || "").trim();
    if (key) config[key] = value;
  }

  // Process orgs
  const orgRows = parseCSV(orgsCSV);
  const processedOrgs = [];
  const orgScrapePromises = [];

  for (let i = 0; i < orgRows.length; i++) {
    const row = orgRows[i];
    const url = (row.url || "").trim();
    if (!url) continue;

    const orgRowId = i + 1;
    const category = (row.category || "").trim() || "Uncategorized";
    const power = parseInt(row.power, 10) || 0;
    const people = (row.people || "").trim()
      ? (row.people || "").trim().split(/\n/).map(p => p.trim()).filter(Boolean)
      : [];

    // Scrape org URL for OG data (same KV pattern as links)
    const kvKey = await hashUrl(url);
    const ogData = await env.KV.get(kvKey, "json");

    let title = null;
    let description = null;
    let og_image = null;
    let site_name = null;

    if (ogData) {
      title = ogData.title || null;
      description = ogData.description || null;
      og_image = ogData.og_image || null;
      site_name = ogData.site_name || null;

      const needsScrape =
        !ogData.date_scraped || isStale(ogData.date_scraped, OG_STALE_DAYS) ||
        (!ogData.site_name && !ogData._v2);
      if (needsScrape) {
        orgScrapePromises.push(scrapeAndStore(env, kvKey, url, orgRowId));
      }
    } else {
      orgScrapePromises.push(scrapeAndStore(env, kvKey, url, orgRowId));
    }

    processedOrgs.push({
      url,
      category,
      power,
      people,
      title,
      description,
      og_image,
      site_name,
      row_id: orgRowId,
    });
  }

  // Fire off org scrapes
  if (orgScrapePromises.length > 0) {
    ctx.waitUntil(Promise.allSettled(orgScrapePromises));
  }

  // Sort orgs: power descending, then row_id ascending
  processedOrgs.sort((a, b) => {
    if (b.power !== a.power) return b.power - a.power;
    return a.row_id - b.row_id;
  });

  const dataset = {
    links: processedLinks,
    editors: processedEditors,
    orgs: processedOrgs,
    config,
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
  await env.KV.delete(MERGED_CACHE_KEY);
  return jsonResponse({ success: true, message: "Cache purged. Next page load will fetch fresh data." });
}

// ─── OG Scraper ─────────────────────────────────────────────────────────────

async function scrapeAndStore(env, kvKey, url, rowId) {
  try {
    const ogData = await scrapeOG(url);
    const entry = {
      title: ogData.title || null,
      description: ogData.description || null,
      og_image: ogData.og_image || null,
      site_name: ogData.site_name || null,
      date_scraped: new Date().toISOString(),
      row_id: rowId,
      _v2: true,
    };
    await env.KV.put(kvKey, JSON.stringify(entry));
  } catch (e) {
    // Store entry with nulls + date_scraped to prevent infinite retry loops
    const entry = {
      title: null,
      description: null,
      og_image: null,
      site_name: null,
      date_scraped: new Date().toISOString(),
      row_id: rowId,
      _v2: true,
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
      return parseOGFromHTML(html, currentUrl);
    } catch (e) {
      clearTimeout(timeoutId);
      return { title: null, description: null, og_image: null };
    }
  }

  return { title: null, description: null, og_image: null };
}

function parseOGFromHTML(html, targetUrl) {
  const result = { title: null, description: null, og_image: null, site_name: null };

  // Parse og:site_name
  const ogSiteNameMatch = html.match(
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*?)["']/i
  ) ||
    html.match(
      /<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']og:site_name["']/i
    );
  if (ogSiteNameMatch) {
    result.site_name = decodeHTMLEntities(ogSiteNameMatch[1]);
  }

  // Parse og:title
  const ogTitleMatch = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*?)["']/i
  ) ||
    html.match(
      /<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']og:title["']/i
    );
  let ogTitle = ogTitleMatch ? decodeHTMLEntities(ogTitleMatch[1]) : null;

  // Parse <title> tag
  const titleTagMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const pageTitle = titleTagMatch ? decodeHTMLEntities(titleTagMatch[1].trim()) : null;

  // Use og:title unless it's too generic (matches domain or is very short)
  // In that case prefer the <title> tag or URL slug
  if (ogTitle && isGenericTitle(ogTitle, targetUrl)) {
    // og:title is generic like "Amazon" or "Notion" — try better alternatives
    const slugTitle = extractTitleFromSlug(targetUrl);
    if (pageTitle && !isGenericTitle(pageTitle, targetUrl) && pageTitle.length > ogTitle.length) {
      result.title = pageTitle;
    } else if (slugTitle) {
      result.title = slugTitle;
    } else {
      result.title = pageTitle || ogTitle;
    }
  } else {
    result.title = ogTitle || pageTitle || null;
  }

  // Final fallback: if still no good title, try URL slug
  if (!result.title || isGenericTitle(result.title, targetUrl)) {
    const slugTitle = extractTitleFromSlug(targetUrl);
    if (slugTitle) result.title = slugTitle;
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
    let imageUrl = decodeHTMLEntities(ogImageMatch[1]);
    // Resolve relative image URLs to absolute
    if (imageUrl && !imageUrl.startsWith("http")) {
      try {
        imageUrl = new URL(imageUrl, targetUrl).href;
      } catch {}
    }
    result.og_image = imageUrl;
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

  // If description matches title exactly, null it out to avoid redundancy
  if (result.description && result.title &&
      result.description.trim().toLowerCase() === result.title.trim().toLowerCase()) {
    result.description = null;
  }

  return result;
}

// Check if an og:title is too generic (just a brand name matching the domain,
// or a known SPA marketing title)
const GENERIC_TITLE_PATTERNS = [
  /^notion\b/i,
  /^notion\s*[–—-]/i,
  /the all-in-one workspace/i,
  /^amazon$/i,
  /^linkedin$/i,
  /^airtable$/i,
  /^google\s*(sheets|docs|drive)?$/i,
];

function isGenericTitle(title, url) {
  if (!title || !url) return false;
  const t = title.trim().toLowerCase();

  // Check against known generic patterns
  for (const pattern of GENERIC_TITLE_PATTERNS) {
    if (pattern.test(title.trim())) return true;
  }

  // Check if title is very short and matches domain
  if (t.length <= 15) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "").split(".")[0].toLowerCase();
      if (t === hostname || t.includes(hostname)) return true;
    } catch {}
  }
  return false;
}

// Extract a human-readable title from a URL slug (e.g., Notion pages)
// "Remodeling-Democracy-for-the-AI-Age-The-Case-for-R-D-Now-3068c95..."
// → "Remodeling Democracy for the AI Age The Case for R D Now"
function extractTitleFromSlug(url) {
  try {
    const pathname = new URL(url).pathname;
    // Get the last path segment
    const segments = pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] || "";

    // Remove trailing hex ID (Notion-style: 32 hex chars at end, possibly with hyphens)
    const cleaned = last.replace(/[-]?[0-9a-f]{32}$/i, "");
    if (!cleaned) return null;

    // Convert hyphens to spaces
    const title = cleaned.replace(/-/g, " ").trim();

    // Only use it if it's reasonably long (not just "index" or "home")
    if (title.length < 10) return null;

    return title;
  } catch {
    return null;
  }
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

  // Parse all fields handling quoted fields with embedded newlines
  const records = parseCSVRecords(csvText.trim());
  if (records.length < 2) return []; // Need header + at least one data row

  const headers = records[0];
  const rows = [];

  for (let i = 1; i < records.length; i++) {
    const values = records[i];
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (values[j] || "").trim();
    }
    rows.push(row);
  }

  return rows;
}

// Full RFC 4180 CSV parser — handles quoted fields with embedded newlines
function parseCSVRecords(text) {
  const records = [];
  let current = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += char;
        i++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === ',') {
        current.push(field);
        field = "";
        i++;
      } else if (char === '\r') {
        // Handle \r\n or \r
        current.push(field);
        field = "";
        records.push(current);
        current = [];
        i++;
        if (i < text.length && text[i] === '\n') i++;
      } else if (char === '\n') {
        current.push(field);
        field = "";
        records.push(current);
        current = [];
        i++;
      } else {
        field += char;
        i++;
      }
    }
  }

  // Push last field/record
  current.push(field);
  if (current.length > 1 || current[0] !== "") {
    records.push(current);
  }

  return records;
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
