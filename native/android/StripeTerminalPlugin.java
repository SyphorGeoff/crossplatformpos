package com.aireus.pos;

import android.Manifest;
import android.app.Activity;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.stripe.stripeterminal.Terminal;
import com.stripe.stripeterminal.external.OfflineMode;
import com.stripe.stripeterminal.external.callable.AppsOnDevicesListener;
import com.stripe.stripeterminal.external.callable.Callback;
import com.stripe.stripeterminal.external.callable.Cancelable;
import com.stripe.stripeterminal.external.callable.ConnectionTokenCallback;
import com.stripe.stripeterminal.external.callable.ConnectionTokenProvider;
import com.stripe.stripeterminal.external.callable.InternetReaderListener;
import com.stripe.stripeterminal.external.callable.OfflineListener;
import com.stripe.stripeterminal.external.callable.PaymentIntentCallback;
import com.stripe.stripeterminal.external.callable.ReaderCallback;
import com.stripe.stripeterminal.external.callable.RefundCallback;
import com.stripe.stripeterminal.external.callable.TerminalListener;
import com.stripe.stripeterminal.external.models.AmountDetails;
import com.stripe.stripeterminal.external.api.ApiError;
import com.stripe.stripeterminal.external.models.CaptureMethod;
import com.stripe.stripeterminal.external.models.CardPresentParameters;
import com.stripe.stripeterminal.external.models.Charge;
import com.stripe.stripeterminal.external.models.CollectPaymentIntentConfiguration;
import com.stripe.stripeterminal.external.models.CollectRefundConfiguration;
import com.stripe.stripeterminal.external.models.ConfirmPaymentIntentConfiguration;
import com.stripe.stripeterminal.external.models.ConnectionConfiguration;
import com.stripe.stripeterminal.external.models.ConnectionStatus;
import com.stripe.stripeterminal.external.models.ConnectionTokenException;
import com.stripe.stripeterminal.external.models.CreateConfiguration;
import com.stripe.stripeterminal.external.models.CustomerCancellation;
import com.stripe.stripeterminal.external.models.DisconnectReason;
import com.stripe.stripeterminal.external.models.DiscoveryConfiguration;
import com.stripe.stripeterminal.external.models.DiscoveryFilter;
import com.stripe.stripeterminal.external.models.EasyConnectConfiguration;
import com.stripe.stripeterminal.external.models.LocaleConfig;
import com.stripe.stripeterminal.external.models.MotoConfiguration;
import com.stripe.stripeterminal.external.models.OfflineBehavior;
import com.stripe.stripeterminal.external.models.OfflineCardPresentDetails;
import com.stripe.stripeterminal.external.models.OfflineDetails;
import com.stripe.stripeterminal.external.models.OfflineStatus;
import com.stripe.stripeterminal.external.models.OfflineStatusDetails;
import com.stripe.stripeterminal.external.models.PaymentIntent;
import com.stripe.stripeterminal.external.models.PaymentIntentParameters;
import com.stripe.stripeterminal.external.models.PaymentMethodDetails;
import com.stripe.stripeterminal.external.models.PaymentMethodOptionsParameters;
import com.stripe.stripeterminal.external.models.PaymentMethodType;
import com.stripe.stripeterminal.external.models.PaymentStatus;
import com.stripe.stripeterminal.external.models.ProcessRefundParameters;
import com.stripe.stripeterminal.external.models.Reader;
import com.stripe.stripeterminal.external.models.ReaderEvent;
import com.stripe.stripeterminal.external.models.ReceiptDetails;
import com.stripe.stripeterminal.external.models.Refund;
import com.stripe.stripeterminal.external.models.SimulatedCard;
import com.stripe.stripeterminal.external.models.SimulatedCollectInputsResult;
import com.stripe.stripeterminal.external.models.SimulatorConfiguration;
import com.stripe.stripeterminal.external.models.TerminalException;
import com.stripe.stripeterminal.external.models.TippingConfiguration;
import com.stripe.stripeterminal.log.LogLevel;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * StripeTerminal — the Stripe Terminal Android SDK behind a Capacitor plugin, so the
 * same JS driver (payments/stripeSdk.ts) runs on the Stripe S710 (handoff mode: the
 * app and the reader are one device) and on a tablet or phone (the reader found over
 * the LAN). The SDK gives what the server-driven REST path cannot: offline payments,
 * stored on the reader and forwarded when the internet returns.
 *
 * Division of labour: the SDK does what needs the reader — connect, collect and
 * confirm a payment, a card-present refund. Everything server-side (capture, tip
 * adjust, incremental auth, API refunds, status after the fact) stays on the REST
 * driver, which the JS side composes.
 *
 * Connection tokens: the SDK asks for one through fetchConnectionToken; the plugin
 * raises a "connectionToken" event with a request id and waits for JS to answer with
 * setConnectionToken. JS mints the token from the back-office secret key (the same
 * one the REST driver uses) and, when offline, answers with an error at once so the
 * SDK proceeds offline (Stripe: the provider must fail fast when the backend is
 * unreachable).
 *
 * Every SDK call runs on the main thread; results come back on the plugin call.
 * The POS never sees a card number: the reader (or MOTO keypad on it) takes it.
 */
@OptIn(markerClass = OfflineMode.class)
@CapacitorPlugin(
    name = "StripeTerminal",
    permissions = { @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, alias = "location") }
)
public class StripeTerminalPlugin extends Plugin implements ConnectionTokenProvider, TerminalListener, OfflineListener {

    private static final long TOKEN_WAIT_MS = 20000;

    /** Pending connection-token requests: request id → the SDK's callback. */
    private final ConcurrentHashMap<String, ConnectionTokenCallback> tokenWaiters = new ConcurrentHashMap<>();
    /** PaymentIntents the SDK has created, by the plugin's local id (an offline intent has no Stripe id yet). */
    private final Map<String, PaymentIntent> intents = new ConcurrentHashMap<>();
    /** In-flight collect/confirm per local id, for cancellation. */
    private final Map<String, Cancelable> inFlight = new ConcurrentHashMap<>();
    @Nullable private volatile Cancelable refundInFlight;
    @Nullable private volatile Cancelable connectInFlight;
    private volatile boolean handoff = false;

    /* ---------------- init ---------------- */

    @PluginMethod
    public void init(PluginCall call) {
        final boolean verbose = Boolean.TRUE.equals(call.getBoolean("verbose", false));
        onMain(() -> {
            try {
                if (!Terminal.isInitialized()) {
                    Terminal.init(getContext().getApplicationContext(), verbose ? LogLevel.VERBOSE : LogLevel.ERROR,
                        this, this, this, LocaleConfig.CardLanguagePreferenceIfAvailable.INSTANCE);
                } else {
                    Terminal.getInstance().setTerminalListener(this);
                    Terminal.getInstance().setOfflineListener(this);
                }
                call.resolve(statusObject());
            } catch (Exception e) {
                call.reject("init failed: " + e.getMessage(), errorObject(e));
            }
        });
    }

    /** ACCESS_FINE_LOCATION must be granted before the SDK will take payments (Stripe: payments are
     *  disabled while it cannot locate the device). On the S710 it is granted at install. */
    @PluginMethod
    public void requestLocation(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) { call.resolve(permissionObject()); return; }
        requestPermissionForAlias("location", call, "locationResult");
    }

    @PermissionCallback
    private void locationResult(PluginCall call) { call.resolve(permissionObject()); }

    private JSObject permissionObject() {
        JSObject o = new JSObject();
        o.put("granted", getPermissionState("location") == PermissionState.GRANTED);
        return o;
    }

    /* ---------------- connection tokens (SDK → JS → SDK) ---------------- */

    @Override
    public void fetchConnectionToken(@NonNull ConnectionTokenCallback callback) {
        final String id = UUID.randomUUID().toString();
        tokenWaiters.put(id, callback);
        JSObject ev = new JSObject();
        ev.put("requestId", id);
        notifyListeners("connectionToken", ev, true);
        // JS answers through setConnectionToken; if it never does, fail the request so the SDK moves on.
        new Thread(() -> {
            try { Thread.sleep(TOKEN_WAIT_MS); } catch (InterruptedException ignored) { /* fall through */ }
            ConnectionTokenCallback late = tokenWaiters.remove(id);
            if (late != null) late.onFailure(new ConnectionTokenException("No connection token from the POS (timeout)"));
        }).start();
    }

    @PluginMethod
    public void setConnectionToken(PluginCall call) {
        String id = call.getString("requestId", "");
        ConnectionTokenCallback cb = id == null ? null : tokenWaiters.remove(id);
        if (cb == null) { call.resolve(); return; }
        String secret = call.getString("secret", "");
        String error = call.getString("error", "");
        if (secret != null && !secret.isEmpty()) cb.onSuccess(secret);
        else cb.onFailure(new ConnectionTokenException(error == null || error.isEmpty() ? "No connection token" : error));
        call.resolve();
    }

    /* ---------------- connect ---------------- */

    /**
     * connect({ mode: "auto" | "handoff" | "internet", locationId, readerId?, simulated?, failIfInUse? })
     * handoff = this app runs on the Stripe reader (Apps on Devices); internet = a reader on the LAN,
     * found by id when one is given; auto = handoff first, then internet.
     */
    @PluginMethod
    public void connect(PluginCall call) {
        if (!Terminal.isInitialized()) { call.reject("not initialized"); return; }
        final String mode = orEmpty(call.getString("mode", "auto"));
        onMain(() -> {
            Reader current = Terminal.getInstance().getConnectedReader();
            if (current != null && Terminal.getInstance().getConnectionStatus() == ConnectionStatus.CONNECTED) {
                JSObject o = readerObject(current); o.put("handoff", handoff); o.put("alreadyConnected", true);
                call.resolve(o); return;
            }
            if ("internet".equals(mode)) { connectInternet(call); return; }
            connectHandoff(call, "auto".equals(mode));
        });
    }

    private void connectHandoff(PluginCall call, boolean fallbackToInternet) {
        EasyConnectConfiguration cfg = new EasyConnectConfiguration.AppsOnDevicesEasyConnectionConfiguration(
            new DiscoveryConfiguration.AppsOnDevicesDiscoveryConfiguration(),
            new ConnectionConfiguration.AppsOnDevicesConnectionConfiguration(new AppsOnDevicesListener() {
                @Override public void onDisconnect(@NonNull DisconnectReason reason) { disconnected(reason); }
                @Override public void onReportReaderEvent(@NonNull ReaderEvent event) { readerEvent(event); }
            })
        );
        connectInFlight = Terminal.getInstance().easyConnect(cfg, new ReaderCallback() {
            @Override public void onSuccess(@NonNull Reader reader) {
                connectInFlight = null; handoff = true;
                JSObject o = readerObject(reader); o.put("handoff", true); call.resolve(o);
            }
            @Override public void onFailure(@NonNull TerminalException e) {
                connectInFlight = null;
                if (fallbackToInternet) onMain(() -> connectInternet(call));
                else call.reject("handoff connect failed: " + e.getErrorMessage(), errorObject(e));
            }
        });
    }

    private void connectInternet(PluginCall call) {
        String locationId = orEmpty(call.getString("locationId", ""));
        String readerId = orEmpty(call.getString("readerId", ""));
        boolean simulated = Boolean.TRUE.equals(call.getBoolean("simulated", false));
        boolean failIfInUse = Boolean.TRUE.equals(call.getBoolean("failIfInUse", false));
        DiscoveryFilter filter = readerId.isEmpty() ? DiscoveryFilter.None.INSTANCE : new DiscoveryFilter.ByReaderId(readerId);
        EasyConnectConfiguration cfg = new EasyConnectConfiguration.InternetEasyConnectConfiguration(
            new DiscoveryConfiguration.InternetDiscoveryConfiguration(0, locationId.isEmpty() ? null : locationId, simulated, filter),
            new ConnectionConfiguration.InternetConnectionConfiguration(new InternetReaderListener() {
                @Override public void onDisconnect(@NonNull DisconnectReason reason) { disconnected(reason); }
            }, failIfInUse)
        );
        connectInFlight = Terminal.getInstance().easyConnect(cfg, new ReaderCallback() {
            @Override public void onSuccess(@NonNull Reader reader) {
                connectInFlight = null; handoff = false;
                JSObject o = readerObject(reader); o.put("handoff", false); call.resolve(o);
            }
            @Override public void onFailure(@NonNull TerminalException e) {
                connectInFlight = null;
                call.reject("connect failed: " + e.getErrorMessage(), errorObject(e));
            }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        if (!Terminal.isInitialized()) { call.resolve(); return; }
        onMain(() -> {
            Cancelable c = connectInFlight;
            if (c != null) { connectInFlight = null; c.cancel(new Callback() { @Override public void onSuccess() {} @Override public void onFailure(@NonNull TerminalException e) {} }); }
            if (Terminal.getInstance().getConnectedReader() == null) { call.resolve(); return; }
            Terminal.getInstance().disconnectReader(new Callback() {
                @Override public void onSuccess() { call.resolve(); }
                @Override public void onFailure(@NonNull TerminalException e) { call.reject("disconnect failed: " + e.getErrorMessage(), errorObject(e)); }
            });
        });
    }

    @PluginMethod
    public void status(PluginCall call) { onMain(() -> call.resolve(statusObject())); }

    /* ---------------- payments ---------------- */

    /**
     * createPaymentIntent({ amount (cents), currency, captureMethod: "manual"|"automatic",
     *   paymentMethodTypes: ["card_present","interac_present","card"], extendedAuth?, incrementalAuth?,
     *   description?, metadata?, offlineBehavior?: "prefer_online"|"require_online"|"force_offline" })
     * → { localId, id?, status, offline }
     */
    @PluginMethod
    public void createPaymentIntent(PluginCall call) {
        if (!Terminal.isInitialized()) { call.reject("not initialized"); return; }
        final long amount = call.getData().optLong("amount", 0L);   // not call.getLong: it ignores an Integer-typed JSON number
        final String currency = orEmpty(call.getString("currency", "usd"));
        final boolean manual = "manual".equals(call.getString("captureMethod", "automatic"));
        final boolean extended = Boolean.TRUE.equals(call.getBoolean("extendedAuth", false));
        final boolean incremental = Boolean.TRUE.equals(call.getBoolean("incrementalAuth", false));
        final String description = call.getString("description", null);
        final JSObject meta = call.getObject("metadata", null);
        final String behavior = orEmpty(call.getString("offlineBehavior", "prefer_online"));
        List<PaymentMethodType> types = new ArrayList<>();
        JSArray arr = call.getArray("paymentMethodTypes", null);
        if (arr != null) {
            try {
                for (int i = 0; i < arr.length(); i++) {
                    String t = String.valueOf(arr.get(i));
                    if ("card_present".equals(t)) types.add(PaymentMethodType.CARD_PRESENT);
                    else if ("interac_present".equals(t)) types.add(PaymentMethodType.INTERAC_PRESENT);
                    else if ("card".equals(t)) types.add(PaymentMethodType.CARD);
                }
            } catch (Exception ignored) { /* bad entry → default below */ }
        }
        if (types.isEmpty()) types.add(PaymentMethodType.CARD_PRESENT);

        onMain(() -> {
            try {
                PaymentIntentParameters.Builder b = new PaymentIntentParameters.Builder(types)
                    .setAmount(amount).setCurrency(currency)
                    .setCaptureMethod(manual ? CaptureMethod.Manual : CaptureMethod.Automatic);
                if (description != null && !description.isEmpty()) b.setDescription(description);
                if (meta != null) {
                    Map<String, String> m = new HashMap<>();
                    for (java.util.Iterator<String> it = meta.keys(); it.hasNext();) { String k = it.next(); Object v = meta.opt(k); if (v != null) m.put(k, String.valueOf(v)); }
                    b.setMetadata(m);
                }
                if (extended || incremental) {
                    CardPresentParameters cp = new CardPresentParameters.Builder()
                        .setRequestExtendedAuthorization(extended)
                        .setRequestIncrementalAuthorizationSupport(incremental)
                        .build();
                    b.setPaymentMethodOptionsParameters(new PaymentMethodOptionsParameters.Builder().setCardPresentParameters(cp).build());
                }
                OfflineBehavior ob = "require_online".equals(behavior) ? OfflineBehavior.REQUIRE_ONLINE
                    : "force_offline".equals(behavior) ? OfflineBehavior.FORCE_OFFLINE : OfflineBehavior.PREFER_ONLINE;
                final String localId = "pi-local-" + UUID.randomUUID();
                Terminal.getInstance().createPaymentIntent(b.build(), new PaymentIntentCallback() {
                    @Override public void onSuccess(@NonNull PaymentIntent intent) {
                        intents.put(localId, intent);
                        JSObject o = intentObject(intent); o.put("localId", localId);
                        call.resolve(o);
                    }
                    @Override public void onFailure(@NonNull TerminalException e) { call.reject("create failed: " + e.getErrorMessage(), errorObject(e)); }
                }, new CreateConfiguration(ob));
            } catch (Exception e) {
                call.reject("create failed: " + e.getMessage(), errorObject(e));
            }
        });
    }

    /**
     * collectAndConfirm({ localId, skipTipping?, tipEligibleAmount? (cents), moto?, customerCancel? })
     * Runs the reader prompt and the confirmation; resolves with the intent when it settles, rejects with
     * { code, declineCode, message, cancelled, intent? } otherwise. Long-running: cancelCollect() aborts it.
     */
    @PluginMethod
    public void collectAndConfirm(PluginCall call) {
        final String localId = orEmpty(call.getString("localId", ""));
        final PaymentIntent intent = intents.get(localId);
        if (intent == null) { call.reject("unknown localId"); return; }
        final boolean skipTipping = Boolean.TRUE.equals(call.getBoolean("skipTipping", true));
        final Long eligible = call.getData().has("tipEligibleAmount") ? Long.valueOf(call.getData().optLong("tipEligibleAmount", 0L)) : null;
        final boolean moto = Boolean.TRUE.equals(call.getBoolean("moto", false));
        final boolean customerCancel = Boolean.TRUE.equals(call.getBoolean("customerCancel", true));
        call.setKeepAlive(true);
        onMain(() -> {
            try {
                CollectPaymentIntentConfiguration.Builder cb = new CollectPaymentIntentConfiguration.Builder()
                    .skipTipping(skipTipping)
                    .setCustomerCancellation(customerCancel ? CustomerCancellation.ENABLE_IF_AVAILABLE : CustomerCancellation.DISABLE_IF_AVAILABLE);
                if (!skipTipping && eligible != null) cb.setTippingConfiguration(new TippingConfiguration.Builder().setEligibleAmount(eligible).build());
                if (moto) cb.setMotoConfiguration(new MotoConfiguration.Builder().build());
                Cancelable c = Terminal.getInstance().processPaymentIntent(intent, cb.build(), new ConfirmPaymentIntentConfiguration.Builder().build(), new PaymentIntentCallback() {
                    @Override public void onSuccess(@NonNull PaymentIntent pi) {
                        inFlight.remove(localId); intents.put(localId, pi);
                        JSObject o = intentObject(pi); o.put("localId", localId);
                        call.setKeepAlive(false); call.resolve(o);
                    }
                    @Override public void onFailure(@NonNull TerminalException e) {
                        inFlight.remove(localId);
                        PaymentIntent pi = e.getPaymentIntent();
                        if (pi != null) intents.put(localId, pi);
                        JSObject err = errorObject(e);
                        if (pi != null) { JSObject o = intentObject(pi); o.put("localId", localId); err.put("intent", o); }
                        call.setKeepAlive(false); call.reject(e.getErrorMessage(), err);
                    }
                });
                inFlight.put(localId, c);
            } catch (Exception e) {
                call.setKeepAlive(false); call.reject("collect failed: " + e.getMessage(), errorObject(e));
            }
        });
    }

    @PluginMethod
    public void cancelCollect(PluginCall call) {
        final String localId = orEmpty(call.getString("localId", ""));
        Cancelable c = inFlight.remove(localId);
        if (c == null) { call.resolve(); return; }
        onMain(() -> c.cancel(new Callback() {
            @Override public void onSuccess() { call.resolve(); }
            @Override public void onFailure(@NonNull TerminalException e) { call.reject("cancel failed: " + e.getErrorMessage(), errorObject(e)); }
        }));
    }

    @PluginMethod
    public void cancelPaymentIntent(PluginCall call) {
        final String localId = orEmpty(call.getString("localId", ""));
        final PaymentIntent intent = intents.get(localId);
        if (intent == null) { call.reject("unknown localId"); return; }
        onMain(() -> Terminal.getInstance().cancelPaymentIntent(intent, new PaymentIntentCallback() {
            @Override public void onSuccess(@NonNull PaymentIntent pi) { intents.put(localId, pi); JSObject o = intentObject(pi); o.put("localId", localId); call.resolve(o); }
            @Override public void onFailure(@NonNull TerminalException e) { call.reject("cancel failed: " + e.getErrorMessage(), errorObject(e)); }
        }));
    }

    /** The intent the plugin holds for a local id (after forwarding it carries the Stripe id). */
    @PluginMethod
    public void getPaymentIntent(PluginCall call) {
        final String localId = orEmpty(call.getString("localId", ""));
        PaymentIntent intent = intents.get(localId);
        if (intent == null) { call.reject("unknown localId"); return; }
        JSObject o = intentObject(intent); o.put("localId", localId); call.resolve(o);
    }

    /** Test mode, simulated reader: pick the card the simulator presents (SimulatedCardType name, or a test card number). */
    @PluginMethod
    public void setSimulatedCard(PluginCall call) {
        if (!Terminal.isInitialized()) { call.reject("not initialized"); return; }
        final String type = orEmpty(call.getString("cardType", ""));
        final String number = orEmpty(call.getString("number", ""));
        onMain(() -> {
            try {
                SimulatedCard card = !type.isEmpty()
                    ? new SimulatedCard(com.stripe.stripeterminal.external.models.SimulatedCardType.valueOf(type))
                    : new SimulatedCard(number.isEmpty() ? "4242424242424242" : number);
                Terminal.getInstance().setSimulatorConfiguration(new SimulatorConfiguration(card, null, false,
                    new SimulatedCollectInputsResult.SimulatedCollectInputsResultSucceeded()));
                call.resolve();
            } catch (Exception e) {
                call.reject("simulator config failed: " + e.getMessage(), errorObject(e));
            }
        });
    }

    /* ---------------- refunds (card present on the reader) ---------------- */

    /** processRefund({ chargeId, amount (cents), currency, customerCancel? }) → { id, status, amount, failureReason } */
    @PluginMethod
    public void processRefund(PluginCall call) {
        if (!Terminal.isInitialized()) { call.reject("not initialized"); return; }
        final String chargeId = orEmpty(call.getString("chargeId", ""));
        final long amount = call.getData().optLong("amount", 0L);   // not call.getLong: it ignores an Integer-typed JSON number
        final String currency = orEmpty(call.getString("currency", "usd"));
        final boolean customerCancel = Boolean.TRUE.equals(call.getBoolean("customerCancel", true));
        if (chargeId.isEmpty() || amount <= 0) { call.reject("chargeId and amount required"); return; }
        call.setKeepAlive(true);
        onMain(() -> {
            try {
                ProcessRefundParameters params = new ProcessRefundParameters.ByChargeId(chargeId, amount, currency).build();
                CollectRefundConfiguration cfg = new CollectRefundConfiguration.Builder()
                    .setCustomerCancellation(customerCancel ? CustomerCancellation.ENABLE_IF_AVAILABLE : CustomerCancellation.DISABLE_IF_AVAILABLE).build();
                refundInFlight = Terminal.getInstance().processRefund(params, cfg, new RefundCallback() {
                    @Override public void onSuccess(@NonNull Refund refund) { refundInFlight = null; call.setKeepAlive(false); call.resolve(refundObject(refund)); }
                    @Override public void onFailure(@NonNull TerminalException e) {
                        refundInFlight = null; JSObject err = errorObject(e);
                        Refund r = e.getRefund(); if (r != null) err.put("refund", refundObject(r));
                        call.setKeepAlive(false); call.reject(e.getErrorMessage(), err);
                    }
                });
            } catch (Exception e) {
                call.setKeepAlive(false); call.reject("refund failed: " + e.getMessage(), errorObject(e));
            }
        });
    }

    @PluginMethod
    public void cancelRefund(PluginCall call) {
        Cancelable c = refundInFlight;
        refundInFlight = null;
        if (c == null) { call.resolve(); return; }
        onMain(() -> c.cancel(new Callback() {
            @Override public void onSuccess() { call.resolve(); }
            @Override public void onFailure(@NonNull TerminalException e) { call.reject("cancel failed: " + e.getErrorMessage(), errorObject(e)); }
        }));
    }

    /* ---------------- SDK listeners → JS events ---------------- */

    @Override public void onConnectionStatusChange(@NonNull ConnectionStatus status) {
        JSObject o = new JSObject(); o.put("status", status.name()); notifyListeners("connectionStatus", o, true);
    }
    @Override public void onPaymentStatusChange(@NonNull PaymentStatus status) {
        JSObject o = new JSObject(); o.put("status", status.name()); notifyListeners("paymentStatus", o, true);
    }
    @Override public void onOfflineStatusChange(@NonNull OfflineStatus offlineStatus) {
        notifyListeners("offlineStatus", offlineObject(offlineStatus), true);
    }
    @Override public void onPaymentIntentForwarded(@NonNull PaymentIntent paymentIntent, @Nullable TerminalException e) {
        // Keep our copy current under whichever local id holds it (match by the metadata the POS stamped).
        String localId = localIdFor(paymentIntent);
        if (localId != null) intents.put(localId, paymentIntent);
        JSObject o = intentObject(paymentIntent);
        if (localId != null) o.put("localId", localId);
        if (e != null) o.put("error", errorObject(e));
        notifyListeners("paymentIntentForwarded", o, true);
    }
    @Override public void onForwardingFailure(@NonNull TerminalException e) { notifyListeners("forwardingFailure", errorObject(e), true); }

    private void disconnected(DisconnectReason reason) {
        JSObject o = new JSObject(); o.put("reason", reason.name()); notifyListeners("readerDisconnect", o, true);
    }
    private void readerEvent(ReaderEvent event) {
        JSObject o = new JSObject(); o.put("event", event.name()); notifyListeners("readerEvent", o, true);
    }

    /* ---------------- objects ---------------- */

    private JSObject statusObject() {
        JSObject o = new JSObject();
        boolean init = Terminal.isInitialized();
        o.put("initialized", init);
        o.put("locationGranted", getPermissionState("location") == PermissionState.GRANTED);
        if (init) {
            Terminal t = Terminal.getInstance();
            o.put("connectionStatus", t.getConnectionStatus().name());
            o.put("paymentStatus", t.getPaymentStatus().name());
            Reader r = t.getConnectedReader();
            if (r != null) { JSObject ro = readerObject(r); ro.put("handoff", handoff); o.put("reader", ro); }
            try { o.put("offline", offlineObject(t.getOfflineStatus())); } catch (Exception ignored) { /* offline module may be unavailable */ }
        }
        return o;
    }

    private JSObject readerObject(Reader r) {
        JSObject o = new JSObject();
        o.put("id", r.getId());
        o.put("serial", r.getSerialNumber());
        o.put("label", r.getLabel());
        o.put("deviceType", r.getDeviceType().name());
        o.put("ipAddress", r.getIpAddress());
        o.put("simulated", r.isSimulated());
        o.put("softwareVersion", r.getSoftwareVersion());
        return o;
    }

    private JSObject offlineObject(OfflineStatus s) {
        JSObject o = new JSObject();
        o.put("sdk", offlineDetails(s.getSdk()));
        OfflineStatusDetails rd = s.getReader();
        if (rd != null) o.put("reader", offlineDetails(rd));
        return o;
    }
    private JSObject offlineDetails(OfflineStatusDetails d) {
        JSObject o = new JSObject();
        o.put("network", d.getNetworkStatus().name());
        o.put("paymentsCount", d.getOfflinePaymentsCount());
        JSObject amounts = new JSObject();
        for (Map.Entry<String, Long> e : d.getOfflinePaymentAmountsByCurrency().entrySet()) amounts.put(e.getKey(), e.getValue());
        o.put("amounts", amounts);
        return o;
    }

    private JSObject intentObject(PaymentIntent pi) {
        JSObject o = new JSObject();
        o.put("id", pi.getId());
        o.put("status", pi.getStatus() == null ? null : pi.getStatus().name());
        o.put("amount", pi.getAmount());
        o.put("amountTip", pi.getAmountTip());
        o.put("currency", pi.getCurrency());
        o.put("clientSecret", pi.getClientSecret());
        o.put("captureMethod", pi.getCaptureMethod());
        AmountDetails ad = pi.getAmountDetails();
        if (ad != null && ad.getTip() != null) o.put("tipAmount", ad.getTip().getAmount());
        if (pi.getMetadata() != null) { JSObject m = new JSObject(); for (Map.Entry<String, String> e : pi.getMetadata().entrySet()) m.put(e.getKey(), e.getValue()); o.put("metadata", m); }
        OfflineDetails od = pi.getOfflineDetails();
        if (od != null) {
            JSObject off = new JSObject();
            off.put("requiresUpload", od.getRequiresUpload());
            off.put("storedAtMs", od.getStoredAtMs());
            OfflineCardPresentDetails oc = od.getCardPresentDetails();
            if (oc != null) {
                JSObject c = new JSObject();
                c.put("brand", oc.getBrand()); c.put("last4", oc.getLast4()); c.put("readMethod", oc.getReadMethod()); c.put("cardholderName", oc.getCardholderName());
                c.put("receipt", receiptObject(oc.getReceiptDetails()));
                off.put("card", c);
            }
            o.put("offline", off);
        }
        Charge ch = pi.getLatestCharge();
        if (ch != null) {
            JSObject c = new JSObject();
            c.put("id", ch.getId()); c.put("status", ch.getStatus()); c.put("authorizationCode", ch.getAuthorizationCode());
            c.put("captured", ch.getCaptured()); c.put("amount", ch.getAmount()); c.put("amountRefunded", ch.getAmountRefunded());
            PaymentMethodDetails pmd = ch.getPaymentMethodDetails();
            if (pmd != null) {
                Charge.CardPresent card = pmd.getInteracPresentDetails() != null ? pmd.getInteracPresentDetails() : pmd.getCardPresentDetails();
                c.put("type", pmd.getInteracPresentDetails() != null ? "interac_present" : pmd.getType() == null ? null : pmd.getType().name().toLowerCase());
                if (card != null) {
                    JSObject k = new JSObject();
                    k.put("brand", card.getBrand()); k.put("last4", card.getLast4()); k.put("readMethod", card.getReadMethod());
                    k.put("funding", card.getFunding()); k.put("network", card.getNetwork()); k.put("cardholderName", card.getCardholderName());
                    k.put("receipt", receiptObject(card.getReceiptDetails()));
                    c.put("card", k);
                }
            }
            o.put("charge", c);
        } else if (pi.getLatestChargeId() != null) {
            JSObject c = new JSObject(); c.put("id", pi.getLatestChargeId()); o.put("charge", c);
        }
        ApiError lpe = pi.getLastPaymentError();
        if (lpe != null) o.put("lastPaymentError", apiErrorObject(lpe));
        return o;
    }

    private JSObject receiptObject(@Nullable ReceiptDetails r) {
        JSObject o = new JSObject();
        if (r == null) return o;
        o.put("accountType", r.getAccountType());
        o.put("applicationPreferredName", r.getApplicationPreferredName());
        o.put("dedicatedFileName", r.getDedicatedFileName());
        o.put("authorizationCode", r.getAuthorizationCode());
        o.put("authorizationResponseCode", r.getAuthorizationResponseCode());
        o.put("applicationCryptogram", r.getApplicationCryptogram());
        o.put("terminalVerificationResults", r.getTvr());
        o.put("transactionStatusInformation", r.getTsi());
        o.put("cardholderVerificationMethod", r.getCvm());
        return o;
    }

    private JSObject refundObject(Refund r) {
        JSObject o = new JSObject();
        o.put("id", r.getId()); o.put("status", r.getStatus()); o.put("amount", r.getAmount()); o.put("currency", r.getCurrency());
        o.put("failureReason", r.getFailureReason()); o.put("chargeId", r.getChargeId()); o.put("paymentIntentId", r.getPaymentIntentId());
        return o;
    }

    private JSObject apiErrorObject(ApiError a) {
        JSObject o = new JSObject();
        o.put("code", a.getCode()); o.put("declineCode", a.getDeclineCode()); o.put("message", a.getMessage()); o.put("type", a.getType());
        return o;
    }

    private JSObject errorObject(Exception e) {
        JSObject o = new JSObject();
        if (e instanceof TerminalException) {
            TerminalException te = (TerminalException) e;
            String code = te.getErrorCode().name();
            o.put("code", code);
            o.put("message", te.getErrorMessage());
            o.put("cancelled", code.startsWith("CANCELED"));
            o.put("declined", code.startsWith("DECLINED") || "OFFLINE_TRANSACTION_DECLINED".equals(code));
            ApiError a = te.getApiError();
            if (a != null) o.put("apiError", apiErrorObject(a));
        } else {
            o.put("code", "EXCEPTION"); o.put("message", String.valueOf(e.getMessage()));
        }
        return o;
    }

    @Nullable
    private String localIdFor(PaymentIntent pi) {
        for (Map.Entry<String, PaymentIntent> e : intents.entrySet()) {
            PaymentIntent held = e.getValue();
            if (held == pi) return e.getKey();
            if (pi.getId() != null && pi.getId().equals(held.getId())) return e.getKey();
            Map<String, String> a = pi.getMetadata(), b = held.getMetadata();
            if (a != null && b != null && a.get("tender_key") != null && a.get("tender_key").equals(b.get("tender_key"))
                && a.get("check_no") != null && a.get("check_no").equals(b.get("check_no"))) return e.getKey();
        }
        return null;
    }

    private static String orEmpty(@Nullable String s) { return s == null ? "" : s; }

    private void onMain(Runnable r) {
        Activity a = getActivity();
        if (a != null) a.runOnUiThread(r); else r.run();
    }
}
