/*
 * Messages — the inbox (MessagesViewController), detail (MessageDetailViewController)
 * and compose (SendMessageViewController) screens, ported from iOS.
 *  - list: Subject / From / Sent, sortable; Mark All Read; Send
 *  - detail: subject, body, sender; Done = Mark_Messages_Read (viewing alone does not)
 *  - compose: Internal (one employee, or — manager-menu jobs only — one or more jobs,
 *    one Post_Message per employee, de-duplicated), Email, Text
 */

import { useMemo, useState } from "react";
import type { InboxMessage } from "@/protocol/messaging";

export interface Recipient { id: string; name: string; }
export interface JobPick { id: string; name: string; }
export interface ComposeTarget { toEmpIds: string[]; email?: string; phone?: string; subject: string; body: string; }

export interface MessagesViewProps {
  messages: InboxMessage[];
  loading: boolean;
  error?: string;
  empName: (id: string) => string;
  employees: Recipient[];
  jobs: JobPick[];                 // empty = no job sends (not a manager-menu job)
  employeesInJob: (jobId: string) => string[];
  onBack: () => void;
  onRefresh: () => void;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onSend: (t: ComposeTarget) => Promise<string>; // resolves to a status line
}

type Sort = "sent" | "subject" | "from";
type Channel = "internal" | "email" | "text";

/** "Last,First" from the server, else the catalog name, else the id. */
function senderName(m: InboxMessage, empName: (id: string) => string): string {
  if (m.fromName) { const [l, f] = m.fromName.split(","); return `${(f ?? "").trim()} ${(l ?? "").trim()}`.trim(); }
  return empName(m.fromEmpId) || m.fromEmpId || "—";
}

export default function MessagesView(p: MessagesViewProps) {
  const [sort, setSort] = useState<Sort>("sent");
  const [open, setOpen] = useState<InboxMessage | null>(null);
  const [compose, setCompose] = useState(false);

  const rows = useMemo(() => {
    const r = [...p.messages];
    if (sort === "sent") r.sort((a, b) => (b.sentOn || "").localeCompare(a.sentOn || ""));
    else if (sort === "subject") r.sort((a, b) => a.subject.localeCompare(b.subject));
    else r.sort((a, b) => senderName(a, p.empName).localeCompare(senderName(b, p.empName)));
    return r;
  }, [p.messages, sort, p.empName]);

  return (
    <div className="tabsview msgview">
      <div className="tabshead">
        <h1>Messages</h1>
        <div className="tabstools">
          <button className="tbbtn" onClick={p.onBack}>‹ Back</button>
          <button className={`tbbtn ${sort === "sent" ? "on" : ""}`} onClick={() => setSort("sent")}>Sent</button>
          <button className={`tbbtn ${sort === "subject" ? "on" : ""}`} onClick={() => setSort("subject")}>Subject</button>
          <button className={`tbbtn ${sort === "from" ? "on" : ""}`} onClick={() => setSort("from")}>From</button>
          <button className="tbbtn" onClick={p.onRefresh} disabled={p.loading}>{p.loading ? "…" : "Refresh"}</button>
          <button className="tbbtn" onClick={p.onMarkAllRead} disabled={p.messages.length === 0}>Mark All Read</button>
          <button className="tbpill" onClick={() => setCompose(true)}>Send</button>
        </div>
      </div>
      {p.error && <div className="tabsstatus">{p.error}</div>}

      <div className="msglist">
        {rows.map((m) => (
          <button key={m.id} className="msgrow" onClick={() => setOpen(m)}>
            <span className="msgsubj">{m.subject || "(no subject)"}</span>
            <span className="msgfrom">{senderName(m, p.empName)}</span>
            <span className="msgwhen">{m.sentOn}</span>
            <span className="msgpeek">{m.body}</span>
          </button>
        ))}
        {rows.length === 0 && !p.loading && <div className="empty">No messages.</div>}
      </div>

      {open && (
        <div className="backdrop" onClick={() => setOpen(null)}>
          <div className="authbox msgdetail" onClick={(e) => e.stopPropagation()}>
            <div className="authtitle">{open.subject || "(no subject)"}</div>
            <div className="authsub">{senderName(open, p.empName)} · {open.sentOn}</div>
            <div className="msgbody">{open.body}</div>
            <div className="mfactions">
              <button className="mfbtn ghost" onClick={() => setOpen(null)}>Close</button>
              <button className="mfbtn go" onClick={() => { p.onMarkRead(open.id); setOpen(null); }}>Done</button>
            </div>
          </div>
        </div>
      )}

      {compose && <Compose p={p} onClose={() => setCompose(false)} />}
    </div>
  );
}

function Compose({ p, onClose }: { p: MessagesViewProps; onClose: () => void }) {
  const [channel, setChannel] = useState<Channel>("internal");
  const [toEmp, setToEmp] = useState<string>("");
  const [jobIds, setJobIds] = useState<Set<string>>(new Set());
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const recipients = (): string[] => {
    const ids = new Set<string>();
    if (toEmp) ids.add(toEmp);
    for (const j of jobIds) for (const e of p.employeesInJob(j)) ids.add(e);
    return [...ids];
  };
  const canSend = body.trim().length > 0 && (
    (channel === "internal" && recipients().length > 0) ||
    (channel === "email" && /\S+@\S+/.test(email)) ||
    (channel === "text" && phone.replace(/\D/g, "").length >= 10));

  const send = async () => {
    setBusy(true);
    const t: ComposeTarget = { toEmpIds: channel === "internal" ? recipients() : [], subject: subject.trim(), body: body.trim() };
    if (channel === "email") t.email = email.trim();
    if (channel === "text") t.phone = phone.replace(/\D/g, "");
    const line = await p.onSend(t);
    setBusy(false); setStatus(line);
    if (!/fail|error|unreachable/i.test(line)) onClose();
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="authbox msgcompose" onClick={(e) => e.stopPropagation()}>
        <div className="authtitle">Send a message</div>
        <div className="msgtabs">
          {(["internal", "email", "text"] as Channel[]).map((c) => (
            <button key={c} className={`tbbtn ${channel === c ? "on" : ""}`} onClick={() => setChannel(c)}>{c === "internal" ? "Internal" : c === "email" ? "Email" : "Text"}</button>
          ))}
        </div>

        {channel === "internal" && (
          <div className="msgto">
            <label className="msglbl">To (one person)</label>
            <select value={toEmp} onChange={(e) => setToEmp(e.target.value)}>
              <option value="">— nobody —</option>
              {p.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            {p.jobs.length > 0 && (
              <>
                <label className="msglbl">Or every clocked-in employee in</label>
                <div className="msgjobs">
                  {p.jobs.map((j) => (
                    <button key={j.id} className={`tbbtn ${jobIds.has(j.id) ? "on" : ""}`}
                      onClick={() => setJobIds((s) => { const n = new Set(s); if (n.has(j.id)) n.delete(j.id); else n.add(j.id); return n; })}>{j.name}</button>
                  ))}
                </div>
              </>
            )}
            <div className="msghint">{recipients().length} recipient{recipients().length === 1 ? "" : "s"}</div>
          </div>
        )}
        {channel === "email" && (
          <div className="msgto"><label className="msglbl">Email address</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></div>
        )}
        {channel === "text" && (
          <div className="msgto"><label className="msglbl">Phone number</label><input type="tel" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 555-1234" /></div>
        )}

        <label className="msglbl">Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
        <label className="msglbl">Message</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Type the message" />
        {status && <div className="msghint">{status}</div>}
        <div className="mfactions">
          <button className="mfbtn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="mfbtn go" onClick={() => void send()} disabled={!canSend || busy}>{busy ? "Sending…" : "Send"}</button>
        </div>
      </div>
    </div>
  );
}
