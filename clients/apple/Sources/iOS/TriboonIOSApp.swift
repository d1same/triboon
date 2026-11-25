import SwiftUI
import TriboonCore

@main
struct TriboonIOSApp: App {
    @StateObject private var session = IOSSessionController()

    var body: some Scene {
        WindowGroup {
            Group {
                if let serverOrigin = session.serverOrigin {
                    TriboonShellView(session: session, serverOrigin: serverOrigin)
                } else {
                    ConnectView(session: session)
                }
            }
            .preferredColorScheme(.dark)
        }
    }
}

@MainActor
final class IOSSessionController: ObservableObject {
    private static let savedServerKey = "triboon.savedServerOrigin"

    @Published var serverOrigin: String?
    @Published var activePlayback: TriboonPlaybackRequest?
    @Published var webLoadError: String?
    @Published var reloadToken = UUID()

    let playback = TriboonPlaybackCoordinator()
    var evaluateJS: ((String) -> Void)?

    var appVersionString: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "3.5.13"
    }

    var buildNumberInt: Int {
        Int(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0") ?? 0
    }

    init() {
        if let saved = UserDefaults.standard.string(forKey: Self.savedServerKey),
           let normalized = try? TriboonServerURL.normalizeServer(saved) {
            self.serverOrigin = normalized
        }
        wirePlaybackEvents()
    }

    func connect(to rawInput: String) async throws {
        let normalized = try TriboonServerURL.normalizeServer(rawInput)
        let client = TriboonAPIClient(baseOrigin: normalized)
        _ = try await client.verifyServer()
        UserDefaults.standard.set(normalized, forKey: Self.savedServerKey)
        webLoadError = nil
        serverOrigin = normalized
        reloadToken = UUID()
    }

    func changeServer() {
        closeActivePlayback(ended: false, notifyWeb: false)
        UserDefaults.standard.removeObject(forKey: Self.savedServerKey)
        webLoadError = nil
        serverOrigin = nil
    }

    func startVodPlayback(_ payload: BridgeVodPayload) {
        guard let origin = serverOrigin else { return }
        var urls: [URL] = []
        if let primary = TriboonServerURL.sanitizeMediaURL(payload.url, baseOrigin: origin, requireSameOrigin: true) {
            urls.append(primary)
        }
        if let remux = TriboonServerURL.sanitizeMediaURL(payload.remuxUrl, baseOrigin: origin, requireSameOrigin: true),
           !urls.contains(remux) {
            urls.append(remux)
        }
        if let transcode = TriboonServerURL.sanitizeMediaURL(payload.transcodeUrl, baseOrigin: origin, requireSameOrigin: true),
           !urls.contains(transcode) {
            urls.append(transcode)
        }
        guard !urls.isEmpty else {
            emitPlayerEvent([
                "type": "error",
                "message": "Video URL is invalid",
                "position": payload.startOffset ?? payload.start ?? 0,
                "duration": payload.duration ?? 0,
                "playbackToken": payload.playbackToken ?? 0,
            ])
            return
        }
        let req = TriboonPlaybackRequest(
            title: payload.title ?? "Triboon",
            subtitle: payload.episodeLabel ?? payload.source ?? "",
            candidateURLs: urls,
            startSeconds: payload.start ?? 0,
            startOffset: payload.startOffset ?? 0,
            expectedDuration: payload.duration ?? 0,
            isLive: false,
            playbackToken: payload.playbackToken ?? 0
        )
        activePlayback = req
        playback.load(req)
    }

    func startLivePlayback(_ payload: BridgeLivePayload) {
        guard let origin = serverOrigin else { return }
        let urls = payload.candidateURLs(baseOrigin: origin)
        guard !urls.isEmpty else {
            emitPlayerEvent(["type": "live_error", "message": "Live TV URL is invalid"])
            return
        }
        let req = TriboonPlaybackRequest(
            title: payload.title ?? "Live TV",
            subtitle: payload.source ?? "",
            candidateURLs: urls,
            isLive: true
        )
        activePlayback = req
        playback.load(req)
    }

    func closeActivePlayback(ended: Bool = false, notifyWeb: Bool = true) {
        let wasRequest = activePlayback
        let pos = playback.currentTitleSeconds()
        let dur = playback.currentDurationSeconds()
        playback.stop(notify: false)
        activePlayback = nil
        guard notifyWeb, let req = wasRequest else { return }
        if req.isLive {
            emitPlayerEvent(["type": "live_closed"])
        } else {
            emitPlayerEvent([
                "type": "closed",
                "position": pos,
                "duration": dur,
                "ended": ended,
                "playbackToken": req.playbackToken,
            ])
        }
    }

    func handleControl(action: String, payload: [String: Any]) {
        switch action {
        case "close":
            closeActivePlayback(ended: false, notifyWeb: true)
        case "play":
            playback.player.play()
        case "pause":
            playback.player.pause()
        case "toggle":
            playback.togglePlayPause()
        case "seek_absolute":
            if let sec = payload["seconds"] as? Double {
                playback.seek(toTitleSeconds: sec)
            }
        case "seek_relative":
            if let sec = payload["seconds"] as? Double {
                playback.seek(by: sec)
            }
        default:
            break
        }
    }

    private func wirePlaybackEvents() {
        playback.onReady = { [weak self] pos, dur, token in
            guard let self, let req = self.activePlayback else { return }
            if req.isLive {
                self.emitPlayerEvent(["type": "live_ready"])
            } else {
                self.emitPlayerEvent(["type": "ready", "position": pos, "duration": dur, "playbackToken": token])
                self.emitPlayerEvent(["type": "playing", "position": pos, "duration": dur, "playbackToken": token])
            }
        }
        playback.onProgress = { [weak self] pos, dur, token in
            guard let self, let req = self.activePlayback, !req.isLive else { return }
            self.emitPlayerEvent(["type": "progress", "position": pos, "duration": dur, "playbackToken": token])
        }
        playback.onEnded = { [weak self] pos, dur, token in
            guard let self, let req = self.activePlayback else { return }
            if req.isLive {
                self.closeActivePlayback(ended: false, notifyWeb: true)
            } else {
                self.emitPlayerEvent(["type": "ended", "position": pos, "duration": dur, "playbackToken": token])
                self.closeActivePlayback(ended: true, notifyWeb: true)
            }
        }
        playback.onError = { [weak self] msg, pos, dur, token in
            guard let self, let req = self.activePlayback else { return }
            if req.isLive {
                self.emitPlayerEvent(["type": "live_error", "message": msg])
            } else {
                self.emitPlayerEvent(["type": "error", "message": msg, "position": pos, "duration": dur, "playbackToken": token])
            }
            self.activePlayback = nil
            self.playback.stop(notify: false)
        }
    }

    func emitPlayerEvent(_ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event),
              let json = String(data: data, encoding: .utf8)
        else { return }
        evaluateJS?("window.__triboonApplePlayerEvent && window.__triboonApplePlayerEvent(\(json));")
    }
}

struct TriboonShellView: View {
    @ObservedObject var session: IOSSessionController
    let serverOrigin: String

    var body: some View {
        ZStack {
            Color(red: 11 / 255, green: 8 / 255, blue: 18 / 255)
                .ignoresSafeArea()

            TriboonWebView(session: session, serverOrigin: serverOrigin)
                .id(session.reloadToken)
                .ignoresSafeArea(.container, edges: .bottom)

            if let errorText = session.webLoadError {
                VStack(spacing: 16) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 40))
                        .foregroundStyle(Color(red: 251 / 255, green: 139 / 255, blue: 60 / 255))
                    Text("Could not reach your Triboon server")
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text(errorText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                    HStack(spacing: 12) {
                        Button("Retry") {
                            session.webLoadError = nil
                            session.reloadToken = UUID()
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color(red: 193 / 255, green: 59 / 255, blue: 214 / 255))

                        Button("Change Server") {
                            session.changeServer()
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .padding(28)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
                .padding(24)
            }
        }
        .fullScreenCover(item: $session.activePlayback, onDismiss: {
            session.closeActivePlayback(ended: false, notifyWeb: true)
        }) { request in
            ApplePlayerView(session: session, request: request)
                .ignoresSafeArea()
        }
    }
}
