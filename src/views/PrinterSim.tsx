/*
 * Printer simulator panel — a floating window over the POS that shows this
 * terminal's local receipt jobs as a paper roll (platform/printsim.ts). On
 * screen whenever the simulator is on; drag it by its bar, minimise it to a
 * pill, Clear empties the roll. Presentation only.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { renderPaper, type PaperLine } from "@/platform/escpos";
import { clearSimJobs, simState, subscribeSim } from "@/platform/printsim";
import { loadJSON, saveJSON } from "@/platform/storage";

const POS = "printsim.pos.v1";
interface Pos { x: number; y: number; }

const clamp = (p: Pos): Pos => ({
  x: Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth - 90)),
  y: Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - 44)),
});

function Line({ l }: { l: PaperLine }) {
  if (l.kind === "cut") return <div className="pscut">cut</div>;
  if (l.kind === "drawer") return <div className="psnote">cash drawer opens</div>;
  return (
    <div className={`psline al-${l.align}`}>
      {l.segs.length === 0 ? " " : l.segs.map((s, i) => (
        <span key={i} className={`${s.bold ? "psb " : ""}${s.wide && s.tall ? "psbig " : s.wide ? "pswide " : s.tall ? "pstall " : ""}${s.red ? "psred" : ""}`}>{s.text}</span>
      ))}
    </div>
  );
}

export default function PrinterSim() {
  const sim = useSyncExternalStore(subscribeSim, simState);
  const [pos, setPos] = useState<Pos>(() => clamp(loadJSON<Pos>(POS, { x: Math.max(8, window.innerWidth - 380), y: 64 })));
  const [mini, setMini] = useState(false);
  const [seen, setSeen] = useState(0);              // jobs on the roll when it was minimised
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const roll = useRef<HTMLDivElement>(null);

  const count = sim.jobs.length;
  useEffect(() => { if (!mini && roll.current) roll.current.scrollTop = roll.current.scrollHeight; }, [count, mini]);
  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!sim.on) return null;

  const down = (e: React.PointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("button.psbtn")) return;   // the bar's own buttons are not drag handles
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, moved: false };
  };
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current; if (!d) return;
    const next = clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy });
    if (Math.abs(next.x - pos.x) + Math.abs(next.y - pos.y) > 3) d.moved = true;
    setPos(next);
  };
  const up = () => { if (drag.current) saveJSON(POS, pos); };
  /** A press on the pill that was not a drag opens the panel. */
  const pillClick = () => { const d = drag.current; drag.current = null; if (!d?.moved) setMini(false); };

  if (mini) {
    const unseen = Math.max(0, count - seen);
    return (
      <button className="psimpill" style={{ left: pos.x, top: pos.y }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onClick={pillClick}>
        Printer{unseen ? ` · ${unseen} new` : ""}
      </button>
    );
  }

  const cpl = Math.max(32, ...sim.jobs.map((j) => j.cpl));
  return (
    <div className="psim" style={{ left: pos.x, top: pos.y, maxHeight: `max(180px, min(72vh, calc(100vh - ${pos.y + 12}px)))` }}>
      <div className="psimbar" onPointerDown={down} onPointerMove={move} onPointerUp={() => { up(); drag.current = null; }}>
        <span>Printer simulator</span>
        <button className="psbtn" onClick={clearSimJobs} disabled={count === 0}>Clear</button>
        <button className="psbtn" onClick={() => { setSeen(count); setMini(true); }} aria-label="Minimise">–</button>
      </div>
      <div className="psroll" ref={roll}>
        {count === 0 && <div className="psempty" style={{ width: `${cpl}ch` }}>Receipts, check prints and clock chits from this terminal appear here.</div>}
        {sim.jobs.map((j) => (
          <div key={j.id} className="pstick" style={{ width: `${j.cpl}ch` }}>
            <div className="psthead">{j.printer}{j.address ? ` · ${j.address}` : ""} · {new Date(j.at).toLocaleTimeString()}</div>
            {renderPaper(j.job).map((l, i) => <Line key={i} l={l} />)}
          </div>
        ))}
      </div>
    </div>
  );
}
