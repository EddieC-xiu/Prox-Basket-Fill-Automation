# Basket Filler

A lightweight grocery basket-filling tool that maps a human shopping list to real Kroger product listings, complete with confidence scoring, substitution detection, caching, and persistence.

---

## Why Kroger?

Kroger operates the largest US supermarket chain (~2 700 stores) and offers a **free, official REST API** at [developer.kroger.com](https://developer.kroger.com).  Unlike scraping or third-party proxies, the official API:

- Is legal and stable
- Returns structured product data (name, brand, price, size, image, UPC)
- Supports location-scoped inventory lookup (exact prices per store)
- Uses standard OAuth2 client-credentials auth

No proxy costs, no HTML parsing, no terms-of-service risk.

---

## Quick Start

### 1. Clone & install

```bash
git clone <repo>
cd basket-filler
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Description |
|---|---|---|
| `KROGER_CLIENT_ID` | Yes | From developer.kroger.com |
| `KROGER_CLIENT_SECRET` | Yes | From developer.kroger.com |
| `PORT` | Optional | Default `3000` |
| `DB_PATH` | Optional | Default `./data/baskets.db` |
| `CACHE_TTL_SECONDS` | Optional | Default `3600` |

### 3. Run CLI

```bash
npm run fill:basket -- --input=sample-basket.json
```

With explicit overrides:

```bash
npm run fill:basket -- --input=sample-basket.json --retailer=kroger --zip=10001
```

JSON output:

```bash
npm run fill:basket -- --input=sample-basket.json --json
```

### 4. Run Web UI / API

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Input Format

```json
{
  "retailer": "kroger",
  "zip": "90046",
  "items": [
    { "query": "milk", "size_preference": "1 gallon" },
    { "query": "eggs", "size_preference": "12 count" },
    { "query": "avocados", "notes": "organic if possible" },
    { "query": "chicken breast", "notes": "boneless skinless" },
    { "query": "tortilla chips" },
    { "query": "greek yogurt", "brand_preference": "Chobani" },
    { "query": "peanut butter", "size_preference": "16 oz" },
    { "query": "bananas" }
  ]
}
```

Each item supports:

| Field | Type | Description |
|---|---|---|
| `query` | string (required) | Natural-language item name |
| `brand_preference` | string | Preferred brand (e.g. `"Chobani"`) |
| `size_preference` | string | Preferred size (e.g. `"16 oz"`, `"1 gallon"`) |
| `notes` | string | Free-text qualifiers (e.g. `"organic"`, `"boneless skinless"`) |

---

## Output Format

```json
{
  "run_id": 1,
  "retailer": "kroger",
  "zip": "90046",
  "created_at": "2024-01-15T10:30:00.000Z",
  "fill_rate": 0.9,
  "items": [
    {
      "requested_query": "greek yogurt",
      "brand_preference": "Chobani",
      "matched_product_name": "Chobani Plain Nonfat Greek Yogurt",
      "retailer": "kroger",
      "price": 5.99,
      "size": "32 oz",
      "product_url": "https://www.kroger.com/p/chobani-plain-nonfat-greek-yogurt/0081840700011",
      "image_url": "https://www.kroger.com/product/images/xlarge/front/0081840700011",
      "match_confidence": 0.91,
      "match_notes": "brand matched \"Chobani\"",
      "is_substitute": false,
      "is_unmatched": false,
      "cached": false
    }
  ]
}
```

---

## Matching Logic

Scoring uses a weighted sum of four signals:

| Signal | Weight | How computed |
|---|---|---|
| **Token similarity** | 40% | Jaccard overlap of lowercase word tokens between query and product name |
| **Brand match** | 25% | Full credit if product brand matches `brand_preference`; neutral (0.5) if no preference |
| **Size match** | 20% | Numeric ratio of parsed sizes; 1.0 for exact match, decays toward 0 |
| **Notes match** | 15% | Fraction of qualifier keywords (organic, boneless, frozen, …) found in product name |

**Classification thresholds:**

| Score | Classification |
|---|---|
| ≥ 0.80 | Exact match ✓ |
| 0.40 – 0.79 | Substitute ~ |
| < 0.40 | Unmatched ✗ |

**Substitution heuristic:** if fewer than half the query tokens appear in the matched product name, the result is flagged as a substitute even if the numeric score is high.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/basket` | Fill a basket (body = `BasketInput`) |
| `GET` | `/api/runs` | List recent basket runs |
| `GET` | `/api/runs/:id` | Detail for a specific run |

---

## Database Schema

```
basket_runs       – one row per fill:basket invocation
basket_requests   – one row per requested item
basket_matches    – matched product for each request
product_cache     – cached Kroger search results (retailer, location, query)
location_cache    – cached ZIP → store locationId
```

See [`migrations/001_init.sql`](migrations/001_init.sql) for the full schema.

---

## Reliability & Cost Features

- **In-DB product cache** — identical queries within TTL skip the Kroger API entirely
- **Location cache** — ZIP → store ID never re-fetched
- **Request deduplication** — duplicate items in a single basket share one search
- **Retry with back-off** — `p-retry` wraps all Kroger API calls (3 retries, 500 ms base)
- **Concurrency cap** — `p-limit(3)` prevents thundering-herd on the API
- **Auth token cache** — OAuth2 token reused until 60 s before expiry
- **Graceful fallback** — unmatched items are flagged, not errored

---

## Tooling Decisions

| Choice | Reason |
|---|---|
| **TypeScript** | Type safety across API shapes, matcher logic, and DB layer |
| **better-sqlite3** | Zero-config embedded DB, synchronous API, WAL mode for performance |
| **p-retry + p-limit** | Battle-tested concurrency primitives; avoid rolling custom retry |
| **Express** | Minimal overhead for a simple CRUD API + static file serving |
| **Commander** | Industry-standard CLI argument parsing |
| **Vanilla HTML/JS UI** | No build step needed; ships immediately with the server |

---

## Tradeoffs

| Decision | Upside | Downside |
|---|---|---|
| SQLite cache | Zero infrastructure, instant setup | Not shared across server replicas |
| Deterministic scorer | Predictable, free, fast | Misses semantic equivalence ("nonfat" vs "fat-free") |
| Single-retailer scope | Deep integration, reliable | Can't compare prices across chains |
| Real API only | Always live catalog & prices | Requires Kroger developer account |

---

## Scale & Cost Strategy

See [`SCALE_STRATEGY.md`](SCALE_STRATEGY.md) for the full write-up covering caching strategy, deterministic vs AI use cases, scaling to 5 000 users, and cost controls.

---

## Project Structure

```
basket-filler/
├── src/
│   ├── index.ts          CLI entry point
│   ├── server.ts         Express API + static UI
│   ├── basket.ts         Orchestrator (search, match, persist)
│   ├── matcher.ts        Scoring & ranking logic
│   ├── db.ts             SQLite layer + migrations
│   ├── types.ts          Shared TypeScript types
│   └── retailers/
│       └── kroger.ts     Kroger API adapter
├── public/
│   └── index.html        Single-page web UI
├── migrations/
│   └── 001_init.sql      Database schema
├── sample-basket.json    Example input
├── SCALE_STRATEGY.md     1-page cost & scale write-up
└── README.md
```
