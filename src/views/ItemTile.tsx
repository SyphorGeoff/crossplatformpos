/*
 * A menu-item tile: tap rings it, a 2-second press opens the item popup
 * (MenuItemCellView: UILongPressGestureRecognizer minimumPressDuration 2 →
 * the description alert). Shows the 86 countdown badge when the item has a
 * counter; at zero the tile is marked sold out (the tap is refused by the
 * caller, the long press still works so a manager can restock it).
 */

import { useRef } from "react";
import type { MenuItem } from "@/model/catalog";

export default function ItemTile({ mi, count, priceLabel, onTap, onLongPress }: {
  mi: MenuItem; count: number; priceLabel: string; onTap: () => void; onLongPress: () => void;
}) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const start = () => {
    fired.current = false;
    timer.current = window.setTimeout(() => { fired.current = true; timer.current = null; onLongPress(); }, 2000);
  };
  const clear = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
  const click = () => { if (fired.current) { fired.current = false; return; } onTap(); };
  return (
    <button
      className={`tile item ${mi.isModifier ? "mod" : ""} ${count === 0 ? "soldout" : ""}`}
      onPointerDown={start} onPointerUp={clear} onPointerLeave={clear} onPointerCancel={clear}
      onContextMenu={(e) => e.preventDefault()} onClick={click}
      title={count === 0 ? "Sold out" : undefined}
    >
      <span className="tname">{mi.name}</span>
      <span className="tprice">{priceLabel}</span>
      {mi.modChainId && <span className="tmod" title="has modifiers">＋</span>}
      {count >= 0 && <span className="tcount">{count}</span>}
    </button>
  );
}
