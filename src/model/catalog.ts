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
  taxGroupId: string;         // Menu_Item_Tax_Group_POS_ID
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

/** One step of a modifier chain: a modifier Screen_Group shown after an item,
 *  with min/max selection rules (Chain rows, ordered by Sort_Order). */
export interface Chain {
  screenChainId: string;    // Screen_Chain_POS_ID (the chain this step belongs to)
  screenGroupId: string;    // Screen_Group_POS_ID (the modifier screen to show)
  isForced: boolean;        // Is_Forced=="1" — must pick, no skip
  isModifier: boolean;
  min: number;
  max: number;              // iPad caps at 20
  maxFreeCount: number;     // first N modifiers priced free
  sort: number;             // Sort_Order (step order)
  _raw: DefRow;
}

/** A named modifier chain (Screen_Chain), referenced by Menu_Item.Screen_Chain_POS_ID. */
export interface ScreenChain {
  id: string;               // POS_ID
  name: string;
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
    taxGroupId: s(r, "Menu_Item_Tax_Group_POS_ID"),
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

export interface DiningRoom {
  id: string;               // POS_ID
  name: string;
  sort: number;
  imageId: string;          // background image (not synced here)
  _raw: DefRow;
}
export interface DiningTable {
  id: string;               // POS_ID
  name: string;             // table number/label
  roomId: string;           // Dining_Room_POS_ID
  revenueCenterId: string;  // RevenueCenter_POS_ID
  x: number;                // X_Coordinate (absolute layout px)
  y: number;                // Y_Coordinate
  seats: number;            // seat_count
  tableType: string;        // Table_Type (shape/kind code)
  selectable: boolean;      // !unselectable
  _raw: DefRow;
}
export interface EmpDiningRoom { empId: string; roomId: string; }

export function diningRooms(): DiningRoom[] {
  return loadDefRows("Dining_Room").filter(alive).map((r) => ({
    id: s(r, "POS_ID"), name: s(r, "Name").trim(),
    sort: Number(s(r, "sort_Order")) || 0, imageId: s(r, "Image_ID"), _raw: r,
  }));
}
export function diningTables(): DiningTable[] {
  return loadDefRows("DiningTable").filter(alive).map((r) => ({
    id: s(r, "POS_ID"), name: s(r, "Name").trim(), roomId: s(r, "Dining_Room_POS_ID"),
    revenueCenterId: s(r, "RevenueCenter_POS_ID"),
    x: Number(s(r, "X_Coordinate")) || 0, y: Number(s(r, "Y_Coordinate")) || 0,
    seats: Number(s(r, "seat_count")) || 0, tableType: s(r, "Table_Type"),
    selectable: s(r, "unselectable") !== "1", _raw: r,
  })).filter((t) => t.id);
}
export function empDiningRooms(): EmpDiningRoom[] {
  return loadDefRows("Emp_DiningRoom").filter(alive).map((r) => ({
    empId: s(r, "Emp_POS_ID"), roomId: s(r, "DiningRoom_POS_ID"),
  }));
}

/** One tax definition within a Tax_Pack (up to 5: Tax_Def1..5). */
export interface TaxDef {
  name: string;
  rate: number;             // percent, e.g. 10 (Tax_DefN_Rate)
  reportGroupId: string;    // Tax_DefN_TRG_POS_ID → Tax_Report_Group
  threshold: number;        // Tax_DefN_Threshold (0 = none)
  rebateRate: number;       // Tax_DefN_Rebate_Rate
  compounded: boolean;      // Tax_DefN_Is_Compounded (tax on prior tax)
}
export interface TaxPack {
  id: string;               // POS_ID
  name: string;
  defs: TaxDef[];           // active definitions (rate or name present)
  _raw: DefRow;
}
export interface MenuItemTaxGroup {
  id: string;               // POS_ID (Menu_Item.Menu_Item_Tax_Group_POS_ID)
  taxPackId: string;        // Tax_Pack_POS_ID
  roundDown: boolean;
  _raw: DefRow;
}
export interface TaxReportGroup {
  id: string;               // POS_ID
  name: string;
  isInclusive: boolean;     // Is_Inclusive — tax baked into the price vs added on top
  _raw: DefRow;
}

export function taxPacks(): TaxPack[] {
  return loadDefRows("Tax_Pack").filter(alive).map((r) => {
    const defs: TaxDef[] = [];
    for (let i = 1; i <= 5; i++) {
      const rate = s(r, `Tax_Def${i}_Rate`);
      const name = s(r, `Tax_Def${i}_Name`);
      const trg = s(r, `Tax_Def${i}_TRG_POS_ID`);
      if (!name && !rate && !trg) continue;         // slot unused
      if (!trg && Number(rate) === 0) continue;     // 0% no-op with no group
      defs.push({
        name, rate: Number(rate) || 0, reportGroupId: trg,
        threshold: Number(s(r, `Tax_Def${i}_Threshold`)) || 0,
        rebateRate: Number(s(r, `Tax_Def${i}_Rebate_Rate`)) || 0,
        compounded: s(r, `Tax_Def${i}_Is_Compounded`) === "1",
      });
    }
    return { id: s(r, "POS_ID"), name: s(r, "Name").trim(), defs, _raw: r };
  });
}

export function menuItemTaxGroups(): MenuItemTaxGroup[] {
  return loadDefRows("Menu_Item_Tax_Group").filter(alive).map((r) => ({
    id: s(r, "POS_ID"), taxPackId: s(r, "Tax_Pack_POS_ID"), roundDown: s(r, "Round_Down") === "1", _raw: r,
  }));
}

export function taxReportGroups(): TaxReportGroup[] {
  return loadDefRows("Tax_Report_Group").filter(alive).map((r) => ({
    id: s(r, "POS_ID"), name: s(r, "Name").trim(), isInclusive: s(r, "Is_Inclusive") === "1", _raw: r,
  }));
}

/** A tender (payment method). The kind flags classify it; `paymentDriver`
 *  selects the processor (empty = native/plain, e.g. "WRPjson"/"AgilysysMember"
 *  = external PMS drivers). Third-party card gateways are out of scope (deferred). */
export interface Tender {
  id: string;               // POS_ID
  name: string;
  sort: number;
  isCash: boolean;
  isCredit: boolean;        // deferred — stubbed in the UI
  isGift: boolean;          // Is_GiftCert (native Aireus/HBroker)
  isLoyalty: boolean;       // is_Loyalty (native ISISLOYALTY)
  isRoomCharge: boolean;    // roomCharge (PMS)
  paymentDriver: string;    // payment_Driver ("" = native/plain)
  openCashDrawer: boolean;
  askForTip: boolean;
  overpayIsTip: boolean;
  roundingAmount: string;   // when Enable_Rounding; e.g. "0.05"
  appliesToCheck: boolean;
  hidden: boolean;
  _raw: DefRow;
}

/** Store-level payment config (processor selection + native merchant creds). */
export interface StoreConfig {
  gcProcessor: string;        // GC_Processor ("ISISGiftCard"/"aireus…" = native)
  loyaltyProcessor: string;   // loyalty_Processor ("" or third-party name)
  gcMerchantId: string;
  gcMerchantPassword: string;
  loyaltyMerchantId: string;
  loyaltyMerchantPassword: string;
}
const nativeProcessor = (v: string) => /isis|aireus/i.test(v);
export function storeConfig(): StoreConfig {
  const r = loadDefRows("Store")[0] ?? {};
  return {
    gcProcessor: s(r, "GC_Processor"),
    loyaltyProcessor: s(r, "loyalty_Processor"),
    gcMerchantId: s(r, "GC_Merchant_ID"),
    gcMerchantPassword: s(r, "GCMerchantPassword"),
    loyaltyMerchantId: s(r, "loyalty_MerchantID"),
    loyaltyMerchantPassword: s(r, "loyalty_Merchant_Password"),
  };
}
/** Is the store's gift processor the native Aireus one (vs a third-party gateway)? */
export const isNativeGift = (cfg: StoreConfig) => nativeProcessor(cfg.gcProcessor);
export const isNativeLoyalty = (cfg: StoreConfig) => cfg.loyaltyProcessor === "" || nativeProcessor(cfg.loyaltyProcessor);

export function tenders(): Tender[] {
  return loadDefRows("Tender").filter(alive).map((r) => ({
    id: s(r, "POS_ID"),
    name: s(r, "Name").trim(),
    sort: Number(s(r, "Sort_Order")) || 0,
    isCash: s(r, "Is_Cash") === "1",
    isCredit: s(r, "Is_Credit") === "1",
    isGift: s(r, "Is_GiftCert") === "1",
    isLoyalty: s(r, "is_Loyalty") === "1",
    isRoomCharge: s(r, "roomCharge") === "1",
    paymentDriver: s(r, "payment_Driver"),
    openCashDrawer: s(r, "Open_Cash_Drawer") === "1",
    askForTip: s(r, "Ask_For_Tip") === "1",
    overpayIsTip: s(r, "Overpay_Is_Tip") === "1",
    roundingAmount: s(r, "Enable_Rounding") === "1" ? s(r, "RoundingAmount") : "",
    appliesToCheck: s(r, "Applies_To_Check") === "1",
    hidden: s(r, "isHide") === "1",
    _raw: r,
  })).filter((t) => t.id);
}

export interface Employee {
  id: string;               // Emp_POS_ID
  name: string;             // First Last
  inTraining: boolean;
  _raw: DefRow;
}

export function employees(): Employee[] {
  return loadDefRows("Employee").filter(alive).map((r) => ({
    id: s(r, "Emp_POS_ID"),
    name: `${s(r, "First_Name")} ${s(r, "Last_Name")}`.trim() || s(r, "Emp_POS_ID"),
    inTraining: s(r, "In_Training") === "1",
    _raw: r,
  })).filter((e) => e.id);
}

export function chains(): Chain[] {
  return loadDefRows("Chain").filter(alive).map((r) => ({
    screenChainId: s(r, "Screen_Chain_POS_ID"),
    screenGroupId: s(r, "Screen_Group_POS_ID"),
    isForced: s(r, "Is_Forced") === "1",
    isModifier: s(r, "Is_Modifier") === "1",
    min: Number(s(r, "Min")) || 0,
    max: Math.min(20, Number(s(r, "Max")) || 0), // iPad caps Max at 20
    maxFreeCount: Number(s(r, "max_Free_Count")) || 0,
    sort: Number(s(r, "Sort_Order")) || 0,
    _raw: r,
  }));
}

export function screenChains(): ScreenChain[] {
  return loadDefRows("Screen_Chain").filter(alive).map((r) => ({
    id: s(r, "POS_ID"), name: s(r, "Name").trim(), _raw: r,
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
