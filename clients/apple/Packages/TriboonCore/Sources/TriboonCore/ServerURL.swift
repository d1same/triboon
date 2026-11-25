import Foundation

public enum ServerURLError: Error, LocalizedError, Equatable, Sendable {
    case empty
    case invalid
    case unsupportedScheme
    case credentialsNotAllowed
    case fragmentNotAllowed
    case pathNotAllowed
    case untrustedOrigin

    public var errorDescription: String? {
        switch self {
        case .empty: return "Enter your Triboon server address."
        case .invalid: return "Server address is invalid."
        case .unsupportedScheme: return "Use an http:// or https:// server address."
        case .credentialsNotAllowed: return "Usernames and passwords in the URL are not allowed."
        case .fragmentNotAllowed: return "URL fragments are not allowed."
        case .pathNotAllowed: return "Enter only the server address without a path or query."
        case .untrustedOrigin: return "Untrusted page origin."
        }
    }
}

/// Strict URL normalization and origin-trust helpers matching Triboon's Windows/Android security model.
public enum TriboonServerURL {
    public static let maxLength = 2048
    public static let defaultPort = 7777

    /// Normalizes a user-entered Triboon server address into a canonical origin (`scheme://host[:port]`).
    /// If no scheme is entered, defaults to `http://` and port `7777`.
    public static func normalizeServer(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ServerURLError.empty }
        guard trimmed.count <= maxLength else { throw ServerURLError.invalid }
        if trimmed.unicodeScalars.contains(where: { $0.value <= 0x20 }) {
            throw ServerURLError.invalid
        }

        let hasScheme = trimmed.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*://"#, options: .regularExpression) != nil
        let candidate = hasScheme ? trimmed : "http://\(trimmed)"

        guard var comps = URLComponents(string: candidate) else {
            throw ServerURLError.invalid
        }
        guard let scheme = comps.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            throw ServerURLError.unsupportedScheme
        }
        if comps.user != nil || comps.password != nil {
            throw ServerURLError.credentialsNotAllowed
        }
        if comps.fragment != nil {
            throw ServerURLError.fragmentNotAllowed
        }
        guard let host = comps.host?.lowercased(), !host.isEmpty else {
            throw ServerURLError.invalid
        }
        let path = comps.path
        if (!path.isEmpty && path != "/") || comps.query != nil {
            throw ServerURLError.pathNotAllowed
        }
        if !hasScheme && comps.port == nil {
            comps.port = defaultPort
        }
        return canonicalOrigin(scheme: scheme, host: host, port: comps.port)
    }

    /// Extracts canonical `scheme://host[:port]` from a full page URL (ignoring hash fragments `#/home`).
    public static func origin(fromPageURL raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= maxLength else { throw ServerURLError.invalid }
        let withoutFragment = trimmed.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? trimmed
        guard let comps = URLComponents(string: withoutFragment),
              let scheme = comps.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              comps.user == nil,
              comps.password == nil,
              let host = comps.host?.lowercased(), !host.isEmpty
        else {
            throw ServerURLError.invalid
        }
        return canonicalOrigin(scheme: scheme, host: host, port: comps.port)
    }

    /// Verifies that a media or subtitle URL uses http(s) and optionally stays strictly same-origin.
    public static func sanitizeMediaURL(_ raw: String?, baseOrigin: String, requireSameOrigin: Bool) -> URL? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= maxLength else { return nil }
        guard let base = URL(string: baseOrigin),
              let resolved = URL(string: trimmed, relativeTo: base)?.absoluteURL,
              let comps = URLComponents(url: resolved, resolvingAgainstBaseURL: false),
              let scheme = comps.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              comps.user == nil,
              comps.password == nil,
              let host = comps.host?.lowercased(), !host.isEmpty
        else {
            return nil
        }
        if requireSameOrigin {
            let resolvedOrigin = canonicalOrigin(scheme: scheme, host: host, port: comps.port)
            guard let expectedOrigin = try? origin(fromPageURL: baseOrigin),
                  resolvedOrigin == expectedOrigin
            else {
                return nil
            }
        }
        return resolved
    }

    public static func canonicalOrigin(scheme: String, host: String, port: Int?) -> String {
        let formattedHost = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        let isDefault = (scheme == "http" && (port == nil || port == 80))
            || (scheme == "https" && (port == nil || port == 443))
        if isDefault || port == nil {
            return "\(scheme)://\(formattedHost)"
        }
        return "\(scheme)://\(formattedHost):\(port!)"
    }
}

/// Validates a `/api/server` JSON response to confirm the host is a genuine Triboon server.
public struct TriboonServerInfo: Codable, Equatable, Sendable {
    public let version: String
    public let needsSetup: Bool
    public let phase: Int?
    public let name: String?

    public var isValidTriboon: Bool {
        let parts = version.split(separator: ".")
        guard parts.count >= 3 else { return false }
        return parts.prefix(3).allSatisfy { Int($0) != nil }
    }
}
