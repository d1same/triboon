# Triboon for iPhone, iPad, and Apple TV

Native Apple clients sharing one Swift core (`Packages/TriboonCore`):

- **`TriboonIOS` (iOS 17+ / iPadOS 17+):** Branded Connect screen, origin-guarded `WKWebView` catalog shell reusing Triboon's web UI (`web/index.html`) via the shared `window.TriboonTV` bridge (`__triboonAppleBridge: true`), and native `AVPlayerViewController` playback handoff with AirPlay, Picture-in-Picture, automatic landscape support, and Live TV HLS fallback.
- **`TriboonTV` (tvOS 17+ / Apple TV):** 100% native SwiftUI Apple TV app (Apple does not permit `WKWebView` on tvOS) with Quick Connect (6-digit code), Password/2FA sign-in, Home/Continue Watching, Movies, TV Shows, Local Libraries, Live TV, Search, and native Siri Remote `AVPlayerViewController` playback with watch-progress sync.

## Building with XcodeGen (macOS / GitHub Actions)

```bash
cd clients/apple
swift test --package-path Packages/TriboonCore
xcodegen generate
xcodebuild -project TriboonApple.xcodeproj -scheme TriboonIOS -destination "generic/platform=iOS Simulator" CODE_SIGNING_ALLOWED=NO build
xcodebuild -project TriboonApple.xcodeproj -scheme TriboonTV -destination "generic/platform=tvOS Simulator" CODE_SIGNING_ALLOWED=NO build
```

## Testing Before TestFlight / App Store

- The `.github/workflows/apple.yml` workflow builds unsigned iOS Simulator (`.app.zip`), iOS device (ARM64), tvOS Simulator, and tvOS device (ARM64) targets on `macos-15` and runs `TriboonCoreTests`.
- You can upload the `TriboonIOS-Simulator.app.zip` artifact directly to TestingBot's **iOS Simulator Live App Testing** without an Apple Developer account.
- When you are ready for real iPhone/iPad/Apple TV installs and auto-updates via **TestFlight** or the **App Store**, add your Apple Developer signing secrets (or Fastlane) — the bundle IDs (`app.triboon.ios`, `app.triboon.appletv`) and ATS local-network permissions are already configured.
