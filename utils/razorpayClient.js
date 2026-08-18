// utils/razorpayClient.js
import Razorpay from "razorpay";
import crypto from "crypto";

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

if (!KEY_ID || !KEY_SECRET) {
  throw new Error(
    "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set — check your .env",
  );
}

// Sanity check — catches the single most common footgun (test keys in
// production or vice versa) at startup instead of at payment time.
if (process.env.NODE_ENV === "production" && !KEY_ID.startsWith("rzp_live_")) {
  console.warn(
    `⚠️  RAZORPAY_KEY_ID does not start with "rzp_live_" (got: ${KEY_ID.slice(0, 12)}...) ` +
      `— are you accidentally using test keys in production?`,
  );
}

export const razorpay = new Razorpay({
  key_id: KEY_ID,
  key_secret: KEY_SECRET,
});

export const RAZORPAY_PUBLIC_KEY_ID = KEY_ID; // safe to send to the frontend

/**
 * Verifies the signature Razorpay's Checkout returns to the browser after
 * a successful payment (razorpay_order_id + razorpay_payment_id + razorpay_signature).
 * Uses RAZORPAY_KEY_SECRET — NOT the webhook secret, these are different.
 */
export function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  const expected = crypto
    .createHmac("sha256", KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return expected === signature;
}

/**
 * Verifies the x-razorpay-signature header on an incoming webhook.
 * MUST be computed against the raw, unparsed request body — re-serialized
 * JSON can differ byte-for-byte from what Razorpay actually signed.
 * Uses RAZORPAY_WEBHOOK_SECRET (set when you create the webhook in the
 * Razorpay dashboard) — NOT the API key secret.
 */
export function verifyWebhookSignature({ rawBody, signature }) {
  if (!WEBHOOK_SECRET) {
    throw new Error(
      "RAZORPAY_WEBHOOK_SECRET is not set — create a webhook in the Razorpay " +
        "dashboard (Settings -> Webhooks) first, then copy its secret into .env",
    );
  }
  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  return expected === signature;
}
