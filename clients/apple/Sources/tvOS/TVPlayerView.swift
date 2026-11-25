import AVKit
import SwiftUI
import TriboonCore

struct TVPlayerView: View {
    @ObservedObject var appState: TVAppState
    let request: TriboonPlaybackRequest

    var body: some View {
        TVAVPlayerRepresentable(player: appState.playback.player)
            .ignoresSafeArea()
            .onExitCommand {
                appState.stopPlayback()
            }
            .onDisappear {
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
