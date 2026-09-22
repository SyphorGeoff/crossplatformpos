import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.aireus.pos",
  appName: "Aireus POS",
  webDir: "dist",
  server: {
    // Native fetches go through the OS stack via CapacitorHttp (no CORS).
    androidScheme: "https",
  },
};

export default config;
