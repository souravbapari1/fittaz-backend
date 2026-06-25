// Thin Razorpay client.
//
// We hit the Razorpay REST API directly rather than pulling in their
// Node SDK — the two endpoints we need (create order + we already
// have HMAC) are trivial, the SDK is heavy, and one less dep means
// one less audit surface for handling payment data.
//
// Docs: https://razorpay.com/docs/api/orders/

import { createHmac, timingSafeEqual } from "node:crypto";

const ORDERS_ENDPOINT = "https://api.razorpay.com/v1/orders";

/**
 * Razorpay API credentials, loaded once at module init. Throwing here
 * means a misconfigured deploy fails loudly on first request instead
 * of silently 500-ing.
 *
 * `keyId` (rzp_test_… or rzp_live_…) is *also* sent to the client so
 * the Razorpay checkout sheet can be opened; `keySecret` MUST stay
 * server-side — it's used for HTTP Basic auth to Razorpay AND to sign
 * the HMAC that proves a payment is genuine.
 */
function readCredentials(): { keyId: string; keySecret: string } {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error(
      "Razorpay is not configured. Set RAZORPAY_KEY_ID and " +
        "RAZORPAY_KEY_SECRET in backend/.env (use the test keys from " +
        "https://dashboard.razorpay.com/app/keys for development).",
    );
  }
  return { keyId, keySecret };
}

export function getPublicKeyId(): string {
  return readCredentials().keyId;
}

interface RazorpayOrderResponse {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
  created_at: number;
}

export interface CreateOrderInput {
  /** Amount in the smallest currency unit (paise for INR). */
  amountInPaise: number;
  currency: string;
  /** Operator-readable receipt id — usually our internal PaymentHistory.id. */
  receipt: string;
  /** Arbitrary metadata Razorpay stores on the order (max 15 keys / 256 chars). */
  notes?: Record<string, string>;
}

/**
 * Create a Razorpay Order. The order is what the client uses to open
 * the checkout sheet — the actual Payment is created when the user
 * pays and is captured separately by Razorpay.
 */
export async function createRazorpayOrder(
  input: CreateOrderInput,
): Promise<RazorpayOrderResponse> {
  const { keyId, keySecret } = readCredentials();

  // HTTP Basic auth — `key_id:key_secret` base64-encoded.
  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  const res = await fetch(ORDERS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${credentials}`,
    },
    body: JSON.stringify({
      amount: input.amountInPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes ?? {},
    }),
  });

  if (!res.ok) {
    // Razorpay returns `{ error: { code, description, ... } }` on
    // failure. Pass the description through to our own error message
    // so operators see the real reason in their logs.
    const text = await res.text();
    let description = text;
    try {
      const body = JSON.parse(text) as { error?: { description?: string } };
      description = body.error?.description ?? text;
    } catch {
      // ignore parse failure; keep raw body
    }
    throw new Error(
      `Razorpay order creation failed (${res.status}): ${description}`,
    );
  }

  return (await res.json()) as RazorpayOrderResponse;
}

/**
 * Verify the signature Razorpay sends back to the client after a
 * successful payment.
 *
 * The client never sends raw money over the wire — instead it forwards
 * the three identifiers Razorpay handed it (order_id, payment_id, and
 * a signature). The signature is `HMAC_SHA256(order_id|payment_id,
 * key_secret)`. If we can reproduce it locally with our secret, we
 * know the payment really happened.
 *
 * Uses `timingSafeEqual` to compare so we don't leak signature bits
 * through response-time differences — overkill at this scale but it's
 * literally free and the right shape for a payment endpoint.
 */
export function verifyRazorpaySignature(args: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): boolean {
  const { keySecret } = readCredentials();
  const expected = createHmac("sha256", keySecret)
    .update(`${args.razorpayOrderId}|${args.razorpayPaymentId}`)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(args.razorpaySignature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
