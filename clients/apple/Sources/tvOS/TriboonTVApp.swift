import SwiftUI
import TriboonCore

@main
struct TriboonTVApp: App {
    @StateObject private var appState = TVAppState()

    var body: some Scene {
        WindowGroup {
            ZStack {
                TVTheme.background

                if appState.serverOrigin == nil {
                    TVConnectView(appState: appState)
                } else if appState.token == nil {
                    TVLoginView(appState: appState)
                } else {
                    TVHomeView(appState: appState)
                }
            }
            .fullScreenCover(item: $appState.activePlayback, onDismiss: {
                appState.stopPlayback()
            }) { request in
                TVPlayerView(appState: appState, request: request)
                    .ignoresSafeArea()
            }
            .overlay(alignment: .top) {
                if let banner = appState.errorBanner {
                    HStack(spacing: 16) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(TVTheme.amber)
                        Text(banner)
                            .font(.callout)
                            .foregroundStyle(.white)
                        Button("Dismiss") { appState.errorBanner = nil }
                    }
                    .padding(.horizontal, 28)
                    .padding(.vertical, 16)
                    .background(TVTheme.surface.opacity(0.95), in: Capsule())
                    .padding(.top, 36)
                }
            }
        }
    }
}
