# Scale & Cost Strategy

One-page write-up for Track C, answering:

- How would you avoid re-solving “milk” for the same retailer and ZIP 1,000 times?
- What parts of this system would be cached?
- What would be deterministic vs AI-assisted?
- How would you improve basket fill quality over time?
- How would this scale to 5,000 users?
- How would you control search / proxy / API costs?

---

## How would you avoid re-solving “milk” for the same retailer and ZIP 1,000 times?

We already cheat in a good way: **we remember stuff in SQLite.**

1. **Product cache** — When we search Kroger for `"milk"` at a given store, we stash the raw results in a table keyed by retailer + store id + search text. First time = real API call. Next 999 times (within the TTL, default an hour) = we read from disk and move on. Same idea as “don’t keep googling the same question.”

2. **Location cache** — ZIP → store id basically never needs to change for that ZIP, so we save it once and reuse it.

If this ever grew into a real product with lots of servers, we’d move that “remembered search” layer to **one shared place** all boxes can read (instead of each server having its own tiny SQLite file). Same idea, bigger room. Prices don’t flip every second; being an hour behind is usually fine.

---

## What parts of this system would be cached?

Rough picture:

| What | Why cache it | How long |
|------|----------------|----------|
| ZIP → store id | It’s stable | Basically forever (overwrite if it changes) |
| Search results for `"milk"` at that store | Kroger charges calls / rate limits us | A few hours is plenty |
| Final pick for same inputs | Skip scoring entirely on repeats | Maybe 30–60 min |
| Login token for Kroger | Don’t re-auth every request | Until Kroger says it’s expired |

---

## What would be deterministic vs AI-assisted?

**Deterministic (what we ship now):**  
word overlap, brand/size/notes checks, calling Kroger, reading cache, not hammering the API. Cheap, predictable, and honestly good enough for most groceries.

**AI-assisted (only where it pays for itself):**  
weird spelling, slang, stuff like “ranch” meaning dressing vs chips, or when the score is garbage and we’re about to pick something dumb. We would **not** run AI on every line — that’s burning money for no reason.

**Cost napkin math (made-up numbers, just for intuition):**  
Say a cheap AI call is a couple tenths of a cent per item and a basket has 10 lines. If we went full-AI every time, that’s maybe a couple cents per basket. If **most** lookups hit cache or never need AI, the average cost per basket drops toward “basically nothing.” The point isn’t the exact cents — it’s **cache + rules first, AI only when we’re stuck.**

---

## How would you improve basket fill quality over time?

We’d treat it like a class project that got real users: **ship, watch what breaks, patch the obvious stuff.**

1. **Feedback** — thumbs up/down or “pick the right product” per line, saved in a simple feedback table. Otherwise we’re guessing.

2. **Hand fixes for repeat mistakes** — if “milk” at store X always maps wrong, we add a tiny override table (`what they typed → product id we want`) instead of endlessly tuning math.

3. **Synonym / slang map** — people don’t type like the catalog. Over time we’d grow a boring map (`nonfat` ≈ `fat free`, etc.) from real corrections.

4. **Retune the matcher** — our weights in `matcher.ts` aren’t sacred. With saved baskets + feedback we’d try different mixes offline and keep whatever actually wins.

5. **Nightly warm-up** — a scheduled job that pre-searches boring staples (milk, eggs, bread) before morning traffic so cache is already hot.

---

## How would this scale to 5,000 users?

At that point we stop treating this like a single-laptop app and make a few practical changes:

- **Shared database (not one local file)** — we can store basket history and caches in one hosted database so every app server sees the same data.

- **Multiple app servers** — we can run multiple copies of the API at the same time and put something in front to spread requests across them.

- **Shared cache** — we can keep one shared cache for common searches (milk, eggs, etc.) so every server benefits from cache hits.

- **Async basket filling for heavy loads** — we can return a “job id” right away and let the browser poll for results, instead of making one request wait forever.

- **Static hosting for the UI** — we can serve the HTML/CSS/JS and images from simple static hosting so the API servers focus on calls + matching.

Also, Kroger’s public API has a **daily call cap**. So we rely on caching hard, and if traffic grows beyond one credential’s daily limit, we can register a couple of apps and spread traffic across them.

---

## How would you control search / proxy / API costs?

Right now we call Kroger directly (no proxy), so the main “cost” is **API call limits** and keeping latency reasonable.

1. **Cache results** — cache common searches (milk, eggs, bread) for a while so we don’t re-hit the API for the same query over and over.

2. **Deduplicate within a basket** — if the same query appears multiple times in one list, we only search once and reuse the result.

3. **Warm the cache** — refresh the top items on a schedule so peak hours mostly hit cache instead of the API.

4. **Keep matching mostly deterministic** — use the rule-based scorer for most items. If we ever add an AI step, we only use it when the normal scorer is low-confidence.

5. **Handle rate limits cleanly** — if Kroger starts rate-limiting us or returning temporary errors, we slow down retries and prefer returning the last cached result when available.

6. **Track basic metrics** — log cache hit rate and API error rate. If a query is always a miss, we can cache it longer or warm it on purpose.

If we ever added a proxy (for a retailer without an official API), we’d treat it the same way: rate-limit it and cache aggressively to avoid paying repeatedly for the same searches.
