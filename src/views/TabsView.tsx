/*
 * Tabs — the list of open checks (counter tabs + table checks) the store has
 * going, so a server can see and pick any one up. Occupancy comes from the
 * server's Open_Checks feed (FinancialCheckManager Open_Checks); tapping a row
 * locks + reads that check back into the order screen.
 */

import type { OpenCheck } from "@/protocol/tables";

export interface TabsViewProps {
  openChecks: OpenCheck[];
  nameForTable: (tableId: string) => string;
  nameForEmp: (empPosId: string) => string;
  onPick: (occ: OpenCheck) => void;
  onNewTab: () => void;
  onRefresh: () => void;
  loading: boolean;
  status?: string;
}

function statusOf(oc: OpenCheck): { label: string; cls: string } {
  if (oc.isAllergy) return { label: "Allergy", cls: "allergy" };
  if (oc.heldItem) return { label: "Held", cls: "held" };
  if (oc.printCount > 0) return { label: "Printed", cls: "printed" };
  return { label: "Open", cls: "open" };
}

export default function TabsView(p: TabsViewProps) {
  const rows = [...p.openChecks].sort((a, b) => (b.lastModified || "").localeCompare(a.lastModified || ""));

  return (
    <div className="tabsview">
      <div className="tabshead">
        <h1>Open Tabs</h1>
        <div className="tabstools">
          <button className="tbbtn" onClick={p.onRefresh} disabled={p.loading}>{p.loading ? "…" : "Refresh"}</button>
          <button className="tbpill" onClick={p.onNewTab}>New tab</button>
        </div>
      </div>

      {p.status && <div className="tabsstatus">{p.status}</div>}

      <div className="tabsgrid">
        {rows.map((oc) => {
          const st = statusOf(oc);
          const label = oc.tableId ? `Table ${p.nameForTable(oc.tableId)}` : "Counter tab";
          const server = p.nameForEmp(oc.empPosId);
          return (
            <button key={`${oc.checkNo}-${oc.checkKey}`} className="tabcard" onClick={() => p.onPick(oc)} disabled={p.loading}>
              <div className="tabcardtop">
                <span className="tabcheckno">#{oc.checkNo}</span>
                <span className={`tabdot ${st.cls}`} title={st.label} />
              </div>
              <div className="tabcardlabel">{label}</div>
              <div className="tabcardsub">{server || "—"}{oc.lastModified ? ` · ${oc.lastModified.slice(11, 16)}` : ""}</div>
            </button>
          );
        })}
        {rows.length === 0 && !p.loading && <div className="empty">No open tabs.</div>}
      </div>
    </div>
  );
}
