/*
 * Definitions sync — faithful port of DefinitionManager.m's revision-driven
 * pull (syncDataSynchNoThread :1043, getAllSeq :1773, makeDefXML :2640).
 *
 * Model (iPad parity):
 *  - FIRST LOAD: pull every definition with Current_Revision_Seq=0 (full),
 *    store rows, and record each table's max Revision_Seq.
 *  - INCREMENTAL: GET the per-table sequence map (Definition_Type="All"),
 *    compare to the stored max per table, and re-pull only the tables whose
 *    server sequence is higher. (Language/Localization special-cased on the
 *    iPad; Tender/Adjustment changes flag a tender refresh.)
 *  - A definition is an array of plain row objects. No ORM.
 *
 * Persisted to storage under one key per table + a sequence map, so a reload /
 * offline start serves the cached copy (the .def-file cache analog).
 *
 * OPEN (verify against live enox, like the KDS spec's open questions):
 *  - exact element names inside the row payloads and the "All" seq-map response;
 *    parsing here is defensive (row = any child element under the type wrapper;
 *    sequence read from Revision_Seq or change_sequence). Tighten once seen live.
 */

import { DEFINITIONS, type DefRow } from "@/model/definitions";
import { apiServerAddress, asList, buildDefinitionRequest, findKey, parseXmlResponse, postXml, textOf, type XmlDict } from "./hbroker";
import { loadJSON, saveJSON } from "@/platform/storage";

const SEQ_KEY = "defseq.v1";                  // table -> max revision seq seen
const rowsKey = (table: string) => `def.${table}.v1`;

export interface SyncConfig {
  enterpriseServerUrl: string;
  isisVer: string;
  storeId: string;
  token: string;
}

export interface SyncProgress {
  (definitionName: string, index: number, total: number, rows: number): void;
}

/** Max numeric Revision_Seq / change_sequence across a set of rows. */
function maxSeq(rows: DefRow[]): number {
  let m = 0;
  for (const r of rows) {
    const v = Number(r["Revision_Seq"] ?? r["change_sequence"] ?? 0);
    if (Number.isFinite(v) && v > m) m = v;
  }
  return m;
}

/** Thrown when the server answers a definition request with an error
 *  (<Message_Status Status_Code="400"><Status_Text>Invalid Token</Status_Text>).
 *  Callers keep the cached rows — an error is NEVER saved as an empty table. */
export class DefinitionError extends Error {
  constructor(message: string, public readonly statusCode: string) { super(message); }
}

/** Server replies seen live (enox 2026-10-13):
 *    rows        <Employees><Employee>…</Employee>…</Employees>
 *    empty       <Outlets></Outlets>
 *    empty       <Message_Status Status_Code="100">…<Status_Text>No records found</Status_Text>
 *    error       <Message_Status Status_Code="400">…<Status_Text>Invalid Token</Status_Text>
 *  Anything else is unrecognised and also an error (never an empty table). */
function statusOf(parsed: XmlDict): { code: string; text: string } | null {
  const ms = findKey(parsed, "Message_Status");
  if (!ms || typeof ms === "string" || Array.isArray(ms)) return null;
  const code = textOf(findKey(ms, "Status_Code"));
  const text = textOf(findKey(ms, "Status_Text"));
  return { code, text };
}

/** Pull one definition table directly, ignoring the revision map (e.g. Terminals for
 *  the assignment check — a re-assignment does not bump the Terminal revision). */
export const pullTable = (cfg: SyncConfig, name: string): Promise<DefRow[]> => pullDefinition(cfg, name);

/** Pull one definition fully (Current_Revision_Seq=0) and return its rows. */
async function pullDefinition(cfg: SyncConfig, name: string): Promise<DefRow[]> {
  const xml = buildDefinitionRequest({
    definitionType: name, isisVer: cfg.isisVer, storeId: cfg.storeId,
    securityToken: cfg.token, currentRevisionSeq: 0,
  });
  const resp = await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml);
  const parsed = parseXmlResponse(resp);
  const status = statusOf(parsed);
  if (status) {
    if (status.code === "100") return []; // "No records found" — a genuinely empty table
    throw new DefinitionError(`${name}: ${status.text || "server error"} (${status.code || "?"})`, status.code);
  }
  // rows = the repeated child elements under the reply's root wrapper. The
  // wrapper is NOT always the request name (Hourly_Pricing → <Hourly_Prices>),
  // so take whatever single root the server answered with.
  const rootKeys = Object.keys(parsed).filter((k) => k !== "_text");
  if (rootKeys.length !== 1) throw new DefinitionError(`${name}: unrecognised reply`, "");
  const wrapper = parsed[rootKeys[0]];
  if (wrapper && typeof wrapper !== "string" && !Array.isArray(wrapper)) {
    for (const [k, v] of Object.entries(wrapper as XmlDict)) {
      if (k === "_text") continue;
      const list = asList(v);
      if (list.length) return list as DefRow[];
    }
  }
  return []; // <Outlets></Outlets>
}

export const loadDefRows = (table: string): DefRow[] => loadJSON<DefRow[]>(rowsKey(table), []);
export const loadSeqMap = (): Record<string, number> => loadJSON<Record<string, number>>(SEQ_KEY, {});

/** Full first-load: every definition, in the client's order. */
export async function fullSync(cfg: SyncConfig, onProgress?: SyncProgress): Promise<void> {
  const seq = loadSeqMap();
  for (let i = 0; i < DEFINITIONS.length; i++) {
    const def = DEFINITIONS[i];
    const rows = await pullDefinition(cfg, def.name);
    saveJSON(rowsKey(def.table), rows);
    seq[def.table] = maxSeq(rows);
    onProgress?.(def.name, i, DEFINITIONS.length, rows.length);
  }
  // We now hold everything the server has: record the server's own numbers so
  // the next revision check is quiet (a few tables' rows carry no Revision_Seq
  // — Store, ToppingPrefixes — and would otherwise re-pull once).
  try {
    const server = await fetchSeqMap(cfg);
    for (const [table, n] of Object.entries(server)) seq[table] = Math.max(seq[table] ?? 0, n);
  } catch { /* keep the row-derived numbers */ }
  saveJSON(SEQ_KEY, seq);
}

/**
 * Incremental sync via the "All" sequence map. Returns the definition names
 * that were re-pulled. Falls back to a no-op if the map is unreadable (keeps
 * the cached copy — never blanks the terminal).
 */
/** The server's sequence map ("All"): table → highest Revision_Seq. Empty when
 *  the server did not answer with one; throws on an explicit error reply. */
export async function fetchSeqMap(cfg: SyncConfig): Promise<Record<string, number>> {
  const serverSeq: Record<string, number> = {};
  let raw = "";
  try {
    const xml = buildDefinitionRequest({
      definitionType: "All", isisVer: cfg.isisVer, storeId: cfg.storeId, securityToken: cfg.token, currentRevisionSeq: 0,
    });
    raw = await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml);
    // The All response (seen live on enox 2026-10-13) has NO root element — it is a
    // bare run of <Table>seq</Table> siblings (<Employee>366</Employee><Job>111</Job>…
    // <Adjustment>176</Adjustment>…), which an XML parser rejects. Read it directly:
    // one element per TABLE name whose text is that table's highest Revision_Seq.
    for (const m of raw.matchAll(/<([A-Za-z_][\w]*)>\s*(-?\d+)\s*<\/\1>/g)) serverSeq[m[1]] = Number(m[2]);
    // Older/row-shaped variant (defensive): rows with a table name + sequence field.
    if (Object.keys(serverSeq).length === 0) {
      const parsed = parseXmlResponse(raw);
      for (const row of asList(findKey(parsed, "Definition") ?? findKey(parsed, "All"))) {
        const table = textOf(findKey(row, "TABLE_NAME") ?? findKey(row, "Table_Name") ?? findKey(row, "Definition_Type"));
        const s = Number(textOf(findKey(row, "Revision_Seq") ?? findKey(row, "change_sequence")) || 0);
        if (table) serverSeq[table] = s;
      }
    }
  } catch {
    return {}; // offline / unreadable — keep cache
  }
  // No sequence map at all = the server did not answer the "All" request with
  // one (an error such as Invalid Token, or an outage). An absent map must
  // never read as "every table is at 0".
  if (Object.keys(serverSeq).length === 0) {
    const status = statusOf(parseXmlResponse(raw));
    if (status && status.code !== "100") throw new DefinitionError(`All: ${status.text || "server error"} (${status.code})`, status.code);
  }
  return serverSeq;
}

export async function incrementalSync(cfg: SyncConfig, onProgress?: SyncProgress): Promise<string[]> {
  const serverSeq = await fetchSeqMap(cfg);
  if (Object.keys(serverSeq).length === 0) return []; // abort, keep every cached table

  const local = loadSeqMap();
  const changed: string[] = [];
  for (let i = 0; i < DEFINITIONS.length; i++) {
    const def = DEFINITIONS[i];
    const svr = serverSeq[def.table] ?? 0;
    // DefinitionManager syncDataSynchNoThread: a table the server reports with no
    // sequence (or 0 — e.g. Adjustment_Department, DiningTable, Store) is always
    // re-pulled in full; otherwise only when the server has moved past our cache.
    if (svr === 0 || svr > (local[def.table] ?? 0)) {
      const rows = await pullDefinition(cfg, def.name);
      // An always-pulled (0-seq) table only counts as changed when its rows differ.
      const same = svr === 0 && JSON.stringify(rows) === JSON.stringify(loadDefRows(def.table));
      saveJSON(rowsKey(def.table), rows);
      // We now hold everything the server has for this table, so record the
      // server's sequence — rows for an empty/legacy table carry a lower (or 0)
      // Revision_Seq and would otherwise re-pull on every pass.
      local[def.table] = Math.max(maxSeq(rows), svr);
      if (!same) changed.push(def.name);
      onProgress?.(def.name, i, DEFINITIONS.length, rows.length);
    }
  }
  saveJSON(SEQ_KEY, local);
  return changed;
}
