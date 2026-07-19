# Third-party notices

Triboon is distributed under the MIT License in `LICENSE`. Its packaged server
distributions also contain third-party software under the licenses below. The
license for each component remains with its respective copyright holders.

## Docker image

| Component | Version in this repository | License and source |
| --- | --- | --- |
| Node.js Docker Official Image | `node:24-alpine`, pinned by digest in `Dockerfile` | [Docker image source and license](https://github.com/nodejs/docker-node) |
| Node.js | Node 24 | [MIT and bundled dependency notices](https://github.com/nodejs/node/blob/main/LICENSE) |
| Alpine Linux and installed APK packages | Version fixed by the pinned base image, plus packages resolved by `apk` | [Alpine package index and per-package licenses](https://pkgs.alpinelinux.org/packages) |
| FFmpeg | Alpine `ffmpeg` package | [FFmpeg licensing and source](https://ffmpeg.org/legal.html) |
| su-exec | Alpine `su-exec` package | [MIT source](https://github.com/ncopa/su-exec) |
| Python | Alpine `python3` package | [PSF License](https://docs.python.org/3/license.html) |
| pip | Alpine `py3-pip` package | [MIT source](https://github.com/pypa/pip) |
| gcompat | Alpine `gcompat` package | [NCSA source](https://git.adelielinux.org/adelie/gcompat) |
| ytmusicapi | 1.12.1 | [MIT source](https://github.com/sigma67/ytmusicapi/tree/1.12.1) |
| yt-dlp | 2026.07.04 | [Unlicense source](https://github.com/yt-dlp/yt-dlp/tree/2026.07.04) |
| alass | 2.0.0 | [GPL-3.0 source](https://github.com/kaegi/alass/tree/v2.0.0) |

The Docker build records and verifies the SHA-256 of the downloaded yt-dlp and
alass artifacts before installing them. FFmpeg and alass are executed as
separate programs; Triboon does not incorporate their source code.

## Windows server installer

The Windows installer includes Node.js, WinSW, FFmpeg/ffprobe, yt-dlp, and
optionally alass. Its generated `licenses/THIRD-PARTY-NOTICES.txt` records the
exact versions selected for that build and provides the corresponding source
locations. FFmpeg license files from its distribution are also copied into the
installer payload.

| Component | License and source |
| --- | --- |
| WinSW | [MIT source](https://github.com/winsw/winsw) |
| Gyan FFmpeg build | [GPL-3.0 build source](https://github.com/GyanD/codexffmpeg) |
| yt-dlp | [Unlicense source](https://github.com/yt-dlp/yt-dlp) |
| alass | [GPL-3.0 source](https://github.com/kaegi/alass) |

The upstream projects and their authors are not affiliated with or responsible
for Triboon.

## Windows native client

Triboon for Windows dynamically loads `libmpv-2.dll` from the unmodified
`mpv-dev-lgpl-x86_64-20260713-git-e5486b96d7` package published by
`zhongfly/mpv-winbuild`. The archive URL and SHA-256 are locked in CI. The
selected package is the LGPL x86-64 build; Triboon does not statically link it
or prevent replacement with an ABI-compatible DLL.

The upstream archive contains a single runtime DLL rather than separate
codec/rendering DLLs; its enabled components remain under their respective
licenses. The installed client carries this notice, Triboon's `LICENSE`,
`LIBMPV-LICENSE.LGPL`, `LIBMPV-SOURCE.md`, and a generated
`RUST-DEPENDENCIES.md` inventory for the locked Windows Cargo graph.
`LIBMPV-SOURCE.md` records the exact archive and DLL hashes, mpv source
revision, builder revision/run, rebuild route, runtime prerequisite, license
links, and replacement instructions. See
the [exact mpv copyright notice](https://github.com/mpv-player/mpv/blob/e5486b96d7d06dd148337899bfdc46bf25101663/Copyright)
and [LGPL license](https://github.com/mpv-player/mpv/blob/e5486b96d7d06dd148337899bfdc46bf25101663/LICENSE.LGPL).
