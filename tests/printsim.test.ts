// @vitest-environment jsdom
/*
 * Printer simulator: the paper renderer (platform/escpos renderPaper), the
 * on/off setting and job store (platform/printsim), and printReceipt routing
 * local receipt jobs to the simulator as well as the printer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAWER_KICK, PrintDoc, renderPaper } from "@/platform/escpos";
import { clearSimJobs, pushSimJob, reloadSimulator, setSimulatorOn, simState, simulatorOn, subscribeSim } from "@/platform/printsim";
import { printReceipt, printTo } from "@/platform/print";
import type { Printer } from "@/model/printers";

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); },
  } as Storage;
}
beforeEach(() => { vi.stubGlobal("localStorage", memStorage()); reloadSimulator(); });
afterEach(() => { vi.unstubAllGlobals(); });

const text = (job: string) => renderPaper(job).map((l) => (l.kind === "text" ? l.segs.map((s) => s.text).join("") : `<${l.kind}>`));
const printer = (over: Partial<Printer> = {}): Printer => ({
  id: "9", name: "Bar Check", address: "", port: 9100, backupId: "", isKDS: false, isHttpServer: false, charsPerLine: 40, cutPaper: true,
  hasCashDrawer: false, printLargeTotal: false, includeSeat: false, useCourse: false, courseNames: [], printCourseRed: false, holdUnfiredCourses: false, ...over,
});

describe("renderPaper", () => {
  it("lays a job out as lines with alignment, bold and size, and marks the cut", () => {
    const job = new PrintDoc(40).centered("Stream Test Store").bold("Check 280011").big("TOTAL $14.30").two("Americano", "$10.00").cut().toString();
    const lines = renderPaper(job);
    expect(lines[0]).toMatchObject({ kind: "text", align: "center" });
    expect(lines[1]).toMatchObject({ kind: "text", align: "left", segs: [{ text: "Check 280011", bold: true, wide: false }] });
    expect(lines[2]).toMatchObject({ kind: "text", segs: [{ text: "TOTAL $14.30", wide: true, tall: true }] });
    expect(text(job)).toEqual(["Stream Test Store", "Check 280011", "TOTAL $14.30", "Americano" + " ".repeat(25) + "$10.00", "<cut>"]);
  });
  it("drops the feed lines before a cut but keeps blank lines inside the ticket", () => {
    expect(text(new PrintDoc(32).line("a").feed(2).line("b").cut().toString())).toEqual(["a", "", "", "b", "<cut>"]);
  });
  it("two jobs back to back are two cut tickets", () => {
    const one = new PrintDoc(32).line("Merchant Copy").cut().toString();
    const two = new PrintDoc(32).line("Guest Copy").cut().toString();
    expect(text(one + two)).toEqual(["Merchant Copy", "<cut>", "Guest Copy", "<cut>"]);
  });
  it("shows a cash drawer kick, and red on a two-colour printer", () => {
    expect(text(new PrintDoc(40).line("Paid").toString() + DRAWER_KICK)).toEqual(["Paid", "<drawer>"]);
    const red = renderPaper(new PrintDoc(32).lineRed("ALLERGY").line("plain").toString());
    expect(red[0]).toMatchObject({ segs: [{ text: "ALLERGY", red: true }] });
    expect(red[1]).toMatchObject({ segs: [{ text: "plain", red: false }] });
  });
  it("skips commands it does not know and never throws on a cut-off job", () => {
    expect(text("ok\x1bZ\nnext\x1b")).toEqual(["ok", "next"]);
    expect(text("\x1d")).toEqual([]);
  });
});

describe("simulator setting and roll", () => {
  it("is off by default, remembers being turned on, and forgets when storage is wiped", () => {
    expect(simulatorOn()).toBe(false);
    setSimulatorOn(true);
    reloadSimulator(); expect(simulatorOn()).toBe(true);          // survives a restart
    localStorage.clear(); reloadSimulator(); expect(simulatorOn()).toBe(false);   // a re-activation wipes it
  });
  it("takes jobs only while on, tells subscribers, and Clear empties the roll", () => {
    const seen = vi.fn(); const off = subscribeSim(seen);
    pushSimJob({ printer: "P", address: "", cpl: 40, job: "x" });
    expect(simState().jobs).toHaveLength(0);
    setSimulatorOn(true);
    pushSimJob({ printer: "P", address: "10.0.0.5", cpl: 40, job: "x" });
    expect(simState().jobs).toHaveLength(1); expect(simState().jobs[0]).toMatchObject({ printer: "P", address: "10.0.0.5" });
    clearSimJobs(); expect(simState().jobs).toHaveLength(0);
    expect(seen.mock.calls.length).toBeGreaterThanOrEqual(3);
    off();
  });
  it("turning it off empties the roll", () => {
    setSimulatorOn(true); pushSimJob({ printer: "P", address: "", cpl: 40, job: "x" });
    setSimulatorOn(false); expect(simState().jobs).toHaveLength(0);
  });
});

describe("printReceipt", () => {
  it("shows a local receipt job on the simulator when it is on; printTo (kitchen orders) never does", async () => {
    setSimulatorOn(true);
    await printReceipt(printer(), "receipt");
    await printTo(printer({ name: "Kitchen" }), "order chit");
    expect(simState().jobs.map((j) => j.printer)).toEqual(["Bar Check"]);
  });
  it("does nothing extra while the simulator is off", async () => {
    await printReceipt(printer(), "receipt");
    expect(simState().jobs).toHaveLength(0);
  });
});
