/*
 * Open-check state — the current check the server is building, persisted to
 * storage on every change (offline doctrine: open checks are serialized locally
 * and flushed to the kitchen on send, never a local database). A reload or an
 * offline restart restores the in-progress check.
 */

import { useCallback, useState } from "react";
import { loadJSON, remove, saveJSON } from "@/platform/storage";
import {
  addAdjustmentLine, addItemLine, addModifierLine, addTender, markRoundSent, mintLineKey, newCheck, removeLine,
  removeTender, setQuantity, voidLine, type Check, type TenderLine,
} from "@/model/check";
import type { MenuItem } from "@/model/catalog";

const KEY = "check.open.v1";

function persist(check: Check | null): void {
  if (check && check.lines.length) saveJSON(KEY, check);
  else remove(KEY);
}

export function useCheck(defaultRcId: string) {
  const [check, setCheck] = useState<Check>(() => loadJSON<Check | null>(KEY, null) ?? newCheck(defaultRcId));

  const mutate = useCallback((fn: (c: Check) => Check) => {
    setCheck((prev) => { const next = fn(prev); persist(next); return next; });
  }, []);

  const addItem = useCallback((item: MenuItem, guestNumber?: number) => {
    const key = mintLineKey();
    mutate((c) => addItemLine(c, item, key, guestNumber));
    return key; // caller uses this to attach modifiers
  }, [mutate]);

  const addModifier = useCallback((parentKey: string, item: MenuItem, amount: number, indent = 1) =>
    mutate((c) => addModifierLine(c, parentKey, item, amount, indent)), [mutate]);

  const remove_ = useCallback((key: string) => mutate((c) => removeLine(c, key)), [mutate]);
  const setQty = useCallback((key: string, qty: number) => mutate((c) => setQuantity(c, key, qty)), [mutate]);

  const setTable = useCallback((tableName: string) => mutate((c) => ({ ...c, tableName })), [mutate]);
  const setGuests = useCallback((guestCount: number) => mutate((c) => ({ ...c, guestCount: Math.max(1, guestCount) })), [mutate]);
  const setRevenueCenter = useCallback((revenueCenterId: string) => mutate((c) => ({ ...c, revenueCenterId })), [mutate]);
  const setDiningTable = useCallback((diningTableId: string, tableName: string) => mutate((c) => ({ ...c, diningTableId, tableName })), [mutate]);
  const setCheckNumber = useCallback((checkNumber: string) => mutate((c) => ({ ...c, checkNumber })), [mutate]);

  const applyTender = useCallback((t: Omit<TenderLine, "key">) => mutate((c) => addTender(c, t)), [mutate]);
  const voidTender = useCallback((key: string) => mutate((c) => removeTender(c, key)), [mutate]);
  const applyAdjustment = useCallback((a: { adjustmentId: string; name: string; amount: number; taxPackId?: string; authEmpId?: string }) =>
    mutate((c) => addAdjustmentLine(c, a)), [mutate]);
  const voidItem = useCallback((key: string, voidPosId: string, authEmpId: string) =>
    mutate((c) => voidLine(c, key, voidPosId, authEmpId)), [mutate]);

  /** After a successful POST: mark the round (items + tenders) sent, advance the
   *  tray counter, and optionally flag the check closed (settled). */
  const markSent = useCallback((closed = false) => mutate((c) => markRoundSent(c, closed)), [mutate]);

  /** Start a fresh check (e.g. after settling / clearing), optionally table-bound. */
  const reset = useCallback((rcId: string, tableName = "", guestCount = 1, diningTableId?: string) => {
    const next = newCheck(rcId, tableName, guestCount, diningTableId); persist(next); setCheck(next);
  }, []);

  /** Replace the current check with one pulled from the server (resume a table). */
  const loadCheck = useCallback((c: Check) => { persist(c); setCheck(c); }, []);

  return { check, addItem, addModifier, remove: remove_, setQty, setTable, setGuests, setRevenueCenter, setDiningTable, setCheckNumber, applyTender, voidTender, applyAdjustment, voidItem, markSent, reset, loadCheck };
}
