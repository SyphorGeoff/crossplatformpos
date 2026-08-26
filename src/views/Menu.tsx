/*
 * Ordering screen (M1 browse + M2 order entry). Left: the menu grid (revenue-
 * center tabs → screen groups → items). Right: the running check. Tapping an
 * item adds it; an item with a forced-modifier chain runs the modifier flow
 * first. Send fires the check's unsent lines to the kitchen as one tray
 * (protocol/order.ts), coordinating BusinessDate_ID and the check number with
 * the server exactly as the iPad does.
 */

import { useMemo, useState } from "react";
import { ISIS_VER, type Settings } from "@/state/useSettings";
import { useCheck } from "@/state/useCheck";
import { useEmployee, type CurrentEmployee } from "@/state/useEmployee";
import CheckPanel from "./CheckPanel";
import ModifierFlow, { type ChosenModifier } from "./ModifierFlow";
import PaymentView from "./PaymentView";
import Floorplan from "./Floorplan";
import {
  childScreenGroups, initialSelection, itemsInScreenGroup, loadCatalog, modifierSteps,
  rootScreenGroups, searchItems, type Catalog, type ModifierStep,
} from "@/model/menu";
import {
  diningRooms, diningTables, employees, isNativeGift, isNativeLoyalty, storeConfig, tenders as loadTenders,
} from "@/model/catalog";
import type { DiningTable, MenuItem, ScreenGroup } from "@/model/catalog";
import {
  fetchHighestCheck, nextCheckNo, resolveBusinessDate, sendCheck,
  type SendContext, type SessionConfig,
} from "@/protocol/order";
import { sendPayment, type GiftType, type LoyaltyType, type PaymentContext, type PaymentResult } from "@/protocol/payment";
import { fetchOpenChecks, lockCheck, readCheck, unlockCheck, type OpenCheck } from "@/protocol/tables";
import { unsentLines } from "@/model/check";
import { computeCheckTax, taxGroupsForWire } from "@/model/tax";

const TILE_COLORS = ["#26303f", "#2f6fb0", "#b0472f", "#2f8f5f", "#b98a2b", "#7a55c0", "#2f8fae", "#b0416f"];
const tileColor = (idx: string): string => {
  const n = Number(idx);
  return Number.isFinite(n) && n > 0 ? TILE_COLORS[n % TILE_COLORS.length] : TILE_COLORS[0];
};
const money = (price: string, askForPrice: boolean): string => {
  if (askForPrice) return "open";
  const n = Number(price);
  return !price || !Number.isFinite(n) ? "" : `$${n.toFixed(2)}`;
};

function EmployeePicker({ onPick }: { onPick: (e: CurrentEmployee) => void }) {
  const list = useMemo(() => employees().sort((a, b) => a.name.localeCompare(b.name)), []);
  return (
    <div className="setup">
      <h1>Aireus POS</h1>
      <div className="card">
        <h2>Who's serving?</h2>
        <div className="emplist">
          {list.map((e) => (
            <button key={e.id} className="empbtn" onClick={() => onPick({ id: e.id, name: e.name })}>
              {e.name}{e.inTraining ? " (training)" : ""}
            </button>
          ))}
          {list.length === 0 && <p className="hint">No employees in the synced catalog.</p>}
        </div>
      </div>
    </div>
  );
}

export default function Menu({ settings, onChangeStation }: { settings: Settings; onChangeStation: () => void }) {
  const cat = useMemo<Catalog>(() => loadCatalog(), []);
  const init = useMemo(() => initialSelection(cat, settings.terminalPosId), [cat, settings.terminalPosId]);
  const { employee, signIn, signOut } = useEmployee();

  const [rcId, setRcId] = useState<string>(init.rcId);
  const [stack, setStack] = useState<ScreenGroup[]>(() => (init.screenGroup ? [init.screenGroup] : []));
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<{ item: MenuItem; steps: ModifierStep[] } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [bdid, setBdid] = useState("");
  const [showPay, setShowPay] = useState(false);
  const [mode, setMode] = useState<"floor" | "order">("order");
  const [transferMode, setTransferMode] = useState(false);
  const [openChecks, setOpenChecks] = useState<OpenCheck[]>([]);
  const [floorLoading, setFloorLoading] = useState(false);
  const [floorStatus, setFloorStatus] = useState("");
  const [lockedCheck, setLockedCheck] = useState<{ checkNo: string; checkKey: string; bd: string } | null>(null);

  const ck = useCheck(init.rcId);
  const payTenders = useMemo(() => loadTenders().filter((t) => t.appliesToCheck && !t.hidden).sort((a, b) => a.sort - b.sort), []);
  const store = useMemo(() => storeConfig(), []);
  const tax = useMemo(() => computeCheckTax(cat, ck.check), [cat, ck.check]);
  const rooms = useMemo(() => diningRooms(), []);
  const tables = useMemo(() => diningTables(), []);
  const occupancy = useMemo(() => {
    const m = new Map<string, OpenCheck>();
    for (const oc of openChecks) if (oc.tableId && !m.has(oc.tableId)) m.set(oc.tableId, oc);
    return m;
  }, [openChecks]);

  const roots = useMemo(() => rootScreenGroups(cat, rcId), [cat, rcId]);
  const current = stack[stack.length - 1];
  const searching = query.trim().length > 0;

  const subGroups = useMemo<ScreenGroup[]>(
    () => (searching || !current ? [] : childScreenGroups(cat, current.id, rcId)),
    [cat, current, rcId, searching],
  );
  const items = useMemo<MenuItem[]>(
    () => (searching ? searchItems(cat, query) : current ? itemsInScreenGroup(cat, current.id) : []),
    [cat, current, query, searching],
  );

  const selectRc = (id: string) => {
    setRcId(id); setQuery("");
    const r = rootScreenGroups(cat, id);
    setStack(r[0] ? [r[0]] : []);
    if (ck.check.lines.length === 0) ck.setRevenueCenter(id);
  };
  const selectTab = (sg: ScreenGroup) => { setQuery(""); setStack([sg]); };
  const enter = (sg: ScreenGroup) => setStack((s) => [...s, sg]);
  const drillTo = (i: number) => setStack((s) => s.slice(0, i + 1));

  const tapItem = (mi: MenuItem) => {
    const steps = mi.modChainId ? modifierSteps(cat, mi.modChainId, rcId) : [];
    if (steps.length) setPending({ item: mi, steps });
    else ck.addItem(mi);
    setSendError("");
  };
  const finishMods = (chosen: ChosenModifier[]) => {
    if (!pending) return;
    const key = ck.addItem(pending.item);
    for (const cm of chosen) ck.addModifier(key, cm.item, cm.free ? 0 : Number(cm.item.price) || 0);
    setPending(null);
  };

  const sessionCfg = (): SessionConfig => ({
    enterpriseServerUrl: settings.enterpriseServerUrl, isisVer: ISIS_VER,
    storeId: settings.storeId, token: settings.token, terminalPosId: settings.terminalPosId,
  });

  const ensureBd = async (): Promise<string> => {
    let bd = bdid;
    if (!bd) { bd = await resolveBusinessDate(sessionCfg()); setBdid(bd); }
    if (!bd) throw new Error("No open business date on the server");
    return bd;
  };

  /** Resolve BusinessDate_ID and a check number, assigning the number once. */
  const ensureSession = async (): Promise<{ bd: string; checkNo: string }> => {
    const bd = await ensureBd();
    let checkNo = ck.check.checkNumber;
    if (!checkNo) { checkNo = nextCheckNo(await fetchHighestCheck(sessionCfg(), bd), settings.terminalPosId); ck.setCheckNumber(checkNo); }
    return { bd, checkNo };
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

  /** Leave the ordering view for the floorplan, holding an in-progress table
   *  check so it persists on the server (an open check keeps the table occupied). */
  const goToFloor = async () => {
    if (ck.check.diningTableId && unsentLines(ck.check).length > 0) { setSending(true); await postCheck(false); setSending(false); }
    await releaseLock();
    setTransferMode(false); setMode("floor");
    void refreshOpenChecks();
  };

  const quickSale = () => { void releaseLock(); setTransferMode(false); ck.reset(rcId); setSendError(""); setMode("order"); };

  /** Move the current (posted) check to another table — a re-POST of the
   *  FinancialCheck with a new DiningTable_POS_ID (recon D). */
  const startTransfer = async () => {
    if (unsentLines(ck.check).length > 0) { setSending(true); const r = await postCheck(false); setSending(false); if (!r.ok) { setSendError(r.message); return; } }
    setTransferMode(true); setMode("floor"); void refreshOpenChecks();
  };
  const transferTo = async (table: DiningTable) => {
    setFloorLoading(true); setFloorStatus(`Moving check to table ${table.name}…`);
    try {
      const { bd, checkNo } = await ensureSession();
      const moved = { ...ck.check, diningTableId: table.id, tableName: table.name, checkNumber: checkNo };
      const res = await sendCheck(settings.enterpriseServerUrl, moved, buildCtx(bd, checkNo), { settle: false, taxGroups: taxGroupsForWire(tax) });
      if (!res.ok) { setFloorStatus(`Transfer failed: ${res.message}`); setFloorLoading(false); return; }
      await releaseLock();
      ck.reset(rcId); setTransferMode(false); setFloorStatus(`Moved to table ${table.name}`);
      await refreshOpenChecks();
    } catch (e) { setFloorStatus(String((e as Error).message ?? e)); }
    setFloorLoading(false);
  };

  const pickTable = async (table: DiningTable, occ?: OpenCheck) => {
    if (transferMode) { void transferTo(table); return; }
    if (!occ) { // open a fresh check bound to the table
      void releaseLock();
      ck.reset(table.revenueCenterId || rcId, table.name, 1, table.id);
      if (table.revenueCenterId && cat.rcById.has(table.revenueCenterId)) setRcId(table.revenueCenterId);
      setSendError(""); setMode("order");
      return;
    }
    setFloorLoading(true); setFloorStatus(`Opening table ${table.name}…`);
    try {
      const bd = occ.businessDateId || (await ensureBd());
      const lock = await lockCheck(sessionCfg(), { checkNo: occ.checkNo, checkKey: occ.checkKey, businessDateId: bd });
      if (!lock.ok) {
        setFloorStatus(lock.alreadyLocked ? `Table ${table.name} is open on another terminal` : `Could not lock: ${lock.message}`);
        setFloorLoading(false); return;
      }
      const names = {
        menuItemName: (id: string) => cat.miById.get(id)?.name ?? `#${id}`,
        tenderName: (id: string) => payTenders.find((t) => t.id === id)?.name ?? `#${id}`,
      };
      const pulled = await readCheck(sessionCfg(), { checkNo: occ.checkNo, checkKey: occ.checkKey, businessDateId: bd }, names);
      if (!pulled) { setFloorStatus("Check not found on the server"); await unlockCheck(sessionCfg(), { checkNo: occ.checkNo, checkKey: occ.checkKey, businessDateId: bd }); setFloorLoading(false); return; }
      ck.loadCheck(pulled);
      if (pulled.revenueCenterId && cat.rcById.has(pulled.revenueCenterId)) setRcId(pulled.revenueCenterId);
      setLockedCheck({ checkNo: occ.checkNo, checkKey: occ.checkKey, bd });
      setSendError(""); setMode("order");
    } catch (e) { setFloorStatus(String((e as Error).message ?? e)); }
    setFloorLoading(false);
  };

  const buildCtx = (bd: string, checkNo: string): SendContext => ({
    isisVer: ISIS_VER, storeId: settings.storeId, securityToken: settings.token,
    terminalPosId: settings.terminalPosId, employeePosId: employee!.id, businessDateId: bd, checkNo,
  });

  /** POST the check with an already-resolved business date + number. */
  const postCheckWith = async (settle: boolean, bd: string, checkNo: string): Promise<{ ok: boolean; message: string }> => {
    const res = await sendCheck(settings.enterpriseServerUrl, { ...ck.check, checkNumber: checkNo }, buildCtx(bd, checkNo), { settle, taxGroups: taxGroupsForWire(tax) });
    if (res.ok) ck.markSent(settle);
    return { ok: res.ok, message: res.message };
  };

  /** POST the check — kitchen fire (settle=false) or settle+close (settle=true). */
  const postCheck = async (settle: boolean): Promise<{ ok: boolean; message: string }> => {
    if (!employee) return { ok: false, message: "No employee signed in" };
    try {
      const { bd, checkNo } = await ensureSession();
      return await postCheckWith(settle, bd, checkNo);
    } catch (e) { return { ok: false, message: String((e as Error).message ?? e) }; }
  };

  const doSend = async () => {
    setSending(true); setSendError("");
    const r = await postCheck(false);
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

  if (!employee) return <EmployeePicker onPick={signIn} />;

  if (mode === "floor") {
    return (
      <Floorplan
        storeName={settings.storeName || settings.storeId}
        employeeName={employee.name}
        rooms={rooms}
        tables={tables}
        occupancy={occupancy}
        onPick={pickTable}
        onQuickSale={quickSale}
        onRefresh={refreshOpenChecks}
        onSignOut={signOut}
        loading={floorLoading}
        status={floorStatus}
        transferMode={transferMode}
        onCancelTransfer={() => { setTransferMode(false); setMode("order"); }}
      />
    );
  }

  return (
    <div className="pos">
      <header className="posbar">
        <div className="ident"><b>{settings.storeName || settings.storeId}</b><span>{settings.terminalName || settings.terminalPosId} · {employee.name}{ck.check.diningTableId ? ` · Table ${ck.check.tableName}` : ""}</span></div>
        <div className="rcs">
          {cat.revenueCenters.map((rc) => (
            <button key={rc.id} className={`rc ${rc.id === rcId ? "on" : ""}`} onClick={() => selectRc(rc.id)}>{rc.name}</button>
          ))}
        </div>
        <div className="tools">
          <input className="search" placeholder="Search items…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="clr" onClick={() => setQuery("")}>✕</button>}
          {ck.check.diningTableId && <button className="station" onClick={startTransfer} disabled={sending}>Move</button>}
          <button className="station" onClick={goToFloor} disabled={sending}>Tables</button>
          <button className="station" onClick={signOut}>Sign out</button>
          <button className="station" onClick={onChangeStation}>Station</button>
        </div>
      </header>

      <div className="order">
        <div className="menuside">
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
              <button key={`i${mi.id}`} className={`tile item ${mi.isModifier ? "mod" : ""}`} onClick={() => tapItem(mi)}>
                <span className="tname">{mi.name}</span>
                <span className="tprice">{money(mi.price, mi.askForPrice)}</span>
                {mi.modChainId && <span className="tmod" title="has modifiers">＋</span>}
              </button>
            ))}
            {subGroups.length === 0 && items.length === 0 && (
              <div className="empty">{searching ? "No matching items." : "This screen has no items or sub-screens."}</div>
            )}
          </div>
        </div>

        <CheckPanel
          check={ck.check}
          tax={tax}
          revenueCenterName={cat.rcById.get(ck.check.revenueCenterId)?.name ?? ""}
          onQty={ck.setQty}
          onRemove={ck.remove}
          onSetTable={ck.setTable}
          onSetGuests={ck.setGuests}
          onSend={doSend}
          onPay={() => setShowPay(true)}
          onNewCheck={() => { ck.reset(rcId); setSendError(""); }}
          sending={sending}
          sendError={sendError}
        />
      </div>

      {pending && (
        <ModifierFlow itemName={pending.item.name} steps={pending.steps} onDone={finishMods} onCancel={() => setPending(null)} />
      )}

      {showPay && (
        <PaymentView
          check={ck.check}
          tax={tax}
          tenders={payTenders}
          applyTender={ck.applyTender}
          processGift={processGift}
          settle={settle}
          onClose={() => setShowPay(false)}
          onClosed={() => {
            const wasTable = !!ck.check.diningTableId;
            void releaseLock(); setShowPay(false); ck.reset(rcId); setSendError("");
            if (wasTable) { setMode("floor"); void refreshOpenChecks(); }
          }}
        />
      )}
    </div>
  );
}
