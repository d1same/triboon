# Triboon Setup Guide

Step-by-step for getting the API keys and accounts Triboon uses, with links.
After installing (Docker, Unraid, or the Windows server installer), open
`http://<your-server>:7777`, create the owner account, then add these in
**Settings**.

**You only need three things to press Play:** a TMDB key (free), a usenet
provider (paid), and one indexer. Everything else — subtitles, Trakt, Live TV,
music — is optional and can be added anytime.

| Service | Cost | Needed for |
|---|---|---|
| TMDB | **Free** | Posters, metadata, seasons/episodes (required) |
| Usenet provider | **Paid** | The actual streaming source (required) |
| Indexer | Free tier / paid | Finding NZBs by title (required) |
| Wyzie subtitles | **Free** | Subtitles (on by default) |
| OpenSubtitles | Free tier | Better subtitle matching (optional) |
| Trakt | **Free** | Watch-history sync + scrobbling (optional) |
| IPTV / Live TV | Your own | Live channels (optional) |

---

## 1. TMDB — metadata & artwork (required, free)

1. Create a free account: <https://www.themoviedb.org/signup>
2. Open **Settings → API**: <https://www.themoviedb.org/settings/api>
3. Request an API key — choose **Developer**, accept the terms (personal /
   non-commercial use is fine). Approval is instant.
4. Copy the **API Key (v3 auth)**.
5. In Triboon: **Settings → TMDB** → paste the key → Save. Triboon validates the
   key when you save it, so a wrong key is rejected immediately.

## 2. Usenet provider — the streaming source (required, paid)

Triboon streams directly from your usenet provider over NNTP. This is the one
part that isn't free — usenet access is a subscription (often a few dollars a
month; many providers sell cheap one-time **block accounts** or offer trials).

Well-known providers: **Newshosting**, **Eweka**, **Frugal Usenet**,
**Easynews**, **UsenetExpress** (and its resellers). Pick one with good
retention and enough connections for your plan.

You'll need: **host** (e.g. `news.provider.com`), **port** (`563` for SSL, `119`
plain — use SSL), **username**, **password**, and your plan's **max
connections**.

In Triboon: **Settings → Usenet** → add the provider → Save. You can add more
than one provider; Triboon combines their capacity.

## 3. Indexer — finds NZBs by title (required)

Triboon searches **Newznab-compatible** indexers. Two approaches:

- **Direct indexers** (each has its own account + API key): e.g.
  **NZBGeek** (<https://nzbgeek.info>), **NZBFinder**, **DrunkenSlug**, **abNZB**.
  Some have a free tier with a daily API-hit limit; paid lifts it. Copy the
  **API URL** and **API key** from the indexer's profile/account page.
- **Aggregators** (manage many indexers behind one URL): self-host
  **Prowlarr** (<https://prowlarr.com>) or
  **NZBHydra2** (<https://github.com/theotherp/nzbhydra2>), then point Triboon at
  its single Newznab endpoint.

In Triboon: **Settings → Indexers** → add (name, Newznab API URL, API key) →
Test. Add several for better coverage.

## 4. Subtitles (optional, free)

- **Wyzie** is used by default — free and unlimited, and usually needs **no
  key**. Nothing to do to get basic subtitles working.
- **OpenSubtitles** (optional) adds hash-based exact-sync matching:
  1. Create an account: <https://www.opensubtitles.com>
  2. Get a free API key (register a consumer/app):
     <https://www.opensubtitles.com/en/consumers>
  3. In Triboon: **Settings → Subtitles** → enter **API key + username +
     password**.
  - **Important:** the *username* is your opensubtitles.com **display name**
    (the short name on your profile), **not your email**. Entering the email is
    the #1 cause of "login failed".
  - The API key alone only *searches*; **downloads require the username +
    password login**. You can also choose the source priority (Wyzie-first is
    the default).

## 5. Trakt — watch-history sync (optional, free)

1. Sign in: <https://trakt.tv>
2. Create an API app: <https://trakt.tv/oauth/applications>
   - For the **Redirect URI**, use the value Triboon shows on its Trakt settings
     page (or `urn:ietf:wg:oauth:2.0:oob`).
3. Copy the **Client ID** and **Client Secret**.
4. In Triboon: **Settings → Trakt** → paste them → **Link account** (a quick
   OAuth approval). Your history then syncs both ways.

## 6. Live TV / IPTV (optional — bring your own)

Triboon plays IPTV playlists you already have; it does **not** provide channels.

- Add an **M3U** playlist URL, or an **Xtream** host + username + password.
- Optional **XMLTV** guide URL for the program guide (EPG).
- Legal, free sources: the **iptv-org** public/FAST channel lists
  (<https://github.com/iptv-org/iptv>), or an **HDHomeRun** network tuner for
  over-the-air (OTA) local channels.

In Triboon: **Settings → Live TV** → add a source.

## 7. Music (optional)

YouTube Music playback runs through `yt-dlp`. To reach your personal playlists
and Liked songs, link a Google account from **Settings → Music** (device-code or
cookie linking); anonymous search/radio works without linking.

---

## Fastest path

1. Paste your **TMDB** key.
2. Add your **usenet provider**.
3. Add one **indexer** and test it.
4. Search a title and press **Play**.

Add subtitles, Trakt, Live TV, and music whenever you like — none of them block
playback. All credentials are encrypted at rest in your data folder and are
never shown to non-admin users.
