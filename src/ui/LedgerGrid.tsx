"use client";
/**
 * The clerk's ledger (AG Grid Community): one row per bidder, with every
 * PayPal id the night produced. Read-only: the grid never changes money.
 */
import { useMemo } from "react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { usd, type ClerkSnapshot } from "./useRoom";

ModuleRegistry.registerModules([AllCommunityModule]);

const PP_SANDBOX = "https://www.sandbox.paypal.com";

export interface LedgerRow {
  id: string;
  paddle: number | null;
  name: string;
  shown: boolean;
  bot: boolean;
  holdCents: number;
  wonCents: number;
  remainingCents: number | null;
  authId: string | null;
  captures: { id: string | null; cents: number; status: string; simulated: boolean }[];
  hold: string;
  release: string;
  attention: boolean;
}

const theme = themeQuartz.withParams({
  backgroundColor: "#F6EDDC",
  foregroundColor: "#2B0A1D",
  headerBackgroundColor: "#EADBC4",
  oddRowBackgroundColor: "#F1E5D1",
  accentColor: "#D4A23F",
  borderColor: "rgba(43, 10, 29, 0.14)",
  fontFamily: "inherit",
  fontSize: 14,
  headerFontWeight: 600,
  rowHeight: 48,
  wrapperBorderRadius: 0,
});

export function ledgerRows(s: ClerkSnapshot): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const release = new Map(s.releases.map((r) => [r.bidder_id, r]));
  const seen = new Set<string>();
  for (const p of s.payments) {
    seen.add(p.id);
    const b = s.allBidders.find((x) => x.id === p.id);
    const caps = s.captureRows.filter((c) => c.bidder_id === p.id);
    const r = release.get(p.id);
    const bad = caps.some((c) => ["DECLINED", "FAILED", "failed"].includes(c.status)) || r?.status === "failed";
    rows.push({
      id: p.id,
      paddle: b?.paddle ?? null,
      name: p.name,
      shown: p.show_name === 1,
      bot: false,
      holdCents: p.authorized_cents ?? p.limit_cents,
      wonCents: b?.wonCents ?? 0,
      remainingCents: b ? b.remainingCents : null,
      authId: p.auth_id,
      captures: caps.map((c) => ({ id: c.capture_id, cents: c.amount_cents, status: c.status, simulated: !!c.simulated })),
      hold: p.simulated ? "Simulated (test)" : holdCopy(p.status, p.auth_status),
      release: r ? releaseCopy(r.status, r.held_cents - r.won_cents) : "—",
      attention: bad || p.status === "failed",
    });
  }
  // Bots live only in the engine (demo rooms); show them so the totals add up.
  for (const b of s.allBidders) {
    if (seen.has(b.id)) continue;
    rows.push({
      id: b.id,
      paddle: b.paddle,
      name: b.name,
      shown: b.showName,
      bot: b.isBot,
      holdCents: b.holdCents,
      wonCents: b.wonCents,
      remainingCents: b.remainingCents,
      authId: null,
      captures: s.captureRows.filter((c) => c.bidder_id === b.id).map((c) => ({ id: c.capture_id, cents: c.amount_cents, status: c.status, simulated: !!c.simulated })),
      hold: b.isBot ? "BOT · simulated hold" : "Simulated (test)",
      release: s.night ? "No payment held" : "—",
      attention: false,
    });
  }
  return rows.sort((a, b) => (a.paddle ?? 1e9) - (b.paddle ?? 1e9));
}

function holdCopy(status: string, auth: string | null) {
  switch (status) {
    case "active":
      return auth === "VOIDED" ? "Released" : `Hold active (${auth ?? "?"})`;
    case "awaiting_approval":
      return "Waiting for PayPal approval";
    case "authorizing":
      return "Authorizing…";
    case "creating_order":
      return "Starting hold…";
    case "pending_review":
      return "PayPal reviewing";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Needs attention";
    default:
      return status;
  }
}

function releaseCopy(status: string, restCents: number) {
  switch (status) {
    case "VOIDED":
      return `Released ${usd(Math.max(0, restCents))}`;
    case "CAPTURED":
      return "Fully captured";
    case "voiding":
      return "Releasing…";
    case "simulated":
      return "No payment held";
    default:
      return "Needs attention";
  }
}

function captureCopy(s: string) {
  switch (s) {
    case "COMPLETED":
      return "captured";
    case "PENDING":
      return "pending";
    case "capturing":
      return "capturing";
    case "simulated":
      return "no payment";
    default:
      return "needs attention";
  }
}

const money = (p: { value?: number | null }) => (p.value === null || p.value === undefined ? "—" : usd(p.value));

function NameCell({ data }: ICellRendererParams<LedgerRow>) {
  if (!data) return null;
  return (
    <span>
      {data.name}
      {data.bot && <span className="ml-2 rounded bg-smoke px-1 font-display text-xs font-bold text-velvet">BOT</span>}
      {!data.shown && <span className="text-velvet/60"> (hidden on stage)</span>}
    </span>
  );
}

function AuthCell({ data }: ICellRendererParams<LedgerRow>) {
  if (!data?.authId) return <span>—</span>;
  return (
    <a className="font-mono text-xs underline" href={`${PP_SANDBOX}/activity/payment/${data.authId}`} target="_blank" rel="noreferrer">
      {data.authId}
    </a>
  );
}

function CapturesCell({ data }: ICellRendererParams<LedgerRow>) {
  if (!data?.captures.length) return <span>—</span>;
  return (
    <span className="flex flex-col justify-center leading-tight">
      {data.captures.map((c, i) => (
        <span key={c.id ?? i} className="whitespace-nowrap">
          {c.id ? (
            <a className="font-mono text-xs underline" href={`${PP_SANDBOX}/activity/payment/${c.id}`} target="_blank" rel="noreferrer">
              {c.id}
            </a>
          ) : (
            <span className="font-mono text-xs">{c.simulated ? "simulated" : "capturing…"}</span>
          )}{" "}
          <span className="text-xs text-velvet/70">
            {usd(c.cents)} · {captureCopy(c.status)}
          </span>
        </span>
      ))}
    </span>
  );
}

export function LedgerGrid({ rows }: { rows: LedgerRow[] }) {
  const cols = useMemo<ColDef<LedgerRow>[]>(
    () => [
      { field: "paddle", headerName: "Paddle", width: 112, cellClass: "font-display text-lg font-bold", sort: "asc" },
      { field: "name", headerName: "Name", flex: 1, minWidth: 160, cellRenderer: NameCell },
      { field: "holdCents", headerName: "Hold", width: 110, valueFormatter: money, type: "rightAligned" },
      { field: "wonCents", headerName: "Won", width: 110, valueFormatter: money, type: "rightAligned" },
      { field: "remainingCents", headerName: "Remaining", width: 124, valueFormatter: money, type: "rightAligned" },
      { field: "authId", headerName: "Authorization ID", width: 200, cellRenderer: AuthCell },
      { colId: "captures", headerName: "Captures", flex: 1.4, minWidth: 260, cellRenderer: CapturesCell, autoHeight: true, sortable: false },
      { field: "hold", headerName: "Hold status", width: 190 },
      {
        field: "release",
        headerName: "End of night",
        width: 170,
        cellClassRules: { "font-semibold": (p) => !!p.data?.attention },
      },
    ],
    [],
  );
  return (
    <div style={{ height: Math.min(640, 56 + Math.max(rows.length, 3) * 52) }}>
      <AgGridReact<LedgerRow>
        theme={theme}
        rowData={rows}
        columnDefs={cols}
        getRowId={(p) => p.data.id}
        defaultColDef={{ sortable: true, resizable: true }}
        rowClassRules={{ "!bg-brass/20": (p) => !!p.data?.attention }}
        overlayNoRowsTemplate="No one has joined yet. Share the stage QR code."
        suppressCellFocus
      />
    </div>
  );
}
