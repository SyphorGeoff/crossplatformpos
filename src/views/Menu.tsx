/*
 * Menu browse (M1) — the ordering grid the iPad renders, in browse form.
 * Structure mirrors CheckViewController: a persistent root tab strip of
 * carousel screen groups (Skip_Carousel off), an always-selected section whose
 * menu items + child screen groups fill the grid, and a breadcrumb for drilling
 * deeper. A flat item search overlays the grid. Initial selection follows the
 * terminal defaults (default RC + default screen group, else first of each).
 *
 * This is the read side of the check screen; building the actual check
 * (tap-to-add + forced modifiers + send to kitchen) is M2, so an item tap here
 * opens a detail sheet rather than adding to an order.
 */

import { useMemo, useState } from "react";
import type { Settings } from "@/state/useSettings";
import {
  childScreenGroups, initialSelection, itemsInScreenGroup, loadCatalog, rootScreenGroups,
  searchItems, type Catalog,
} from "@/model/menu";
import type { MenuItem, ScreenGroup } from "@/model/catalog";

/* button_color is a small palette index on the iPad; these are legible POS tile
   colors for it. Index 0 / blank = the neutral card tone. */
const TILE_COLORS = ["#26303f", "#2f6fb0", "#b0472f", "#2f8f5f", "#b98a2b", "#7a55c0", "#2f8fae", "#b0416f"];
const tileColor = (idx: string): string => {
  const n = Number(idx);
  return Number.isFinite(n) && n > 0 ? TILE_COLORS[n % TILE_COLORS.length] : TILE_COLORS[0];
};

function money(price: string, askForPrice: boolean): string {
  if (askForPrice) return "open";
  const n = Number(price);
  if (!price || !Number.isFinite(n)) return "";
  return `$${n.toFixed(2)}`;
}

function ItemDetail({ item, cat, onClose }: { item: MenuItem; cat: Catalog; onClose: () => void }) {
  const category = cat.catById.get(item.categoryId)?.name;
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="shead">
          <div className="sname">{item.name}</div>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="sprice">{money(item.price, item.askForPrice) || "—"}</div>
        <dl className="sfacts">
          <div><dt>Item #</dt><dd>{item.id}</dd></div>
          {category && <div><dt>Category</dt><dd>{category}</dd></div>}
          {item.printGroupId && <div><dt>Print group</dt><dd>{item.printGroupId}</dd></div>}
          {item.modChainId && <div><dt>Modifiers</dt><dd>forced chain #{item.modChainId}</dd></div>}
          {item.isModifier && <div><dt>Type</dt><dd>modifier</dd></div>}
        </dl>
        <p className="snote">Adding to a check (with modifiers) arrives with order entry — M2.</p>
      </div>
    </div>
  );
}

export default function Menu({ settings, onChangeStation }: { settings: Settings; onChangeStation: () => void }) {
  const cat = useMemo(() => loadCatalog(), []);
  const init = useMemo(() => initialSelection(cat, settings.terminalPosId), [cat, settings.terminalPosId]);

  const [rcId, setRcId] = useState<string>(init.rcId);
  // Drill path within the selected section: stack[0] is the root tab, deeper
  // entries are child screen groups. Empty only if the RC has no carousel groups.
  const [stack, setStack] = useState<ScreenGroup[]>(() => (init.screenGroup ? [init.screenGroup] : []));
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

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

  const open = openId ? cat.miById.get(openId) : undefined;

  const selectRc = (id: string) => {
    setRcId(id); setQuery("");
    const r = rootScreenGroups(cat, id);
    setStack(r[0] ? [r[0]] : []);
  };
  const selectTab = (sg: ScreenGroup) => { setQuery(""); setStack([sg]); };
  const enter = (sg: ScreenGroup) => setStack((s) => [...s, sg]);
  const drillTo = (i: number) => setStack((s) => s.slice(0, i + 1)); // keep crumb i

  return (
    <div className="pos">
      <header className="posbar">
        <div className="ident"><b>{settings.storeName || settings.storeId}</b><span>terminal {settings.terminalName || settings.terminalPosId}</span></div>
        <div className="rcs">
          {cat.revenueCenters.map((rc) => (
            <button key={rc.id} className={`rc ${rc.id === rcId ? "on" : ""}`} onClick={() => selectRc(rc.id)}>{rc.name}</button>
          ))}
        </div>
        <div className="tools">
          <input className="search" placeholder="Search items…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="clr" onClick={() => setQuery("")}>✕</button>}
          <button className="station" onClick={onChangeStation}>Change station</button>
        </div>
      </header>

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
          <button key={`i${mi.id}`} className={`tile item ${mi.isModifier ? "mod" : ""}`} onClick={() => setOpenId(mi.id)}>
            <span className="tname">{mi.name}</span>
            <span className="tprice">{money(mi.price, mi.askForPrice)}</span>
            {mi.modChainId && <span className="tmod" title="has modifiers">＋</span>}
          </button>
        ))}
        {subGroups.length === 0 && items.length === 0 && (
          <div className="empty">{searching ? "No matching items." : "This screen has no items or sub-screens."}</div>
        )}
      </div>

      {open && <ItemDetail item={open} cat={cat} onClose={() => setOpenId(null)} />}
    </div>
  );
}
