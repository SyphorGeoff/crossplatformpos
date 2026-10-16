/*
 * Manager's Menu — where a Mgr_Menu job lands after login (LoginViewController.m:949-953:
 * isManager && !managerServerMode → managerMenuViewController). Buttons follow the
 * iOS ManagerMenuViewController order; functions this port hasn't built render
 * disabled. Sign Out (pill, top) returns to the login screen (pressCancel :616-620).
 */

export interface ManagerMenuActions {
  queryByTable?: () => void;      // table layout
  openChecks?: () => void;        // open checks list
  mergeChecks?: () => void;
  openClosedChecks?: () => void;
  backOffice?: () => void;
  transferAll?: () => void;
  clockOut?: () => void;
  teams?: () => void;
  clockedInEmployees?: () => void;
  printGroupOnOff?: () => void;
  printerTest?: () => void;
  printGroupTest?: () => void;
  openEmptyCheck?: () => void;
  drawerAssignment?: () => void;
  addTips?: () => void;
  terminalRead?: () => void;
  serverRead?: () => void;
  pulseReport?: () => void;
  reports?: () => void;
  unpostedChecks?: () => void;
  terminal?: () => void;          // station settings
  exit: () => void;
}

// Removed for good (Geoff 2026-10-16): Back Office, Teams, Print Group On/Off, Printer Test,
// Print Group Test, Drawer Assignment, Add Tips, Terminal Read, Server Read, Pulse Report,
// Reports, Unposted Checks, Terminal. The iPad's grid had them; the cross-platform POS does not.
const ORDER: { key: keyof ManagerMenuActions; label: string }[] = [
  { key: "queryByTable", label: "Query By Table" },
  { key: "openChecks", label: "Open Checks" },
  { key: "mergeChecks", label: "Merge Checks" },
  { key: "openClosedChecks", label: "Open Closed Checks" },
  { key: "transferAll", label: "Transfer All" },
  { key: "clockOut", label: "Clock Out" },
  { key: "clockedInEmployees", label: "Clocked In Employees" },
  { key: "openEmptyCheck", label: "Open Empty Check" },
];

export default function ManagerMenu({ storeName, employeeName, jobName, status, busy, actions }: {
  storeName: string; employeeName: string; jobName: string; status?: string; busy?: boolean; actions: ManagerMenuActions;
}) {
  return (
    <div className="editcheck mgrmenu">
      {/* Sign Out as a pill up top, like every other screen (Geoff 2026-10-16); no Exit tile */}
      <div className="mgrtop"><button className="tbbtn" onClick={actions.exit} disabled={busy}><i>‹</i>Sign Out</button></div>
      <div className="echead">
        <div className="eckicker">{storeName.toUpperCase()} · MANAGER</div>
        <h1>Manager's Menu</h1>
        <div className="ecmeta">{employeeName} · {jobName}{status ? <><br /><span>{status}</span></> : null}</div>
      </div>
      <div className="ecgrid">
        {ORDER.map(({ key, label }) => {
          const fn = actions[key];
          return (
            <button key={key} className="ecfn" onClick={fn} disabled={!fn || busy} title={fn ? label : `${label} — not built yet`}>
              <span className="ecfnlabel">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
