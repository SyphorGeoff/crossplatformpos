/*
 * Permissions & manager authorization (LoginManager canEmployee*: / Job flags).
 * An employee's permission for an action is the OR across all their jobs
 * (Employee_Job → Job). A restricted action the signed-in server lacks is
 * gated by a manager PIN: the entered PIN resolves to an employee, and that
 * employee must themselves hold the permission (ManagerAuthViewController).
 */

import { employeeJobs, employees, jobs, type Job } from "./catalog";

export interface Perms {
  void: boolean;          // Auth_Voids
  adjust: boolean;        // Auth_Adjustments (discounts/comps/service charges)
  reopen: boolean;        // Auth_Pullbacks
  overridePrice: boolean; // Override_Price
  removeTax: boolean;     // Auth_Tax_Exemptions
  transfer: boolean;      // Approve_Transfer
  noSale: boolean;        // allow_no_sale / No_Sale
  manager: boolean;       // Mgr_Menu (pay-in/out, force clock, release drawer, cancel…)
}
export type AuthAction = keyof Perms;

const NONE: Perms = { void: false, adjust: false, reopen: false, overridePrice: false, removeTax: false, transfer: false, noSale: false, manager: false };

function union(list: Job[]): Perms {
  return list.reduce<Perms>((p, j) => ({
    void: p.void || j.authVoids,
    adjust: p.adjust || j.authAdjustments,
    reopen: p.reopen || j.authPullbacks,
    overridePrice: p.overridePrice || j.overridePrice,
    removeTax: p.removeTax || j.authTaxExemptions,
    transfer: p.transfer || j.approveTransfer,
    noSale: p.noSale || j.noSale,
    manager: p.manager || j.mgrMenu,
  }), { ...NONE });
}

/** The union of an employee's job permissions. */
export function permsForEmployee(empId: string): Perms {
  const jobIds = new Set(employeeJobs().filter((e) => e.empId === empId).map((e) => e.jobId));
  return union(jobs().filter((j) => jobIds.has(j.id)));
}

/** Can this employee perform `action`? Holding the manager permission (Mgr_Menu)
 *  is a master override — a manager may authorize any restricted action, even if
 *  clocked in on a non-manager job (the permission is the union across ALL their
 *  jobs, not just the one they clocked into). */
export const can = (empId: string, action: AuthAction): boolean => {
  const p = permsForEmployee(empId);
  return p[action] || p.manager;
};

export interface Authorizer { id: string; name: string; }

/** True if an employee with this ID exists (first step of manager auth: ID). */
export const employeeExists = (id: string): boolean => employees().some((e) => e.id === id.trim());

/** Authorize by ID + PIN (ManagerAuthViewController: enter ID, then PIN). The ID
 *  must resolve to an employee, the PIN must match their Pin, and they must hold
 *  `action` (or be a manager). Returns the authorizer, else null. */
export function authorizeById(id: string, pin: string, action: AuthAction): Authorizer | null {
  const e = employees().find((x) => x.id === id.trim());
  if (!e) return null;
  if ((e.pin ?? "") !== pin.trim()) return null;
  return can(e.id, action) ? { id: e.id, name: e.name } : null;
}

/** Jobs an employee can clock into (Employee_Job → Job), for the timeclock. */
export function jobsForEmployee(empId: string): Job[] {
  const jobIds = new Set(employeeJobs().filter((e) => e.empId === empId).map((e) => e.jobId));
  return jobs().filter((j) => jobIds.has(j.id));
}
