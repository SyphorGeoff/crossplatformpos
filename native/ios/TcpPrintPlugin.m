// Objective-C shim so older Capacitor templates that use the CAP_PLUGIN macro
// registration still find the plugin. With Capacitor 5+ the Swift class's
// CAPBridgedPlugin conformance is sufficient; keeping this file is harmless.
#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(TcpPrintPlugin, "TcpPrint",
  CAP_PLUGIN_METHOD(send, CAPPluginReturnPromise);
)
