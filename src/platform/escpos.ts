/*
 * ESC/POS encoder — a print job is a JS string whose per-character low byte is
 * the byte sent to the printer (encoded latin1/CP1252 at the transport, exactly
 * like the iPad's NSWindowsCP1252 send). Control sequences mirror the iOS
 * PrintManager set (ESCPOSCore.m / AR_PrintQueueManager.m / PrintManagerHelper.m):
 *   init ESC @ · align ESC a n · size ESC ! n · full cut GS V 0 · drawer ESC p.
 */

export const ESC = "\x1b";
export const GS = "\x1d";
export const LF = "\n";

export const INIT = ESC + "@";                    // 1B 40
export const CUT = GS + "V" + "\x30";              // 1D 56 30  full cut
export const ALIGN_L = ESC + "a" + "\x00";         // 1B 61 00
export const ALIGN_C = ESC + "a" + "\x01";         // 1B 61 01
export const ALIGN_R = ESC + "a" + "\x02";         // 1B 61 02
export const SIZE_NORMAL = ESC + "!" + "\x00";     // 1B 21 00
export const SIZE_DWIDTH = ESC + "!" + "\x20";     // 1B 21 20  double width
export const SIZE_DOUBLE = ESC + "!" + "\x30";     // 1B 21 30  double width + height
export const BOLD_ON = ESC + "!" + "\x08";         // emphasis bit
export const BOLD_OFF = ESC + "!" + "\x00";
export const DRAWER_KICK = ESC + "p" + "\x30" + "\x19" + "\xfa"; // 1B 70 30 19 FA
export const RED_ON = ESC + "r" + "\x01";          // 1B 72 01  two-color red (impact ≤32col)
export const RED_OFF = ESC + "r" + "\x00";         // 1B 72 00
// ESC ! 0x21 — double-width font B, the font every kitchen/prep chit prints in
// (iOS PrintManager parseJSON; crossplatformkds codec PRINT_FONT_PREFIX). The
// printer's Chars_Per_Line is sized for this font, so lay out at cpl then prefix.
export const FONT_PREP = ESC + "!" + "\x21";       // 1B 21 21

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const padLeft = (s: string, n: number) => (s.length >= n ? s.slice(-n) : " ".repeat(n - s.length) + s);

/** Center `text` within `width` columns. */
export function center(text: string, width: number): string {
  const t = text.length > width ? text.slice(0, width) : text;
  const left = Math.max(0, Math.floor((width - t.length) / 2));
  return " ".repeat(left) + t;
}

/** A left label with a right-justified value on the same line (name … amount). */
export function twoCol(left: string, right: string, width: number): string {
  const r = right.slice(0, width);
  const l = pad(left, Math.max(0, width - r.length));
  return (l + r).slice(0, width);
}

/** Qty / name / right-aligned amount, wrapping the name across lines. */
export function itemLine(qty: string, name: string, amount: string, width: number): string {
  const qcol = pad(qty, 3);
  const acol = amount ? padLeft(amount, 8) : "";
  const nameWidth = Math.max(1, width - qcol.length - acol.length);
  const words = name.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + (cur ? " " : "") + w).length > nameWidth) { if (cur) lines.push(cur); cur = w; }
    else cur += (cur ? " " : "") + w;
  }
  if (cur) lines.push(cur);
  if (lines.length === 0) lines.push("");
  return lines
    .map((ln, i) => (i === 0 ? qcol + pad(ln, nameWidth) + acol : "   " + pad(ln, nameWidth)))
    .join(LF);
}

export const rule = (width: number, ch = "-"): string => ch.repeat(width);

/** Accumulates lines/commands into an ESC/POS job string. */
export class PrintDoc {
  // Start every job black: INIT then an explicit RED_OFF, so a two-color impact
  // printer left in red by a prior job (whose ESC @ may not reset select-color)
  // doesn't bleed red into this chit's header. Harmless on non-red printers.
  private buf = INIT + RED_OFF;
  constructor(private width = 40) {}
  raw(s: string): this { this.buf += s; return this; }
  line(s = ""): this { this.buf += s + LF; return this; }
  // Center with the printer's own ESC a 1 (it knows its true width) — do NOT also
  // pad manually, or the line gets centered twice and shifts right.
  centered(s: string): this { this.buf += ALIGN_C + s + LF + ALIGN_L; return this; }
  // Centered, in red on 2-color impact printers (≤32 col); plain black otherwise
  // (matches PrintManager printLineInRed, which no-ops above 32 chars).
  // ESC r (select color) is only honored at the START of a line, before any
  // printable data — so RED_ON goes ahead of the text and RED_OFF is placed at
  // the head of the FOLLOWING line (after the LF), not trailing this one, or the
  // color never turns back off and the rest of the chit bleeds red.
  centeredRed(s: string): this {
    if (this.width <= 32) this.buf += ALIGN_C + RED_ON + s + LF + ALIGN_L + RED_OFF;
    else this.buf += ALIGN_C + s + LF + ALIGN_L;
    return this;
  }
  // Left-aligned red line (printLineInRed on an item/modifier line); same color rule.
  lineRed(s: string): this {
    if (this.width <= 32) this.buf += RED_ON + s + LF + RED_OFF;
    else this.buf += s + LF;
    return this;
  }
  big(s: string): this { this.buf += SIZE_DOUBLE + s + SIZE_NORMAL + LF; return this; }
  bold(s: string): this { this.buf += BOLD_ON + s + BOLD_OFF + LF; return this; }
  sep(ch = "="): this { this.buf += rule(this.width, ch) + LF; return this; }
  two(left: string, right: string): this { this.buf += twoCol(left, right, this.width) + LF; return this; }
  item(qty: string, name: string, amount = ""): this { this.buf += itemLine(qty, name, amount, this.width) + LF; return this; }
  feed(n = 1): this { this.buf += LF.repeat(n); return this; }
  drawer(): this { this.buf += DRAWER_KICK; return this; }
  cut(): this { this.buf += LF.repeat(6) + CUT; return this; } // feed clear of the cutter first
  toString(): string { return this.buf; }
}
