/*
 * Number pad entry state. Digits type right-to-left like a register. A prefilled
 * pad (the card amount pad opens on the balance) shows its starting value until
 * the first digit, which replaces it; backspace edits the starting value instead.
 */

export interface PadState { digits: string; fresh: boolean; }

const clean = (d: string) => d.replace(/\D/g, "").replace(/^0+/, "").slice(0, 9);

/** Starting state. `prefill` = the first digit typed replaces `initial`. */
export function padStart(initial: string, prefill: boolean): PadState {
  const digits = clean(initial);
  return { digits, fresh: prefill && digits !== "" };
}

/** One key: a digit "0".."9" or "⌫". */
export function padKey(s: PadState, k: string): PadState {
  if (k === "⌫") return { digits: s.digits.slice(0, -1), fresh: false };
  if (!/^\d$/.test(k)) return s;
  return { digits: clean((s.fresh ? "" : s.digits) + k), fresh: false };
}
