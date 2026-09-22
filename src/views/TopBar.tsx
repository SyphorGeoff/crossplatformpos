/*
 * Top action strip (Paul's counter layout): navigation + check tools on the
 * left, the fire/settle actions as dark pills on the right. Presentation only —
 * every action is a callback the Menu wires to real behavior. Buttons whose
 * backing feature isn't built yet (Customer, Print) render disabled.
 */

export interface TopBarProps {
  onLogout: () => void;  // the iOS check screen's leading button (CheckViewController.m:499): park the check, back to login
  onTables: () => void;
  onTabs: () => void;
  onHub: () => void;
  onEdit: () => void;
  editing: boolean;
  onPrint?: () => void;
  onSendStay: () => void;
  onSend: () => void;
  onPay: () => void;
  canSend: boolean;      // Send & Stay — enabled when there are unsent changes to fire
  canSendExit: boolean;  // Send — enabled whenever there's a check (re-confirms + exits even with no changes)
  canPay: boolean;
  sending: boolean;
}

export default function TopBar(p: TopBarProps) {
  return (
    <header className="topbar">
      <div className="tbnav">
        <button className="tbbtn" onClick={p.onLogout} disabled={p.sending}><i>‹</i>Sign Out</button>
        <button className="tbbtn" onClick={p.onTables} disabled={p.sending}><i>▦</i>Tables</button>
        <button className="tbbtn" onClick={p.onTabs} disabled={p.sending}><i>❏</i>Tabs</button>
        <button className="tbbtn" onClick={p.onHub} disabled={p.sending}><i>◎</i>Dashboard</button>
        <button className={`tbbtn ${p.editing ? "on" : ""}`} onClick={p.onEdit} disabled={p.sending}><i>✎</i>Edit</button>
        <button className="tbbtn" disabled title="Customer — coming soon"><i>☺</i>Customer</button>
        <button className="tbbtn" onClick={p.onPrint} disabled={p.sending || !p.onPrint} title={p.onPrint ? "Print check" : "Print — add items first"}><i>⎙</i>Print</button>
      </div>
      <div className="tbfire">
        <button className="tbpill" onClick={p.onSendStay} disabled={p.sending || !p.canSend}>Send &amp; Stay</button>
        <button className="tbpill" onClick={p.onSend} disabled={p.sending || !p.canSendExit}>{p.sending ? "Sending…" : "Send"}</button>
        <button className="tbpill pay" onClick={p.onPay} disabled={p.sending || !p.canPay}>Pay</button>
      </div>
    </header>
  );
}
