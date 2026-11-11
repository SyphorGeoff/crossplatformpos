/*
 * A small red padlock: the check is locked by another terminal (Open_Checks
 * Is_Locked / Locking_Terminal_POS_ID; the iPad lists the locking terminal in
 * OpenCheckListTableCell.m:225).
 */

export default function LockIcon({ title }: { title?: string }) {
  return (
    <span className="lockico" title={title} aria-label={title ?? "Locked"}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path fill="currentColor" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-.5V4.5A3.5 3.5 0 0 0 8 1Zm-2 3.5a2 2 0 1 1 4 0V7H6V4.5Z" />
      </svg>
    </span>
  );
}
