import XCTest
@testable import TriboonCore

final class TriboonCoreTests: XCTestCase {
    func testNormalizeServerDefaultsSchemeAndPort() throws {
        XCTAssertEqual(try TriboonServerURL.normalizeServer("192.168.1.20"), "http://192.168.1.20:7777")
        XCTAssertEqual(try TriboonServerURL.normalizeServer("https://stream.example.com"), "https://stream.example.com")
        XCTAssertEqual(try TriboonServerURL.normalizeServer("https://stream.example.com:443"), "https://stream.example.com")
        XCTAssertEqual(try TriboonServerURL.normalizeServer("http://10.0.0.5:80/"), "http://10.0.0.5")
        XCTAssertEqual(try TriboonServerURL.normalizeServer("http://[::1]:7777"), "http://[::1]:7777")
    }

    func testNormalizeServerRejectsUnsafeInputs() {
        XCTAssertThrowsError(try TriboonServerURL.normalizeServer(""))
        XCTAssertThrowsError(try TriboonServerURL.normalizeServer("ftp://example.com"))
        XCTAssertThrowsError(try TriboonServerURL.normalizeServer("http://user:pass@example.com:7777"))
        XCTAssertThrowsError(try TriboonServerURL.normalizeServer("https://example.com/api"))
        XCTAssertThrowsError(try TriboonServerURL.normalizeServer("https://example.com#frag"))
    }

    func testOriginFromPageURLIgnoresHashRoutes() throws {
        XCTAssertEqual(
            try TriboonServerURL.origin(fromPageURL: "https://media.example.com:7777/#/movie/1726"),
            "https://media.example.com:7777"
        )
    }

    func testSanitizeMediaURLEnforcesSameOriginForVOD() {
        let same = TriboonServerURL.sanitizeMediaURL(
            "/api/hls/abc/index.m3u8?t=tok",
            baseOrigin: "https://tv.example.com",
            requireSameOrigin: true
        )
        XCTAssertEqual(same?.absoluteString, "https://tv.example.com/api/hls/abc/index.m3u8?t=tok")

        let foreign = TriboonServerURL.sanitizeMediaURL(
            "https://evil.example.com/video.mp4",
            baseOrigin: "https://tv.example.com",
            requireSameOrigin: true
        )
        XCTAssertNil(foreign, "VOD streams must never cross origins")

        let liveExternal = TriboonServerURL.sanitizeMediaURL(
            "https://cdn.provider.example/live.m3u8",
            baseOrigin: "https://tv.example.com",
            requireSameOrigin: false
        )
        XCTAssertEqual(liveExternal?.absoluteString, "https://cdn.provider.example/live.m3u8")
    }

    func testServerInfoValidation() throws {
        let json = #"{"version":"3.5.12","needsSetup":false,"phase":4}"#.data(using: .utf8)!
        let info = try JSONDecoder().decode(TriboonServerInfo.self, from: json)
        XCTAssertTrue(info.isValidTriboon)

        let bad = TriboonServerInfo(version: "not-semver", needsSetup: false, phase: nil, name: nil)
        XCTAssertFalse(bad.isValidTriboon)
    }

    func testPlayResponsePrefersHLSForMKVAndDirectForMP4() {
        let mkv = PlayResponse(
            id: "m1",
            name: "Movie.2026.1080p.WEB-DL.mkv",
            streamUrl: "/api/stream/m1?t=abc",
            hlsUrl: "/api/hls/m1/index.m3u8?t=abc",
            remuxUrl: "/api/remux/m1?t=abc",
            transcodeUrl: "/api/transcode/m1?t=abc",
            size: 4_000_000_000,
            duration: 7200,
            error: nil
        )
        XCTAssertEqual(
            mkv.preferredAppleURL(baseOrigin: "https://tv.example.com", startSeconds: 120)?.absoluteString,
            "https://tv.example.com/api/hls/m1/index.m3u8?t=abc&start=120&audioSafe=1"
        )

        let mp4 = PlayResponse(
            id: "m2",
            name: "Movie.2026.1080p.mp4",
            streamUrl: "/api/stream/m2?t=abc",
            hlsUrl: "/api/hls/m2/index.m3u8?t=abc",
            remuxUrl: nil,
            transcodeUrl: nil,
            size: 2_000_000_000,
            duration: 5400,
            error: nil
        )
        XCTAssertEqual(
            mp4.preferredAppleURL(baseOrigin: "https://tv.example.com", startSeconds: 0)?.absoluteString,
            "https://tv.example.com/api/stream/m2?t=abc"
        )
    }

    func testIPTVOrderedAppleURLsPrefersHLS() {
        let live = IPTVPlayResponse(
            idx: 3,
            id: "ch-3",
            name: "News HD",
            group: "News",
            streamUrl: "/api/iptv/stream/3?t=1",
            nativeUrl: "/api/iptv/native/3?t=1",
            hlsUrl: "/api/iptv/hls/3/index.m3u8?t=1",
            nativeMime: "application/vnd.apple.mpegurl",
            nativeFallbackUrl: "/api/iptv/native/3?alt=1&t=1"
        )
        let urls = live.orderedAppleURLs(baseOrigin: "https://tv.example.com")
        XCTAssertEqual(urls.first?.absoluteString, "https://tv.example.com/api/iptv/hls/3/index.m3u8?t=1")
        XCTAssertEqual(urls.count, 4)
    }

    func testBridgeLivePayloadPrefersHLSFallback() {
        let payload = BridgeLivePayload(
            title: "Sports",
            source: "Live",
            url: "https://tv.example.com/api/iptv/stream/1?t=a",
            mime: "video/mp4",
            fallbackUrl: nil,
            fallbackMime: nil,
            fallbacks: [
                BridgeLiveFallback(url: "https://tv.example.com/api/iptv/hls/1/index.m3u8?t=a", mime: "application/vnd.apple.mpegurl"),
            ],
            guide: false
        )
        let urls = payload.candidateURLs(baseOrigin: "https://tv.example.com")
        XCTAssertEqual(urls.first?.absoluteString, "https://tv.example.com/api/iptv/hls/1/index.m3u8?t=a")
    }
}
