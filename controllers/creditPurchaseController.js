import {
  initiatePurchase,
  markPurchasePaidAndCredit,
  markPurchaseFailed,
  getPurchaseHistory,
} from "../services/creditPurchaseService.js";
import {
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "../utils/razorpayClient.js";

/**
 * POST /api/credits/purchase/initiate
 * Body: EITHER { package_id }  OR  { amount_inr } — never both.
 */
export const initiatePurchaseHandler = async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { package_id, amount_inr } = req.body;

    if (!package_id && !amount_inr) {
      return res
        .status(400)
        .json({ error: "Either package_id or amount_inr is required" });
    }
    if (package_id && amount_inr) {
      return res
        .status(400)
        .json({ error: "Provide either package_id or amount_inr, not both" });
    }

    const result = await initiatePurchase({
      userId,
      packageId: package_id,
      customAmountInr: amount_inr,
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error("[initiatePurchaseHandler] error:", err.message);
    // Surface validation messages (e.g. "Minimum custom top-up is ₹200")
    // to the user instead of a generic 500 — these are expected user
    // errors, not server failures.
    const isValidationError = /minimum|invalid|required|not both/i.test(
      err.message,
    );
    return res
      .status(isValidationError ? 400 : 500)
      .json({
        error: isValidationError ? err.message : "Failed to start checkout",
      });
  }
};

/**
 * POST /api/credits/purchase/verify
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * Called by the frontend immediately after Razorpay Checkout's success
 * handler fires — gives fast UI feedback. NOT the only place credits get
 * granted (the webhook is the real source of truth, for users who close
 * the browser before this fires).
 */
export const verifyPurchaseHandler = async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res
        .status(400)
        .json({ error: "Missing payment verification fields" });
    }

    const isValid = verifyCheckoutSignature({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
    });

    if (!isValid) {
      console.error(
        `[verifyPurchaseHandler] ⚠️  Signature mismatch for order ${razorpay_order_id} — ` +
          `possible tampering attempt, rejecting`,
      );
      return res.status(400).json({ error: "Payment verification failed" });
    }

    const result = await markPurchasePaidAndCredit({
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
    });

    if (result.notFound) {
      return res.status(404).json({ error: "Order not found" });
    }

    return res.status(200).json({
      success: true,
      newBalance: result.newBalance ?? result.purchase?.credits,
      alreadyProcessed: result.alreadyProcessed,
    });
  } catch (err) {
    console.error("[verifyPurchaseHandler] error:", err.message);
    return res.status(500).json({ error: "Failed to verify payment" });
  }
};

/**
 * GET /api/credits/purchase/history
 * Returns the current user's recent credit purchases (paid, pending, and
 * failed) newest-first — powers the "Recent purchases" panel.
 */
export const getPurchaseHistoryHandler = async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const purchases = await getPurchaseHistory({ userId, limit: 20 });
    return res.status(200).json({ purchases });
  } catch (err) {
    console.error("[getPurchaseHistoryHandler] error:", err.message);
    return res.status(500).json({ error: "Failed to load purchase history" });
  }
};

/**
 * POST /api/credits/purchase/webhook
 * ⚠️ This route MUST receive the RAW request body — see app.js wiring
 * notes below. Do not let express.json() touch this route before this
 * handler runs, or signature verification will always fail.
 *
 * Configure in Razorpay Dashboard -> Settings -> Webhooks:
 *   URL: https://your-domain.com/api/credits/purchase/webhook
 *   Events: payment.captured, payment.failed
 */
export const razorpayWebhookHandler = async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const rawBody = req.body; // Buffer — see app.js wiring, must be express.raw()

    if (!signature) {
      return res.status(400).json({ error: "Missing signature header" });
    }

    const isValid = verifyWebhookSignature({
      rawBody: rawBody.toString("utf8"),
      signature,
    });

    if (!isValid) {
      console.error(
        "[razorpayWebhook] ⚠️  Invalid webhook signature — rejecting",
      );
      return res.status(400).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody.toString("utf8"));
    console.log(`[razorpayWebhook] Event: ${event.event}`);

    if (event.event === "payment.captured") {
      const payment = event.payload.payment.entity;
      await markPurchasePaidAndCredit({
        razorpayOrderId: payment.order_id,
        razorpayPaymentId: payment.id,
      });
    } else if (event.event === "payment.failed") {
      const payment = event.payload.payment.entity;
      await markPurchaseFailed({ razorpayOrderId: payment.order_id });
    }

    // Always 200 quickly — Razorpay retries on non-2xx, and slow/failing
    // responses here can cascade into duplicate webhook storms.
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[razorpayWebhookHandler] error:", err.message);
    // Still 200 — an internal error shouldn't trigger infinite Razorpay
    // retries; log it and investigate manually instead.
    return res.status(200).json({ received: true, error: "internal_error" });
  }
};
