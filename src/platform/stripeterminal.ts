/*
 * StripeTerminal plugin seam — the Stripe Terminal Android SDK behind the Capacitor
 * plugin native/android/StripeTerminalPlugin.java, typed for the JS driver
 * (payments/stripeSdk.ts). Present only on an Android build with the plugin compiled
 * in; `hasStripeTerminal()` is the platform gate, exactly like the AppUpdate plugin.
 *
 * Connection tokens: the SDK asks the plugin, the plugin raises "connectionToken",
 * and the provider installed with `installTokenProvider` answers through
 * setConnectionToken. The provider is expected to fail fast when Stripe is unreachable
 * so the SDK can carry on offline.
 */

// Reads window.Capacitor itself (not through platform/http) so tests that mock http.ts are unaffected.
interface CapGlobal { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> }
const cap = (): CapGlobal | null => ((globalThis as { Capacitor?: CapGlobal }).Capacitor ?? null);
const isNative = (): boolean => !!cap()?.isNativePlatform?.();

export type ConnectMode = "auto" | "handoff" | "internet";

export interface ReaderSummary {
  id?: string; serial?: string; label?: string; deviceType?: string; ipAddress?: string; simulated?: boolean; softwareVersion?: string;
  handoff?: boolean; alreadyConnected?: boolean;
}

export interface OfflineSide { network: "UNKNOWN" | "OFFLINE" | "ONLINE"; paymentsCount: number; amounts: Record<string, number>; }
export interface OfflineSummary { sdk: OfflineSide; reader?: OfflineSide; }

export interface TerminalStatus {
  initialized: boolean; locationGranted: boolean;
  connectionStatus?: "NOT_CONNECTED" | "CONNECTING" | "CONNECTED" | "DISCOVERING" | string;
  paymentStatus?: string; reader?: ReaderSummary; offline?: OfflineSummary;
}

export interface ReceiptSummary {
  accountType?: string | null; applicationPreferredName?: string | null; dedicatedFileName?: string | null; authorizationCode?: string | null;
  authorizationResponseCode?: string | null; applicationCryptogram?: string | null; terminalVerificationResults?: string | null;
  transactionStatusInformation?: string | null; cardholderVerificationMethod?: string | null;
}
export interface CardSummary { brand?: string | null; last4?: string | null; readMethod?: string | null; funding?: string | null; network?: string | null; cardholderName?: string | null; receipt?: ReceiptSummary; }
export interface IntentSummary {
  localId?: string; id?: string | null;
  status?: "CANCELED" | "PROCESSING" | "REQUIRES_CAPTURE" | "REQUIRES_REAUTHORIZATION" | "REQUIRES_CONFIRMATION" | "REQUIRES_PAYMENT_METHOD" | "REQUIRES_ACTION" | "SUCCEEDED" | null;
  amount?: number; amountTip?: number | null; tipAmount?: number | null; currency?: string | null; clientSecret?: string | null; captureMethod?: string | null;
  metadata?: Record<string, string>;
  offline?: { requiresUpload: boolean; storedAtMs: number; card?: CardSummary };
  charge?: { id?: string | null; status?: string | null; authorizationCode?: string | null; captured?: boolean; amount?: number; amountRefunded?: number; type?: string | null; card?: CardSummary };
  lastPaymentError?: { code?: string | null; declineCode?: string | null; message?: string | null; type?: string | null };
  error?: PluginError;
}
export interface RefundSummary { id?: string | null; status?: string | null; amount?: number | null; currency?: string | null; failureReason?: string | null; chargeId?: string | null; paymentIntentId?: string | null; }

/** What a rejected plugin call carries (Capacitor puts it on error.data). */
export interface PluginError { code?: string; message?: string; cancelled?: boolean; declined?: boolean; apiError?: { code?: string | null; declineCode?: string | null; message?: string | null }; intent?: IntentSummary; refund?: RefundSummary; }

export interface CreateIntentOpts {
  amount: number; currency: string; captureMethod: "manual" | "automatic";
  paymentMethodTypes: Array<"card_present" | "interac_present" | "card">;
  extendedAuth?: boolean; incrementalAuth?: boolean; description?: string; metadata?: Record<string, string | undefined>;
  offlineBehavior?: "prefer_online" | "require_online" | "force_offline";
}
export interface CollectOpts { localId: string; skipTipping: boolean; tipEligibleAmount?: number; moto?: boolean; customerCancel?: boolean; }

interface StripeTerminalPlugin {
  init(opts: { verbose?: boolean }): Promise<TerminalStatus>;
  requestLocation(): Promise<{ granted: boolean }>;
  setConnectionToken(opts: { requestId: string; secret?: string; error?: string }): Promise<void>;
  connect(opts: { mode: ConnectMode; locationId?: string; readerId?: string; simulated?: boolean; failIfInUse?: boolean }): Promise<ReaderSummary>;
  disconnect(): Promise<void>;
  status(): Promise<TerminalStatus>;
  createPaymentIntent(opts: CreateIntentOpts): Promise<IntentSummary>;
  collectAndConfirm(opts: CollectOpts): Promise<IntentSummary>;
  cancelCollect(opts: { localId: string }): Promise<void>;
  cancelPaymentIntent(opts: { localId: string }): Promise<IntentSummary>;
  getPaymentIntent(opts: { localId: string }): Promise<IntentSummary>;
  setSimulatedCard(opts: { cardType?: string; number?: string }): Promise<void>;
  processRefund(opts: { chargeId: string; amount: number; currency: string; customerCancel?: boolean }): Promise<RefundSummary>;
  cancelRefund(): Promise<void>;
  addListener(event: string, cb: (data: never) => void): Promise<{ remove: () => void }> | { remove: () => void };
}

const plugin = (): StripeTerminalPlugin | undefined => cap()?.Plugins?.StripeTerminal as StripeTerminalPlugin | undefined;

/** True on a native build with the Terminal SDK plugin compiled in (Android). The web never has it. */
export function hasStripeTerminal(): boolean { return isNative() && !!plugin(); }

/** The plugin, or a thrown error when this build has none (callers gate with hasStripeTerminal first). */
export function stripeTerminal(): StripeTerminalPlugin {
  const p = plugin();
  if (!p) throw new Error("Stripe Terminal SDK is not available on this platform");
  return p;
}

/** The error object a rejected plugin call carries, from whatever shape Capacitor hands back. */
export function pluginError(e: unknown): PluginError {
  const o = (e ?? {}) as { data?: PluginError; code?: string; message?: string };
  const d = o.data ?? {};
  return { ...d, message: d.message || o.message || String(e), code: d.code ?? o.code };
}

let tokenProviderInstalled = false;
/** Answer the SDK's connection-token requests with `mint()` (REST, with the bundle's secret key). Installed once. */
export async function installTokenProvider(mint: () => Promise<string>): Promise<void> {
  if (tokenProviderInstalled) return;
  const p = stripeTerminal();
  tokenProviderInstalled = true;
  await Promise.resolve(p.addListener("connectionToken", (ev: never) => {
    const requestId = (ev as { requestId?: string }).requestId ?? "";
    mint().then(
      (secret) => void p.setConnectionToken({ requestId, secret }),
      (err) => void p.setConnectionToken({ requestId, error: String((err as Error)?.message ?? err) }),
    );
  }));
}

export type TerminalEvent = "offlineStatus" | "paymentIntentForwarded" | "forwardingFailure" | "readerDisconnect" | "connectionStatus" | "paymentStatus" | "readerEvent";
/** Subscribe to an SDK event; returns the unsubscribe. */
export async function onTerminalEvent<T = Record<string, unknown>>(event: TerminalEvent, cb: (data: T) => void): Promise<() => void> {
  const h = await Promise.resolve(stripeTerminal().addListener(event, cb as (data: never) => void));
  return () => h.remove();
}
