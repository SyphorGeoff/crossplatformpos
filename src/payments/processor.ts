/*
 * The card-processor seam — the one interface every online card processor
 * (Stripe, TSYS, the dev mock) implements, and the only thing the UI imports.
 * PaymentView / FinalizeView / the void path call these methods and never a
 * processor module directly; `select.ts` picks the module from the definitions.
 *
 * Every call carries the check identity (store, business date, check number,
 * check_key, the tender line's lineitemkey) so a processor or a payment service
 * can tie its transaction to the Aireus check and make retries idempotent.
 * The POS never holds a card number: every card is presented on, or keyed into,
 * the payment device (Geoff 2026-11-06: "we can no longer handle a card number
 * under ANY circumstances or any card driver").
 * Every call returns one CardResult; a `pending` result means the processor
 * (or its device) is still working — the UI polls `status(ref)` until the
 * result settles or the Store CC_Timeout deadline passes, and may `cancel`.
 *
 * Amounts are dollars (two decimals) throughout; processors convert.
 */

export type ProcessorName = "stripe" | "tsys" | "mock";

export type CardBrand = "VISA" | "MASTERCARD" | "AMEX" | "DISCOVER" | "JCB" | "DINERS" | "UNIONPAY" | "OTHER";

/** Where a transaction belongs on the Aireus side. */
export interface CheckRef {
  storeId: string;
  businessDateId: string;
  checkNo: string;
  checkKey: string;
  tenderKey: string;        // the Type="T" line's lineitemkey (idempotency per tender line)
  terminalPosId: string;
  employeePosId: string;
  revenueCenterId?: string;
}

export interface CardRequest extends CheckRef {
  amount: number;           // the base amount to authorize / charge
  tip?: number;             // tip known at payment time (one-shot sale with the tip prompt first)
  tenderId: string;         // Tender_POS_ID the server picked
  readerId?: string;        // Terminal TyroTerminalID — the device to drive, when there is one
  token?: string;           // a card token from an earlier tokenize/auth (bar tabs: charge the stored card)
  promptTip?: boolean;      // let the device prompt for a tip (pay-at-table sale)
  deviceKeyedEntry?: boolean; // tender flag use_third_party_keyed_entry: ask the DEVICE to allow manual entry; a processor without such a switch ignores it
  captureSignature?: boolean; // the tender wants a signature; a device may collect it itself
  timeoutSec: number;       // how long the UI will wait (Store CC_Timeout or the tender's WaitTime)
}

export interface CardAmounts { amount: number; tip: number; }

export type CardStatus = "ok" | "declined" | "pending" | "error" | "cancelled";

export interface CardResult {
  status: CardStatus;
  message: string;          // human text for the sheet (decline reason, error, "Approved")
  ref?: string;             // the processor's transaction id — RefNo on the wire
  recordNo?: string;        // a second id when the processor has one (RecordNo); else the same as ref
  authCode?: string;
  last4?: string;
  brand?: CardBrand;
  authorizedAmount?: number; // a partial approval is less than asked
  capturedAmount?: number;
  tip?: number;
  token?: string;           // card-on-file token when the processor returned one
  signatureCaptured?: boolean; // the device collected the signature itself
  receipt?: { customer?: string; merchant?: string }; // processor-rendered receipt text (EMV lines), when provided
}

export interface CardProcessor {
  readonly name: ProcessorName;
  /** Pre-authorize: hold the amount, capture later with the tip (table service). */
  authorize(req: CardRequest): Promise<CardResult>;
  /** Sale: authorize and capture in one step (counter, pay-at-table). */
  sale(req: CardRequest): Promise<CardResult>;
  /** Capture an earlier authorization for base + tip (finalize). */
  capture(ref: string, amounts: CardAmounts, ctx: CheckRef): Promise<CardResult>;
  /** Change the amount and/or tip of a transaction after capture (tip adjust, shrink/grow a sale). */
  adjust(ref: string, amounts: CardAmounts, ctx: CheckRef): Promise<CardResult>;
  /** Raise an open authorization to a new total (bar tabs; an item added after the auth). */
  increment(ref: string, newAmount: number, ctx: CheckRef): Promise<CardResult>;
  /** Cancel before settlement — an uncaptured auth, or a same-day sale. `amount` = partial void. */
  cancel(ref: string, ctx: CheckRef, amount?: number): Promise<CardResult>;
  /** Return money after settlement. */
  refund(ref: string, amount: number, ctx: CheckRef): Promise<CardResult>;
  /** Current state of a transaction (poll while `pending`; recover after a timeout). */
  status(ref: string, ctx: CheckRef): Promise<CardResult>;
  /** Attach a POS-pad signature (PNG data URL) to a transaction. Optional: a device may do it itself. */
  attachSignature?(ref: string, pngDataUrl: string, ctx: CheckRef): Promise<CardResult>;
  /** Store the card for later charges (bar tabs) without moving money. Optional. */
  tokenize?(req: CardRequest): Promise<CardResult>;
}

/** Shorthand results. */
export const declined = (message: string, extra: Partial<CardResult> = {}): CardResult => ({ status: "declined", message, ...extra });
export const failed = (message: string, extra: Partial<CardResult> = {}): CardResult => ({ status: "error", message, ...extra });

/** Map a processor's brand string to the iCat_Code vocabulary the Tender definitions use. */
export function brandFromText(v: string | undefined): CardBrand | undefined {
  const t = (v ?? "").trim().toUpperCase();
  if (!t) return undefined;
  if (/^(V|VISA)$/.test(t)) return "VISA";
  if (/^(M|MC|MASTERCARD|MASTER CARD)$/.test(t)) return "MASTERCARD";
  if (/^(X|AX|AMEX|AMERICAN EXPRESS)$/.test(t)) return "AMEX";
  if (/^(R|DS|DISC|DISCOVER)$/.test(t)) return "DISCOVER";
  if (/^(J|JCB)$/.test(t)) return "JCB";
  if (/^(D|DC|DINERS|DINERS CLUB)$/.test(t)) return "DINERS";
  if (/^(U|UP|UNIONPAY|CUP)$/.test(t)) return "UNIONPAY";
  return "OTHER";
}
