import AVKit
import SwiftUI
import TriboonCore

struct TVPlayerView: View {
    private enum LiveControl: Hashable {
        case prev, channels, next
    }

    @ObservedObject var appState: TVAppState
    let request: TriboonPlaybackRequest
    @State private var showChannelDrawer = false
    @State private var showLiveBar = false
    @State private var hideTask: Task<Void, Never>?
    @FocusState private var focusedControl: LiveControl?

    private func revealLiveBar() {
        guard request.isLive else { return }
        showLiveBar = true
        hideTask?.cancel()
        hideTask = Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if !Task.isCancelled && !showChannelDrawer {
                await MainActor.run { showLiveBar = false }
            }
        }
    }

    var body: some View {
        ZStack(alignment: .top) {
            TVAVPlayerRepresentable(player: appState.playback.player)
                .ignoresSafeArea()

            if request.isLive && showLiveBar {
                HStack(spacing: 14) {
                    Button("Ch -") {
                        revealLiveBar()
                        appState.zapIPTV(direction: -1)
                    }
                    .focused($focusedControl, equals: .prev)

                    Button("Channels") {
                        hideTask?.cancel()
                        showChannelDrawer = true
                    }
                    .focused($focusedControl, equals: .channels)

                    Button("Ch +") {
                        revealLiveBar()
                        appState.zapIPTV(direction: 1)
                    }
                    .focused($focusedControl, equals: .next)
                }
                .buttonStyle(.bordered)
                .padding(.top, 28)
                .onAppear {
                    if focusedControl == nil { focusedControl = .channels }
                }
            }

            if let toast = appState.liveZapToast {
                Text(toast)
                    .font(.headline)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 12)
                    .background(Color.black.opacity(0.84), in: RoundedRectangle(cornerRadius: 12))
                    .padding(.top, showLiveBar ? 96 : 36)
            }
        }
        .onMoveCommand { direction in
            guard request.isLive && !showChannelDrawer else { return }
            switch direction {
            case .up:
                revealLiveBar()
                appState.zapIPTV(direction: 1)
            case .down:
                revealLiveBar()
                appState.zapIPTV(direction: -1)
            case .left, .right:
                if !showLiveBar { revealLiveBar() }
            @unknown default:
                break
            }
        }
        .sheet(isPresented: $showChannelDrawer) {
            NavigationStack {
                List(appState.iptvChannels.prefix(300)) { channel in
                    Button {
                        showChannelDrawer = false
                        showLiveBar = false
                        Task { await appState.playIPTVChannel(channel) }
                    } label: {
                        HStack {
                            Text(channel.name)
                            Spacer()
                            if let grp = channel.group, !grp.isEmpty {
                                Text(grp).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .navigationTitle("Live TV Channels")
            }
        }
        .onExitCommand {
            if showChannelDrawer {
                showChannelDrawer = false
            } else if showLiveBar {
                showLiveBar = false
            } else {
                appState.stopPlayback()
            }
        }
        .onDisappear {
            hideTask?.cancel()
            if appState.activePlayback?.id == request.id {
                appState.stopPlayback()
            }
        }
    }
}

private struct TVAVPlayerRepresentable: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.showsPlaybackControls = true
        return controller
    }

    func updateUIViewController(_ uiViewController: AVPlayerViewController, context: Context) {
        if uiViewController.player !== player {
            uiViewController.player = player
        }
    }
}
