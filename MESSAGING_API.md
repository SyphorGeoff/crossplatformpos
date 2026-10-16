# Aireus POS Messaging API — as built (iOS client + HBroker server)

Status: documentation of what exists today, written 2026-10-16 from the code.
Ground truth: the iOS client (`aireus_posclient_sql_nocoredata/Classes`) and the
HBroker server (`ISISPOS/src/HBroker/HBroker_1.1`). Line numbers refer to those
trees. Nothing here is proposed; the proposals for the messaging arc are at the end.

---

## 1. Transport and envelope

- Endpoint: `POST {enterprise server}/ISISPOS/HBroker`, `Content-type: text/xml`
  (`web.xml:116-119` → `com.isispos.core.HBroker`).
- The DOCTYPE **root name** selects the handler (`MessageParser.java:120`, routing
  table `:677-687`). A request with no DOCTYPE is rejected 500 "Invalid Message
  Type" (`:97-100, 704-729`). DTD validation is OFF (`:116`), so the DTDs are
  documentation only.
- Status replies use one envelope, no XML declaration (`FunctionLib.java:506-520`):
  `<Message_Status Status_Code="N"><ISIS_Ver>1.0</ISIS_Ver><Status_Text>…</Status_Text></Message_Status>`
  Codes (`Message_Status.dtd`): 100 success · 200 timeout · 300 deferred/maintenance ·
  400 security failure · 500 invalid XML / handler error.
- The servlet replaces every `&` in a reply with `&amp;` (`HBroker.java:781`); nothing
  else is escaped. A `<` in a message body produces broken XML on the way back.
- Add `replyWithJSON="1"` anywhere in the body to get the reply as JSON (`HBroker.java:759-796`).
- iOS escapes `&` and `'` in the request (`DefinitionManager.m:2745-2758`), never `<`.
- Timestamps (`Sent_On`) are client-generated, `yyyy-MM-dd HH:mm` local time
  (`AITransactionManager.m:2537-2548`). The server never stamps a message.

**Storage: messages are NOT in the database.** They live in the store's in-memory
transaction store (`TransactionStore.Store.Messages`, `TransactionStore.java:3069`),
flushed to disk every minute and reloaded at startup (`PersistenceDaemon.java`,
`HBroker.java:486-498`). Read messages are purged hourly
(`TransactionStoreJanitorDaemon.java:62-96`). The only DB writes are `AuditTrail`
rows (and `Customer` rows on some email paths). The back office cannot see them.

---

## 2. `Post_Message` — send (internal, SMS, email, push)

DOCTYPE `Transactions/Post_Messages/Post_Message.dtd`, root `<Post_Message>`.
Handler: `Transactional_Request.messageposter(Document)` (`Transactional_Request.java:1256-1614`).

### 2.1 Request elements (as read by the server, `:1267-1346`)

| Element | Req | Meaning |
|---|---|---|
| `ISIS_Ver` | yes | client version string |
| `Store_ID` | yes | store |
| `Security_Token` | sent | **not checked** — the check is commented out "for backoffice messages" (`:1271-1277`) |
| `From_Employee_POS_ID` | yes | sender; shown by the client as a name |
| `To_Employee_POS_ID` | 0..n | one element per recipient; none → recipient list `["na"]` |
| `Send_Internal` | flag | store an in-app message for each recipient |
| `Send_SMS` | flag | SMS to `Phone_Number` (if ≥10 chars, once) and/or to each recipient's `Employee.Mobile` |
| `Send_Email` | flag | email to `Email_Address` (+`CC_Email_Address`), once **per recipient** (loop bug, see 2.3) |
| `Send_APN` | flag | Apple push to each recipient's `APN_Token` (not used by iOS) |
| `Phone_Number` | opt | raw SMS target |
| `Email_Address`, `CC_Email_Address` | opt | email targets (`to\|cc` also accepted) |
| `Subject` | opt | not in the DTD, read by the handler |
| `Message_Body` | opt | text; null → "" |
| `Sent_On` | opt | stored and echoed back verbatim |
| `Event_ID` | opt | **`Event_ID`** on the wire; iOS writes `Events_ID`, which the server ignores |
| `Check_ID`, `BusinessDate_ID`, `check_key`, `Check_Header` | opt | email-a-check path only |
| `ImageURL` | opt | MMS attachment for SMS |
| `Customer_ID` | — | in the DTD, never read |

Flags accept `1/0` or `true/false` (`VariableGetters.java:40-64`); missing = false.

### 2.2 Server behaviour, in order

1. `Send_SMS` + `Phone_Number` (≥10 chars): one Twilio SMS, text = `"Subject: …\n"` + body (`:1318-1340`).
2. For **each** `To_Employee_POS_ID` (`:1348-1605`):
   - `Send_Internal` → a `Message` stored with a random `Message_ID` (`abs(new Random(now).nextInt())`, `:1358-1363`), `isRead=false`, `LocalNotified=0`, plus From/To/Body/Subject/Sent_On/Event_ID/Check_ID/BusinessDate_ID/Email_Address.
   - `Send_SMS` → SMS to the recipient's `Mobile` (body only, no subject).
   - `Send_APN` → push.
   - `Send_Email` → SMTP email; subject "Aireus POS Mail", or "Check N" / "{Subject} - Check N" with the check HTML when `Check_ID` is given; " Event Announcement" appended when `Event_ID` is given.
3. Reply 100 "Message posting successful" (`:1607`). Internal, SMS, push and email failures are swallowed; only a synchronous exception gives 500 "Message posting unsuccessful".

### 2.3 Known server bugs (do not depend on these)

- `Message_ID` is seeded from the current millisecond per recipient: two recipients in the same millisecond share an ID and the second overwrites the first (`:1358-1363`). The out-of-stock helper works around it with `Thread.sleep(100)` (`:1657`).
- Email runs inside the recipient loop: one email per recipient, with CC re-appended each pass (`:1461-1602`).
- The reply never returns the generated `Message_ID`(s).
- No token check on `Post_Message` or `Mark_Messages_Read`.
- `Message_Body` goes unescaped into the `AuditTrail` INSERT (`:13611`): a `'` breaks the insert (caught, logged).
- SMS result is discarded (`TransactionStore.java:589-603`): "Success" even when Twilio failed.

### 2.4 Replies

- `<Message_Status Status_Code="100">…<Status_Text>Message posting successful</Status_Text>…`
- 500 "Message posting unsuccessful"; 500 "Unable to set check lock" (no root element; copy-paste text); 500 "Invalid Message Type"; 300 "Server maintenance mode".

### 2.5 How iOS uses it (`MessagingManager.m:201-258`, callers in §5)

iOS builds the element list in this order: `ISIS_Ver, Store_ID, Security_Token,
Send_Email[+Email_Address], Send_SMS[+Phone_Number], From_Employee_POS_ID,
[To_Employee_POS_ID + Send_Internal=1], [Events_ID], Subject, Message_Body, Sent_On`.
`Send_Internal` is only ever sent as `1` with a recipient; otherwise omitted.
The reply is ignored except for the literal `Invalid Token` retry.

---

## 3. `Transactional_Request Trans_Type="Messages"` — fetch (and LocalNotified)

DOCTYPE `Transactions/Post_Messages/Transactional_Request.dtd`.
Handler: `getTransXML` → `case MESSAGE` (`Transactional_Request.java:9893-9941`).
**This one DOES validate the token** (`:9253-9265`; 400 "Invalid Token").

### 3.1 Fetch my unread messages

Request (iOS `MessagingManager.m:95-100`):
`<Transactional_Request Trans_Type="Messages"><ISIS_Ver/><Store_ID/><Security_Token/><Emp_POS_ID/></Transactional_Request>`

Reply (`Message.java:128-164`), root `<Messages>`, one `<Message>` per **unread** message
whose `To_Employee_POS_ID` = `Emp_POS_ID` (`Message.java:127`):

```
<Messages>
  <Message>
    <ISIS_Version>1.0</ISIS_Version>   ← note: ISIS_Version here, ISIS_Ver elsewhere
    <Store_ID/><Message_ID/><Message_Body/><To_Employee_POS_ID/><From_Employee_POS_ID/>
    [<From_Employee_Name>Last,First</From_Employee_Name>]   ← only if the sender is a known employee
    <isRead>false</isRead><LocalNotified>0|1</LocalNotified>
    <Sent_On/><Subject/><Event_ID/><Check_ID/><BusinessDate_ID/><Email_Address/>
  </Message>…
</Messages>
```
Empty result = `<Messages></Messages>` (no status envelope). No business-date filter
despite the DTD comment. Values are unescaped (see §1).

Without `Emp_POS_ID` the server returns **every** message in the store, read or not,
in a different element order (`Message.java:99-114`).

### 3.2 Mark "LocalNotified"

Same document plus `<type>LocalNotified</type><Source>{Message_ID}</Source>`
(iOS `MessagingManager.m:180-186`). Server sets `LocalNotified=1` on that message
(`:9897-9916`) and always replies 100 "Message marked local notified".
iOS uses `LocalNotified=0` only to decide whether to show a local notification.

---

## 4. `Mark_Messages_Read` — mark read (the only lifecycle call; there is no delete)

DOCTYPE `Transactions/Post_Messages/Mark_Messages_Read.dtd`, root `<Mark_Messages_Read>`.
Request (iOS `MessagingManager.m:378-383`): `<ISIS_Ver/><Store_ID/><Security_Token/><Message_ID/>` — **one ID per request**; the handler processes only the first `Message_ID` it finds (`Transactional_Request.java:1670-1701`). Token not checked.
Replies: 100 "Message mark read operation successful" · 500 "Invalid message ID" · 500 "Message not found" · 500 "Unable to parse post".
A read message disappears from the next fetch and is purged within the hour.

---

## 5. iOS client behaviour (what a parity port must do)

**Receive**
- Poll `Messages` every **5 s** from sign-in until the login screen reappears (`startMessageTimer`, `MessagingManager.m:590-601`; started in LoginViewController.m:1058 and the job/team/room selection screens; stopped at LoginViewController.m:256). The menu, section, manager-menu and messages screens also fetch on appear.
- The fetched list **replaces** the local list every time (`:117`); badge = `messages.count` (SectionViewController.m:968-972 etc.). "Unread" is server-side: a message stops arriving once marked read.
- For each message with `LocalNotified=0`: iOS local notification titled with the sender's name, body `"Subject:Body"`, then the LocalNotified call (`:120-159`).
- **Check For Messages On Sign In** is a **Job** column: `Job.check_for_messages_on_signin` (`Job.m:234-238`). When the job has it and the list is non-empty, the landing screen auto-opens the Messages list (LoginViewController.m:1065-1136; ManagerMenu/OtherMenu/Section/CheckViewController consumers).
- No local persistence; nothing survives a restart until the next poll.

**Read**
- Messages list (Subject / From / Sent_On, sortable) → detail (Subject, Body, sender name). "Done" on the detail sends `Mark_Messages_Read`; "Mark All Read" sends one per message. The local list is not touched until the next poll.

**Send** (`SendMessageViewController`): Internal / Email / Text. Internal picks one employee, or (managers only) one or more Jobs → one `Post_Message` per employee holding the job (`:415-487`; duplicates possible). Email → `Send_Email=1`. Text → `Send_SMS=1`.

**Automatic sends already mirrored in crossplatformpos**
- Check transfer: internal, Subject `CheckTransfer`, body "{Table X / Tab Y} was transferred to you!" (EmployeeListViewController.m:283-361).
- Out of stock: one internal per clocked-in employee, Subject "Menu Item out of Stock: {name}" (MenuItemCountManager.m:237-255). The server also does this itself when a counter reaches 0 on a check post (`Transactional_Request.java:6112, 1616-1668`).
- Text a check: SMS whose body is the aireuspay check URL (CheckViewController.m:33376-33433); the Security_Token rides in that URL.
- Not mirrored: empty-check assignment notice ("A new table has been assigned to you under {Tab}", EmployeeListViewController.m:229-246); manager-alert / receipt / AR emails (`sendEmailCheckMessage`, with a bug that drops subject/body on the 6-arg overload); event emails; valet email.

---

## 6. Gaps the messaging arc must close (cross-platform POS and KDS)

| # | Arc item | What exists | What is missing |
|---|---|---|---|
| 1 | Send from the POS (internal / email / SMS) | `Post_Message` works for all three; auto notices use it | The compose UI (recipient / job / email / phone), like SendMessageViewController |
| 2 | Receive on the POS + Check For Messages On Sign In | `Messages` fetch, `Mark_Messages_Read`, `Job.check_for_messages_on_signin` | Everything client-side: poll while signed in, badge, list, detail, mark read, the sign-in auto-open, the out-of-stock alert (bug R43) |
| 3 | KDS → POS bulletin board on the login screen | `Post_Message` can carry an internal message per employee; the KDS already has a KDS token (but `Messages` fetch filters by `Emp_POS_ID`, and nobody is signed in on the login screen) | A **terminal-/store-level** message the keypad can fetch with no employee, with an expiry: new element(s) on `Post_Message` (e.g. `<Broadcast>1</Broadcast>` + `<Expires_On>`) and a fetch variant for the store/terminal. See §7 |
| 4 | Kitchen note from a sent line → printers / KDS | Nothing. The KDS receives only remoteorder documents from pqserver | A note document on the KDS order path (pqserver `/remoteorder/`, same channel as orders — NOT HBroker messaging), plus a note chit on paper printers |
| 5 | KDS shows the note on its ticket | Nothing | KDS parser + ticket rendering for the note document |

Items 4–5 are kitchen-side and belong to the order channel, not to this API.

---

## 7. Proposed API additions for the arc (for agreement before building)

Minimal, additive, iOS untouched:

1. **Broadcast message** on `Post_Message`: `<Broadcast>1</Broadcast>` (store-wide; `To_Employee_POS_ID` omitted) and optional `<Expires_On>yyyy-MM-dd HH:mm</Expires_On>` (default now + 10 min). Stored like an internal message with `To_Employee_POS_ID` = `*`.
2. **Fetch broadcasts** without an employee: `Trans_Type="Messages"` with `<type>Broadcast</type>` (and no `Emp_POS_ID`) returns the store's unexpired broadcasts; the keypad polls it while idle. Marking read = `Mark_Messages_Read` per terminal is wrong for a broadcast, so a broadcast is cleared by `<type>ClearBroadcast</type><Source>{Message_ID}</Source>` (any terminal) or by expiry.
3. **Return the generated IDs** from `Post_Message`: `<Message_Status …><Message_ID>…</Message_ID>…</Message_Status>` (one per recipient). Harmless to iOS, which ignores the body.
4. **Fix** while in there: per-recipient random seed (unique IDs), email once not per recipient, escape `'` in the AuditTrail insert, re-enable the token check on `Post_Message` / `Mark_Messages_Read` for non-backoffice callers, accept several `Message_ID`s in one `Mark_Messages_Read`.
5. **Do not touch** the 5-second poll contract: the cross-platform POS will poll the same `Messages` call while signed in, and the broadcast call while on the keypad.

Security notes for the server owner, out of this arc's scope: hardcoded SMTP credentials (`Mail.java:113,141-143`), Twilio SID/token (`TwilioAireus.java:67`), DB password in `web.xml:65,85`; `supporting/clearMessage.jsp` wipes a store's messages with no authentication.
