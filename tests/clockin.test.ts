import { describe, expect, it } from "vitest";
import { clockInNeedsRoom } from "@/model/permissions";

const j = (o: Partial<{ skipTable: boolean; timeclockOnly: boolean; mgrMenu: boolean; managerServerMode: boolean }> = {}) =>
  ({ skipTable: false, timeclockOnly: false, mgrMenu: false, managerServerMode: false, ...o });

describe("clockInNeedsRoom", () => {
  it("a server job with rooms picks a room", () => { expect(clockInNeedsRoom(j(), 3)).toBe(true); });
  it("Skip_Table, clock-only and no rooms skip it", () => {
    expect(clockInNeedsRoom(j({ skipTable: true }), 3)).toBe(false);
    expect(clockInNeedsRoom(j({ timeclockOnly: true }), 3)).toBe(false);
    expect(clockInNeedsRoom(j(), 0)).toBe(false);
  });
  it("a Manager job (Mgr_Menu) never asks for a room; a manager-server job still does", () => {
    expect(clockInNeedsRoom(j({ mgrMenu: true }), 3)).toBe(false);
    expect(clockInNeedsRoom(j({ mgrMenu: true, managerServerMode: true }), 3)).toBe(true);
  });
});
