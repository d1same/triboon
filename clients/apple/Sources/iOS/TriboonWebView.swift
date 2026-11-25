import SwiftUI
import TriboonCore
import WebKit

struct TriboonWebView: UIViewRepresentable {
    @ObservedObject var session: IOSSessionController
    let serverOrigin: String

    func makeCoordinator() -> Coordinator {
        Coordinator(session: session, serverOrigin: serverOrigin)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.allowsAirPlayForMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.applicationNameForUserAgent = "TriboonIOS/\(session.appVersionString)"

        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "triboonBridge")
        if let initScript = makeBridgeInitScript(
            savedOrigin: serverOrigin,
            versionName: session.appVersionString,
            versionCode: session.buildNumberInt
        ) {
            let userScript = WKUserScript(source: initScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            controller.addUserScript(userScript)
        }
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 11 / 255, green: 8 / 255, blue: 18 / 255, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator

        session.evaluateJS = { [weak webView] script in
            DispatchQueue.main.async {
                webView?.evaluateJavaScript(script, completionHandler: nil)
            }
        }

        if let url = URL(string: serverOrigin) {
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    private func makeBridgeInitScript(savedOrigin: String, versionName: String, versionCode: Int) -> String? {
        guard let bridgeURL = Bundle.main.url(forResource: "bridge", withExtension: "js"),
              let bridgeSource = try? String(contentsOf: bridgeURL, encoding: .utf8)
        else {
            return nil
        }
        let isTablet = UIDevice.current.userInterfaceIdiom == .pad
        let bootstrap: [String: Any] = [
            "chromeVersion": 4,
            "playbackCaps": [
                "native": true,
                "deviceClass": isTablet ? "ipad" : "iphone",
                "player": "avplayer",
                "source": "avplayer",
                "mkv": false,
                "mp4": true,
                "h264": true,
                "hevc": true,
                "vp9": false,
                "mpeg2": false,
                "av1": false,
                "dovi": true,
                "aac": true,
                "ac3": true,
                "eac3": true,
                "dts": false,
                "truehd": false,
                "hls": true,
                "airplay": true,
            ],
            "appVersion": [
                "versionName": versionName,
                "versionCode": versionCode,
                "tv": false,
                "tablet": isTablet,
                "platform": "ios",
            ],
        ]
        guard let originJSON = jsonLiteral(savedOrigin),
              let bootstrapData = try? JSONSerialization.data(withJSONObject: bootstrap),
              let bootstrapJSON = String(data: bootstrapData, encoding: .utf8)
        else {
            return nil
        }
        return """
        (function(){
          if (location.origin !== \(originJSON)) return;
          Object.defineProperty(window, '__TRIBOON_APPLE_BOOTSTRAP__', {
            value: Object.freeze(\(bootstrapJSON)),
            configurable: false,
            writable: false
          });
          \(bridgeSource)
        })();
        """
    }

    private func jsonLiteral(_ string: String) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: [string]),
              let raw = String(data: data, encoding: .utf8),
              raw.count >= 2
        else { return nil }
        return String(raw.dropFirst().dropLast())
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        private let session: IOSSessionController
        private let serverOrigin: String

        init(session: IOSSessionController, serverOrigin: String) {
            self.session = session
            self.serverOrigin = serverOrigin
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "triboonBridge" else { return }
            let sec = message.frameInfo.securityOrigin
            let callerOrigin = TriboonServerURL.canonicalOrigin(
                scheme: sec.protocol.lowercased(),
                host: sec.host.lowercased(),
                port: sec.port == 0 ? nil : sec.port
            )
            guard callerOrigin == serverOrigin else { return }
            guard let body = message.body as? [String: Any],
                  let command = body["command"] as? String
            else { return }
            let payloadDict = body["payload"] as? [String: Any] ?? [:]

            Task { @MainActor in
                switch command {
                case "change_server":
                    session.changeServer()
                case "play_vod":
                    if let data = try? JSONSerialization.data(withJSONObject: payloadDict),
                       let vod = try? JSONDecoder().decode(BridgeVodPayload.self, from: data) {
                        session.startVodPlayback(vod)
                    }
                case "play_live":
                    if let data = try? JSONSerialization.data(withJSONObject: payloadDict),
                       let live = try? JSONDecoder().decode(BridgeLivePayload.self, from: data) {
                        session.startLivePlayback(live)
                    }
                case "control":
                    let action = payloadDict["action"] as? String ?? ""
                    let args = payloadDict["payload"] as? [String: Any] ?? [:]
                    session.handleControl(action: action, payload: args)
                default:
                    break
                }
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if navigationAction.targetFrame?.isMainFrame == false {
                decisionHandler(.allow)
                return
            }
            if let pageOrigin = try? TriboonServerURL.origin(fromPageURL: url.absoluteString),
               pageOrigin == serverOrigin {
                decisionHandler(.allow)
                return
            }
            if navigationAction.navigationType == .linkActivated,
               (url.scheme == "http" || url.scheme == "https") {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in
                session.webLoadError = nil
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let ns = error as NSError
            if ns.code == NSURLErrorCancelled { return }
            Task { @MainActor in
                session.webLoadError = error.localizedDescription
            }
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url,
               url.scheme == "http" || url.scheme == "https" {
                UIApplication.shared.open(url)
            }
            return nil
        }
    }
}
