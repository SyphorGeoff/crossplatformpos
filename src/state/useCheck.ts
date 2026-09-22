/*
 * Open-check state — the current check the server is building, persisted to
 * storage on every change (offline doctrine: open checks are serialized locally
 * and flushed to the kitchen on send, never a local database). A reload or an
 * offline restart restores the in-progress check.
 */

import { useCallback, useState } from "react";
import { loadJSON, saveJSON } from "@/platform/storage";
import {
  addAdjustmentLine, addItemLine, addModifierLine, addTender, guestAssignment, holdUnholdLines, markRoundSent, mintLineKey,
  newCheck, removeLine, removeTender, reorderLines, setLineGuest, setLinePrice, setQuantity, splitItemAmongGuests, voidLine, type Check, type TenderLine,
} from "@/model/check";
import { mintCheckNumber } from "./checkcounter";
import type { MenuItem } from "@/model/catalog";

const KEY = "check.open.v1";

// A check is always persisted (including its number) so its number survives a
// reload — check numbers are never re-minted for an existing open check.
function persist(check: Check): void { saveJSON(KEY, check); }

export function useCheck(defaultRcId: string, terminalPosId: string) {
  // A brand-new check ALWAYS carries a number, minted at creation (newCheckNumber).
  const fresh = (rcId: string, tableName = "", guestCount = 1, diningTableId?: string): Check => {
    const c = newCheck(rcId, tableName, guestCount, diningTableId);
    c.checkNumber = mintCheckNumber(terminalPosId);
    return c;
  };
  const [check, setCheck] = useState<Check>(() => loadJSON<Check | null>(KEY, null) ?? fresh(defaultRcId));

  // The currently-selected guest (0-based; 0 = guest 1, -1 = "T" whole table) —
  // the single source of truth for where new items land (currentGuestIndex).
  const [currentGuest, setCurrentGuest] = useState(0);

  const mutate = useCallback((fn: (c: Check) => Check) => {
    setCheck((prev) => { const next = fn(prev); persist(next); return next; });
  }, []);

  /** Add a menu item. `guest` is the assignment captured when the tile was TAPPED
   *  (a modifier flow may be open in between — the seat never changes mid-flow);
   *  defaults to the currently selected guest. */
  const addItem = useCallback((item: MenuItem, guest?: { guestNumber: number; appliedToGuests?: string }) => {
    const key = mintLineKey();
    const { guestNumber, appliedToGuests } = guest ?? guestAssignment(currentGuest);
    mutate((c) => addItemLine(c, item, key, guestNumber, appliedToGuests));
    return key; // caller uses this to attach modifiers
  }, [mutate, currentGuest]);
  const splitAmong = useCallback((keys: Set<string>, guests: number[], authEmpId?: string) =>
    mutate((c) => splitItemAmongGuests(c, keys, guests, authEmpId)), [mutate]);

  const setGuestFor = useCallback((keys: Set<string>, guestNumber: number) =>
    mutate((c) => setLineGuest(c, keys, guestNumber)), [mutate]);

  const addModifier = useCallback((parentKey: string, item: MenuItem, amount: number, indent = 1) =>
    mutate((c) => addModifierLine(c, parentKey, item, amount, indent)), [mutate]);

  const remove_ = useCallback((key: string) => mutate((c) => removeLine(c, key)), [mutate]);
  const setQty = useCallback((key: string, qty: number) => mutate((c) => setQuantity(c, key, qty)), [mutate]);
  const setPrice = useCallback((key: string, amount: number) => mutate((c) => setLinePrice(c, key, amount)), [mutate]);
  const reorder = useCallback((keys: Set<string>) => mutate((c) => reorderLines(c, keys)), [mutate]);
  const holdUnhold = useCallback((keys: Set<string>) => mutate((c) => holdUnholdLines(c, keys)), [mutate]);

  const setTable = useCallback((tableName: string) => mutate((c) => ({ ...c, tableName })), [mutate]);
  const setGuests = useCallback((guestCount: number) => mutate((c) => ({ ...c, guestCount: Math.max(1, guestCount) })), [mutate]);
  const setRevenueCenter = useCallback((revenueCenterId: string) => mutate((c) => ({ ...c, revenueCenterId })), [mutate]);
  const setDiningTable = useCallback((diningTableId: string, tableName: string) => mutate((c) => ({ ...c, diningTableId, tableName })), [mutate]);
  const setCheckNumber = useCallback((checkNumber: string) => mutate((c) => ({ ...c, checkNumber })), [mutate]);

  const applyTender = useCallback((t: Omit<TenderLine, "key">) => mutate((c) => addTender(c, t)), [mutate]);
  const voidTender = useCallback((key: string) => mutate((c) => removeTender(c, key)), [mutate]);
  const applyAdjustment = useCallback((a: Parameters<typeof addAdjustmentLine>[1]) =>
    mutate((c) => addAdjustmentLine(c, a)), [mutate]);
  /** Apply an arbitrary pure reducer (discount-by-item, auto gratuity…) and persist. */
  const update = useCallback((fn: (c: Check) => Check) => mutate(fn), [mutate]);
  const voidItem = useCallback((key: string, voidPosId: string, authEmpId: string) =>
    mutate((c) => voidLine(c, key, voidPosId, authEmpId)), [mutate]);

  /** After a successful POST: mark the round (items + tenders) sent, advance the
   *  tray counter, and optionally flag the check closed (settled). */
  const markSent = useCallback((closed = false) => mutate((c) => markRoundSent(c, closed)), [mutate]);

  /** Start a fresh check (e.g. after settling / clearing), optionally table-bound.
   *  Persist inside the updater so this clear is ordered *after* any pending
   *  markSent persist (whose updater also writes storage) — otherwise a
   *  post-then-reset (e.g. sign-out) could let the sent check be re-saved and
   *  then reappear on the next load. */
  const reset = useCallback((rcId: string, tableName = "", guestCount = 1, diningTableId?: string) => {
    setCheck(() => { const next = fresh(rcId, tableName, guestCount, diningTableId); persist(next); return next; });
    setCurrentGuest(0); // new check → back to guest 1
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Replace the current check with one pulled from the server (resume a table). */
  const loadCheck = useCallback((c: Check) => { persist(c); setCheck(c); setCurrentGuest(0); }, []);

  return { check, currentGuest, setCurrentGuest, addItem, addModifier, remove: remove_, setQty, setPrice, reorder, holdUnhold, setGuestFor, splitAmong, setTable, setGuests, setRevenueCenter, setDiningTable, setCheckNumber, applyTender, voidTender, applyAdjustment, update, voidItem, markSent, reset, loadCheck };
}
