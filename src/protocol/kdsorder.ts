/*
 * KDS ordering — faithful port of DisplayManager getKDSOrderString / sendOrderToKDS.
 * When a fired item routes to a KDS-flagged printer, the POS POSTs a JSON order
 * (not a paper chit) to {scheme}://{kdsPrinter.address}:{port}/remoteorder/
 * (443/8443 → https), body `?order='<json>'`, Content-type text/xml. Built from
 * the iOS getKDSOrderString structure so the crossplatformkds intake parses it.
 */

import { httpRequest } from "@/platform/http";
import type { Printer } from "@/model/printers";

export interface KdsHeader {
  token: string; entid: string; entcode: string;
  server: string; empId: string; guests: number; checkNo: string; date: string;
  revenueCenter: string; tableName: string; store: string; printerId: string;
  bdid: string; checkKey: string; togo: string; vip: string; allergy: string;
  fire?: string;   // NEW optional: "N" — this document releases course N (Fire Course), not a new round
}
export interface KdsItem {
  lineitemkey: string; quantity: string; description: string; amount: string;
  guestNumber: string; indentLevel: number; reference: string; type: string; isVoid: string;
  prepTime?: string;
  course?: string; // NEW optional: "1".."10"
  fired?: string;  // NEW optional: "0" = sent but held until Fire Course; absent/"1" = live
}

/** The KDS order document (getKDSOrderString). Built as a plain object and
 *  JSON-stringified for valid escaping; field names match the iOS output. */
export function buildKdsOrderJson(uuid: string, h: KdsHeader, items: KdsItem[], footer: { tax: string; total: string }): string {
  const doc = {
    UUID: uuid,
    check: {
      Token: h.token, entid: h.entid, entcode: h.entcode,
      header: {
        server: `Server: ${h.server}`, emp_pos: h.empId, guestCount: `Guests: ${h.guests}`,
        checkNumber: `Check: ${h.checkNo}`, date: h.date, revenueCenter: h.revenueCenter,
        tableName: h.tableName, store: h.store, printer: h.printerId, bdid: h.bdid,
        checkkey: h.checkKey, togo: h.togo, vip: h.vip, allergy: h.allergy,
        ...(h.fire !== undefined ? { fire: h.fire } : {}),
      },
      lineitem: items.map((l) => ({
        lineitemkey: l.lineitemkey, quantity: l.quantity, description: l.description, amount: l.amount,
        guestNumber: l.guestNumber, indentLevel: String(l.indentLevel), reference: l.reference,
        type: l.type, is_void: l.isVoid, prep_time: l.prepTime ?? "", KDSImage: "", detail: "",
        ...(l.course !== undefined ? { course: l.course } : {}),
        ...(l.fired !== undefined ? { fired: l.fired } : {}),
      })),
      footer: { tax: footer.tax, total: footer.total },
    },
  };
  return JSON.stringify(doc).replace(/\n/g, "");
}

/** POST the KDS order to the printer's /remoteorder/ endpoint (sendOrderToKDS). */
export async function sendKdsOrder(printer: Printer, json: string): Promise<boolean> {
  const scheme = printer.port === 443 || printer.port === 8443 ? "https" : "http";
  const url = `${scheme}://${printer.address}:${printer.port}/remoteorder/`;
  const body = `?order='${json}'`;
  try {
    const res = await httpRequest(url, { method: "POST", headers: { "Content-type": "text/xml" }, body });
    return res.ok;
  } catch { return false; }
}
