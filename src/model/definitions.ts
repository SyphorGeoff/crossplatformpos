/*
 * The definition catalog — the 51 definition types the iOS ISIS client syncs,
 * in the client's own order. Cited verbatim from DefinitionManager.m:163-640
 * (each `setValue:@"…" forKey:@"DEFINITION_NAME"` / `TABLE_NAME`).
 *
 * `name` is the wire value used in Definition_Request Definition_Type=…;
 * `table` is the row's table (its Revision_Seq/change_sequence namespace).
 * A definition is just an array of plain objects (a table's rows) — NO ORM,
 * NO Core Data. The iPad's Core Data was stripped years ago; what remained was
 * object instantiation that is morally arrays-of-dictionaries. We do exactly
 * that: typed records held in memory and cached to storage.
 */

export interface DefinitionType {
  name: string;   // Definition_Type on the wire
  table: string;  // row table / sequence namespace
}

export const DEFINITIONS: DefinitionType[] = [
  { name: "Adjustments", table: "Adjustment" },
  { name: "Adjustment_Departments", table: "Adjustment_Department" },
  { name: "Adjustment_RevenueCenters", table: "Adjustment_RevenueCenter" },
  { name: "Buttons", table: "AIScreen_Button" },
  { name: "Categories", table: "Category" },
  { name: "Chains", table: "Chain" },
  { name: "Check_Wrappers", table: "Check_Wrappers" },
  { name: "Departments", table: "Department" },
  { name: "Dining_Rooms", table: "Dining_Room" },
  { name: "DiningTables", table: "DiningTable" },
  { name: "Employees", table: "Employee" },
  { name: "Employee_Jobs", table: "Employee_Job" },
  { name: "Emp_DiningRooms", table: "Emp_DiningRoom" },
  { name: "Events", table: "Event" },
  { name: "Hourly_Pricing", table: "Hourly_Pricing" },
  { name: "Jobs", table: "Job" },
  { name: "Languages", table: "Language" },
  { name: "Menu_Item_Tax_Groups", table: "Menu_Item_Tax_Group" },
  { name: "Menu_Items", table: "Menu_Item" },
  { name: "Mobile_Dashboard", table: "Mobile_Dashboard" },
  { name: "Outlets", table: "Outlet" },
  { name: "PayInOuts", table: "PayInOut" },
  { name: "Print_Groups", table: "Print_Group" },
  { name: "Printers", table: "Printer" },
  { name: "Printer_Print_Groups", table: "Printer_Print_Group" },
  { name: "ProductionItems", table: "ProductionItem" },
  { name: "Revenue_Centers", table: "Revenue_Center" },
  { name: "RevenueCenter_Screen_Groups", table: "RevenueCenter_Screen_Group" },
  { name: "RevenueCenter_Print_Groups", table: "RevenueCenter_Print_Group" },
  { name: "Screen_Chain_Exemptions", table: "Terminal_Screen_Chain_Exemption" },
  { name: "Screen_Chains", table: "Screen_Chain" },
  { name: "Screen_Groups", table: "Screen_Group" },
  { name: "Store", table: "Store" },
  { name: "Tax_Packs", table: "Tax_Pack" },
  { name: "Tax_Report_Groups", table: "Tax_Report_Group" },
  { name: "Tenders", table: "Tender" },
  { name: "Terminals", table: "Terminal" },
  { name: "Terminal_Print_Groups", table: "Terminal_Print_Group" },
  { name: "TimePeriods", table: "TimePeriod" },
  { name: "ToppingPrefixes", table: "ToppingPrefix" },
  { name: "ToppingGroups", table: "ToppingGroup" },
  { name: "Topping_MenuItems", table: "Topping_MenuItem" },
  { name: "Topping_ToppingPrefixes", table: "Topping_ToppingPrefix" },
  { name: "Voids", table: "Void" },
  { name: "Wine_Appellations", table: "Wine_Appellation" },
  { name: "Wine_Styles", table: "Wine_Style" },
  { name: "Wine_Varietals", table: "Wine_Varietal" },
  { name: "Wines", table: "Wine" },
  { name: "Themes", table: "Theme" },
  { name: "Localization", table: "Localization" },
  { name: "Images", table: "Image" },
];

/** One definition table's rows: an array of untyped records (the wire shape).
 *  Specific typed accessors (Menu_Item, Tender, Store…) come as views over this
 *  as each subsystem is built; the sync layer stays type-agnostic. */
export type DefRow = Record<string, unknown>;
export type DefStore = Record<string, DefRow[]>; // table -> rows
