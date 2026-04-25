export interface BasketItem {
  query: string;
  brand_preference?: string;
  size_preference?: string;
  notes?: string;
}

export interface BasketInput {
  retailer: string;
  zip: string;
  items: BasketItem[];
}

/** Raw product data returned by a retailer adapter */
export interface ProductCandidate {
  product_id: string;
  name: string;
  brand: string;
  price: number | null;
  size: string | null;
  product_url: string;
  image_url: string | null;
  category: string | null;
}

/** Scored product ready for selection */
export interface ScoredProduct extends ProductCandidate {
  score: number;
  score_breakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  token_similarity: number;
  brand_match: number;
  size_match: number;
  notes_match: number;
  total: number;
}

/** Final result for a single basket item */
export interface BasketMatch {
  requested_query: string;
  brand_preference: string | null;
  size_preference: string | null;
  notes: string | null;
  matched_product_name: string | null;
  retailer: string;
  price: number | null;
  size: string | null;
  product_url: string | null;
  image_url: string | null;
  match_confidence: number;
  match_notes: string;
  is_substitute: boolean;
  is_unmatched: boolean;
  cached: boolean;
}

/** Complete result for a basket run */
export interface BasketResult {
  run_id: number;
  retailer: string;
  zip: string;
  store_name: string | null;
  store_city: string | null;
  store_state: string | null;
  created_at: string;
  fill_rate: number;
  items: BasketMatch[];
}

export interface ResolvedLocation {
  locationId: string;
  store_name: string | null;
  store_city: string | null;
  store_state: string | null;
}

/** Retailer adapter interface */
export interface RetailerAdapter {
  name: string;
  searchProducts(query: string, locationId: string): Promise<ProductCandidate[]>;
  resolveLocation(zip: string): Promise<ResolvedLocation>;
}
