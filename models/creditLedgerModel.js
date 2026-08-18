// models/creditLedgerModel.js
//
// Shared functions for checking balance, deducting credits, and writing the
// audit-trail logs (claude_usage_log, voice_usage_log, conversation_cost,
// credit_ledger). Both the chatbot flow and the voice-call settle flow call
// into these — this file is the ONE place credits actually move.

import { supabase } from "../config/supabase.js";
import { getUserById, updateUserCredits } from "./userModel.js";
import {
  computeClaudeCallCost,
  billedCreditsFromTrueCost,
  formatCredits,
  computeOcrCost,
} from "../config/creditPricing.js";

// ── Balance check (pre-check, before any cost is incurred) ─────────────────

export async function hasSufficientCredits(userId, minRequired) {
  const user = await getUserById(userId);
  if (!user) throw new Error("User not found");
  return {
    sufficient: user.credits >= minRequired,
    balance: formatCredits(user.credits),
  };
}

// ── Raw logging (per-call, happens as usage occurs) ────────────────────────

export async function logClaudeUsage({
  userId,
  conversationId = null,
  model,
  feature,
  inputTokens,
  outputTokens,
}) {
  const costUsd = computeClaudeCallCost(model, inputTokens, outputTokens);

  console.log(
    `[claude-usage] user=${userId} conv=${conversationId} model=${model} ` +
      `feature=${feature} in=${inputTokens} out=${outputTokens} cost=$${costUsd.toFixed(6)}`,
  );

  const { error } = await supabase.from("claude_usage_log").insert({
    user_id: userId,
    conversation_id: conversationId,
    model,
    feature,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
  });
  if (error) console.error("[claude-usage] log write failed:", error.message);

  return costUsd;
}

export async function logVoiceUsage({
  userId,
  eventId,
  conversationId,
  metadata, // the full ElevenLabs metadata object
}) {
  const durationSecs = metadata?.call_duration_secs || 0;
  const costFiat = metadata?.cost_fiat || 0; // already includes ElevenLabs' own LLM cost

  console.log(
    `[voice-usage] user=${userId} event=${eventId} conv=${conversationId} ` +
      `duration=${durationSecs}s cost_fiat=$${costFiat} credits=${metadata?.cost} ` +
      `llm_charge=${metadata?.charging?.llm_charge}`,
  );

  const { error } = await supabase.from("voice_usage_log").insert({
    user_id: userId,
    event_id: eventId,
    conversation_id: conversationId,
    call_duration_secs: durationSecs,
    elevenlabs_cost_usd: costFiat,
    elevenlabs_cost_credits: metadata?.cost || 0,
    llm_charge_credits: metadata?.charging?.llm_charge || 0,
    raw_metadata: metadata,
  });
  if (error) console.error("[voice-usage] log write failed:", error.message);

  return costFiat;
}

export async function logTelephonyUsage({
  userId,
  eventId,
  conversationId,
  durationSecs,
  costInr,
  costUsd,
}) {
  console.log(
    `[telephony-usage] user=${userId} event=${eventId} conv=${conversationId} ` +
      `duration=${durationSecs}s cost_inr=₹${costInr} cost_usd=$${costUsd.toFixed(6)}`,
  );

  const { error } = await supabase.from("telephony_usage_log").insert({
    user_id: userId,
    event_id: eventId,
    conversation_id: conversationId,
    call_duration_secs: durationSecs,
    vobiz_cost_inr: costInr,
    vobiz_cost_usd: costUsd,
  });
  if (error)
    console.error("[telephony-usage] log write failed:", error.message);
}

export async function logOcrUsage({
  userId,
  conversationId = null,
  participantId = null,
  eventId = null,
  visionUnits = 0,
  claudeInputTokens = 0,
  claudeOutputTokens = 0,
  claudeModel = "claude-haiku-4-5-20251001",
  documentType = null,
}) {
  const visionCostUsd = computeOcrCost(visionUnits);
  const claudeCostUsd = computeClaudeCallCost(
    claudeModel,
    claudeInputTokens,
    claudeOutputTokens,
  );
  const totalCostUsd = visionCostUsd + claudeCostUsd;

  console.log(
    `[ocr-usage] user=${userId} conv=${conversationId} doc=${documentType} ` +
      `vision_units=${visionUnits} vision_cost=$${visionCostUsd.toFixed(6)} ` +
      `claude_in=${claudeInputTokens} claude_out=${claudeOutputTokens} claude_cost=$${claudeCostUsd.toFixed(6)} ` +
      `total=$${totalCostUsd.toFixed(6)}`,
  );

  const { error } = await supabase.from("ocr_usage_log").insert({
    user_id: userId,
    conversation_id: conversationId,
    participant_id: participantId,
    event_id: eventId,
    vision_units: visionUnits,
    vision_cost_usd: visionCostUsd,
    claude_input_tokens: claudeInputTokens,
    claude_output_tokens: claudeOutputTokens,
    claude_cost_usd: claudeCostUsd,
    document_type: documentType,
  });
  if (error) console.error("[ocr-usage] log write failed:", error.message);

  return totalCostUsd; // combined — caller adds this into ocrCostUsd for settlement
}

// ── Adding credits (purchases) ──────────────────────────────────────────────

/**
 * Adds `credits` to userId's balance, writes one credit_ledger row.
 * Mirrors deductCredits exactly, just the opposite direction. Must be
 * called from an idempotent caller (see razorpayService.js's
 * markPurchasePaidAndCredit) — this function itself does not check for
 * duplicate calls.
 */
export async function addCreditsToBalance({
  userId,
  credits,
  type = "purchase",
  note,
}) {
  const user = await getUserById(userId);
  if (!user) throw new Error("User not found");

  const newBalance = formatCredits(user.credits + credits);
  await updateUserCredits(userId, newBalance);

  console.log(
    `[credit-ledger] user=${userId} added=${credits} ` +
      `${formatCredits(user.credits)} -> ${newBalance}`,
  );

  const { error } = await supabase.from("credit_ledger").insert({
    user_id: userId,
    conversation_id: null,
    type,
    credits, // positive, unlike deductCredits' negative
    balance_after: newBalance,
    note,
  });
  if (error) console.error("[credit-ledger] write failed:", error.message);

  return { previousBalance: formatCredits(user.credits), newBalance };
}

// ── Deduction (the only place that actually moves the balance) ─────────────

/**
 * Deducts `credits` from userId's balance, writes one credit_ledger row.
 * NOTE: this is a read-then-write, not a DB transaction — fine for MVP at
 * current volume, but if you see concurrent-call race conditions later,
 * move this into a Postgres function (FOR UPDATE / atomic increment) instead.
 */
export async function deductCredits({
  userId,
  conversationId = null,
  credits,
  note,
}) {
  const user = await getUserById(userId);
  if (!user) throw new Error("User not found");

  const newBalance = formatCredits(user.credits - credits);
  await updateUserCredits(userId, newBalance);

  console.log(
    `[credit-ledger] user=${userId} conv=${conversationId} deducted=${credits} ` +
      `${formatCredits(user.credits)} -> ${newBalance}`,
  );

  const { error } = await supabase.from("credit_ledger").insert({
    user_id: userId,
    conversation_id: conversationId,
    type: "deduction",
    credits: -credits,
    balance_after: newBalance,
    note,
  });
  if (error) console.error("[credit-ledger] write failed:", error.message);

  return { previousBalance: formatCredits(user.credits), newBalance };
}

// ── Settlement (true cost -> markup -> deduct -> conversation_cost row) ────

/**
 * Called once per conversation, at the end, with whichever cost components
 * apply. Pass 0 for any component that doesn't apply to this conversation
 * type (e.g. telephonyCostUsd = 0 for a text-only chat).
 */
// ── Chat settlement from a usage array (WhatsApp / decideNextStep flows) ───

/**
 * For engines that make 1+ Claude calls per turn and return a usage array
 * (e.g. decideNextStep's { usage: [{model, input_tokens, output_tokens}, ...] }).
 * Logs each call, sums true cost, settles via settleConversationCost.
 * Returns null if usageArray is empty (nothing to settle — caller should
 * fall back to whatever legacy deduction still applies for that engine).
 */
export async function settleChatFromUsage({
  userId,
  conversationId = null,
  eventId = null,
  usageArray,
  feature,
  isTest = false,
  ocrCostUsd = 0,
}) {
  const hasClaudeUsage = usageArray && usageArray.length > 0;
  if (!hasClaudeUsage && ocrCostUsd === 0) return null;

  let chatbotCostUsd = 0;
  for (const call of usageArray || []) {
    const cost = await logClaudeUsage({
      userId,
      conversationId,
      model: call.model,
      feature,
      inputTokens: call.input_tokens,
      outputTokens: call.output_tokens,
    });
    chatbotCostUsd += cost;
  }

  return settleConversationCost({
    userId,
    conversationId,
    eventId,
    conversationType: "chatbot",
    feature,
    isTest,
    chatbotCostUsd,
    voiceCostUsd: 0,
    telephonyCostUsd: 0,
    ocrCostUsd,
  });
}
export async function settleConversationCost({
  userId,
  conversationId,
  eventId = null,
  conversationType, // 'chatbot' | 'voice'
  feature = null,
  isTest = false, // true -> bills at TEST_MARKUP (50% of production), per lead
  chatbotCostUsd = 0,
  voiceCostUsd = 0,
  telephonyCostUsd = 0,
  ocrCostUsd = 0,
}) {
  // ✅ Idempotency guard — a conversation should only be settled ONCE.
  // Without this, a voice call gets re-charged on every cron cycle it's
  // still visible in (in_progress/pending), not just when it completes.
  if (conversationId) {
    const { data: existing } = await supabase
      .from("conversation_cost")
      .select("id")
      .eq("conversation_id", conversationId)
      .maybeSingle();

    if (existing) {
      console.log(
        `[settle] SKIPPED — conv=${conversationId} already settled (idempotent)`,
      );
      return { alreadySettled: true };
    }
  }

  const trueCostUsd =
    chatbotCostUsd + voiceCostUsd + telephonyCostUsd + ocrCostUsd;
  const { billedUsd, credits, markup } = billedCreditsFromTrueCost(
    trueCostUsd,
    isTest,
  );

  const { error: costRowError } = await supabase
    .from("conversation_cost")
    .insert({
      user_id: userId,
      conversation_id: conversationId,
      event_id: eventId,
      conversation_type: conversationType,
      feature,
      is_test: isTest,
      chatbot_cost_usd: chatbotCostUsd,
      voice_cost_usd: voiceCostUsd,
      telephony_cost_usd: telephonyCostUsd,
      ocr_cost_usd: ocrCostUsd,
      true_cost_usd: trueCostUsd,
      markup,
      billed_cost_usd: billedUsd,
      credits_charged: credits,
    });
  if (costRowError) {
    console.error("[conversation-cost] write failed:", costRowError.message);
  }

  const { newBalance } = await deductCredits({
    userId,
    conversationId,
    credits,
    note: `${conversationType}${isTest ? " (test)" : ""} settle — true=$${trueCostUsd.toFixed(6)} billed=$${billedUsd.toFixed(6)} markup=${markup}x`,
  });

  console.log(
    `[settle] user=${userId} conv=${conversationId} type=${conversationType} ` +
      `${isTest ? "TEST " : ""}true=$${trueCostUsd.toFixed(6)} billed=$${billedUsd.toFixed(6)} markup=${markup}x credits=${credits} newBalance=${newBalance}`,
  );

  return { trueCostUsd, billedUsd, credits, markup, newBalance };
}
