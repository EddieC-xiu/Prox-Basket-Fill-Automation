/**
 * Basket orchestrator
 *
 * Coordinates:
 *  1. Location resolution (ZIP → store ID, cached in SQLite)
 *  2. Deduplicated, concurrent product searches (respecting rate limits)
 *  3. Ranking & match selection for each item
 *  4. Persistence of the run to SQLite
 *
 * Concurrency is capped at 3 simultaneous API calls to avoid throttling.
 * Items with identical normalised queries share one search result.
 */

import { createLimiter } from "./concurrency";
import dotenv from "dotenv";
import {
  insertBasketRun,
  insertBasketRequest,
  insertBasketMatch,
  updateBasketRunFillRate,
  getCachedProducts,
} from "./db";
import { buildMatch } from "./matcher";
import type {
  BasketInput,
  BasketMatch,
  BasketResult,
  RetailerAdapter,
} from "./types";
import { KrogerAdapter } from "./retailers/kroger";

dotenv.config();

const CONCURRENCY = 3;

function normaliseQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ");
}

function getAdapter(): RetailerAdapter {
  const id = process.env.KROGER_CLIENT_ID;
  const secret = process.env.KROGER_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "KROGER_CLIENT_ID and KROGER_CLIENT_SECRET are required. Copy .env.example to .env and add your keys from https://developer.kroger.com"
    );
  }
  return new KrogerAdapter(id, secret);
}

export async function fillBasket(input: BasketInput): Promise<BasketResult> {
  const adapter = getAdapter();
  const limit = createLimiter(CONCURRENCY);

  // ── 1. Resolve store location ──────────────────────────────────────────────
  const location = await adapter.resolveLocation(input.zip);
  const { locationId } = location;

  // ── 2. Deduplicate queries ─────────────────────────────────────────────────
  // Multiple items may share the same normalised query (e.g. "milk" × 2).
  // We only issue one search per unique key.
  const uniqueQueries = [
    ...new Set(input.items.map((i) => normaliseQuery(i.query))),
  ];

  // ── 3. Concurrent searches ─────────────────────────────────────────────────
  const searchResults = new Map<string, Awaited<ReturnType<typeof adapter.searchProducts>>>();

  await Promise.all(
    uniqueQueries.map((qKey) =>
      limit(async () => {
        const results = await adapter.searchProducts(qKey, locationId);
        searchResults.set(qKey, results);
      })
    )
  );

  // ── 4. Match each item ─────────────────────────────────────────────────────
  const runId = insertBasketRun(input.retailer, input.zip);
  const matches: BasketMatch[] = [];

  for (const item of input.items) {
    const qKey = normaliseQuery(item.query);
    const wasCached =
      getCachedProducts(adapter.name, locationId, qKey) !== null;
    const candidates = searchResults.get(qKey) ?? [];
    const match = buildMatch(item, candidates, input.retailer, wasCached);
    matches.push(match);

    const requestId = insertBasketRequest(
      runId,
      item.query,
      item.brand_preference,
      item.size_preference,
      item.notes
    );
    insertBasketMatch(requestId, match);
  }

  // ── 5. Compute fill rate ───────────────────────────────────────────────────
  const filled = matches.filter((m) => !m.is_unmatched).length;
  const fillRate = filled / matches.length;
  updateBasketRunFillRate(runId, fillRate);

  return {
    run_id:      runId,
    retailer:    input.retailer,
    zip:         input.zip,
    store_name:  location.store_name,
    store_city:  location.store_city,
    store_state: location.store_state,
    created_at:  new Date().toISOString(),
    fill_rate:   fillRate,
    items:       matches,
  };
}
