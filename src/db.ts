import Database, { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import type { BasketMatch } from "./types";

dotenv.config();

const DB_PATH = process.env.DB_PATH ?? "./data/baskets.db";

// Ensure the directory exists before opening the db file
const dbDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db: DatabaseType = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/** Run migrations from the SQL file */
export function runMigrations(): void {
  const migrationPath = path.resolve("migrations/001_init.sql");
  const sql = fs.readFileSync(migrationPath, "utf-8");
  db.exec(sql);
}

// ──────────────────────────────────────────────────────
// Basket persistence
// ──────────────────────────────────────────────────────

export function insertBasketRun(retailer: string, zip: string): number {
  const stmt = db.prepare(
    "INSERT INTO basket_runs (retailer, zip) VALUES (?, ?)"
  );
  return Number(stmt.run(retailer, zip).lastInsertRowid);
}

export function updateBasketRunFillRate(runId: number, fillRate: number): void {
  db.prepare("UPDATE basket_runs SET fill_rate = ? WHERE id = ?").run(
    fillRate,
    runId
  );
}

export function insertBasketRequest(
  runId: number,
  query: string,
  brand?: string,
  size?: string,
  notes?: string
): number {
  const stmt = db.prepare(
    `INSERT INTO basket_requests (basket_run_id, requested_query, brand_preference, size_preference, notes)
     VALUES (?, ?, ?, ?, ?)`
  );
  return Number(
    stmt.run(runId, query, brand ?? null, size ?? null, notes ?? null)
      .lastInsertRowid
  );
}

export function insertBasketMatch(
  requestId: number,
  match: BasketMatch
): void {
  db.prepare(
    `INSERT INTO basket_matches
       (basket_request_id, matched_product_name, product_url, image_url, price, size,
        confidence, match_notes, is_substitute, is_unmatched, cached)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    requestId,
    match.matched_product_name,
    match.product_url,
    match.image_url,
    match.price,
    match.size,
    match.match_confidence,
    match.match_notes,
    match.is_substitute ? 1 : 0,
    match.is_unmatched ? 1 : 0,
    match.cached ? 1 : 0
  );
}

// ──────────────────────────────────────────────────────
// Product cache
// ──────────────────────────────────────────────────────

const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS ?? "3600", 10);

export function getCachedProducts(
  retailer: string,
  locationId: string,
  queryKey: string
): unknown[] | null {
  const row = db
    .prepare(
      `SELECT results_json, created_at FROM product_cache
       WHERE retailer = ? AND location_id = ? AND query_key = ?`
    )
    .get(retailer, locationId, queryKey) as
    | { results_json: string; created_at: string }
    | undefined;

  if (!row) return null;

  const ageSeconds =
    (Date.now() - new Date(row.created_at).getTime()) / 1000;
  if (ageSeconds > CACHE_TTL) return null;

  return JSON.parse(row.results_json) as unknown[];
}

export function setCachedProducts(
  retailer: string,
  locationId: string,
  queryKey: string,
  results: unknown[]
): void {
  db.prepare(
    `INSERT INTO product_cache (retailer, location_id, query_key, results_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(retailer, location_id, query_key)
     DO UPDATE SET results_json = excluded.results_json, created_at = CURRENT_TIMESTAMP`
  ).run(retailer, locationId, queryKey, JSON.stringify(results));
}

export function getCachedLocation(retailer: string, zip: string): string | null {
  const row = db
    .prepare(
      "SELECT location_id FROM location_cache WHERE retailer = ? AND zip = ?"
    )
    .get(retailer, zip) as { location_id: string } | undefined;
  return row?.location_id ?? null;
}

export function setCachedLocation(
  retailer: string,
  zip: string,
  locationId: string
): void {
  db.prepare(
    `INSERT INTO location_cache (retailer, zip, location_id) VALUES (?, ?, ?)
     ON CONFLICT(retailer, zip) DO UPDATE SET location_id = excluded.location_id`
  ).run(retailer, zip, locationId);
}

// ──────────────────────────────────────────────────────
// History queries (used by the UI)
// ──────────────────────────────────────────────────────

export interface RunSummary {
  id: number;
  retailer: string;
  zip: string;
  fill_rate: number;
  created_at: string;
  item_count: number;
}

export function listRuns(limit = 20): RunSummary[] {
  return db
    .prepare(
      `SELECT r.id, r.retailer, r.zip, r.fill_rate, r.created_at,
              COUNT(bq.id) AS item_count
       FROM basket_runs r
       LEFT JOIN basket_requests bq ON bq.basket_run_id = r.id
       GROUP BY r.id
       ORDER BY r.created_at DESC
       LIMIT ?`
    )
    .all(limit) as RunSummary[];
}

export function getRunDetail(runId: number): unknown {
  const run = db
    .prepare("SELECT * FROM basket_runs WHERE id = ?")
    .get(runId);
  const items = db
    .prepare(
      `SELECT bq.*, bm.matched_product_name, bm.product_url, bm.image_url,
              bm.price, bm.size, bm.confidence, bm.match_notes,
              bm.is_substitute, bm.is_unmatched, bm.cached
       FROM basket_requests bq
       LEFT JOIN basket_matches bm ON bm.basket_request_id = bq.id
       WHERE bq.basket_run_id = ?`
    )
    .all(runId);
  return { run, items };
}

// Auto-run migrations when this module is first imported
runMigrations();

// Allow direct execution: `tsx src/db.ts` to run migrations manually
if (process.argv[1]?.endsWith("db.ts") || process.argv[1]?.endsWith("db.js")) {
  console.log("Migrations applied successfully.");
  db.close();
}
