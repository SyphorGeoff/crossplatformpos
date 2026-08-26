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

/** Pull one definition fully (Current_Revision_Seq=0) and return its rows. */
async function pullDefinition(cfg: SyncConfig, name: string): Promise<DefRow[]> {
  const xml = buildDefinitionRequest({
    definitionType: name, isisVer: cfg.isisVer, storeId: cfg.storeId,
    securityToken: cfg.token, currentRevisionSeq: 0,
  });
  const resp = await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml);
  const parsed = parseXmlResponse(resp);
  // rows = the repeated child elements under the response wrapper. Defensive:
  // find the wrapper for this type, then take its array-valued child.
  const wrapper = findKey(parsed, name);
  if (wrapper && typeof wrapper !== "string" && !Array.isArray(wrapper)) {
    for (const v of Object.values(wrapper as XmlDict)) {
      const list = asList(v);
      if (list.length) return list as DefRow[];
    }
  }
  return asList(wrapper) as DefRow[];
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
  saveJSON(SEQ_KEY, seq);
}

/**
 * Incremental sync via the "All" sequence map. Returns the definition names
 * that were re-pulled. Falls back to a no-op if the map is unreadable (keeps
 * the cached copy — never blanks the terminal).
 */
export async function incrementalSync(cfg: SyncConfig, onProgress?: SyncProgress): Promise<string[]> {
  let serverSeq: Record<string, number> = {};
  try {
    const xml = buildDefinitionRequest({
      definitionType: "All", isisVer: cfg.isisVer, storeId: cfg.storeId, securityToken: cfg.token, currentRevisionSeq: 0,
    });
    const parsed = parseXmlResponse(await postXml(apiServerAddress(cfg.enterpriseServerUrl), xml));
    // The All response lists per-table sequences. Defensive: each row carries a
    // table/name field and a sequence field.
    for (const row of asList(findKey(parsed, "Definition") ?? findKey(parsed, "All"))) {
      const table = textOf(findKey(row, "TABLE_NAME") ?? findKey(row, "Table_Name") ?? findKey(row, "Definition_Type"));
      const s = Number(textOf(findKey(row, "Revision_Seq") ?? findKey(row, "change_sequence")) || 0);
      if (table) serverSeq[table] = s;
    }
  } catch {
    return []; // offline / unreadable — keep cache
  }

  const local = loadSeqMap();
  const changed: string[] = [];
  for (let i = 0; i < DEFINITIONS.length; i++) {
    const def = DEFINITIONS[i];
    const svr = serverSeq[def.table];
    if (svr === undefined) continue;
    if (svr > (local[def.table] ?? 0)) {
      const rows = await pullDefinition(cfg, def.name);
      saveJSON(rowsKey(def.table), rows);
      local[def.table] = maxSeq(rows);
      changed.push(def.name);
      onProgress?.(def.name, i, DEFINITIONS.length, rows.length);
    }
  }
  saveJSON(SEQ_KEY, local);
  return changed;
}
