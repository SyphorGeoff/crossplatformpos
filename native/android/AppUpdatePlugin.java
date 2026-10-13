package com.aireus.pos;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * AppUpdate — in-app APK update (Android only; iOS cannot install from inside an
 * app, so the JS side hides the button there).
 *
 *   getVersion()              → { versionCode, versionName }
 *   canInstall()              → { ok }   Android 8+: "install unknown apps" granted to us?
 *   requestInstallPermission() opens the system page for that permission
 *   install({ url })          downloads the APK to our cache dir and hands it to the
 *                             Android package installer (same signing key → installs
 *                             over the running build, settings kept). Resolves once the
 *                             installer sheet is open; the OS does the rest.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

  @PluginMethod
  public void getVersion(PluginCall call) {
    try {
      PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
      JSObject ret = new JSObject();
      ret.put("versionCode", Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode);
      ret.put("versionName", pi.versionName);
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("version: " + e.getMessage());
    }
  }

  @PluginMethod
  public void canInstall(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("ok", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls());
    call.resolve(ret);
  }

  @PluginMethod
  public void requestInstallPermission(PluginCall call) {
    if (Build.VERSION.SDK_INT >= 26) {
      Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:" + getContext().getPackageName()));
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(i);
    }
    call.resolve();
  }

  @PluginMethod
  public void install(PluginCall call) {
    final String url = call.getString("url", "");
    if (url == null || url.isEmpty()) { call.reject("url required"); return; }
    new Thread(() -> {
      try {
        File dir = new File(getContext().getCacheDir(), "update");
        if (!dir.exists()) dir.mkdirs();
        File apk = new File(dir, "aireus-pos.apk");
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(60000);
        conn.connect();
        if (conn.getResponseCode() / 100 != 2) { call.reject("download failed: HTTP " + conn.getResponseCode()); return; }
        long total = conn.getContentLengthLong();
        long got = 0;
        int lastPct = -1;
        try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
          byte[] buf = new byte[65536];
          int n;
          while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            got += n;
            if (total > 0) {
              int pct = (int) (got * 100 / total);
              if (pct != lastPct) {
                lastPct = pct;
                JSObject ev = new JSObject();
                ev.put("pct", pct);
                notifyListeners("progress", ev);
              }
            }
          }
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getContext().startActivity(i);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject("update failed: " + e.getMessage());
      }
    }).start();
  }
}
