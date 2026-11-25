import AVFoundation
import Foundation

/// Describes the active native playback request (VOD or Live TV) across both iOS/iPadOS and tvOS.
public struct TriboonPlaybackRequest: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public let title: String
    public let subtitle: String
    public let candidateURLs: [URL]
    public let startSeconds: Double
    public let startOffset: Double
    public let expectedDuration: Double
    public let isLive: Bool
    public let playbackToken: Int
    public let watchKey: String?
    public let watchMeta: WatchRowMeta?

    public init(
        title: String,
        subtitle: String = "",
        candidateURLs: [URL],
        startSeconds: Double = 0,
        startOffset: Double = 0,
        expectedDuration: Double = 0,
        isLive: Bool = false,
        playbackToken: Int = 0,
        watchKey: String? = nil,
        watchMeta: WatchRowMeta? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.candidateURLs = candidateURLs
        self.startSeconds = max(0, startSeconds)
        self.startOffset = max(0, startOffset)
        self.expectedDuration = max(0, expectedDuration)
        self.isLive = isLive
        self.playbackToken = playbackToken
        self.watchKey = watchKey
        self.watchMeta = watchMeta
    }
}

/// Pluggable player engine identifier so VLCKit Direct Play can be enabled alongside Apple's AVPlayer.
public enum ApplePlayerEngineKind: String, Sendable {
    case avplayer
    case vlckit
}

/// Shared AVPlayer session manager with automatic candidate fallback, AirPlay, resume seeking, and progress callbacks.
@MainActor
public final class TriboonPlaybackCoordinator: ObservableObject {
    public let player = AVPlayer()
    @Published public private(set) var currentRequest: TriboonPlaybackRequest?
    @Published public private(set) var isPlaying = false
    @Published public private(set) var lastError: String?

    private var candidateIndex = 0
    private var statusObserver: NSKeyValueObservation?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var didInitialSeek = false
    private var didReportReady = false

    public var onReady: ((Double, Double, Int) -> Void)?
    public var onProgress: ((Double, Double, Int) -> Void)?
    public var onEnded: ((Double, Double, Int) -> Void)?
    public var onError: ((String, Double, Double, Int) -> Void)?

    public init() {
        player.allowsExternalPlayback = true
        #if os(iOS)
        player.usesExternalPlaybackWhileExternalScreenIsActive = true
        #endif
    }

    deinit {
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
        }
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
    }

    public func load(_ request: TriboonPlaybackRequest) {
        stop(notify: false)
        guard !request.candidateURLs.isEmpty else {
            lastError = "No playable stream URL available."
            onError?(lastError ?? "Playback error", request.startOffset, request.expectedDuration, request.playbackToken)
            return
        }
        configureAudioSession()
        currentRequest = request
        candidateIndex = 0
        didInitialSeek = false
        didReportReady = false
        lastError = nil
        startCandidate(at: 0, for: request)
    }

    public func stop(notify: Bool = true) {
        let pos = currentTitleSeconds()
        let dur = currentDurationSeconds()
        let token = currentRequest?.playbackToken ?? 0
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
            self.timeObserver = nil
        }
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
            self.endObserver = nil
        }
        statusObserver?.invalidate()
        statusObserver = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
        isPlaying = false
        if notify && currentRequest != nil {
            onProgress?(pos, dur, token)
        }
        currentRequest = nil
    }

    public func currentTitleSeconds() -> Double {
        let raw = player.currentTime().seconds
        let offset = currentRequest?.startOffset ?? 0
        guard raw.isFinite && raw >= 0 else { return offset }
        return offset + raw
    }

    public func currentDurationSeconds() -> Double {
        let itemDur = player.currentItem?.duration.seconds ?? 0
        if itemDur.isFinite && itemDur > 1 {
            return max(itemDur, currentRequest?.expectedDuration ?? 0)
        }
        return currentRequest?.expectedDuration ?? 0
    }

    public func seek(toTitleSeconds seconds: Double) {
        let offset = currentRequest?.startOffset ?? 0
        let local = max(0, seconds - offset)
        let target = CMTime(seconds: local, preferredTimescale: 600)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero)
    }

    public func seek(by deltaSeconds: Double) {
        seek(toTitleSeconds: currentTitleSeconds() + deltaSeconds)
    }

    public func togglePlayPause() {
        if player.timeControlStatus == .playing {
            player.pause()
            isPlaying = false
        } else {
            player.play()
            isPlaying = true
        }
    }

    private func startCandidate(at index: Int, for request: TriboonPlaybackRequest) {
        guard index < request.candidateURLs.count else {
            let msg = lastError ?? "Unable to play this stream."
            onError?(msg, currentTitleSeconds(), currentDurationSeconds(), request.playbackToken)
            return
        }
        let url = request.candidateURLs[index]
        let item = AVPlayerItem(url: url)
        item.preferredForwardBufferDuration = request.isLive ? 4 : 18

        statusObserver?.invalidate()
        statusObserver = item.observe(\.status, options: [.new]) { [weak self] observed, _ in
            Task { @MainActor [weak self] in
                guard let self, let active = self.currentRequest, active.id == request.id else { return }
                switch observed.status {
                case .readyToPlay:
                    if !self.didInitialSeek && active.startSeconds > 1 && !active.isLive {
                        self.didInitialSeek = true
                        let cm = CMTime(seconds: active.startSeconds, preferredTimescale: 600)
                        self.player.seek(to: cm, toleranceBefore: .zero, toleranceAfter: .zero)
                    }
                    if !self.didReportReady {
                        self.didReportReady = true
                        self.onReady?(self.currentTitleSeconds(), self.currentDurationSeconds(), active.playbackToken)
                    }
                    self.player.play()
                    self.isPlaying = true
                case .failed:
                    let reason = observed.error?.localizedDescription ?? "Stream failed to load"
                    self.lastError = reason
                    let next = self.candidateIndex + 1
                    if next < active.candidateURLs.count {
                        self.candidateIndex = next
                        self.startCandidate(at: next, for: active)
                    } else {
                        self.isPlaying = false
                        self.onError?(reason, self.currentTitleSeconds(), self.currentDurationSeconds(), active.playbackToken)
                    }
                case .unknown:
                    break
                @unknown default:
                    break
                }
            }
        }

        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let active = self.currentRequest, active.id == request.id else { return }
                self.isPlaying = false
                self.onEnded?(self.currentTitleSeconds(), self.currentDurationSeconds(), active.playbackToken)
            }
        }

        if let timeObserver {
            player.removeTimeObserver(timeObserver)
        }
        let interval = CMTime(seconds: 2.0, preferredTimescale: 600)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let active = self.currentRequest, active.id == request.id else { return }
                self.isPlaying = self.player.timeControlStatus == .playing
                self.onProgress?(self.currentTitleSeconds(), self.currentDurationSeconds(), active.playbackToken)
            }
        }

        player.replaceCurrentItem(with: item)
        player.play()
    }

    private func configureAudioSession() {
        #if os(iOS) || os(tvOS)
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback, options: [.allowAirPlay])
            try session.setActive(true)
        } catch {
            // Non-fatal on Simulator where AVAudioSession categories can vary.
        }
        #endif
    }
}
