/*
 * HBroker builder parity — byte-format checks against the strings the iOS ISIS
 * client concatenates (TerminalConfigManager.m:886/916, DefinitionManager.m:2640).
 */

import { describe, expect, it } from "vitest";
import { apiServerAddress, buildNewTerminalToken, buildStandardToken, buildDefinitionRequest } from "@/protocol/hbroker";
import { DEFINITIONS } from "@/model/definitions";

describe("apiServerAddress", () => {
  it("appends /ISISPOS/HBroker", () => {
    expect(apiServerAddress("https://enox.aireus.com")).toBe("https://enox.aireus.com/ISISPOS/HBroker");
    expect(apiServerAddress("https://enox.aireus.com/")).toBe("https://enox.aireus.com/ISISPOS/HBroker");
  });
});

describe("Token_Request New_Terminal (TerminalConfigManager.m:886)", () => {
  it("matches element order and DTD", () => {
    expect(buildNewTerminalToken({ isisVer: "ver 1.0.0", terminalUID: "1234567890", enterpriseCode: "ENOX", login: "admin", password: "p" })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE Token_Request SYSTEM "Transactions/Post_Messages/Token_Request.dtd"><Token_Request Token_Type="New_Terminal"><ISIS_Ver>ver 1.0.0</ISIS_Ver><Terminal_UID>1234567890</Terminal_UID><Enterprise_Code>ENOX</Enterprise_Code><Enterprise_Login>admin</Enterprise_Login><Enterprise_Password>p</Enterprise_Password></Token_Request>',
    );
  });
});

describe("Token_Request Standard (TerminalConfigManager.m:916)", () => {
  it("carries empty Emp_POS_ID/Pin/Login/Password", () => {
    const xml = buildStandardToken({ isisVer: "ver 1.0.0", storeId: "3", terminalPosId: "17", terminalUID: "1234567890", enterpriseCode: "ENOX" });
    expect(xml).toContain('Token_Type="Standard"');
    expect(xml).toContain("<Store_ID>3</Store_ID><Terminal_POS_ID>17</Terminal_POS_ID>");
    expect(xml).toContain("<Emp_POS_ID></Emp_POS_ID><Pin></Pin>");
    expect(xml).toContain("<Enterprise_Login></Enterprise_Login><Enterprise_Password></Enterprise_Password>");
  });
});

describe("Definition_Request (DefinitionManager.m:2640)", () => {
  it("full load: Override_Revision_Seq=0, Current_Revision_Seq=0, no change_sequence", () => {
    const xml = buildDefinitionRequest({ definitionType: "Menu_Items", isisVer: "ver 1.0.0", storeId: "3", securityToken: "T" });
    expect(xml).toContain('Override_Revision_Seq="0" Definition_Type="Menu_Items"');
    expect(xml).toContain("<Current_Revision_Seq>0</Current_Revision_Seq>");
    expect(xml).not.toContain("change_sequence");
    expect(xml).toContain("<Security_Token>T</Security_Token>");
  });
  it("incremental: includes change_sequence when given", () => {
    const xml = buildDefinitionRequest({ definitionType: "Menu_Items", isisVer: "v", storeId: "3", securityToken: "T", currentRevisionSeq: 40, changeSequence: 12 });
    expect(xml).toContain("<Current_Revision_Seq>40</Current_Revision_Seq><change_sequence>12</change_sequence>");
  });
});

describe("definition catalog", () => {
  it("has the 51 cited definition types in client order", () => {
    expect(DEFINITIONS).toHaveLength(51);
    expect(DEFINITIONS[0]).toEqual({ name: "Adjustments", table: "Adjustment" });
    expect(DEFINITIONS[18]).toEqual({ name: "Menu_Items", table: "Menu_Item" });
    expect(DEFINITIONS[DEFINITIONS.length - 1]).toEqual({ name: "Images", table: "Image" });
  });
});

// parseXmlResponse uses the browser DOMParser (web + WebView); it is verified
// live against enox rather than unit-tested in node (spec open question #2/#3).
