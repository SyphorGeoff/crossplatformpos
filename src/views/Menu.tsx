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
import {
  childScreenGroups, initialSelection, itemsInScreenGroup, loadCatalog, modifierSteps,
  rootScreenGroups, searchItems, type Catalog, type ModifierStep,
} from "@/model/menu";
import { employees, isNativeGift, isNativeLoyalty, storeConfig, tenders as loadTenders } from "@/model/catalog";
import type { MenuItem, ScreenGroup } from "@/model/catalog";
import {
  fetchHighestCheck, nextCheckNo, resolveBusinessDate, sendCheck,
  type SendContext, type SessionConfig,
} from "@/protocol/order";
import { sendPayment, type GiftType, type LoyaltyType, type PaymentContext, type PaymentResult } from "@/protocol/payment";

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

  const ck = useCheck(init.rcId);
  const payTenders = useMemo(() => loadTenders().filter((t) => t.appliesToCheck && !t.hidden).sort((a, b) => a.sort - b.sort), []);
  const store = useMemo(() => storeConfig(), []);

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

  /** Resolve BusinessDate_ID and a check number, assigning the number once. */
  const ensureSession = async (): Promise<{ bd: string; checkNo: string }> => {
    const cfg = sessionCfg();
    let bd = bdid;
    if (!bd) { bd = await resolveBusinessDate(cfg); setBdid(bd); }
    if (!bd) throw new Error("No open business date on the server");
    let checkNo = ck.check.checkNumber;
    if (!checkNo) { checkNo = nextCheckNo(await fetchHighestCheck(cfg, bd), settings.terminalPosId); ck.setCheckNumber(checkNo); }
    return { bd, checkNo };
  };

  const buildCtx = (bd: string, checkNo: string): SendContext => ({
    isisVer: ISIS_VER, storeId: settings.storeId, securityToken: settings.token,
    terminalPosId: settings.terminalPosId, employeePosId: employee!.id, businessDateId: bd, checkNo,
  });

  /** POST the check with an already-resolved business date + number. */
  const postCheckWith = async (settle: boolean, bd: string, checkNo: string): Promise<{ ok: boolean; message: string }> => {
    const res = await sendCheck(settings.enterpriseServerUrl, { ...ck.check, checkNumber: checkNo }, buildCtx(bd, checkNo), { settle });
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

  return (
    <div className="pos">
      <header className="posbar">
        <div className="ident"><b>{settings.storeName || settings.storeId}</b><span>{settings.terminalName || settings.terminalPosId} · {employee.name}</span></div>
        <div className="rcs">
          {cat.revenueCenters.map((rc) => (
            <button key={rc.id} className={`rc ${rc.id === rcId ? "on" : ""}`} onClick={() => selectRc(rc.id)}>{rc.name}</button>
          ))}
        </div>
        <div className="tools">
          <input className="search" placeholder="Search items…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="clr" onClick={() => setQuery("")}>✕</button>}
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
          tenders={payTenders}
          applyTender={ck.applyTender}
          processGift={processGift}
          settle={settle}
          onClose={() => setShowPay(false)}
          onClosed={() => { setShowPay(false); ck.reset(rcId); setSendError(""); }}
        />
      )}
    </div>
  );
}
