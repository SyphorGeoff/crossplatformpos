/*
 * Printer definitions + routing — faithful to PrintManager.m's selection rules.
 *   check / receipt / reprint / clock chit → the terminal's Chk_Printer_POS_ID.
 *   prep (kitchen) chits → each menu item's print group(s) resolved through
 *     Printer_Print_Group → Printer, gated by Terminal_Print_Group (if this
 *     terminal is assigned any) and RevenueCenter_Print_Group (if the RVC uses
 *     it) and the print group's active window. One printer serving several
 *     groups gets ONE merged chit (de-dup).
 * Cloud/HTTP printers (Port ∈ 80/443/8080/8443) and KDS printers are flagged so
 * the transport can route them away from the raw 9100 socket.
 */

import { loadDefRows } from "@/protocol/defsync";
import type { DefRow } from "./definitions";

/** The header text for course n on this printer (AIPrinter courseName1..10). */
export const courseName = (p: Printer, n: number): string => (p.courseNames[n - 1] || `Course ${n}`);

const s = (r: DefRow, k: string): string => { const v = r[k]; return v == null ? "" : String(Array.isArray(v) ? v[0] ?? "" : v); };
const alive = (r: DefRow): boolean => s(r, "Mark_Deleted") !== "1";
const HTTP_PORTS = new Set(["80", "443", "8080", "8443"]);

export interface Printer {
  id: string;
  name: string;
  address: string;
  port: number;
  backupId: string;
  isKDS: boolean;
  isHttpServer: boolean;   // cloud/print-server (printserver.jsp) rather than raw TCP
  charsPerLine: number;
  cutPaper: boolean;
  hasCashDrawer: boolean;
  printLargeTotal: boolean;   // double-size TOTAL line on the check
  includeSeat: boolean;       // append the seat (S1 / T) to each prep-chit item
  useCourse: boolean;         // useCourse — course headers on this printer's prep chits
  courseNames: string[];      // course1..course10 (empty → "Course N")
  printCourseRed: boolean;    // printCourseRed — course headers in red
  holdUnfiredCourses: boolean; // NEW optional column (KDS printers): send later courses as unfired, released by Fire Course
}

function toPrinter(r: DefRow): Printer {
  const port = Number(s(r, "Port")) || 9100;
  return {
    id: s(r, "POS_ID"),
    name: s(r, "Name").trim(),
    address: s(r, "Address").trim(),
    port,
    backupId: s(r, "Backup_POS_ID"),
    isKDS: s(r, "Is_KDS") === "1",
    isHttpServer: s(r, "isHTTPServer") === "1" || s(r, "cloud_Printing") === "1" || HTTP_PORTS.has(String(port)),
    charsPerLine: Number(s(r, "Chars_Per_Line")) || 40,
    cutPaper: s(r, "Cut_Paper") === "1",
    hasCashDrawer: s(r, "Has_Cash_Drawer") === "1",
    printLargeTotal: s(r, "printLargeTotal") === "1",
    includeSeat: s(r, "includeSeat") === "1",
    useCourse: s(r, "useCourse") === "1",
    courseNames: Array.from({ length: 10 }, (_, i) => s(r, `course${i + 1}`).trim()),
    printCourseRed: s(r, "printCourseRed") === "1",
    holdUnfiredCourses: s(r, "holdUnfiredCourses") === "1",
  };
}

export function printers(): Printer[] { return loadDefRows("Printer").filter(alive).map(toPrinter); }
export function printerById(id: string): Printer | undefined { return id ? printers().find((p) => p.id === id) : undefined; }

/** The receipt/check printer for a terminal (Terminal.Chk_Printer_POS_ID). */
export function checkPrinter(terminalPosId: string): Printer | undefined {
  const term = loadDefRows("Terminal").find((t) => s(t, "POS_ID") === terminalPosId);
  return term ? printerById(s(term, "Chk_Printer_POS_ID")) : undefined;
}

/** Follow one Backup_POS_ID hop (PrintManager falls back to a backup printer). */
export function backupPrinter(p: Printer | undefined): Printer | undefined {
  return p && p.backupId ? printerById(p.backupId) : undefined;
}

function printGroupActive(pgId: string): boolean {
  const pg = loadDefRows("Print_Group").find((g) => s(g, "POS_ID") === pgId);
  if (!pg) return false;
  if (s(pg, "always_Active") === "1") return true;
  // "No Print" and inactive groups are skipped; we honor the simple is_Active flag.
  return s(pg, "is_Active") === "1" || s(pg, "active_ByDefault") === "1";
}

export interface CheckWrapper { maxWidth: number; headerLines: string[]; trailerLines: string[]; }

/** The receipt header/trailer for a revenue center (RVC.Check_Wrapper_POS_ID →
 *  Check_Wrappers). Header_Line_1..10 / Trailer_Line_1..20, blanks trimmed. */
export function checkWrapper(revenueCenterId: string): CheckWrapper {
  const rvc = loadDefRows("Revenue_Center").find((r) => s(r, "POS_ID") === revenueCenterId);
  const wid = rvc ? s(rvc, "Check_Wrapper_POS_ID") : "";
  const cw = loadDefRows("Check_Wrappers").find((r) => s(r, "POS_ID") === wid) ?? loadDefRows("Check_Wrappers")[0] ?? {};
  // Raw lines, untrimmed of blanks: the job builder applies the "|"=blank-spacer /
  // empty=ignored rule so the wrapper's spacing is preserved.
  const collect = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => s(cw, `${prefix}${i + 1}`)).map((x) => x.trimEnd());
  return {
    maxWidth: Number(s(cw, "Max_Width")) || 40,
    headerLines: collect("Header_Line_", 10),
    trailerLines: collect("Trailer_Line_", 20),
  };
}

/** Print groups this terminal is responsible for (Terminal_Print_Group). Empty
 *  table ⇒ no terminal restriction (fire every matched printer). */
function terminalGroups(terminalPosId: string): Set<string> | null {
  const rows = loadDefRows("Terminal_Print_Group").filter(alive).filter((r) => s(r, "Terminal_POS_ID") === terminalPosId);
  if (rows.length === 0) return null; // null = unrestricted
  return new Set(rows.map((r) => s(r, "Print_Group_POS_ID")));
}

/** Printer ids mapped to a print group (Printer_Print_Group). */
function printersForGroup(pgId: string): string[] {
  return loadDefRows("Printer_Print_Group").filter(alive)
    .filter((r) => s(r, "Print_Group_POS_ID") === pgId)
    .map((r) => s(r, "Printer_POS_ID"));
}

/** Resolve the set of prep printers for a set of item print groups, honoring the
 *  terminal assignment and active window. Returns distinct printers. */
export function prepPrintersForGroups(printGroupIds: string[], terminalPosId: string): Printer[] {
  const allowed = terminalGroups(terminalPosId);
  const seen = new Set<string>();
  const out: Printer[] = [];
  for (const pg of printGroupIds) {
    if (allowed && !allowed.has(pg)) continue;
    if (!printGroupActive(pg)) continue;
    for (const prId of printersForGroup(pg)) {
      if (seen.has(prId)) continue;
      const pr = printerById(prId);
      if (pr) { seen.add(prId); out.push(pr); }
    }
  }
  return out;
}
