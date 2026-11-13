/*
 * Card slip — the "Transaction Record" a card payment prints, two tickets:
 * the Merchant Copy first, then the Guest Copy (iPad PrintManager.m
 * printReceipt:paymentDetails: 14283 and getReceiptHeader:paymentDetails: 16067).
 *
 *   sale  (iPad CREDIT)   the amount, the tip and the total are known: a one-shot
 *                         sale (Pay At Table / counter) or a bar tab being finished.
 *   auth  (iPad PREAUTH)  a hold on a normal terminal: blank Tip and Total lines
 *                         for the guest to fill in; the tip is keyed at Finalize.
 *   void  (iPad CREDITVOID) a card payment taken back: the amount prints negative,
 *                         no tip lines, no trailer. Prints whenever the processor
 *                         confirms the reversal (CheckViewController.m 29984-30010).
 *
 * Left out on purpose (Geoff 2026-11-10): every signature line and agreement
 * text, Cardholder's Name, processor-specific lines (host response, FreedomPay
 * bundle…) and the Square tip grid. The card lines (Account / APN / AID / TVR /
 * TSI / Cryptogram / ENTRY) come from the processor driver as ready text.
 *
 * Whether a slip prints at all is shouldPrintCardSlip (iPad CheckViewController.m
 * 7517-7541): the tender's threshold and the store's print-on-demand setting.
 */

import { PrintDoc } from "@/platform/escpos";
import { replaceTokens, type TokenCtx } from "./printjobs";

export type SlipKind = "sale" | "auth" | "void";
export type SlipCopy = "merchant" | "guest";

export interface CardSlipCtx {
  store: { identification: string; address1: string; address2: string; city: string };
  server: string;            // the signed-in employee's name ("Furio Corso" prints as "Furio C")
  time: string;              // short time, e.g. "1:08 PM"
  date: string;              // MM/dd/yyyy
  checkNo: string;
  tabName: string;           // Check_Name ("" when none)
  kind: SlipKind;
  cardType: string;          // brand / tender name as recorded (VISA, INTERAC…)
  last4: string;
  amount: number;            // the payment (base) amount
  tip: number;               // sale only
  authCode: string;
  cardLines: string[];       // processor card lines, already labelled
  /** Guest copy only: the check wrapper's trailer lines, when the revenue center prints the trailer on
   *  payment receipts (Revenue_Center backup3). Tokens resolve against the payment amount on a hold and
   *  print "-" on a sale, as the iPad does. */
  trailerLines?: string[];
  tokens?: Pick<TokenCtx, "firstName" | "lastName" | "tabName">;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** "Furio Corso" → "Furio C" (firstN + first letter of lastN). */
export function slipServerName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  return `${parts[0]} ${parts[parts.length - 1][0]}`;
}

/** One trailer line with its tokens resolved the way the iPad does on a payment receipt. */
function trailerLine(raw: string, ctx: CardSlipCtx): string {
  const names = { firstName: ctx.tokens?.firstName ?? "", lastName: ctx.tokens?.lastName ?? "", tabName: ctx.tokens?.tabName ?? ctx.tabName };
  if (ctx.kind === "sale") return replaceTokens(raw.replace(/\{(SUBT|TOTAL)\*[\d.]+%?\}/g, "-"), { ...names, subtotal: 0, grandTotal: 0 });
  return replaceTokens(raw, { ...names, subtotal: ctx.amount, grandTotal: ctx.amount });
}

/** One copy of the slip as an ESC/POS job. */
export function buildCardSlip(ctx: CardSlipCtx, copy: SlipCopy, cpl = 40): string {
  const d = new PrintDoc(cpl);
  for (const s of [ctx.store.identification, ctx.store.address1, ctx.store.address2, ctx.store.city]) if (s) d.centered(s);
  d.line("");
  d.sep("_");
  d.centered("Transaction Record");
  d.two(`Server Name: ${slipServerName(ctx.server)} ${ctx.time}`.trimEnd(), ctx.date);
  d.line(`Check #:${ctx.checkNo}  ${ctx.tabName}`.trimEnd());
  d.bold(ctx.kind === "sale" ? "CreditSale" : ctx.kind === "auth" ? "CreditPreAuth" : "CreditVoidSale");
  d.line("");
  d.line(ctx.kind === "void" ? "CREDITVOID" : "PURCHASE");
  d.line("");
  d.line(ctx.cardType);
  d.line(`Card#:${ctx.last4}`);
  d.feed(2);
  d.two("Amount:", ctx.kind === "void" ? `$-${Math.abs(ctx.amount).toFixed(2)}` : money(ctx.amount));
  if (ctx.kind === "void") {
    for (const l of ctx.cardLines) d.line(l);
  } else if (ctx.kind === "sale") {
    d.two("Tip   :", money(ctx.tip));
    d.two("Total :", money(round2(ctx.amount + ctx.tip)));
    d.line("");
    for (const l of ctx.cardLines) d.line(l);
  } else {
    for (const l of ctx.cardLines) d.line(l);
    d.line("");
    d.line("Tip   :_____________________");
    d.line("");
    d.line("Total :_____________________");
    d.feed(2);
  }
  d.line(`Auth#: ${ctx.authCode}`);
  d.line("");
  if (ctx.kind === "void") {
    d.feed(4);
    d.centered(copy === "merchant" ? "----- Merchant Copy -------" : "----- Guest Copy -------");
  } else if (copy === "merchant") {
    d.line("----- Merchant Copy --------");
  } else {
    const trailer = (ctx.trailerLines ?? []).map((t) => (t ?? "").trim()).filter((t) => t !== "");
    if (trailer.length) {
      d.feed(2);
      d.sep("-");
      d.line("");
      for (const t of trailer) { if (t === "|") d.line(""); else d.centered(trailerLine(t, ctx)); }
    }
    d.feed(4);
    d.centered("----- Guest Copy -------");
  }
  d.cut();
  return d.toString();
}

/** Both tickets, in print order: Merchant Copy, then Guest Copy. */
export function buildCardSlips(ctx: CardSlipCtx, cpl = 40): [string, string] {
  return [buildCardSlip(ctx, "merchant", cpl), buildCardSlip(ctx, "guest", cpl)];
}

/** Does this payment print a slip? (CheckViewController.m 7517-7541)
 *    sale: a tender with a threshold prints at or above it; with no threshold it prints unless the
 *          store prints non-cash receipts on demand only.
 *    auth: prints at or above the tender's threshold (always, when there is none).
 *    void: always. */
export function shouldPrintCardSlip(kind: SlipKind, amountPlusTip: number, threshold: number, printOnDemand: boolean): boolean {
  if (kind === "void") return true;   // a reversal always leaves a record
  if (kind === "auth") return amountPlusTip >= threshold - 0.005;
  if (threshold > 0) return amountPlusTip >= threshold - 0.005;
  return !printOnDemand;
}
