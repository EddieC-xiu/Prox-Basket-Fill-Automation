/**
 * Matching & ranking logic
 *
 * Scoring is a weighted sum of four signals:
 *
 *  1. token_similarity (40%) – Jaccard overlap between query tokens and
 *     product-name tokens.  This is the primary relevance signal.
 *
 *  2. brand_match (25%) – exact brand preference alignment.
 *     Full credit if the product brand contains the requested brand.
 *
 *  3. size_match (20%) – compare numeric size values.
 *     Credit decays as the ratio of the two sizes diverges from 1.
 *
 *  4. notes_match (15%) – check whether qualifier keywords from the
 *     "notes" field (organic, boneless, low-fat, frozen, …) appear in
 *     the product name.
 *
 * A result with score ≥ 0.80 is classified as an exact match.
 * A result with score ∈ [0.40, 0.80) is a substitute.
 * Below 0.40 → unmatched.
 *
 * Substitution detection compares the matched product's name tokens
 * against the query tokens; if fewer than half overlap we flag it.
 */

import type {
  BasketItem,
  BasketMatch,
  ProductCandidate,
  ScoredProduct,
  ScoreBreakdown,
} from "./types";

const WEIGHT = {
  token_similarity: 0.40,
  brand_match:      0.25,
  size_match:       0.20,
  notes_match:      0.15,
} as const;

/**
 * Dynamic exact-match threshold.
 * When the user specifies preferences (brand/size/notes), those signals
 * can boost the score above 0.80.  When no preferences are given, the
 * maximum achievable score is ~0.70 (perfect token similarity + neutral
 * brand/size/notes of 0.5).  We lower the threshold accordingly.
 */
function exactThreshold(item: BasketItem): number {
  const hasPrefs =
    !!item.brand_preference || !!item.size_preference || !!item.notes;
  return hasPrefs ? 0.70 : 0.62;
}

const SUBSTITUTE_THRESHOLD = 0.38;

// ─── Tokenisation ─────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "of", "in", "for", "with", "and", "or", "to",
  "at", "is", "it", "oz", "fl", "lb", "ct", "pk",
]);

/**
 * Very lightweight stemmer: handles common English plural/gerund forms so
 * "avocados" → "avocado", "eggs" → "egg", "chips" → "chip".
 * Avoids false collapses (e.g. "grass" should NOT become "gras").
 */
function stem(word: string): string {
  if (word.length < 4) return word;
  // ies → y (e.g. berries → berry)
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  // sses → ss (e.g. grasses → grass)
  if (word.endsWith("sses")) return word.slice(0, -2);
  // ses/zes/xes/ches → se/ze/xe/che
  if (/[szxch]es$/.test(word)) return word.slice(0, -1);
  // strip trailing 's' only if stem ≥ 3 chars and doesn't end in ss
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 4) {
    return word.slice(0, -1);
  }
  return word;
}

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
      .map(stem)
  );
}

/**
 * Compound-noun penalty: if a query token (e.g. "butter") is preceded in the
 * product name by a modifying noun that changes the product category
 * (e.g. "peanut butter"), reduce the token similarity score.
 *
 * This prevents "butter" from strongly matching "Peanut Butter".
 */
const COMPOUND_DISQUALIFIERS: [string, RegExp][] = [
  // [query-term, pattern that means it's really a compound meaning something else]
  ["butter", /peanut\s+butter/i],
  ["milk", /coconut\s+milk|almond\s+milk|oat\s+milk|soy\s+milk/i],
  ["cream", /ice\s+cream|sour\s+cream|heavy\s+cream/i],
  ["chips", /chocolate\s+chip/i],
];

function compoundPenalty(query: string, productName: string): number {
  const qLower = query.toLowerCase();
  const pLower = productName.toLowerCase();
  for (const [term, pattern] of COMPOUND_DISQUALIFIERS) {
    if (qLower.includes(term) && !qLower.match(pattern) && pLower.match(pattern)) {
      return 0.5; // halve the token similarity contribution
    }
  }
  return 1.0;
}

/**
 * Blended token similarity: 50% Jaccard (precision) + 50% query recall.
 *
 * Pure Jaccard penalises long product names that contain all query tokens
 * plus extra descriptor words.  The recall component rewards products that
 * cover all query tokens, regardless of how long the product name is.
 *
 * Example: query="milk" vs "Kroger Whole Milk"
 *   jaccard = 1/3 = 0.33,  recall = 1/1 = 1.0 → blended = 0.67
 *
 * This gives much more intuitive scores while Jaccard still penalises
 * semantically unrelated products that happen to share one common token.
 */
function tokenSimilarity(query: Set<string>, product: Set<string>): number {
  if (query.size === 0 && product.size === 0) return 1;
  if (query.size === 0 || product.size === 0) return 0;

  const intersection = [...query].filter((t) => product.has(t)).length;
  const unionSize    = new Set([...query, ...product]).size;

  const jaccard = intersection / unionSize;
  const recall  = intersection / query.size; // fraction of query tokens covered

  return 0.5 * jaccard + 0.5 * recall;
}

// ─── Size parsing ─────────────────────────────────────────────────────────────

/** Extract the first numeric value from a size string, normalising units. */
function parseSize(s: string): number | null {
  const numMatch = s.match(/([\d.]+)/);
  if (!numMatch) return null;
  const n = parseFloat(numMatch[1]);

  const lower = s.toLowerCase();
  if (lower.includes("gal")) return n * 128; // → fl oz
  if (lower.includes("qt"))  return n * 32;
  if (lower.includes("pt"))  return n * 16;
  if (lower.includes("lb"))  return n * 16; // → oz
  return n; // oz, ct, etc. – treat as-is
}

function sizeSimilarity(want: string, have: string): number {
  const wantN = parseSize(want);
  const haveN = parseSize(have);
  if (wantN === null || haveN === null) return 0.5; // unknown → neutral
  const ratio = Math.min(wantN, haveN) / Math.max(wantN, haveN);
  // Reward exact match, decay toward 0 as ratio drops
  return ratio;
}

// ─── Notes keyword matching ───────────────────────────────────────────────────

const QUALIFIER_KEYWORDS = [
  "organic", "natural", "frozen", "fresh", "boneless", "skinless",
  "low-fat", "nonfat", "fat-free", "whole", "reduced", "unsalted",
  "gluten-free", "vegan", "plant-based", "cage-free", "free-range",
  "grass-fed", "no-sugar", "diet", "light",
];

function notesScore(notes: string, productName: string): number {
  const lName = productName.toLowerCase();
  const lNotes = notes.toLowerCase();

  const requested = QUALIFIER_KEYWORDS.filter((kw) => lNotes.includes(kw));
  if (requested.length === 0) {
    // No qualifiers → any product is fine; give neutral credit
    return 0.5;
  }
  const matched = requested.filter((kw) => lName.includes(kw.replace("-", " "))).length;
  return matched / requested.length;
}

// ─── Core scoring ─────────────────────────────────────────────────────────────

function scoreProduct(
  item: BasketItem,
  product: ProductCandidate
): ScoreBreakdown {
  const queryTokens   = tokenise(item.query);
  const productTokens = tokenise(product.name);
  const rawSimilarity = tokenSimilarity(queryTokens, productTokens);
  const penalty       = compoundPenalty(item.query, product.name);
  const token_similarity = rawSimilarity * penalty;

  // Brand match
  let brand_match = 0;
  if (item.brand_preference) {
    const wantedBrand = item.brand_preference.toLowerCase();
    const haveBrand   = product.brand.toLowerCase();
    if (haveBrand.includes(wantedBrand) || wantedBrand.includes(haveBrand)) {
      brand_match = 1.0;
    } else {
      brand_match = 0.0;
    }
  } else {
    brand_match = 0.5; // no preference → neutral
  }

  // Size match
  let size_match = 0.5; // default neutral
  if (item.size_preference && product.size) {
    size_match = sizeSimilarity(item.size_preference, product.size);
  } else if (item.size_preference && !product.size) {
    size_match = 0.3; // wanted a size but product has none listed
  }

  // Notes match
  let notes_match = 0.5;
  if (item.notes) {
    notes_match = notesScore(item.notes, product.name);
  }

  const total =
    token_similarity * WEIGHT.token_similarity +
    brand_match      * WEIGHT.brand_match      +
    size_match       * WEIGHT.size_match       +
    notes_match      * WEIGHT.notes_match;

  return { token_similarity, brand_match, size_match, notes_match, total };
}

// ─── Ranking & selection ──────────────────────────────────────────────────────

export function rankAndSelect(
  item: BasketItem,
  candidates: ProductCandidate[]
): ScoredProduct | null {
  if (candidates.length === 0) return null;

  const scored: ScoredProduct[] = candidates.map((p) => {
    const breakdown = scoreProduct(item, p);
    return { ...p, score: breakdown.total, score_breakdown: breakdown };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best.score >= SUBSTITUTE_THRESHOLD ? best : null;
}

// ─── Human-readable match notes ───────────────────────────────────────────────

function buildMatchNotes(
  item: BasketItem,
  product: ScoredProduct,
  isSubstitute: boolean
): string {
  const parts: string[] = [];
  const bd = product.score_breakdown;

  if (isSubstitute) {
    parts.push("substitute");
  }
  if (bd.brand_match === 1.0 && item.brand_preference) {
    parts.push(`brand matched "${item.brand_preference}"`);
  } else if (bd.brand_match === 0.0 && item.brand_preference) {
    parts.push(`brand "${item.brand_preference}" not available, used "${product.brand}"`);
  }
  if (item.size_preference && product.size) {
    if (bd.size_match >= 0.95) {
      parts.push("exact size match");
    } else if (bd.size_match >= 0.5) {
      parts.push(`closest available size is ${product.size}`);
    } else {
      parts.push(`size mismatch – wanted ${item.size_preference}, found ${product.size}`);
    }
  }
  if (item.notes && bd.notes_match < 0.5) {
    parts.push(`note "${item.notes}" partially matched`);
  } else if (item.notes && bd.notes_match >= 0.8) {
    parts.push(`note "${item.notes}" matched`);
  }
  if (parts.length === 0) {
    parts.push("best token match");
  }
  return parts.join("; ");
}

// ─── Public: build a BasketMatch ─────────────────────────────────────────────

export function buildMatch(
  item: BasketItem,
  candidates: ProductCandidate[],
  retailer: string,
  cached: boolean
): BasketMatch {
  const best = rankAndSelect(item, candidates);

  if (!best) {
    return {
      requested_query:  item.query,
      brand_preference: item.brand_preference ?? null,
      size_preference:  item.size_preference  ?? null,
      notes:            item.notes            ?? null,
      matched_product_name: null,
      retailer,
      price:            null,
      size:             null,
      product_url:      null,
      image_url:        null,
      match_confidence: 0,
      match_notes:      "no matching product found",
      is_substitute:    false,
      is_unmatched:     true,
      cached,
    };
  }

  const isExact      = best.score >= exactThreshold(item);
  const isSubstitute = !isExact;

  return {
    requested_query:      item.query,
    brand_preference:     item.brand_preference ?? null,
    size_preference:      item.size_preference  ?? null,
    notes:                item.notes            ?? null,
    matched_product_name: best.name,
    retailer,
    price:                best.price,
    size:                 best.size,
    product_url:          best.product_url,
    image_url:            best.image_url,
    match_confidence:     Math.round(best.score * 100) / 100,
    match_notes:          buildMatchNotes(item, best, isSubstitute),
    is_substitute:        isSubstitute,
    is_unmatched:         false,
    cached,
  };
}
