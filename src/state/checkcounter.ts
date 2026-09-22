/*
 * Check-number counter — faithful to FinancialCheckManager newCheckNumber /
 * resetCheckCounter. A check ALWAYS has a number, minted at creation (never lazily
 * on send). The counter is the last-used number, persisted locally and caught up
 * to the server's highest check for the business date so terminals don't collide.
 * First check ever on a terminal is `<Terminal_POS_ID>0001` (e.g. 200001).
 */

import { loadJSON, saveJSON } from "@/platform/storage";

const KEY = "check.counter.v1";
let counter: number | null = null;

function load(): number {
  if (counter === null) counter = loadJSON<number>(KEY, 0);
  return counter;
}
function store(n: number): void { counter = n; saveJSON(KEY, n); }

/** Catch the counter up to the server's highest existing check (resetCheckCounter).
 *  `serverHighest` is the highest check number the server has for this business
 *  date/terminal (0 if none). */
export function syncCheckCounter(serverHighest: number): void {
  if (serverHighest > load()) store(serverHighest);
}

/** Mint the next check number (newCheckNumber) — synchronous, gapless. */
export function mintCheckNumber(terminalPosId: string): string {
  const c = load();
  const next = c === 0 ? Number(`${terminalPosId}0001`) : c + 1;
  store(next);
  return String(next);
}
