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
                } else if appState.needsProfilePick {
                    TVProfilePickerView(appState: appState)
                } else {
                    TVHomeView(appState: appState)
                }
            }
            .dynamicTypeSize(appState.dynamicTypeSize)
            .fullScreenCover(item: $appState.activePlayback, onDismiss: {
                appState.stopPlayback()
            }) { request in
                TVPlayerView(appState: appState, request: request)
                    .ignoresSafeArea()
            }
            .overlay(alignment: .bottom) {
                if let banner = appState.errorBanner {
                    HStack(spacing: 14) {
                        Circle()
                            .fill(Color(red: 232 / 255, green: 107 / 255, blue: 116 / 255))
                            .frame(width: 10, height: 10)
                        Text(banner)
                            .font(.callout.weight(.medium))
                            .foregroundStyle(.white)
                            .lineLimit(2)
                        Button("Dismiss") { appState.dismissErrorBanner() }
                    }
                    .padding(.horizontal, 26)
                    .padding(.vertical, 16)
                    .background(Color(red: 20 / 255, green: 22 / 255, blue: 27 / 255).opacity(0.95), in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(red: 232 / 255, green: 107 / 255, blue: 116 / 255).opacity(0.32), lineWidth: 1))
                    .padding(.bottom, 44)
                    .transition(.opacity)
                }
            }
        }
    }
}
