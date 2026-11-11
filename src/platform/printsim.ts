/*
 * Printer simulator — a terminal setting (Manager Console on the keypad, off by
 * default) that shows this terminal's LOCAL receipt jobs on screen: customer
 * checks, reprints, clock chits, card slips. Kitchen orders are never shown.
 * The jobs still go to the real printer; where there is none (a browser, a
 * tablet with no printer nearby) the on-screen paper is the only output.
 *
 * The setting lives in this terminal's storage, so it survives a restart and
 * goes back to off when the terminal is re-activated (storage is wiped).
 */

import { loadStr, saveStr } from "./storage";

const ON = "printsim.on.v1";
const MAX_JOBS = 40;

export interface SimJob { id: number; printer: string; address: string; cpl: number; job: string; at: number; }
export interface SimState { on: boolean; jobs: SimJob[]; }

let state: SimState = { on: loadStr(ON) === "1", jobs: [] };
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export const simState = (): SimState => state;
export const simulatorOn = (): boolean => state.on;
export function subscribeSim(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

export function setSimulatorOn(on: boolean): void {
  saveStr(ON, on ? "1" : "");
  state = { on, jobs: on ? state.jobs : [] };
  emit();
}

/** Re-read the setting from storage (after a re-activation wiped it). */
export function reloadSimulator(): void {
  state = { on: loadStr(ON) === "1", jobs: [] };
  emit();
}

/** Put one job on the simulator's paper. Ignored while the simulator is off. */
export function pushSimJob(j: { printer: string; address: string; cpl: number; job: string }): void {
  if (!state.on || !j.job) return;
  state = { on: true, jobs: [...state.jobs, { ...j, id: ++seq, at: Date.now() }].slice(-MAX_JOBS) };
  emit();
}

export function clearSimJobs(): void {
  state = { on: state.on, jobs: [] };
  emit();
}
