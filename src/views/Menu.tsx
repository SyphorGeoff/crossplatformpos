/*
 * Ordering screen (M1 browse + M2 order entry). Left: the menu grid (revenue-
 * center tabs → screen groups → items). Right: the running check. Tapping an
 * item adds it; an item with a forced-modifier chain runs the modifier flow
 * first. Send fires the check's unsent lines to the kitchen as one tray
 * (protocol/order.ts), coordinating BusinessDate_ID and the check number with
 * the server exactly as the iPad does.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ISIS_VER, type Settings } from "@/state/useSettings";
import { useCheck } from "@/state/useCheck";
import { mintCheckNumber, syncCheckCounter } from "@/state/checkcounter";
import { useEmployee } from "@/state/useEmployee";
import CheckPanel from "./CheckPanel";
import ModifierFlow, { type ChosenModifier } from "./ModifierFlow";
import PaymentView from "./PaymentView";
import Floorplan from "./Floorplan";
import Login from "./Login";
import ManagerPanel from "./ManagerPanel";
import ManagerAuth from "./ManagerAuth";
import ClockInGate from "./ClockInGate";
import TopBar from "./TopBar";
import TabsView from "./TabsView";
import MessagesView, { type ComposeTarget } from "./MessagesView";
import { useMessages } from "@/state/useMessages";
import { sendMessage, type InboxMessage } from "@/protocol/messaging";
import EditCheck, { type EditCheckActions } from "./EditCheck";
import SplitCheck, { type SplitKind, type SplitPlan } from "./SplitCheck";
import NumberPad from "./NumberPad";
import ManagerMenu from "./ManagerMenu";
import { checkHtmlUrl, sendEmployeeNotice, sendTextCheck } from "@/protocol/messaging";
import { memberLookup, type Member } from "@/protocol/memberlookup";
import { backupPrinter, checkPrinter, checkWrapper, prepPrintersForGroups, printers as loadPrinters, type Printer } from "@/model/printers";
import { buildClockChit, buildCustomerCheck, buildFireChit, buildNoteChit, buildPrepChit, type CheckLineOut, type CourseOpts, type PrepCtx, type PrepItem } from "@/protocol/printjobs";
import { printTo } from "@/platform/print";
import { DRAWER_KICK } from "@/platform/escpos";
import { buildKdsOrderJson, sendKdsOrder, type KdsItem } from "@/protocol/kdsorder";
import {
  childScreenGroups, FAVORITES_GROUP_ID, favoriteItems, favoritesGroup, initialSelection, itemsInScreenGroup, loadCatalog, modifierSteps,
  rootScreenGroups, searchItems, type Catalog, type ModifierStep,
} from "@/model/menu";
import {
  adjustmentDepartments, adjustments as loadAdjustments, diningRooms, diningTables, employeeJobs, employees, isNativeGift, isNativeLoyalty, jobs,
  storeConfig, tenders as loadTenders, voidReasons,
} from "@/model/catalog";
import type { Adjustment, DiningTable, Employee, Job, MenuItem, ScreenGroup } from "@/model/catalog";
import { can, jobsForEmployee, permsForEmployee, type AuthAction, type Authorizer } from "@/model/permissions";
import { clockIn, clockOut, fetchClockedInEmp, fetchClockedInEmpIds } from "@/protocol/timeclock";
import {
  fetchHighestCheck, resolveBusinessDate, sendCheck,
  type SendContext, type SessionConfig,
} from "@/protocol/order";
import { sendPayment, type GiftType, type LoyaltyType, type PaymentContext, type PaymentResult } from "@/protocol/payment";
import { fetchOpenChecks, fetchUnfinalizedTenders, lockCheck, modifyLineItem, readCheck, unlockCheck, type OpenCheck } from "@/protocol/tables";
import { absorbSentLines, addFireCourseRecord, addTransferCheckRecord, applyAutoGratuity, changeRevenueCenter, applyItemAdjustments, applyMovePlan, checkSubtotal, effectiveCourse, firedCourses, guestAssignment, highestGuestNumber, lastLineOf, lineExtended, repeatLastOf, setLineReference, markRoundSent, mergeInto, newCheck, removeLine, setCourse, splitToNewCheck, unsentLines, voidLine, voidTenderLine, type AutoGratDef, type Check, type CheckLine } from "@/model/check";
import { computeCheckTax, grandTotal, taxGroupsForWire } from "@/model/tax";
import { adjustCount, countFor, emptyCounts, stockRefusal, withServerCounts, type ItemCounts } from "@/model/itemcounts";
import { fetchMenuItemCounters, removeMenuItemCounter, setMenuItemCounter } from "@/protocol/itemcounts";
import ItemTile from "./ItemTile";
import { loadJSON, saveJSON } from "@/platform/storage";
import { courseHue } from "./CheckPanel";

/* Muted "food" tile tones (Sr_Simulator counter palette). Index 0/blank = the
   default system tone; button_color picks a specific tone (the item>category>
   screen-group>system cascade lands here). */
const TILE_COLORS = ["#7A6A52", "#9B5E3B", "#6F5F38", "#4A4F38", "#3A323E", "#6F7559", "#857B8E", "#5B4A3A", "#4F5B52"];
const tileColor = (idx: string): string => {
  const n = Number(idx);
  return Number.isFinite(n) && n > 0 ? TILE_COLORS[n % TILE_COLORS.length] : TILE_COLORS[0];
};
const money = (price: string, askForPrice: boolean): string => {
  if (askForPrice) return "open";
  const n = Number(price);
  return !price || !Number.isFinite(n) ? "" : `$${n.toFixed(2)}`;
};

export default function Menu({ settings, defsVersion, refreshDefinitions, onChangeStation }: {
  settings: Settings;
  /** Bumped by App whenever a definitions pull changed a table: the catalog is rebuilt from the cache. */
  defsVersion: number;
  /** Revision-based definitions pull (App). Returns the names of the tables that changed. */
  refreshDefinitions: (force?: boolean) => Promise<string[]>;
  onChangeStation: () => void;
}) {
  const cat = useMemo<Catalog>(() => loadCatalog(), [defsVersion]);
  const init = useMemo(() => initialSelection(cat, settings.terminalPosId), [cat, settings.terminalPosId]);
  const { employee, clock, signIn, signOut, setClock, clockOut: endShift } = useEmployee();

  const [rcId, setRcId] = useState<string>(init.rcId);
  const [stack, setStack] = useState<ScreenGroup[]>(() => (init.screenGroup ? [init.screenGroup] : []));
  const [query, setQuery] = useState("");
  /** Everything a long-press pill can decide about a ring, carried through the
   *  modifier / open-price flows so it lands on the line that finally gets placed. */
  type RingOpts = { course?: number; guestIdx?: number; qty?: number; held?: boolean; after?: (key: string) => void; skipPairing?: boolean };
  const [pending, setPending] = useState<{ item: MenuItem; steps: ModifierStep[]; guest: { guestNumber: number; appliedToGuests?: string }; price?: number; opts: RingOpts } | null>(null);
  // Open-price prompt (ASK_FOR_PRICE) and cover-count pad (table open) — NumberPad targets
  const [pricePrompt, setPricePrompt] = useState<{ item: MenuItem; steps: ModifierStep[]; guest: { guestNumber: number; appliedToGuests?: string }; opts: RingOpts } | null>(null);
  const [overridePad, setOverridePad] = useState<{ key: string; name: string; amount: number } | null>(null); // manager "Override price" pill
  const [notePad, setNotePad] = useState<{ key: string; name: string; chips: string[]; text: string } | null>(null); // "Allergen note" pill
  const [kitchenNote, setKitchenNote] = useState<{ key: string; name: string; text: string } | null>(null); // long-press on a SENT line → note to its stations (F5)
  const [fireNowKey, setFireNowKey] = useState<string | null>(null); // "Fire now" pill: fires once the rung line is in state
  // Pairs Well With (MenuItem_Affinity_POS_ID): iOS asks before ringing — Order / Description / Skip
  const [pairing, setPairing] = useState<{ mi: MenuItem; paired: MenuItem; opts: RingOpts; showDesc: boolean } | null>(null);
  // Pin to favorites: this employee's pinned items (per device), on top of the Top16 set
  const pinsKey = `pos.favpins.${employee?.id ?? ""}`;
  const [pins, setPins] = useState<Set<string>>(() => new Set(loadJSON<string[]>(pinsKey, [])));
  useEffect(() => { setPins(new Set(loadJSON<string[]>(pinsKey, []))); }, [pinsKey]);
  const togglePin = (id: string) => setPins((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); saveJSON(pinsKey, [...next]); return next; });
  const [coverPrompt, setCoverPrompt] = useState<DiningTable | null>(null);
  // Tab-name prompt gating send / pay / print (payingCheck / sendCheck / print paths)
  const [tabNamePrompt, setTabNamePrompt] = useState<{ after: () => void } | null>(null);
  const [tabNameDraft, setTabNameDraft] = useState("");
  // Split Item: pick the guests to divide the selection among (GuestSelection SPLIT_GUESTS)
  const [splitGuests, setSplitGuests] = useState<Set<number> | null>(null);
  // Change Guest: the selection captured when the pad opened (guest pad, not window.prompt)
  const [guestPick, setGuestPick] = useState<Set<string> | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [bdid, setBdid] = useState("");
  const [showPay, setShowPay] = useState(false);
  const [mode, setMode] = useState<"floor" | "order" | "tabs" | "manager" | "messages">("order");
  const [modeBeforeMessages, setModeBeforeMessages] = useState<"floor" | "order" | "tabs" | "manager">("order");
  const [toast, setToast] = useState<InboxMessage | null>(null); // the iOS local notification, in-app
  // 86 / item countdown (MenuItemCountManager): server counts + local rung offsets
  const [counts, setCounts] = useState<ItemCounts>(emptyCounts);
  const [itemPopup, setItemPopup] = useState<MenuItem | null>(null);                    // long-press popup
  const [countPad, setCountPad] = useState<{ mi: MenuItem; auth: Authorizer } | null>(null); // Manage Qty pad
  // Coursing: the sticky "Adding to" course (0 = Auto, FinancialCheckManager.courseNum) and the course chooser
  const [addingCourse, setAddingCourse] = useState(0);
  const [coursePick, setCoursePick] = useState<{ mode: "adding" } | { mode: "lines"; keys: string[] } | null>(null);
  const [showHub, setShowHub] = useState(false);
  const [tabsFromManager, setTabsFromManager] = useState(false); // Open Checks opened from the Manager's Menu → back goes there
  const [tabsMineOnly, setTabsMineOnly] = useState(true);        // open-checks list: mine (default) or everyone's (job see_All_Checks)
  const [editing, setEditing] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set()); // selected line keys in Edit mode
  const [adjPick, setAdjPick] = useState<null | "discount" | "service">(null);
  // an Is_Open adjustment waiting for its percent / amount on the pad (replaces window.prompt)
  const [adjOpen, setAdjOpen] = useState<{ adj: Adjustment; auth: Authorizer; keys: string[] } | null>(null);
  const [showRcPick, setShowRcPick] = useState(false);
  const [showTaxPick, setShowTaxPick] = useState(false);
  const [taxExempt, setTaxExempt] = useState<Set<string>>(new Set()); // removed tax report-group ids
  const [sortByGuest, setSortByGuest] = useState(false);
  const [transferItemKeys, setTransferItemKeys] = useState<Set<string> | null>(null); // items awaiting a destination table
  // Destination-table confirmation (ChangeTableViewController pressTable): the iPad
  // always asks before moving a check, warns when the table already has one, and
  // for item transfers offers New Check / Merge (or a check picker when several).
  const [xferConfirm, setXferConfirm] = useState<{ kind: "check" | "items"; table: DiningTable; occs: OpenCheck[] } | null>(null);
  const [memberBox, setMemberBox] = useState<null | { q: string; busy: boolean; msg: string; results: Member[] }>(null);
  const lastReceiptRef = useRef("");   // last customer-check text, for Reprint Last Check
  const [transferMode, setTransferMode] = useState(false);
  // The dining room the floor shows: seeded from the shift's default room at
  // sign-in / clock-in, then follows the room the server switches to.
  const [floorRoomId, setFloorRoomId] = useState<string>("");
  // Transfer Check (CheckViewController.m:28557 transferCheckOptions): the option
  // chooser, then the clocked-in employee picker for Person / Person And Table.
  const [xferPick, setXferPick] = useState<null | "menu" | "person" | "personTable">(null);
  const [xferClocked, setXferClocked] = useState<Set<string> | null>(null);
  const [xferEmp, setXferEmp] = useState<{ emp: Employee; auth: Authorizer } | null>(null); // pending owner for Person And Table
  // Split Check screen (Split Guest = chksplit · Transfer Item = lixfer)
  const [splitMode, setSplitMode] = useState<{ kind: SplitKind; preselect?: Set<string>; auth: Authorizer } | null>(null);
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitErr, setSplitErr] = useState("");
  const splitLocks = useRef<{ checkNo: string; checkKey: string; bd: string }[]>([]); // existing destination checks we hold locked
  const [mergePick, setMergePick] = useState<Authorizer | null>(null); // Merge With Another Check: pick the destination
  const [openChecks, setOpenChecks] = useState<OpenCheck[]>([]);
  const [floorLoading, setFloorLoading] = useState(false);
  const [floorStatus, setFloorStatus] = useState("");
  const [lockedCheck, setLockedCheck] = useState<{ checkNo: string; checkKey: string; bd: string } | null>(null);
  const [showManager, setShowManager] = useState(false);
  const [confirmTerminal, setConfirmTerminal] = useState(false); // Manager's Menu → Terminal: confirm before de-activating
  const [mgrStatus, setMgrStatus] = useState("");
  const [mgrBusy, setMgrBusy] = useState(false);
  const [pendingAuth, setPendingAuth] = useState<{ title: string; action: AuthAction; onOk: (a: Authorizer) => void } | null>(null);
  const [voidReason, setVoidReason] = useState<{ keys: string[]; auth: Authorizer } | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  // Definitions refresh on the login keypad (iOS LoginViewController viewDidAppear →
  // updatedDefinitionsLogin:YES): every arrival at the keypad pulls the tables the
  // server has revised since our cache; the terminal name re-runs it by hand
  // (pressTerminalName → updateDefinitions). Changes land through defsVersion.
  const [defsStatus, setDefsStatus] = useState("");
  const pullDefs = async (force = false) => {
    setDefsStatus("Updating definitions…");
    try {
      const changed = await refreshDefinitions(force);
      setDefsStatus(changed.length ? `Updated: ${changed.join(", ")}` : "");
    } catch (e) { console.warn("[defsync] keypad refresh failed — using cache:", e); setDefsStatus(""); }
  };
  useEffect(() => { if (!employee) void pullDefs(); }, [employee]); // eslint-disable-line react-hooks/exhaustive-deps

  const ck = useCheck(init.rcId, settings.terminalPosId);
  const checkRef = useRef(ck.check); checkRef.current = ck.check; // always-current check for async flows
  const payTenders = useMemo(() => loadTenders().filter((t) => t.appliesToCheck && !t.hidden).sort((a, b) => a.sort - b.sort), [defsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const store = useMemo(() => storeConfig(), [defsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const tax = useMemo(() => computeCheckTax(cat, ck.check, taxExempt), [cat, ck.check, taxExempt]);
  const empJobs = useMemo(() => (employee ? jobsForEmployee(employee.id) : []), [employee]);
  const perms = useMemo(() => (employee ? permsForEmployee(employee.id) : null), [employee]);
  const adjustmentDefs = useMemo(() => loadAdjustments(), [defsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const adjDepts = useMemo(() => adjustmentDepartments(), [defsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  /** doesLineItemBelongToAdjustmentDepartment (FinancialCheckManager :4157): an item
   *  qualifies ONLY when an Adjustment_Department row pairs this adjustment with the
   *  item's Category.Dept_POS_ID. No row → not eligible. Discounts require departments. */
  const inAdjDepartment = (adj: Adjustment, l: CheckLine): boolean => {
    const depts = adjDepts.get(adj.id);
    if (!depts || depts.size === 0) return false;
    const mi = cat.miById.get(l.menuItemId);
    const dept = mi ? cat.catById.get(mi.categoryId)?.departmentId : undefined;
    return !!dept && depts.has(dept);
  };
  /** Automatic gratuity (I-09): applied on Send / Print / Pay, one line per guest,
   *  unless the revenue center disables it (rc_backup15). Returns the check to post. */
  const withAutoGrat = (): Check => {
    const rc = cat.rcById.get(ck.check.revenueCenterId);
    if (rc?.disableAutoGrat) return ck.check;
    const defs: AutoGratDef[] = adjustmentDefs
      .filter((a) => a.isAutomatic && a.isServiceCharge && a.isPercentage && a.amount > 0)
      .map((a) => ({ id: a.id, name: a.name, isPercentage: true, isServiceCharge: true, taxPackId: a.taxPackId, affectsTaxes: a.affectsTaxes,
        partySize: a.partySize, amount: a.amount, departmentOk: (l) => inAdjDepartment(a, l) }));
    if (defs.length === 0) return ck.check;
    const next = applyAutoGratuity(ck.check, defs, employee?.id ?? "");
    if (next !== ck.check) ck.update(() => next);
    return next;
  };
  const voidDefs = useMemo(() => voidReasons(), [defsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const empList = useMemo(() => employees(), [defsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const rooms = useMemo(() => diningRooms(), [defsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const tables = useMemo(() => diningTables(), [defsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  // The table's display number lives on the DiningTable definition (keyed by
  // DiningTable_POS_ID) — NOT in Check_Name, which is a separate custom label.
  const tableNumberOf = (dtId?: string): string => (dtId ? tables.find((t) => t.id === dtId)?.name ?? "" : "");
  const occupancy = useMemo(() => {
    const m = new Map<string, OpenCheck>();
    for (const oc of openChecks) if (oc.tableId && !m.has(oc.tableId)) m.set(oc.tableId, oc);
    return m;
  }, [openChecks]);

  const roots = useMemo(() => rootScreenGroups(cat, rcId), [cat, rcId]);
  const current = stack[stack.length - 1];
  const searching = query.trim().length > 0;

  const favorites = useMemo(() => favoriteItems(cat, pins), [cat, pins]);
  const subGroups = useMemo<ScreenGroup[]>(() => {
    if (searching || !current) return [];
    const kids = current.id === FAVORITES_GROUP_ID ? [] : childScreenGroups(cat, current.id, rcId);
    // Visual favorites (Top16 + pins) ride as the first tile of the root screen
    return stack.length === 1 && favorites.length > 0 ? [favoritesGroup(), ...kids] : kids;
  }, [cat, current, rcId, searching, stack.length, favorites.length]);
  const items = useMemo<MenuItem[]>(
    () => (searching ? searchItems(cat, query) : current ? (current.id === FAVORITES_GROUP_ID ? favorites : itemsInScreenGroup(cat, current.id)) : []),
    [cat, current, query, searching, favorites],
  );

  /** Browse another revenue centre's menu (chips). An EMPTY check simply takes that
   *  RC; a check with lines keeps its RC until changeCheckRc (the iOS ChangeRVC path). */
  const selectRc = (id: string) => {
    setRcId(id); setQuery("");
    const r = rootScreenGroups(cat, id);
    setStack(r[0] ? [r[0]] : []);
    if (ck.check.lines.length === 0) ck.setRevenueCenter(id);
  };
  /** Change the CHECK's revenue centre at any time (CheckViewController pressChangeRevenueCenter):
   *  manager auth ("ChangeRVC" = canEmployeeManager), the ChangeRVC audit record, taxes and
   *  behaviour follow the new RC; it is posted with the next send. */
  const changeCheckRc = (id: string) => {
    if (ck.check.lines.length === 0) { selectRc(id); return; }
    if (id === ck.check.revenueCenterId) { selectRc(id); return; }
    requireAuth(false, "Authorize change revenue center", "manager", (auth) => {
      const to = cat.rcById.get(id); if (!to || !employee) return;
      const fromName = cat.rcById.get(ck.check.revenueCenterId)?.name ?? ck.check.revenueCenterId;
      ck.update((c) => changeRevenueCenter(c, { id: to.id, name: to.name }, fromName, employee.id, auth.id));
      selectRc(id);
      setSendError(`Revenue center changed to ${to.name}`);
    });
  };
  const selectTab = (sg: ScreenGroup) => { setQuery(""); setStack([sg]); };
  const enter = (sg: ScreenGroup) => setStack((s) => [...s, sg]);
  const drillTo = (i: number) => setStack((s) => s.slice(0, i + 1));

  /** Tap a tile. The guest is fixed HERE (the iPad reads currentGuestIndex when the
   *  line is created; switching seats while a sheet is open never moves it). An
   *  open-price item asks for its price first (ASK_FOR_PRICE :16890-16902), then
   *  any modifier chain runs. */
  /** Reload the 86 counts (loadMenuItemCount): on entering the order screen and
   *  after a manager sets / removes a counter. A reload clears the local offsets. */
  const refreshCounts = async () => {
    if (!employee) return;
    try {
      const bd = await ensureBd();
      const rows = await fetchMenuItemCounters(sessionCfg(), { businessDateId: bd, empPosId: employee.id });
      if (rows) setCounts(withServerCounts(rows));
    } catch { /* unreachable server: keep what we have */ }
  };
  /** 86 to zero → the iPad tells every clocked-in employee (MenuItemCountManager
   *  sendMessageForZeroMenuItem): one internal message each, Subject
   *  "Menu Item out of Stock: {name}". Same Post_Message wire as the transfer notice. */
  const notifyOutOfStock = async (mi: MenuItem) => {
    const ids = await fetchClockedInEmpIds(sessionCfg());
    if (!ids) return;
    for (const toEmpId of ids) {
      void sendEmployeeNotice(sessionCfg(), {
        fromEmpId: employee?.id ?? "", toEmpId,
        subject: `Menu Item out of Stock: ${mi.name}`,
        body: `Please note that the following menu item ${mi.name} is out of stock`,
      });
    }
  };
  const empIdForCounts = employee?.id ?? "";
  useEffect(() => { if (mode === "order" && empIdForCounts) void refreshCounts(); }, [mode, empIdForCounts]); // eslint-disable-line react-hooks/exhaustive-deps
  /** decrementCounter on ring / isDeleting on remove+void: keep the tile counts honest between reloads. */
  const countRing = (menuItemId: string, qty: number) => setCounts((c) => adjustCount(c, menuItemId, qty));
  const lineOf = (key: string) => ck.check.lines.find((l) => l.key === key);
  const removeCounted = (key: string) => {
    const l = lineOf(key);
    if (l?.kind === "M") countRing(l.menuItemId, -l.quantity);
    ck.remove(key);
  };
  const setQtyCounted = (key: string, qty: number) => {
    const l = lineOf(key);
    if (l?.kind === "M") {
      const diff = Math.max(0, qty) - l.quantity;
      const refusal = stockRefusal(counts, l.menuItemId, diff);
      if (refusal) { setSendError(refusal); return; }
      if (diff > 0 && overMax(l.amount * diff)) return;   // Store.max_check_amount applies to the stepper too
      countRing(l.menuItemId, diff);
    }
    ck.setQty(key, qty);
  };

  /** Store.max_check_amount (getMax_check_amount / amountDiff): refuse an item that
   *  would push the check past the limit. */
  const overMax = (price: number): boolean => {
    if (checkSubtotal(ck.check) + price <= store.maxCheckAmount) return false;
    setSendError("Your check reaches max limit"); return true;
  };
  /** `courseOverride` comes from the long-press course pills; otherwise the sticky
   *  "Adding to" course (0 = Auto → the item's default at print time). */
  const tapItem = (mi: MenuItem, o: RingOpts = {}) => {
    const steps = mi.modChainId ? modifierSteps(cat, mi.modChainId, rcId) : [];
    const guest = guestAssignment(o.guestIdx ?? ck.currentGuest);   // "Send to seat N" pill overrides the selected guest
    const opts: RingOpts = { ...o, course: o.course ?? (addingCourse > 0 ? addingCourse : undefined) };
    const qty = Math.max(1, Math.floor(o.qty ?? 1));
    setSendError("");
    const refusal = stockRefusal(counts, mi.id, qty);   // 86: sold-out / countdown gate
    if (refusal) { setSendError(refusal); return; }
    // Pairs Well With (CheckViewController :15291-15320): ask before ringing unless the store uses Syphor
    if (!o.skipPairing && !store.useSyphor && mi.affinityId) {
      const paired = cat.miById.get(mi.affinityId);
      if (paired && paired.id !== mi.id) { setPairing({ mi, paired, opts: { ...opts, skipPairing: true }, showDesc: false }); return; }
    }
    if (!mi.askForPrice && overMax((Number(mi.price) || 0) * qty)) return;
    if (mi.askForPrice) { setPricePrompt({ item: mi, steps, guest, opts }); return; }
    if (steps.length) setPending({ item: mi, steps, guest, opts });
    else placeItem(mi, guest, undefined, [], opts);
  };
  const placeItem = (mi: MenuItem, guest: { guestNumber: number; appliedToGuests?: string }, price?: number, chosen: ChosenModifier[] = [], o: RingOpts = {}) => {
    const key = ck.addItem(mi, guest, o.course, o.held);
    const qty = Math.max(1, Math.floor(o.qty ?? 1));
    countRing(mi.id, qty);
    if (price !== undefined) ck.setPrice(key, Math.round(price * 100) / 100);
    for (const cm of chosen) ck.addModifier(key, cm.item, cm.free ? 0 : Number(cm.item.price) || 0);
    if (qty > 1) ck.setQty(key, qty);   // x2 / x3 / x5 pill — modifiers scale with the parent
    o.after?.(key);
  };
  const finishMods = (chosen: ChosenModifier[]) => {
    if (!pending) return;
    placeItem(pending.item, pending.guest, pending.price, chosen, pending.opts);
    setPending(null);
  };
  const finishPrice = (amount: number) => {
    if (!pricePrompt) return;
    const { item, steps, guest, opts } = pricePrompt; setPricePrompt(null);
    if (overMax(amount)) return;
    if (steps.length) setPending({ item, steps, guest, price: amount, opts });
    else placeItem(item, guest, amount, [], opts);
  };
  /** The comp adjustment for the manager pills: a percentage discount named "comp";
   *  an open one takes 100 / 50 / 25, a fixed one shows only its own percent. */
  const compAdj = adjustmentDefs.find((a) => /comp/i.test(a.name) && a.isPercentage && !a.isServiceCharge);
  /** Pill role from the clocked-in JOB (no Job_Class in the back office yet):
   *  Skip_Table → counter (bar / cashier share one set), else server; no shift → every pill. */
  const pillRole: "server" | "counter" | "all" = (() => {
    const j = clock ? empJobs.find((x) => x.id === clock.jobId) : undefined;
    return j ? (j.skipTable ? "counter" : "server") : "all";
  })();
  const agoLabel = (ms?: number) => (ms === undefined ? "" : Date.now() - ms < 60_000 ? "just now" : `${Math.round((Date.now() - ms) / 60_000)} min ago`);
  /** Repeat last: ring the item again as its latest line on this check (mods, seat, course). */
  const repeatLast = (mi: MenuItem) => {
    const last = lastLineOf(ck.check, mi.id);
    if (!last) return;
    const refusal = stockRefusal(counts, mi.id, last.quantity);
    if (refusal) { setSendError(refusal); return; }
    ck.update((c) => repeatLastOf(c, mi.id).check);
    countRing(mi.id, last.quantity);
    setSendError(`Repeated ${mi.name}`);
  };
  /** Fire now (server pill): send ONLY this item's family to the kitchen right now;
   *  the other unsent lines stay unsent for the next Send. */
  const fireNow = async (key: string) => {
    if (!employee) return;
    const live = checkRef.current;   // the check as it is NOW, not as this render captured it
    const fam = new Set<string>();
    for (const l of live.lines) if (l.key === key || (l.parentKey && fam.has(l.parentKey))) fam.add(l.key);
    if (fam.size === 0) return;
    const others = live.lines.filter((l) => !l.sent && !fam.has(l.key) && l.kind !== "R");
    if (others.length === 0) { await doSend(); return; } // nothing else waiting — a plain Send & Stay
    setSending(true); setSendError("");
    try {
      const { bd, checkNo } = await ensureSession();
      const subset: Check = { ...checkRef.current, checkNumber: checkNo, lines: checkRef.current.lines.filter((l) => l.sent || fam.has(l.key)) };
      const res = await sendCheck(settings.enterpriseServerUrl, subset, buildCtx(bd, checkNo), { settle: false, taxGroups: taxGroupsForWire(computeCheckTax(cat, subset, taxExempt)) });
      if (!res.ok) { setSendError(`Fire now failed: ${res.message}`); setSending(false); return; }
      const stamped = markRoundSent(subset);
      ck.update((c) => absorbSentLines(c, stamped, fam));   // the fired family is SENT; the rest stays for the next Send
      void printPrepChits(stamped.lines.filter((l) => fam.has(l.key) && (l.kind === "M" || l.kind === "Mo") && !l.isVoid), checkNo);
      setSendError("Fired to the kitchen");
    } catch (e) { setSendError(String((e as Error).message ?? e)); }
    setSending(false);
  };
  useEffect(() => {
    if (!fireNowKey || !ck.check.lines.some((l) => l.key === fireNowKey)) return;
    const key = fireNowKey; setFireNowKey(null);
    void fireNow(key);
  }, [fireNowKey, ck.check]); // eslint-disable-line react-hooks/exhaustive-deps
  const ALLERGEN_CHIPS = ["Allergy", "Gluten", "Dairy", "Nuts", "Shellfish", "Egg", "Soy", "Vegan"];

  /** A tab name is required before send / pay / print when the check has none and
   *  (payingCheck :8929-8942, send :10823-10838): the RC is Always_Ask_For_Tab, or the
   *  job is bar mode (Skip_Table) on a tab, or an unsent item forces a tab name. */
  const needsTabName = (): boolean => {
    if (ck.check.tableName.trim() || !ck.check.lines.some((l) => l.kind === "M" && !l.isVoid && !l.transferOut)) return false;
    const rc = cat.rcById.get(ck.check.revenueCenterId);
    if (rc?.alwaysAskForTab) return true;
    const barMode = !!clock && empJobs.some((j) => j.id === clock.jobId && j.skipTable);
    if (barMode && !ck.check.diningTableId) return true;
    return ck.check.lines.some((l) => l.kind === "M" && !l.sent && cat.miById.get(l.menuItemId)?.forceTabName);
  };
  const withTabName = (after: () => void) => {
    if (needsTabName()) { setTabNameDraft(""); setTabNamePrompt({ after }); return; }
    after();
  };

  // Line selection for Edit mode (Select All / Void Selected / Split Item, …).
  const selectableKeys = () => ck.check.lines
    .filter((l) => l.kind === "M" && !l.transferOut && !(l.isVoid && l.amount < 0))
    .map((l) => l.key);
  const toggleLine = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const selectAll = () => setSel(new Set(selectableKeys()));
  const unselectAll = () => setSel(new Set());
  useEffect(() => { if (!editing) setSel(new Set()); }, [editing]); // clear picks when leaving Edit

  // Catch the check-number counter up to the server's highest check once per
  // session, so numbers stay gapless and don't collide with other terminals.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!employee || seededRef.current) return;
    seededRef.current = true;
    void (async () => {
      try {
        syncCheckCounter(await fetchHighestCheck(sessionCfg(), await ensureBd()));
        // adopt the server-synced number if the working check is still empty
        if (!ck.check.lines.length && ck.check.traysSent === 0) ck.reset(rcId);
      } catch { /* keep the local counter */ }
    })();
  }, [employee]); // eslint-disable-line react-hooks/exhaustive-deps
  // per check: the exemption set starts from what the server holds for it (P13), Edit closes, course picker resets
  useEffect(() => { setTaxExempt(new Set(ck.check.exemptTaxGroups ?? [])); setEditing(false); setAddingCourse(0); }, [ck.check.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // …and the check remembers it, so a browser reload or a re-post keeps the exemption
  useEffect(() => {
    const cur = ck.check.exemptTaxGroups ?? [];
    const next = [...taxExempt].sort();
    if (cur.length === next.length && cur.every((id, i) => id === next[i])) return;
    ck.update((c) => ({ ...c, exemptTaxGroups: next.length ? next : undefined }));
  }, [taxExempt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (mode !== "order") setAddingCourse(0); }, [mode]); // iOS resets courseNum on leaving the check screen
  // Arriving on the floor (sign-in landing, Tables, Query By Table): fresh occupancy, no stale status text
  useEffect(() => { if (mode === "floor" && employee) { setFloorStatus(""); void refreshOpenChecks(); } }, [mode, employee?.id]); // eslint-disable-line react-hooks/exhaustive-deps // per-check: reset tax exemption; leave Edit for the menu view when the check closes/switches

  const sessionCfg = (): SessionConfig => ({
    enterpriseServerUrl: settings.enterpriseServerUrl, isisVer: ISIS_VER,
    storeId: settings.storeId, token: settings.token, terminalPosId: settings.terminalPosId,
  });

  // Inbox (messaging arc F1): 5 s poll while signed in; a never-seen message pops a toast
  // (the out-of-stock notice lands here — R43). Messages screen is an overlay mode that
  // returns to wherever it was opened from; it never touches the working check.
  const msgs = useMessages(sessionCfg, employee?.id ?? null, (m) => setToast(m));
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 8000); return () => window.clearTimeout(t); }, [toast]);
  const openMessages = () => { if (mode !== "messages") setModeBeforeMessages(mode); setMode("messages"); setToast(null); };
  const closeMessages = () => setMode(modeBeforeMessages);
  const sendFromCompose = async (t: ComposeTarget): Promise<string> => {
    if (!employee) return "Not signed in";
    const base = { fromEmpId: employee.id, subject: t.subject, body: t.body };
    const results = t.toEmpIds.length
      ? await Promise.all(t.toEmpIds.map((toEmpId) => sendMessage(sessionCfg(), { ...base, toEmpId })))
      : [await sendMessage(sessionCfg(), { ...base, email: t.email, phone: t.phone })];
    const failed = results.filter((r) => !r.ok);
    if (failed.length) return `Send failed: ${failed[0].message}`;
    const sms = results.find((r) => r.smsResult)?.smsResult;
    return t.toEmpIds.length ? `Sent to ${results.length} employee${results.length === 1 ? "" : "s"}` : sms && sms !== "Success" ? `Text: ${sms}` : "Sent";
  };

  const ensureBd = async (): Promise<string> => {
    let bd = bdid;
    if (!bd) { bd = await resolveBusinessDate(sessionCfg()); setBdid(bd); }
    if (!bd) throw new Error("No open business date on the server");
    return bd;
  };

  // At login, check the server for an existing shift (Clocked_In_Emps). If the
  // employee is already clocked in, go straight in using their current job /
  // default room / sequence — no clock-in gate (LoginViewController loginLoading).
  /** Where a signed-in employee lands (DefinitionManager isBarMode = current job's
   *  Skip_Table): a Skip_Table job goes straight to the check screen (bar mode);
   *  every other job lands on the table layout. */
  const landingMode = (empId: string, jobId: string): "floor" | "order" | "manager" => {
    const job = jobsForEmployee(empId).find((j) => j.id === jobId);
    if (job?.mgrMenu && !job.managerServerMode) return "manager"; // LoginViewController.m:949 → Manager's Menu
    return job?.skipTable ? "order" : "floor";
  };

  // sendUnSentChecks parity: a working check left with unsent items (app killed,
  // page reloaded) is posted as soon as someone is signed in and clocked in. If
  // the post fails the check is shown so nothing is ever silently lost.
  const flushedRef = useRef(false);
  useEffect(() => {
    if (!employee || !clock) { flushedRef.current = false; return; }
    if (flushedRef.current) return;
    flushedRef.current = true;
    const c = checkRef.current;
    if (unsentLines(c).length === 0 && !c.tenders.some((t) => !t.sent)) return;
    void (async () => {
      const no = c.checkNumber ?? "";
      if (await flushWorkingCheck()) { await releaseLock(); ck.reset(rcId); setSendError(""); setFloorStatus(`Unsent items on check ${no} were sent`); }
      else setMode("order");
    })();
  }, [employee, clock]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!employee) { setSigningIn(false); return; }
    if (clock) { setFloorRoomId(clock.defaultRoomId); setMode(landingMode(employee.id, clock.jobId)); return; } // stored shift → straight in, by the JOB
    let cancelled = false;
    setSigningIn(true);
    void (async () => {
      try {
        const emp = await fetchClockedInEmp(sessionCfg(), employee.id);
        if (cancelled) return;
        if (emp) {
          const jobName = empJobs.find((j) => j.id === emp.jobId)?.name ?? "";
          setClock({ empId: employee.id, jobId: emp.jobId, jobName, sequence: emp.sequence, defaultRoomId: emp.defaultRoomId });
          setFloorRoomId(emp.defaultRoomId); setMode(landingMode(employee.id, emp.jobId));
        } else setSigningIn(false); // not clocked in → the gate handles clock-in
      } catch { if (!cancelled) setSigningIn(false); }
    })();
    return () => { cancelled = true; };
  }, [employee, clock]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check For Messages On Sign In (Job.check_for_messages_on_signin): once per sign-in,
  // after the first poll, open the inbox if it has anything (LoginViewController.m:1065-1136).
  // Declared AFTER the landing effect on purpose: both fire in the commit that sets the
  // clock, and the later effect's setMode wins.
  const signInMsgChecked = useRef(false);
  useEffect(() => {
    if (!employee || !clock) { signInMsgChecked.current = false; return; }
    if (signInMsgChecked.current || msgs.pollCount === 0) return;
    signInMsgChecked.current = true;
    const job = empJobs.find((j) => j.id === clock.jobId);
    if (job?.checkForMessagesOnSignIn && msgs.messages.length > 0) openMessages();
  }, [employee, clock, msgs.pollCount]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Resolve BusinessDate_ID and a check number, assigning the number once. */
  const ensureSession = async (): Promise<{ bd: string; checkNo: string }> => {
    // A check pulled from the server keeps ITS business date (a carried-over check
    // re-POSTed under today's date makes the server open a second record).
    const bd = ck.check.businessDateId || (await ensureBd());
    return { bd, checkNo: ck.check.checkNumber ?? "" }; // the check always has its number (minted at creation)
  };

  const refreshOpenChecks = async () => {
    setFloorLoading(true); setFloorStatus("");
    try {
      const bd = await ensureBd();
      const list = await fetchOpenChecks(sessionCfg(), bd);
      setOpenChecks(list);
      setFloorStatus(`${list.length} open check(s)`);
    } catch (e) { setFloorStatus(String((e as Error).message ?? e)); }
    setFloorLoading(false);
  };

  const releaseLock = async () => {
    if (!lockedCheck) return;
    await unlockCheck(sessionCfg(), { checkNo: lockedCheck.checkNo, checkKey: lockedCheck.checkKey, businessDateId: lockedCheck.bd });
    setLockedCheck(null);
  };

  /** sendUnSentChecks parity, used ONLY by the sign-in recovery: a working check
   *  left with unsent lines / tenders (crash, failed send) is posted. false = the
   *  post failed; the caller shows the check instead. */
  const flushWorkingCheck = async (): Promise<boolean> => {
    const c = checkRef.current;
    if (unsentLines(c).length === 0 && !c.tenders.some((t) => !t.sent)) return true;
    setSending(true); setSendError("");
    const r = await postCheck(false, withAutoGrat());
    setSending(false);
    if (!r.ok) { setSendError(r.message || "Couldn't send the check — items kept."); return false; }
    return true;
  };

  /** iOS unsentItemAlert ("Unsent Items — Please send or delete unsent items"):
   *  there is NO way out of a check with unsent items — Tables, Tabs, Sign Out,
   *  Quick sale, New tab/check, Manager's Menu all stop here. Only a crash or a
   *  failed send can leave unsent items behind, and the sign-in flush recovers those. */
  const [unsentAlert, setUnsentAlert] = useState(false);
  const blockIfUnsent = (): boolean => {
    const c = checkRef.current;
    if (unsentLines(c).length === 0 && !c.tenders.some((t) => !t.sent)) return false;
    setUnsentAlert(true);
    return true;
  };

  /** Park the working check before leaving the order screen: drop the local
   *  working copy + lock (the check is already on the server). Refused, with the
   *  iOS alert, while anything is unsent. A brand-new empty check parks to nothing. */
  const parkCheck = async (): Promise<boolean> => {
    if (blockIfUnsent()) return false;
    await releaseLock();
    ck.reset(rcId); setSendError(""); setEditing(false);
    return true;
  };

  /** Leave the ordering view for the floorplan. */
  const goToFloor = async () => {
    if (!(await parkCheck())) return;
    setTransferMode(false); setMode("floor");
    void refreshOpenChecks();
  };

  const quickSale = () => {
    if (blockIfUnsent()) { setMode("order"); return; }
    void releaseLock(); setTransferMode(false); ck.reset(rcId); setSendError(""); setMode("order");
  };

  /** Open the Tabs list — every open check (counter tabs + tables), to pick up. */
  const goToTabs = async () => {
    if (!(await parkCheck())) return;
    setTabsFromManager(false); setTransferMode(false); setMode("tabs");
    void refreshOpenChecks();
  };

  /** Send & Stay — fire unsent items to the kitchen, keep editing the check. */
  const doSendStay = () => void doSend();

  /** Backing out of the payment sheet: any payment taken but not yet posted goes to the
   *  server right away (iOS makePayment posts each tender), so a partial payment never
   *  sits only on this terminal. */
  const closePay = async () => {
    if (ck.check.tenders.some((t) => !t.sent)) {
      setSending(true); setSendError("");
      const r = await postCheck(false);
      setSending(false);
      if (!r.ok) { setSendError(`Payment not saved: ${r.message}`); return; } // keep the sheet open; nothing is lost
      setSendError("Payment saved");
    }
    setShowPay(false);
  };

  /** Pay (I-17, payingCheck): the check is SENT before the payment sheet opens, so
   *  backing out leaves nothing unsent/removable; auto gratuity rides along. */
  const openPay = async () => {
    const next = withAutoGrat();
    if (unsentLines(next).length > 0) {
      setSending(true); setSendError("");
      const r = await postCheck(false, next);
      setSending(false);
      if (!r.ok) { setSendError(r.message || "Couldn't send the check."); return; }
    }
    setShowPay(true);
  };

  /** Send — fire unsent items, then leave the check as an open tab (it stays on
   *  the server, pickable from Tabs / the floor). */
  const doSend2 = async () => {
    const wasTable = !!ck.check.diningTableId;
    setSending(true); setSendError("");
    const r = await postCheck(false, withAutoGrat());
    setSending(false);
    if (!r.ok) { setSendError(r.message || "Couldn't send the check."); return; }
    await releaseLock();
    ck.reset(rcId); setSendError("");
    if (wasTable) { setMode("floor"); } else { setMode("tabs"); }
    void refreshOpenChecks();
  };

  /** Sign out — we're done with this check for now: fire any unsent items to the
   *  kitchen, then clear the working check so the next sign-in starts fresh (a
   *  table check stays open on the server, resumable from the floor). Ends the
   *  session but keeps the shift (sign-out ≠ clock-out). */
  const doSignOut = async () => {
    if (blockIfUnsent()) return;
    await releaseLock();
    ck.reset(rcId); setSendError(""); setTransferMode(false);
    signOut();
  };

  /** Transfer Check → Person / Person And Table, phase A (transferToPerson
   *  :16563-16603): fire anything unsent first, then load the clocked-in list and
   *  open the employee picker. Phase B runs from the picker on a fresh render. */
  const beginTransferCheck = async (kind: "person" | "personTable") => {
    if (blockIfUnsent()) return;
    setSending(true); setSendError("");
    setXferClocked(await fetchClockedInEmpIds(sessionCfg()));
    setSending(false); setXferPick(kind);
  };

  /** Phase B (EmployeeListViewController transfer :282-345): same check number,
   *  re-POSTed with the "Xfer from A  to  B" note + chkxfer record and the new
   *  owner as Employee_POS_ID (optionally re-bound to `table`); the new owner is
   *  told by an internal message. Refuses a transfer to the current owner. */
  const transferCheckToEmployee = async (to: Employee, auth: Authorizer, table?: DiningTable) => {
    const ownerId = ck.check.employeePosId ?? employee!.id;
    if (ownerId === to.id) { setSendError("That employee already has this check."); setFloorStatus("That employee already has this check."); return; }
    const from = { id: ownerId, name: empList.find((e) => e.id === ownerId)?.name ?? "" };
    setSending(true); setSendError("");
    try {
      const { bd, checkNo } = await ensureSession();
      const moved = addTransferCheckRecord(
        { ...ck.check, employeePosId: to.id, ...(table ? { diningTableId: table.id } : {}) },
        from, { id: to.id, name: to.name }, auth.id,
      );
      const res = await sendCheck(settings.enterpriseServerUrl, moved, buildCtx(bd, checkNo), { settle: false, taxGroups: taxGroupsForWire(tax) });
      if (!res.ok) { setSendError(res.message || "Couldn't transfer the check."); setFloorStatus(`Transfer failed: ${res.message}`); return; }
      const where = table ? `Table ${table.name}`
        : ck.check.diningTableId ? `Table ${tableNumberOf(ck.check.diningTableId)}`
        : ck.check.tableName ? `Tab ${ck.check.tableName}` : "Check";
      void sendEmployeeNotice(sessionCfg(), { fromEmpId: employee!.id, toEmpId: to.id, subject: "CheckTransfer", body: `${where} was transferred to you!` });
      await releaseLock();
      const wasTable = !!(table ?? ck.check.diningTableId);
      ck.reset(rcId); setXferEmp(null); setTransferMode(false); setFloorStatus(`Transferred to ${to.name}`);
      setMode(wasTable ? "floor" : "tabs"); void refreshOpenChecks();
    } catch (e) { setSendError(String((e as Error).message ?? e)); }
    finally { setSending(false); }
  };

  /** Move the current (posted) check to another table — a re-POST of the
   *  FinancialCheck with a new DiningTable_POS_ID (recon D). */
  const startTransfer = async () => {
    if (blockIfUnsent()) return;
    setTransferMode(true); setMode("floor"); void refreshOpenChecks();
  };
  const transferTo = async (table: DiningTable) => {
    if (xferEmp) { await transferCheckToEmployee(xferEmp.emp, xferEmp.auth, table); return; } // Person And Table
    setFloorLoading(true); setFloorStatus(`Moving check to table ${table.name}…`);
    try {
      const { bd, checkNo } = await ensureSession();
      // Re-bind to the new table (DiningTable_POS_ID); keep Check_Name as-is —
      // it's the check's own label, not the table number.
      const moved = { ...ck.check, diningTableId: table.id, checkNumber: checkNo };
      const res = await sendCheck(settings.enterpriseServerUrl, moved, buildCtx(bd, checkNo), { settle: false, taxGroups: taxGroupsForWire(tax) });
      if (!res.ok) { setFloorStatus(`Transfer failed: ${res.message}`); setFloorLoading(false); return; }
      await releaseLock();
      ck.reset(rcId); setTransferMode(false); setFloorStatus(`Moved to table ${table.name}`);
      await refreshOpenChecks();
    } catch (e) { setFloorStatus(String((e as Error).message ?? e)); }
    setFloorLoading(false);
  };

  /** Pick up (resume) any open check — a table check or a counter tab. Locks it,
   *  reads it back from the server, and loads it into the check panel. */
  const pickCheck = async (occ: OpenCheck, label = `check ${occ.checkNo}`): Promise<boolean> => {
    if (blockIfUnsent()) { setMode("order"); return false; } // the working check's unsent items first
    setFloorLoading(true); setFloorStatus(`Opening ${label}…`);
    try {
      const bd = occ.businessDateId || (await ensureBd());
      const lock = await lockCheck(sessionCfg(), { checkNo: occ.checkNo, checkKey: occ.checkKey, businessDateId: bd });
      if (!lock.ok) {
        setFloorStatus(lock.alreadyLocked ? `${label} is open on another terminal` : `Could not lock: ${lock.message}`);
        setFloorLoading(false); return false;
      }
      const names = {
        menuItemName: (id: string) => cat.miById.get(id)?.name ?? `#${id}`,
        tenderName: (id: string) => payTenders.find((t) => t.id === id)?.name ?? `#${id}`,
        adjustmentName: (id: string) => adjustmentDefs.find((a) => a.id === id)?.name ?? `#${id}`,
      };
      const pulled = await readCheck(sessionCfg(), { checkNo: occ.checkNo, checkKey: occ.checkKey, businessDateId: bd }, names);
      if (!pulled) { setFloorStatus("Check not found on the server"); await unlockCheck(sessionCfg(), { checkNo: occ.checkNo, checkKey: occ.checkKey, businessDateId: bd }); setFloorLoading(false); return false; }
      ck.loadCheck({ ...pulled, businessDateId: bd });
      if (pulled.revenueCenterId && cat.rcById.has(pulled.revenueCenterId)) setRcId(pulled.revenueCenterId);
      setLockedCheck({ checkNo: occ.checkNo, checkKey: occ.checkKey, bd });
      setSendError(""); setFloorStatus(""); setMode("order");
      setFloorLoading(false); return true;
    } catch (e) { setFloorStatus(String((e as Error).message ?? e)); setFloorLoading(false); return false; }
  };

  /** Move the selected (sent) item family to another check — a table's open
   *  check, or a new check on an empty table. Two FinancialCheck POSTs: the
   *  source with the items voided-off (Transfered_Out), the destination with
   *  fresh copies (ground-truth pressTransferItems / didSelectTableCheck). */
  const transferItemsTo = async (table: DiningTable, occ?: OpenCheck) => {
    if (!transferItemKeys) return;
    setFloorLoading(true); setFloorStatus(`Transferring items to table ${table.name}…`);
    try {
      const { source, dest } = splitToNewCheck(ck.check, transferItemKeys);
      if (dest.lines.length === 0) { setFloorStatus("Nothing to transfer"); setTransferItemKeys(null); setFloorLoading(false); return; }
      const { bd } = await ensureSession();
      const srcNo = ck.check.checkNumber!;
      const moved = dest.lines.map((l) => ({ ...l, sent: false }));
      const names = {
        menuItemName: (id: string) => cat.miById.get(id)?.name ?? `#${id}`,
        tenderName: (id: string) => payTenders.find((t) => t.id === id)?.name ?? `#${id}`,
        adjustmentName: (id: string) => adjustmentDefs.find((a) => a.id === id)?.name ?? `#${id}`,
      };
      // 1) source re-POST with the Transfered_Out lines
      const r1 = await sendCheck(settings.enterpriseServerUrl, { ...source, checkNumber: srcNo }, buildCtx(bd, srcNo),
        { settle: false, taxGroups: taxGroupsForWire(computeCheckTax(cat, source)) });
      if (!r1.ok) { setFloorStatus(`Transfer failed (source): ${r1.message}`); setFloorLoading(false); return; }
      // 2) destination: merge into the table's open check, or open a new one
      if (occ) {
        const dbd = occ.businessDateId || bd;
        const lock = await lockCheck(sessionCfg(), { checkNo: occ.checkNo, checkKey: occ.checkKey, businessDateId: dbd });
        if (!lock.ok) { setFloorStatus(`Destination is open on another terminal`); setFloorLoading(false); return; }
        const pulled = await readCheck(sessionCfg(), { checkNo: occ.checkNo, checkKey: occ.checkKey, businessDateId: dbd }, names);
        if (!pulled) { setFloorStatus("Destination check not found"); await unlockCheck(sessionCfg(), { checkNo: occ.checkNo, checkKey: occ.checkKey, businessDateId: dbd }); setFloorLoading(false); return; }
        const merged = { ...pulled, lines: [...pulled.lines, ...moved] };
        const r2 = await sendCheck(settings.enterpriseServerUrl, { ...merged, checkNumber: occ.checkNo }, buildCtx(dbd, occ.checkNo),
          { settle: false, taxGroups: taxGroupsForWire(computeCheckTax(cat, merged)) });
        await unlockCheck(sessionCfg(), { checkNo: occ.checkNo, checkKey: occ.checkKey, businessDateId: dbd });
        if (!r2.ok) { setFloorStatus(`Transfer failed (destination): ${r2.message}`); setFloorLoading(false); return; }
      } else {
        const destNo = mintCheckNumber(settings.terminalPosId);
        const nc = { ...newCheck(table.revenueCenterId || rcId, table.name, 1, table.id), lines: moved, checkNumber: destNo };
        const r2 = await sendCheck(settings.enterpriseServerUrl, nc, buildCtx(bd, destNo),
          { settle: false, taxGroups: taxGroupsForWire(computeCheckTax(cat, nc)) });
        if (!r2.ok) { setFloorStatus(`Transfer failed (destination): ${r2.message}`); setFloorLoading(false); return; }
      }
      // 3) commit the source locally (Transfered_Out round now sent)
      ck.loadCheck(source); ck.markSent(false);
      setTransferItemKeys(null); setMode("order"); setFloorStatus(`Items moved to table ${table.name}`);
      await refreshOpenChecks();
    } catch (e) { setFloorStatus(String((e as Error).message ?? e)); }
    setFloorLoading(false);
  };

  const pickTable = async (table: DiningTable, occ?: OpenCheck) => {
    const occs = openChecks.filter((o) => o.tableId === table.id); // every open check on that table, not just the floor's first
    if (transferItemKeys) { setXferConfirm({ kind: "items", table, occs }); return; }
    if (transferMode) { setXferConfirm({ kind: "check", table, occs }); return; }
    if (!occ) { // open a fresh check bound to the table — cover count first (guestCountPad on table open)
      setCoverPrompt(table);
      return;
    }
    void pickCheck(occ, `table ${table.name}`);
  };

  const openTableWithCovers = (table: DiningTable, covers: number) => {
    setCoverPrompt(null);
    if (blockIfUnsent()) { setMode("order"); return; } // never over-write unsent items
    void releaseLock();
    // Bind to the table (DiningTable_POS_ID); leave Check_Name empty — it's a
    // separate custom label, not the table number (which comes from the def).
    ck.reset(table.revenueCenterId || rcId, "", Math.max(1, covers), table.id);
    if (table.revenueCenterId && cat.rcById.has(table.revenueCenterId)) setRcId(table.revenueCenterId);
    setSendError(""); setMode("order");
  };

  const buildCtx = (bd: string, checkNo: string): SendContext => ({
    isisVer: ISIS_VER, storeId: settings.storeId, securityToken: settings.token,
    terminalPosId: settings.terminalPosId, employeePosId: employee!.id, businessDateId: bd, checkNo,
  });

  /* ---- Printing (PrintManager port; native TCP 9100 on device, no-op in dev) ---- */

  /** Route the just-fired items to their printers: a paper prep chit to raw/cloud
   *  printers, and a KDS order (/remoteorder/) to KDS-flagged printers. */
  /* ---- Coursing helpers (COURSING_SPEC.md §5/§6) ---- */
  const courseOfLine = (l: CheckLine): number => effectiveCourse(l, cat.miById.get(l.menuItemId)?.printSortOrder ?? 0);
  /** A modifier prints under its parent's course. */
  const familyCourse = (l: CheckLine): number => {
    if (l.kind === "M") return courseOfLine(l);
    const parent = l.parentKey ? ck.check.lines.find((x) => x.key === l.parentKey) : undefined;
    return parent ? courseOfLine(parent) : 0;
  };
  const currentRc = () => cat.rcById.get(ck.check.revenueCenterId);
  const courseOptsFor = (printer: Printer): CourseOpts => ({
    useCourse: printer.useCourse, forceHeaders: store.printCourseLine, names: printer.courseNames, red: printer.printCourseRed,
    guestBeforeCourse: currentRc()?.guestBeforeCourse ?? false,
  });
  /** On-screen course label: the first course-printing printer that names it, else "Course N". */
  const courseLabelFor = (n: number): string => {
    for (const pr of loadPrinters()) if (pr.useCourse && pr.courseNames[n - 1]) return pr.courseNames[n - 1];
    return `Course ${n}`;
  };
  /** Route item families to prep printers (one merged bucket per printer). */
  const bucketByPrinter = (lines: CheckLine[]) => {
    const families: { item: CheckLine; mods: CheckLine[] }[] = [];
    for (const l of lines) {
      if (l.kind === "M") families.push({ item: l, mods: [] });
      else if (l.kind === "Mo") families[families.length - 1]?.mods.push(l);
    }
    const buckets = new Map<string, { printer: Printer; lines: CheckLine[] }>();
    for (const fam of families) {
      const mi = cat.miById.get(fam.item.menuItemId);
      const pgIds = mi?.printGroupIds?.length ? mi.printGroupIds : (mi?.printGroupId ? [mi.printGroupId] : []);
      for (const pr of prepPrintersForGroups(pgIds, settings.terminalPosId)) {
        const b = buckets.get(pr.id) ?? { printer: pr, lines: [] };
        b.lines.push(fam.item, ...fam.mods); buckets.set(pr.id, b);
      }
    }
    return buckets;
  };
  const prepCtxFor = (checkNo: string, now: Date, refire?: boolean): PrepCtx => {
    const p2 = (n: number) => String(n).padStart(2, "0");
    let hr = now.getHours() % 12; if (hr === 0) hr = 12;
    return {
      checkNo, server: employee?.name ?? "", guests: ck.check.guestCount, rcName: currentRc()?.name ?? "",
      tabLabel: ck.check.diningTableId ? `TBL: ${tableNumberOf(ck.check.diningTableId)}` : `TAB:${ck.check.tableName ? ` ${ck.check.tableName}` : ""}`,
      date: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`,
      time: `${hr}:${p2(now.getMinutes())}`, refire,
    };
  };
  const prepItemsFor = (printer: Printer, lines: CheckLine[]): PrepItem[] => {
    const out: PrepItem[] = [];
    let cur: PrepItem | null = null;
    for (const l of lines) {
      // Seat tag (S1 / T) only when the printer has includeSeat set (PrintManager.m:5248 + 13116-13124).
      if (l.kind === "M") {
        const seat = printer.includeSeat ? (l.guestNumber && l.guestNumber > 0 && !l.appliedToGuests ? `S${l.guestNumber}` : "T") : undefined;
        const c = courseOfLine(l);
        cur = { qty: l.quantity, name: l.description, mods: [], seat, held: l.held, course: l.course === undefined && c === 0 ? undefined : c, guest: l.guestNumber ?? 0, note: l.reference };
        out.push(cur);
      } else if (cur) cur.mods.push(l.description);
    }
    return out;
  };
  const kdsHeaderFor = (checkNo: string, printer: Printer, now: Date, fire?: number) => ({
    token: settings.token, entid: store.enterpriseId, entcode: settings.enterpriseCode,
    server: employee?.name ?? "", empId: employee?.id ?? "", guests: ck.check.guestCount, checkNo,
    date: now.toLocaleString(), revenueCenter: currentRc()?.name ?? "",
    tableName: ck.check.diningTableId ? `Table ${tableNumberOf(ck.check.diningTableId)}` : (ck.check.tableName || ""),
    store: settings.storeId, printerId: printer.id, bdid: bdid, checkKey: ck.check.id, togo: "", vip: "", allergy: "0",
    ...(fire !== undefined ? { fire: String(fire) } : {}),
  });
  const kdsLine = (l: CheckLine, course: number, fired?: string): KdsItem => ({
    lineitemkey: `${ck.check.id}:${l.key}`, quantity: String(l.quantity), description: l.description,
    amount: l.amount.toFixed(2), guestNumber: l.appliedToGuests === "0" || !l.guestNumber || l.guestNumber <= 0 ? "T" : String(l.guestNumber),
    indentLevel: l.indentLevel, reference: l.kind === "M" ? (l.reference ?? "") : "", type: l.kind === "Mo" ? "Mo" : "M", isVoid: l.isVoid ? "1" : "0",
    ...(course > 0 ? { course: String(course) } : {}), ...(fired !== undefined ? { fired } : {}),
  });
  const uuid = () => { try { return crypto.randomUUID(); } catch { return String(Date.now()) + Math.floor(Math.random() * 1e6); } };

  /** Fire the round's items to the kitchen: paper chits with course headers
   *  (PrintManager rules) and KDS documents with "Co" course lines. When a KDS
   *  printer opts in (holdUnfiredCourses), courses above this round's lowest
   *  course go out unfired, to be released by Fire Course. */
  const printPrepChits = async (fired: typeof ck.check.lines, checkNo: string, opts: { refire?: boolean } = {}) => {
    const buckets = bucketByPrinter(fired);
    if (buckets.size === 0) return;
    const now = new Date();
    for (const { printer, lines } of buckets.values()) {
      if (printer.isKDS) {
        const co = courseOptsFor(printer);
        const live = lines.filter((l) => !l.held);
        const heads = live.filter((l) => l.kind === "M");
        const coursesOn = co.useCourse && (co.forceHeaders || heads.every((l) => { const c = courseOfLine(l); return c >= 1 && c <= 10; }));
        const withCourse = heads.map(courseOfLine).filter((c) => c > 0);
        const minCourse = withCourse.length ? Math.min(...withCourse) : 0;
        const firedFlag = (c: number): string | undefined => (printer.holdUnfiredCourses ? (minCourse > 0 && c > minCourse ? "0" : "1") : undefined);
        const items: KdsItem[] = opts.refire
          ? [{ lineitemkey: `${ck.check.id}:refire`, quantity: "", description: "REFIRE", amount: "", guestNumber: "", indentLevel: 0, reference: "", type: "Co", isVoid: "0" }]
          : []; // DisplayManager :1100-1102 — a string entry becomes a type "Co" line
        // families in print order: by course (1..10, then Others) when headers apply, else entry order
        const fams: { head: CheckLine; mods: CheckLine[]; course: number }[] = [];
        for (const l of live) {
          if (l.kind === "M") fams.push({ head: l, mods: [], course: courseOfLine(l) });
          else fams[fams.length - 1]?.mods.push(l);
        }
        const order = coursesOn ? [...fams].sort((a, b) => (a.course >= 1 && a.course <= 10 ? a.course : 99) - (b.course >= 1 && b.course <= 10 ? b.course : 99)) : fams;
        let lastHeader = "";
        for (const f of order) {
          if (coursesOn) {
            const header = f.course >= 1 && f.course <= 10 ? (printer.courseNames[f.course - 1] || `Course ${f.course}`) : "Others";
            if (header !== lastHeader) { // a course name rides to the KDS as a type "Co" line (PrintManager :5459)
              items.push({ lineitemkey: `${ck.check.id}:co${f.course}`, quantity: "", description: header, amount: "", guestNumber: "", indentLevel: 0, reference: "", type: "Co", isVoid: "0" });
              lastHeader = header;
            }
          }
          const flag = firedFlag(f.course);
          items.push(kdsLine(f.head, f.course, flag));
          for (const m of f.mods) items.push(kdsLine(m, f.course, flag));
        }
        const json = buildKdsOrderJson(uuid(), kdsHeaderFor(checkNo, printer, now), items, { tax: tax.taxTotal.toFixed(2), total: grandTotal(checkSubtotal(ck.check), tax).toFixed(2) });
        void sendKdsOrder(printer, json);
      } else {
        const job = buildPrepChit(printer.name, prepCtxFor(checkNo, now, opts.refire), prepItemsFor(printer, lines), printer.charsPerLine, courseOptsFor(printer));
        void printTo(printer, job, { enterpriseCode: settings.enterpriseCode, storeId: settings.storeId, backup: backupPrinter(printer) });
      }
    }
  };

  /** Fire Course N (waiter-driven, COURSING_SPEC §6.2): record it on the check,
   *  then tell each station holding that course's items — a FIRE chit on paper,
   *  a `fire` document on a KDS. */
  const fireCourse = async (n: number) => {
    if (!employee) return;
    const lines = ck.check.lines.filter((l) => (l.kind === "M" || l.kind === "Mo") && l.sent && !l.isVoid && !l.transferOut && !l.isSplit && !l.held && familyCourse(l) === n);
    if (!lines.some((l) => l.kind === "M")) { setSendError(`Course ${n} is empty. Add at least one item to the course before firing it.`); return; }
    setSending(true); setSendError("");
    const before = ck.check;
    const next = addFireCourseRecord(before, n, employee.id);
    ck.update(() => next);   // the record is on the check NOW (header → FIRED, button gone); the post marks it sent
    const r = await postCheck(false, next);
    if (!r.ok) { ck.update(() => before); setSendError(`Fire course failed: ${r.message}`); setSending(false); return; }
    const checkNo = ck.check.checkNumber ?? "";
    const now = new Date();
    for (const { printer, lines: plines } of bucketByPrinter(lines).values()) {
      if (printer.isKDS) {
        const items = plines.map((l) => kdsLine(l, n, "1"));
        const json = buildKdsOrderJson(uuid(), kdsHeaderFor(checkNo, printer, now, n), items, { tax: tax.taxTotal.toFixed(2), total: grandTotal(checkSubtotal(ck.check), tax).toFixed(2) });
        void sendKdsOrder(printer, json);
      } else {
        const job = buildFireChit(printer.name, prepCtxFor(checkNo, now), n, printer.courseNames[n - 1] || `Course ${n}`, prepItemsFor(printer, plines), printer.charsPerLine, printer.printCourseRed);
        void printTo(printer, job, { enterpriseCode: settings.enterpriseCode, storeId: settings.storeId, backup: backupPrinter(printer) });
      }
    }
    setSendError(`Fired course ${n}`); setSending(false);
  };

  /** Change Course on lines (CouringViewController pressN/pressZero): set it locally;
   *  sent lines also re-post print_Sort_Order through the Modify path. */
  const applyCourseChange = (keys: string[], course: number) => {
    const set = new Set(keys);
    const sentLines = ck.check.lines.filter((l) => set.has(l.key) && l.kind === "M" && l.sent && l.trayNumber && l.lineNumber);
    const checkNo = ck.check.checkNumber, checkKey = ck.check.id, bdOfCheck = ck.check.businessDateId;
    ck.update((c) => setCourse(c, set, course)); unselectAll(); setEditing(false);
    if (sentLines.length && checkNo) {
      void (async () => {
        try {
          const bd = bdOfCheck || (await ensureBd());
          for (const l of sentLines) {
            const r = await modifyLineItem(sessionCfg(), { businessDateId: bd, checkNo, checkKey, trayNumber: l.trayNumber!, lineNumber: l.lineNumber!, field: "print_Sort_Order", value: String(course) });
            if (!r.ok) { setSendError(`Course change not saved on the server: ${r.message}`); return; }
          }
          setSendError(`Course changed on ${sentLines.length} sent line(s)`);
        } catch (e) { setSendError(String((e as Error).message ?? e)); }
      })();
    }
  };
  /** 1-second press on a check line (CheckTableCellView pressLong): course chooser
   *  for a menu item; iOS routes an unsent modifier to Change Modifier instead. */
  const lineLongPress = (key: string) => {
    if (store.useSyphor) return;
    const l = ck.check.lines.find((x) => x.key === key);
    if (!l || l.kind !== "M") return;
    // A SENT item: the kitchen-note pills (Delay / Rush / Remake / Allergy / custom), with
    // Change course still reachable from the same sheet. An unsent item: the course chooser, as before.
    if (l.sent && !l.isVoid && !l.transferOut) { setKitchenNote({ key, name: l.description, text: "" }); return; }
    setCoursePick({ mode: "lines", keys: [key] });
  };

  /** Kitchen note (messaging arc F5, Geoff 2026-10-16): a NEW order for this check carrying
   *  one type "R" reference line, sent to EXACTLY the stations the referenced item routes to
   *  (its print groups → this terminal's printers): the KDS merges it into the existing
   *  ticket as a highlighted line; a paper station gets a NOTE chit. */
  const sendKitchenNote = async (key: string, text: string) => {
    const l = ck.check.lines.find((x) => x.key === key);
    if (!l || !employee) return;
    const checkNo = ck.check.checkNumber ?? "";
    const buckets = bucketByPrinter([l]);
    if (buckets.size === 0) { setSendError(`No kitchen station prints ${l.description}`); return; }
    const now = new Date();
    const note = `NOTE: ${text} · ${l.description}`;
    let n = 0;
    for (const { printer } of buckets.values()) {
      n++;
      if (printer.isKDS) {
        const items: KdsItem[] = [{
          lineitemkey: `${ck.check.id}:note:${key}:${now.getTime()}`, quantity: "", description: note, amount: "",
          guestNumber: "", indentLevel: 0, reference: "", type: "R", isVoid: "0",
        }];
        const json = buildKdsOrderJson(uuid(), kdsHeaderFor(checkNo, printer, now), items, { tax: tax.taxTotal.toFixed(2), total: grandTotal(checkSubtotal(ck.check), tax).toFixed(2) });
        void sendKdsOrder(printer, json);
      } else {
        const job = buildNoteChit(printer.name, prepCtxFor(checkNo, now), text, l.description, printer.charsPerLine, printer.printCourseRed);
        void printTo(printer, job, { enterpriseCode: settings.enterpriseCode, storeId: settings.storeId, backup: backupPrinter(printer) });
      }
    }
    setSendError(`Note sent to ${n} station${n === 1 ? "" : "s"}: ${text}`);
  };

  /** Build the customer-check receipt text for the current check. */
  const buildReceiptText = (checkNo: string, reprint = false, c: Check = ck.check): string => {
    const wrap = checkWrapper(c.revenueCenterId);
    const pr = checkPrinter(settings.terminalPosId);
    const cpl = pr?.charsPerLine ?? wrap.maxWidth;
    const t = c === ck.check ? tax : computeCheckTax(cat, c, taxExempt);
    const lines: CheckLineOut[] = c.lines
      .filter((l) => !l.transferOut && !l.isSplit && !(l.isVoid && l.amount < 0) && l.kind !== "Co" && l.kind !== "R")
      .map((l) => ({ qty: l.quantity, name: l.description, amount: lineExtended(l), indent: l.indentLevel, isMod: l.kind === "Mo" }));
    const subtotal = checkSubtotal(c);
    const total = grandTotal(subtotal, t);
    const nm = (employee?.name ?? "").trim().split(/\s+/);
    return buildCustomerCheck(
      { headerLines: wrap.headerLines, trailerLines: wrap.trailerLines, checkNo, server: employee?.name ?? "",
        guests: c.guestCount, date: new Date().toLocaleString(),
        tableLabel: c.diningTableId ? `Table ${tableNumberOf(c.diningTableId)}` : (c.tableName || undefined), reprint,
        largeTotal: pr?.printLargeTotal ?? false,
        tokens: { firstName: nm[0] ?? "", lastName: nm.slice(1).join(" "), tabName: c.tableName, subtotal, grandTotal: total } },
      lines, subtotal, t.groups.filter((g) => !g.isInclusive && g.amount).map((g) => ({ name: g.name, amount: g.amount })),
      total, c.tenders.map((x) => ({ name: x.name, amount: x.amount })),
      Math.max(0, total - c.tenders.reduce((a, x) => a + x.amount, 0)), cpl,
    );
  };

  /** POST the check with an already-resolved business date + number. */
  const postCheckWith = async (settle: boolean, bd: string, checkNo: string, c: Check = ck.check): Promise<{ ok: boolean; message: string }> => {
    const firing = settle ? [] : c.lines.filter((l) => !l.sent && (l.kind === "M" || l.kind === "Mo") && !l.isVoid && !l.transferOut);
    const t = c === ck.check ? tax : computeCheckTax(cat, c, taxExempt);
    const res = await sendCheck(settings.enterpriseServerUrl, { ...c, checkNumber: checkNo }, buildCtx(bd, checkNo), { settle, taxGroups: taxGroupsForWire(t) });
    if (res.ok) {
      ck.markSent(settle);
      lastReceiptRef.current = buildReceiptText(checkNo, false, c);   // remember for Reprint Last Check
      if (!settle && firing.length) void printPrepChits(firing, checkNo); // fire kitchen chits
    }
    return { ok: res.ok, message: res.message };
  };

  /** POST the check — kitchen fire (settle=false) or settle+close (settle=true). */
  const postCheck = async (settle: boolean, c?: Check): Promise<{ ok: boolean; message: string }> => {
    if (!employee) return { ok: false, message: "No employee signed in" };
    try {
      const { bd, checkNo } = await ensureSession();
      return await postCheckWith(settle, bd, checkNo, c);
    } catch (e) { return { ok: false, message: String((e as Error).message ?? e) }; }
  };

  const doSend = async () => {
    setSending(true); setSendError("");
    const r = await postCheck(false, withAutoGrat());
    if (!r.ok) setSendError(r.message);
    setSending(false);
  };

  const settle = () => postCheck(true);

  /** Native gift/loyalty <Payment> processing (balance inquiry + redeem). */
  const processGift = async (card: string, type: GiftType | LoyaltyType, amount: number): Promise<PaymentResult> => {
    if (!employee) return { ok: false, status: "", message: "No employee", fields: {} };
    const loyalty = type.startsWith("Loyalty");
    if (loyalty && !isNativeLoyalty(store)) return { ok: false, status: "", message: "Third-party loyalty is out of scope", fields: {} };
    if (!loyalty && !isNativeGift(store)) return { ok: false, status: "", message: "Third-party gift card is out of scope", fields: {} };
    try {
      const { bd, checkNo } = await ensureSession();
      // Native <Payment> processing references a check the server already knows —
      // post the check first if it hasn't been sent (server: "Check not posted").
      if (ck.check.traysSent === 0) {
        const r = await postCheckWith(false, bd, checkNo);
        if (!r.ok) return { ok: false, status: "", message: `Send check first: ${r.message}`, fields: {} };
      }
      const pctx: PaymentContext = {
        enterpriseServerUrl: settings.enterpriseServerUrl, isisVer: ISIS_VER, storeId: settings.storeId,
        terminalPosId: settings.terminalPosId, securityToken: settings.token, businessDateId: bd,
        merchantId: loyalty ? store.loyaltyMerchantId : store.gcMerchantId,
        merchantPassword: loyalty ? store.loyaltyMerchantPassword : store.gcMerchantPassword,
        operatorId: employee.id, invoiceNo: checkNo, checkKey: ck.check.id,
      };
      return await sendPayment(type, pctx, { card, amount });
    } catch (e) { return { ok: false, status: "ERROR", message: String((e as Error).message ?? e), fields: {} }; }
  };

  /** Run `onOk` directly if the signed-in employee holds `action`, else prompt
   *  for a manager PIN (the authorizer must hold the permission). */
  /** Run `onOk` if the signed-in employee can `action` (a manager may authorize
   *  anything). `force` demands a manager prompt even when they could (e.g. an
   *  adjustment flagged Requires_Auth). Otherwise it prompts for an authorizing
   *  employee's ID + PIN. */
  const requireAuth = (force: boolean, title: string, action: AuthAction, onOk: (a: Authorizer) => void) => {
    if (!force && employee && can(employee.id, action)) { onOk({ id: employee.id, name: employee.name }); return; }
    setPendingAuth({ title, action, onOk });
  };

  /** Clock in to a job (Time_Card post) and record the shift. Used by the
   *  post-login gate; ordering is blocked until this succeeds. */
  const clockInPost = async (job: Job, defaultRoomId = ""): Promise<{ ok: boolean; sequence: string; message: string }> => {
    if (!employee) return { ok: false, sequence: "", message: "No employee" };
    try {
      const bd = await ensureBd();
      const r = await clockIn(sessionCfg(), { businessDateId: bd, empPosId: employee.id, jobPosId: job.id, rate: job.regularRate, defaultRoomId });
      // Already-clocked-in means the employee is on the clock — proceed as success.
      return { ok: r.ok || r.alreadyClockedIn, sequence: r.sequence, message: r.message };
    } catch (e) { return { ok: false, sequence: "", message: String((e as Error).message ?? e) }; }
  };
  /** Finalize the shift (after clock-in + optional default-room pick) → opens ordering. */
  const printClockChit = (action: "IN" | "OUT", jobName: string, rate?: number) => {
    const pr = checkPrinter(settings.terminalPosId);
    if (!pr || !employee) return;
    const job = buildClockChit({ storeName: settings.storeName || settings.storeId, empName: employee.name, action, jobName, time: new Date().toLocaleString(), rate }, pr.charsPerLine);
    void printTo(pr, job, { enterpriseCode: settings.enterpriseCode, storeId: settings.storeId, backup: backupPrinter(pr) });
  };

  const commitShift = (c: { jobId: string; jobName: string; sequence: string; defaultRoomId: string }) => {
    if (!employee) return;
    setClock({ empId: employee.id, ...c });
    printClockChit("IN", c.jobName, empJobs.find((j) => j.id === c.jobId)?.regularRate); // clock-in chit
    if (empJobs.find((j) => j.id === c.jobId)?.timeclockOnly) { signOut(); return; } // clock-only job: back to the login keypad
    setFloorRoomId(c.defaultRoomId);
    setMode(landingMode(employee.id, c.jobId)); // Skip_Table job → check screen, otherwise the table layout
  };
  /** Clock out — refused while the employee still owns an open check or has a
   *  tender awaiting finalization (OtherMenuViewController pressClockOut:
   *  hasOpenChecks: / hasUnfinalizedTenders: → "Please close all of your checks
   *  before clocking out"). Only then is the Time_Card_Post sent. */
  const doClockOut = async () => {
    setMgrBusy(true); setMgrStatus("Checking for open checks…");
    if (clock && employee) {
      try {
        const bd = await ensureBd();
        const [open, unfinalized] = await Promise.all([
          fetchOpenChecks(sessionCfg(), bd, { empPosId: employee.id }),
          fetchUnfinalizedTenders(sessionCfg(), { businessDateId: bd, empPosId: employee.id }),
        ]);
        const mine = open.filter((o) => o.empPosId === employee.id);
        if (mine.length || unfinalized.length) {
          setMgrStatus(mine.length
            ? `Please close all of your checks before clocking out (${mine.length} open: ${mine.map((o) => o.checkNo).join(", ")})`
            : `Please finalize your payments before clocking out (${unfinalized.length} unfinalized)`);
          setMgrBusy(false); return;
        }
      } catch (e) { setMgrStatus(`Cannot verify open checks: ${String((e as Error).message ?? e)}`); setMgrBusy(false); return; }
    }
    setMgrStatus("Clocking out…");
    try {
      if (clock && employee) { const bd = await ensureBd(); await clockOut(sessionCfg(), { businessDateId: bd, empPosId: employee.id, sequence: clock.sequence }); }
    } catch { /* clock out locally regardless of the server result */ }
    printClockChit("OUT", clock?.jobName ?? ""); // clock-out chit
    setMgrBusy(false); setShowManager(false); endShift();
  };

  const doNoSale = () => {
    requireAuth(false, "Authorize no-sale", "noSale", () => setMgrStatus("Drawer opened (no sale)"));
  };

  const doCancelCheck = () => {
    requireAuth(false, "Authorize cancel check", "manager", async () => {
      setMgrBusy(true); setMgrStatus("Cancelling…");
      try {
        const { bd, checkNo } = await ensureSession();
        const res = await sendCheck(settings.enterpriseServerUrl, { ...ck.check, checkNumber: checkNo }, buildCtx(bd, checkNo), { cancel: true, taxGroups: taxGroupsForWire(tax) });
        if (res.ok) { await releaseLock(); ck.reset(rcId); setShowManager(false); setMgrStatus("Check cancelled"); }
        else setMgrStatus(res.message);
      } catch (e) { setMgrStatus(String((e as Error).message ?? e)); }
      setMgrBusy(false);
    });
  };

  /** Discount / service charge (I-12, I-13): item-level, like the iPad's
   *  addAdjustmentsToLineItems — the SELECTED menu items, or every live item when
   *  nothing is selected; items outside the adjustment's departments drop out; the
   *  same adjustment goes on an item only once. Open adjustments take their
   *  percent / amount on the pad, then applyItemAdjustments splits it per item. */
  const doDiscount = (adj: Adjustment) => {
    requireAuth(adj.requiresAuth, `Authorize ${adj.name}`, "adjust", (auth) => {
      const live = ck.check.lines.filter((l) => l.kind === "M" && !l.isVoid && !l.transferOut && !l.isSplit);
      const picked = sel.size ? live.filter((l) => sel.has(l.key)) : live;
      if (picked.length === 0) { setSendError("No items to adjust"); return; }
      const inDept = picked.filter((l) => inAdjDepartment(adj, l));
      if (inDept.length === 0) { setSendError(`${adj.name} does not apply to ${sel.size ? "the selected items" : "any item on this check"} (department)`); return; }
      const fresh = inDept.filter((it) => !ck.check.lines.some((l) => l.kind === "A" && l.parentKey === it.key && l.adjustmentId === adj.id && !l.isVoid));
      if (fresh.length === 0) { setSendError("Same discount can be only applied once to each item"); return; }
      const keys = fresh.map((l) => l.key);
      setShowManager(false); setAdjPick(null);
      if (adj.isOpen) { setAdjOpen({ adj, auth, keys }); return; }
      finishDiscount(adj, auth, keys, adj.amount);
    });
  };
  const finishDiscount = (adj: Adjustment, auth: Authorizer, keys: string[], magnitude: number) => {
    if (!(magnitude > 0)) return;
    ck.update((c) => applyItemAdjustments(c, { id: adj.id, name: adj.name, isPercentage: adj.isPercentage, isServiceCharge: adj.isServiceCharge,
      taxPackId: adj.taxPackId, affectsTaxes: adj.affectsTaxes }, magnitude, keys, auth.id));
    unselectAll(); setEditing(false);
    setSendError(`Applied ${adj.name} to ${keys.length} item(s)`);
  };

  // Void selected lines (from the check-panel select mode). Sent lines need a
  // manager auth + reason; unsent lines are just removed.
  const voidSelected = (keys: Set<string>) => {
    const sentKeys = [...keys].filter((k) => ck.check.lines.find((l) => l.key === k)?.sent);
    if (sentKeys.length === 0) { keys.forEach((k) => removeCounted(k)); return; }
    requireAuth(false, "Authorize void", "void", (auth) => setVoidReason({ keys: [...keys], auth }));
  };
  /** Void: reduce the check HERE (pure reducers) and POST that exact object — the
   *  React state update is async, so posting `ck.check` right after `ck.voidItem`
   *  serialised the pre-void check and the reversals never left the client. */
  const applyVoid = async (reasonId: string) => {
    if (!voidReason) return;
    const { keys, auth } = voidReason; setVoidReason(null);
    let next = ck.check;
    for (const k of keys) {
      const tender = next.tenders.find((t) => t.key === k);
      if (tender) { next = voidTenderLine(next, k, reasonId, auth.id); continue; }   // a posted payment (cash / offline card)
      const line = next.lines.find((l) => l.key === k);
      if (!line) continue;
      if (line.kind === "M" && !line.isVoid) countRing(line.menuItemId, -line.quantity); // isDeleting → count comes back
      next = line.sent ? voidLine(next, k, reasonId, auth.id) : removeLine(next, k);
    }
    ck.loadCheck(next);
    if (unsentLines(next).length === 0 && !next.tenders.some((t) => !t.sent)) { setSendError("Void applied"); return; } // only unsent lines/tenders were removed
    setSending(true);
    try {
      const { bd, checkNo } = await ensureSession();
      const res = await sendCheck(settings.enterpriseServerUrl, { ...next, checkNumber: checkNo }, buildCtx(bd, checkNo),
        { settle: false, taxGroups: taxGroupsForWire(computeCheckTax(cat, next, taxExempt)) });
      if (res.ok) { ck.loadCheck(markRoundSent({ ...next, checkNumber: checkNo })); setSendError("Void sent"); }
      else setSendError(`Void failed: ${res.message}`);
    } catch (e) { setSendError(`Void failed: ${String((e as Error).message ?? e)}`); }
    setSending(false);
  };

  if (!employee) return (
    <Login
      settings={settings}
      usePin={store.usePin}
      lookup={(id) => { const e = empList.find((x) => x.id === id); return e ? { id: e.id, name: e.name, pin: e.pin } : null; }}
      onLogin={signIn}
      status={defsStatus}
      onTerminalName={() => void pullDefs(true)}
      isManager={(id) => jobsForEmployee(id).some((j) => j.mgrMenu)}
    />
  );

  // While checking the server for an existing shift.
  // In-app stand-in for the iOS local notification: tap = open the inbox; fades after 8 s.
  const toastEl = toast ? (
    <div className="msgtoast" onClick={openMessages}>
      <div className="mtfrom">{toast.fromName ? toast.fromName.split(",").reverse().join(" ").trim() : (empList.find((e) => e.id === toast.fromEmpId)?.name ?? "Message")}</div>
      <div className="mttext">{toast.subject ? `${toast.subject}: ${toast.body}` : toast.body}</div>
    </div>
  ) : null;

  if (!clock && signingIn) return (
    <div className="login"><div className="loginpad"><div className="loginprompt">Signing in…</div></div>{toastEl}</div>
  );
  // Gate ordering on clock-in (job → clock-in → default dining room).
  if (!clock) return (
    <>{toastEl}<ClockInGate employee={employee} jobs={empJobs} rooms={rooms} onClockIn={clockInPost} onCommit={commitShift} onCancel={signOut} /></>
  );

  // Dashboard (iOS DashboardViewController / check-screen dashboardButton) —
  // functions (clock in/out, no sale, discount, cancel check), station, sign out.
  const hubMenu = (
    <div className="backdrop" onClick={() => setShowHub(false)}>
      <div className="hubbox" onClick={(e) => e.stopPropagation()}>
        <div className="hubtitle">{settings.storeName || settings.storeId} · {employee.name}</div>
        <button className="hubrow" onClick={() => { setShowHub(false); void goToTabs(); }}>Open checks</button>
        <button className="hubrow" onClick={() => { setShowHub(false); if (blockIfUnsent()) return; setMgrStatus(""); setShowManager(true); }}>Functions</button>
        <button className="hubrow" onClick={() => { setShowHub(false); if (blockIfUnsent()) return; onChangeStation(); }}>Change station</button>
        <button className="hubrow danger" onClick={() => { setShowHub(false); void doSignOut(); }}>Sign Out</button>
        <button className="hubrow ghost" onClick={() => setShowHub(false)}>Close</button>
      </div>
    </div>
  );

  // Cover-count pad (guestCountPad on table open) — must render in the FLOOR branch too,
  // since that's where an empty table is tapped.
  const coverPad = coverPrompt && (
    <NumberPad title={`Table ${coverPrompt.name}`} sub="Number of guests" mode="count" onOk={(n) => openTableWithCovers(coverPrompt, n)} onCancel={() => setCoverPrompt(null)} />
  );

  // A clock-only job (LoginManager currentJobClockOnly) gets no POS at all — just the
  // Dashboard so the employee can clock out.
  if (empJobs.find((j) => j.id === clock.jobId)?.timeclockOnly) {
    return (
      <div className="login">
        <div className="cinbox">
          <div className="cinname">{employee.name}</div>
          <div className="cinprompt">Clocked in · {clock.jobName}</div>
          <div className="hint">This job is time clock only — no POS functions.</div>
          <div className="mgrlist">
            <button className="mgrrow" disabled={mgrBusy} onClick={() => void doClockOut()}>{mgrBusy ? mgrStatus || "Clocking out…" : "Clock Out"}</button>
            <button className="mgrrow" onClick={() => void doSignOut()}>Sign Out</button>
          </div>
        </div>
      </div>
    );
  }

  /** Manager's Menu → Terminal: confirm before de-activating (rendered in BOTH the manager branch and the main screen). */
  const unsentModal = unsentAlert ? (
        <div className="backdrop" onClick={() => setUnsentAlert(false)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Unsent Items</div>
            <div className="authsub">Please send or delete unsent items</div>
            <div className="mfactions">
              <button className="mfbtn go" onClick={() => setUnsentAlert(false)}>OK</button>
            </div>
          </div>
        </div>
  ) : null;
  const terminalConfirm = confirmTerminal ? (
        <div className="backdrop" onClick={() => setConfirmTerminal(false)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Re-activate this terminal?</div>
            <div className="authsub">This removes the current activation. You will need the enterprise credentials to activate it again.</div>
            <div className="mfactions">
              <button className="mfbtn ghost" onClick={() => setConfirmTerminal(false)}>Cancel</button>
              <button className="mfbtn go" onClick={() => { setConfirmTerminal(false); onChangeStation(); }}>Re-activate</button>
            </div>
          </div>
        </div>
  ) : null;


  if (mode === "manager") {
    return (<>
      <ManagerMenu
        storeName={settings.storeName || settings.storeId} employeeName={employee.name} jobName={clock.jobName}
        status={mgrStatus} busy={mgrBusy} unread={msgs.unread}
        actions={{
          messages: () => openMessages(),
          queryByTable: () => { if (blockIfUnsent()) return; setMode("floor"); void refreshOpenChecks(); },
          openChecks: () => { if (blockIfUnsent()) return; setTabsFromManager(true); setMode("tabs"); void refreshOpenChecks(); },
          clockOut: () => void doClockOut(),
          terminal: () => setConfirmTerminal(true),
          exit: () => void doSignOut(),
        }}
      />
      {terminalConfirm}
      {toastEl}
      {unsentModal}
    </>);
  }

  if (mode === "floor") {
    return (<>
      {coverPad}
      {toastEl}
      {showHub && hubMenu}
      {showManager && perms && (
        <ManagerPanel
          employee={employee} perms={perms} clocked={clock} jobs={empJobs} adjustments={adjustmentDefs}
          hasCheck={ck.check.lines.length > 0} busy={mgrBusy} status={mgrStatus}
          onClockIn={(j) => { void clockInPost(j).then((r) => { if (r.ok) commitShift({ jobId: j.id, jobName: j.name, sequence: r.sequence, defaultRoomId: "" }); }); }}
          onClockOut={doClockOut} onNoSale={doNoSale} onCancelCheck={doCancelCheck}
          onDiscount={doDiscount} onClose={() => setShowManager(false)}
        />
      )}
      <Floorplan
        storeName={settings.storeName || settings.storeId}
        employeeName={employee.name}
        rooms={rooms}
        tables={tables}
        occupancy={occupancy}
        onPick={pickTable}
        onQuickSale={quickSale}
        onMessages={openMessages} unread={msgs.unread}
        onRefresh={refreshOpenChecks}
        onSignOut={() => void doSignOut()}
        onDashboard={() => setShowHub(true)}
        loading={floorLoading}
        status={floorStatus}
        transferMode={transferMode || !!transferItemKeys}
        onCancelTransfer={() => { setTransferMode(false); setTransferItemKeys(null); setXferEmp(null); setMode("order"); }}
        roomId={floorRoomId} onRoomChange={setFloorRoomId}
      />
    </>);
  }

  // Edit Check functions (ground-truth getEditCheckButton set). Wired here to the
  // behaviors we have; the rest render disabled until built. Selection-based ones
  // (Void, Split, Change Price) act on the lines picked in the check panel.
  // Text Check — SMS the guest a link to the web receipt (Post_Message, Send_SMS=1).
  const doTextCheck = async () => {
    const phone = window.prompt("Text the check to (phone number):", "");
    if (!phone || !phone.trim()) return;
    try {
      const bd = await ensureBd();
      const url = checkHtmlUrl({
        imageServerUrl: store.imageServerUrl, enterpriseId: store.enterpriseId, enterpriseCode: settings.enterpriseCode,
        storeId: settings.storeId, token: settings.token, businessDateId: bd, checkNo: ck.check.checkNumber ?? "", checkKey: ck.check.id,
      });
      const r = await sendTextCheck(sessionCfg(), { phone: phone.trim(), empPosId: employee!.id, body: url });
      setSendError(r.ok ? `Texted the check to ${phone.trim()}` : `Text failed: ${r.message}`);
    } catch (e) { setSendError(String((e as Error).message ?? e)); }
  };

  const runMemberSearch = async (q: string) => {
    const query = q.trim();
    if (!query) return;
    setMemberBox((b) => (b ? { ...b, busy: true, msg: "Searching…", results: [] } : b));
    const byCode = /^\d{4,}$/.test(query); // a numeric card number → AR-code search, else by name
    const r = await memberLookup(settings.enterpriseCode, byCode ? { code: query } : { name: query });
    setMemberBox((b) => (b ? { ...b, busy: false, msg: r.message, results: r.members } : b));
  };

  /** On settle: print the paid receipt to the check printer and pop the cash
   *  drawer for cash / drawer-opening tenders (PrintManager printReceipt + drawer
   *  kick). Call before the check is reset (needs its tenders). */
  const printSettleReceipt = () => {
    const pr = checkPrinter(settings.terminalPosId);
    if (!pr) return;
    let text = buildReceiptText(ck.check.checkNumber ?? "", false);
    const opensDrawer = ck.check.tenders.some((t) => { const def = payTenders.find((pt) => pt.id === t.tenderId); return def?.openCashDrawer || def?.isCash; });
    if (opensDrawer) text += DRAWER_KICK;
    lastReceiptRef.current = text;
    void printTo(pr, text, { enterpriseCode: settings.enterpriseCode, storeId: settings.storeId, backup: backupPrinter(pr) });
  };

  /** Print the current check to the terminal's check printer (Print button).
   *  Print is a Send & Stay first (Geoff 2026-10-13, iOS parity): any unsent lines
   *  go to the kitchen/server before the guest check prints, so a printed check
   *  can never exist for lines the server has not seen. A failed send prints nothing. */
  const doPrintCheck = async () => {
    const pr = checkPrinter(settings.terminalPosId);
    if (!pr) { setSendError("No check printer assigned"); return; }
    let c: Check;
    if (unsentLines(ck.check).length > 0 || ck.check.tenders.some((t) => !t.sent)) {
      setSending(true); setSendError("");
      const r = await postCheck(false, withAutoGrat());
      setSending(false);
      if (!r.ok) { setSendError(r.message); return; }
      c = checkRef.current; // post-send state (this closure's ck.check is stale after the await)
    } else {
      c = withAutoGrat();
    }
    const text = buildReceiptText(c.checkNumber ?? "", false, c);
    lastReceiptRef.current = text;
    void printTo(pr, text, { enterpriseCode: settings.enterpriseCode, storeId: settings.storeId, backup: backupPrinter(pr) });
    setSendError(`Printing check to ${pr.name}`);
  };

  const doReprintLast = () => {
    const pr = checkPrinter(settings.terminalPosId);
    if (!pr) { setSendError("No check printer assigned"); return; }
    if (!lastReceiptRef.current) { setSendError("No check to reprint yet"); return; }
    void printTo(pr, lastReceiptRef.current, { enterpriseCode: settings.enterpriseCode, storeId: settings.storeId, backup: backupPrinter(pr) });
    setSendError("Reprinting last check");
  };

  /* ---- Split Check screen: Split Guest (chksplit) / Transfer Item (lixfer) ---- */
  const openSplit = (kind: SplitKind, auth: Authorizer, preselect?: Set<string>) => {
    setSplitErr(""); setSplitMode({ kind, preselect, auth }); void refreshOpenChecks();
  };
  const unlockSplitLocks = async () => {
    const locks = splitLocks.current; splitLocks.current = [];
    for (const l of locks) await unlockCheck(sessionCfg(), { checkNo: l.checkNo, checkKey: l.checkKey, businessDateId: l.bd }).catch(() => undefined);
  };
  /** An existing open check as a destination column: lock it and read it back
   *  (same as picking it up); it stays locked until Apply posts it or Cancel. */
  const loadSplitDest = async (occ: OpenCheck): Promise<Check | null> => {
    try {
      const bd = occ.businessDateId || (await ensureBd());
      const lock = await lockCheck(sessionCfg(), { checkNo: occ.checkNo, checkKey: occ.checkKey, businessDateId: bd });
      if (!lock.ok) { setSplitErr(lock.alreadyLocked ? `Check ${occ.checkNo} is open on another terminal` : `Could not lock check ${occ.checkNo}: ${lock.message}`); return null; }
      const names = {
        menuItemName: (id: string) => cat.miById.get(id)?.name ?? `#${id}`,
        tenderName: (id: string) => payTenders.find((t) => t.id === id)?.name ?? `#${id}`,
        adjustmentName: (id: string) => adjustmentDefs.find((a) => a.id === id)?.name ?? `#${id}`,
      };
      const pulled = await readCheck(sessionCfg(), { checkNo: occ.checkNo, checkKey: occ.checkKey, businessDateId: bd }, names);
      if (!pulled) { await unlockCheck(sessionCfg(), { checkNo: occ.checkNo, checkKey: occ.checkKey, businessDateId: bd }); setSplitErr(`Check ${occ.checkNo} not found on the server`); return null; }
      splitLocks.current.push({ checkNo: occ.checkNo, checkKey: occ.checkKey, bd });
      return { ...pulled, businessDateId: bd };
    } catch (e) { setSplitErr(String((e as Error).message ?? e)); return null; }
  };
  const cancelSplit = () => { void unlockSplitLocks(); setSplitMode(null); setSplitErr(""); };

  /** Merge With Another Check (APPROVE_TRANSFER): the CURRENT check is the source
   *  and goes onto the picked open check. Fires unsent first, locks + reads the
   *  destination, then POSTs destination (copies) → source (Is_Transferred=1 +
   *  CheckMerge note), exactly the iPad's order. The current check then leaves us. */
  const doMerge = async (occ: OpenCheck, auth: Authorizer) => {
    if (!employee) return;
    setMergePick(null);
    if (blockIfUnsent()) return;
    setSending(true); setSendError("");
    try {
      const { bd, checkNo: srcNo } = await ensureSession();
      if (occ.checkNo === srcNo) { setSendError("You cannot merge a check with itself."); return; }
      const dest0 = await loadSplitDest(occ);
      if (!dest0) { setSendError(splitErr || `Couldn't open check ${occ.checkNo}`); return; }
      const nm = auth.name.trim().split(/\s+/);
      const authName = nm.length > 1 ? `${nm[nm.length - 1]},${nm.slice(0, -1).join(" ")}` : auth.name || " ";
      const src0 = { ...ck.check, checkNumber: srcNo, lines: ck.check.lines.map((l) => ({ ...l, sent: true })) };
      const { dest, source } = mergeInto(dest0, src0, authName);
      const r1 = await sendCheck(settings.enterpriseServerUrl, dest, buildCtx(dest.businessDateId || bd, dest.checkNumber!), { settle: false, taxGroups: taxGroupsForWire(computeCheckTax(cat, dest)) });
      if (!r1.ok) { setSendError(`Unable to post merged check ${dest.checkNumber}: ${r1.message}`); await unlockSplitLocks(); return; }
      const r2 = await sendCheck(settings.enterpriseServerUrl, source, buildCtx(bd, srcNo), { settle: false, transferred: true, taxGroups: taxGroupsForWire(computeCheckTax(cat, source, taxExempt)) });
      await unlockSplitLocks();
      if (!r2.ok) { setSendError(`Merged into ${dest.checkNumber}, but the source check could not be closed (${r2.message}). Please report this to a manager.`); }
      else setSendError(`Check ${srcNo} merged into ${dest.checkNumber}`);
      await releaseLock();
      const wasTable = !!ck.check.diningTableId;
      ck.reset(rcId); setEditing(false);
      setMode(wasTable ? "floor" : "tabs"); void refreshOpenChecks();
    } catch (e) { setSendError(String((e as Error).message ?? e)); await unlockSplitLocks(); }
    finally { setSending(false); }
  };
  /** Apply: run the plan through the core, then POST the source (its Transfered_Out
   *  void-offs; Is_Closed=1 if it emptied) and each destination — new checks get a
   *  fresh number; existing ones are re-POSTed and unlocked. Already-sent items
   *  don't re-fire to the kitchen (they ride as copies, no prep chits). */
  const applySplit = async (plan: SplitPlan) => {
    if (!splitMode || !employee) return;
    setSplitBusy(true); setSplitErr("");
    try {
      const { bd, checkNo: srcNo } = await ensureSession();
      const src0 = { ...ck.check, checkNumber: srcNo };
      const run = applyMovePlan(src0, plan.targets, {
        moveKind: splitMode.kind, srcCheckNo: srcNo, authEmpId: splitMode.auth.id,
        newCheck: (name, t) => {
          // undefined = same table/tab as the source · null = Transfer To Tab · id = Transfer To Table
          const table = t.tableId === undefined ? src0.diningTableId : (t.tableId || undefined);
          const rc = table ? (tables.find((x) => x.id === table)?.revenueCenterId || src0.revenueCenterId) : src0.revenueCenterId;
          return {
            ...newCheck(rc, table ? "" : name, 1, table), // Check_Name only for tabs
            checkNumber: mintCheckNumber(settings.terminalPosId), employeePosId: src0.employeePosId ?? employee.id,
          };
        },
      });
      if (run.dests.length === 0) { setSplitErr("Nothing to move — drag items to a check first."); return; }
      const r1 = await sendCheck(settings.enterpriseServerUrl, run.source, buildCtx(bd, srcNo),
        { settle: false, close: run.closeSource, taxGroups: taxGroupsForWire(computeCheckTax(cat, run.source, taxExempt)) });
      if (!r1.ok) { setSplitErr(`Source check ${srcNo}: ${r1.message}`); return; }
      const landed: string[] = [];
      for (const { target, dest } of run.dests) {
        const r2 = await sendCheck(settings.enterpriseServerUrl, dest, buildCtx(dest.businessDateId || bd, dest.checkNumber!), // an existing destination keeps its own business date
          { settle: false, taxGroups: taxGroupsForWire(computeCheckTax(cat, dest)) });
        if (!r2.ok) { setSplitErr(`Check ${dest.checkNumber}: ${r2.message} (source already posted)`); return; }
        if (target.kind === "existing") {
          const l = splitLocks.current.find((x) => x.checkNo === dest.checkNumber);
          if (l) { splitLocks.current = splitLocks.current.filter((x) => x !== l); await unlockCheck(sessionCfg(), { checkNo: l.checkNo, checkKey: l.checkKey, businessDateId: l.bd }).catch(() => undefined); }
        }
        landed.push(`${target.keys.size} → ${target.kind === "existing" ? "check" : "new check"} ${dest.checkNumber}`);
      }
      await unlockSplitLocks();
      setSplitMode(null); setEditing(false); unselectAll();
      if (run.closeSource) { await releaseLock(); ck.reset(rcId); setMode(src0.diningTableId ? "floor" : "tabs"); }
      else ck.loadCheck(markRoundSent(run.source));
      setSendError(landed.join(" · "));
      void refreshOpenChecks();
    } catch (e) { setSplitErr(String((e as Error).message ?? e)); }
    finally { setSplitBusy(false); }
  };

  /** Change Guest: g = 0 means whole table (applied_to_guests="0"). Sent lines are
   *  changed LIVE on the server (updateGuestForLineItems :11416-11454 → Trans_Type
   *  "Modify" Guest_Num); unsent ones just ride the next POST. */
  const applyGuestChange = (keys: Set<string>, g: number) => {
    const fam = new Set<string>();
    for (const l of ck.check.lines) if (keys.has(l.key) || (l.parentKey && fam.has(l.parentKey))) fam.add(l.key);
    const sentLines = ck.check.lines.filter((l) => fam.has(l.key) && l.sent && l.trayNumber && l.lineNumber);
    const checkNo = ck.check.checkNumber, checkKey = ck.check.id, bdOfCheck = ck.check.businessDateId;
    ck.setGuestFor(keys, g); unselectAll(); setGuestPick(null);
    if (sentLines.length && checkNo) {
      void (async () => {
        try {
          const bd = bdOfCheck || (await ensureBd());
          for (const l of sentLines) {
            const r = await modifyLineItem(sessionCfg(), { businessDateId: bd, checkNo, checkKey, trayNumber: l.trayNumber!, lineNumber: l.lineNumber!, field: "Guest_Num", value: String(g) });
            if (!r.ok) { setSendError(`Guest change not saved on the server: ${r.message}`); return; }
          }
          setSendError(`Guest changed on ${sentLines.length} sent line(s)`);
        } catch (e) { setSendError(String((e as Error).message ?? e)); }
      })();
    }
  };

  // Change Price needs exactly one selected, unsent menu item (iOS CHANGE_PRICE).
  const priceTarget = sel.size === 1 ? ck.check.lines.find((l) => l.key === [...sel][0] && l.kind === "M" && !l.sent) : undefined;
  // Re-order needs at least one selected sent menu item.
  const canReorder = [...sel].some((k) => { const l = ck.check.lines.find((x) => x.key === k); return l?.kind === "M" && l.sent; });
  // Transfer Item needs selected menu items that are all already sent (iOS rejects unsent).
  const selLines = [...sel].map((k) => ck.check.lines.find((x) => x.key === k)).filter(Boolean);
  const canTransferItem = selLines.length > 0 && selLines.some((l) => l!.kind === "M") &&
    selLines.every((l) => (l!.kind === "M" || l!.kind === "Mo") && l!.sent);

  const editActions: EditCheckActions = {
    discount: () => setAdjPick("discount"),
    serviceCharge: () => setAdjPick("service"),
    voidSelected: sel.size ? () => voidSelected(new Set(sel)) : undefined,   // VOID_AUTH inside
    splitItem: sel.size ? () => setSplitGuests(new Set()) : undefined,          // divide among guests (splitItemsForGuests)
    refire: (store.allowRefire && sel.size && [...sel].every((k) => { const l = ck.check.lines.find((x) => x.key === k); return l?.kind === "M" && l.sent && !l.isVoid; }))
      ? () => {
          const fam = new Set<string>();
          for (const l of ck.check.lines) if (sel.has(l.key) || (l.parentKey && fam.has(l.parentKey))) fam.add(l.key);
          void printPrepChits(ck.check.lines.filter((l) => fam.has(l.key) && (l.kind === "M" || l.kind === "Mo")), ck.check.checkNumber ?? "", { refire: true });
          unselectAll(); setEditing(false); setSendError("Refire sent to the kitchen");
        }
      : undefined,
    selectAll, unselectAll,
    transferCheck: ck.check.lines.length ? () => setXferPick("menu") : undefined, // Person / Table / Person And Table / Merge
    mergeCheck: ck.check.lines.length ? () => requireAuth(false, "Authorize merge checks", "transfer", (a) => { setMergePick(a); void refreshOpenChecks(); }) : undefined,
    searchMenu: () => { setEditing(false); },                                  // back to the menu (search lives there)
    changeRc: () => requireAuth(false, "Authorize change revenue center", "manager", () => setShowRcPick(true)),
    nameTab: () => { const v = window.prompt("Name this tab:", ck.check.tableName); if (v !== null) ck.setTable(v.trim()); },
    guestCount: () => { const v = Number(window.prompt("Guest count:", String(ck.check.guestCount)) ?? ""); if (v >= 1) ck.setGuests(Math.floor(v)); },
    changeGuest: sel.size ? () => setGuestPick(new Set(sel)) : undefined,   // guest pad (GuestSelection) → applyGuestChange
    changeCourse: sel.size && !store.useSyphor ? () => setCoursePick({ mode: "lines", keys: [...sel] }) : undefined,
    removeTax: tax.groups.some((g) => !g.isExempt)
      ? () => requireAuth(false, "Authorize remove tax", "removeTax", () => setShowTaxPick(true))
      : undefined,
    removeAllTax: tax.groups.some((g) => !g.isExempt)
      ? () => requireAuth(false, "Authorize remove all tax", "removeTax", () => setTaxExempt((prev) => new Set([...prev, ...tax.groups.map((g) => g.reportGroupId)])))
      : undefined,
    changePrice: priceTarget
      ? () => requireAuth(false, "Authorize change price", "overridePrice", () => {
          const v = Number(window.prompt(`New price for ${priceTarget.description}:`, priceTarget.amount.toFixed(2)) ?? "");
          if (v >= 0) ck.setPrice(priceTarget.key, Math.round(v * 100) / 100);
        })
      : undefined,
    reorder: canReorder
      ? () => {
          for (const k of sel) { const l = lineOf(k); if (l?.kind === "M" && !l.isVoid) countRing(l.menuItemId, l.quantity); } // reorderItems decrements again
          ck.reorder(new Set(sel)); setEditing(false);
        }
      : undefined,
    holdUnhold: sel.size ? () => { ck.holdUnhold(new Set(sel)); unselectAll(); } : undefined,
    sortGuest: () => setSortByGuest((s) => !s),
    textCheck: (ck.check.checkNumber && unsentLines(ck.check).length === 0) ? () => void doTextCheck() : undefined,
    splitGuest: (ck.check.checkNumber && unsentLines(ck.check).length === 0 && employee)
      ? () => openSplit("chksplit", { id: employee.id, name: employee.name })
      : undefined,
    reprintLast: lastReceiptRef.current ? () => doReprintLast() : undefined,
    transferItem: canTransferItem ? () => requireAuth(false, "Authorize transfer item", "transfer", (a) => openSplit("lixfer", a, new Set(sel))) : undefined,
  };

  if (mode === "messages") {
    const mgrJobs = empJobs.some((j) => j.mgrMenu) ? jobs().filter((j) => !j.timeclockOnly).map((j) => ({ id: j.id, name: j.name })) : [];
    return (
      <div className="pos">
        <TopBar
          onLogout={() => void doSignOut()} onTables={() => { closeMessages(); void goToFloor(); }} onTabs={() => { closeMessages(); void goToTabs(); }}
          onHub={() => setShowHub(true)} onEdit={() => {}} editing={false}
          onSendStay={() => {}} onSend={() => {}} onPay={() => {}}
          canSend={false} canSendExit={false} canPay={false} sending={false}
          onMessages={closeMessages} unread={msgs.unread}
        />
        <MessagesView
          messages={msgs.messages} loading={msgs.loading} error={msgs.error}
          empName={(id) => empList.find((e) => e.id === id)?.name ?? ""}
          employees={empList.filter((e) => e.id !== employee.id).map((e) => ({ id: e.id, name: e.name }))}
          jobs={mgrJobs}
          employeesInJob={(jobId) => employeeJobs().filter((ej) => ej.jobId === jobId).map((ej) => ej.empId)}
          onBack={closeMessages} onRefresh={() => void msgs.refresh()}
          onMarkRead={(id) => void msgs.markRead(id)} onMarkAllRead={() => void msgs.markAllRead()}
          onSend={sendFromCompose}
        />
        {showHub && hubMenu}
      </div>
    );
  }

  if (mode === "tabs") {
    return (
      <div className="pos">
        <TopBar
          onLogout={() => void doSignOut()} onTables={() => void goToFloor()} onTabs={() => void goToTabs()}
          onHub={() => setShowHub(true)} onEdit={() => {}} editing={false}
          onSendStay={() => {}} onSend={() => {}} onPay={() => {}}
          canSend={false} canSendExit={false} canPay={false} sending={floorLoading}
          onMessages={openMessages} unread={msgs.unread}
        />
        <TabsView
          openChecks={openChecks}
          nameForTable={(id) => tables.find((t) => t.id === id)?.name ?? id}
          nameForEmp={(id) => empList.find((e) => e.id === id)?.name ?? ""}
          onPick={(occ) => void pickCheck(occ)}
          onNewTab={() => { if (blockIfUnsent()) { setMode("order"); return; } void releaseLock(); ck.reset(rcId); setSendError(""); setMode("order"); }}
          onRefresh={refreshOpenChecks}
          loading={floorLoading}
          status={floorStatus}
          onBack={tabsFromManager ? () => { setTabsFromManager(false); setMode("manager"); } : undefined}
          myEmpId={employee.id}
          mineOnly={tabsMineOnly}
          canSeeAll={!!clock && !!empJobs.find((j) => j.id === clock.jobId)?.seeAllChecks}
          onToggleMine={() => setTabsMineOnly((v) => !v)}
        />
        {showHub && hubMenu}
        {toastEl}
      </div>
    );
  }

  return (
    <div className="pos">
      <TopBar
        onLogout={() => void doSignOut()} onTables={() => void goToFloor()} onTabs={() => void goToTabs()}
        onHub={() => setShowHub(true)} onEdit={() => setEditing((e) => !e)} editing={editing}
        onPrint={ck.check.lines.length ? () => withTabName(() => void doPrintCheck()) : undefined}
        onSendStay={() => withTabName(() => void doSendStay())} onSend={() => withTabName(() => void doSend2())} onPay={() => withTabName(() => void openPay())}
        canSend={unsentLines(ck.check).length > 0} canSendExit={ck.check.lines.length > 0} canPay={ck.check.lines.length > 0} sending={sending}
        onMessages={openMessages} unread={msgs.unread}
      />
      <div className="subbar">
        <div className="ident"><b>{settings.storeName || settings.storeId}</b><span>{settings.terminalName || settings.terminalPosId} · {employee.name}{ck.check.diningTableId ? ` · Table ${tableNumberOf(ck.check.diningTableId)}` : ""}</span></div>
        <div className="rcs">
          {cat.revenueCenters.map((rc) => (
            <button key={rc.id} className={`rc ${rc.id === rcId ? "on" : ""}`} onClick={() => changeCheckRc(rc.id)}>{rc.name}</button>
          ))}
        </div>
        <div className="tools">
          <input className="search" placeholder="Search items…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="clr" onClick={() => setQuery("")}>✕</button>}
          {ck.check.diningTableId && <button className="station" onClick={startTransfer} disabled={sending}>Move</button>}
        </div>
      </div>

      {showHub && hubMenu}

      <div className="order">
        {editing ? (
          <EditCheck
            checkNo={ck.check.checkNumber || "—"}
            kindLabel={ck.check.diningTableId ? `Table ${tableNumberOf(ck.check.diningTableId)}` : "Tab"}
            guests={ck.check.guestCount}
            subtotal={checkSubtotal(ck.check)}
            selCount={sel.size}
            actions={editActions}
          />
        ) : (
        <div className="menuside">
          <div className="menutop"><span className="mtitle">{searching ? `Search “${query.trim()}”` : (stack[stack.length - 1]?.name ?? roots[0]?.name ?? "Menu")}</span></div>
          <nav className="tabs">
            {roots.map((sg) => (
              <button key={sg.id} className={`tab ${!searching && stack[0]?.id === sg.id ? "on" : ""}`} onClick={() => selectTab(sg)}>{sg.name}</button>
            ))}
          </nav>

          {searching ? (
            <nav className="crumbs"><span className="crumb here">Search “{query.trim()}” — {items.length} item(s)</span></nav>
          ) : stack.length > 1 ? (
            <nav className="crumbs">
              {stack.map((sg, i) => (
                <span key={sg.id}>
                  {i > 0 && <span className="sep">›</span>}
                  <button className={`crumb ${i === stack.length - 1 ? "here" : ""}`} onClick={() => drillTo(i)}>{sg.name}</button>
                </span>
              ))}
            </nav>
          ) : null}

          <div className="menugrid">
            {subGroups.map((sg) => (
              <button key={`g${sg.id}`} className="tile group" style={{ background: tileColor(sg.color) }} onClick={() => enter(sg)}>
                <span className="tname">{sg.name}</span>
                <span className="tinto">›</span>
              </button>
            ))}
            {items.map((mi) => (
              <ItemTile key={`i${mi.id}`} mi={mi} count={countFor(counts, mi.id)} priceLabel={money(mi.price, mi.askForPrice)}
                onTap={() => tapItem(mi)} onLongPress={() => setItemPopup(mi)} />
            ))}
            {subGroups.length === 0 && items.length === 0 && (
              <div className="empty">{searching ? "No matching items." : "This screen has no items or sub-screens."}</div>
            )}
          </div>
        </div>
        )}

        <CheckPanel
          check={ck.check}
          tax={tax}
          revenueCenterName={cat.rcById.get(ck.check.revenueCenterId)?.name ?? ""}
          orderName={employee.name}
          onQty={setQtyCounted}
          onRemove={removeCounted}
          onSetTable={ck.setTable}
          onSetGuests={ck.setGuests}
          onSend={doSend}
          onPay={() => withTabName(() => void openPay())}
          onSplit={(keys) => { setSel(keys); setSplitGuests(new Set()); }}
          onVoid={voidSelected}
          onNewCheck={() => { if (blockIfUnsent()) return; ck.reset(rcId); setSendError(""); }}
          editing={editing}
          onEditingChange={setEditing}
          selectedKeys={sel}
          onToggleLine={toggleLine}
          sortByGuest={sortByGuest}
          tableNumber={tableNumberOf(ck.check.diningTableId)}
          currentGuest={ck.currentGuest}
          onSelectGuest={ck.setCurrentGuest}
          onAddGuest={() => { const g = ck.check.guestCount; ck.setGuests(g + 1); ck.setCurrentGuest(g); }}
          guestLocked={!!pending || !!pricePrompt}
          sending={sending}
          sendError={sendError}
          showCourse={currentRc()?.showCourse ?? false}
          courseOf={courseOfLine}
          courseLabel={courseLabelFor}
          firedCourses={firedCourses(ck.check)}
          onFireCourse={(n) => void fireCourse(n)}
          onLineLongPress={store.useSyphor ? undefined : lineLongPress}
          useCourseButtons={currentRc()?.useCourseButtons ?? false}
          addingCourse={addingCourse}
          onAddingCourse={() => setCoursePick({ mode: "adding" })}
        />
      </div>

      {splitMode && (
        <SplitCheck
          check={ck.check} kind={splitMode.kind} isTable={!!ck.check.diningTableId}
          where={ck.check.diningTableId ? `Table ${tableNumberOf(ck.check.diningTableId)}` : ck.check.tableName ? `Tab ${ck.check.tableName}` : ""}
          preselect={splitMode.preselect}
          totalFor={(lines) => { const synth = { ...ck.check, lines }; return grandTotal(checkSubtotal(synth), computeCheckTax(cat, synth, taxExempt)); }}
          openChecks={openChecks} tables={tables} rooms={rooms} occupancy={occupancy}
          loadExisting={loadSplitDest}
          onCancel={cancelSplit}
          onApply={(plan) => void applySplit(plan)}
          busy={splitBusy} error={splitErr}
        />
      )}

      {pricePrompt && (
        <NumberPad title="Enter Price" sub={pricePrompt.item.name} mode="money" onOk={finishPrice} onCancel={() => setPricePrompt(null)} />
      )}
      {coverPad}
      {toastEl}
      {tabNamePrompt && (
        <div className="backdrop" onClick={() => setTabNamePrompt(null)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Tab name</div>
            <div className="authsub">A name is required for this check</div>
            <input className="ctable tabname" autoFocus value={tabNameDraft} onChange={(e) => setTabNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && tabNameDraft.trim()) { ck.setTable(tabNameDraft.trim()); const a = tabNamePrompt.after; setTabNamePrompt(null); a(); } }} />
            <div className="mfactions">
              <button className="mfbtn ghost" onClick={() => setTabNamePrompt(null)}>Cancel</button>
              <button className="mfbtn go" disabled={!tabNameDraft.trim()} onClick={() => { ck.setTable(tabNameDraft.trim()); const a = tabNamePrompt.after; setTabNamePrompt(null); a(); }}>OK</button>
            </div>
          </div>
        </div>
      )}
      {guestPick && (
        <div className="backdrop" onClick={() => setGuestPick(null)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Change Guest</div>
            <div className="authsub">Move {guestPick.size} selected item(s) to</div>
            <div className="cguestbar center">
              {Array.from({ length: Math.max(ck.check.guestCount, 1) }, (_, i) => i + 1).map((g) => (
                <button key={g} className="gbtn" onClick={() => applyGuestChange(guestPick, g)}>{g}</button>
              ))}
              <button className="gbtn add" title="Add a guest" onClick={() => ck.setGuests(ck.check.guestCount + 1)}>+</button>
              <button className="gbtn tbtn" title="Whole table" onClick={() => applyGuestChange(guestPick, 0)}>T</button>
            </div>
            <button className="mfbtn ghost" onClick={() => setGuestPick(null)}>Cancel</button>
          </div>
        </div>
      )}
      {splitGuests && (
        <div className="backdrop" onClick={() => setSplitGuests(null)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Split Item</div>
            <div className="authsub">Divide the selected item(s) evenly among these guests</div>
            <div className="cguestbar center">
              {Array.from({ length: Math.max(ck.check.guestCount, 2) }, (_, i) => i + 1).map((g) => (
                <button key={g} className={`gbtn ${splitGuests.has(g) ? "on" : ""}`} onClick={() => setSplitGuests((s) => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n; })}>{g}</button>
              ))}
              <button className="gbtn add" onClick={() => ck.setGuests(Math.max(ck.check.guestCount, 2) + 1)}>+</button>
            </div>
            <div className="mfactions">
              <button className="mfbtn ghost" onClick={() => setSplitGuests(null)}>Cancel</button>
              <button className="mfbtn go" disabled={splitGuests.size < 2} onClick={() => {
                const guests = [...splitGuests].sort((a, b) => a - b);
                if (ck.check.guestCount < guests[guests.length - 1]) ck.setGuests(guests[guests.length - 1]);
                ck.splitAmong(new Set(sel), guests, employee?.id); unselectAll(); setSplitGuests(null);
                setSendError(`Split among ${guests.length} guests`);
              }}>Split {splitGuests.size >= 2 ? `${splitGuests.size} ways` : ""}</button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <ModifierFlow itemName={pending.item.name} steps={pending.steps} onDone={finishMods} onCancel={() => setPending(null)} />
      )}

      {showManager && perms && (
        <ManagerPanel
          employee={employee} perms={perms} clocked={clock} jobs={empJobs} adjustments={adjustmentDefs}
          hasCheck={ck.check.lines.length > 0} busy={mgrBusy} status={mgrStatus}
          onClockIn={(j) => { void clockInPost(j).then((r) => { if (r.ok) commitShift({ jobId: j.id, jobName: j.name, sequence: r.sequence, defaultRoomId: "" }); }); }}
          onClockOut={doClockOut} onNoSale={doNoSale} onCancelCheck={doCancelCheck}
          onDiscount={doDiscount} onClose={() => setShowManager(false)}
        />
      )}

      {pendingAuth && (
        <ManagerAuth
          title={pendingAuth.title} action={pendingAuth.action}
          onAuthorized={(a) => { const cb = pendingAuth.onOk; setPendingAuth(null); cb(a); }}
          onCancel={() => setPendingAuth(null)}
        />
      )}

      {voidReason && (
        <div className="backdrop" onClick={() => setVoidReason(null)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Void reason</div>
            <div className="mgrlist">
              {voidDefs.map((v) => <button key={v.id} className="mgrrow" onClick={() => applyVoid(v.id)}>{v.name}</button>)}
            </div>
            <button className="mfbtn ghost" onClick={() => setVoidReason(null)}>Cancel</button>
          </div>
        </div>
      )}

      {xferConfirm && (() => {
        const { kind, table, occs } = xferConfirm;
        const close = () => setXferConfirm(null);
        const checkNo = ck.check.checkNumber ?? "";
        if (kind === "check") {
          const who = xferEmp ? `${xferEmp.emp.name} and table ${table.name}` : `table ${table.name}`;
          const msg = occs.length === 0
            ? `Transfer check# ${checkNo} to ${who}?`
            : `There is already a check on table ${table.name}. Are you sure you want to transfer check# ${checkNo} to ${who}?`;
          return (
            <div className="backdrop" onClick={close}>
              <div className="authbox" onClick={(e) => e.stopPropagation()}>
                <div className="authtitle">Transfer Check</div>
                <div className="authsub">{msg}</div>
                <div className="mfactions">
                  <button className="mfbtn ghost" onClick={close}>Cancel</button>
                  <button className="mfbtn go" onClick={() => { close(); void transferTo(table); }}>OK</button>
                </div>
              </div>
            </div>
          );
        }
        // Transfer Items: empty table → confirm a new check; one check → New Check / Merge; several → pick
        return (
          <div className="backdrop" onClick={close}>
            <div className="authbox" onClick={(e) => e.stopPropagation()}>
              <div className="authtitle">Transfer Items</div>
              {occs.length === 0 && (
                <>
                  <div className="authsub">Transfer items to Table {table.name} and create a new check?</div>
                  <div className="mfactions">
                    <button className="mfbtn ghost" onClick={close}>No</button>
                    <button className="mfbtn go" onClick={() => { close(); void transferItemsTo(table); }}>Yes</button>
                  </div>
                </>
              )}
              {occs.length === 1 && (
                <>
                  <div className="authsub">Transfer items to a new check or Merge the check?</div>
                  <div className="mfactions">
                    <button className="mfbtn ghost" onClick={close}>Cancel</button>
                    <button className="mfbtn ghost" onClick={() => { close(); void transferItemsTo(table); }}>New Check</button>
                    <button className="mfbtn go" onClick={() => { close(); void transferItemsTo(table, occs[0]); }}>Merge</button>
                  </div>
                </>
              )}
              {occs.length > 1 && (
                <>
                  <div className="authsub">Table {table.name} has {occs.length} open checks — merge into one, or start a new check</div>
                  <div className="mgrlist">
                    {occs.map((o) => (
                      <button key={o.checkNo} className="mgrrow" onClick={() => { close(); void transferItemsTo(table, o); }}>Check {o.checkNo}<span>merge</span></button>
                    ))}
                    <button className="mgrrow" onClick={() => { close(); void transferItemsTo(table); }}>New Check</button>
                  </div>
                  <button className="mfbtn ghost" onClick={close}>Cancel</button>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {itemPopup && (() => {
        const mi = itemPopup; const close = () => setItemPopup(null);
        const n = countFor(counts, mi.id);
        return (
          <div className="backdrop" onClick={close}>
            <div className="authbox" onClick={(e) => e.stopPropagation()}>
              <div className="authtitle">{mi.name}</div>
              <div className="itemdesc">{mi.description.trim() || "No Description Available"}</div>
              {n >= 0 && <div className="authsub">{n === 0 ? "Sold out" : `${n} left`}</div>}
              {(currentRc()?.showCourse || currentRc()?.useCourseButtons) && (
                <div className="itempills" aria-label="Order into course">
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((c) => (
                    <button key={c} className={mi.printSortOrder === c ? "def" : ""} style={{ "--ch": courseHue(c) } as React.CSSProperties}
                      onClick={() => { close(); tapItem(mi, { course: c }); }}>C{c}</button>
                  ))}
                </div>
              )}
              {/* Role pills (Paul's catalog, filtered by the clocked-in job): server vs counter (bar / cashier) */}
              {(() => {
                const isServer = pillRole !== "counter", isCounter = pillRole !== "server";
                const last = lastLineOf(ck.check, mi.id);
                const seatLabel = isServer ? "Seat" : "Guest";
                return (
                  <>
                    <div className="itempills" aria-label="Order to seat">
                      {Array.from({ length: Math.max(ck.check.guestCount, highestGuestNumber(ck.check)) }, (_, i) => (
                        <button key={i} className={ck.currentGuest === i ? "def" : ""} style={{ "--ch": 200 } as React.CSSProperties} onClick={() => { close(); tapItem(mi, { guestIdx: i }); }}>{seatLabel} {i + 1}</button>
                      ))}
                      <button className={ck.currentGuest === -1 ? "def" : ""} style={{ "--ch": 45 } as React.CSSProperties} onClick={() => { close(); tapItem(mi, { guestIdx: -1 }); }}>Table</button>
                    </div>
                    <div className="itempills" aria-label="Quantity and timing">
                      {isCounter && [2, 3, 5].map((q) => (
                        <button key={q} style={{ "--ch": 30 } as React.CSSProperties} onClick={() => { close(); tapItem(mi, { qty: q }); }}>x{q}</button>
                      ))}
                      {isCounter && last && (
                        <button style={{ "--ch": 120 } as React.CSSProperties} onClick={() => { close(); repeatLast(mi); }}>Repeat last{last.rungAt ? ` (${agoLabel(last.rungAt)})` : ""}</button>
                      )}
                      {mi.modChainId && <button style={{ "--ch": 282 } as React.CSSProperties} onClick={() => { close(); tapItem(mi); }}>Add Mods</button>}
                      {isServer && <button style={{ "--ch": 0 } as React.CSSProperties} onClick={() => { close(); tapItem(mi, { held: true }); }}>Hold</button>}
                      {isServer && <button style={{ "--ch": 15 } as React.CSSProperties} onClick={() => { close(); tapItem(mi, { after: (key) => setFireNowKey(key) }); }}>Fire now</button>}
                      {isServer && <button style={{ "--ch": 342 } as React.CSSProperties} onClick={() => { close(); tapItem(mi, { after: (key) => setNotePad({ key, name: mi.name, chips: [], text: "" }) }); }}>Allergen note</button>}
                      {isServer && <button style={{ "--ch": 148 } as React.CSSProperties} onClick={() => { close(); tapItem(mi, { after: (key) => { setSel(new Set([key])); setSplitGuests(new Set()); } }); }}>Split item</button>}
                    </div>
                  </>
                );
              })()}
              {(() => {
                const paired = mi.affinityId ? cat.miById.get(mi.affinityId) : undefined;
                const pinned = pins.has(mi.id);
                return (
                  <div className="itempills" aria-label="Pairing and favorites">
                    {paired && paired.id !== mi.id && (
                      <button style={{ "--ch": 45 } as React.CSSProperties} onClick={() => { close(); tapItem(paired, { skipPairing: true }); }}>Pairs with {paired.name}</button>
                    )}
                    <button className={pinned || mi.top16 ? "def" : ""} style={{ "--ch": 260 } as React.CSSProperties} disabled={mi.top16 && !pinned} title={mi.top16 && !pinned ? "A back-office favorite (Top16)" : undefined}
                      onClick={() => { togglePin(mi.id); setSendError(pinned ? `${mi.name} unpinned` : `${mi.name} pinned to Favorites`); }}>
                      {pinned ? "★ Unpin" : mi.top16 ? "★ Favorite" : "☆ Pin to favorites"}
                    </button>
                  </div>
                );
              })()}
              {perms?.manager && mi.cost > 0 && (() => {
                const price = Number(mi.price) || 0;
                const margin = price > 0 ? Math.round(((price - mi.cost) / price) * 100) : null;
                return <div className="authsub itemcost">Cost ${mi.cost.toFixed(2)}{margin !== null ? ` · Margin ${margin}%` : ""}</div>;
              })()}
              {perms?.manager && (
                <div className="itempills mgr" aria-label="Manager">
                  {compAdj && [100, 50, 25].filter((pct) => compAdj.isOpen || compAdj.amount === pct).map((pct) => (
                    <button key={pct} style={{ "--ch": 342 } as React.CSSProperties}
                      onClick={() => { close(); tapItem(mi, { after: (key) => requireAuth(compAdj.requiresAuth, `Authorize ${compAdj.name}`, "adjust", (auth) => finishDiscount(compAdj, auth, [key], pct)) }); }}>
                      Comp {pct}%
                    </button>
                  ))}
                  <button style={{ "--ch": 210 } as React.CSSProperties}
                    onClick={() => { close(); tapItem(mi, { after: (key) => requireAuth(false, "Authorize change price", "overridePrice", () => setOverridePad({ key, name: mi.name, amount: Number(mi.price) || 0 })) }); }}>
                    Override price
                  </button>
                  <button style={{ "--ch": 15 } as React.CSSProperties}
                    onClick={() => { close(); requireAuth(false, "Authorize 86 count", "manager", (auth) => {
                      void (async () => {
                        const r = await setMenuItemCounter(sessionCfg(), { menuItemId: mi.id, counter: 0, authEmpId: auth.id });
                        setSendError(r.ok ? `${mi.name}: 86'd` : `86 failed: ${r.message}`);
                        if (r.ok) void notifyOutOfStock(mi);
                        await refreshCounts();
                      })();
                    }); }}>
                    86 from here
                  </button>
                </div>
              )}
              <div className="mgrlist">
                <button className="mgrrow" onClick={() => { close(); tapItem(mi); }}>Order Item</button>
                <button className="mgrrow" onClick={() => { close(); requireAuth(false, "Authorize 86 count", "manager", (auth) => setCountPad({ mi, auth })); }}>Manage Qty<span>set what's left</span></button>
                <button className="mgrrow" onClick={() => {
                  close();
                  void (async () => {
                    const r = await removeMenuItemCounter(sessionCfg(), { menuItemId: mi.id, authEmpId: employee?.id ?? "" });
                    setSendError(r.ok ? `${mi.name}: counter removed` : `Remove Qty failed: ${r.message}`);
                    await refreshCounts();
                  })();
                }}>Remove Qty<span>no countdown</span></button>
              </div>
              <button className="mfbtn ghost" onClick={close}>Skip</button>
            </div>
          </div>
        );
      })()}
      {pairing && (() => {
        const { mi, paired, opts, showDesc } = pairing; const close = () => setPairing(null);
        return (
          <div className="backdrop" onClick={close}>
            <div className="authbox" onClick={(e) => e.stopPropagation()}>
              <div className="authtitle">Pairs well with</div>
              <div className="authsub">{mi.name} pairs well with {paired.name}</div>
              {showDesc && <div className="itemdesc">{paired.description.trim() || "No Description for this item"}</div>}
              <div className="mgrlist">
                <button className="mgrrow" onClick={() => { close(); tapItem(mi, opts); tapItem(paired, { skipPairing: true, guestIdx: opts.guestIdx }); }}>Order both<span>{mi.name} + {paired.name}</span></button>
                <button className="mgrrow" onClick={() => setPairing({ ...pairing, showDesc: !showDesc })}>Description<span>{paired.name}</span></button>
                <button className="mgrrow" onClick={() => { close(); tapItem(mi, opts); }}>Skip<span>just {mi.name}</span></button>
              </div>
              <button className="mfbtn ghost" onClick={close}>Cancel</button>
            </div>
          </div>
        );
      })()}
      {kitchenNote && (() => {
        const close = () => setKitchenNote(null);
        const fire = (text: string) => { const { key } = kitchenNote; close(); void sendKitchenNote(key, text); };
        const pills = ["Delay 5 min", "Delay 10 min", "Delay 15 min", "Delay 30 min", "Rush", "Remake", "Allergy — check with the server"];
        return (
          <div className="backdrop" onClick={close}>
            <div className="authbox" onClick={(e) => e.stopPropagation()}>
              <div className="authtitle">Note to the kitchen</div>
              <div className="authsub">{kitchenNote.name} · goes to the stations that printed it</div>
              <div className="itempills" aria-label="Kitchen note">
                {pills.map((t) => (<button key={t} style={{ "--ch": 28 } as React.CSSProperties} onClick={() => fire(t)}>{t}</button>))}
              </div>
              <input className="ctable" placeholder="Custom note" value={kitchenNote.text} onChange={(e) => setKitchenNote((k) => k && ({ ...k, text: e.target.value }))} />
              <div className="mfactions">
                <button className="mfbtn ghost" onClick={close}>Cancel</button>
                <button className="mfbtn ghost" onClick={() => { const { key } = kitchenNote; close(); setCoursePick({ mode: "lines", keys: [key] }); }}>Change course…</button>
                <button className="mfbtn go" disabled={!kitchenNote.text.trim()} onClick={() => fire(kitchenNote.text.trim())}>Send note</button>
              </div>
            </div>
          </div>
        );
      })()}
      {notePad && (() => {
        const close = () => setNotePad(null);
        const toggle = (c: string) => setNotePad((n) => n && ({ ...n, chips: n.chips.includes(c) ? n.chips.filter((x) => x !== c) : [...n.chips, c] }));
        const text = [...notePad.chips, notePad.text.trim()].filter(Boolean).join(" · ");
        return (
          <div className="backdrop" onClick={close}>
            <div className="authbox" onClick={(e) => e.stopPropagation()}>
              <div className="authtitle">Allergen note</div>
              <div className="authsub">{notePad.name}</div>
              <div className="itempills" aria-label="Allergens">
                {ALLERGEN_CHIPS.map((c) => (
                  <button key={c} className={notePad.chips.includes(c) ? "def" : ""} style={{ "--ch": 342 } as React.CSSProperties} onClick={() => toggle(c)}>{c}</button>
                ))}
              </div>
              <input className="ctable" placeholder="Note for the kitchen (optional)" value={notePad.text} onChange={(e) => setNotePad((n) => n && ({ ...n, text: e.target.value }))} autoFocus />
              <div className="mfactions">
                <button className="mfbtn ghost" onClick={close}>Cancel</button>
                <button className="mfbtn go" disabled={!text} onClick={() => { const { key } = notePad; close(); ck.update((c) => setLineReference(c, key, text)); setSendError(`Note added: ${text}`); }}>Add note</button>
              </div>
            </div>
          </div>
        );
      })()}
      {overridePad && (
        <NumberPad title={overridePad.name} sub="Override price" mode="money" initial={String(Math.round(overridePad.amount * 100))}
          onOk={(v) => { const { key } = overridePad; setOverridePad(null); ck.setPrice(key, Math.round(v * 100) / 100); setSendError(`Price overridden on ${overridePad.name}`); }}
          onCancel={() => setOverridePad(null)} />
      )}
      {countPad && (
        <NumberPad title={countPad.mi.name} sub="How many are left? (0 = sold out)" mode="count" allowZero
          initial={countFor(counts, countPad.mi.id) > 0 ? String(countFor(counts, countPad.mi.id)) : ""}
          onOk={(v) => {
            const { mi, auth } = countPad; setCountPad(null);
            void (async () => {
              const r = await setMenuItemCounter(sessionCfg(), { menuItemId: mi.id, counter: v, authEmpId: auth.id });
              setSendError(r.ok ? (v === 0 ? `${mi.name}: sold out` : `${mi.name}: ${v} left`) : `Manage Qty failed: ${r.message}`);
              if (r.ok && v === 0) void notifyOutOfStock(mi);
              await refreshCounts();
            })();
          }}
          onCancel={() => setCountPad(null)} />
      )}

      {terminalConfirm}
      {unsentModal}

      {coursePick && (() => {
        const close = () => setCoursePick(null);
        const adding = coursePick.mode === "adding";
        const current = adding ? addingCourse : (() => { const l = ck.check.lines.find((x) => x.key === coursePick.keys[0]); return l ? courseOfLine(l) : 0; })();
        const pick = (c: number) => { close(); if (adding) setAddingCourse(c); else applyCourseChange(coursePick.keys, c); };
        return (
          <div className="backdrop" onClick={close}>
            <div className="authbox" onClick={(e) => e.stopPropagation()}>
              <div className="authtitle">{adding ? "Add new items to which course?" : `Change course${coursePick.keys.length > 1 ? ` (${coursePick.keys.length} lines)` : ""}`}</div>
              <div className="coursepick">
                {Array.from({ length: 10 }, (_, i) => i + 1).map((c) => (
                  <button key={c} className={current === c ? "on" : ""} style={{ "--ch": courseHue(c) } as React.CSSProperties} onClick={() => pick(c)}>
                    {courseLabelFor(c) === `Course ${c}` ? `C${c}` : courseLabelFor(c)}
                  </button>
                ))}
                <button className="none" onClick={() => pick(0)}>{adding ? "Auto — item's default course" : "No course"}</button>
              </div>
              <button className="mfbtn ghost" onClick={close}>Cancel</button>
            </div>
          </div>
        );
      })()}

      {adjOpen && (
        <NumberPad title={adjOpen.adj.name} sub={adjOpen.adj.isPercentage ? "Enter the percent" : "Enter the amount"} mode={adjOpen.adj.isPercentage ? "count" : "money"}
          onOk={(v) => { const o = adjOpen; setAdjOpen(null); finishDiscount(o.adj, o.auth, o.keys, v); }} onCancel={() => setAdjOpen(null)} />
      )}

      {adjPick && (
        <div className="backdrop" onClick={() => setAdjPick(null)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">{adjPick === "service" ? "Service charge" : "Discount"}</div>
            <div className="mgrlist">
              {adjustmentDefs.filter((a) => (adjPick === "service" ? a.isServiceCharge : !a.isServiceCharge)).map((a) => (
                <button key={a.id} className="mgrrow" onClick={() => { setAdjPick(null); doDiscount(a); }}>
                  {a.name}<span>{a.isPercentage ? `${a.amount}%` : `$${a.amount.toFixed(2)}`}</span>
                </button>
              ))}
              {adjustmentDefs.filter((a) => (adjPick === "service" ? a.isServiceCharge : !a.isServiceCharge)).length === 0 && <div className="hint">None configured.</div>}
            </div>
            <button className="mfbtn ghost" onClick={() => setAdjPick(null)}>Cancel</button>
          </div>
        </div>
      )}

      {xferPick === "menu" && (
        <div className="backdrop" onClick={() => setXferPick(null)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Transfer Check</div>
            <div className="authsub">Please select a check transfer option</div>
            <div className="mgrlist">
              <button className="mgrrow" onClick={() => { setXferPick(null); void beginTransferCheck("person"); }}>Check To Person</button>
              <button className="mgrrow" onClick={() => { setXferPick(null); void startTransfer(); }}>Check To Table</button>
              <button className="mgrrow" onClick={() => { setXferPick(null); void beginTransferCheck("personTable"); }}>Check To Person And Table</button>
              <button className="mgrrow" onClick={() => { setXferPick(null); requireAuth(false, "Authorize merge checks", "transfer", (a) => { setMergePick(a); void refreshOpenChecks(); }); }}>Merge With Another Check</button>
            </div>
            <button className="mfbtn ghost" onClick={() => setXferPick(null)}>Cancel</button>
          </div>
        </div>
      )}

      {(xferPick === "person" || xferPick === "personTable") && (
        <div className="backdrop" onClick={() => setXferPick(null)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">{xferPick === "person" ? "Transfer check to" : "Transfer check to… then pick a table"}</div>
            <div className="authsub">{xferClocked ? "Clocked-in employees" : "All employees (clock-in list unavailable)"}</div>
            <div className="mgrlist">
              {empList
                .filter((e) => (!xferClocked || xferClocked.has(e.id)) && jobsForEmployee(e.id).some((j) => !j.timeclockOnly))
                .map((e) => (
                  <button key={e.id} className="mgrrow" onClick={() => {
                    const kind = xferPick; setXferPick(null);
                    requireAuth(false, "Authorize transfer check", "transfer", (a) => {
                      if (kind === "person") void transferCheckToEmployee(e, a);
                      else { setXferEmp({ emp: e, auth: a }); setTransferMode(true); setMode("floor"); void refreshOpenChecks(); }
                    });
                  }}>{e.name}</button>
                ))}
            </div>
            <button className="mfbtn ghost" onClick={() => setXferPick(null)}>Cancel</button>
          </div>
        </div>
      )}

      {mergePick && (
        <div className="backdrop" onClick={() => setMergePick(null)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Merge into which check?</div>
            <div className="authsub">Check {ck.check.checkNumber ?? "—"} will be merged onto the check you pick</div>
            <div className="mgrlist">
              {openChecks.filter((o) => o.checkNo !== ck.check.checkNumber).map((o) => (
                <button key={o.checkNo} className="mgrrow" onClick={() => void doMerge(o, mergePick)}>
                  Check {o.checkNo}<span>{o.tableId ? `Table ${tableNumberOf(o.tableId)}` : "tab"} · {empList.find((e) => e.id === o.empPosId)?.name ?? o.empPosId}</span>
                </button>
              ))}
              {openChecks.filter((o) => o.checkNo !== ck.check.checkNumber).length === 0 && <div className="hint">No other open checks.</div>}
            </div>
            <button className="mfbtn ghost" onClick={() => setMergePick(null)}>Cancel</button>
          </div>
        </div>
      )}

      {showRcPick && (
        <div className="backdrop" onClick={() => setShowRcPick(false)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Revenue center</div>
            <div className="mgrlist">
              {cat.revenueCenters.map((rc) => (
                <button key={rc.id} className="mgrrow" onClick={() => { setShowRcPick(false); changeCheckRc(rc.id); }}>{rc.name}</button>
              ))}
            </div>
            <button className="mfbtn ghost" onClick={() => setShowRcPick(false)}>Cancel</button>
          </div>
        </div>
      )}

      {showTaxPick && (
        <div className="backdrop" onClick={() => setShowTaxPick(false)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Remove tax</div>
            <div className="mgrlist">
              {tax.groups.filter((g) => !g.isExempt).map((g) => (
                <button key={g.reportGroupId} className="mgrrow" onClick={() => { setShowTaxPick(false); setTaxExempt((s) => new Set(s).add(g.reportGroupId)); }}>
                  {g.name}<span>${g.amount.toFixed(2)}</span>
                </button>
              ))}
              {tax.groups.filter((g) => !g.isExempt).length === 0 && <div className="hint">No tax on this check.</div>}
            </div>
            <button className="mfbtn ghost" onClick={() => setShowTaxPick(false)}>Cancel</button>
          </div>
        </div>
      )}

      {memberBox && (
        <div className="backdrop" onClick={() => setMemberBox(null)}>
          <div className="authbox" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">Member lookup</div>
            <div className="membersearch">
              <input className="ctable" placeholder="Name or card #" value={memberBox.q} autoFocus
                onChange={(e) => setMemberBox((b) => (b ? { ...b, q: e.target.value } : b))}
                onKeyDown={(e) => { if (e.key === "Enter") void runMemberSearch(memberBox.q); }} />
              <button className="csend" disabled={memberBox.busy || !memberBox.q.trim()} onClick={() => void runMemberSearch(memberBox.q)}>{memberBox.busy ? "…" : "Search"}</button>
            </div>
            {memberBox.msg && <div className="hint">{memberBox.msg}</div>}
            <div className="mgrlist">
              {memberBox.results.map((m, i) => (
                <div key={i} className="mgrrow" style={{ cursor: "default" }}>
                  <span>{m.name || "(no name)"}{m.arcode ? ` · ${m.arcode}` : ""}</span>
                  <span>{m.status}</span>
                </div>
              ))}
            </div>
            <button className="mfbtn ghost" onClick={() => setMemberBox(null)}>Close</button>
          </div>
        </div>
      )}

      {showPay && (
        <PaymentView
          check={ck.check}
          tax={tax}
          tenders={payTenders}
          applyTender={ck.applyTender}
          voidTender={ck.voidTender}
          voidPostedTender={(key) => requireAuth(false, "Authorize void", "void", (auth) => setVoidReason({ keys: [key], auth }))}
          processGift={processGift}
          settle={settle}
          authorize={(title, ok) => requireAuth(false, title, "manager", () => ok())}
          onClose={() => void closePay()}
          onClosed={() => {
            const wasTable = !!ck.check.diningTableId;
            const logoutAfter = cat.rcById.get(ck.check.revenueCenterId)?.logoutAfterPayment ?? false; // N-13
            printSettleReceipt(); // paid receipt + cash-drawer kick, before the check is cleared
            void releaseLock(); setShowPay(false); ck.reset(rcId); setSendError("");
            if (logoutAfter) { setTransferMode(false); signOut(); return; } // Revenue_Center.logoutAfterPayment → login keypad
            if (wasTable) { setMode("floor"); void refreshOpenChecks(); }
          }}
        />
      )}
    </div>
  );
}
