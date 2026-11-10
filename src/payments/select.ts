/*
 * Processor selection — the definitions pick the module (Revenue Center
 * override, else the Store), and this registry maps the name to the module.
 * A name the registry does not know (square, converge, "", …) returns null and
 * online tenders stay disabled, exactly as before the seam existed.
 *
 * Registry: `mock` ships now (dev + tests). `tsys` and `stripe` register here
 * when their modules land (each in its own file; nothing else changes).
 *
 * Dev override: in a Vite dev build only, localStorage "dev.ccProcessor" names
 * the processor regardless of the definitions, so the mock can run against a
 * store whose back office still says square. Never read in a production build.
 */

import type { RevenueCenter, StoreConfig } from "@/model/catalog";
import { loadStr } from "@/platform/storage";
import { processorConfig, type ProcessorConfig } from "./config";
import { mockProcessor } from "./mock";
import type { CardProcessor, ProcessorName } from "./processor";

export const DEV_OVERRIDE_KEY = "dev.ccProcessor";

const registry: Partial<Record<ProcessorName, (cfg: ProcessorConfig) => CardProcessor>> = {
  mock: () => mockProcessor,
};

/** Register a processor module (called once at module load by tsys.ts / stripe.ts). */
export function registerProcessor(name: ProcessorName, make: (cfg: ProcessorConfig) => CardProcessor): void {
  registry[name] = make;
}

export function devProcessorOverride(): string {
  try { return import.meta.env?.DEV ? loadStr(DEV_OVERRIDE_KEY, "").trim().toLowerCase() : ""; } catch { return ""; }
}

export interface Selected { processor: CardProcessor; config: ProcessorConfig; }

/** The processor for a check, or null when none is configured / supported. */
export function selectProcessor(store: StoreConfig, rc?: RevenueCenter | null): Selected | null {
  const config = processorConfig(store, rc, devProcessorOverride());
  if (!config.name) return null;
  const make = registry[config.name];
  if (!make) return null;
  return { processor: make(config), config };
}
