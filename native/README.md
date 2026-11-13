# Native builds (Capacitor) — Android / iOS

The web app is the app; Capacitor wraps `dist/` in a native shell. Native builds
gain two things the browser can't do:

1. **No CORS** — the app calls the enterprise server by address through the OS
   network stack (the `platform/http.ts` seam detects Capacitor automatically).
2. **Raw TCP printing (port 9100)** — via the tiny `TcpPrint` plugin in this
   folder (the `platform/print.ts` seam uses it when present; in the browser it
   no-ops, which is why prints are silent in dev).

The printing subsystem (`platform/escpos.ts`, `model/printers.ts`,
`protocol/printjobs.ts`, `platform/print.ts`) is a faithful port of the iPad
PrintManager: check printer = the terminal's `Chk_Printer_POS_ID`; prep chits
route through `Print_Group → Printer_Print_Group → Printer` (gated by
`Terminal_Print_Group` / `RevenueCenter_Print_Group`); primary→backup failover;
cloud/HTTP printers (port 80/443/8080/8443) POST to `printserver.jsp` instead of
the raw socket; KDS-flagged printers receive orders through the order flow.

## One-time setup

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npm run build
npx cap add android     # creates android/
npx cap add ios         # creates ios/   (macOS + Xcode)
```

`capacitor.config.ts` at the repo root declares appId `com.aireus.pos`, appName
`Aireus POS`, webDir `dist` (matching the `com.aireus.pos` package in
`android/TcpPrintPlugin.java`). `android/` is generated and already has the
plugin registered, landscape + keep-screen-on in the manifest, and the release
signing config.

## Installing the TcpPrint plugin

Capacitor discovers plugins compiled into the app.

**Android** — copy `android/TcpPrintPlugin.java` and `android/MainActivity.java` from
this folder into `android/app/src/main/java/com/aireus/pos/` (the generated
`android/` tree is gitignored, so these two files are the tracked source of
truth). `MainActivity` registers the plugin and hides the Android status bar and
navigation bar / taskbar (immersive sticky: an edge swipe peeks them, they re-hide).
For a true kiosk lockdown use Android's App pinning on the tablet as well.

**iOS** — add `ios/TcpPrintPlugin.swift` and `ios/TcpPrintPlugin.m` to the App
target in Xcode (they self-register via the CAP_PLUGIN macro).

## Installing the AppUpdate plugin (Android only)

Copy `android/AppUpdatePlugin.java` next to the TcpPrint one (MainActivity
registers both) and add to `android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
```

The login keypad then shows the installed build (`v1.3`) and, when the
enterprise server's `UpdateKit/pos-version.json` carries a higher
`versionCode`, an **Update to x.y** button. Tapping it asks for a manager on the
keypad (ID then PIN of an employee with a Mgr_Menu job; "Manager required"
otherwise): the APK downloads to the app's cache
and the Android package installer takes over (same keystore → installs over the
running build, settings kept). First time, Android asks to allow installs from
Aireus POS; tap Update again afterwards. Not possible on iOS (Apple) — the
plugin is absent there and the button never renders.

`pos-version.json` (served from the same Tomcat `UpdateKit` folder as the APKs):

```json
{ "versionCode": 5, "versionName": "1.4", "url": "aireus-pos.apk" }
```

## Plugin contract

`AppUpdate.getVersion() → { versionCode, versionName }` ·
`canInstall() → { ok }` · `requestInstallPermission()` ·
`install({ url }) → { ok }` (emits `progress { pct }`).



`TcpPrint.send({ ip: string, port: number, dataB64: string }) → { ok: boolean }`

`dataB64` is the ESC/POS job (CP1252 bytes) base64-encoded. One connect → write →
close with a 5s timeout; JS handles backup-IP failover and the print queue.

## Every release

The Capacitor 8 CLI needs Node ≥ 22 (`nvm use 22`) and the Android build needs
Java 21 (`brew install openjdk@21`). The release keystore lives in
`../android-signing/aireus-pos.keystore` and `android/app/build.gradle` signs
with it automatically.

```bash
nvm use 22
npm run build && npx cap sync android
cd android && JAVA_HOME=/usr/local/opt/openjdk@21 ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk (signed)
# copy to ../apk-upload/aireus-pos.apk, bump the size/version on its index.html AND
# versionCode/versionName in ../apk-upload/pos-version.json (the in-app Update button reads it)
npx cap open ios       # build in Xcode, distribute in-house
```

## Stripe Terminal SDK (StripeTerminalPlugin)

`native/android/StripeTerminalPlugin.java` puts the Stripe Terminal Android SDK
(`com.stripe:stripeterminal-core` + `stripeterminal-appsondevices`, 6.0.0, in
`android/app/build.gradle`; minSdk 26 in `variables.gradle`) behind a Capacitor
plugin for both flavours. `MainApplication.java` (manifest `android:name`) gives
the SDK its lifecycle hook; `ACCESS_FINE_LOCATION` is in the manifest because the
SDK refuses payments until it can locate the device (granted at install on the
S710, requested once on a tablet). The JS driver is `src/payments/stripeSdk.ts`
over the seam in `src/platform/stripeterminal.ts`; the Manager Console switch
"Stripe cards: Terminal SDK / REST" (`src/payments/transport.ts`) picks it, and a
web build is always REST. Connection tokens are minted by the app with the
back-office secret key; no payment service. On the S710 the plugin connects in
handoff mode (the app and the reader are one device); on a tablet it finds the
terminal's reader over the LAN by its `tmr_` id; in test mode with no real reader
it uses the SDK's simulated reader (the amount's cents pick the card, as with REST).

## xmini (posx mini on the Stripe S710)

The same Android project builds two products as Gradle flavours in
`android/app/build.gradle`: `pos` (the tablet POS: `com.aireus.pos`, landscape,
in-app Update pill) and `mini` (`com.aireus.xmini`, orientation left to the
device — S710 portrait, T600 landscape — its own `versionCode`/`versionName` in
the flavour block, kept equal to `package.json` `miniVersion`). Neither flavour
forces a layout: the screen width decides (`src/platform/layout.ts`, 760px or
narrower = mini), and the Manager Console "Layout" row can force mini on a wide
screen for testing. `android/app/src/mini/` holds the mini-only app name and a
manifest that removes `REQUEST_INSTALL_PACKAGES`, which is not on Stripe's Apps
on Devices permission allowlist; the reader updates apps through the Stripe
Dashboard, and `canSelfUpdate()` is off in the mini bundle.

```bash
npm run build:mini                                  # Node 18 → dist-mini/ (mini layout baked in, miniVersion)
nvm use 22 && POS_MINI=1 npx cap sync android       # copies dist-mini into the shared assets folder
cd android && JAVA_HOME=/usr/local/opt/openjdk@21 ./gradlew assembleMiniRelease
# → android/app/build/outputs/apk/mini/release/app-mini-release.apk (signed with the same keystore)
```

`cap sync` copies whichever bundle the config names into the one shared assets
folder, so sync the matching bundle before each flavour's `assemble…Release`
(plain `npx cap sync android` + `assemblePosRelease` for the tablet APK) and
check the APK's `assets/public/index.html` hash against the dist folder before
handing it on. The xmini APK goes to Stripe (Dashboard → Terminal → Software →
Create app, package `com.aireus.xmini`, device type Stripe Reader S700/S710),
then a deploy group that holds the reader's location; it is never put on UpdateKit.
