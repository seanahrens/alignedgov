// AlignedGov Cloudflare Worker
// Fetches link + editor data from Google Sheets, enriches with OG metadata,
// caches in KV, and serves JSON API to the frontend.

const MERGED_CACHE_KEY = "merged_dataset_v1";
const MERGED_CACHE_TTL = 86400; // 24 hours in seconds
const OG_STALE_DAYS = 7;
const SCRAPE_TIMEOUT = 5000; // 5 seconds per URL
const MAX_REDIRECTS = 2;

// CORS origins
const ALLOWED_ORIGINS = [
  "https://alignedgov.pages.dev",
  "https://alignedgov.org",
  "https://www.alignedgov.org",
  "https://aixdemocracy.fyi",
  "https://www.aixdemocracy.fyi",
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
    } else if (url.pathname === "/api/subscribe" && request.method === "POST") {
      response = await handleSubscribe(request, env);
    } else if (url.pathname === "/api/draft-digest" && request.method === "POST") {
      response = await handleDraftDigest(request, env);
    } else if (url.pathname === "/api/purge" || url.pathname === "/bust") {
      response = await handlePurge(url, env);
    } else {
      response = new Response("Not Found", { status: 404 });
    }

    return handleCors(request, response);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendMonthlyDigest(env));
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

  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");
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
  const [linksCSV, editorsCSV, configCSV, orgsCSV, deadlinesCSV] = await Promise.all([
    fetchText(env.LINKS_CSV_URL),
    fetchText(env.EDITORS_CSV_URL),
    fetchText(env.CONFIG_CSV_URL).catch(() => ""),
    fetchText(env.ORGS_CSV_URL).catch(() => ""),
    fetchText(env.DEADLINES_CSV_URL).catch(() => ""),
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
    if ((row.deleted_at || "").trim()) continue;

    const orgRowId = i + 1;
    const category = (row.category || "").trim() || "Uncategorized";
    const power = parseInt(row.power, 10) || 0;
    const people = (row.people || "").trim()
      ? (row.people || "").trim().split(/\n/).map(p => p.trim()).filter(Boolean)
      : [];

    // Sheet-level overrides (if non-blank, take precedence over scraped OG data)
    const titleOverride = (row.title || "").trim() || null;
    const descOverride = (row.description || "").trim() || null;

    // Scrape org URL for OG data (same KV pattern as links)
    const kvKey = await hashUrl(url);
    const ogData = await env.KV.get(kvKey, "json");

    let title = titleOverride;
    let description = descOverride;
    let og_image = null;
    let site_name = null;

    if (ogData) {
      if (!title) title = ogData.title || null;
      if (!description) description = ogData.description || null;
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

  // Process deadlines
  const deadlineRows = parseCSV(deadlinesCSV);
  const processedDeadlines = [];
  const deadlineScrapePromises = [];

  for (let i = 0; i < deadlineRows.length; i++) {
    const row = deadlineRows[i];
    const url = (row.url || "").trim();
    const deadlineStr = (row.deadline || "").trim();
    if (!url || !deadlineStr) continue;

    // Sheet-level overrides
    const titleOverride = (row.title || "").trim() || null;
    const descOverride = (row.description || "").trim() || null;

    const kvKey = await hashUrl(url);
    const ogData = await env.KV.get(kvKey, "json");

    let title = titleOverride;
    let description = descOverride;
    let og_image = null;
    let site_name = null;

    if (ogData) {
      if (!title) title = ogData.title || null;
      if (!description) description = ogData.description || null;
      og_image = ogData.og_image || null;
      site_name = ogData.site_name || null;

      const needsScrape =
        !ogData.date_scraped || isStale(ogData.date_scraped, OG_STALE_DAYS) ||
        (!ogData.site_name && !ogData._v2);
      if (needsScrape) {
        deadlineScrapePromises.push(scrapeAndStore(env, kvKey, url, i + 1));
      }
    } else {
      deadlineScrapePromises.push(scrapeAndStore(env, kvKey, url, i + 1));
    }

    processedDeadlines.push({
      url,
      deadline: deadlineStr,
      title,
      description,
      og_image,
      site_name,
    });
  }

  if (deadlineScrapePromises.length > 0) {
    ctx.waitUntil(Promise.allSettled(deadlineScrapePromises));
  }

  // Track first-seen timestamps for newsletter digest
  const trackPromises = [];
  for (const link of processedLinks) {
    const trackKey = "newsletter:link:" + (await hashUrl(link.url));
    trackPromises.push(
      env.KV.get(trackKey).then((existing) => {
        if (!existing) {
          return env.KV.put(trackKey, JSON.stringify({
            url: link.url,
            first_seen: new Date().toISOString(),
          }));
        }
      })
    );
  }
  if (trackPromises.length > 0) {
    ctx.waitUntil(Promise.allSettled(trackPromises));
  }

  const dataset = {
    links: processedLinks,
    editors: processedEditors,
    orgs: processedOrgs,
    deadlines: processedDeadlines,
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

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── POST /api/subscribe ────────────────────────────────────────────────────

async function handleSubscribe(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  const email = (body.email || "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: "Please enter a valid email address" }, 422);
  }

  try {
    // Step 1: Create subscriber as inactive
    const createResp = await fetch("https://api.kit.com/v4/subscribers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kit-Api-Key": env.KIT_API_KEY,
      },
      body: JSON.stringify({ email_address: email, state: "inactive" }),
    });

    if (!createResp.ok && createResp.status !== 200 && createResp.status !== 202) {
      const data = await createResp.json().catch(() => ({}));
      return jsonResponse({ error: data.message || "Subscription failed" }, createResp.status);
    }

    // Step 2: Add to form (triggers double opt-in confirmation email)
    const formResp = await fetch(`https://api.kit.com/v4/forms/${env.KIT_FORM_ID}/subscribers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kit-Api-Key": env.KIT_API_KEY,
      },
      body: JSON.stringify({ email_address: email }),
    });

    if (formResp.ok || formResp.status === 201) {
      return jsonResponse({ success: true });
    }

    const data = await formResp.json().catch(() => ({}));
    return jsonResponse({ error: data.message || "Subscription failed" }, formResp.status);
  } catch (err) {
    return jsonResponse({ error: "Service temporarily unavailable" }, 502);
  }
}

// ─── Monthly Digest ─────────────────────────────────────────────────────────

// Parse a deadline date string (matches frontend logic)
function parseDeadlineDate(str) {
  const MONTH_MAP = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  const s = (str || "").trim();
  // ISO format
  const iso = new Date(s + "T23:59:59");
  if (!isNaN(iso.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(s)) return iso;
  // "Mon DD" or "Mon DD, YYYY"
  const m = s.match(/^([A-Za-z]+)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?$/);
  if (!m) return null;
  const monthIdx = MONTH_MAP[m[1].toLowerCase().slice(0, 3)];
  if (monthIdx === undefined) return null;
  const day = parseInt(m[2], 10);
  const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  const date = new Date(year, monthIdx, day, 23, 59, 59);
  if (!m[3] && date < new Date(Date.now() - 180 * 24 * 60 * 60 * 1000)) {
    date.setFullYear(date.getFullYear() + 1);
  }
  return date;
}

// Shared: generate digest content (subject, html, newLinks, deadlines) without sending
async function generateDigest(env) {
  const LAST_SEND_KEY = "newsletter:last_send";

  const lastSendRaw = await env.KV.get(LAST_SEND_KEY);
  const lastSend = lastSendRaw ? new Date(lastSendRaw) : new Date(0);

  const [linksCSV, configCSV, deadlinesCSV] = await Promise.all([
    fetchText(env.LINKS_CSV_URL),
    fetchText(env.CONFIG_CSV_URL).catch(() => ""),
    fetchText(env.DEADLINES_CSV_URL).catch(() => ""),
  ]);
  const allLinks = parseCSV(linksCSV);
  const configRows = parseCSV(configCSV);
  const config = {};
  for (const row of configRows) {
    const key = (row.key || "").trim();
    const value = (row.value || "").trim();
    if (key) config[key] = value;
  }

  // ─── Deadlines (not passed by more than 7 days) ───
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const deadlineRows = parseCSV(deadlinesCSV);
  const deadlines = [];
  for (const d of deadlineRows) {
    const date = parseDeadlineDate(d.deadline);
    if (!date || date < sevenDaysAgo) continue;
    const url = (d.url || "").trim();
    if (!url) continue;

    // Check sheet overrides first, then fall back to OG data from KV
    let title = (d.title || "").trim() || null;
    let description = (d.description || "").trim() || null;
    if (!title || !description) {
      const kvKey = await hashUrl(url);
      const ogData = await env.KV.get(kvKey, "json");
      if (ogData) {
        if (!title) title = ogData.title || null;
        if (!description) description = ogData.description || null;
      }
    }

    const label = MONTHS[date.getMonth()] + " " + date.getDate();
    deadlines.push({ url, title: title || url, description: description || "", date, label });
  }
  deadlines.sort((a, b) => a.date - b.date);

  // ─── New links ───
  const newLinks = [];
  for (const row of allLinks) {
    const url = (row.url || "").trim();
    if (!url) continue;
    if ((row.deleted_at || "").trim()) continue;

    const trackKey = "newsletter:link:" + (await hashUrl(url));
    const trackData = await env.KV.get(trackKey, "json");
    if (!trackData) continue;

    const firstSeen = new Date(trackData.first_seen);
    if (firstSeen > lastSend) {
      const kvKey = await hashUrl(url);
      const ogData = await env.KV.get(kvKey, "json");

      const title = (row.title || "").trim() ||
        (ogData && ogData.title) || url;
      const description = (row.description || "").trim() ||
        (ogData && ogData.description) || "";
      const category = (row.category || "").trim() || "Uncategorized";

      newLinks.push({ url, title, description, category });
    }
  }

  const siteName = config.title || "AI×Democracy.FYI";

  // ─── Build subject line ───
  const hasLinks = newLinks.length > 0;
  const hasDeadlines = deadlines.length > 0;
  let subject;
  if (hasLinks && hasDeadlines) subject = "New Resources & Upcoming Deadlines";
  else if (hasLinks) subject = "What's new this month?";
  else if (hasDeadlines) subject = "Upcoming Deadlines";
  else subject = "Monthly Update";

  // ─── Build HTML email ───
  const deadlinesHtml = deadlines.length > 0 ? `
  <h2 style="font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #1a1a2e; margin: 0 0 12px 0; padding-bottom: 8px; border-bottom: 2px solid #2d5be3;">Opportunities &mdash; Upcoming Deadlines</h2>
  <table style="width: 100%; border-collapse: collapse; margin-bottom: 28px;">
    ${deadlines.map((d) => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #e2e4e9; vertical-align: top;">
        <a href="${escapeHtml(d.url)}" style="color: #2d5be3; font-weight: 600; font-size: 15px; text-decoration: none;">${escapeHtml(d.title)}</a>
        ${d.description ? `<div style="color: #555770; font-size: 13px; margin-top: 3px; line-height: 1.4;">${escapeHtml(d.description)}</div>` : ""}
      </td>
      <td style="padding: 10px 0 10px 12px; border-bottom: 1px solid #e2e4e9; vertical-align: top; white-space: nowrap; text-align: right;">
        <span style="font-size: 13px; font-weight: 600; color: #2d5be3;">${escapeHtml(d.label)}</span>
      </td>
    </tr>`).join("")}
  </table>` : "";

  const newLinksHtml = newLinks.length > 0 ? `
  <h2 style="font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #1a1a2e; margin: 0 0 12px 0; padding-bottom: 8px; border-bottom: 2px solid #2d5be3;">New Resources</h2>
  <table style="width: 100%; border-collapse: collapse; margin-bottom: 28px;">
    ${newLinks.map((link) => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #e2e4e9;">
        <a href="${escapeHtml(link.url)}" style="color: #2d5be3; font-weight: 600; font-size: 15px; text-decoration: none;">${escapeHtml(link.title)}</a>
        ${link.description ? `<div style="color: #555770; font-size: 13px; margin-top: 3px; line-height: 1.4;">${escapeHtml(link.description)}</div>` : ""}
      </td>
    </tr>`).join("")}
  </table>` : "";

  const html = `
<div style="max-width: 600px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e;">
  <h1 style="font-size: 22px; margin-bottom: 4px;">${escapeHtml(siteName)}</h1>
  <p style="color: #8888a0; font-size: 14px; margin-bottom: 24px;">Monthly Digest &mdash; ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}</p>
  ${deadlinesHtml}
  ${newLinksHtml}
  <p style="margin-top: 8px; font-size: 14px; color: #8888a0; text-align: center;">
    <a href="https://aixdemocracy.fyi" style="color: #2d5be3;">Visit ${escapeHtml(siteName)}</a>
  </p>
</div>`;

  const previewParts = [];
  if (deadlines.length > 0) previewParts.push(`${deadlines.length} upcoming deadline${deadlines.length === 1 ? "" : "s"}`);
  if (newLinks.length > 0) previewParts.push(`${newLinks.length} new resource${newLinks.length === 1 ? "" : "s"}`);
  const previewText = previewParts.join(" and ") + ` on ${siteName}`;

  return { subject, html, previewText, newLinks, deadlines, siteName };
}

// Cron handler: generate draft broadcast (human must approve + send from Kit)
async function sendMonthlyDigest(env) {
  const digest = await generateDigest(env);
  if (digest.newLinks.length === 0 && digest.deadlines.length === 0) return;

  // Create as draft (no send_at) — requires human approval in Kit
  const resp = await fetch("https://api.kit.com/v4/broadcasts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kit-Api-Key": env.KIT_API_KEY,
    },
    body: JSON.stringify({
      content: digest.html,
      subject: digest.subject,
      description: `Monthly digest — ${digest.deadlines.length} deadlines, ${digest.newLinks.length} new resources`,
      public: false,
      preview_text: digest.previewText,
    }),
  });

  if (!resp.ok) return;

  const data = await resp.json().catch(() => ({}));
  const broadcastId = data.broadcast && data.broadcast.id;

  // Update last_send so the "new links" window resets for next month
  await env.KV.put("newsletter:last_send", new Date().toISOString());

  // Send notification email to admin
  if (env.SEND_EMAIL && env.NOTIFY_EMAIL) {
    try {
      const kitUrl = broadcastId
        ? `https://app.kit.com/campaigns/${broadcastId}/draft`
        : "https://app.kit.com/campaigns?status=draft";

      const rawEmail = [
        `From: noreply@aixdemocracy.fyi`,
        `To: ${env.NOTIFY_EMAIL}`,
        `Subject: AlignedGov: Monthly digest draft ready for review`,
        `Content-Type: text/html; charset=utf-8`,
        ``,
        `<p>A new monthly digest draft has been created on Kit with <strong>${digest.deadlines.length}</strong> deadline(s) and <strong>${digest.newLinks.length}</strong> new resource(s).</p>`,
        `<p>Subject: <em>${escapeHtml(digest.subject)}</em></p>`,
        `<p><a href="${kitUrl}">Review and send the draft on Kit</a></p>`,
      ].join("\r\n");

      const { EmailMessage } = await import("cloudflare:email");
      const message = new EmailMessage(
        "noreply@aixdemocracy.fyi",
        env.NOTIFY_EMAIL,
        new TextEncoder().encode(rawEmail)
      );
      await env.SEND_EMAIL.send(message);
    } catch (e) {
      // Notification failure shouldn't block the draft creation
      console.error("Failed to send notification email:", e.message);
    }
  }
}

// Admin endpoint: create a draft broadcast (no send) for preview
async function handleDraftDigest(request, env) {
  // Auth check
  const authKey = request.headers.get("X-Admin-Key");
  if (!authKey || authKey !== env.ADMIN_KEY) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const digest = await generateDigest(env);
  if (digest.newLinks.length === 0 && digest.deadlines.length === 0) {
    return jsonResponse({ error: "Nothing to send — no upcoming deadlines and no new links since last send", linkCount: 0 }, 200);
  }

  // Create as draft (send_at: null)
  const resp = await fetch("https://api.kit.com/v4/broadcasts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kit-Api-Key": env.KIT_API_KEY,
    },
    body: JSON.stringify({
      content: digest.html,
      subject: digest.subject,
      description: `[DRAFT] Monthly digest — ${digest.deadlines.length} deadlines, ${digest.newLinks.length} new resources`,
      public: false,
      preview_text: digest.previewText,
    }),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    return jsonResponse({ error: "Kit API error", details: data }, resp.status);
  }

  const broadcastId = data.broadcast && data.broadcast.id;

  return jsonResponse({
    success: true,
    linkCount: digest.newLinks.length,
    subject: digest.subject,
    broadcastId: broadcastId,
    kitUrl: broadcastId ? `https://app.kit.com/campaigns/${broadcastId}/draft` : null,
  });
}

function escapeHtml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
