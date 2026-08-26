/*
 * Forced-modifier flow — after a menu item with a Screen_Chain is added, walk
 * its chain steps (CheckViewController.m:17284-17476). Each step is a modifier
 * screen with min/max selection rules: forced steps must be satisfied (no Skip),
 * optional steps show Skip; the first `maxFreeCount` picks are free, extras keep
 * their price. Chosen modifiers are returned to attach under the parent line.
 */

import { useState } from "react";
import type { MenuItem } from "@/model/catalog";
import type { ModifierStep } from "@/model/menu";

export interface ChosenModifier { item: MenuItem; free: boolean; }

const fmt = (n: number) => `$${n.toFixed(2)}`;

export default function ModifierFlow({ itemName, steps, onDone, onCancel }: {
  itemName: string;
  steps: ModifierStep[];
  onDone: (chosen: ChosenModifier[]) => void;
  onCancel: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [picks, setPicks] = useState<MenuItem[][]>(() => steps.map(() => []));
  const step = steps[idx];

  const selected = picks[idx];
  const isSelected = (id: string) => selected.some((m) => m.id === id);
  const atMax = step.max > 0 && selected.length >= step.max;
  const meetsMin = selected.length >= step.min;

  const toggle = (item: MenuItem) => {
    setPicks((prev) => {
      const next = prev.map((a) => a.slice());
      const cur = next[idx];
      const at = cur.findIndex((m) => m.id === item.id);
      if (at >= 0) cur.splice(at, 1);           // deselect
      else if (step.max === 1) next[idx] = [item]; // single-select replaces
      else if (!atMax) cur.push(item);           // multi-select add (within max)
      return next;
    });
  };

  const finish = () => {
    const chosen: ChosenModifier[] = [];
    steps.forEach((s, si) => {
      picks[si].forEach((item, i) => chosen.push({ item, free: s.maxFreeCount > 0 && i < s.maxFreeCount }));
    });
    onDone(chosen);
  };

  const next = () => (idx < steps.length - 1 ? setIdx(idx + 1) : finish());
  const skip = next;
  const back = () => idx > 0 && setIdx(idx - 1);

  const rule = step.min > 0
    ? `pick ${step.min}${step.max && step.max !== step.min ? `–${step.max}` : ""}`
    : step.max ? `up to ${step.max}` : "";

  return (
    <div className="backdrop">
      <div className="modflow" onClick={(e) => e.stopPropagation()}>
        <div className="mfhead">
          <div>
            <div className="mftitle">{step.title}</div>
            <div className="mfsub">
              {itemName} · step {idx + 1}/{steps.length} · {step.isForced ? "required" : "optional"}{rule ? ` · ${rule}` : ""}
            </div>
          </div>
          <button className="x" onClick={onCancel}>✕</button>
        </div>

        <div className="mfgrid">
          {step.items.map((m) => (
            <button key={m.id} className={`tile item ${isSelected(m.id) ? "picked" : ""}`}
              disabled={!isSelected(m.id) && atMax && step.max !== 1}
              onClick={() => toggle(m)}>
              <span className="tname">{m.name}</span>
              {Number(m.price) > 0 && <span className="tprice">{fmt(Number(m.price))}</span>}
            </button>
          ))}
        </div>

        <div className="mfactions">
          {idx > 0 && <button className="mfbtn ghost" onClick={back}>Back</button>}
          {!step.isForced && <button className="mfbtn ghost" onClick={skip}>Skip</button>}
          <button className="mfbtn go" disabled={step.isForced && !meetsMin} onClick={next}>
            {idx < steps.length - 1 ? "Next" : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}
