/*
 * Menu resolver — the ground-truth navigation rules ported in model/menu.ts,
 * exercised over a synthetic catalog so the predicates stay pinned:
 *  - root = Skip_Carousel!=1 + RC-visible, by Sort_Order then Name
 *    (CheckViewController.m:2791-2811)
 *  - children by Parent_Screen_Group_POS_ID(+2..10)
 *  - items by primary OR secondary Screen_Group slot, Hide_From_Store dropped
 *  - RC visibility: filter off → all; filter on → always_filter hides
 *  - initial selection: terminal default RC/SG, else first
 */

import { describe, expect, it } from "vitest";
import { indexBy, type Catalog } from "@/model/catalog";
import type { MenuItem, RcScreenGroup, RevenueCenter, ScreenGroup, Terminal } from "@/model/catalog";
import {
  childScreenGroups, initialSelection, isScreenGroupVisible, itemsInScreenGroup,
  rootScreenGroups, searchItems,
} from "@/model/menu";

const sg = (id: string, name: string, o: Partial<ScreenGroup> & { skip?: string } = {}): ScreenGroup => ({
  id, name, sort: o.sort ?? 0, parentIds: o.parentIds ?? [], displayMode: o.displayMode ?? "LG_VIEW",
  imageId: "", color: o.color ?? "", isTableView: false,
  _raw: { Skip_Carousel: o.skip ?? "0" },
});
const mi = (id: string, name: string, o: Partial<MenuItem> & { hide?: string; nlu?: string } = {}): MenuItem => ({
  id, name, price: o.price ?? "1.00", screenGroupId: o.screenGroupId ?? "", otherScreenGroupIds: o.otherScreenGroupIds ?? [],
  sort: o.sort ?? 0, categoryId: "", printGroupId: "", isModifier: o.isModifier ?? false, modChainId: o.modChainId ?? "",
  askForPrice: false, nonRevenue: false, imageId: "",
  _raw: { Hide_From_Store: o.hide ?? "0", NLU: o.nlu ?? "" },
});
const rc = (id: string, name: string, filter = false): RevenueCenter => ({ id, name, screenGroupFilter: filter, _raw: {} });
const term = (id: string, defRc = "", defSg = ""): Terminal => ({
  id, name: "T" + id, defaultScreenGroupId: defSg, defaultRevenueCenterId: defRc, _raw: {},
});

function build(parts: {
  screenGroups?: ScreenGroup[]; menuItems?: MenuItem[]; revenueCenters?: RevenueCenter[];
  rcScreenGroups?: RcScreenGroup[]; terminals?: Terminal[];
}): Catalog {
  const screenGroups = parts.screenGroups ?? [];
  const menuItems = parts.menuItems ?? [];
  const revenueCenters = parts.revenueCenters ?? [];
  const terminals = parts.terminals ?? [];
  return {
    screenGroups, menuItems, revenueCenters, terminals,
    rcScreenGroups: parts.rcScreenGroups ?? [], categories: [],
    sgById: indexBy(screenGroups, (x) => x.id), miById: indexBy(menuItems, (x) => x.id),
    rcById: indexBy(revenueCenters, (x) => x.id), catById: new Map(), termById: indexBy(terminals, (x) => x.id),
  };
}

describe("rootScreenGroups", () => {
  it("keeps carousel groups (Skip_Carousel!=1), drops the rest, sorts by Sort_Order then Name", () => {
    const cat = build({
      revenueCenters: [rc("1", "Main")],
      screenGroups: [
        sg("10", "Beverages", { sort: 1 }),
        sg("20", "Toast Options", { sort: 1, skip: "1" }), // modifier group — off root
        sg("30", "Desserts", { sort: 2, parentIds: ["10"] }), // parented but still carousel
        sg("40", "Apps", { sort: 2 }),
      ],
    });
    expect(rootScreenGroups(cat, "1").map((s) => s.name)).toEqual(["Beverages", "Apps", "Desserts"]);
  });
});

describe("childScreenGroups", () => {
  it("matches any parent slot", () => {
    const cat = build({
      revenueCenters: [rc("1", "Main")],
      screenGroups: [sg("3", "Main Dishes"), sg("13", "Breakfast", { parentIds: ["3"] }), sg("99", "Sides", { parentIds: ["x", "3"] })],
    });
    expect(childScreenGroups(cat, "3", "1").map((s) => s.id).sort()).toEqual(["13", "99"]);
  });
});

describe("itemsInScreenGroup", () => {
  it("includes primary and secondary placement, drops Hide_From_Store, sorts by sort then name", () => {
    const cat = build({
      menuItems: [
        mi("a", "Zebra", { screenGroupId: "5", sort: 2 }),
        mi("b", "Apple", { screenGroupId: "5", sort: 2 }),
        mi("c", "Front", { screenGroupId: "5", sort: 1 }),
        mi("d", "Secondary", { screenGroupId: "9", otherScreenGroupIds: ["5"], sort: 3 }),
        mi("e", "Hidden", { screenGroupId: "5", hide: "1" }),
      ],
    });
    expect(itemsInScreenGroup(cat, "5").map((m) => m.name)).toEqual(["Front", "Apple", "Zebra", "Secondary"]);
  });
});

describe("isScreenGroupVisible", () => {
  const group = sg("7", "Lunch");
  it("shows everything when the RC filter is off", () => {
    const cat = build({ revenueCenters: [rc("1", "Main", false)] });
    expect(isScreenGroupVisible(cat, group, cat.rcById.get("1"))).toBe(true);
  });
  it("hides an always_filter group when the RC filter is on", () => {
    const cat = build({
      revenueCenters: [rc("1", "Main", true)],
      rcScreenGroups: [{ rcId: "1", screenGroupId: "7", alwaysFilter: true, startTime: "", endTime: "", days: [true, true, true, true, true, true, true], _raw: {} }],
    });
    expect(isScreenGroupVisible(cat, group, cat.rcById.get("1"))).toBe(false);
  });
  it("shows an unreferenced group even when the RC filter is on", () => {
    const cat = build({ revenueCenters: [rc("1", "Main", true)] });
    expect(isScreenGroupVisible(cat, group, cat.rcById.get("1"))).toBe(true);
  });
});

describe("initialSelection", () => {
  const groups = [sg("10", "Beverages", { sort: 1 }), sg("40", "Apps", { sort: 2 })];
  it("uses the terminal's default RC and screen group when set", () => {
    const cat = build({ revenueCenters: [rc("1", "A"), rc("2", "B")], screenGroups: groups, terminals: [term("t", "2", "40")] });
    const r = initialSelection(cat, "t");
    expect(r.rcId).toBe("2");
    expect(r.screenGroup?.id).toBe("40");
  });
  it("falls back to first RC and first carousel group", () => {
    const cat = build({ revenueCenters: [rc("1", "A"), rc("2", "B")], screenGroups: groups, terminals: [term("t")] });
    const r = initialSelection(cat, "t");
    expect(r.rcId).toBe("1");
    expect(r.screenGroup?.id).toBe("10");
  });
});

describe("searchItems", () => {
  it("finds sellable items by name/NLU and excludes modifiers", () => {
    const cat = build({
      menuItems: [
        mi("a", "Cheeseburger", { screenGroupId: "5" }),
        mi("b", "No Onion", { screenGroupId: "5", isModifier: true }),
        mi("c", "Soda", { screenGroupId: "5", nlu: "BURGERCOMBO" }),
      ],
    });
    expect(searchItems(cat, "burger").map((m) => m.id).sort()).toEqual(["a", "c"]);
  });
});
