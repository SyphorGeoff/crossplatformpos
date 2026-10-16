# Messaging arc — technical proposal

Status: proposal for Geoff, 2026-10-16. Nothing built yet.
Companion: `MESSAGING_API.md` (the API as it exists today, with file:line cites).

Hard rules
- **ZERO iOS changes.** Every API change is additive and defaults to today's behaviour when the new element is absent. Existing replies keep their element names and order; new elements are appended.
- Server = HBroker (`ISISPOS/src/HBroker/HBroker_1.1`). The back office is not touched.
- **No SQL schema changes.** Messages are not in the database (as designed) and stay that way. The only DB touch is the `AuditTrail` insert, which gets escaped.
- Clients = crossplatformpos and crossplatformkds. iOS keeps working unchanged against the extended server.

---

## 1. Feature list

| # | Feature | Side | Server change? |
|---|---|---|---|
| F1 | Receive on the POS: poll, badge, list, detail, mark read, "Check For Messages On Sign In" | POS | no |
| F2 | Send from the POS: internal (employee or job), email, SMS | POS | no |
| F3 | Out-of-stock alert shown on the POS (bug R43) | POS | no (falls out of F1) |
| F4 | KDS → POS bulletin board (store broadcast on the login keypad, expires) | KDS + POS + server | **yes**: broadcast message, broadcast fetch, clear |
| F5 | Kitchen note from a sent line → paper chit + KDS ticket | POS + KDS | no HBroker change; a new document on the pqserver order channel |
| F6 | Expire unread messages after 48 h (W7) | server | yes |
| F7 | Token check on `Post_Message` / `Mark_Messages_Read` (W2) | server | yes |
| F8 | Correct send replies: Message_IDs returned, SMS/email failure reported (W3) | server (+ clients read it) | yes |
| F9 | Unique Message_IDs (W4) and `Events_ID` accepted (W5) | server | yes |

F1–F3 need nothing from the server and can start now. F6–F9 and the server half of F4 are one HBroker change set. F5 is kitchen-channel work (pqserver JSON), separate from HBroker.

---

## 2. Server changes (HBroker)

All in `com/isispos/core/` unless stated. Line numbers = today's code (see MESSAGING_API.md).

### 2.1 `Message.java` — new fields, backward-compatible XML

Add fields with getters/setters (the class is serialized to disk/S3 — keep `serialVersionUID` stable and give the new fields defaults so old persisted stores deserialize):
- `long receivedAtMillis` — server clock when stored (default 0 = unknown → treated as "now" on first janitor pass).
- `long expiresAtMillis` — 0 = none (then the 48 h rule applies).
- `boolean broadcast` — default false.
- `String terminalPosId` — sender terminal for broadcasts (optional, display only).

XML: **append** to both `getXML()` variants, after `Email_Address`:
`<Received_On>yyyy-MM-dd HH:mm:ss</Received_On><Expires_On>…</Expires_On><Broadcast>0|1</Broadcast>`.
iOS reads child elements by name and ignores unknown ones (parseResponseXML, DefinitionManager.m:3047+), so appending is safe. Do not rename `ISIS_Version` in the filtered variant (iOS doesn't read it, but leave it).

Escape element text on the way out (`&`, `<`, `>`) in `getXML` — today a `<` in a body breaks the reply (MESSAGING_API §1). The servlet's global `&`→`&amp;` must then be skipped for already-escaped text: simplest is to escape only `<` and `>` in `getXML` and leave `&` to the servlet, which is what happens today for `&`.

### 2.2 `Transactional_Request.messageposter(Document)` — `Post_Message`

- **F9 unique IDs** (`:1358-1363`): replace `new Random(System.currentTimeMillis())` with a single static `java.security.SecureRandom` or `ThreadLocalRandom`, i.e. seed once (Geoff: "fix by nanosecond and leave it" → `new Random(System.nanoTime())` per message is acceptable; a shared generator is simpler and strictly better). Keep `Math.abs(nextInt())` so the ID stays a positive int string like today.
- **F9 Events_ID**: `eventID = getNamedNodeValue(doc, "Event_ID"); if (eventID == null) eventID = getNamedNodeValue(doc, "Events_ID");` (`:1297`).
- **F4 broadcast**: read `<Broadcast>` (booleangetter) and `<Expires_On>` (optional, `yyyy-MM-dd HH:mm`). When `Broadcast` is true: store ONE message with `To_Employee_POS_ID="*"`, `broadcast=true`, `expiresAt = Expires_On` or now + 10 min; skip the per-recipient loop; SMS/email/APN flags are ignored for broadcasts. `From_Employee_POS_ID` may be empty for a KDS (store it as given; the POS shows "Kitchen" when it is empty or not an employee).
- **F6 received stamp**: set `receivedAtMillis = System.currentTimeMillis()` on every stored message.
- **F8 reply**: collect the generated IDs and the SMS/email outcome, and reply
  `<Message_Status Status_Code="100"><ISIS_Ver>1.0</ISIS_Ver><Status_Text>Message posting successful</Status_Text><Message_IDs>id1,id2</Message_IDs><SMS_Result>Success|{twilio text}</SMS_Result><Email_Result>Queued|Skipped</Email_Result></Message_Status>`.
  Status_Code stays 100 (fire and forget). iOS only substring-searches `Invalid Token` in this reply, so extra elements are safe. Twilio's text comes from `TwilioAireus.sendMessageToPhoneNumber`, which `TransactionStore.smsPhone/smsEmployee` must now return instead of discarding (`TransactionStore.java:589-603, 550-587`). Email is sent on a background thread (`Mail.java:151-164`); "Queued" is the honest word.
- **Email once** (`:1461-1602`): move the email block out of the recipient loop (send once; CC appended once). No caller sends email with several recipients today, so iOS sees no difference.
- **AuditTrail escape** (`saveToAuditTrail`, `:13611`): use a `PreparedStatement` with `?` parameters instead of `String.format`. No schema change.
- **F7 token check** (`:1271-1277`): replace the commented block with the same rule the `Messages` fetch uses (`:9253-9265`): accept the store's terminal token OR a store-"0" back-office token; otherwise 400 "Invalid Token". **Precondition:** identify the back-office caller that posts without a token (grep the backoffice webapp for `Post_Message`) and confirm it can send its back-office token; if it cannot, gate the check behind an `HBroker.properties` flag `messaging.requireToken=true` so it can be switched on per server. iOS always sends its terminal token, so it is unaffected.

### 2.3 `Transactional_Request.getTransXML` `case MESSAGE` (`:9893-9941`) — fetch

- **F4 broadcast fetch**: new `type` value `Broadcast`: returns `<Messages>` of the store's messages with `broadcast=true` and not expired, regardless of `Emp_POS_ID`. Token validated as today (the KDS token or a POS terminal token both validate for the store).
- **F4 clear**: new `type` value `ClearBroadcast` with `Source={Message_ID}`: marks that broadcast read (so the janitor drops it). Reply 100 "Broadcast cleared".
- **Default employee fetch**: unchanged, except it must ALSO return unexpired broadcasts? **No** — keep it exactly as today so iOS lists are unaffected; broadcasts are a separate fetch for the keypad only.
- `getTOMESSXML` (`TransactionStore.java:1202-1223`) and `Message.getXML(empid, allEmps)` (`Message.java:127`): add `&& !expired(now)` to the unread filter so an expired-but-unread message never ships (F6).

### 2.4 `Transactional_Request.markmessageread` (`:1670-1701`)

- **F7**: same token rule as 2.2.
- Accept several IDs: iterate `getNamedNodeValueVector(doc, "Message_ID")` and mark each; reply 100 with `<Marked>n</Marked>` appended. iOS sends one ID per request and ignores the body → unchanged for it.

### 2.5 `TransactionStoreJanitorDaemon` (`:62-96`) — F6

In the hourly pass, drop a message when `isRead`, OR `expiresAt != 0 && now > expiresAt`, OR `receivedAt != 0 && now - receivedAt > 48 h`. Messages with `receivedAt == 0` (persisted before this change) get `receivedAt = now` on first sight. Make the 48 h a property `messaging.unreadTtlHours` (default 48).

**Amazon-mode caveat** (MESSAGING_API §3.1 note): in S3 mode reads load a fresh copy and flag changes are not written back, so `isRead`, `LocalNotified` and the new expiry would not persist there either. The production servers run memory mode (`HBroker.properties` overrides `store`); this proposal does not fix S3 mode and says so.

### 2.6 DTDs (documentation only; validation is off)

- `Transactions/Post_Messages/Post_Message.dtd`: add `Subject?, Check_ID?, BusinessDate_ID?, Events_ID?, Broadcast?, Expires_On?` to the content model (today Subject/Check_ID/BusinessDate_ID are read but not declared).
- `Transactions/Response_Messages/Messages.dtd`: add `From_Employee_Name?, LocalNotified?, Received_On?, Expires_On?, Broadcast?`; note `ISIS_Version` in the filtered form.
- `Transactions/Response_Messages/Message_Status.dtd`: allow `Message_IDs?, SMS_Result?, Email_Result?, Marked?`.
- `Transactional_Request.dtd`: document `type` values `LocalNotified | Broadcast | ClearBroadcast` and `Source`.
- Samples under `supporting/xml-samples/`: add `Post_Message_Broadcast.xml`, `Messages_Broadcast_TransRequest.xml`.

### 2.7 JSPs

- `supporting/clearMessage.jsp`: require a token (same validateToken) or remove it. Out of the arc's scope but flagged.
- No new JSPs; HBroker handlers cover everything.

### 2.8 SQL

- None. (`AuditTrail` insert becomes a prepared statement; same table, same columns.)

---

## 3. Client changes — crossplatformpos

### 3.1 Protocol (`src/protocol/messaging.ts`)
- `fetchMessages(cfg, empPosId)` → `Transactional_Request Trans_Type="Messages"` + `Emp_POS_ID`; parse `<Messages><Message>` into `{ id, from, fromName?, subject, body, sentOn, localNotified, eventId?, checkId? }`. Tolerate both `ISIS_Version`/`ISIS_Ver`. Empty `<Messages></Messages>` = []. 400 Invalid Token → the normal token path.
- `markRead(cfg, ids[])` → `Mark_Messages_Read` with one `Message_ID` per request (keep iOS shape until F7's multi-ID lands, then batch).
- `setLocalNotified(cfg, empPosId, id)` → `type=LocalNotified` + `Source`.
- `sendMessage(cfg, { from, to?: string[], jobIds?, email?, phone?, subject, body })` → one `Post_Message` per recipient, building exactly the iOS element order (§2.5 of the API doc). Job → employees via `Employee_Job` from the catalog, de-duplicated (fix the iOS double-send).
- `fetchBroadcasts(cfg)` / `clearBroadcast(cfg, id)` → `type=Broadcast` / `type=ClearBroadcast` (F4; no-op until the server ships).
- Read `Message_IDs` / `SMS_Result` from the send reply when present (F8).

### 3.2 State (`src/state/useMessages.ts`, new)
- Poll every **5 s** while an employee is signed in (iOS `startMessageTimer`), stop on the keypad. One in-flight request at a time; a failed poll keeps the last list.
- `messages` replaced per poll; `unread = messages.length` (server-side unread).
- New-message detection: any id not seen before with `localNotified="0"` → show an in-app toast (there is no OS notification on web/Android WebView) titled with the sender's name, body "Subject: Body", then `setLocalNotified`. **This is R43**: the out-of-stock notice pops on every clocked-in terminal.

### 3.3 UI
- Top bar: a "Messages" pill with the unread count badge (TopBar), and the same badge on the Manager's Menu header.
- `MessagesView`: list (Subject / From / Sent), sortable like iOS; "Mark All Read"; "Send".
- `MessageDetail`: subject, body, sender; "Done" marks read.
- `SendMessage`: Internal / Email / Text tabs. Internal: pick one employee, or (jobs with `mgrMenu`) one or more jobs. Email: address. Text: phone pad (reuse NumberPad). Send → `sendMessage`.
- Sign-in: after the clock-in gate lands, if the current job has `Job.check_for_messages_on_signin` (`see` catalog `jobs()` — add `checkForMessagesOnSignIn: s(r,"check_for_messages_on_signin") === "1"`) and the first poll returns ≥1 message, open `MessagesView` once (iOS `isMessage`).
- Keypad (F4): poll `fetchBroadcasts` every 10 s while on the keypad; render a bulletin strip beside the keypad listing unexpired broadcasts (sender "Kitchen" or the employee name, time, text); a "Clear" per item calls `clearBroadcast`. Expired items vanish on the next poll.

### 3.4 Catalog
- `Job.checkForMessagesOnSignIn` (column `check_for_messages_on_signin`).
- `Employee_Job` already parsed (`employeeJobs()`), used for job sends.

### 3.5 Tests
- Wire builders byte-for-byte against the iOS strings (MessagingManager.m:95-100, 180-186, 201-258, 378-383).
- Parser: filtered reply (`ISIS_Version`, `From_Employee_Name` optional), all-messages reply, empty reply, unescaped `&`.
- Poll state: replace-on-fetch, toast once per id, mark-read does not touch the local list.

---

## 4. Client changes — crossplatformkds

### 4.1 Bulletin board sender (F4)
- Utilities (or the Dashboard hub): "Message the floor" → a short text pad with a few preset pills ("Kitchen backed up 10 min", "86 {item}", free text) → `Post_Message` with `Broadcast=1`, `Expires_On = now + 10 min`, `From_Employee_POS_ID` empty, using the KDS token. Shows "Sent to all terminals" with the returned Message_ID.
- Manager gate: not required (Geoff: kitchen staff broadcast); add one if abuse appears.

### 4.2 Kitchen note receiver (F5) — pqserver order channel, not HBroker
- POS → `/remoteorder/` JSON document `{ "type": "note", "checkkey", "lineitemkey"?, "note": "Delay 10 min", "from": "…", "time" }` addressed to the same KDS/printer targets that printed the item (the POS already knows them from the order routing).
- KDS: `intake.ts` recognises `type:"note"`, attaches it to the matching ticket (by checkkey, and to the line by lineitemkey when given), renders a highlighted note row under the line; sound once.
- Paper printers: a note chit "*** NOTE: {text} ***" for check N, same chit path as a fire chit (`printjobs.ts buildFireChit` pattern).
- POS side: 1-second press on a SENT line → pills (Delay / Rush / Remake / Allergy / free text — list to confirm with Paul) → send the note document to every target the line printed to, print the note chit to paper targets.

---

## 5. Compatibility checklist (iOS must not notice)

| Change | iOS effect |
|---|---|
| Extra elements appended to `<Message>` | ignored (parsed by name) |
| Extra elements in `Message_Status` | ignored (substring check for Invalid Token only) |
| `Events_ID` accepted | iOS event emails start attaching the event (improvement, no client change) |
| Email sent once instead of per recipient | iOS never sends email with recipients → identical |
| Unique IDs | identical shape (positive int string) |
| Token check on Post_Message / Mark_Messages_Read | iOS always sends its token → passes. Back office caller must be verified first (property flag as the safety) |
| 48 h expiry | iOS lists simply stop showing >48 h-old unread items |
| Broadcast fetch / clear | new `type` values only; default fetch unchanged |

---

## 6. Order of work

1. POS F1 + F3 + F2 against the live server (no server change) — closes R43.
2. HBroker change set: F6, F7 (with the property flag), F8, F9, F4 server half, DTD/sample updates. One deploy to enox.
3. POS keypad bulletin + KDS sender (F4).
4. Kitchen note F5: POS pills + pqserver note document + KDS rendering + paper chit.

Test rows to add to MASTER_TEST_LIST: M01 poll/badge, M02 list/detail/mark read, M03 Mark All Read, M04 send internal (employee), M05 send to job (no duplicates), M06 send email, M07 send SMS, M08 check-for-messages-on-sign-in, M09 out-of-stock alert pops (R43), M10 broadcast appears on every keypad within 10 s and clears / expires, M11 unread expires after 48 h (server), M12 kitchen note on the KDS ticket and paper chit.
