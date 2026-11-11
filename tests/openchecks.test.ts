// @vitest-environment jsdom
/*
 * Open_Checks reply → rows, with the lock state the list and the floor draw a
 * red lock from. Is_Locked is an attribute of <Open_Check>; a locked row names
 * the terminal in Locking_Terminal_POS_ID (shape taken from enox, 2026-11-11).
 */

import { describe, expect, it } from "vitest";
import { parseXmlResponse } from "@/protocol/hbroker";
import { lockedElsewhere, parseOpenChecks } from "@/protocol/tables";

const REPLY = `<?xml version="1.0"?><Open_Checks>
<Open_Check Is_Locked="0"><Store_ID>3</Store_ID><Table_POS_ID/><BusinessDate_ID>90119</BusinessDate_ID><Last_Modified_Time>2026-11-11 12:01</Last_Modified_Time>
<Check_Number>280020</Check_Number><check_key>111</check_key><Emp_POS_ID>5</Emp_POS_ID><Print_Count>1</Print_Count><Held_Item>0</Held_Item><Is_Allergy>0</Is_Allergy></Open_Check>
<Open_Check Is_Locked="1"><Store_ID>3</Store_ID><Table_POS_ID>92</Table_POS_ID><BusinessDate_ID>90111</BusinessDate_ID><Last_Modified_Time>2026-11-06 12:46</Last_Modified_Time>
<Check_Number>200080</Check_Number><check_key>8811378</check_key><Emp_POS_ID>1</Emp_POS_ID><Print_Count>0</Print_Count><Held_Item>0</Held_Item>
<Locking_Terminal_POS_ID>20</Locking_Terminal_POS_ID><Is_Allergy>0</Is_Allergy></Open_Check>
<Open_Check Is_Locked="1"><Check_Number>280021</Check_Number><check_key>222</check_key><Emp_POS_ID>1</Emp_POS_ID></Open_Check>
</Open_Checks>`;

describe("parseOpenChecks", () => {
  const rows = parseOpenChecks(parseXmlResponse(REPLY), "90119");
  it("reads every row, falling back to the asked business date", () => {
    expect(rows.map((r) => r.checkNo)).toEqual(["280020", "200080", "280021"]);
    expect(rows[1]).toMatchObject({ tableId: "92", checkKey: "8811378", businessDateId: "90111", empPosId: "1" });
    expect(rows[2].businessDateId).toBe("90119"); expect(rows[0].printCount).toBe(1);
  });
  it("an unlocked check has no locking terminal", () => { expect(rows[0].lockedBy).toBe(""); });
  it("a locked check names the terminal holding it", () => { expect(rows[1].lockedBy).toBe("20"); });
  it("locked with no terminal named is still locked", () => { expect(rows[2].lockedBy).toBe("?"); });
});

describe("lockedElsewhere", () => {
  it("another terminal's lock shows; this terminal's own lock and no lock do not", () => {
    expect(lockedElsewhere({ lockedBy: "20" }, "28")).toBe(true);
    expect(lockedElsewhere({ lockedBy: "28" }, "28")).toBe(false);
    expect(lockedElsewhere({ lockedBy: "?" }, "28")).toBe(true);
    expect(lockedElsewhere({ lockedBy: "" }, "28")).toBe(false);
    expect(lockedElsewhere({}, "28")).toBe(false);
    expect(lockedElsewhere(undefined, "28")).toBe(false);
  });
});
