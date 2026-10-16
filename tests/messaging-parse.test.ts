// @vitest-environment jsdom
/* parseMessagesXml — the three reply shapes the server emits (Message.java:99-164) */
import { describe, expect, it } from "vitest";
import { parseMessagesXml } from "@/protocol/messaging";

describe("parseMessagesXml", () => {
  it("filtered reply: ISIS_Version, optional From_Employee_Name, LocalNotified", () => {
    const xml = "<Messages><Message><ISIS_Version>1.0</ISIS_Version><Store_ID>3</Store_ID><Message_ID>42</Message_ID><Message_Body>Please note that the following menu item Coke is out of stock</Message_Body><To_Employee_POS_ID>1</To_Employee_POS_ID><From_Employee_POS_ID>9999</From_Employee_POS_ID><From_Employee_Name>Manager,Paul</From_Employee_Name><isRead>false</isRead><LocalNotified>0</LocalNotified><Sent_On>2026-10-16 19:40</Sent_On><Subject>Menu Item out of Stock: Coke</Subject><Event_ID></Event_ID><Check_ID></Check_ID><BusinessDate_ID></BusinessDate_ID><Email_Address></Email_Address></Message></Messages>";
    const [m] = parseMessagesXml(xml);
    expect(m).toMatchObject({ id: "42", fromEmpId: "9999", fromName: "Manager,Paul", toEmpId: "1", subject: "Menu Item out of Stock: Coke", sentOn: "2026-10-16 19:40", localNotified: false });
    expect(m.body).toMatch(/Coke is out of stock$/);
  });
  it("two messages, and LocalNotified=1 reads as notified", () => {
    const xml = "<Messages><Message><Message_ID>1</Message_ID><Subject>A</Subject><LocalNotified>1</LocalNotified></Message><Message><Message_ID>2</Message_ID><Subject>B</Subject><LocalNotified>0</LocalNotified></Message></Messages>";
    const ms = parseMessagesXml(xml);
    expect(ms.map((m) => m.id)).toEqual(["1", "2"]);
    expect(ms[0].localNotified).toBe(true);
  });
  it("empty reply <Messages></Messages> → []", () => {
    expect(parseMessagesXml("<Messages></Messages>")).toEqual([]);
  });
  it("Message_Status 400 Invalid Token throws", () => {
    expect(() => parseMessagesXml('<Message_Status Status_Code="400"><ISIS_Ver>1.0</ISIS_Ver><Status_Text>Invalid Token</Status_Text></Message_Status>')).toThrow(/Invalid Token/);
  });
});

import { fetchBroadcasts } from "@/protocol/messaging";
describe("broadcast parse (via fetchBroadcasts on a stubbed transport)", () => {
  it("drops rows without Broadcast=1 — an un-updated server returns the plain message list", async () => {
    const xml = "<Messages><Message><Message_ID>1</Message_ID><Subject>old</Subject></Message><Message><Message_ID>2</Message_ID><Subject>86</Subject><Message_Body>86 Ribeye</Message_Body><Broadcast>1</Broadcast><Terminal_POS_ID>Bar KDS</Terminal_POS_ID></Message></Messages>";
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(xml, { status: 200 })) as typeof fetch;
    try {
      const list = await fetchBroadcasts({ enterpriseServerUrl: "https://x", isisVer: "v", storeId: "3", token: "T", terminalPosId: "21" });
      expect(list.map((n) => n.id)).toEqual(["2"]);
      expect(list[0].terminalPosId).toBe("Bar KDS");
    } finally { globalThis.fetch = origFetch; }
  });
});
