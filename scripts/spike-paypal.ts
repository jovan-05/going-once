/**
 * M1 — prove the money flow against the PayPal sandbox.
 *
 *   1. Create a $300 AUTHORIZE order, print the approval link.
 *   2. Wait for sandbox-buyer approval, then authorize; print the auth id.
 *   3. Capture $120 (final_capture: false).
 *   4. Capture $80  (final_capture: false).
 *   5. Void the remainder.
 *   6. Re-read and print every capture and the final authorization status.
 *
 * Usage:
 *   npm run spike:paypal              # start or resume
 *   npm run spike:paypal -- --reset   # throw away saved state, start a new run
 *   npm run spike:paypal -- --no-wait # don't poll for approval; re-run later
 *
 * State (ids + every PayPal-Request-Id) is written to data/spike-paypal.json
 * BEFORE each call, so a crash or Ctrl-C resumes with the same request ids.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PayPalClient, PayPalError, configFromEnv, findLink, type Link, type Money } from "../src/paypal/client";

const STATE_PATH = "data/spike-paypal.json";
const CURRENCY = "USD";
const HOLD = "300.00";
const CAPTURES = ["120.00", "80.00"] as const;
const APPROVAL_TIMEOUT_MS = 15 * 60_000;

type ItemCategory = "DONATION" | "DIGITAL_GOODS";

interface CaptureRecord {
  amount: string;
  requestId: string;
  invoiceId: string;
  id?: string;
  status?: string;
}

interface SpikeState {
  runId: string;
  createdAt: string;
  create: { requestId: string; itemCategory: ItemCategory; rejected?: { category: ItemCategory; error: string }[] };
  orderId?: string;
  approveUrl?: string;
  authorize: { requestId: string };
  authId?: string;
  captures: CaptureRecord[];
  void: { requestId: string; done?: boolean; status?: string };
}

// ---------- tiny helpers ----------

const args = new Set(process.argv.slice(2));
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
const step = (n: number, title: string) => console.log(`\n${c.bold(`[${n}/6] ${title}`)}`);
const ok = (label: string, value: string) => console.log(`  ${c.green("✓")} ${label.padEnd(22)} ${c.cyan(value)}`);
const info = (s: string) => console.log(`  ${c.dim(s)}`);

function save(s: SpikeState) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATE_PATH);
}

function load(): SpikeState {
  if (args.has("--reset") && existsSync(STATE_PATH)) rmSync(STATE_PATH);
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")) as SpikeState;
  const runId = new Date().toISOString().replace(/\D/g, "").slice(0, 14) + "-" + randomUUID().slice(0, 6);
  const s: SpikeState = {
    runId,
    createdAt: new Date().toISOString(),
    create: { requestId: `spike:${runId}:create:DONATION`, itemCategory: "DONATION" },
    authorize: { requestId: `spike:${runId}:authorize` },
    captures: CAPTURES.map((amount, i) => ({
      amount,
      requestId: `spike:${runId}:capture:${i + 1}`,
      // invoice_id must be unique per capture across the merchant account.
      invoiceId: `spike-${runId}-lot${i + 1}-bidder1`,
    })),
    void: { requestId: `spike:${runId}:void` },
  };
  save(s);
  return s;
}

function printPayPalError(e: unknown) {
  if (e instanceof PayPalError) {
    console.log(c.red("\n  PayPal returned an error — record this in docs/PAYPAL.md:"));
    console.log(
      JSON.stringify(
        { http_status: e.status, request: `${e.method} ${e.path}`, name: e.paypalName, message: e.paypalMessage, details: e.details, debug_id: e.debugId },
        null,
        2,
      )
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"),
    );
  } else {
    console.log(c.red(`\n  ${e instanceof Error ? e.message : String(e)}`));
  }
}

// ---------- PayPal response shapes (only what we read) ----------

interface Authorization {
  id: string;
  status: string;
  amount?: Money;
  expiration_time?: string;
  links?: Link[];
}
interface Capture {
  id: string;
  status: string;
  status_details?: { reason?: string };
  amount?: Money;
  final_capture?: boolean;
  invoice_id?: string;
  seller_receivable_breakdown?: { gross_amount?: Money; paypal_fee?: Money; net_amount?: Money };
}
interface Order {
  id: string;
  status: string;
  intent?: string;
  links?: Link[];
  purchase_units?: { payments?: { authorizations?: Authorization[]; captures?: Capture[] } }[];
}

const authFromOrder = (o: Order) => o.purchase_units?.[0]?.payments?.authorizations?.[0];

// ---------- the spike ----------

async function main() {
  const pp = new PayPalClient(configFromEnv());
  const s = load();
  console.log(c.bold("Going Once — PayPal sandbox money-flow spike"));
  info(`run ${s.runId}  ·  state ${STATE_PATH}`);

  // 1. Create the $300 AUTHORIZE order
  step(1, `Create $${HOLD} AUTHORIZE order`);
  if (!s.orderId) {
    const returnBase = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
    const body = (category: ItemCategory) => ({
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: "hold",
          custom_id: "spike-bidder-1",
          description: "Going Once — spending-limit hold",
          amount: { currency_code: CURRENCY, value: HOLD, breakdown: { item_total: { currency_code: CURRENCY, value: HOLD } } },
          items: [{ name: "Auction spending limit", quantity: "1", category, unit_amount: { currency_code: CURRENCY, value: HOLD } }],
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Going Once",
            shipping_preference: "NO_SHIPPING",
            user_action: "CONTINUE",
            return_url: `${returnBase}/join/spike?approved=1`,
            cancel_url: `${returnBase}/join/spike?cancelled=1`,
          },
        },
      },
    });

    let order: Order | undefined;
    for (;;) {
      try {
        const res = await pp.request<Order>("POST", "/v2/checkout/orders", { body: body(s.create.itemCategory), requestId: s.create.requestId });
        order = res.data;
        break;
      } catch (e) {
        // DONATION may be refused for this flow; fall back to DIGITAL_GOODS once, with a NEW request id (different body).
        if (e instanceof PayPalError && e.status === 422 && s.create.itemCategory === "DONATION") {
          (s.create.rejected ??= []).push({ category: "DONATION", error: e.message });
          printPayPalError(e);
          info("DONATION refused → retrying with DIGITAL_GOODS");
          s.create.itemCategory = "DIGITAL_GOODS";
          s.create.requestId = `spike:${s.runId}:create:DIGITAL_GOODS`;
          save(s);
          continue;
        }
        throw e;
      }
    }
    s.orderId = order.id;
    s.approveUrl = findLink(order.links, "payer-action", "approve");
    save(s);
  }
  ok("order id", s.orderId);
  ok("item category", s.create.itemCategory);
  if (s.create.rejected?.length) info(`(DONATION rejected: ${s.create.rejected[0]?.error})`);
  ok("approval link", s.approveUrl ?? "(none returned!)");

  // 2. Wait for approval, then authorize
  step(2, "Buyer approval → authorize");
  if (!s.authId) {
    let order = (await pp.request<Order>("GET", `/v2/checkout/orders/${s.orderId}`)).data;
    if (order.status !== "APPROVED" && order.status !== "COMPLETED") {
      console.log(`\n  ${c.bold("Open this link and log in as a sandbox PERSONAL (buyer) account:")}`);
      console.log(`  ${c.cyan(s.approveUrl ?? "")}`);
      info("After approving, PayPal redirects to PUBLIC_BASE_URL — a 'can't connect' page is fine; this script polls the order.");
      if (args.has("--no-wait")) {
        info(`order status ${order.status}. Re-run \`npm run spike:paypal\` after approving.`);
        return;
      }
      const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
      process.stdout.write("  waiting for approval ");
      while (order.status !== "APPROVED" && order.status !== "COMPLETED") {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for approval (status ${order.status}). Re-run to keep waiting.`);
        await new Promise((r) => setTimeout(r, 3000));
        process.stdout.write(".");
        order = (await pp.request<Order>("GET", `/v2/checkout/orders/${s.orderId}`)).data;
      }
      process.stdout.write("\n");
    }
    ok("order status", order.status);

    let auth = authFromOrder(order);
    if (!auth) {
      try {
        const res = await pp.request<Order>("POST", `/v2/checkout/orders/${s.orderId}/authorize`, { body: {}, requestId: s.authorize.requestId });
        auth = authFromOrder(res.data);
      } catch (e) {
        // Lost response on a previous run: resolve by re-reading, never by a new request (rule 3).
        if (e instanceof PayPalError && e.issues.includes("ORDER_ALREADY_AUTHORIZED")) {
          auth = authFromOrder((await pp.request<Order>("GET", `/v2/checkout/orders/${s.orderId}`)).data);
        } else throw e;
      }
    }
    if (!auth) throw new Error("Authorize succeeded but no authorization id in the response.");
    s.authId = auth.id;
    save(s);
    ok("authorization status", `${auth.status} ${auth.amount ? `${auth.amount.value} ${auth.amount.currency_code}` : ""}`.trim());
    if (auth.expiration_time) ok("auth expires", auth.expiration_time);
  }
  ok("authorization id", s.authId);

  // 3 + 4. Partial captures
  for (const [i, cap] of s.captures.entries()) {
    step(3 + i, `Capture $${cap.amount} (final_capture: false)`);
    if (!cap.id) {
      const res = await pp.request<Capture>("POST", `/v2/payments/authorizations/${s.authId}/capture`, {
        requestId: cap.requestId,
        body: { amount: { currency_code: CURRENCY, value: cap.amount }, final_capture: false, invoice_id: cap.invoiceId },
      });
      cap.id = res.data.id;
      cap.status = res.data.status;
      save(s);
    }
    ok("capture id", cap.id);
    ok("capture status", cap.status ?? "?");
  }

  // 5. Void the remainder
  step(5, "Void the remaining authorization");
  if (!s.void.done) {
    try {
      const res = await pp.request<Authorization | Record<string, never>>("POST", `/v2/payments/authorizations/${s.authId}/void`, {
        requestId: s.void.requestId,
      });
      info(`HTTP ${res.status}`);
    } catch (e) {
      // Already voided on a previous run whose response was lost: re-read below decides.
      if (!(e instanceof PayPalError && e.issues.includes("AUTHORIZATION_ALREADY_VOIDED"))) throw e;
      info("already voided (from a previous run)");
    }
    const auth = (await pp.request<Authorization>("GET", `/v2/payments/authorizations/${s.authId}`)).data;
    s.void.done = true;
    s.void.status = auth.status;
    save(s);
  }
  ok("authorization after void", s.void.status ?? "?");

  // 6. Re-read everything from PayPal (source of truth)
  step(6, "Re-read from PayPal");
  for (const cap of s.captures) {
    const r = (await pp.request<Capture>("GET", `/v2/payments/captures/${cap.id}`)).data;
    const fee = r.seller_receivable_breakdown?.paypal_fee?.value;
    const net = r.seller_receivable_breakdown?.net_amount?.value;
    ok(`capture ${r.id}`, `${r.status}${r.status_details?.reason ? ` (${r.status_details.reason})` : ""}  ${r.amount?.value} ${r.amount?.currency_code}  final=${r.final_capture}  fee=${fee ?? "?"} net=${net ?? "?"}  invoice=${r.invoice_id}`);
  }
  const auth = (await pp.request<Authorization>("GET", `/v2/payments/authorizations/${s.authId}`)).data;
  ok(`authorization ${auth.id}`, `${auth.status}  amount=${auth.amount?.value} ${auth.amount?.currency_code}`);
  const order = (await pp.request<Order>("GET", `/v2/checkout/orders/${s.orderId}`)).data;
  ok(`order ${order.id}`, order.status);

  const allCompleted = s.captures.every((x) => x.status === "COMPLETED");
  console.log(
    `\n${c.bold(allCompleted && auth.status === "VOIDED" ? c.green("M1 PASS") : "M1 DONE — review statuses above")}: ` +
      `hold $${HOLD} → captured ${s.captures.map((x) => `$${x.amount}`).join(" + ")} → remainder released (auth ${auth.status}).`,
  );
  info("Record the item category and final auth status in docs/PAYPAL.md.");
}

main().catch((e) => {
  printPayPalError(e);
  if (existsSync(STATE_PATH)) console.log(c.dim(`\n  State saved in ${STATE_PATH}; re-running resumes with the same PayPal-Request-Ids.`));
  process.exit(1);
});
