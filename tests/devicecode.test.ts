/*
 * The TEMPORARY device-id save through /ISISPOS/devicecode_cap.jsp
 * (protocol/devicecode.ts): the URL the iPad's Square pairing uses, and how the
 * page's reply is read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { deviceCodeUrl, saveDeviceId } from "@/protocol/devicecode";

const calls: Array<{ url: string; method?: string }> = [];
let reply: { ok: boolean; status: number; text: string } | Error = { ok: true, status: 200, text: "" };
vi.mock("@/platform/http", () => ({
  httpRequest: vi.fn(async (url: string, init: { method?: string }) => {
    calls.push({ url, method: init.method });
    if (reply instanceof Error) throw reply;
    const r = reply;
    return { ok: r.ok, status: r.status, text: async () => r.text, bytes: async () => new ArrayBuffer(0) };
  }),
}));

const cfg = { enterpriseServerUrl: "https://enox.aireus.com/", storeId: "3", terminalUid: "6168738826" };
beforeEach(() => { calls.length = 0; reply = { ok: true, status: 200, text: "<body>oauthurl -- devicecode saved OK<br></body>" }; });

describe("device id save (temporary JSP route)", () => {
  it("builds the page URL with Store_ID, devicecode and terminaluid", () => {
    expect(deviceCodeUrl(cfg, "tmr_ABC 1")).toBe("https://enox.aireus.com/ISISPOS/devicecode_cap.jsp?Store_ID=3&devicecode=tmr_ABC%201&terminaluid=6168738826");
  });
  it("a 200 with the saved marker is ok", async () => {
    expect(await saveDeviceId(cfg, "tmr_ABC")).toEqual({ ok: true, message: "saved" });
    expect(calls).toHaveLength(1); expect(calls[0].method).toBe("GET");
  });
  it("a reply without the marker, an HTTP error and a network error are failures", async () => {
    reply = { ok: true, status: 200, text: "oauthurl -- devicecode not saved<br>" };
    expect((await saveDeviceId(cfg, "tmr_ABC")).ok).toBe(false);
    reply = { ok: false, status: 500, text: "" };
    expect(await saveDeviceId(cfg, "tmr_ABC")).toEqual({ ok: false, message: "HTTP 500" });
    reply = new Error("offline");
    expect(await saveDeviceId(cfg, "tmr_ABC")).toEqual({ ok: false, message: "offline" });
  });
  it("does not call the server without an activated terminal or a device id", async () => {
    expect((await saveDeviceId({ ...cfg, terminalUid: "" }, "tmr_ABC")).ok).toBe(false);
    expect((await saveDeviceId(cfg, " ")).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
