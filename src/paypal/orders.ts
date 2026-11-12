/** Typed wrappers for the PayPal calls Going Once makes. */
import type { Link, Money, PayPalClient } from "./client";

export type ItemCategory = "DONATION" | "DIGITAL_GOODS";

export interface Authorization {
  id: string;
  status: "CREATED" | "CAPTURED" | "DENIED" | "PARTIALLY_CAPTURED" | "VOIDED" | "PENDING" | string;
  status_details?: { reason?: string };
  amount?: Money;
  expiration_time?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
}

export interface Order {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED" | string;
  links?: Link[];
  purchase_units?: {
    custom_id?: string;
    payments?: { authorizations?: Authorization[]; captures?: { id: string; status: string; invoice_id?: string; status_details?: { reason?: string } }[] };
  }[];
}

export const usd = (cents: number): Money => ({ currency_code: "USD", value: (cents / 100).toFixed(2) });
export const toCents = (m: Money | undefined) => (m ? Math.round(Number(m.value) * 100) : 0);
export const authOf = (o: Order) => o.purchase_units?.[0]?.payments?.authorizations?.[0];

export function holdOrderBody(opts: {
  cents: number;
  bidderId: string;
  roomName: string;
  category: ItemCategory;
  returnUrl: string;
  cancelUrl: string;
}) {
  const amount = usd(opts.cents);
  return {
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: "hold",
        custom_id: opts.bidderId,
        description: `Spending-limit hold for ${opts.roomName}`.slice(0, 127),
        amount: { ...amount, breakdown: { item_total: amount } },
        items: [{ name: "Auction spending limit", quantity: "1", category: opts.category, unit_amount: amount }],
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "Going Once",
          shipping_preference: "NO_SHIPPING",
          user_action: "CONTINUE",
          return_url: opts.returnUrl,
          cancel_url: opts.cancelUrl,
        },
      },
    },
  };
}

export const getOrder = (pp: PayPalClient, id: string) => pp.request<Order>("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`);
export const getAuthorization = (pp: PayPalClient, id: string) =>
  pp.request<Authorization>("GET", `/v2/payments/authorizations/${encodeURIComponent(id)}`);
