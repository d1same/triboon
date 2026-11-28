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
    result = { url: "", streamFormat: "hls" }
    if playRes = invalid then return result

    fileName = ""
    if playRes.name <> invalid then fileName = LCase(playRes.name.ToStr())
    directMp4 = (Right(fileName, 4) = ".mp4" or Right(fileName, 4) = ".m4v" or Right(fileName, 4) = ".mov")

    if directMp4 and startSec <= 0 and playRes.streamUrl <> invalid and playRes.streamUrl <> ""
        result.url = TriboonResolveUrl(baseOrigin, playRes.streamUrl)
        result.streamFormat = "mp4"
        return result
    end if

    if playRes.hlsUrl <> invalid and playRes.hlsUrl <> ""
        hls = TriboonResolveUrl(baseOrigin, playRes.hlsUrl)
        sep = "?"
        if Instr(1, hls, "?") > 0 then sep = "&"
        if startSec > 1
            hls = hls + sep + "vod=1&start=" + startSec.ToStr() + "&audioSafe=1"
        else
            hls = hls + sep + "vod=1&audioSafe=1"
        end if
        result.url = hls
        result.streamFormat = "hls"
        return result
    end if

    if playRes.streamUrl <> invalid and playRes.streamUrl <> ""
        result.url = TriboonResolveUrl(baseOrigin, playRes.streamUrl)
        if directMp4
            result.streamFormat = "mp4"
        else
            result.streamFormat = "hls"
        end if
        return result
    end if

    if playRes.remuxUrl <> invalid and playRes.remuxUrl <> ""
        result.url = TriboonResolveUrl(baseOrigin, playRes.remuxUrl)
        result.streamFormat = "mp4"
        return result
    end if

    return result
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
