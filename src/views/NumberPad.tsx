/*
 * Numeric entry pad — the POS keypad used for "Enter Price" (priceViewController,
 * ASK_FOR_PRICE) and the cover-count pad (guestCountPadViewController). Money
 * mode types cents right-to-left like a register ("1","2","5","0" → $12.50);
 * count mode is a plain integer.
 */

import { useState } from "react";

export default function NumberPad({ title, sub, mode, initial = "", onOk, onCancel }: {
  title: string; sub?: string; mode: "money" | "count"; initial?: string;
  onOk: (value: number) => void; onCancel: () => void;
}) {
  const [digits, setDigits] = useState(initial.replace(/\D/g, ""));
  const value = mode === "money" ? Number(digits || "0") / 100 : Number(digits || "0");
  const shown = mode === "money" ? `$${value.toFixed(2)}` : digits || "0";
  const press = (k: string) => setDigits((d) => (d + k).replace(/^0+(?=\d)/, "").slice(0, 9));
  const del = () => setDigits((d) => d.slice(0, -1));
  const ok = () => { if (mode === "count" && value < 1) return; onOk(value); };
  return (
    <div className="backdrop" onClick={onCancel}>
      <div className="authbox" onClick={(e) => e.stopPropagation()}>
        <div className="authtitle">{title}</div>
        {sub && <div className="authsub">{sub}</div>}
        <div className="authpin">{shown}</div>
        <div className="keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"].map((k) => (
            <button key={k} className={`kkey ${k === "OK" ? "ok" : ""}`} onClick={() => (k === "⌫" ? del() : k === "OK" ? ok() : press(k))}>{k}</button>
          ))}
        </div>
        <button className="mfbtn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
