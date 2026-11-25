import Foundation

public enum TriboonAPIError: Error, LocalizedError, Sendable {
    case invalidURL
    case notTriboonServer
    case unauthorized
    case serverError(Int, String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid server URL."
        case .notTriboonServer: return "This address did not respond as a Triboon server."
        case .unauthorized: return "Session expired. Please sign in again."
        case .serverError(_, let message): return message.isEmpty ? "Server request failed." : message
        }
    }
}

/// Async/await REST client for Triboon's `/api/*` endpoints (shared by iOS Connect validation and the native tvOS app).
public final class TriboonAPIClient: Sendable {
    public let baseOrigin: String
    public let token: String?
    private let session: URLSession

    public init(baseOrigin: String, token: String? = nil, session: URLSession = .shared) {
        self.baseOrigin = baseOrigin
        self.token = token
        self.session = session
    }

    public func withToken(_ token: String?) -> TriboonAPIClient {
        TriboonAPIClient(baseOrigin: baseOrigin, token: token, session: session)
    }

    // MARK: - Server & Auth

    public func verifyServer() async throws -> TriboonServerInfo {
        let info: TriboonServerInfo = try await request("GET", "/api/server", authenticated: false)
        guard info.isValidTriboon else { throw TriboonAPIError.notTriboonServer }
        return info
    }

    public func login(name: String, password: String) async throws -> LoginResponse {
        try await request("POST", "/api/login", body: ["name": name, "password": password], authenticated: false)
    }

    public func login2FA(challenge: String, code: String) async throws -> LoginResponse {
        try await request("POST", "/api/login/2fa", body: ["challenge": challenge, "code": code], authenticated: false)
    }

    public func createQuickConnect(deviceName: String) async throws -> QuickConnectCreateResponse {
        try await request("POST", "/api/quickconnect", body: ["deviceName": deviceName], authenticated: false)
    }

    public func pollQuickConnect(code: String) async throws -> QuickConnectPollResponse {
        let clean = code.filter(\.isNumber)
        return try await request("GET", "/api/quickconnect/\(clean)", authenticated: false)
    }

    public func fetchMe() async throws -> TriboonUser {
        try await request("GET", "/api/me")
    }

    // MARK: - Catalog & Search

    public func fetchTMDB(_ path: String) async throws -> TMDBPage {
        let clean = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return try await request("GET", "/api/tmdb/\(clean)")
    }

    public func fetchTMDBDetail(mediaType: String, tmdbId: Int) async throws -> TMDBTitle {
        let kind = mediaType == "tv" ? "tv" : "movie"
        return try await request("GET", "/api/tmdb/\(kind)/\(tmdbId)?append_to_response=credits")
    }

    public func fetchTMDBSeason(tmdbId: Int, season: Int) async throws -> TMDBSeasonDetail {
        try await request("GET", "/api/tmdb/tv/\(tmdbId)/season/\(season)")
    }

    public func searchTMDB(query: String) async throws -> TMDBPage {
        let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        return try await request("GET", "/api/tmdb/search/multi?query=\(encoded)")
    }

    // MARK: - Watch State & Watchlist

    public func fetchWatchRows(profileId: String = "default") async throws -> [WatchRow] {
        let enc = profileId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "default"
        return try await request("GET", "/api/watch?profile=\(enc)")
    }

    public func saveWatch(
        key: String,
        profileId: String = "default",
        position: Double,
        duration: Double,
        watched: Bool = false,
        meta: WatchRowMeta? = nil
    ) async throws {
        var payload: [String: Any] = [
            "key": key,
            "profile": profileId,
            "position": max(0, position),
            "duration": max(0, duration),
            "watched": watched,
        ]
        if let meta, let data = try? JSONEncoder().encode(meta),
           let obj = try? JSONSerialization.jsonObject(with: data) {
            payload["meta"] = obj
        }
        let _: EmptyResponse = try await request("POST", "/api/watch", body: payload)
    }

    // MARK: - Local Libraries

    public func fetchLibraries() async throws -> [LocalLibrary] {
        let res: LocalLibraryListResponse = try await request("GET", "/api/libraries")
        return res.libraries
    }

    public func fetchLibraryItems(libId: String, offset: Int = 0, limit: Int = 60, showIdx: Int? = nil) async throws -> LocalLibraryItemsResponse {
        var path = "/api/libraries/\(libId)/items?offset=\(offset)&limit=\(limit)"
        if let showIdx { path += "&showIdx=\(showIdx)" }
        return try await request("GET", path)
    }

    // MARK: - Playback & Live TV

    public func playCatalog(
        title: String,
        type: String,
        year: Int?,
        tmdbId: Int,
        season: Int? = nil,
        episode: Int? = nil,
        profileId: String = "default",
        resumeFrac: Double = 0
    ) async throws -> PlayResponse {
        var body: [String: Any] = [
            "title": title,
            "type": type,
            "tmdbId": tmdbId,
            "profileId": profileId,
            "caps": [
                "mkv": false,
                "mp4": true,
                "h264": true,
                "hevc": true,
                "aac": true,
                "ac3": true,
                "eac3": true,
                "hls": true,
            ],
        ]
        if let year { body["year"] = year }
        if let season { body["season"] = season }
        if let episode { body["episode"] = episode }
        if resumeFrac > 0 { body["resumeFrac"] = resumeFrac }
        return try await request("POST", "/api/play", body: body, timeout: 60)
    }

    public func playLocal(libId: String, idx: Int, profileId: String = "default") async throws -> PlayResponse {
        let body: [String: Any] = [
            "profileId": profileId,
            "caps": [
                "mkv": false,
                "mp4": true,
                "h264": true,
                "hevc": true,
                "aac": true,
                "ac3": true,
                "eac3": true,
                "hls": true,
            ],
        ]
        return try await request("POST", "/api/local/\(libId)/\(idx)/play", body: body, timeout: 30)
    }

    public func fetchIPTVChannels() async throws -> [IPTVChannel] {
        let res: IPTVChannelsResponse = try await request("GET", "/api/iptv/channels")
        return res.channels
    }

    public func playIPTV(idx: Int, cid: String) async throws -> IPTVPlayResponse {
        let enc = cid.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? cid
        return try await request("GET", "/api/iptv/play/\(idx)?cid=\(enc)")
    }

    // MARK: - Internal Transport

    private struct EmptyResponse: Codable {}

    private func request<T: Decodable>(
        _ method: String,
        _ path: String,
        body: [String: Any]? = nil,
        authenticated: Bool = true,
        timeout: TimeInterval = 15
    ) async throws -> T {
        guard let url = URL(string: "\(baseOrigin)\(path)") else {
            throw TriboonAPIError.invalidURL
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if authenticated, let token, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw TriboonAPIError.serverError(0, "No HTTP response.")
        }
        if http.statusCode == 401 {
            throw TriboonAPIError.unauthorized
        }
        if http.statusCode < 200 || http.statusCode >= 300 {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String ?? "HTTP \(http.statusCode)"
            throw TriboonAPIError.serverError(http.statusCode, msg)
        }
        if T.self == EmptyResponse.self {
            return EmptyResponse() as! T
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
