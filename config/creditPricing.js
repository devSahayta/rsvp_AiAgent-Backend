// config/creditPricing.js
//
// Single source of truth for the credit system's pricing constants and cost
// math. Per the spec: markup and the credit unit live in EXACTLY ONE place —
// here — so they can be tuned without touching any calling code.

// ── Tunable constants ───────────────────────────────────────────────────────

export const MARKUP = 3.0; // charge 3x true cost — per lead's spec
export const TEST_MARKUP = MARKUP * 0.5; // 1.5x — test agents billed at 50% of production, per lead
export const CREDIT_VALUE_USD = 0.001; // 1 credit = $0.001 (one-tenth of a cent)

// TODO (Section 8, item 4): confirm with finance — pinned or live rate
export const USD_INR_RATE = 88;

// TODO (Section 8, item 1): confirm real effective rate from ElevenLabs invoice.
// Only used as a LAST-RESORT fallback — normally we use metadata.cost_fiat
// directly from ElevenLabs, which already includes their own LLM cost.
export const ELEVENLABS_RATE_PER_MIN_FALLBACK = 0.08;

// TODO (Section 8, item 3): confirm real per-destination rate from Vobiz console.
export const VOBIZ_RATE_PER_MIN_INR = 0.6;

// Google Cloud Vision — TEXT_DETECTION / DOCUMENT_TEXT_DETECTION.
// $1.50 per 1,000 images/pages after the first 1,000 free/month (per feature).
// We deliberately ignore the free tier in cost math (same philosophy as
// Claude prompt caching — treat any real discount as bonus margin, not
// baseline), so this number stays predictable regardless of monthly usage.
export const OCR_COST_PER_IMAGE_USD = 0.0015;

// Minimum credits required before starting a NEW chat turn / voice call.
// Conservative placeholders until real production averages exist (Section 8, item 5).
export const MIN_CHAT_CREDIT_HOLD = 50;
export const MIN_VOICE_CREDIT_HOLD_PER_CALL = 300;

// Test-mode holds — half of production, matching TEST_MARKUP.
export const TEST_MIN_CHAT_CREDIT_HOLD = MIN_CHAT_CREDIT_HOLD * 0.5;
export const TEST_MIN_VOICE_CREDIT_HOLD_PER_CALL =
  MIN_VOICE_CREDIT_HOLD_PER_CALL * 0.5;

// Claude per-million-token rates (standard pricing). Keyed by exact model
// string so a call logs its own model and looks up its own rate — a
// conversation can mix Haiku and Sonnet calls.
export const CLAUDE_RATES = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 }, // exact string used by agentChatEngine.js / generalChatEngine.js
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 5, output: 25 },
  // Sonnet 5 — intro pricing through Aug 31, 2026; becomes $3/$15 after.
  // TODO: update to { input: 3, output: 15 } on/after Sept 1, 2026.
  "claude-sonnet-5": { input: 2, output: 10 },
};

// ── Helpers ──────────────────────────────────────────────────────────────

export const formatCredits = (value) =>
  Number(parseFloat(value || 0).toFixed(2));

/**
 * Cost in USD for a single Claude call, given its model + token usage.
 * Falls back to Sonnet's rate if the model string isn't in the table yet,
 * so an unrecognized model never silently costs $0.
 */
export function computeClaudeCallCost(
  model,
  inputTokens = 0,
  outputTokens = 0,
) {
  const rate = CLAUDE_RATES[model] || CLAUDE_RATES["claude-sonnet-4-6"];
  return (
    (inputTokens / 1_000_000) * rate.input +
    (outputTokens / 1_000_000) * rate.output
  );
}

/** USD -> credits, always rounded UP. Never round in the customer's favor. */
export function usdToCredits(usd) {
  return Math.ceil(usd / CREDIT_VALUE_USD);
}

/**
 * The core pricing step: true cost -> billed cost -> credits.
 * Returns all three so callers can store true_cost_usd and billed_cost_usd
 * separately (never overwrite one with the other — see spec Section 1).
 * Pass isTest=true for test-agent calls — bills at TEST_MARKUP (50% of
 * production), per lead's instruction.
 */
export function billedCreditsFromTrueCost(trueCostUsd, isTest = false) {
  const markup = isTest ? TEST_MARKUP : MARKUP;
  const billedUsd = trueCostUsd * markup;
  return {
    trueCostUsd, // full precision — do not round here, only round the final credits
    billedUsd,
    markup,
    credits: usdToCredits(billedUsd),
  };
}

/** INR -> USD, for Vobiz telephony cost. */
export function inrToUsd(inr) {
  return inr / USD_INR_RATE;
}

/** Cost in USD for N billable Google Vision API calls (1 unit = 1 image/page). */
export function computeOcrCost(visionUnits = 0) {
  return visionUnits * OCR_COST_PER_IMAGE_USD;
}

// ── Legacy compatibility (DO NOT use in new code) ───────────────────────────
//
// Older files (whatsappController.js, agentTestController.js) still import
// CREDIT_PRICING, calculateChatCredits, and calculateVoiceCredits from before
// the markup-based rewrite. Keeping these here unblocks the app immediately.
//
// ⚠️ VALUES BELOW ARE PLACEHOLDERS except BATCH_CALL_PER_MINUTE-derived ones.
// Check git history on the old config/creditPricing.js (e.g.
// `git show <commit-before-rewrite>:config/creditPricing.js`) to confirm the
// REAL original numbers for PRODUCTION_CHAT_PER_MESSAGE, TEST_VOICE_PER_MINUTE,
// and TEST_CHAT_PER_MESSAGE — until then, these are guesses and may charge
// differently than your old system did.
//
// TODO: migrate every remaining caller to computeClaudeCallCost /
// billedCreditsFromTrueCost / settleConversationCost, then delete this block.

export const CREDIT_PRICING = {
  BATCH_CALL_PER_MINUTE: MIN_VOICE_CREDIT_HOLD_PER_CALL / 3, // old flat per-minute equivalent (assumed ~3 min/call)
  PRODUCTION_CHAT_PER_MESSAGE: 2, // ⚠️ placeholder — matches inline comment in whatsappController.js, confirm with git history
  TEST_VOICE_PER_MINUTE: 10, // ⚠️ placeholder — confirm with git history
  TEST_CHAT_PER_MESSAGE: 1, // ⚠️ placeholder — confirm with git history
};

export function calculateVoiceCredits(durationSecsOrValue, isTest = false) {
  const minutes = durationSecsOrValue / 60;
  const rate = isTest
    ? CREDIT_PRICING.TEST_VOICE_PER_MINUTE
    : CREDIT_PRICING.BATCH_CALL_PER_MINUTE;
  return Math.ceil(minutes * rate);
}

export function calculateChatCredits(count = 1, isTest = false) {
  const rate = isTest
    ? CREDIT_PRICING.TEST_CHAT_PER_MESSAGE
    : CREDIT_PRICING.PRODUCTION_CHAT_PER_MESSAGE;
  return Math.ceil(count * rate);
}
