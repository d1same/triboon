import SwiftUI
import TriboonCore

@MainActor
final class TVAppState: ObservableObject {
    private static let serverKey = "triboon.tv.serverOrigin"
    private static let tokenKey = "triboon.tv.token"
    private static let profileKey = "triboon.tv.profileId"
    private static let skipPickerKey = "triboon.tv.skipProfilePicker"
    private static let coverSizeKey = "triboon.tv.coverSize"
    private static let textSizeKey = "triboon.tv.textSize"

    @Published var serverOrigin: String?
    @Published var token: String?
    @Published var user: TriboonUser?
    @Published var activeProfileId: String = "default"
    @Published var skipProfilePicker: Bool = false
    @Published var coverSize: String = "M"
    @Published var textSize: String = "M"
    @Published var needsProfilePick: Bool = false
    @Published var isLoadingHome = false
    @Published var errorBanner: String?

    private var pickedThisSession = false

    @Published var continueWatching: [WatchRow] = []
    @Published var trendingMovies: [TMDBTitle] = []
    @Published var trendingShows: [TMDBTitle] = []
    @Published var popularMovies: [TMDBTitle] = []
    @Published var popularShows: [TMDBTitle] = []
    @Published var libraries: [LocalLibrary] = []
    @Published var iptvChannels: [IPTVChannel] = []

    @Published var activePlayback: TriboonPlaybackRequest?
    @Published var isStartingPlayback = false
    let playback = TriboonPlaybackCoordinator()

    private var lastSavedAt: Date = .distantPast

    var api: TriboonAPIClient? {
        guard let origin = serverOrigin else { return nil }
        return TriboonAPIClient(baseOrigin: origin, token: token)
    }

    init() {
        if let saved = UserDefaults.standard.string(forKey: Self.serverKey),
           let normalized = try? TriboonServerURL.normalizeServer(saved) {
            self.serverOrigin = normalized
        }
        self.token = UserDefaults.standard.string(forKey: Self.tokenKey)
        self.activeProfileId = UserDefaults.standard.string(forKey: Self.profileKey) ?? "default"
        self.skipProfilePicker = UserDefaults.standard.bool(forKey: Self.skipPickerKey)
        let savedCover = UserDefaults.standard.string(forKey: Self.coverSizeKey) ?? "M"
        self.coverSize = ["S", "M", "L"].contains(savedCover) ? savedCover : "M"
        let savedText = UserDefaults.standard.string(forKey: Self.textSizeKey) ?? "M"
        self.textSize = ["S", "M", "L"].contains(savedText) ? savedText : "M"
        wirePlaybackCallbacks()
        if serverOrigin != nil && token != nil {
            Task { await restoreSession() }
        }
    }

    func connect(to rawInput: String) async throws {
        let normalized = try TriboonServerURL.normalizeServer(rawInput)
        let client = TriboonAPIClient(baseOrigin: normalized)
        _ = try await client.verifyServer()
        UserDefaults.standard.set(normalized, forKey: Self.serverKey)
        serverOrigin = normalized
        errorBanner = nil
    }

    func completeSignIn(token: String, user: TriboonUser?) async {
        UserDefaults.standard.set(token, forKey: Self.tokenKey)
        self.token = token
        pickedThisSession = false
        if let user {
            self.user = user
            if let profiles = user.profiles, profiles.count == 1, let only = profiles.first?.id {
                selectProfile(only)
            }
        }
        await restoreSession()
    }

    func selectProfile(_ id: String) {
        activeProfileId = id
        pickedThisSession = true
        needsProfilePick = false
        UserDefaults.standard.set(id, forKey: Self.profileKey)
        Task { await refreshHome() }
    }

    func setSkipProfilePicker(_ skip: Bool) {
        skipProfilePicker = skip
        UserDefaults.standard.set(skip, forKey: Self.skipPickerKey)
    }

    var posterWidth: CGFloat {
        switch coverSize {
        case "S": return 200
        case "L": return 290
        default: return 240
        }
    }

    var dynamicTypeSize: DynamicTypeSize {
        switch textSize {
        case "S": return .medium
        case "L": return .xLarge
        default: return .large
        }
    }

    func setCoverSize(_ size: String) {
        let v = ["S", "M", "L"].contains(size) ? size : "M"
        coverSize = v
        UserDefaults.standard.set(v, forKey: Self.coverSizeKey)
    }

    func setTextSize(_ size: String) {
        let v = ["S", "M", "L"].contains(size) ? size : "M"
        textSize = v
        UserDefaults.standard.set(v, forKey: Self.textSizeKey)
    }

    func signOut() {
        stopPlayback()
        UserDefaults.standard.removeObject(forKey: Self.tokenKey)
        token = nil
        user = nil
        pickedThisSession = false
        needsProfilePick = false
        continueWatching = []
        libraries = []
        iptvChannels = []
    }

    func changeServer() {
        signOut()
        UserDefaults.standard.removeObject(forKey: Self.serverKey)
        serverOrigin = nil
    }

    func restoreSession() async {
        guard let api else { return }
        do {
            let me = try await api.fetchMe()
            self.user = me
            if let profiles = me.profiles, !profiles.isEmpty {
                if !profiles.contains(where: { $0.id == activeProfileId }) {
                    activeProfileId = profiles[0].id
                    UserDefaults.standard.set(activeProfileId, forKey: Self.profileKey)
                }
                if profiles.count > 1 && !pickedThisSession && !skipProfilePicker {
                    needsProfilePick = true
                    return
                }
            }
            needsProfilePick = false
            await refreshHome()
        } catch TriboonAPIError.unauthorized {
            signOut()
        } catch {
            showError(for: error)
        }
    }

    func refreshHome() async {
        guard let api else { return }
        isLoadingHome = true
        defer { isLoadingHome = false }

        async let watchTask = try? api.fetchWatchRows(profileId: activeProfileId)
        async let tMoviesTask = try? api.fetchTMDB("trending/movie/week")
        async let tShowsTask = try? api.fetchTMDB("trending/tv/week")
        async let pMoviesTask = try? api.fetchTMDB("movie/popular")
        async let pShowsTask = try? api.fetchTMDB("tv/popular")
        async let libsTask = try? api.fetchLibraries()
        async let iptvTask = try? api.fetchIPTVChannels()

        if let rows = await watchTask {
            continueWatching = rows
                .filter(\.isResumable)
                .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
        }
        if let p = await tMoviesTask { trendingMovies = p.results }
        if let p = await tShowsTask { trendingShows = p.results }
        if let p = await pMoviesTask { popularMovies = p.results }
        if let p = await pShowsTask { popularShows = p.results }
        if let libs = await libsTask { libraries = libs }
        if let chans = await iptvTask { iptvChannels = chans }
    }

    func playCatalogMovie(_ item: TMDBTitle, resumeAt: Double = 0) async {
        guard let api, let origin = serverOrigin else { return }
        isStartingPlayback = true
        errorBanner = nil
        defer { isStartingPlayback = false }
        do {
            let resp = try await api.playCatalog(
                title: item.displayTitle,
                type: "movie",
                year: item.year,
                tmdbId: item.id,
                profileId: activeProfileId
            )
            guard let url = resp.preferredAppleURL(baseOrigin: origin, startSeconds: resumeAt) else {
                showError("This title isn't playable right now.")
                return
            }
            let isHLS = url.absoluteString.lowercased().contains(".m3u8")
            let meta = WatchRowMeta(
                title: item.displayTitle,
                type: "movie",
                tmdbId: item.id,
                year: item.year,
                poster: item.posterPath,
                backdrop: item.backdropPath
            )
            let req = TriboonPlaybackRequest(
                title: item.displayTitle,
                subtitle: item.year.map(String.init) ?? "",
                candidateURLs: [url],
                startSeconds: isHLS ? 0 : resumeAt,
                startOffset: isHLS ? resumeAt : 0,
                expectedDuration: resp.duration ?? Double((item.runtime ?? 0) * 60),
                isLive: false,
                watchKey: "tmdb:movie:\(item.id)",
                watchMeta: meta
            )
            activePlayback = req
            playback.load(req)
        } catch {
            showError(for: error)
        }
    }

    func playCatalogEpisode(show: TMDBTitle, season: Int, episode: TMDBEpisode, resumeAt: Double = 0) async {
        guard let api, let origin = serverOrigin else { return }
        isStartingPlayback = true
        errorBanner = nil
        defer { isStartingPlayback = false }
        do {
            let resp = try await api.playCatalog(
                title: show.displayTitle,
                type: "tv",
                year: show.year,
                tmdbId: show.id,
                season: season,
                episode: episode.episodeNumber,
                profileId: activeProfileId
            )
            guard let url = resp.preferredAppleURL(baseOrigin: origin, startSeconds: resumeAt) else {
                showError("This title isn't playable right now.")
                return
            }
            let isHLS = url.absoluteString.lowercased().contains(".m3u8")
            let meta = WatchRowMeta(
                title: show.displayTitle,
                episodeTitle: episode.displayName,
                type: "tv",
                tmdbId: show.id,
                year: show.year,
                season: season,
                episode: episode.episodeNumber,
                poster: show.posterPath,
                backdrop: episode.stillPath ?? show.backdropPath
            )
            let req = TriboonPlaybackRequest(
                title: show.displayTitle,
                subtitle: "S\(season)E\(episode.episodeNumber) · \(episode.displayName)",
                candidateURLs: [url],
                startSeconds: isHLS ? 0 : resumeAt,
                startOffset: isHLS ? resumeAt : 0,
                expectedDuration: resp.duration ?? Double((episode.runtime ?? 0) * 60),
                isLive: false,
                watchKey: "tmdb:tv:\(show.id):s\(season)e\(episode.episodeNumber)",
                watchMeta: meta
            )
            activePlayback = req
            playback.load(req)
        } catch {
            showError(for: error)
        }
    }

    func playLocalItem(libId: String, item: LocalItem, resumeAt: Double = 0) async {
        guard let api, let origin = serverOrigin else { return }
        isStartingPlayback = true
        errorBanner = nil
        defer { isStartingPlayback = false }
        do {
            let resp = try await api.playLocal(libId: libId, idx: item.idx, profileId: activeProfileId)
            guard let url = resp.preferredAppleURL(baseOrigin: origin, startSeconds: resumeAt) else {
                showError("This library file isn't playable right now.")
                return
            }
            let isHLS = url.absoluteString.lowercased().contains(".m3u8")
            let meta = WatchRowMeta(
                title: item.title,
                episodeTitle: item.epTitle,
                type: item.isEpisode ? "tv" : "movie",
                tmdbId: item.tmdbId,
                year: item.year,
                season: item.s,
                episode: item.e,
                libId: libId,
                idx: item.idx
            )
            let req = TriboonPlaybackRequest(
                title: item.title,
                subtitle: item.epTitle ?? "",
                candidateURLs: [url],
                startSeconds: isHLS ? 0 : resumeAt,
                startOffset: isHLS ? resumeAt : 0,
                expectedDuration: resp.duration ?? (item.runtime ?? 0) * 60,
                isLive: false,
                watchKey: "local:\(libId):\(item.idx)",
                watchMeta: meta
            )
            activePlayback = req
            playback.load(req)
        } catch {
            showError(for: error)
        }
    }

    @Published var activeLiveChannelIdx: Int?
    @Published var liveZapToast: String?
    private var liveZapToastTask: Task<Void, Never>?
    private var errorBannerTask: Task<Void, Never>?

    func dismissErrorBanner() {
        errorBannerTask?.cancel()
        errorBannerTask = nil
        errorBanner = nil
    }

    func showError(_ message: String) {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        errorBanner = trimmed.count > 140 ? String(trimmed.prefix(137)) + "…" : trimmed
        errorBannerTask?.cancel()
        errorBannerTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            self?.errorBanner = nil
        }
    }

    func showError(for error: Error) {
        if error is CancellationError { return }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == NSURLErrorDomain {
            showError("Could not reach the server. Check your connection.")
            return
        }
        showError(error.localizedDescription)
    }

    func playIPTVChannel(_ channel: IPTVChannel) async {
        guard let api, let origin = serverOrigin else { return }
        isStartingPlayback = true
        errorBanner = nil
        activeLiveChannelIdx = channel.idx
        defer { isStartingPlayback = false }
        do {
            let resp = try await api.playIPTV(idx: channel.idx, cid: channel.id)
            let urls = resp.orderedAppleURLs(baseOrigin: origin)
            guard !urls.isEmpty else {
                errorBanner = "Live TV stream is unavailable."
                return
            }
            let req = TriboonPlaybackRequest(
                title: channel.name,
                subtitle: channel.group ?? "Live TV",
                candidateURLs: urls,
                isLive: true
            )
            activePlayback = req
            playback.load(req)
        } catch {
            showError(for: error)
        }
    }

    func zapIPTV(direction: Int) {
        let list = iptvChannels
        guard list.count >= 2 else { return }
        let curIndex = list.firstIndex(where: { $0.idx == activeLiveChannelIdx }) ?? 0
        let step = direction >= 0 ? 1 : -1
        let nextIndex = (curIndex + step + list.count) % list.count
        let target = list[nextIndex]
        activeLiveChannelIdx = target.idx
        liveZapToast = "\(nextIndex + 1)/\(list.count) · \(target.name)"
        liveZapToastTask?.cancel()
        liveZapToastTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            guard !Task.isCancelled else { return }
            self?.liveZapToast = nil
        }
        Task { await playIPTVChannel(target) }
    }

    func stopPlayback() {
        let req = activePlayback
        let pos = playback.currentTitleSeconds()
        let dur = playback.currentDurationSeconds()
        playback.stop(notify: false)
        activePlayback = nil
        if let req, !req.isLive, let key = req.watchKey, pos >= 5 {
            saveWatchProgress(key: key, pos: pos, dur: dur, watched: dur > 60 && pos / dur >= 0.92, meta: req.watchMeta)
        }
    }

    private func wirePlaybackCallbacks() {
        playback.onProgress = { [weak self] pos, dur, _ in
            guard let self, let req = self.activePlayback, !req.isLive, let key = req.watchKey else { return }
            if Date().timeIntervalSince(self.lastSavedAt) >= 10, pos >= 5 {
                self.lastSavedAt = Date()
                self.saveWatchProgress(key: key, pos: pos, dur: dur, watched: false, meta: req.watchMeta)
            }
        }
        playback.onEnded = { [weak self] pos, dur, _ in
            guard let self, let req = self.activePlayback else { return }
            if !req.isLive, let key = req.watchKey {
                self.saveWatchProgress(key: key, pos: max(pos, dur), dur: dur, watched: true, meta: req.watchMeta)
            }
            self.activePlayback = nil
            self.playback.stop(notify: false)
        }
        playback.onError = { [weak self] msg, _, _, _ in
            guard let self else { return }
            self.showError(msg.isEmpty ? "Playback could not start — try another source." : msg)
            self.activePlayback = nil
            self.playback.stop(notify: false)
        }
    }

    private func saveWatchProgress(key: String, pos: Double, dur: Double, watched: Bool, meta: WatchRowMeta?) {
        guard let api else { return }
        let profile = activeProfileId
        Task {
            try? await api.saveWatch(key: key, profileId: profile, position: pos, duration: dur, watched: watched, meta: meta)
            await refreshHome()
        }
    }
}
