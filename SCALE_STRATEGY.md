# Scale & Cost Strategy

## How would you avoid re-solving "milk" for the same retailer and ZIP 1,000 times?

The system already caches at two levels:

1. **SQLite product cache** (`product_cache` table) — keyed on `(retailer, location_id, query_key)` with a configurable TTL (default 1 hour).  The first request for `(kroger, 01400943, "milk")` hits the Kroger API; the next 999 are answered from the local database in microseconds.

2. **Location cache** (`location_cache` table) — ZIP → store `locationId` never changes, so it's cached indefinitely.

At production scale, the product cache moves from SQLite → **Redis** (or DynamoDB) shared across all worker instances, with a TTL of 4–8 hours.  Grocery assortments change infrequently; a stale price by a few cents is almost always acceptable.

---

## What parts of this system would be cached?

| Layer | What | TTL |
|---|---|---|
| Location resolution | ZIP → Kroger `locationId` | indefinite (use ON CONFLICT update) |
| Product search results | raw Kroger product JSON per query | 1–8 hours |
| Match decisions | final basket match per `(query, location, brand, size, notes)` | 30–60 min |
| Auth token | Kroger OAuth2 bearer token | 1 800 s (30 min TTL minus buffer) |

Cached match decisions allow completely skipping the scoring step for repeat queries with identical parameters.

---

## What would be deterministic vs AI-assisted?

**Deterministic (current system):**
- Token-based Jaccard similarity scoring
- Brand/size/notes keyword matching
- Location resolution and product search
- Cache lookups and dedup

This handles the vast majority of queries cheaply and reliably.  A bag of "boneless skinless chicken breast" from Kroger almost always maps correctly via keyword overlap.

**AI-assisted (where worth the cost):**

| Scenario | Why AI helps | When to invoke |
|---|---|---|
| Ambiguous categories | "ranch" → dressing vs. flavor chip | Only if deterministic score < 0.5 |
| Spelling / brand aliases | "Haas avocado", "natty pb" | Pre-processing normalisation pass |
| Semantic mismatches | "protein bar" → which category? | Low-confidence items only |
| Substitution explanation | Generate natural-language rationale | On demand (user requests detail) |

**Rule of thumb:** invoke AI only when the deterministic score falls below the substitute threshold (0.40) or when a human-readable explanation is explicitly requested.  At $0.002 per AI call and 10 items per basket, the all-AI cost per basket is $0.02.  With a 90% cache-hit rate, the actual blended cost is ~$0.002 per basket.

---

## How would you improve basket fill quality over time?

1. **Feedback loop** — let users thumbs-up/down each match.  Store corrections in a `match_feedback` table.

2. **Override dictionary** — high-volume queries where the default scorer is wrong get a hand-curated `query → preferred_product_id` override table, updated weekly.

3. **Synonym expansion** — build a query-normalisation map (`nonfat` → `fat free`, `whole wheat` → `whole grain`) derived from confirmed corrections.

4. **A/B test scoring weights** — the four weights in `matcher.ts` are configurable.  Run weekly offline evaluations against the feedback corpus and promote weights that improve precision.

5. **Seasonal catalogues** — re-warm the product cache for the top 500 queries every night via a cron job, so cache hits are warm at peak morning traffic.

---

## How would this scale to 5,000 concurrent users?

| Component | Change |
|---|---|
| **Database** | Move from SQLite → PostgreSQL (or PlanetScale).  Add read replicas for history queries. |
| **Cache** | Shared Redis cluster replaces in-process SQLite cache. |
| **API workers** | Horizontally scale the Express service behind a load balancer (e.g. AWS ALB + ECS Fargate). |
| **Search concurrency** | Per-request `p-limit(3)` becomes a global rate-limiter token bucket to cap total outbound Kroger API QPS across all workers. |
| **Queue** | Replace synchronous fill with an async job queue (BullMQ + Redis).  POST /api/basket returns a job ID; the client polls `GET /api/jobs/:id` or uses a WebSocket. |
| **CDN** | Product images and the static UI are served from CloudFront.  Zero origin load for assets. |

At 5 000 users with an average basket of 10 items and a 90% cache hit rate, peak outbound Kroger API calls ≈ 5 000 × 10 × 0.10 = 5 000 req/s.  The Kroger public API allows ≈ 10 000 req/min per credential.  Solution: pool 2–3 API credential pairs and round-robin across them.

---

## How would you control search / proxy / API costs?

1. **Cache aggressively** — every product search is cached.  Most grocery items change price/availability less than once per day.  Extending TTL from 1 h → 8 h cuts Kroger API calls by 8×.

2. **Batch queries** — the dedup logic in `basket.ts` already collapses identical queries within a single basket.  Across users, a shared cache provides the same benefit globally.

3. **Pre-warm popular items** — top 1 000 queries (milk, eggs, bread, …) are refreshed nightly by a background job, so daytime traffic is nearly 100% cached.

4. **Tiered AI budget** — deterministic scoring is free.  AI is invoked only for low-confidence items (< 1% of queries in practice once the system matures).

5. **Circuit breaker** — if the Kroger API returns 429/503 repeatedly, fall back to returning the last cached result rather than hammering the endpoint and spending budget on retries.

6. **Observability** — instrument cache hit rate per query key.  Queries with < 50% hit rate are candidates for extended TTL or pre-warming.
