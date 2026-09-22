/*
 * Manager's Menu — where a Mgr_Menu job lands after login (LoginViewController.m:949-953:
 * isManager && !managerServerMode → managerMenuViewController). Buttons follow the
 * iOS ManagerMenuViewController order; functions this port hasn't built render
 * disabled. Exit returns to the login screen (pressCancel :616-620).
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

const ORDER: { key: keyof ManagerMenuActions; label: string }[] = [
  { key: "queryByTable", label: "Query By Table" },
  { key: "openChecks", label: "Open Checks" },
  { key: "mergeChecks", label: "Merge Checks" },
  { key: "openClosedChecks", label: "Open Closed Checks" },
  { key: "backOffice", label: "Back Office" },
  { key: "transferAll", label: "Transfer All" },
  { key: "clockOut", label: "Clock Out" },
  { key: "teams", label: "Teams" },
  { key: "clockedInEmployees", label: "Clocked In Employees" },
  { key: "printGroupOnOff", label: "Print Group On/Off" },
  { key: "printerTest", label: "Printer Test" },
  { key: "printGroupTest", label: "Print Group Test" },
  { key: "openEmptyCheck", label: "Open Empty Check" },
  { key: "drawerAssignment", label: "Drawer Assignment" },
  { key: "addTips", label: "Add Tips" },
  { key: "terminalRead", label: "Terminal Read" },
  { key: "serverRead", label: "Server Read" },
  { key: "pulseReport", label: "Pulse Report" },
  { key: "reports", label: "Reports" },
  { key: "unpostedChecks", label: "Unposted Checks" },
  { key: "terminal", label: "Terminal" },
];

export default function ManagerMenu({ storeName, employeeName, jobName, status, busy, actions }: {
  storeName: string; employeeName: string; jobName: string; status?: string; busy?: boolean; actions: ManagerMenuActions;
}) {
  return (
    <div className="editcheck mgrmenu">
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
        <button className="ecfn exit" onClick={actions.exit} disabled={busy}><span className="ecfnlabel">Exit</span></button>
      </div>
    </div>
  );
}
