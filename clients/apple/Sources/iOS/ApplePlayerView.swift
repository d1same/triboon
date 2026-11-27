import AVKit
import SwiftUI
import TriboonCore

struct ApplePlayerView: View {
    @ObservedObject var session: IOSSessionController
    let request: TriboonPlaybackRequest

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            AVPlayerControllerRepresentable(player: session.playback.player) {
                session.closeActivePlayback(ended: false, notifyWeb: true)
            }
            .ignoresSafeArea()

            if request.isLive {
                HStack(spacing: 10) {
                    Button(action: { session.zapLive(-1) }) {
                        Image(systemName: "backward.end.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(width: 36, height: 36)
                    }
                    .accessibilityLabel("Previous channel")

                    Button(action: { session.toggleLiveFavorite() }) {
                        Image(systemName: session.liveFavorite ? "star.fill" : "star")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(session.liveFavorite ? Color.yellow : Color.white)
                            .frame(width: 36, height: 36)
                    }
                    .accessibilityLabel("Favorite channel")

                    Button(action: { session.zapLive(1) }) {
                        Image(systemName: "forward.end.fill")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(width: 36, height: 36)
                    }
                    .accessibilityLabel("Next channel")
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.ultraThinMaterial, in: Capsule())
                .padding(.top, 14)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, 18)
            }

            if let toast = session.playerToastText {
                Text(toast)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 9)
                    .background(Color.black.opacity(0.82), in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.18), lineWidth: 1))
                    .padding(.top, 60)
                    .transition(.opacity)
            }
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
