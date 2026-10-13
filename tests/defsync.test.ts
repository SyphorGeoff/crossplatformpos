/*
 * (jsdom: parseXmlResponse uses the browser DOMParser.)
 * Definition sync safety — the live "All" sequence map is a root-less run of
 * <Table>seq</Table> elements; a 0 / absent sequence means "always re-pull"
 * (DefinitionManager syncDataSynchNoThread); and an error reply
 * (<Message_Status Status_Code="400">Invalid Token) must NEVER be saved as an
 * empty table (2026-10-13: a lapsed token wiped every definition on a terminal).
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/protocol/hbroker", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/protocol/hbroker")>();
  return { ...orig, postXml: vi.fn() };
});

import { postXml } from "@/protocol/hbroker";
import { DefinitionError, incrementalSync, loadDefRows, loadSeqMap, type SyncConfig } from "@/protocol/defsync";
import { saveJSON } from "@/platform/storage";

const cfg: SyncConfig = { enterpriseServerUrl: "https://x", isisVer: "ver 1.0.0", storeId: "3", token: "T" };
const ERR = '<Message_Status Status_Code="400"><ISIS_Ver>1.0</ISIS_Ver><Status_Text>Invalid Token</Status_Text></Message_Status>';
const NONE = '<Message_Status Status_Code="100"><ISIS_Ver>1.0</ISIS_Ver><Status_Text>No records found</Status_Text></Message_Status>';
const typeOf = (xml: string) => /Definition_Type="([^"]+)"/.exec(xml)?.[1] ?? "";

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memStorage());
  saveJSON("def.Employee.v1", [{ Emp_POS_ID: "9999", Revision_Seq: "300" }]);
  saveJSON("def.Adjustment_Department.v1", [{ Adjustment_POS_ID: "21", Department_POS_ID: "2", Revision_Seq: "0" }]);
  saveJSON("defseq.v1", { Employee: 300, Adjustment_Department: 0 });
});
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(postXml).mockReset(); });

describe("incrementalSync", () => {
  it("re-pulls tables the server has moved past and always re-pulls 0-seq tables", async () => {
    vi.mocked(postXml).mockImplementation(async (_u, xml) => {
      switch (typeOf(xml)) {
        case "All": return "<Employee>366</Employee><Adjustment_Department>0</Adjustment_Department><Job>111</Job>";
        case "Employees": return "<Employees><Employee><Emp_POS_ID>9999</Emp_POS_ID><Revision_Seq>366</Revision_Seq></Employee></Employees>";
        case "Adjustment_Departments": return "<Adjustment_Departments><Adjustment_Department><Adjustment_POS_ID>29</Adjustment_POS_ID><Department_POS_ID>6</Department_POS_ID><Revision_Seq>0</Revision_Seq></Adjustment_Department></Adjustment_Departments>";
        default: return NONE;
      }
    });
    const changed = await incrementalSync(cfg);
    expect(changed).toEqual(expect.arrayContaining(["Employees", "Adjustment_Departments"]));
    expect(loadSeqMap().Employee).toBe(366);
    expect(loadDefRows("Adjustment_Department")[0].Adjustment_POS_ID).toBe("29");
  });

  it("an unchanged 0-seq table is re-pulled but not reported as changed", async () => {
    vi.mocked(postXml).mockImplementation(async (_u, xml) => {
      switch (typeOf(xml)) {
        case "All": return "<Employee>300</Employee><Adjustment_Department>0</Adjustment_Department>";
        case "Adjustment_Departments": return "<Adjustment_Departments><Adjustment_Department><Adjustment_POS_ID>21</Adjustment_POS_ID><Department_POS_ID>2</Department_POS_ID><Revision_Seq>0</Revision_Seq></Adjustment_Department></Adjustment_Departments>";
        default: return NONE;
      }
    });
    expect(await incrementalSync(cfg)).toEqual([]);
  });

  it("an error on the All request throws and keeps every cached table", async () => {
    vi.mocked(postXml).mockResolvedValue(ERR);
    await expect(incrementalSync(cfg)).rejects.toBeInstanceOf(DefinitionError);
    expect(loadDefRows("Employee")).toHaveLength(1);
    expect(loadSeqMap().Employee).toBe(300);
  });

  it("a missing sequence map aborts instead of reading as all-zero", async () => {
    vi.mocked(postXml).mockResolvedValue("<html>gateway timeout</html>");
    expect(await incrementalSync(cfg)).toEqual([]);
    expect(loadDefRows("Employee")).toHaveLength(1);
    expect(postXml).toHaveBeenCalledTimes(1); // no table pulls at all
  });

  it("an error on a table pull throws and never saves an empty table", async () => {
    vi.mocked(postXml).mockImplementation(async (_u, xml) =>
      typeOf(xml) === "All" ? "<Employee>366</Employee>" : ERR);
    await expect(incrementalSync(cfg)).rejects.toThrow(/Invalid Token/);
    expect(loadDefRows("Employee")).toHaveLength(1);
    expect(loadSeqMap().Employee).toBe(300);
  });

  it("reads rows whose wrapper is not the request name (Hourly_Pricing → <Hourly_Prices>)", async () => {
    vi.mocked(postXml).mockImplementation(async (_u, xml) => {
      switch (typeOf(xml)) {
        case "All": return "<Employee>300</Employee><Hourly_Pricing>49</Hourly_Pricing>";
        case "Hourly_Pricing": return "<Hourly_Prices><Hourly_Price><POS_ID>1</POS_ID><Monday>1</Monday><Revision_Seq>49</Revision_Seq></Hourly_Price></Hourly_Prices>";
        default: return NONE;
      }
    });
    expect(await incrementalSync(cfg)).toContain("Hourly_Pricing");
    expect(loadDefRows("Hourly_Pricing")).toHaveLength(1);
  });

  it("'No records found' and an empty wrapper are genuinely empty tables", async () => {
    vi.mocked(postXml).mockImplementation(async (_u, xml) => {
      switch (typeOf(xml)) {
        case "All": return "<Employee>366</Employee><Outlet>0</Outlet><Hourly_Pricing>49</Hourly_Pricing>";
        case "Employees": return "<Employees><Employee><Emp_POS_ID>9999</Emp_POS_ID><Revision_Seq>366</Revision_Seq></Employee></Employees>";
        case "Outlets": return "<Outlets></Outlets>";
        default: return NONE;
      }
    });
    await incrementalSync(cfg);
    expect(loadDefRows("Outlet")).toEqual([]);
    expect(loadDefRows("Hourly_Pricing")).toEqual([]);
    expect(loadSeqMap().Hourly_Pricing).toBe(49); // recorded at the server's seq, so it is not re-pulled every pass
  });
});
