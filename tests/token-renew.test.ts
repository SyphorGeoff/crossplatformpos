// @vitest-environment jsdom
/*
 * Session token renewal — the server keeps one Standard token per terminal, so
 * any call can come back "Invalid Token". postXml then asks the registered
 * renewer for a fresh token and sends the same request once more (Geoff
 * 2026-11-11). An error reply is never read as data: the clock check throws
 * instead of reporting "not clocked in".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isInvalidTokenReply, postXml, setTokenRenewer } from "@/protocol/hbroker";
import { fetchClockedInEmp, ServerReplyError } from "@/protocol/timeclock";
import type { SessionConfig } from "@/protocol/order";

const calls: Array<{ url: string; body: string }> = [];
let replies: string[] = [];
vi.mock("@/platform/http", () => ({
  httpRequest: vi.fn(async (url: string, init: { body?: string }) => {
    calls.push({ url, body: init.body ?? "" });
    const text = replies.shift() ?? "";
    return { ok: true, status: 200, text: async () => text, bytes: async () => new ArrayBuffer(0) };
  }),
}));

const INVALID = `<Message_Status Status_Code="400"><ISIS_Ver>1.0</ISIS_Ver><Status_Text>Invalid Token</Status_Text></Message_Status>`;
const REQ = (tok: string) => `<Transactional_Request Trans_Type="Clocked_In_Emps"><Store_ID>3</Store_ID><Security_Token>${tok}</Security_Token></Transactional_Request>`;
const LIST = `<Clocked_In_Emps><Clocked_In_Emp><Emp_POS_ID>1</Emp_POS_ID><BusinessDate_ID>90119</BusinessDate_ID><Sequence>1</Sequence><Job_POS_ID>2</Job_POS_ID></Clocked_In_Emp></Clocked_In_Emps>`;
const cfg: SessionConfig = { enterpriseServerUrl: "https://enox.aireus.com", isisVer: "1.0", storeId: "3", token: "OLD.1", terminalPosId: "28" };

beforeEach(() => { calls.length = 0; replies = []; });
afterEach(() => { setTokenRenewer(null); });

describe("isInvalidTokenReply", () => {
  it("recognises the server's Invalid Token status and nothing else", () => {
    expect(isInvalidTokenReply(INVALID)).toBe(true);
    expect(isInvalidTokenReply(`<Message_Status Status_Code="400"><Status_Text>Check not posted</Status_Text></Message_Status>`)).toBe(false);
    expect(isInvalidTokenReply(`<Message_Status Status_Code="100"><Status_Text>OK</Status_Text></Message_Status>`)).toBe(false);
    expect(isInvalidTokenReply(LIST)).toBe(false);
  });
});

describe("postXml", () => {
  it("renews the token and sends the same request again with it", async () => {
    const renew = vi.fn(async () => "NEW.2");
    setTokenRenewer(renew);
    replies = [INVALID, LIST];
    const out = await postXml("https://enox.aireus.com/ISISPOS/HBroker", REQ("OLD.1"));
    expect(out).toBe(LIST);
    expect(renew).toHaveBeenCalledWith("OLD.1");
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toContain("<Security_Token>OLD.1</Security_Token>");
    expect(calls[1].body).toBe(REQ("NEW.2"));
  });
  it("retries once only: a second refusal is passed on", async () => {
    setTokenRenewer(async () => "NEW.2");
    replies = [INVALID, INVALID];
    expect(await postXml("u", REQ("OLD.1"))).toBe(INVALID);
    expect(calls).toHaveLength(2);
  });
  it("passes the refusal on when no token could be had (refused request, or the network)", async () => {
    setTokenRenewer(async () => null);
    replies = [INVALID];
    expect(await postXml("u", REQ("OLD.1"))).toBe(INVALID);
    expect(calls).toHaveLength(1);
    setTokenRenewer(async () => { throw new Error("offline"); });
    replies = [INVALID];
    expect(await postXml("u", REQ("OLD.1"))).toBe(INVALID);
  });
  it("leaves ordinary replies, other errors and token requests alone", async () => {
    const renew = vi.fn(async () => "NEW.2");
    setTokenRenewer(renew);
    replies = [LIST, `<Message_Status Status_Code="400"><Status_Text>Check not posted</Status_Text></Message_Status>`, INVALID];
    expect(await postXml("u", REQ("OLD.1"))).toBe(LIST);
    expect(await postXml("u", REQ("OLD.1"))).toContain("Check not posted");
    expect(await postXml("u", `<Token_Request Token_Type="Standard"><Store_ID>3</Store_ID></Token_Request>`)).toBe(INVALID);   // no session token in it: nothing to renew
    expect(renew).not.toHaveBeenCalled(); expect(calls).toHaveLength(3);
  });
  it("without a renewer registered nothing changes", async () => {
    replies = [INVALID];
    expect(await postXml("u", REQ("OLD.1"))).toBe(INVALID); expect(calls).toHaveLength(1);
  });
});

describe("sign-in clock check", () => {
  it("a rejected token is renewed and the employee is found clocked in", async () => {
    setTokenRenewer(async () => "NEW.2");
    replies = [INVALID, LIST];
    expect(await fetchClockedInEmp(cfg, "1")).toMatchObject({ empId: "1", jobId: "2", businessDateId: "90119" });
  });
  it("an error reply throws: it is never read as 'not clocked in'", async () => {
    replies = [INVALID];
    await expect(fetchClockedInEmp(cfg, "1")).rejects.toBeInstanceOf(ServerReplyError);
    replies = [INVALID];
    await expect(fetchClockedInEmp(cfg, "1")).rejects.toThrow(/Invalid Token/);
  });
  it("a real list without the employee still means not clocked in", async () => {
    replies = [LIST];
    expect(await fetchClockedInEmp(cfg, "5")).toBeNull();
    replies = [`<Clocked_In_Emps></Clocked_In_Emps>`];
    expect(await fetchClockedInEmp(cfg, "1")).toBeNull();
  });
});
