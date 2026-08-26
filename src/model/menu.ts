/*
 * Menu navigation resolver — the browse hierarchy the iPad renders, ported from
 * the ground truth (FinancialCheckManager shouldShowScreenGroup: 21944-22075;
 * ItemsTableViewController updateSubScreenGroups: 1328-1397 / updateMenuItems:
 * 1400-1461). Key facts established from the Objective-C source + live enox data:
 *
 *  - RevenueCenter_Screen_Group is a HIDE/SCHEDULE table, NOT a membership join.
 *    When the revenue center's enable_screen_group_filter is off (the common
 *    case), EVERY screen group shows. When on, a matching RC/SG row hides the
 *    group (always_filter) or restricts it to a day/time window.
 *  - The grid at any level = child screen groups (navigate) + menu items (add),
 *    both keyed off the current screen group's POS_ID. Root = parentless groups.
 *  - Menu items match a screen group by primary Screen_Group_POS_ID OR any of the
 *    secondary/3..10 slots; hidden (Mark_Deleted / Hide_From_Store) rows drop out.
 *  - Sort: screen groups by Sort_Order; items by Screen_Sort_Order then Name.
 */

import {
  categories, chains, indexBy, menuItems, menuItemTaxGroups, revenueCenters, rcScreenGroups, screenChains,
  screenGroups, taxPacks, taxReportGroups, terminals,
  type Category, type Chain, type MenuItem, type MenuItemTaxGroup, type RevenueCenter, type RcScreenGroup,
  type ScreenChain, type ScreenGroup, type TaxPack, type TaxReportGroup, type Terminal,
} from "./catalog";

export interface Catalog {
  revenueCenters: RevenueCenter[];
  screenGroups: ScreenGroup[];
  menuItems: MenuItem[];
  rcScreenGroups: RcScreenGroup[];
  categories: Category[];
  terminals: Terminal[];
  chains: Chain[];
  screenChains: ScreenChain[];
  taxPacks: TaxPack[];
  menuItemTaxGroups: MenuItemTaxGroup[];
  taxReportGroups: TaxReportGroup[];
  sgById: Map<string, ScreenGroup>;
  miById: Map<string, MenuItem>;
  rcById: Map<string, RevenueCenter>;
  catById: Map<string, Category>;
  termById: Map<string, Terminal>;
  taxPackById: Map<string, TaxPack>;
  taxGroupById: Map<string, MenuItemTaxGroup>;
  reportGroupById: Map<string, TaxReportGroup>;
}

/** Snapshot the cached definitions into indexed typed views (cheap; call per mount). */
export function loadCatalog(): Catalog {
  const sg = screenGroups();
  const mi = menuItems();
  const rc = revenueCenters();
  const cat = categories();
  const term = terminals();
  const tp = taxPacks();
  const mitg = menuItemTaxGroups();
  const trg = taxReportGroups();
  return {
    revenueCenters: rc,
    screenGroups: sg,
    menuItems: mi,
    rcScreenGroups: rcScreenGroups(),
    categories: cat,
    terminals: term,
    chains: chains(),
    screenChains: screenChains(),
    taxPacks: tp,
    menuItemTaxGroups: mitg,
    taxReportGroups: trg,
    sgById: indexBy(sg, (x) => x.id),
    miById: indexBy(mi, (x) => x.id),
    rcById: indexBy(rc, (x) => x.id),
    catById: indexBy(cat, (x) => x.id),
    termById: indexBy(term, (x) => x.id),
    taxPackById: indexBy(tp, (x) => x.id),
    taxGroupById: indexBy(mitg, (x) => x.id),
    reportGroupById: indexBy(trg, (x) => x.id),
  };
}

/** One resolved modifier step: the screen to show + its rules + its items. */
export interface ModifierStep {
  screenChainId: string;
  screenGroupId: string;
  title: string;            // the modifier screen's name
  min: number;
  max: number;
  isForced: boolean;        // must pick (no skip)
  maxFreeCount: number;     // first N free
  items: MenuItem[];        // modifier tiles
}

/**
 * Resolve a menu item's forced-modifier chain into ordered steps
 * (CheckViewController.m:17284-17362): Screen_Chain_POS_ID → Chain rows by
 * Sort_Order → each Chain's Screen_Group → that group's items. Steps whose
 * modifier screen is hidden for the RC are dropped (:17327).
 */
export function modifierSteps(cat: Catalog, screenChainId: string, rcId: string, when?: Date): ModifierStep[] {
  if (!screenChainId) return [];
  const rc = cat.rcById.get(rcId);
  return cat.chains
    .filter((ch) => ch.screenChainId === screenChainId)
    .sort((a, b) => a.sort - b.sort)
    .map((ch) => {
      const sg = cat.sgById.get(ch.screenGroupId);
      if (!sg || !isScreenGroupVisible(cat, sg, rc, when)) return null;
      return {
        screenChainId, screenGroupId: ch.screenGroupId, title: sg.name,
        min: ch.min, max: ch.max, isForced: ch.isForced, maxFreeCount: ch.maxFreeCount,
        items: itemsInScreenGroup(cat, ch.screenGroupId),
      } as ModifierStep;
    })
    .filter((s): s is ModifierStep => s !== null && s.items.length > 0);
}

const bySortThenName = <T extends { sort: number; name: string }>(a: T, b: T) =>
  a.sort - b.sort || a.name.localeCompare(b.name);

/** minutes-since-midnight for "HH:MM:SS" (empty → NaN). */
function toMinutes(hms: string): number {
  const [h, m] = hms.split(":");
  const n = Number(h) * 60 + Number(m);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Port of FinancialCheckManager shouldShowScreenGroup: (21966-22025).
 * `when` defaults to now — used only when the RC filters on a schedule.
 */
export function isScreenGroupVisible(
  cat: Catalog, sg: ScreenGroup, rc: RevenueCenter | undefined, when: Date = new Date(),
): boolean {
  if (!rc || !rc.screenGroupFilter) return true; // filter off → every group shows (21966)
  const rows = cat.rcScreenGroups.filter((j) => j.rcId === rc.id && j.screenGroupId === sg.id);
  if (rows.length === 0) return true; // not referenced → not restricted
  // A referenced group is hidden outright (always_filter), else shown only inside
  // its day-of-week / time window.
  for (const j of rows) {
    if (j.alwaysFilter) return false; // (21988)
    if (!j.days[when.getDay()]) continue; // wrong day → this rule doesn't admit it
    const start = toMinutes(j.startTime), end = toMinutes(j.endTime);
    const nowMin = when.getHours() * 60 + when.getMinutes();
    if (Number.isNaN(start) || Number.isNaN(end) || (nowMin >= start && nowMin <= end)) return true;
  }
  return false;
}

/** Skip_Carousel==1 keeps a group off the root tab strip (it's reached only via
 *  a modifier chain). This — NOT parentless-ness — is the root predicate
 *  (CheckViewController.m:2794-2799). */
const inCarousel = (sg: ScreenGroup) => sg._raw["Skip_Carousel"] !== "1";

/**
 * Root screen-group tabs for a revenue center: carousel groups (Skip_Carousel
 * off) that pass the RC visibility gate, by Sort_Order then Name
 * (CheckViewController.m:2791-2811). A group with a parent can still be a root
 * tab (e.g. "Fresh Desserts") — root membership is the carousel flag, not depth.
 */
export function rootScreenGroups(cat: Catalog, rcId: string, when?: Date): ScreenGroup[] {
  const rc = cat.rcById.get(rcId);
  return cat.screenGroups
    .filter(inCarousel)
    .filter((sg) => isScreenGroupVisible(cat, sg, rc, when))
    .sort(bySortThenName);
}

/**
 * Initial browse selection when the terminal opens (CheckViewController.m
 * 2906-2923): the terminal's default revenue center and default screen group,
 * each falling back to the first available.
 */
export function initialSelection(cat: Catalog, terminalPosId: string): { rcId: string; screenGroup?: ScreenGroup } {
  const term = cat.termById.get(terminalPosId);
  const rcId = (term?.defaultRevenueCenterId && cat.rcById.has(term.defaultRevenueCenterId))
    ? term.defaultRevenueCenterId
    : cat.revenueCenters[0]?.id ?? "";
  const roots = rootScreenGroups(cat, rcId);
  const preferred = term?.defaultScreenGroupId ? roots.find((sg) => sg.id === term.defaultScreenGroupId) : undefined;
  return { rcId, screenGroup: preferred ?? roots[0] };
}

/** Child screen groups of a parent (navigate-into tiles). */
export function childScreenGroups(cat: Catalog, parentId: string, rcId: string, when?: Date): ScreenGroup[] {
  const rc = cat.rcById.get(rcId);
  return cat.screenGroups
    .filter((sg) => sg.parentIds.includes(parentId))
    .filter((sg) => isScreenGroupVisible(cat, sg, rc, when))
    .sort(bySortThenName);
}

/** Menu items placed in a screen group (primary or any secondary slot). */
export function itemsInScreenGroup(cat: Catalog, sgId: string): MenuItem[] {
  return cat.menuItems
    .filter((mi) => mi.screenGroupId === sgId || mi.otherScreenGroupIds.includes(sgId))
    .filter((mi) => mi._raw["Hide_From_Store"] !== "1")
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
}

/** Case/space-insensitive name+NLU search across sellable items (not modifiers). */
export function searchItems(cat: Catalog, query: string): MenuItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return cat.menuItems
    .filter((mi) => !mi.isModifier)
    .filter((mi) => mi.name.toLowerCase().includes(q) || String(mi._raw["NLU"] ?? "").toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 60);
}
