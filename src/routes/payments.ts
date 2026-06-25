// Razorpay-backed checkout flow.
//
//   1. Client: POST /payments/order  { planId }
//      → backend looks up the plan price, creates a Razorpay Order,
//        and a `PaymentHistory` row in `created` state. Returns the
//        IDs/keys the Razorpay checkout sheet needs.
//
//   2. Client opens Razorpay checkout with those IDs. User pays.
//
//   3. Client: POST /payments/verify
//        { razorpayOrderId, razorpayPaymentId, razorpaySignature }
//      → backend verifies the HMAC signature, marks the payment
//        `captured`, and grants the user the plan (creating a
//        `MealActivePlan` row spanning the plan's expirationDuration).
//
// We *never* trust amounts from the client — the price is always
// looked up server-side from `Plans.price` so a tampered client
// can't pay ₹1 for a ₹999 plan.
//
// Failures (`/payments/failure`) are best-effort: the client tells
// us when Razorpay reported an error so we can flip the row to
// `failed` for the admin dashboard, but absence of this call must
// not break anything — Razorpay is the source of truth.

import { Router } from "express";
import type { Request, Response } from "express";

import { prisma } from "../lib/prisma.ts";
import {
  createRazorpayOrder,
  getPublicKeyId,
  verifyRazorpaySignature,
} from "../lib/razorpay.ts";
import { requireAuth } from "../middleware/require_auth.ts";

export const paymentsRouter: Router = Router();
paymentsRouter.use(requireAuth);

/**
 * Translate the schema's expirationDuration enum into a concrete
 * MealActivePlan end date. `lifetime` becomes year-9999 — ugly, but
 * the column is NOT NULL and we'd rather not bend the schema for a
 * sentinel value (one task at a time).
 */
function endDateForDuration(start: Date, duration: string): Date {
  const d = new Date(start);
  switch (duration) {
    case "oneMonth":
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d;
    case "threeMonths":
      d.setUTCMonth(d.getUTCMonth() + 3);
      return d;
    case "sixMonths":
      d.setUTCMonth(d.getUTCMonth() + 6);
      return d;
    case "oneYear":
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      return d;
    case "lifetime":
    default:
      // ~277 years out. Long enough that we'll have replaced this
      // sentinel with a nullable column before it ever matters.
      return new Date("9999-12-31T00:00:00.000Z");
  }
}

/**
 * Create a Razorpay order for the given plan.
 *
 * Returns the keyId publicly so the client can launch Razorpay's
 * checkout — the secret is *never* part of the response.
 */
paymentsRouter.post("/order", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { planId?: unknown };
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  if (!planId) {
    res.status(400).json({ error: "invalid_plan_id" });
    return;
  }

  const plan = await prisma.plans.findUnique({
    where: { id: planId },
    select: { id: true, name: true, price: true, expirationDuration: true },
  });
  if (!plan) {
    res.status(404).json({ error: "plan_not_found" });
    return;
  }

  // Block buying a plan the user already has an active subscription
  // to. The catalog hides the buy button when the cached subscription
  // list says "active", but a stale client (mid-flight payment, slow
  // refresh after a previous purchase) can still slip through — this
  // is the server-side backstop so we never let a user double-pay.
  //
  // `gt` (not `gte`) so a sub that expires at the exact instant of
  // the request can be repurchased without an awkward "try again in
  // 100ms" message.
  const active = await prisma.mealActivePlan.findFirst({
    where: {
      userId: req.userId!,
      plansId: plan.id,
      endDate: { gt: new Date() },
    },
    select: { id: true, endDate: true },
    orderBy: { endDate: "desc" },
  });
  if (active) {
    res.status(409).json({
      error: "already_subscribed",
      endDate: active.endDate.toISOString(),
      // `isLifetime` lets the client show "Lifetime access" instead
      // of "active until 31 Dec 9999" if a stale checkout race
      // somehow makes it this far.
      isLifetime: plan.expirationDuration === "lifetime",
    });
    return;
  }

  // Zero-price plans skip Razorpay — the client should call
  // POST /payments/activate-free instead.
  if (plan.price === 0) {
    res.status(409).json({ error: "free_plan_use_activate" });
    return;
  }

  // Razorpay requires amount in paise. Round to the nearest integer
  // so floating-point quirks (₹99.999999) can't slip through.
  const amountInPaise = Math.round(plan.price * 100);
  if (!Number.isFinite(amountInPaise) || amountInPaise <= 0) {
    res.status(409).json({ error: "plan_not_purchasable" });
    return;
  }
  // Razorpay caps single transactions at ₹5,00,000 by default. We
  // surface a friendlier error than letting the API reject it.
  if (amountInPaise > 50_000_000) {
    res.status(409).json({ error: "amount_exceeds_limit" });
    return;
  }

  // Reserve the PaymentHistory row first so we have a stable
  // `receipt` to send to Razorpay. We use our internal id as the
  // receipt — operators can look up either side from one search.
  const payment = await prisma.paymentHistory.create({
    data: {
      plansId: plan.id,
      amount: plan.price,
      currency: "INR",
      userid: req.userId!,
      status: "created",
    },
    select: { id: true },
  });

  let order;
  try {
    order = await createRazorpayOrder({
      amountInPaise,
      currency: "INR",
      receipt: payment.id,
      notes: {
        planId: plan.id,
        planName: plan.name,
        userId: req.userId!,
      },
    });
  } catch (err) {
    // Roll the placeholder row forward to `failed` so the admin
    // dashboard reflects reality instead of leaving a stuck
    // `created`. We don't `delete` because the row's id was already
    // handed to Razorpay as the receipt.
    await prisma.paymentHistory
      .update({
        where: { id: payment.id },
        data: { status: "failed" },
      })
      .catch(() => undefined);
    console.error("[payments] razorpay create order failed:", err);
    res.status(502).json({
      error: "gateway_error",
      message: err instanceof Error ? err.message : "Razorpay unavailable.",
    });
    return;
  }

  await prisma.paymentHistory.update({
    where: { id: payment.id },
    data: { razorpayOrderId: order.id },
  });

  res.json({
    paymentId: payment.id,
    razorpayOrderId: order.id,
    keyId: getPublicKeyId(),
    amount: order.amount, // paise — Razorpay checkout wants paise
    currency: order.currency,
    planId: plan.id,
    planName: plan.name,
  });
});

/**
 * Activate a zero-price plan without going through Razorpay.
 *
 * Free tiers still need a `MealActivePlan` row so feature access
 * merges them with admin-configured free features the same way paid
 * subscriptions do.
 */
paymentsRouter.post("/activate-free", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { planId?: unknown };
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  if (!planId) {
    res.status(400).json({ error: "invalid_plan_id" });
    return;
  }

  const plan = await prisma.plans.findUnique({
    where: { id: planId },
    select: { id: true, name: true, price: true, expirationDuration: true },
  });
  if (!plan) {
    res.status(404).json({ error: "plan_not_found" });
    return;
  }
  if (plan.price !== 0) {
    res.status(409).json({ error: "plan_not_free" });
    return;
  }

  const active = await prisma.mealActivePlan.findFirst({
    where: {
      userId: req.userId!,
      plansId: plan.id,
      endDate: { gt: new Date() },
    },
    select: { id: true, endDate: true },
    orderBy: { endDate: "desc" },
  });
  if (active) {
    res.status(409).json({
      error: "already_subscribed",
      endDate: active.endDate.toISOString(),
      isLifetime: plan.expirationDuration === "lifetime",
    });
    return;
  }

  const now = new Date();
  const endDate = endDateForDuration(now, plan.expirationDuration ?? "lifetime");

  const subscription = await prisma.$transaction(async (tx) => {
    const payment = await tx.paymentHistory.create({
      data: {
        plansId: plan.id,
        amount: 0,
        currency: "INR",
        userid: req.userId!,
        status: "captured",
      },
      select: { id: true },
    });
    const row = await tx.mealActivePlan.create({
      data: {
        plansId: plan.id,
        userId: req.userId!,
        startDate: now,
        endDate,
      },
      select: { id: true, startDate: true, endDate: true },
    });
    return { paymentId: payment.id, subscription: row };
  });

  res.json({
    status: "activated",
    paymentId: subscription.paymentId,
    subscriptionId: subscription.subscription.id,
    endDate: subscription.subscription.endDate.toISOString(),
  });
});

/**
 * Verify a completed Razorpay payment and activate the plan.
 *
 * The client is expected to call this immediately after the
 * Razorpay checkout fires its onPaymentSuccess callback. If the
 * signature is good we transition the row to `captured` and grant
 * a `MealActivePlan`. If not, the row goes to `failed` — never
 * `captured`, even if the user really did pay (Razorpay's webhook,
 * which we'll add later, is the durable backstop for that case).
 */
paymentsRouter.post("/verify", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    razorpayOrderId?: unknown;
    razorpayPaymentId?: unknown;
    razorpaySignature?: unknown;
  };
  const razorpayOrderId =
    typeof body.razorpayOrderId === "string" ? body.razorpayOrderId : "";
  const razorpayPaymentId =
    typeof body.razorpayPaymentId === "string" ? body.razorpayPaymentId : "";
  const razorpaySignature =
    typeof body.razorpaySignature === "string" ? body.razorpaySignature : "";

  const missing: string[] = [];
  if (!razorpayOrderId) missing.push("razorpayOrderId");
  if (!razorpayPaymentId) missing.push("razorpayPaymentId");
  if (!razorpaySignature) missing.push("razorpaySignature");
  if (missing.length > 0) {
    res.status(400).json({ error: "missing_fields", missing });
    return;
  }

  // Look up the pending payment by Razorpay order id and the
  // current user. Scoping by user id prevents someone from
  // confirming someone else's pending order.
  const payment = await prisma.paymentHistory.findFirst({
    where: { razorpayOrderId, userid: req.userId! },
    select: {
      id: true,
      status: true,
      plansId: true,
      plan: { select: { expirationDuration: true } },
    },
  });
  if (!payment) {
    res.status(404).json({ error: "order_not_found" });
    return;
  }
  if (payment.status === "captured") {
    // Idempotent re-verify (the client retried) — already done.
    res.json({ status: "captured", paymentId: payment.id });
    return;
  }

  const ok = verifyRazorpaySignature({
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
  });
  if (!ok) {
    await prisma.paymentHistory.update({
      where: { id: payment.id },
      data: { status: "failed", razorpayPaymentId },
    });
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  // Signature is genuine. Mark captured + activate the plan in one
  // transaction so a partial write can't leave a paid-but-inactive
  // customer.
  const now = new Date();
  const endDate = endDateForDuration(
    now,
    payment.plan.expirationDuration ?? "lifetime",
  );

  await prisma.$transaction([
    prisma.paymentHistory.update({
      where: { id: payment.id },
      data: {
        status: "captured",
        razorpayPaymentId,
        razorpaySignature,
      },
    }),
    prisma.mealActivePlan.create({
      data: {
        plansId: payment.plansId,
        userId: req.userId!,
        startDate: now,
        endDate,
      },
    }),
  ]);

  res.json({ status: "captured", paymentId: payment.id });
});

/**
 * Best-effort failure reporter. The client calls this when Razorpay
 * fires onPaymentError — it lets us flip the placeholder row to
 * `failed` so the admin dashboard isn't littered with `created`
 * orphans. Returns 200 even on no-op so the client doesn't loop.
 */
paymentsRouter.post("/failure", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    razorpayOrderId?: unknown;
    reason?: unknown;
  };
  const razorpayOrderId =
    typeof body.razorpayOrderId === "string" ? body.razorpayOrderId : "";
  if (!razorpayOrderId) {
    res.json({ ok: true });
    return;
  }
  await prisma.paymentHistory
    .updateMany({
      where: {
        razorpayOrderId,
        userid: req.userId!,
        status: "created",
      },
      data: { status: "failed" },
    })
    .catch((err) => {
      console.warn("[payments] failure mark error:", err);
    });
  res.json({ ok: true });
});
