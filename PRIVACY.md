# Triboon Privacy Policy

_Last updated: 2026-11-25_

Triboon is a self-hosted personal media client for connecting to your own Triboon server on your local network or your own domain.

## 1. Data We Collect

**Triboon does not collect, sell, share, or transmit your personal data to us or any third-party advertising or analytics network.**

- **No developer servers**: The Triboon app communicates only with the self-hosted Triboon server address that you explicitly enter, plus any media/cast devices on your local network that you choose to connect to.
- **No analytics, ads, or crash trackers**: Triboon contains zero advertising SDKs and zero third-party analytics trackers.

## 2. Data Stored Locally on Your Device

The app stores minimal configuration locally on your device so it can reconnect automatically:

- Your saved Triboon server URL
- Your sign-in session cookie/token issued by your own Triboon server
- Local playback preferences (such as audio passthrough, subtitle size, or UI theme)

You can clear this data at any time via **Change server** / **Sign out** inside the app or by clearing app storage in Android settings.

## 3. Permissions Used

- **Internet & Network State**: Required to stream media from your self-hosted Triboon server.
- **Wake Lock & Foreground Media Service**: Keeps video and background audio playback smooth without pausing mid-stream.
- **Microphone (`RECORD_AUDIO`, optional, requested at runtime only)**: Used strictly when you tap the voice-search button to dictate a search query using Android's system speech recognizer. Audio is never recorded or stored by Triboon.
- **Notifications (`POST_NOTIFICATIONS`, optional)**: Used to display playback media controls when audio plays in the background.

## 4. Self-Hosted Server Responsibility

Because you connect Triboon to your own self-hosted server, any media metadata, watch history, or account credentials are stored on and governed by your own server.

## 5. Children's Privacy

Triboon does not knowingly collect personal information from children or any other users.

## 6. Contact

For privacy questions or support, please open an issue on the project repository:
https://github.com/d1same/triboon/issues
