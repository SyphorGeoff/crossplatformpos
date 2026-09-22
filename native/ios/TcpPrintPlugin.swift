import Foundation
import Capacitor
import Network

/// TcpPrint — raw ESC/POS send to a network printer (JetDirect, port 9100).
/// One connect → write → close; the JS side handles backup-IP failover.
/// Mirrors the iPad POS's PrintManager / ESCPOSCore postTransaction path.
@objc(TcpPrintPlugin)
public class TcpPrintPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TcpPrintPlugin"
    public let jsName = "TcpPrint"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise)
    ]

    @objc func send(_ call: CAPPluginCall) {
        guard let ip = call.getString("ip"), !ip.isEmpty,
              let dataB64 = call.getString("dataB64"), !dataB64.isEmpty,
              let data = Data(base64Encoded: dataB64) else {
            call.reject("ip and dataB64 required")
            return
        }
        let port = UInt16(call.getInt("port") ?? 9100)
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            call.reject("bad port")
            return
        }
        let conn = NWConnection(host: NWEndpoint.Host(ip), port: nwPort, using: .tcp)
        var finished = false
        let finish: (Bool, String?) -> Void = { ok, msg in
            if finished { return }
            finished = true
            conn.cancel()
            if ok { call.resolve(["ok": true]) } else { call.reject(msg ?? "print failed") }
        }
        conn.stateUpdateHandler = { state in
            switch state {
            case .ready:
                conn.send(content: data, completion: .contentProcessed { err in
                    finish(err == nil, err?.localizedDescription)
                })
            case .failed(let err):
                finish(false, err.localizedDescription)
            default:
                break
            }
        }
        conn.start(queue: .global())
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
            finish(false, "timeout")
        }
    }
}
