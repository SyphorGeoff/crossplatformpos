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

## Plugin contract

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
# copy to ../apk-upload/aireus-pos.apk and bump the size/version on its index.html
npx cap open ios       # build in Xcode, distribute in-house
```
