package com.aireus.pos;

import android.app.Application;
import com.stripe.stripeterminal.TerminalApplicationDelegate;

/**
 * Application subclass the Stripe Terminal Android SDK needs: it watches the app
 * lifecycle through TerminalApplicationDelegate so its long-running work (reader
 * connection, offline store-and-forward) is cleaned up properly. Named in
 * AndroidManifest.xml as android:name=".MainApplication". Both flavours (pos, mini).
 */
public class MainApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        TerminalApplicationDelegate.onCreate(this);
    }
}
