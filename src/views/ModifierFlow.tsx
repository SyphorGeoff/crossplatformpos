/*
 * Forced-modifier flow — after a menu item with a Screen_Chain is added, walk
 * its chain steps (CheckViewController.m:17284-17476). Each step is a modifier
 * screen with min/max selection rules: forced steps must be satisfied (no Skip),
 * optional steps show Skip; the first `maxFreeCount` picks are free, extras keep
 * their price. Chosen modifiers are returned to attach under the parent line.
 *
 * Mods of mods (updateMenuItemButtonsAfterSelectingMenuitem :17144-17420): a
 * picked modifier that has its own Screen_Chain pushes that chain's steps AHEAD
 * of the remaining steps (screenChainStack insertObject:atIndex:), with the
 * modifier as their parent line — so "Baked Potato" asks sour cream / butter
 * right after it is picked, and those land one level under the potato.
 */
import { useState } from "react";
import type { MenuItem, ToppingPrefix } from "@/model/catalog";
import type { ModifierStep } from "@/model/menu";

export interface ChosenModifier { item: MenuItem; free: boolean; parent?: ChosenModifier; prefix?: ToppingPrefix; }

// parent = the pick this step hangs off (nested chain); selectedPrefixId = the step's prefix bar
// (ItemsTableViewController nextMenuItemsList.prefixes: default pre-selected, back to it after every pick)
interface FlowStep extends ModifierStep { parent?: ChosenModifier; selectedPrefixId?: string; }

const fmt = (n: number) => `$${n.toFixed(2)}`;

export default function ModifierFlow({ itemName, steps, stepsFor, onDone, onCancel }: {
  itemName: string;
  steps: ModifierStep[];
  stepsFor?: (item: MenuItem) => ModifierStep[];   // a modifier's own chain (mods of mods); absent = no nesting
  onDone: (chosen: ChosenModifier[]) => void;
  onCancel: () => void;
}) {
  const [flow, setFlow] = useState<FlowStep[]>(() => steps.map((s) => ({ ...s, selectedPrefixId: s.defaultPrefixId || undefined })));
  const [idx, setIdx] = useState(0);
  const [picks, setPicks] = useState<ChosenModifier[][]>(() => steps.map(() => []));
  const step = flow[idx];
  const selected = picks[idx];
  const isSelected = (id: string) => selected.some((m) => m.item.id === id);
  const atMax = step.max > 0 && selected.length >= step.max;
  const meetsMin = selected.length >= step.min;

  /** Steps a pick brings with it: its own chain, parented to the pick. */
  const nestedFor = (pick: ChosenModifier): FlowStep[] =>
    (stepsFor && pick.item.modChainId ? stepsFor(pick.item) : []).map((s) => ({ ...s, parent: pick, selectedPrefixId: s.defaultPrefixId || undefined }));

  /** Drop the nested steps (and their picks) that belong to a de-selected pick, at any depth. */
  const withoutNested = (f: FlowStep[], p: ChosenModifier[][], pick: ChosenModifier) => {
    const dead = new Set<ChosenModifier>([pick]);
    let grew = true;
    while (grew) { grew = false; for (const fs of f) if (fs.parent && dead.has(fs.parent)) for (const c of p[f.indexOf(fs)] ?? []) if (!dead.has(c)) { dead.add(c); grew = true; } }
    const keep = f.map((fs, i) => [fs, p[i]] as const).filter(([fs]) => !(fs.parent && dead.has(fs.parent)));
    return { f: keep.map(([fs]) => fs), p: keep.map(([, pk]) => pk) };
  };

  const toggle = (item: MenuItem) => {
    const cur = picks[idx];
    const at = cur.findIndex((m) => m.item.id === item.id);
    let f = flow.slice(), p = picks.map((a) => a.slice());
    if (at >= 0) {                                                  // deselect → its nested steps go too
      const r = withoutNested(f, p, cur[at]); f = r.f; p = r.p;
      p[idx] = p[idx].filter((m) => m.item.id !== item.id);
    } else {
      const prefix = step.prefixes.find((x) => x.id === step.selectedPrefixId);
      const pick: ChosenModifier = { item, free: false, parent: step.parent, ...(prefix ? { prefix } : {}) };
      if (step.max === 1 && cur.length) { const r = withoutNested(f, p, cur[0]); f = r.f; p = r.p; p[idx] = []; }   // single-select replaces
      else if (atMax) return;
      p[idx] = [...p[idx], pick];
      f[idx] = { ...f[idx], selectedPrefixId: step.defaultPrefixId || undefined };   // the bar snaps back to the default
      const nested = nestedFor(pick);
      if (nested.length) { f.splice(idx + 1, 0, ...nested); p.splice(idx + 1, 0, ...nested.map(() => [] as ChosenModifier[])); }
    }
    setFlow(f); setPicks(p);
  };

  const finish = () => {
    const chosen: ChosenModifier[] = [];
    flow.forEach((s, si) => {
      picks[si].forEach((pick, i) => chosen.push({ ...pick, free: s.maxFreeCount > 0 && i < s.maxFreeCount }));
    });
    // a nested pick's `parent` object identity is what placeItem uses; re-point at the finished copies
    const byOrig = new Map<ChosenModifier, ChosenModifier>();
    flow.forEach((_, si) => picks[si].forEach((pick, i) => byOrig.set(pick, chosen[picks.slice(0, si).reduce((n, a) => n + a.length, 0) + i])));
    for (const c of chosen) if (c.parent) c.parent = byOrig.get(c.parent) ?? c.parent;
    onDone(chosen);
  };
  const next = () => (idx < flow.length - 1 ? setIdx(idx + 1) : finish());
  const skip = next;
  const back = () => idx > 0 && setIdx(idx - 1);
  const rule = step.min > 0
    ? `pick ${step.min}${step.max && step.max !== step.min ? `–${step.max}` : ""}`
    : step.max ? `up to ${step.max}` : "";
  const owner = step.parent ? step.parent.item.name : itemName;

  return (
    <div className="backdrop">
      <div className="modflow" onClick={(e) => e.stopPropagation()}>
        <div className="mfhead">
          <div>
            <div className="mftitle">{step.title}</div>
            <div className="mfsub">
              {owner} · step {idx + 1}/{flow.length} · {step.isForced ? "required" : "optional"}{rule ? ` · ${rule}` : ""}
            </div>
          </div>
          <button className="x" onClick={onCancel}>✕</button>
        </div>
        {step.prefixes.length > 0 && (
          <div className="prefixbar" role="radiogroup" aria-label="Prefix">
            {step.prefixes.map((pf) => (
              <button key={pf.id} className={`pfx ${step.selectedPrefixId === pf.id ? "on" : ""}`} aria-pressed={step.selectedPrefixId === pf.id}
                onClick={() => setFlow(flow.map((s, i) => (i === idx ? { ...s, selectedPrefixId: pf.id } : s)))}>{pf.name}</button>
            ))}
          </div>
        )}
        <div className="mfgrid">
          {step.items.map((m) => (
            <button key={m.id} className={`tile item ${isSelected(m.id) ? "picked" : ""}`}
              disabled={!isSelected(m.id) && atMax && step.max !== 1}
              onClick={() => toggle(m)}>
              {selected.find((x) => x.item.id === m.id)?.prefix && <span className="tpfx">{selected.find((x) => x.item.id === m.id)!.prefix!.name}</span>}
              <span className="tname">{m.name}</span>
              {Number(m.price) > 0 && <span className="tprice">{fmt(Number(m.price))}</span>}
            </button>
          ))}
        </div>
        <div className="mfactions">
          {idx > 0 && <button className="mfbtn ghost" onClick={back}>Back</button>}
          {!step.isForced && <button className="mfbtn ghost" onClick={skip}>Skip</button>}
          <button className="mfbtn go" disabled={step.isForced && !meetsMin} onClick={next}>
            {idx < flow.length - 1 ? "Next" : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}
