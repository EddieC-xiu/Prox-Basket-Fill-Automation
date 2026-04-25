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

We’re not there yet, but the story is straightforward:

- **One database file won’t cut it** — we’d move history + cache to a proper hosted database so every server sees the same data.

- **One server won’t cut it** — we’d run **multiple copies** of the app behind something that spreads traffic (think “load balancer 101”).

- **One shared cache** — so all copies benefit from the same saved Kroger searches instead of each machine forgetting everything.

- **Don’t block the browser forever** — heavy fills could become “submit job → poll until done” so a giant basket doesn’t tie up one worker for ages.

- **Don’t re-download the UI from our tiny server for every image** — static pages and images could live on cheap file hosting so our app mostly does API + logic.

Kroger’s public API has a **daily call cap** (order of tens of thousands per day per app). So we’d also **split traffic across a couple of registered apps** if we ever got huge, and we’d lean hard on cache so we don’t blow the limit in an hour.

---

## How would you control search / proxy / API costs?

We’re not using a paid proxy right now — it’s straight to Kroger — so “cost” here is mostly **API calls, rate limits, and optional AI**.

1. **Cache longer when it’s safe** — groceries don’t need sub-minute freshness for everything. Longer TTL = fewer API calls.

2. **Dedup inside one basket** — we already search `"milk"` once if it appears twice; we’d keep doing that.

3. **Pre-fetch popular stuff at night** — same as above; mornings feel faster and cheaper.

4. **AI only on the weird rows** — rules do the heavy lifting.

5. **Back off when Kroger is mad** — if we start getting rate-limit or server errors, we stop retrying like idiots and return the last good cached result when we can.

6. **Actually look at numbers** — simple logging: how often does cache hit per search term? If something is always a miss, we either cache it longer or warm it on purpose.

If we ever added a proxy (e.g. to scrape something without an API), we’d rate-limit that too and cache hard so we’re not paying per request on the same “milk” search all day.

---

**TL;DR:** cache what repeats, share state if we multiply servers, use AI sparingly, and improve from real user feedback instead of vibes.
