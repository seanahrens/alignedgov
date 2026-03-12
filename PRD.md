# AlignedGov — Product Requirements Document

**Version:** 2.0
**Date:** March 12, 2026
**Author:** Sean + Claude
**Status:** Active

---

## 1. Overview

A publicly accessible ecosystem map where a community of editors curate URLs about AI & Democracy. The site displays enriched link previews (title, description, og:image) fetched automatically, with no manual deployment required to update content.

## 2. Goals

- Zero-friction content updates — editors add links to Google Sheets; the site reflects changes within 24 hours with no code deploys
- Rich link previews — each link automatically displays title, description, and og:image scraped once and cached, re-scraped every 7 days
- Custom domain — hosted on user's existing Cloudflare-managed domain (alignedgov.org)
- Claude-programmable frontend — design is expressed in code (HTML/JS) so Claude can iterate on it freely
- Near-zero cost — target $0–2/mo beyond existing domain registration

## 3. Non-Goals

- User authentication or public submissions — editing is restricted to invited Google account holders
- Real-time updates — 24-hour cache staleness is acceptable
- Server-side rendering framework — no Next.js/Astro build pipeline required
- Write-back to Google Sheets from the scraper

## 4. Architecture

### 4.1 Stack

| Layer | Tool | Cost |
|---|---|---|
| Database | Google Sheets | Free |
| OG Enrichment Cache | Cloudflare KV | Free tier (100k reads/day, 1k writes/day) |
| API / Scraper Logic | Cloudflare Worker | Free tier (100k req/day) |
| Frontend Hosting | Cloudflare Pages | Free (unlimited requests) |
| CDN / DNS / Domain | Cloudflare | Free (domain cost ~$10/yr) |
| Public Submissions | Google Forms | Free |

### 4.2 Caching Strategy

Single KV cache layer. CDN caching evaluated and rejected for v1.0 — at low traffic volumes, the Worker reading one KV key (~10–30ms) is fast and free within Cloudflare's generous free tier.

| Layer | Mechanism | TTL | Effect |
|---|---|---|---|
| KV (merged cache) | Cloudflare KV stores merged enriched link dataset | 24 hours | On KV hit, Worker returns data without re-fetching Sheet or re-scraping. On KV miss, full fetch + enrichment cycle runs. |
| KV (individual OG) | Per-URL OG data keyed by sha256(url).slice(0,16) | No TTL (re-scraped when stale) | Individual entries persist until re-scraped at 7-day intervals |

**Manual cache invalidation:** `GET /bust` deletes the merged KV entry, forcing a full re-fetch on the next visit. No secret key required — simple memorable URL.

### 4.3 Data Flow

1. User visits alignedgov.org — Cloudflare Pages serves static HTML/JS instantly
2. Frontend JS calls GET /api/links on the Cloudflare Worker
3. Worker checks KV for merged enriched dataset (24hr TTL)
4. On KV hit: Worker returns dataset immediately (~10–30ms). Done.
5. On KV miss: Worker fetches Google Sheets published CSVs (Approved Links, Editors, Orgs, Config tabs)
6. Worker reads all rows from Approved Links — every row shown on site, no filtering needed
7. For each approved row, Worker checks KV for individual OG enrichment entry keyed by hash(url)
8. Missing or stale (> 7 days) OG entries are scraped asynchronously via waitUntil() — response is not blocked
9. Worker merges Sheet rows + OG enrichment, sorts by power desc / row_id asc, writes merged dataset to KV (24hr TTL)
10. Worker returns { links: [...], editors: [...], orgs: [...], config: {...} } to frontend; frontend renders enriched link cards

### 4.4 Async Enrichment Behavior

To avoid blocking the first visitor after a KV cache miss when many new links exist, the Worker must:

- Return immediately with all currently available data (existing OG enrichment where present, nulls where not yet scraped)
- Trigger scraping of unenriched/stale URLs asynchronously using waitUntil() — these run after the response is sent
- Newly approved links will be fully enriched by the next request after scraping completes, typically within seconds of the first visit

## 5. Database Schema (Google Sheets)

The Google Sheet is the single source of truth for all human-curated data. The Worker reads published CSV tabs — no API key required.

### Sheet Tabs

| Tab Name | Published CSV gid | Purpose |
|---|---|---|
| Approved Links | 1419865336 | Links displayed on the site |
| Editors | 0 | Editor profiles for /editors page |
| Orgs | 599532148 | Organizations (relational parent for links) |
| Config | 1010322382 | Key/value site configuration |
| Submitted Links | N/A (not read by Worker) | Google Form submission queue |
| Submitted Editors | N/A (not read by Worker) | Editor application queue |

### 5.1 Approved Links Tab

Every row here appears on the site — no approval logic in code. Editors manually promote links here from Submitted Links (or add them directly).

| Column | Type | Required | Description |
|---|---|---|---|
| url | string | Yes | Full URL of the link. Row skipped entirely if blank. |
| category | string | Yes | Freeform category label. Defaults to 'Uncategorized' if blank. |
| power | integer 1–10 | No | Editor-assigned quality/relevance score. Defaults to 0. Used for sort order only — not shown publicly. |
| notes | string | No | Optional editor commentary shown on the card. |
| org | string | No | URL matching an Orgs row — creates relational link to parent org. |
| deleted_at | string | No | Soft-delete timestamp. Row hidden from output if present. |

**Note:** `submitter` and `approved_by` columns exist for human editorial workflow but are NOT included in the API output.

**OG enrichment fields** (title, description, og_image, site_name, date_scraped) live exclusively in Cloudflare KV, keyed by sha256(url).slice(0,16).

### 5.2 Editors Tab

| Column | Type | Required | Description |
|---|---|---|---|
| name | string | Yes | Editor's display name |
| email | string | Yes | Used to generate Gravatar URL (MD5 hashed client-side) |
| role | string | No | e.g. Founder, Editor, Contributor |
| bio | string | No | Short bio shown on editor card |
| url | string | No | Personal website or profile link |
| photo_url | string | No | Optional override for Gravatar. If blank, Gravatar is used. |

**Photo resolution:** Gravatar URL is requested at ?s=400 for retina display. Fallback: identicon.

### 5.3 Orgs Tab

| Column | Type | Required | Description |
|---|---|---|---|
| url | string | Yes | Organization's website URL. Used as join key from Approved Links. |
| category | string | Yes | Org category (Non-profits, University Labs, etc.) |
| people | string | No | Key people, newline-separated. |
| power | integer | No | Sort weight for org display order. |

Org title, description, favicon, and og_image are scraped from the org's URL and cached in KV (same pattern as link scraping).

### 5.4 Config Tab

Key/value pairs for site configuration.

| Column | Description |
|---|---|
| key | Config key name (e.g. heading, subheading, description) |
| value | Config value |

Current keys: `heading`, `subheading`, `description`

### 5.5 Submitted Links Tab

Receives public submissions from the Google Form. Never read by the Worker — this is a human review queue only.

## 6. Cloudflare KV Schema

Each enriched URL is stored as a single KV entry.

```
Key:    sha256(url).slice(0, 16)
Value:  {
  "title": string | null,
  "description": string | null,
  "og_image": string | null,
  "site_name": string | null,
  "date_scraped": ISO8601 string,
  "row_id": integer,
  "_v2": true
}
```

Merged dataset cache key: `merged_dataset_v1` (24hr TTL)

## 7. Cloudflare Worker

### 7.1 Endpoints

- `GET /api/links` — Returns { links, editors, orgs, config } as JSON. Links are OG-enriched, sorted by power desc / row_id asc.
- `GET /bust` — Deletes the merged KV dataset entry, forcing full re-fetch on next visit. No auth required.

**CORS:** Allows *.pages.dev, localhost, alignedgov.org, www.alignedgov.org

### 7.2 Worker Responsibilities

- Fetch published CSV URLs (Approved Links, Editors, Orgs, Config) from Google Sheets — no auth required
- Parse CSVs defensively: skip rows with blank url; treat blank power as 0; treat blank category as 'Uncategorized'
- Skip rows with `deleted_at` populated (soft-delete)
- Assign row_id (1-based integer, position in tab excluding header)
- For each URL, look up individual OG enrichment KV entry by sha256(url).slice(0,16)
- Identify unenriched (no KV entry) or stale (date_scraped > 7 days ago) rows
- Scrape unenriched/stale rows asynchronously via waitUntil()
- Merge Sheet rows + OG enrichment, sort by power desc / row_id asc
- Write merged dataset to KV with 24hr TTL
- Return { links, editors, orgs, config }

### 7.3 Scraper Behavior

- Fetch target URL with browser-like User-Agent (`AlignedGovBot/1.0`)
- Parse `<meta>` tags for og:title, og:description, og:image, og:site_name
- Fall back to `<title>` tag if og:title absent or generic
- Generic title detection: known SPA patterns (Notion, Amazon, LinkedIn, Airtable) → fall back to URL slug extraction
- Resolve relative og:image URLs to absolute
- Store result regardless of success/failure — always write date_scraped to prevent infinite retry loops
- 5-second fetch timeout per URL
- Max 2 redirects

### 7.4 wrangler.toml Environment Variables

```toml
LINKS_CSV_URL   = "...pub?gid=1419865336&single=true&output=csv"
EDITORS_CSV_URL = "...pub?gid=0&single=true&output=csv"
ORGS_CSV_URL    = "...pub?gid=599532148&single=true&output=csv"
CONFIG_CSV_URL  = "...pub?gid=1010322382&single=true&output=csv"
```

## 8. Frontend

### 8.1 Site Identity

- **Domain:** alignedgov.org
- **Heading:** AlignedGov (pulled from Config sheet)
- **Subheading:** Aligned AI Requires Aligned Governance
- **Description:** ecosystem map of orgs, people, and papers focused on the intersection of AI & Democracy

### 8.2 Hosting & File Structure

Static files deployed to Cloudflare Pages from GitHub repo. Auto-deploys on git push (~30 seconds).

```
index.html      — Home page (link collection, compact favicon-based cards)
orgs-test.html  — Org-centric view (test page)
editors.html    — Editors page
submit.html     — Submit a Resource page
bust.html       — Cache bust trigger page
styles.css      — Shared design system
favicon.svg     — SVG network-node favicon
worker.js       — Cloudflare Worker (deployed separately via Wrangler)
wrangler.toml   — Worker configuration
```

### 8.3 Pages

**/ — Home (Link Collection)**
- Site heading, subheading, and description at top (populated from Config sheet via API)
- Category filter pills — one pill per unique category, plus 'All' (default)
- Compact favicon-based card layout (two-column grid, single column on medium screens)
- Each card: favicon (Google Favicon API), meta line (source + category badge), title (single line, truncated with ellipsis), description (2-line fixed height), editor notes (if present)
- Cards sorted by power descending, row_id ascending for tiebreak
- DOM-based card creation (not innerHTML) to prevent XSS/escaping issues

**/editors — Editors Page**
- Editor cards displayed in a centered grid (max-width 420px per card for balanced single-editor layout)
- Each card: Gravatar (160x160px, MD5 hashed client-side) or photo_url, name, role, bio, link
- Ethos statement below editors: co-created, open, rotating stewards
- "Apply to be a rotating editor" link → Google Form

**/submit — Submit a Resource**
- Explains purpose and submission criteria
- CTA button links to Google Form (opens in new tab)

**/orgs-test — Org-Centric View (Test)**
- Org cards displayed in a single-column list
- Each org card: left side (org identity: favicon, linked name, description, category badge, key people) + right side (vertically-stacked link list with thin dividers)
- Org name links to the org's URL
- Links displayed as simple list items (favicon + meta + title + description), not cards — separated by thin horizontal lines
- Hover: light background fill on both org cards and individual link items
- Orgs sorted by power descending, row_id ascending
- Links matched to orgs via the `org` column (URL matching with normalization)
- Orphan links (no org match) collected into "Independent Resources" section at bottom
- Orgs without links display cleanly with just the org identity
- Responsive: stacks vertically on screens < 768px

**/bust — Cache Bust**
- Calls Worker `/bust` endpoint and shows confirmation

### 8.4 OG Metadata

All pages include hardcoded Open Graph and Twitter Card meta tags:
- og:title, og:description, og:image, og:url, og:site_name
- twitter:card (summary_large_image)
- og:image points to `https://alignedgov.pages.dev/og-image.png` (needs to be created)

### 8.5 Navigation

- Shared top nav across all pages via styles.css
- Nav links: Aligned Gov (home), Links, Editors, Submit a Resource
- Active page highlighted in nav

### 8.6 Design Principles

- Clean, editorial aesthetic appropriate for a governance/policy ecosystem map
- Shared styles.css — global design changes in one file
- Content updates require zero code changes
- Accessible: semantic HTML, sufficient color contrast, keyboard-navigable pills and cards
- Power score is internal only — never displayed to public visitors

## 9. Access & Permissions

| Role | Access Method | Capabilities |
|---|---|---|
| Public visitor | Website (no auth) | Browse links, filter by category, visit /editors, submit via Google Form |
| Public submitter | Google Form | Submit URL + metadata; row lands in Submitted Links |
| Editor (up to 100) | Google Sheets (shared) | Add/edit/delete rows, approve submissions |
| Editor applicant | Google Form | Apply to become a rotating editor |
| Developer | GitHub + Cloudflare Pages | Edit frontend design and Worker logic |

## 10. Cost Summary

| Service | Monthly Cost | Notes |
|---|---|---|
| Google Sheets | $0 | Free, up to 100 editors |
| Google Forms | $0 | Free, linked to Sheet |
| Cloudflare Pages | $0 | Unlimited requests, 500 builds/mo |
| Cloudflare Worker | $0 | 100k req/day free tier |
| Cloudflare KV | $0 | 100k reads, 1k writes/day free |
| Gravatar | $0 | Photo hosting via email hash |
| Domain (alignedgov.org) | ~$0.83/mo | Amortized annual registration |
| **Total** | **~$1/mo** | Domain cost only |

## 11. Credentials & Values Reference

| Variable | Where to get it | Value |
|---|---|---|
| LINKS_CSV_URL | Sheets → Publish to web → Approved Links tab → CSV | `...pub?gid=1419865336&single=true&output=csv` |
| EDITORS_CSV_URL | Same flow, Editors tab | `...pub?gid=0&single=true&output=csv` |
| ORGS_CSV_URL | Same flow, Orgs tab | `...pub?gid=599532148&single=true&output=csv` |
| CONFIG_CSV_URL | Same flow, Config tab | `...pub?gid=1010322382&single=true&output=csv` |
| GOOGLE_FORM_URL (submissions) | Google Forms → Share → Copy link | `https://forms.gle/s8WjAG8YENCvZVwh7` |
| GOOGLE_FORM_URL (editor apps) | Google Forms → Share → Copy link | `https://forms.gle/dcZnTDsyLitvhB2x6` |
| KV_NAMESPACE_ID | Cloudflare dashboard → KV | `6b9f010f78674b9987d69ea2add08a03` |
| WORKER_URL | Output by Claude Code after wrangler deploy | `https://alignedgov-worker.seanahrens.workers.dev` |
| PAGES_DEV_URL | Cloudflare Pages dashboard | `https://alignedgov.pages.dev` |

## 12. Ongoing Human + AI Workflow

### Content Updates (zero code — Sean or any editor)
- Add a link: open Approved Links tab, add row with url, category, power. Appears on site within 24 hours.
- Approve a submission: open Submitted Links tab, copy url/category/notes to new row in Approved Links, set power.
- Force immediate refresh: visit `https://alignedgov.pages.dev/bust`. Next page load fetches fresh data.
- Add an editor: append row to Editors tab. Site reflects it within 24 hours.
- Soft-delete a link: fill in `deleted_at` column with any value.

### Design & Feature Changes (Claude Code)
Open Claude Code in the repo folder. Describe what you want in plain English. Claude Code edits the relevant files and pushes — Cloudflare Pages deploys in ~30 seconds.

## 13. Future Considerations

- Promote org-centric view from test page to primary navigation
- RSS feed for subscribers
- date_added column to display when a link was added
- Power score shown publicly as visual indicator
- Pagination or infinite scroll if collection grows beyond ~200 links
- In-page submission form (Cloudflare Worker + Google service account)
- Search across title, description, and category
- CDN cache layer on top of KV if traffic grows significantly
