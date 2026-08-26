/*
 * Open-check state — the current check the server is building, persisted to
 * storage on every change (offline doctrine: open checks are serialized locally
 * and flushed to the kitchen on send, never a local database). A reload or an
 * offline restart restores the in-progress check.
 */

import { useCallback, useState } from "react";
import { loadJSON, remove, saveJSON } from "@/platform/storage";
import {
  addItemLine, addModifierLine, markAllSent, mintLineKey, newCheck, removeLine, setQuantity,
  type Check,
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
  const setCheckNumber = useCallback((checkNumber: string) => mutate((c) => ({ ...c, checkNumber })), [mutate]);

  /** After a successful fire to the kitchen: mark lines sent (keep the check open). */
  const markSent = useCallback(() => mutate(markAllSent), [mutate]);

  /** Start a fresh check (e.g. after settling / clearing). */
  const reset = useCallback((rcId: string, tableName = "", guestCount = 1) => {
    const next = newCheck(rcId, tableName, guestCount); persist(next); setCheck(next);
  }, []);

  return { check, addItem, addModifier, remove: remove_, setQty, setTable, setGuests, setRevenueCenter, setCheckNumber, markSent, reset };
}
