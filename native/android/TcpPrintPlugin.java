package com.aireus.pos;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;

/**
 * TcpPrint — raw ESC/POS send to a network printer (JetDirect, port 9100).
 * The JS side (platform/print.ts) handles primary→backup failover; this does one
 * connect → write → close. Mirrors the iPad's PrintManager / ESCPOSCore
 * postTransaction (5s connect timeout, then write CP1252 bytes).
 */
@CapacitorPlugin(name = "TcpPrint")
public class TcpPrintPlugin extends Plugin {

  @PluginMethod
  public void send(PluginCall call) {
    final String ip = call.getString("ip", "");
    final int port = call.getInt("port", 9100);
    final String dataB64 = call.getString("dataB64", "");
    if (ip == null || ip.isEmpty() || dataB64 == null || dataB64.isEmpty()) {
      call.reject("ip and dataB64 required");
      return;
    }
    new Thread(() -> {
      try (Socket sock = new Socket()) {
        sock.connect(new InetSocketAddress(ip, port), 5000);
        sock.setSoTimeout(5000);
        byte[] bytes = Base64.decode(dataB64, Base64.DEFAULT);
        OutputStream out = sock.getOutputStream();
        out.write(bytes);
        out.flush();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject("print failed: " + e.getMessage());
      }
    }).start();
  }
}
