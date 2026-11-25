import Foundation

/// Payloads exchanged between Triboon's `web/index.html` and the iOS/iPadOS native player bridge.
public struct BridgeVodPayload: Codable, Sendable {
    public let title: String?
    public let episodeLabel: String?
    public let source: String?
    public let url: String
    public let backdropUrl: String?
    public let start: Double?
    public let startOffset: Double?
    public let kind: String?
    public let mime: String?
    public let duration: Double?
    public let playbackToken: Int?
    public let subtitleUrl: String?
    public let subtitleLabel: String?
    public let remuxUrl: String?
    public let transcodeUrl: String?
}

public struct BridgeLiveFallback: Codable, Sendable {
    public let url: String
    public let mime: String?
}

public struct BridgeLivePayload: Codable, Sendable {
    public let title: String?
    public let source: String?
    public let url: String
    public let mime: String?
    public let fallbackUrl: String?
    public let fallbackMime: String?
    public let fallbacks: [BridgeLiveFallback]?
    public let guide: Bool?

    public func candidateURLs(baseOrigin: String) -> [URL] {
        var result: [URL] = []
        func add(_ raw: String?) {
            guard let url = TriboonServerURL.sanitizeMediaURL(raw, baseOrigin: baseOrigin, requireSameOrigin: false) else { return }
            if !result.contains(url) { result.append(url) }
        }
        // Prefer Apple HLS entries first if provided in fallbacks
        for fb in fallbacks ?? [] {
            let mime = (fb.mime ?? "").lowercased()
            if mime.contains("mpegurl") || fb.url.lowercased().contains(".m3u8") {
                add(fb.url)
            }
        }
        add(url)
        add(fallbackUrl)
        for fb in fallbacks ?? [] {
            add(fb.url)
        }
        return result
    }
}

public struct BridgeControlMessage: Codable, Sendable {
    public let command: String
    public let payload: String?
}
