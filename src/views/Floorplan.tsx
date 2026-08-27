/*
 * Floorplan — dining rooms and their tables, laid out by DiningTable
 * X_Coordinate/Y_Coordinate on a scaled canvas (SectionView.m). Occupancy is
 * derived from the server's Open_Checks list (not a table field): a table with
 * an open check shows occupied (allergy/held/printed take precedence, matching
 * the iPad status order). Tapping a table opens a new check or resumes the
 * existing one.
 */

import { useMemo, useState } from "react";
import type { DiningRoom, DiningTable } from "@/model/catalog";
import type { OpenCheck } from "@/protocol/tables";

const DESIGN_W = 768; // the iPad room canvas width; tables are placed within it

export interface FloorplanProps {
  storeName: string;
  employeeName: string;
  rooms: DiningRoom[];
  tables: DiningTable[];
  occupancy: Map<string, OpenCheck>;
  onPick: (table: DiningTable, occ?: OpenCheck) => void;
  onQuickSale: () => void;
  onRefresh: () => void;
  onSignOut: () => void;
  loading: boolean;
  status?: string;
  transferMode?: boolean;
  onCancelTransfer?: () => void;
  initialRoomId?: string;
}

type Status = "open" | "occupied" | "allergy" | "held" | "printed";
function tableStatus(occ?: OpenCheck): Status {
  if (!occ) return "open";
  if (occ.isAllergy) return "allergy";
  if (occ.heldItem) return "held";
  if (occ.printCount > 0) return "printed";
  return "occupied";
}

export default function Floorplan(p: FloorplanProps) {
  const rooms = useMemo(() => [...p.rooms].sort((a, b) => a.sort - b.sort), [p.rooms]);
  const [roomId, setRoomId] = useState<string>(() => (p.initialRoomId && rooms.some((r) => r.id === p.initialRoomId) ? p.initialRoomId : rooms[0]?.id ?? ""));

  const roomTables = useMemo(() => p.tables.filter((t) => t.roomId === roomId), [p.tables, roomId]);
  // Canvas height from the tables' extent (kept in the 768-wide design space).
  const designH = useMemo(() => Math.max(400, ...roomTables.map((t) => t.y + 80)), [roomTables]);

  return (
    <div className="floor">
      <header className="posbar">
        <div className="ident"><b>{p.storeName}</b><span>{p.employeeName}</span></div>
        <div className="rcs">
          {rooms.map((r) => (
            <button key={r.id} className={`rc ${r.id === roomId ? "on" : ""}`} onClick={() => setRoomId(r.id)}>{r.name}</button>
          ))}
        </div>
        <div className="tools">
          <button className="station" onClick={p.onRefresh} disabled={p.loading}>{p.loading ? "…" : "Refresh"}</button>
          <button className="station" onClick={p.onQuickSale}>Quick sale</button>
          <button className="station" onClick={p.onSignOut}>Sign out</button>
        </div>
      </header>

      {p.transferMode && (
        <div className="floorstatus xfer">Pick a table to move the check to · <button className="link" onClick={p.onCancelTransfer}>Cancel</button></div>
      )}
      {p.status && <div className="floorstatus">{p.status}</div>}

      <div className="floorscroll">
        <div className="floorcanvas" style={{ aspectRatio: `${DESIGN_W} / ${designH}` }}>
          {roomTables.map((t) => {
            const occ = p.occupancy.get(t.id);
            const st = tableStatus(occ);
            return (
              <button
                key={t.id}
                className={`table st-${st} ${t.selectable ? "" : "locked"}`}
                style={{ left: `${(t.x / DESIGN_W) * 100}%`, top: `${(t.y / designH) * 100}%` }}
                disabled={!t.selectable}
                onClick={() => p.onPick(t, occ)}
                title={occ ? `Check ${occ.checkNo}` : `Table ${t.name}`}
              >
                <span className="tnum">{t.name}</span>
                {occ && <span className="tchk">#{occ.checkNo}</span>}
                {t.seats > 0 && !occ && <span className="tseats">{t.seats}</span>}
              </button>
            );
          })}
          {roomTables.length === 0 && <div className="empty">No tables in this room.</div>}
        </div>
      </div>
    </div>
  );
}
