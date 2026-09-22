/*
 * Print job layouts — pure builders that turn check/shift data into an ESC/POS
 * string (PrintManager.m getOrderHeaderDetails/parseMenuItem for prep chits,
 * getCheckWrapperHeader/getCurrentCheckInfo/getCheckWrapperTrailer for the
 * customer check, printTimeCard for the clock chit). No I/O — the transport
 * sends the returned string; this keeps the layouts unit-testable.
 */

import { FONT_PREP, PrintDoc } from "@/platform/escpos";

const money = (n: number) => `$${n.toFixed(2)}`;

export interface PrepItem { qty: number; name: string; mods: string[]; seat?: string; held?: boolean; }
export interface PrepCtx { checkNo: string; server: string; guests: number; rcName: string; tabLabel: string; date: string; time: string; refire?: boolean; }

// Server line = first name + last initial (PrintManager getOrderHeaderDetails).
function serverShort(name: string): string {
  const [first = "", last = ""] = name.trim().split(/\s+/);
  return (last ? `${first} ${last[0]}` : first).slice(0, 10);
}

/** Kitchen/prep chit — one printer's items, no prices (PrintManager printCurrentOrder /
 *  getOrderHeaderDetails / getOrderTail). RVC + tab print red on impact printers. */
export function buildPrepChit(printerName: string, ctx: PrepCtx, items: PrepItem[], cpl = 40): string {
  // Order-chit width (PrintManager.m:5231-5246): base 42 unless the printer's
  // Chars_Per_Line is a non-standard value; then, because the chit prints in
  // double-wide font (printDW), the usable width is halved (31 → 20).
  const base = cpl === 40 || cpl === 31 || cpl === 32 ? 42 : cpl;
  const width = cpl === 31 ? 20 : Math.floor(base / 2);
  const d = new PrintDoc(width);
  d.raw(FONT_PREP);                 // whole chit in double-wide font B, like the iPad/KDS
  if (ctx.refire) d.centeredRed("Refire");   // printRefireOrder: red centered line ahead of the normal chit
  if (printerName) d.centered(printerName);
  d.centered(`CHECKNUM: ${ctx.checkNo || "-"}`);
  d.two(serverShort(ctx.server), `Gst:${ctx.guests}`);
  d.sep("=");
  d.centeredRed(ctx.rcName);
  if (ctx.tabLabel) d.centeredRed(ctx.tabLabel);
  d.sep("=");
  for (const it of items) {
    if (it.held) continue; // held items are withheld from the kitchen
    // includeSeat printers append the seat (S1 / T) to the item name (PrintManager.m:13116-13124).
    d.item(String(it.qty), it.seat ? `${it.name}  ${it.seat}` : it.name);
    for (const m of it.mods) d.line(`   - ${m}`);
  }
  d.sep("=");
  d.two(ctx.date, ctx.time);
  d.feed(2);          // extra clearance before the cut
  d.cut();
  return d.toString();
}

export interface CheckLineOut { qty: number; name: string; amount: number; indent: number; isMod: boolean; }
export interface CheckCtx {
  headerLines: string[]; trailerLines: string[];
  checkNo: string; server: string; guests: number; date: string; tableLabel?: string; reprint?: boolean;
  largeTotal?: boolean;   // printer.printLargeTotal — double-size TOTAL line
  tokens: TokenCtx;       // values for {SUBT*NN%}/{TOTAL*NN%}/{CHK_*}/{TABNAME}
}
export interface CheckTaxOut { name: string; amount: number; }
export interface CheckTenderOut { name: string; amount: number; }

/** Values behind check-wrapper tokens (PrintManager parseCheckTrailerToken). */
export interface TokenCtx { firstName: string; lastName: string; tabName: string; subtotal: number; grandTotal: number; }

function tokenValue(tok: string, t: TokenCtx): string {
  switch (tok) {
    case "CHK_FIRST_NAME": case "TRN_FIRST_NAME": return t.firstName;
    case "CHK_LAST_NAME": case "TRN_LAST_NAME": return t.lastName;
    case "TABNAME": return t.tabName;
    case "CHECKBOX": return ""; // signature checkbox — handled at print time on iOS
  }
  let m = tok.match(/^SUBT\*([\d.]+)%?$/); // suggested tip on subtotal; "x Total: $y"
  if (m) { const sug = t.subtotal * parseFloat(m[1]) / 100; return `${sug.toFixed(2)} Total: $${(t.grandTotal + sug).toFixed(2)}`; }
  m = tok.match(/^TOTAL\*([\d.]+)%?$/); // suggested tip on grand total
  if (m) { const sug = t.grandTotal * parseFloat(m[1]) / 100; return `${sug.toFixed(2)} Total: $${(t.grandTotal + sug).toFixed(2)}`; }
  return "";
}

/** Replace {…} tokens in a wrapper line (parseCheckTrailerToken/loopThroughTrailertokens). */
function replaceTokens(line: string, t: TokenCtx): string {
  if (!line.includes("{")) return line;
  return line.split(/[{}]/).map((seg, i) => (i % 2 === 0 ? seg : tokenValue(seg, t))).join("");
}

/** Customer check / guest receipt (PrintManager getCheckText). */
export function buildCustomerCheck(
  ctx: CheckCtx, lines: CheckLineOut[], subtotal: number, taxGroups: CheckTaxOut[], total: number,
  tenders: CheckTenderOut[], balance: number, cpl = 40,
): string {
  const d = new PrintDoc(cpl);
  // Wrapper lines: a line of only "|" is a blank spacer; an empty line is ignored;
  // otherwise tokens are resolved and the line is centered (getCheckWrapperHeader/Trailer).
  const emitWrap = (wrapLines: string[]) => {
    for (const raw of wrapLines) {
      const s = (raw ?? "").trim();
      if (s === "") continue;
      if (s === "|") { d.line(""); continue; }
      d.centered(replaceTokens(s, ctx.tokens));
    }
  };
  emitWrap(ctx.headerLines);
  d.feed();
  if (ctx.reprint) d.centered("*** REPRINTED ***");
  if (ctx.tableLabel) d.line(ctx.tableLabel);
  d.line(`CHK: ${ctx.checkNo}    Gst: ${ctx.guests}`);
  d.line(ctx.server);
  d.line(ctx.date);
  d.sep();
  for (const l of lines) {
    if (l.isMod) d.line(`   ${l.name}`);
    else d.item(l.qty > 1 ? `${l.qty}` : "1", l.name, money(l.amount));
  }
  d.sep("-");
  d.two("Subtotal", money(subtotal));
  for (const t of taxGroups) if (t.amount) d.two(t.name, money(t.amount));
  if (ctx.largeTotal) d.big(twoBig("TOTAL", money(total), cpl)); else d.two("Total", money(total));
  for (const t of tenders) d.two(t.name, money(t.amount));
  if (balance > 0.005) d.two("Balance Due", money(balance));
  d.feed();
  emitWrap(ctx.trailerLines);
  d.cut();
  return d.toString();
}

// TOTAL line in double size still needs manual column fit at half the width.
function twoBig(left: string, right: string, cpl: number): string {
  const w = Math.floor(cpl / 2);
  const r = right.slice(0, w);
  const l = left.slice(0, Math.max(0, w - r.length));
  return l + " ".repeat(Math.max(1, w - l.length - r.length)) + r;
}

export interface ClockCtx {
  storeName: string; empName: string; action: "IN" | "OUT"; jobName: string; time: string; rate?: number;
  hoursWorked?: string; earned?: number; tipsDeclared?: number;
}

/** Clock-in / clock-out chit (PrintManager printTimeCard). */
export function buildClockChit(ctx: ClockCtx, cpl = 40): string {
  const d = new PrintDoc(cpl);
  d.centered(ctx.storeName);
  d.feed();
  d.big(ctx.action === "IN" ? "CLOCK IN" : "CLOCK OUT");
  d.sep();
  d.line(ctx.empName);
  if (ctx.jobName) d.line(`Job: ${ctx.jobName}`);
  d.two(ctx.action === "IN" ? "Clock In" : "Clock Out", ctx.time);
  if (ctx.rate !== undefined) d.two("Rate", money(ctx.rate) + "/hr");
  if (ctx.hoursWorked) d.two("Hours", ctx.hoursWorked);
  if (ctx.earned !== undefined) d.two("Earned", money(ctx.earned));
  if (ctx.tipsDeclared !== undefined) d.two("Tips Declared", money(ctx.tipsDeclared));
  d.cut();
  return d.toString();
}
