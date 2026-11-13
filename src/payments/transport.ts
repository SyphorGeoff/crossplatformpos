/*
 * How the Stripe driver reaches the reader: through the Terminal SDK (the Android
 * plugin; offline-capable; handoff mode on the S710) or the server-driven REST API
 * (online only; the only road a browser has). A terminal-local setting in the
 * Manager Console (Login → version number → manager ID + PIN), default SDK on a
 * build that has the plugin; a web build is REST and cannot be changed.
 */

import { loadStr, saveStr } from "@/platform/storage";
import { hasStripeTerminal } from "@/platform/stripeterminal";

export type StripeTransport = "sdk" | "rest";

const KEY = "payments.stripe.transport.v1";

/** The stored preference (what the console shows), default SDK. */
export function stripeTransportSetting(): StripeTransport {
  return loadStr(KEY, "sdk").trim().toLowerCase() === "rest" ? "rest" : "sdk";
}

const listeners = new Set<() => void>();
/** Watch the setting (Menu re-selects the card driver when the console flips it). Returns the unsubscribe. */
export function subscribeStripeTransport(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }

export function setStripeTransport(t: StripeTransport): void { saveStr(KEY, t); for (const cb of listeners) cb(); }

/** Whether this build can use the SDK at all (a native build with the plugin). */
export function sdkAvailable(): boolean { return hasStripeTerminal(); }

/** The transport in force: the setting, forced to REST where no SDK exists. */
export function effectiveStripeTransport(): StripeTransport {
  return sdkAvailable() ? stripeTransportSetting() : "rest";
}
