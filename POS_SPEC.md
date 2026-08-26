# Aireus POS EDGE — wire contract & port spec

Ground truth: `/Users/geoffreymarshall/Documents/ISIS/aireus_posclient_sql_nocoredata`
(the shipped Objective-C ISIS POS client, target **ISIS**). Every outbound
request this app makes has a matching line there, cited file:line, and is
live-verified against enox before being marked resolved. Doctrine, sources, and
the fabricated-artifact warnings are the same as the KDS project
(`../WEBKDS_PORT_GUIDE.md`); `Sr_Simulator version 10.0` is feature/design
inspiration only, never protocol truth.

**Architecture:** one React/TS codebase → web + Android + iOS (Capacitor),
platform seams (`http`, `storage`, `device` reused from the KDS). Definitions
are plain typed record arrays in memory + storage cache — **no Core Data, no
ORM** (the iPad's Core Data was stripped years ago; what remained is object
instantiation that is morally arrays-of-dictionaries). Offline = serialize
open checks to storage and flush on reconnect (the KDS command-queue pattern),
NOT a local database.

**Scope rules (Geoff):** credit-card processing deferred (new modern
interfaces come later); room-charge/PMS kept; gift-card & loyalty limited to the
native Aireus in-house (HBroker) versions — third-party gateways (Givex,
DataCandy, Paytronix, RepeatRewards…) left out. API extensions come only from
the ranked feature triage, designed deliberately (Jerry owns the phase-one XML
API expansion server-side).

---

## Chapter 1 — Activation & definitions sync  *(this slice)*

### 1.1 HBroker transport
XML `POST` to `{enterprise_server_url}/ISISPOS/HBroker`, `Content-type: text/xml`
(getAPIServerAddress, TerminalConfigManager.m:810; app-path const :90/:117).
`enterprise_server_url` derives from the enterprise code by Aireus convention
(`ENOX` → `https://enox.aireus.com`), matching the KDS.

### 1.2 Tokens (TerminalConfigManager.m)
| Step | Message | Fields | Source |
|---|---|---|---|
| Enrol | `Token_Request Token_Type="New_Terminal"` | ISIS_Ver, Terminal_UID (persistent 10-digit GUID), Enterprise_Code (=enterprise id), Enterprise_Login, Enterprise_Password | :886 |
| Session | `Token_Request Token_Type="Standard"` | ISIS_Ver, Store_ID, Terminal_POS_ID, Terminal_UID, empty Emp_POS_ID/Pin/Login/Password, Enterprise_Code | :916 |

Token read from `<Security_Token_Value>`; `<error>`/`<Status_Text>` = refusal.
(Note: POS uses **New_Terminal**, where the KDS used New_KDS.)

Between enrol and session comes store-list → terminal-list → **Terminal_Assignment**
(next slice — same pattern as the KDS activation, different message set).

### 1.3 Definitions sync (DefinitionManager.m)
- **Catalog:** 51 definition types in client order (DefinitionManager.m:163-640),
  captured verbatim in `src/model/definitions.ts` (name → table).
- **Request** (makeDefXML, :2640): `Definition_Request Override_Revision_Seq="0"
  Definition_Type="X"` with ISIS_Ver, Store_ID, Current_Revision_Seq, optional
  change_sequence, Security_Token. Three shapes: full (Current_Revision_Seq=0),
  incremental+change_seq, incremental.
- **First load** (`firstLoad`, syncDataSynchNoThread :1043/:1082): pull all 51
  fully; record each table's max Revision_Seq.
- **Incremental** (getAllSeq :1773, `Definition_Type="All"`): fetch the per-table
  sequence map, compare to stored, re-pull only tables whose server seq is
  higher. Language/Localization special-cased; Tender/Adjustment changes flag a
  tender refresh (:1123-1140).
- **Offline** (:1790): `COMMFAIL` falls back to the cached copy (the `.def`-file
  cache; here, storage-backed `def.<table>.v1` + `defseq.v1`).

Implemented: `src/protocol/hbroker.ts`, `src/protocol/activation.ts`,
`src/protocol/defsync.ts`, `src/model/definitions.ts`. Tests: `tests/hbroker.test.ts`.

### 1.4 Live verification — VERIFIED end-to-end against enox (2026-08-26)
Full chain drove live: sign-in → store (Aireus Cafe·3) → POS terminal list
(Is_Licensed=="1") → assignment → Standard token → all 51 definitions synced
(36 tables, ~2006 rows: Menu_Item 159, Chain 52, DiningTable 49, Employee 12,
Employee_Job 30, +1413 images). Resolved:
1. Token element is `<Security_Token_Value>` for New_Terminal & Standard. ✓
2. Definition row parsing (array-valued child under the type wrapper) works on
   every real response. ✓
3. `Definition_Type` full-pull rows carry Revision_Seq; the "All" incremental
   map path is coded but not yet exercised live (no def changed mid-session) —
   the one remaining item to confirm on a real edit.
4. Terminal_Assignment success is `Message_Status Status_Code="100"`
   ("Terminal Authorized. Please Wait") — NOT an error. Interpret by numeric
   Status_Code (>=400 = failure); an <error> element is failure.

---

## Later chapters (planned, per milestone)
M1 store/terminal pick + assignment + menu browse · M2 order entry + send to
kitchen (closes the loop with the shipped KDS) · M3 payments (cash + room
charge + native Aireus gift/loyalty; CC seam stubbed) · M4 table service /
splits / transfers / floorplan · M5 manager functions / timeclock / cash mgmt.
Each ends with an enox side-by-side against the iPad. M1–M2 run entirely on the
existing XML API — no dependency on the server rewrite.
