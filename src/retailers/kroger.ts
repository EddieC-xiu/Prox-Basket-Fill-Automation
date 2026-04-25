/**
 * Kroger API adapter
 *
 * Uses the official Kroger Developer API (https://developer.kroger.com).
 * Endpoints used:
 *   POST /connect/oauth2/token  – client_credentials grant
 *   GET  /v1/locations          – resolve ZIP → nearest store locationId
 *   GET  /v1/products           – search products at that location
 *
 * All calls are retried up to 3 times with exponential back-off.
 * Auth tokens are cached in-memory for their TTL duration.
 */

import axios, { AxiosInstance } from "axios";
import type { ProductCandidate, RetailerAdapter, ResolvedLocation } from "../types";
import { withRetry } from "../concurrency";
import {
  getCachedLocation,
  setCachedLocation,
  getCachedProducts,
  setCachedProducts,
} from "../db";

const BASE_URL = "https://api.kroger.com/v1";
const AUTH_URL = "https://api.kroger.com/v1/connect/oauth2/token";
const SEARCH_LIMIT = 10; // products per query

interface TokenCache {
  token: string;
  expiresAt: number;
}

interface KrogerProduct {
  productId: string;
  productPageURI?: string;
  brand?: string;
  description: string;
  categories?: string[];
  images?: Array<{
    perspective: string;
    featured?: boolean;
    sizes?: Array<{ id: string; url: string }>;
  }>;
  items?: Array<{
    price?: { regular?: number; promo?: number };
    size?: string;
    soldBy?: string;
  }>;
}

interface KrogerLocation {
  locationId: string;
  name: string;
  address?: { addressLine1?: string; city?: string; state?: string };
}

export class KrogerAdapter implements RetailerAdapter {
  readonly name = "kroger";
  private http: AxiosInstance;
  private tokenCache: TokenCache | null = null;

  constructor(
    private clientId: string,
    private clientSecret: string
  ) {
    this.http = axios.create({ baseURL: BASE_URL, timeout: 15_000 });
  }

  // ── Auth ──────────────────────────────────────────────

  private async getToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "product.compact",
    });
    const { data } = await withRetry(
      () =>
        axios.post(AUTH_URL, params.toString(), {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization:
              "Basic " +
              Buffer.from(`${this.clientId}:${this.clientSecret}`).toString(
                "base64"
              ),
          },
        }),
      { retries: 3, minTimeout: 500 }
    );
    this.tokenCache = {
      token: data.access_token as string,
      // Buffer 60 s before actual expiry to avoid edge cases
      expiresAt: Date.now() + (data.expires_in as number) * 1000 - 60_000,
    };
    return this.tokenCache.token;
  }

  private async authHeaders() {
    return { Authorization: `Bearer ${await this.getToken()}` };
  }

  // ── Location resolution ────────────────────────────────

  async resolveLocation(zip: string): Promise<ResolvedLocation> {
    const cachedId = getCachedLocation(this.name, zip);
    if (cachedId) {
      // Location was cached — store name not persisted, return ID only
      return { locationId: cachedId, store_name: null, store_city: null, store_state: null };
    }

    const resolved = await withRetry(
      async () => {
        const headers = await this.authHeaders();
        const { data } = await this.http.get<{ data: KrogerLocation[] }>(
          "/locations",
          {
            headers,
            params: {
              "filter.zipCode.near": zip,
              "filter.radiusInMiles": 25,
              "filter.limit": 1,
              // No chain filter — Kroger operates as Ralphs in CA, King Soopers
              // in CO, Fred Meyer in the NW, etc.
            },
          }
        );
        const first = data.data?.[0];
        if (!first) throw new Error(`No Kroger-family store found near ZIP ${zip}`);
        console.log(
          `[kroger] resolved ZIP ${zip} → store "${first.name}" ` +
          `(${first.address?.city ?? ""}, ${first.address?.state ?? ""}) ` +
          `locationId=${first.locationId}`
        );
        return {
          locationId: first.locationId,
          store_name:  first.name ?? null,
          store_city:  first.address?.city  ?? null,
          store_state: first.address?.state ?? null,
        } satisfies ResolvedLocation;
      },
      { retries: 3, minTimeout: 500 }
    );

    setCachedLocation(this.name, zip, resolved.locationId);
    return resolved;
  }

  // ── Product search ────────────────────────────────────

  async searchProducts(
    query: string,
    locationId: string
  ): Promise<ProductCandidate[]> {
    // Normalise query for cache key: lowercase, collapse whitespace
    const queryKey = query.toLowerCase().trim().replace(/\s+/g, " ");

    const cached = getCachedProducts(this.name, locationId, queryKey);
    if (cached) {
      return cached as ProductCandidate[];
    }

    const results = await withRetry(
      async () => {
        const headers = await this.authHeaders();
        try {
          const { data } = await this.http.get<{ data: KrogerProduct[] }>(
            "/products",
            {
              headers,
              params: {
                "filter.term": queryKey,
                "filter.locationId": locationId,
                "filter.limit": SEARCH_LIMIT,
              },
            }
          );
          return (data.data ?? []).map((p) => this.normalise(p));
        } catch (err: unknown) {
          // Log the full Kroger error body to help diagnose 400s
          if (axios.isAxiosError(err) && err.response) {
            console.error(
              `[kroger] ${err.response.status} on "${query}" locationId="${locationId}":`,
              JSON.stringify(err.response.data)
            );
          }
          throw err;
        }
      },
      {
        retries: 2,
        minTimeout: 600,
        onFailedAttempt: (err) =>
          console.warn(
            `[kroger] retry ${err.attemptNumber} for "${query}": ${err.message}`
          ),
      }
    );

    setCachedProducts(this.name, locationId, queryKey, results);
    return results;
  }

  // ── Normalisation ─────────────────────────────────────

  private normalise(p: KrogerProduct): ProductCandidate {
    const item = p.items?.[0];
    // Prefer promo price when available, fall back to regular
    const price = item?.price?.promo || item?.price?.regular || null;

    // Pick the largest available front image
    const imageObj = p.images?.find((i) => i.perspective === "front") ?? p.images?.[0];
    const image_url =
      imageObj?.sizes?.find((s) => s.id === "xlarge")?.url ??
      imageObj?.sizes?.find((s) => s.id === "large")?.url ??
      imageObj?.sizes?.[0]?.url ??
      null;

    // Use the productPageURI returned by the API — this is the canonical URL
    // Kroger provides and is guaranteed to be correct.
    // Fall back to a search URL if the field is absent (older API responses).
    const product_url = p.productPageURI
      ? `https://www.kroger.com${p.productPageURI}`
      : `https://www.kroger.com/search?query=${encodeURIComponent(p.description)}&searchType=default_search`;

    return {
      product_id: p.productId,
      name: p.description,
      brand: p.brand ?? "",
      price: price ?? null,
      size: item?.size ?? null,
      product_url,
      image_url,
      category: p.categories?.[0] ?? null,
    };
  }
}
