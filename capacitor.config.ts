import type { CapacitorConfig } from "@capacitor/cli";

// POS_MINI=1 (same switch as `npm run build:mini`) syncs the xmini bundle instead:
//   POS_MINI=1 npx cap sync android && (cd android && ./gradlew assembleMiniRelease)
// The Android project carries both as Gradle product flavours (pos / mini) — see native/README.md.
const MINI = process.env.POS_MINI === "1";

const config: CapacitorConfig = {
  appId: MINI ? "com.aireus.xmini" : "com.aireus.pos",
  appName: MINI ? "Aireus xmini" : "Aireus POS",
  webDir: MINI ? "dist-mini" : "dist",
  server: {
    // Native fetches go through the OS stack via CapacitorHttp (no CORS).
    androidScheme: "https",
  },
};

export default config;
