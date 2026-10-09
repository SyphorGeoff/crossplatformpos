/*
 * 86 / item countdown: local count math (server − rung offset), the stock gate,
 * and the three HBroker messages (read / set / remove) + the read parser.
 */

import { describe, expect, it } from "vitest";
import { adjustCount, countFor, emptyCounts, stockRefusal, withServerCounts } from "@/model/itemcounts";
import { menuItemCountersXml, parseMenuItemCounters, updateMenuItemCounterXml } from "@/protocol/itemcounts";

const cfg = { enterpriseServerUrl: "https://x", isisVer: "1", storeId: "997", token: "T", terminalPosId: "58" };

describe("item counts (model)", () => {
  it("−1 without a counter; server − offset with one; a reload clears offsets", () => {
    let c = withServerCounts([{ menuItemId: "7", counter: 5 }]);
    expect(countFor(c, "7")).toBe(5);
    expect(countFor(c, "8")).toBe(-1);
    c = adjustCount(c, "7", 2);
    expect(countFor(c, "7")).toBe(3);
    c = adjustCount(c, "7", -1);            // an unsent line removed / a sent line voided
    expect(countFor(c, "7")).toBe(4);
    c = withServerCounts([{ menuItemId: "7", counter: 1 }]);
    expect(countFor(c, "7")).toBe(1);
  });
  it("stock gate: free when no counter; refuses at 0 and when the increase exceeds the count", () => {
    const c = adjustCount(withServerCounts([{ menuItemId: "7", counter: 2 }, { menuItemId: "9", counter: 0 }]), "7", 0);
    expect(stockRefusal(c, "x", 10)).toBeNull();
    expect(stockRefusal(c, "7", 2)).toBeNull();
    expect(stockRefusal(c, "7", 3)).toBe("Not enough items in stock");
    expect(stockRefusal(c, "9", 1)).toBe("No items in stock");
    expect(stockRefusal(c, "9", -1)).toBeNull();
    expect(stockRefusal(emptyCounts(), "9", 1)).toBeNull();
  });
});

describe("item counts (wire)", () => {
  it("read: Trans_Type Menu_Item_Counters with store, token, business date, employee, terminal", () => {
    const xml = menuItemCountersXml(cfg, { businessDateId: "123", empPosId: "33" });
    expect(xml).toContain('<Transactional_Request Trans_Type="Menu_Item_Counters">');
    expect(xml).toContain("<ISIS_Ver>1</ISIS_Ver><Store_ID>997</Store_ID><Security_Token>T</Security_Token><BusinessDate_ID>123</BusinessDate_ID><Emp_POS_ID>33</Emp_POS_ID><Terminal_POS_ID>58</Terminal_POS_ID></Transactional_Request>");
  });
  it("set: Update_Menu_Item_Counter with Remove_Counter=0 and the count (0 allowed = sold out)", () => {
    const xml = updateMenuItemCounterXml(cfg, { menuItemId: "7", counter: 0, authEmpId: "33" });
    expect(xml).toContain('<Update_Menu_Item_Counter Remove_Counter="0" Decrement_Counter="0" Increment_Counter="0">');
    expect(xml).toContain("<Menu_Item_POS_ID>7</Menu_Item_POS_ID><Counter>0</Counter><Authorizing_Emp_POS_ID>33</Authorizing_Emp_POS_ID></Update_Menu_Item_Counter>");
  });
  it("remove: Remove_Counter=1 and no Counter element", () => {
    const xml = updateMenuItemCounterXml(cfg, { menuItemId: "7", remove: true, authEmpId: "33" });
    expect(xml).toContain('Remove_Counter="1"');
    expect(xml).not.toContain("<Counter>");
    expect(xml).toContain("<Menu_Item_POS_ID>7</Menu_Item_POS_ID><Authorizing_Emp_POS_ID>33</Authorizing_Emp_POS_ID>");
  });
  it("parses Menu_Item_Counter rows (one or many) and skips junk", () => {
    const one = { Menu_Item_Counters: { Menu_Item_Counter: { Menu_Item_POS_ID: "7", Counter: "5" } } };
    expect(parseMenuItemCounters(one)).toEqual([{ menuItemId: "7", counter: 5 }]);
    const many = { Menu_Item_Counters: { Menu_Item_Counter: [
      { Menu_Item_POS_ID: "7", Counter: "5" }, { Menu_Item_POS_ID: "9", Counter: "0" }, { Menu_Item_POS_ID: "", Counter: "3" }, { Menu_Item_POS_ID: "4", Counter: "abc" },
    ] } };
    expect(parseMenuItemCounters(many)).toEqual([{ menuItemId: "7", counter: 5 }, { menuItemId: "9", counter: 0 }]);
  });
});
