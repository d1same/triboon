' Pure utility helpers for Triboon Roku channel (server URL validation, playback selection, registry)

function TriboonNormalizeServerUrl(raw as String) as String
    s = raw.Trim()
    if s = "" then return ""
    if Instr(1, s, " ") > 0 then return ""

    lower = LCase(s)
    if Left(lower, 11) = "javascript:" or Left(lower, 5) = "data:" or Left(lower, 5) = "file:"
        return ""
    end if
    if Left(lower, 7) <> "http://" and Left(lower, 8) <> "https://"
        if Instr(1, s, "://") > 0 then return ""
        s = "http://" + s
    end if

    ' Strip trailing slashes
    while Right(s, 1) = "/"
        s = Left(s, Len(s) - 1)
    end while
    return s
end function

function TriboonIsValidServerInfo(info as Object) as Boolean
    if info = invalid or type(info) <> "roAssociativeArray" then return false
    if info.app <> invalid and LCase(info.app) = "triboon" then return true
    if info.name <> invalid and LCase(info.name) = "triboon" then return true
    if info.version <> invalid and Len(info.version) >= 5 then return true
    return false
end function

function TriboonResolveUrl(baseOrigin as String, rawPath as Dynamic) as String
    if rawPath = invalid then return ""
    p = rawPath.ToStr().Trim()
    if p = "" then return ""
    lower = LCase(p)
    if Left(lower, 7) = "http://" or Left(lower, 8) = "https://"
        return p
    end if
    if Left(p, 1) = "/"
        return baseOrigin + p
    end if
    return baseOrigin + "/" + p
end function

function TriboonRokuCaps() as Object
    return {
        mkv: false,
        mp4: true,
        h264: true,
        hevc: true,
        aac: true,
        ac3: true,
        eac3: true,
        dts: false,
        hls: true
    }
end function

function TriboonPreferredVodStream(baseOrigin as String, playRes as Object, startSec as Integer) as Object
    list = TriboonOrderedVodStreams(baseOrigin, playRes, startSec)
    if list.Count() > 0 then return list[0]
    return { url: "", streamFormat: "hls" }
end function

function TriboonOrderedVodStreams(baseOrigin as String, playRes as Object, startSec as Integer) as Object
    list = []
    if playRes = invalid then return list

    fileName = ""
    if playRes.name <> invalid then fileName = LCase(playRes.name.ToStr())
    directMp4 = (Right(fileName, 4) = ".mp4" or Right(fileName, 4) = ".m4v" or Right(fileName, 4) = ".mov")
    playMode = ""
    if playRes.playback <> invalid and type(playRes.playback) = "roAssociativeArray" and playRes.playback.mode <> invalid
        playMode = LCase(playRes.playback.mode.ToStr())
    end if

    ' 1. Direct MP4 only when container is MP4/M4V/MOV, starting near 0, and server says direct (not transcode)
    if directMp4 and startSec <= 0 and playMode <> "transcode" and playRes.streamUrl <> invalid and playRes.streamUrl <> ""
        TriboonAppendLiveCandidate(list, baseOrigin, playRes.streamUrl, "mp4")
    end if

    ' 2. HLS VOD remux (audioSafe=1 converts AC3/DTS/MP3/etc. to Roku-safe AAC; vod=1 gives full scrub bar)
    if playRes.hlsUrl <> invalid and playRes.hlsUrl <> ""
        hlsBase = TriboonResolveUrl(baseOrigin, playRes.hlsUrl)
        sep = "?"
        if Instr(1, hlsBase, "?") > 0 then sep = "&"
        startQ = ""
        if startSec > 1 then startQ = "&start=" + startSec.ToStr()
        if playMode <> "transcode"
            TriboonAppendLiveCandidate(list, baseOrigin, hlsBase + sep + "vod=1&audioSafe=1" + startQ, "hls")
        end if
        ' 3. HLS H.264/AAC transcode fallback (handles MPEG-4, Xvid, High10, exotic codecs in Persian/local MKV/MP4)
        TriboonAppendLiveCandidate(list, baseOrigin, hlsBase + sep + "transcode=1&height=1080&audioSafe=1" + startQ, "hls")
        if playMode = "transcode"
            TriboonAppendLiveCandidate(list, baseOrigin, hlsBase + sep + "vod=1&audioSafe=1" + startQ, "hls")
        end if
    end if

    ' 4. Direct streamUrl / remuxUrl last-resort fallback
    if playRes.streamUrl <> invalid and playRes.streamUrl <> ""
        fmt = "hls"
        if directMp4 then fmt = "mp4"
        TriboonAppendLiveCandidate(list, baseOrigin, playRes.streamUrl, fmt)
    end if
    if playRes.remuxUrl <> invalid and playRes.remuxUrl <> ""
        TriboonAppendLiveCandidate(list, baseOrigin, playRes.remuxUrl, "mp4")
    end if

    return list
end function

function TriboonOrderedLiveStreams(baseOrigin as String, playRes as Object) as Object
    list = []
    if playRes = invalid then return list

    TriboonAppendLiveCandidate(list, baseOrigin, playRes.hlsUrl, "hls")
    if playRes.nativeMime <> invalid
        mime = LCase(playRes.nativeMime.ToStr())
        if Instr(1, mime, "mpegurl") > 0 or Instr(1, mime, "m3u8") > 0
            TriboonAppendLiveCandidate(list, baseOrigin, playRes.nativeUrl, "hls")
        end if
    end if
    TriboonAppendLiveCandidate(list, baseOrigin, playRes.nativeFallbackUrl, "hls")
    TriboonAppendLiveCandidate(list, baseOrigin, playRes.nativeUrl, "hls")
    TriboonAppendLiveCandidate(list, baseOrigin, playRes.streamUrl, "mp4")
    return list
end function

sub TriboonAppendLiveCandidate(list as Object, baseOrigin as String, rawUrl as Dynamic, fmt as String)
    if rawUrl = invalid then return
    resolved = TriboonResolveUrl(baseOrigin, rawUrl)
    if resolved = "" then return
    for each existing in list
        if existing.url = resolved then return
    end for
    list.Push({ url: resolved, streamFormat: fmt })
end sub

function TriboonRegRead(key as String) as String
    sec = CreateObject("roRegistrySection", "TriboonAuth")
    if sec.Exists(key) then return sec.Read(key)
    return ""
end function

sub TriboonRegWrite(key as String, value as String)
    sec = CreateObject("roRegistrySection", "TriboonAuth")
    if value = ""
        if sec.Exists(key) then sec.Delete(key)
    else
        sec.Write(key, value)
    end if
    sec.Flush()
end sub

function TriboonTmdbImage(pathVal as Dynamic, sizeStr as String) as String
    if pathVal = invalid then return ""
    p = pathVal.ToStr().Trim()
    if p = "" then return ""
    if Left(LCase(p), 4) = "http" then return p
    return "https://image.tmdb.org/t/p/" + sizeStr + p
end function
