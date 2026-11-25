import AVKit
import SwiftUI
import TriboonCore

struct ApplePlayerView: View {
    @ObservedObject var session: IOSSessionController
    let request: TriboonPlaybackRequest

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()
            AVPlayerControllerRepresentable(player: session.playback.player) {
                session.closeActivePlayback(ended: false, notifyWeb: true)
            }
            .ignoresSafeArea()
        }
        .statusBarHidden(true)
        .onDisappear {
            if session.activePlayback?.id == request.id {
                session.closeActivePlayback(ended: false, notifyWeb: true)
            }
        }
    }
}

private struct AVPlayerControllerRepresentable: UIViewControllerRepresentable {
    let player: AVPlayer
    let onDismiss: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onDismiss: onDismiss)
    }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.showsPlaybackControls = true
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = true
        controller.entersFullScreenWhenPlaybackBegins = false
        controller.exitsFullScreenWhenPlaybackEnds = false
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: AVPlayerViewController, context: Context) {
        if uiViewController.player !== player {
            uiViewController.player = player
        }
    }

    final class Coordinator: NSObject, AVPlayerViewControllerDelegate {
        let onDismiss: () -> Void

        init(onDismiss: @escaping () -> Void) {
            self.onDismiss = onDismiss
        }

        func playerViewController(
            _ playerViewController: AVPlayerViewController,
            willEndFullScreenPresentationWithAnimationCoordinator coordinator: UIViewControllerTransitionCoordinator
        ) {
            coordinator.animate(alongsideTransition: nil) { ctx in
                if !ctx.isCancelled {
                    self.onDismiss()
                }
            }
        }
    }
}
