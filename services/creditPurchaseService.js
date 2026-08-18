// services/creditPurchaseService.js
import { supabase } from "../config/supabase.js";
import { razorpay, RAZORPAY_PUBLIC_KEY_ID } from "../utils/razorpayClient.js";
import { addCreditsToBalance } from "../models/creditLedgerModel.js";
import { CREDIT_VALUE_USD, USD_INR_RATE } from "../config/creditPricing.js";

// Same peg used everywhere else (Logs page display, cost math): 1 credit
// = CREDIT_VALUE_USD * USD_INR_RATE = ₹0.088 today. Importing the two
// upstream constants instead of hardcoding 0.088 here means if finance
// ever repegs USD_INR_RATE, this stays correct automatically.
const INR_PER_CREDIT = CREDIT_VALUE_USD * USD_INR_RATE;

// Floor for the custom top-up path — mirrors Claude's $5 minimum, just in
// rupees. Below this, Razorpay's per-transaction fee eats a
// disproportionate share of the payment.
export const MIN_CUSTOM_TOPUP_INR = 200;

/**
 * INR -> credits for a custom top-up. Always rounds DOWN — unlike
 * usdToCredits() in creditPricing.js (which rounds UP because that's a
 * *cost*, and you never round a cost in the customer's favor), this is a
 * *grant*, so the direction that protects the business is the opposite:
 * never hand out a fraction of a credit more than what was actually paid for.
 */
export function inrToCredits(amountInr) {
  return Math.floor(Number(amountInr) / INR_PER_CREDIT);
}

/**
 * Step 1: user clicks "Buy" -> creates a pending order in our DB, then a
 * matching order with Razorpay. Returns everything the frontend needs to
 * open the Checkout modal.
 *
 * Accepts EITHER a fixed packageId OR a customAmountInr — never both.
 * Exactly one must be provided; the controller validates this before
 * calling in, but this function re-validates too since it's the one place
 * money actually gets tied to a credits amount.
 */
export async function initiatePurchase({ userId, packageId, customAmountInr }) {
  if (packageId && customAmountInr) {
    throw new Error("Provide either packageId or customAmountInr, not both");
  }
  if (!packageId && !customAmountInr) {
    throw new Error("Either packageId or customAmountInr is required");
  }

  let credits;
  let amountInr;
  let packageName;
  let pkgId = null;

  if (packageId) {
    const { data: pkg, error: pkgError } = await supabase
      .from("credit_packages")
      .select("*")
      .eq("id", packageId)
      .eq("is_active", true)
      .maybeSingle();

    if (pkgError || !pkg) throw new Error("Invalid or inactive package");

    credits = pkg.credits;
    amountInr = pkg.price_inr;
    packageName = pkg.name;
    pkgId = pkg.id;
  } else {
    const amount = Number(customAmountInr);
    if (!Number.isFinite(amount) || amount < MIN_CUSTOM_TOPUP_INR) {
      throw new Error(`Minimum custom top-up is ₹${MIN_CUSTOM_TOPUP_INR}`);
    }
    credits = inrToCredits(amount);
    amountInr = amount;
    packageName = `Custom top-up — ₹${amount}`;
  }

  const { data: purchase, error: purchaseError } = await supabase
    .from("credit_purchases")
    .insert({
      user_id: userId,
      package_id: pkgId, // null for custom top-ups
      credits,
      amount_inr: amountInr,
      status: "pending",
      gateway: "razorpay",
    })
    .select()
    .single();

  if (purchaseError) throw purchaseError;

  // Razorpay wants the amount in paise (smallest currency unit) — the
  // single most common integration bug is forgetting this ×100.
  const amountPaise = Math.round(Number(amountInr) * 100);

  const razorpayOrder = await razorpay.orders.create({
    amount: amountPaise,
    currency: "INR",
    receipt: purchase.id, // ties Razorpay's order back to our row
    notes: {
      user_id: userId,
      package_id: pkgId || "custom",
      purchase_id: purchase.id,
      credits,
    },
  });

  await supabase
    .from("credit_purchases")
    .update({ razorpay_order_id: razorpayOrder.id })
    .eq("id", purchase.id);

  return {
    purchaseId: purchase.id,
    razorpayOrderId: razorpayOrder.id,
    amountPaise,
    currency: "INR",
    keyId: RAZORPAY_PUBLIC_KEY_ID, // public — safe to send to the browser
    packageName,
    credits,
  };
}

/**
 * The ONE place credits actually get granted from a purchase. Called from
 * BOTH the frontend-verify endpoint (fast UI feedback) and the webhook
 * (source of truth, catches users who close the browser early) — safe to
 * call from either or both, only the first call does anything.
 */
export async function markPurchasePaidAndCredit({
  razorpayOrderId,
  razorpayPaymentId,
}) {
  const { data: purchase, error } = await supabase
    .from("credit_purchases")
    .select("*")
    .eq("razorpay_order_id", razorpayOrderId)
    .maybeSingle();

  if (error || !purchase) {
    console.error(
      `[creditPurchase] No purchase found for order ${razorpayOrderId}`,
    );
    return { alreadyProcessed: false, notFound: true };
  }

  if (purchase.status === "paid") {
    console.log(
      `[creditPurchase] Order ${razorpayOrderId} already settled — skipping`,
    );
    return { alreadyProcessed: true, purchase };
  }

  await supabase
    .from("credit_purchases")
    .update({
      status: "paid",
      razorpay_payment_id: razorpayPaymentId,
      paid_at: new Date().toISOString(),
    })
    .eq("id", purchase.id);

  const isCustom = !purchase.package_id;
  const result = await addCreditsToBalance({
    userId: purchase.user_id,
    credits: purchase.credits,
    type: "purchase",
    note: isCustom
      ? `Custom top-up — ${purchase.credits} credits — ₹${purchase.amount_inr} — order ${razorpayOrderId}`
      : `Purchased ${purchase.credits} credits — ₹${purchase.amount_inr} — order ${razorpayOrderId}`,
  });

  console.log(
    `[creditPurchase] ✅ Credited user ${purchase.user_id}: +${purchase.credits} credits ` +
      `(₹${purchase.amount_inr}) | balance: ${result.newBalance}`,
  );

  return { alreadyProcessed: false, purchase, ...result };
}

/**
 * Recent purchase history for the "Recent purchases" panel on the
 * pricing page. Reads directly from credit_purchases — no dependency on
 * the usage-logs table/endpoint, so this ships independently of that work.
 */
export async function getPurchaseHistory({ userId, limit = 20 }) {
  const { data, error } = await supabase
    .from("credit_purchases")
    .select(
      "id, credits, amount_inr, status, gateway, razorpay_order_id, razorpay_payment_id, created_at, paid_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function markPurchaseFailed({ razorpayOrderId }) {
  await supabase
    .from("credit_purchases")
    .update({ status: "failed" })
    .eq("razorpay_order_id", razorpayOrderId)
    .eq("status", "pending"); // never overwrite an already-paid order
}
