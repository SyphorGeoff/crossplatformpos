/*
 * Processor configuration from the definitions. No new Store columns per
 * processor: Store.CC_Processor names the module and Store.MerchantPassword
 * (or the Revenue Center's rc_CC_Merchant_Password when use_RC_CC_Processor)
 * holds that processor's JSON bundle, written by the back-office Credit Card
 * interface screen. Credentials are entered ONCE there (Geoff 2026-11-06: the
 * same credentials serve other Aireus applications, so they live in the
 * config, not per tablet) — the bundle is the source of truth for every client.
 *
 * Bundles (back office writes these; keys are lower camel):
 *   tsys   { mid, deviceId, developerId, testMode }
 *   stripe { accountId, locationId, secretKey, publishableKey, testMode, currency? }
 */

import type { RevenueCenter, StoreConfig } from "@/model/catalog";
import type { ProcessorName } from "./processor";

export interface ProcessorBundle {
  [k: string]: string | number | boolean | undefined;
  mid?: string;
  deviceId?: string;
  developerId?: string;
  accountId?: string;
  locationId?: string;
  secretKey?: string;        // stripe: the account's secret or restricted key (sk_/rk_)
  publishableKey?: string;   // stripe: pk_ for browser-side payment forms (AireusPay)
  currency?: string;         // stripe: optional override; default = the account's default_currency
  testMode?: boolean;
}

/** Parse a bundle string. Tolerates the HTML-escaped quotes the back office
 *  sometimes stores (&quot;) and single-quoted JSON; anything unparsable → {}. */
export function parseBundle(raw: string | undefined): ProcessorBundle {
  const text = (raw ?? "").trim().replace(/&quot;/g, '"');
  if (!text.startsWith("{")) return {};
  try { return JSON.parse(text) as ProcessorBundle; } catch { /* fall through */ }
  try { return JSON.parse(text.replace(/'/g, '"')) as ProcessorBundle; } catch { return {}; }
}

export interface ProcessorConfig {
  name: ProcessorName | "";   // "" = no supported processor configured (online tenders stay disabled)
  merchantId: string;         // Store.Merchant_ID or the RC's rc_CC_Merchant_ID
  bundle: ProcessorBundle;
  testMode: boolean;          // Store.cc_test_mode || bundle.testMode
  timeoutSec: number;         // Store.CC_Timeout
}

const SUPPORTED: ReadonlyArray<ProcessorName> = ["stripe", "tsys", "mock"];

export function isProcessorName(v: string): v is ProcessorName {
  return (SUPPORTED as ReadonlyArray<string>).includes(v);
}

/** Resolve the processor for a check: Revenue_Center override (use_RC_CC_Processor +
 *  rc_CreditCardDriver) else the Store's CC_Processor. `override` is the dev-only
 *  terminal override (select.ts), applied last. */
export function processorConfig(store: StoreConfig, rc?: RevenueCenter | null, override?: string): ProcessorConfig {
  const useRc = !!rc && rc.useRcCcProcessor && !!rc.ccProcessor;
  const rawName = (override || (useRc ? rc!.ccProcessor : store.ccProcessor) || "").trim().toLowerCase();
  const name: ProcessorName | "" = isProcessorName(rawName) ? rawName : "";
  const bundle = parseBundle(useRc ? rc!.ccMerchantBundle : store.merchantBundle);
  return {
    name,
    merchantId: (useRc ? rc!.ccMerchantId : store.merchantId) || String(bundle.mid ?? bundle.accountId ?? ""),
    bundle,
    testMode: store.ccTestMode || bundle.testMode === true,
    timeoutSec: store.ccTimeoutSec > 0 ? store.ccTimeoutSec : 60,
  };
}
