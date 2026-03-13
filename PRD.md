# AI×Democracy.FYI — Product Requirements Document

**Version:** 4.0
**Date:** March 12, 2026
**Author:** Sean + Claude
**Status:** Active

---

## 1. Overview

A publicly accessible ecosystem map where a community of rotating editors curate URLs about AI & Democracy. The site displays enriched link previews (title, description, og:image) fetched automatically, with no manual deployment required to update content.

## 2. Goals

- Zero-friction content updates — editors add links to Google Sheets; the site reflects changes within 24 hours with no code deploys
- Rich link previews — each link automatically displays title, description, and og:image scraped once and cached, re-scraped every 7 days
- Custom domain — hosted at **aixdemocracy.fyi** on Cloudflare
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
| Newsletter / Email | Kit (ConvertKit) | Free tier (up to 10k subscribers) |

### 4.2 Caching Strategy

Single KV cache layer.

| Layer | Mechanism | TTL | Effect |
|---|---|---|---|
| KV (merged cache) | Cloudflare KV stores merged enriched link dataset | 24 hours | On KV hit, Worker returns data without re-fetching Sheet or re-scraping. On KV miss, full fetch + enrichment cycle runs. |
| KV (individual OG) | Per-URL OG data keyed by sha256(url).slice(0,16) | No TTL (re-scraped when stale) | Individual entries persist until re-scraped at 7-day intervals |

**Manual cache invalidation:** `GET /bust` deletes the merged KV entry, forcing a full re-fetch on the next visit. Also accessible from the admin page UI.

### 4.3 Data Flow

1. User visits aixdemocracy.fyi — Cloudflare Pages serves static HTML/JS instantly
2. Frontend JS calls GET /api/links on the Cloudflare Worker
3. Worker checks KV for merged enriched dataset (24hr TTL)
4. On KV hit: Worker returns dataset immediately (~10–30ms). Done.
5. On KV miss: Worker fetches Google Sheets published CSVs (Approved Links, Editors, Orgs, Config, Deadlines tabs)
6. For each approved row, Worker checks KV for individual OG enrichment entry keyed by hash(url)
7. Missing or stale (> 7 days) OG entries are scraped asynchronously via waitUntil() — response is not blocked
8. Worker merges Sheet rows + OG enrichment, sorts by power desc / row_id asc, writes merged dataset to KV (24hr TTL)
9. Worker returns `{ links, editors, orgs, deadlines, config }` to frontend; frontend renders enriched link cards

### 4.4 Async Enrichment Behavior

To avoid blocking the first visitor after a KV cache miss when many new links exist, the Worker:

- Returns immediately with all currently available data (existing OG enrichment where present, nulls where not yet scraped)
- Triggers scraping of unenriched/stale URLs asynchronously using waitUntil()
- Newly approved links will be fully enriched by the next request after scraping completes

## 5. Database Schema (Google Sheets)

The Google Sheet is the single source of truth for all human-curated data. The Worker reads published CSV tabs — no API key required.

### Sheet Tabs

| Tab Name | Published CSV gid | Purpose |
|---|---|---|
| Approved Links | 1419865336 | Links displayed on the site |
| Editors | 0 | Editor profiles for Team tab on About page |
| Orgs | 599532148 | Organizations (relational parent for links) |
| Config | 1010322382 | Key/value site configuration |
| Deadlines | 950777082 | Upcoming program deadlines |
| Submitted Links | N/A (not read by Worker) | Google Form submission queue |
| Submitted Editors | N/A (not read by Worker) | Editor application queue |

### 5.1 Approved Links Tab

Every row here appears on the site — no approval logic in code.

| Column | Type | Required | Description |
|---|---|---|---|
| url | string | Yes | Full URL of the link. Row skipped if blank. |
| category | string | Yes | Freeform category label. Defaults to 'Uncategorized' if blank. |
| power | integer 1–10 | No | Editor-assigned quality/relevance score. Defaults to 0. Sort order only — not shown publicly. |
| notes | string | No | Optional editor commentary shown on the card. |
| org | string | No | URL matching an Orgs row — creates relational link to parent org. |
| title | string | No | Override for scraped OG title. |
| description | string | No | Override for scraped OG description. |
| deleted_at | string | No | Soft-delete timestamp. Row hidden from output if present. |

**OG enrichment fields** (title, description, og_image, site_name, date_scraped) live exclusively in Cloudflare KV, keyed by sha256(url).slice(0,16). Title/description overrides in the sheet take precedence over scraped values.

### 5.2 Editors Tab

| Column | Type | Required | Description |
|---|---|---|---|
| name | string | Yes | Editor's display name |
| email | string | Yes | Used to generate Gravatar URL (MD5 hashed client-side) |
| role | string | No | e.g. Founder, Editor, Contributor |
| bio | string | No | Short bio shown on editor card |
| url | string | No | Personal website or profile link |
| photo_url | string | No | Optional override for Gravatar. If blank, Gravatar is used. |

### 5.3 Orgs Tab

| Column | Type | Required | Description |
|---|---|---|---|
| url | string | Yes | Organization's website URL. Used as join key from Approved Links. |
| category | string | Yes | Org category (Non-profits, University Labs, etc.) |
| title | string | No | Override for scraped OG title. |
| description | string | No | Override for scraped OG description. |
| people | string | No | Key people, newline-separated. |
| power | integer | No | Sort weight for org display order. |
| deleted_at | string | No | Soft-delete timestamp. |

### 5.4 Config Tab

Key/value pairs for site configuration.

| Key | Description |
|---|---|
| title | Site brand name shown in nav and page titles (e.g. "AI×Democracy.FYI") |
| heading | Main heading on the home page |
| subheading | Subheading on the home page |
| description | Meta description / hero text |
| footer | Footer text shown on all pages |

### 5.5 Deadlines Tab

| Column | Type | Required | Description |
|---|---|---|---|
| url | string | Yes | URL of the program/opportunity |
| deadline | string (ISO 8601) | Yes | Deadline date, e.g. "2026-03-16" |
| title | string | No | Override for scraped OG title |
| description | string | No | Override for scraped OG description |

Deadlines are enriched with OG data just like links. Frontend filters to show only deadlines within 1 week past, sorted ascending by date. Passed deadlines show "(passed)" label.

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

Newsletter link tracking keys:
```
Key:    newsletter:link:{sha256(url).slice(0,16)}
Value:  { "url": string, "first_seen": ISO8601 string }
```

Last send timestamp: `newsletter:last_send` (ISO8601 string, updated only by the cron handler after a successful broadcast send)

## 7. Newsletter System

### 7.1 Overview

Visitors can subscribe to a monthly email digest via a signup form on the homepage. Emails are managed through Kit (ConvertKit) using their free tier. The system supports double opt-in — subscribers must confirm via a Kit confirmation email before receiving broadcasts.

### 7.2 Signup Flow

1. Visitor enters email in the homepage signup form
2. Frontend POSTs to Worker endpoint `POST /api/subscribe` with `{ email }`
3. Worker creates subscriber on Kit as `state: "inactive"` via `POST /v4/subscribers`
4. Worker adds subscriber to a Kit Form via `POST /v4/forms/{KIT_FORM_ID}/subscribers`
5. Kit automatically sends a double opt-in confirmation email
6. Subscriber clicks confirmation link → status becomes "active" on Kit
7. Frontend shows inline success/error message (no Kit-branded UI on the site)

### 7.3 Monthly Digest (Cron)

A Cloudflare Worker Cron Trigger fires on the 1st of each month at 9 AM UTC (`0 9 1 * *`).

The digest includes two sections:
- **Opportunities — Upcoming Deadlines:** All deadlines not more than 7 days past (same filter as homepage), sorted ascending by date. Title/description sourced from sheet overrides first, then OG metadata from KV.
- **New Resources:** Links whose `first_seen` timestamp in KV is after the `newsletter:last_send` timestamp. Title/description sourced from sheet overrides first, then OG metadata from KV.

The email is only sent if there is at least one deadline OR one new link. After a successful send, `newsletter:last_send` is updated in KV.

**Subject line logic:**

| New Resources? | Upcoming Deadlines? | Subject Line |
|---|---|---|
| Yes | Yes | New Resources & Upcoming Deadlines |
| Yes | No | What's new this month? |
| No | Yes | Upcoming Deadlines |
| No | No | *(no email sent)* |

### 7.4 Link First-Seen Tracking

When the Worker fetches and merges links (on cache miss), it checks each link URL against KV. For any link not previously seen, it stores a `newsletter:link:{hash}` entry with the current timestamp. This runs as part of the existing cache-refresh flow via `waitUntil()`.

### 7.5 Draft Digest (Admin)

The admin page has a "Create Draft Digest" button that generates the same digest content but creates a Kit broadcast draft (no `send_at`). This allows previewing and sending test emails from Kit's UI without affecting subscribers or updating `newsletter:last_send`.

Protected by an admin key sent via `X-Admin-Key` header, validated against the `ADMIN_KEY` Worker secret.

### 7.6 Kit Configuration

| Item | Details |
|---|---|
| Kit Form ID | Stored as Worker secret `KIT_FORM_ID` |
| Kit API Key | Stored as Worker secret `KIT_API_KEY` |
| Admin Key | Stored as Worker secret `ADMIN_KEY` |
| Kit Dashboard (drafts) | https://app.kit.com/campaigns?status=draft |

## 8. Cloudflare Worker

### 8.1 Endpoints

- `GET /api/links` — Returns `{ links, editors, orgs, deadlines, config }` as JSON.
- `GET /bust` — Deletes the merged KV dataset entry, forcing full re-fetch on next visit. No auth required.
- `POST /api/subscribe` — Subscribes an email to the newsletter via Kit (double opt-in). Body: `{ email }`.
- `POST /api/draft-digest` — Creates a draft broadcast on Kit for preview. Requires `X-Admin-Key` header.

**CORS:** Allows *.pages.dev, localhost, alignedgov.org, www.alignedgov.org, aixdemocracy.fyi, www.aixdemocracy.fyi. `X-Admin-Key` included in `Access-Control-Allow-Headers`.

### 8.2 Worker Responsibilities

- Fetch published CSV URLs (Approved Links, Editors, Orgs, Config, Deadlines) from Google Sheets
- Parse CSVs with RFC 4180 parser handling quoted fields with embedded newlines
- Skip rows with blank url; treat blank power as 0; treat blank category as 'Uncategorized'
- Skip rows with `deleted_at` populated (soft-delete)
- Assign row_id (1-based integer, position in tab excluding header)
- Apply title/description overrides from sheet columns (take precedence over scraped OG values)
- For each URL, look up individual OG enrichment KV entry by sha256(url).slice(0,16)
- Scrape unenriched/stale rows asynchronously via waitUntil()
- Merge Sheet rows + OG enrichment, sort by power desc / row_id asc
- Write merged dataset to KV with 24hr TTL

### 8.3 Scraper Behavior

- Fetch target URL with browser-like User-Agent (`AlignedGovBot/1.0`)
- Parse `<meta>` tags for og:title, og:description, og:image, og:site_name
- Fall back to `<title>` tag if og:title absent or generic
- Generic title detection: known SPA patterns (Notion, Amazon, LinkedIn, Airtable) → fall back to URL slug extraction
- Resolve relative og:image URLs to absolute
- Store result regardless of success/failure — always write date_scraped to prevent infinite retry loops
- 5-second fetch timeout per URL
- Max 2 redirects

### 8.4 Cron Trigger

`0 9 1 * *` — 1st of each month at 9 AM UTC. Calls `sendMonthlyDigest()` which generates and sends the digest broadcast via Kit API.

### 8.5 wrangler.toml Environment Variables

```toml
LINKS_CSV_URL     = "...pub?gid=1419865336&single=true&output=csv"
EDITORS_CSV_URL   = "...pub?gid=0&single=true&output=csv"
ORGS_CSV_URL      = "...pub?gid=599532148&single=true&output=csv"
CONFIG_CSV_URL    = "...pub?gid=1010322382&single=true&output=csv"
DEADLINES_CSV_URL = "...pub?gid=950777082&single=true&output=csv"
```

## 9. Frontend

### 9.1 Site Identity

- **Domain:** aixdemocracy.fyi
- **Brand name, heading, subheading, description, footer:** All pulled dynamically from Config sheet
- **Page titles:** Set dynamically via JS from config (e.g. "About — AI×Democracy.FYI")

### 9.2 File Structure

Static files deployed to Cloudflare Pages from GitHub repo. Auto-deploys on git push (~30 seconds).

```
index.html      — Home page (org-centric resource list + deadlines + editor writings)
about.html      — About page with pill tabs (About, Team, Become an Editor)
submit.html     — Submit a Resource page
admin.html      — Unlisted admin page (cache bust, CRM, form links)
resources.html  — Redirect to /
styles.css      — Shared design system
favicon.svg     — SVG network-node favicon
worker.js       — Cloudflare Worker (deployed separately via Wrangler)
wrangler.toml   — Worker configuration
```

### 9.3 Pages

**/ — Home (Resource List)**
- Deadlines section at top — shows upcoming program deadlines within 1 week past, sorted ascending. Passed deadlines show "(passed)".
- Org-centric view: orgs grouped by category, each org card shows org identity (favicon, name, description, category, people) + nested link list
- "Independent Resources" section for links not matched to any org
- "Editor Writings" section for links with category "editor"
- Newsletter signup form in hero area — email input + subscribe button, posts to Worker `/api/subscribe`
- Submit a Resource CTA button at bottom
- Dynamic nav brand, footer, and document.title from config

**Cards & link display:**
- Each link: favicon (Google Favicon API), meta line (source + category badge), title, description, editor notes
- Links sorted by power descending, row_id ascending for tiebreak
- DOM-based card creation (not innerHTML) to prevent XSS/escaping issues

**/about — About Page**
- Pill tab navigation: About, Team, Become an Editor
- **About tab:** Mission, how it works, what belongs here, who it's for, get involved section with anti-spam email link (hello@aixdemocracy.fyi assembled via JS)
- **Team tab:** Horizontal full-width editor cards (avatar, name, role, bio, link). "Become an editor →" link to switch tabs.
- **Become an Editor tab:** Intro copy, callout, two always-visible detail sections (responsibilities + what good editorship looks like), Apply button → Google Form

**/submit — Submit a Resource**
- Explains purpose and submission criteria
- CTA button links to Google Form (opens in new tab)

**/admin — Admin (unlisted)**
- `noindex` meta tag
- Bust Cache button (calls Worker `/bust` endpoint)
- CRM link (Google Sheet)
- Submit Resource Form (View + Edit links)
- Apply to be an Editor Form (View + Edit links)
- Newsletter Digest section: admin key input + "Create Draft" button → creates draft on Kit. Shows link to view draft on Kit.
- Kit Dashboard link (drafts view)

### 9.4 Navigation

Shared top nav across all pages:
- Nav brand (site title from config, links to /)
- Home (/)
- About (/about.html)
- Submit a Resource (/submit.html)
- Active page highlighted

### 9.5 OG Metadata

All pages include Open Graph and Twitter Card meta tags:
- og:title, og:description, og:image, og:url, og:site_name
- twitter:card (summary_large_image)
- og:image points to `https://alignedgov.pages.dev/og-image.png`

### 9.6 Dynamic Content from Config

All pages fetch `/api/links` on load to populate:
- Nav brand text (from config.title)
- Page title (from config.title)
- Footer text (from config.footer)

### 9.7 Design Principles

- Clean, editorial aesthetic appropriate for a governance/policy ecosystem map
- Shared styles.css — global design changes in one file
- Content updates require zero code changes
- Accessible: semantic HTML, sufficient color contrast
- Power score is internal only — never displayed to public visitors

## 10. Access & Permissions

| Role | Access Method | Capabilities |
|---|---|---|
| Public visitor | Website (no auth) | Browse links, view about/team, submit via Google Form |
| Public submitter | Google Form | Submit URL + metadata; row lands in Submitted Links |
| Editor (up to 100) | Google Sheets (shared) | Add/edit/delete rows, approve submissions |
| Editor applicant | Google Form | Apply to become a rotating editor |
| Admin | /admin page (unlisted, no auth) | Bust cache, access CRM and forms |
| Developer | GitHub + Cloudflare Pages | Edit frontend design and Worker logic |

## 11. Cost Summary

| Service | Monthly Cost | Notes |
|---|---|---|
| Google Sheets | $0 | Free, up to 100 editors |
| Google Forms | $0 | Free, linked to Sheet |
| Cloudflare Pages | $0 | Unlimited requests, 500 builds/mo |
| Cloudflare Worker | $0 | 100k req/day free tier |
| Cloudflare KV | $0 | 100k reads, 1k writes/day free |
| Gravatar | $0 | Photo hosting via email hash |
| Domain (aixdemocracy.fyi) | ~$0.83/mo | Amortized annual registration |
| Kit (ConvertKit) | $0 | Free up to 10k subscribers |
| **Total** | **~$1/mo** | Domain cost only |

## 12. Credentials & Values Reference

| Variable | Value |
|---|---|
| LINKS_CSV_URL | `...pub?gid=1419865336&single=true&output=csv` |
| EDITORS_CSV_URL | `...pub?gid=0&single=true&output=csv` |
| ORGS_CSV_URL | `...pub?gid=599532148&single=true&output=csv` |
| CONFIG_CSV_URL | `...pub?gid=1010322382&single=true&output=csv` |
| DEADLINES_CSV_URL | `...pub?gid=950777082&single=true&output=csv` |
| Google Form (submissions) | `https://forms.gle/s8WjAG8YENCvZVwh7` |
| Google Form (editor apps) | `https://forms.gle/dcZnTDsyLitvhB2x6` |
| CRM Spreadsheet | `https://docs.google.com/spreadsheets/d/1jDfHpPcuQeW78y5V6rBJALCNKd62AJPrKnUdI8JFytg/edit` |
| Submit Form (edit) | `https://docs.google.com/forms/d/1Eg7Ww3n7xwmkef8cKq-WUij92ucKwERCsiFhmaxTMWo/edit` |
| Apply Form (edit) | `https://docs.google.com/forms/d/1kSHsBTI6jeAP1-wtfNvQiSzZsbhB19GrDoeXl-R7dj0/edit` |
| KIT_API_KEY | Worker secret (set via `wrangler secret put KIT_API_KEY`) |
| KIT_FORM_ID | Worker secret (`9201052`) |
| ADMIN_KEY | Worker secret (for draft-digest endpoint auth) |
| KV_NAMESPACE_ID | `6b9f010f78674b9987d69ea2add08a03` |
| WORKER_URL | `https://alignedgov-worker.seanahrens.workers.dev` |
| PAGES_DEV_URL | `https://alignedgov.pages.dev` |
| Production URL | `https://aixdemocracy.fyi` |

## 13. Ongoing Human + AI Workflow

### Content Updates (zero code — Sean or any editor)
- Add a link: open Approved Links tab, add row with url, category, power. Appears on site within 24 hours.
- Approve a submission: copy url/category/notes from Submitted Links to Approved Links, set power.
- Force immediate refresh: visit /admin and click "Bust Cache", or hit `WORKER_URL/bust` directly.
- Add an editor: append row to Editors tab.
- Add a deadline: append row to Deadlines tab with url and ISO date.
- Soft-delete a link or org: fill in `deleted_at` column with any value.

### Design & Feature Changes (Claude Code)
Open Claude Code in the repo folder. Describe what you want in plain English. Claude Code edits the relevant files and pushes — Cloudflare Pages deploys in ~30 seconds. Worker changes require `wrangler deploy`.

### Deployment
- **Frontend:** `git push` → Cloudflare Pages auto-deploys (~30 seconds)
- **Worker:** `wrangler deploy` from the repo directory

## 14. Future Considerations

- date_added column to display when a link was added
- Pagination or infinite scroll if collection grows beyond ~200 links
- In-page submission form (Cloudflare Worker + Google service account)
- Search across title, description, and category
- CDN cache layer on top of KV if traffic grows significantly
