/*
 * Catalog — typed views over the synced definition rows (definitions.ts /
 * defsync.ts cache them per table). A definition is just an array of plain
 * records; this layer gives the fields M1 needs a name and a type, and builds
 * POS_ID indexes, without pretending to be an ORM. Field names are the live
 * wire names verified against enox (store 3), not guesses.
 *
 * Only the columns the POS actually reads are typed; the raw row is kept on
 * `._raw` so later milestones can reach fields without a schema change.
 */

import { loadDefRows } from "@/protocol/defsync";
import type { DefRow } from "./definitions";

const s = (r: DefRow, k: string): string => {
  const v = r[k];
  return v == null ? "" : String(Array.isArray(v) ? v[0] ?? "" : v);
};
const alive = (r: DefRow): boolean => s(r, "Mark_Deleted") !== "1";

export interface MenuItem {
  id: string;                 // POS_ID
  name: string;
  price: string;              // raw "0.00" string; formatting is the view's job
  screenGroupId: string;      // primary Screen_Group_POS_ID
  otherScreenGroupIds: string[]; // Secondary_ + Screen_Group_POS_ID3..10
  sort: number;               // Screen_Sort_Order within the group
  categoryId: string;
  printGroupId: string;
  isModifier: boolean;        // Is_Modifier=="1" — a topping/mod, not a sellable tile
  modChainId: string;         // Screen_Chain_POS_ID — forces modifiers when added (M2)
  askForPrice: boolean;       // open-price item (Ask_For_Price=="1")
  nonRevenue: boolean;
  imageId: string;            // MenuItem_Image_ID || Image_ID
  _raw: DefRow;
}

export interface ScreenGroup {
  id: string;                 // POS_ID
  name: string;
  sort: number;               // Sort_Order
  parentIds: string[];        // Parent_Screen_Group_POS_ID + parent_..2..10
  displayMode: string;        // inroom_Display_Mode: LG_VIEW (menu page) vs LG_MOD* (modifier)
  imageId: string;            // Image_ID
  color: string;              // button_color palette index
  isTableView: boolean;
  _raw: DefRow;
}

export interface RevenueCenter {
  id: string;                 // POS_ID
  name: string;
  screenGroupFilter: boolean; // enable_screen_group_filter=="1"
  _raw: DefRow;
}

export interface RcScreenGroup {
  rcId: string;               // RevenueCenter_ID
  screenGroupId: string;      // Screen_Group_ID
  alwaysFilter: boolean;      // always_filter=="1" (ignore day/time window)
  startTime: string;          // filter_start_time "HH:MM:SS"
  endTime: string;
  days: boolean[];            // [sun..sat]
  _raw: DefRow;
}

export interface Category {
  id: string;
  name: string;
  sort: number;
  color: string;
  _raw: DefRow;
}

export interface Terminal {
  id: string;                 // POS_ID
  name: string;
  defaultScreenGroupId: string;   // Screen_Group_POS_ID (blank → first root group)
  defaultRevenueCenterId: string; // Default_RevenueCenter_POS_ID
  _raw: DefRow;
}

/** Secondary/extra screen-group columns a menu item can also appear under. */
const EXTRA_SG_KEYS = [
  "Secondary_Screen_Group_POS_ID",
  "Screen_Group_POS_ID3", "Screen_Group_POS_ID4", "Screen_Group_POS_ID5",
  "Screen_Group_POS_ID6", "Screen_Group_POS_ID7", "Screen_Group_POS_ID8",
  "Screen_Group_POS_ID9", "Screen_Group_POS_ID10",
];
const PARENT_KEYS = [
  "Parent_Screen_Group_POS_ID",
  "parent_Screen_Group_POS_ID2", "parent_Screen_Group_POS_ID3", "parent_Screen_Group_POS_ID4",
  "parent_Screen_Group_POS_ID5", "parent_Screen_Group_POS_ID6", "parent_Screen_Group_POS_ID7",
  "parent_Screen_Group_POS_ID8", "parent_Screen_Group_POS_ID9", "parent_Screen_Group_POS_ID10",
];

function toMenuItem(r: DefRow): MenuItem {
  return {
    id: s(r, "POS_ID"),
    name: s(r, "Name").trim(),
    price: s(r, "Price"),
    screenGroupId: s(r, "Screen_Group_POS_ID"),
    otherScreenGroupIds: EXTRA_SG_KEYS.map((k) => s(r, k)).filter(Boolean),
    sort: Number(s(r, "Screen_Sort_Order")) || 0,
    categoryId: s(r, "Category_POS_ID"),
    printGroupId: s(r, "Print_Group_POS_ID"),
    isModifier: s(r, "Is_Modifier") === "1",
    modChainId: s(r, "Screen_Chain_POS_ID"),
    askForPrice: s(r, "Ask_For_Price") === "1",
    nonRevenue: s(r, "Non_Revenue") === "1",
    imageId: s(r, "MenuItem_Image_ID") || s(r, "Image_ID"),
    _raw: r,
  };
}

function toScreenGroup(r: DefRow): ScreenGroup {
  return {
    id: s(r, "POS_ID"),
    name: s(r, "Name").trim(),
    sort: Number(s(r, "Sort_Order")) || 0,
    parentIds: PARENT_KEYS.map((k) => s(r, k)).filter(Boolean),
    displayMode: s(r, "inroom_Display_Mode"),
    imageId: s(r, "Image_ID"),
    color: s(r, "button_color"),
    isTableView: s(r, "Is_Table_View") === "1",
    _raw: r,
  };
}

export function menuItems(): MenuItem[] {
  return loadDefRows("Menu_Item").filter(alive).map(toMenuItem);
}

export function screenGroups(): ScreenGroup[] {
  return loadDefRows("Screen_Group").filter(alive).map(toScreenGroup);
}

export function revenueCenters(): RevenueCenter[] {
  return loadDefRows("Revenue_Center").filter(alive).map((r) => ({
    id: s(r, "POS_ID"),
    name: s(r, "Name").trim(),
    screenGroupFilter: s(r, "enable_screen_group_filter") === "1",
    _raw: r,
  }));
}

export function rcScreenGroups(): RcScreenGroup[] {
  return loadDefRows("RevenueCenter_Screen_Group").filter(alive).map((r) => ({
    rcId: s(r, "RevenueCenter_ID"),
    screenGroupId: s(r, "Screen_Group_ID"),
    alwaysFilter: s(r, "always_filter") === "1",
    startTime: s(r, "filter_start_time"),
    endTime: s(r, "filter_end_time"),
    days: [
      s(r, "sunday") === "1", s(r, "monday") === "1", s(r, "tuesday") === "1",
      s(r, "wednesday") === "1", s(r, "thursday") === "1", s(r, "friday") === "1",
      s(r, "saturday") === "1",
    ],
    _raw: r,
  }));
}

export function terminals(): Terminal[] {
  return loadDefRows("Terminal").filter(alive).map((r) => ({
    id: s(r, "POS_ID"),
    name: s(r, "Name").trim(),
    defaultScreenGroupId: s(r, "Screen_Group_POS_ID"),
    defaultRevenueCenterId: s(r, "Default_RevenueCenter_POS_ID"),
    _raw: r,
  }));
}

export function categories(): Category[] {
  return loadDefRows("Category").filter(alive).map((r) => ({
    id: s(r, "POS_ID"),
    name: s(r, "Name").trim(),
    sort: Number(s(r, "Sort_Order")) || 0,
    color: s(r, "button_color"),
    _raw: r,
  }));
}

/** Index an array by a key selector (last write wins on dup keys). */
export function indexBy<T>(rows: T[], key: (t: T) => string): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return m;
}
