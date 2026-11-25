import Foundation

public struct TriboonProfile: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let avatar: String?
    public let avatarUrl: String?
    public let pinSet: Bool?
    public let kids: Bool?
    public let maturity: Int?
}

public struct TriboonUser: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let role: String?
    public let profiles: [TriboonProfile]?
    public let iptvAllowed: Bool?
    public let audiobooksAllowed: Bool?
}

public struct LoginResponse: Codable, Sendable {
    public let token: String?
    public let user: TriboonUser?
    public let requiresTwoFactor: Bool?
    public let challenge: String?
    public let error: String?
}

public struct QuickConnectCreateResponse: Codable, Sendable {
    public let code: String
    public let expiresIn: Int?
}

public struct QuickConnectPollResponse: Codable, Sendable {
    public let status: String
    public let token: String?
    public let user: TriboonUser?
}

public struct TMDBPage: Codable, Sendable {
    public let page: Int?
    public let results: [TMDBTitle]
    public let totalResults: Int?

    enum CodingKeys: String, CodingKey {
        case page, results
        case totalResults = "total_results"
    }
}

public struct TMDBTitle: Codable, Identifiable, Hashable, Sendable {
    public let id: Int
    public let mediaType: String?
    public let title: String?
    public let name: String?
    public let overview: String?
    public let posterPath: String?
    public let backdropPath: String?
    public let releaseDate: String?
    public let firstAirDate: String?
    public let voteAverage: Double?
    public let runtime: Int?
    public let numberOfSeasons: Int?
    public let seasons: [TMDBSeasonSummary]?

    public init(
        id: Int,
        mediaType: String? = nil,
        title: String? = nil,
        name: String? = nil,
        overview: String? = nil,
        posterPath: String? = nil,
        backdropPath: String? = nil,
        releaseDate: String? = nil,
        firstAirDate: String? = nil,
        voteAverage: Double? = nil,
        runtime: Int? = nil,
        numberOfSeasons: Int? = nil,
        seasons: [TMDBSeasonSummary]? = nil
    ) {
        self.id = id
        self.mediaType = mediaType
        self.title = title
        self.name = name
        self.overview = overview
        self.posterPath = posterPath
        self.backdropPath = backdropPath
        self.releaseDate = releaseDate
        self.firstAirDate = firstAirDate
        self.voteAverage = voteAverage
        self.runtime = runtime
        self.numberOfSeasons = numberOfSeasons
        self.seasons = seasons
    }

    enum CodingKeys: String, CodingKey {
        case id, title, name, overview, runtime, seasons
        case mediaType = "media_type"
        case posterPath = "poster_path"
        case backdropPath = "backdrop_path"
        case releaseDate = "release_date"
        case firstAirDate = "first_air_date"
        case voteAverage = "vote_average"
        case numberOfSeasons = "number_of_seasons"
    }

    public var displayTitle: String {
        if let title, !title.isEmpty { return title }
        if let name, !name.isEmpty { return name }
        return "Untitled"
    }

    public var year: Int? {
        let raw = releaseDate ?? firstAirDate ?? ""
        guard raw.count >= 4 else { return nil }
        return Int(raw.prefix(4))
    }

    public var isTV: Bool {
        if let mediaType { return mediaType == "tv" }
        return name != nil && title == nil
    }

    public var watchKey: String {
        isTV ? "tmdb:tv:\(id)" : "tmdb:movie:\(id)"
    }

    public func posterURL(size: String = "w500") -> URL? {
        guard let posterPath, !posterPath.isEmpty else { return nil }
        return URL(string: "https://image.tmdb.org/t/p/\(size)\(posterPath)")
    }

    public func backdropURL(size: String = "w1280") -> URL? {
        guard let backdropPath, !backdropPath.isEmpty else { return nil }
        return URL(string: "https://image.tmdb.org/t/p/\(size)\(backdropPath)")
    }
}

public struct TMDBSeasonSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: Int?
    public let seasonNumber: Int
    public let name: String?
    public let episodeCount: Int?
    public let posterPath: String?

    enum CodingKeys: String, CodingKey {
        case id, name
        case seasonNumber = "season_number"
        case episodeCount = "episode_count"
        case posterPath = "poster_path"
    }

    public var displayName: String {
        if let name, !name.isEmpty { return name }
        return "Season \(seasonNumber)"
    }
}

public struct TMDBSeasonDetail: Codable, Sendable {
    public let seasonNumber: Int?
    public let name: String?
    public let episodes: [TMDBEpisode]

    enum CodingKeys: String, CodingKey {
        case name, episodes
        case seasonNumber = "season_number"
    }
}

public struct TMDBEpisode: Codable, Identifiable, Hashable, Sendable {
    public let id: Int?
    public let episodeNumber: Int
    public let seasonNumber: Int?
    public let name: String?
    public let overview: String?
    public let stillPath: String?
    public let runtime: Int?
    public let airDate: String?

    public init(
        id: Int? = nil,
        episodeNumber: Int,
        seasonNumber: Int? = nil,
        name: String? = nil,
        overview: String? = nil,
        stillPath: String? = nil,
        runtime: Int? = nil,
        airDate: String? = nil
    ) {
        self.id = id
        self.episodeNumber = episodeNumber
        self.seasonNumber = seasonNumber
        self.name = name
        self.overview = overview
        self.stillPath = stillPath
        self.runtime = runtime
        self.airDate = airDate
    }

    enum CodingKeys: String, CodingKey {
        case id, name, overview, runtime
        case episodeNumber = "episode_number"
        case seasonNumber = "season_number"
        case stillPath = "still_path"
        case airDate = "air_date"
    }

    public var displayName: String {
        if let name, !name.isEmpty { return name }
        return "Episode \(episodeNumber)"
    }

    public func stillURL(size: String = "w500") -> URL? {
        guard let stillPath, !stillPath.isEmpty else { return nil }
        return URL(string: "https://image.tmdb.org/t/p/\(size)\(stillPath)")
    }
}

public struct WatchRowMeta: Codable, Hashable, Sendable {
    public let title: String?
    public let episodeTitle: String?
    public let type: String?
    public let tmdbId: Int?
    public let year: Int?
    public let season: Int?
    public let episode: Int?
    public let poster: String?
    public let backdrop: String?
    public let libId: String?
    public let idx: Int?

    public init(
        title: String? = nil,
        episodeTitle: String? = nil,
        type: String? = nil,
        tmdbId: Int? = nil,
        year: Int? = nil,
        season: Int? = nil,
        episode: Int? = nil,
        poster: String? = nil,
        backdrop: String? = nil,
        libId: String? = nil,
        idx: Int? = nil
    ) {
        self.title = title
        self.episodeTitle = episodeTitle
        self.type = type
        self.tmdbId = tmdbId
        self.year = year
        self.season = season
        self.episode = episode
        self.poster = poster
        self.backdrop = backdrop
        self.libId = libId
        self.idx = idx
    }
}

public struct WatchRow: Codable, Identifiable, Hashable, Sendable {
    public let key: String
    public let position: Double
    public let duration: Double
    public let watched: Bool?
    public let updatedAt: Double?
    public let meta: WatchRowMeta?

    public var id: String { key }

    public var progress: Double {
        guard duration > 1 else { return 0 }
        return min(1, max(0, position / duration))
    }

    public var isResumable: Bool {
        watched != true && position >= 15 && (duration <= 0 || progress < 0.94)
    }
}

public struct LocalLibrary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let kind: String?
    public let count: Int?
}

public struct LocalLibraryListResponse: Codable, Sendable {
    public let libraries: [LocalLibrary]
}

public struct LocalItem: Codable, Identifiable, Hashable, Sendable {
    public let idx: Int
    public let showIdx: Int?
    public let kind: String?
    public let title: String
    public let epTitle: String?
    public let year: Int?
    public let s: Int?
    public let e: Int?
    public let runtime: Double?
    public let overview: String?
    public let poster: String?
    public let backdrop: String?
    public let artUrl: String?
    public let thumbUrl: String?
    public let tmdbId: Int?
    public let episodeCount: Int?

    public init(
        idx: Int,
        showIdx: Int? = nil,
        kind: String? = nil,
        title: String,
        epTitle: String? = nil,
        year: Int? = nil,
        s: Int? = nil,
        e: Int? = nil,
        runtime: Double? = nil,
        overview: String? = nil,
        poster: String? = nil,
        backdrop: String? = nil,
        artUrl: String? = nil,
        thumbUrl: String? = nil,
        tmdbId: Int? = nil,
        episodeCount: Int? = nil
    ) {
        self.idx = idx
        self.showIdx = showIdx
        self.kind = kind
        self.title = title
        self.epTitle = epTitle
        self.year = year
        self.s = s
        self.e = e
        self.runtime = runtime
        self.overview = overview
        self.poster = poster
        self.backdrop = backdrop
        self.artUrl = artUrl
        self.thumbUrl = thumbUrl
        self.tmdbId = tmdbId
        self.episodeCount = episodeCount
    }

    public var id: String { "\(idx)-\(title)" }

    public var isShow: Bool { kind == "show" }
    public var isEpisode: Bool { kind == "episode" }
}

public struct LocalLibraryItemsResponse: Codable, Sendable {
    public let items: [LocalItem]
    public let total: Int?
}

public struct PlayResponse: Codable, Sendable {
    public let id: String?
    public let name: String?
    public let streamUrl: String?
    public let hlsUrl: String?
    public let remuxUrl: String?
    public let transcodeUrl: String?
    public let size: Int64?
    public let duration: Double?
    public let error: String?

    /// Picks the best AVPlayer-compatible URL on Apple platforms:
    /// prefers native HLS for MKV/remux streams and direct MP4/M4V/MOV when streamable directly.
    public func preferredAppleURL(baseOrigin: String, preferHLS: Bool = true, startSeconds: Double = 0) -> URL? {
        let lowerName = (name ?? "").lowercased()
        let directContainerOK = lowerName.hasSuffix(".mp4") || lowerName.hasSuffix(".m4v") || lowerName.hasSuffix(".mov")

        if !preferHLS && directContainerOK,
           let direct = TriboonServerURL.sanitizeMediaURL(streamUrl, baseOrigin: baseOrigin, requireSameOrigin: true) {
            return direct
        }
        if directContainerOK && startSeconds <= 0,
           let direct = TriboonServerURL.sanitizeMediaURL(streamUrl, baseOrigin: baseOrigin, requireSameOrigin: true) {
            return direct
        }
        if let hlsRaw = hlsUrl {
            let sep = hlsRaw.contains("?") ? "&" : "?"
            let withStart = startSeconds > 1 ? "\(hlsRaw)\(sep)start=\(Int(startSeconds))&audioSafe=1" : "\(hlsRaw)\(sep)audioSafe=1"
            if let hls = TriboonServerURL.sanitizeMediaURL(withStart, baseOrigin: baseOrigin, requireSameOrigin: true) {
                return hls
            }
        }
        if let direct = TriboonServerURL.sanitizeMediaURL(streamUrl, baseOrigin: baseOrigin, requireSameOrigin: true) {
            return direct
        }
        return TriboonServerURL.sanitizeMediaURL(remuxUrl, baseOrigin: baseOrigin, requireSameOrigin: true)
    }
}

public struct IPTVChannel: Codable, Identifiable, Hashable, Sendable {
    public let idx: Int
    public let id: String
    public let name: String
    public let group: String?
    public let logo: String?
    public let fav: Bool?
}

public struct IPTVChannelsResponse: Codable, Sendable {
    public let channels: [IPTVChannel]
}

public struct IPTVPlayResponse: Codable, Sendable {
    public let idx: Int
    public let id: String
    public let name: String
    public let group: String?
    public let streamUrl: String?
    public let nativeUrl: String?
    public let hlsUrl: String?
    public let nativeMime: String?
    public let nativeFallbackUrl: String?

    /// Ordered Apple AVPlayer candidate URLs for Live TV:
    /// native rolling HLS first (works natively on iOS/tvOS + AirPlay), then direct provider HLS, then fallback.
    public func orderedAppleURLs(baseOrigin: String) -> [URL] {
        var urls: [URL] = []
        func append(_ raw: String?) {
            guard let url = TriboonServerURL.sanitizeMediaURL(raw, baseOrigin: baseOrigin, requireSameOrigin: false) else { return }
            if !urls.contains(url) { urls.append(url) }
        }
        append(hlsUrl)
        if let mime = nativeMime?.lowercased(), mime.contains("mpegurl") || mime.contains("m3u8") {
            append(nativeUrl)
        }
        append(nativeFallbackUrl)
        append(nativeUrl)
        append(streamUrl)
        return urls
    }
}
