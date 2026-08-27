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

export const can = (empId: string, action: AuthAction): boolean => permsForEmployee(empId)[action];

export interface Authorizer { id: string; name: string; }
/** Resolve a manager PIN to an employee who may perform `action`, else null. */
export function findAuthorizer(pin: string, action: AuthAction): Authorizer | null {
  const p = pin.trim();
  if (!p) return null;
  for (const e of employees()) {
    if (e.pin && e.pin === p && permsForEmployee(e.id)[action]) return { id: e.id, name: e.name };
  }
  return null;
}

/** Jobs an employee can clock into (Employee_Job → Job), for the timeclock. */
export function jobsForEmployee(empId: string): Job[] {
  const jobIds = new Set(employeeJobs().filter((e) => e.empId === empId).map((e) => e.jobId));
  return jobs().filter((j) => jobIds.has(j.id));
}
