import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTerminalData, loadJSON, saveJSON } from "@/platform/storage";

function memStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

beforeEach(() => { vi.stubGlobal("localStorage", memStorage()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("clearTerminalData (re-activation wipes the store's cache)", () => {
  it("drops every definition table, the revision map and the open check, keeps settings", () => {
    saveJSON("settings.v1", { storeId: "3", activated: true });
    saveJSON("def.Menu_Item.v1", [{ Menu_Item_POS_ID: "1", Revision_Seq: "900" }]);
    saveJSON("def.Store.v1", [{ Store_ID: "3" }]);
    saveJSON("defseq.v1", { Menu_Item: 900 });
    saveJSON("check.open.v1", { lines: [] });
    localStorage.setItem("other.app", "keep");
    clearTerminalData();
    expect(loadJSON("settings.v1", null)).toEqual({ storeId: "3", activated: true });
    expect(loadJSON("def.Menu_Item.v1", [])).toEqual([]);
    expect(loadJSON("def.Store.v1", [])).toEqual([]);
    expect(loadJSON("defseq.v1", {})).toEqual({});       // empty map → App runs fullSync, not incremental
    expect(loadJSON("check.open.v1", null)).toBeNull();
    expect(localStorage.getItem("other.app")).toBe("keep");
  });
});
