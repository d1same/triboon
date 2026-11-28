' Pure utility helpers for Triboon Roku channel (server URL validation, playback selection, Persian/RTL shaping, registry)

function TriboonMakeFont(size as Integer, bold = false as Boolean) as Object
    f = CreateObject("roSGNode", "Font")
    if bold
        f.uri = "pkg:/fonts/Vazirmatn-Bold.ttf"
    else
        f.uri = "pkg:/fonts/Vazirmatn-Regular.ttf"
    end if
    f.size = size
    return f
end function

function TriboonHasRtl(s as String) as Boolean
    n = Len(s)
    for i = 1 to n
        cp = Asc(Mid(s, i, 1))
        if (cp >= &h0600 and cp <= &h06FF) or (cp >= &hFB50 and cp <= &hFEFF)
            return true
        end if
    end for
    return false
end function

function TriboonArabicForms(cp as Integer) as Dynamic
    ' Returns [isolated, final, initial, medial] (0 means form does not join on the left)
    if cp = &h0621 then return [&hFE80, 0, 0, 0]
    if cp = &h0622 then return [&hFE81, &hFE82, 0, 0]
    if cp = &h0623 then return [&hFE83, &hFE84, 0, 0]
    if cp = &h0624 then return [&hFE85, &hFE86, 0, 0]
    if cp = &h0625 then return [&hFE87, &hFE88, 0, 0]
    if cp = &h0626 then return [&hFE89, &hFE8A, &hFE8B, &hFE8C]
    if cp = &h0627 then return [&hFE8D, &hFE8E, 0, 0]
    if cp = &h0628 then return [&hFE8F, &hFE90, &hFE91, &hFE92]
    if cp = &h0629 then return [&hFE93, &hFE94, 0, 0]
    if cp = &h062A then return [&hFE95, &hFE96, &hFE97, &hFE98]
    if cp = &h062B then return [&hFE99, &hFE9A, &hFE9B, &hFE9C]
    if cp = &h062C then return [&hFE9D, &hFE9E, &hFE9F, &hFEA0]
    if cp = &h062D then return [&hFEA1, &hFEA2, &hFEA3, &hFEA4]
    if cp = &h062E then return [&hFEA5, &hFEA6, &hFEA7, &hFEA8]
    if cp = &h062F then return [&hFEA9, &hFEAA, 0, 0]
    if cp = &h0630 then return [&hFEAB, &hFEAC, 0, 0]
    if cp = &h0631 then return [&hFEAD, &hFEAE, 0, 0]
    if cp = &h0632 then return [&hFEAF, &hFEB0, 0, 0]
    if cp = &h0633 then return [&hFEB1, &hFEB2, &hFEB3, &hFEB4]
    if cp = &h0634 then return [&hFEB5, &hFEB6, &hFEB7, &hFEB8]
    if cp = &h0635 then return [&hFEB9, &hFEBA, &hFEBB, &hFEBC]
    if cp = &h0636 then return [&hFEBD, &hFEBE, &hFEBF, &hFEC0]
    if cp = &h0637 then return [&hFEC1, &hFEC2, &hFEC3, &hFEC4]
    if cp = &h0638 then return [&hFEC5, &hFEC6, &hFEC7, &hFEC8]
    if cp = &h0639 then return [&hFEC9, &hFECA, &hFECB, &hFECC]
    if cp = &h063A then return [&hFECD, &hFECE, &hFECF, &hFED0]
    if cp = &h0640 then return [&h0640, &h0640, &h0640, &h0640]
    if cp = &h0641 then return [&hFED1, &hFED2, &hFED3, &hFED4]
    if cp = &h0642 then return [&hFED5, &hFED6, &hFED7, &hFED8]
    if cp = &h0643 then return [&hFED9, &hFEDA, &hFEDB, &hFEDC]
    if cp = &h0644 then return [&hFEDD, &hFEDE, &hFEDF, &hFEE0]
    if cp = &h0645 then return [&hFEE1, &hFEE2, &hFEE3, &hFEE4]
    if cp = &h0646 then return [&hFEE5, &hFEE6, &hFEE7, &hFEE8]
    if cp = &h0647 then return [&hFEE9, &hFEEA, &hFEEB, &hFEEC]
    if cp = &h0648 then return [&hFEED, &hFEEE, 0, 0]
    if cp = &h0649 then return [&hFEEF, &hFEF0, 0, 0]
    if cp = &h064A then return [&hFEF1, &hFEF2, &hFEF3, &hFEF4]
    ' Persian letters
    if cp = &h067E then return [&hFB56, &hFB57, &hFB58, &hFB59]
    if cp = &h0686 then return [&hFB7A, &hFB7B, &hFB7C, &hFB7D]
    if cp = &h0698 then return [&hFB8A, &hFB8B, 0, 0]
    if cp = &h06A9 then return [&hFB8E, &hFB8F, &hFB90, &hFB91]
    if cp = &h06AF then return [&hFB92, &hFB93, &hFB94, &hFB95]
    if cp = &h06C0 then return [&h06C0, &hFBA5, 0, 0]
    if cp = &h06CC then return [&hFBFC, &hFBFD, &hFBFE, &hFBFF]
    return invalid
end function

function TriboonIsArabicDiacritic(cp as Integer) as Boolean
    return (cp >= &h064B and cp <= &h065F) or cp = &h0670
end function

function TriboonShapeArabicLine(lineStr as String) as String
    n = Len(lineStr)
    if n = 0 then return ""
    codes = []
    for i = 1 to n
        codes.Push(Asc(Mid(lineStr, i, 1)))
    end for

    shaped = []
    idx = 0
    total = codes.Count()
    while idx < total
        cp = codes[idx]
        if cp = &h200C or cp = &h200D or cp = &h200E or cp = &h200F
            idx = idx + 1
            continue while
        end if
        if TriboonIsArabicDiacritic(cp)
            idx = idx + 1
            continue while
        end if

        forms = TriboonArabicForms(cp)
        if forms = invalid
            shaped.Push(cp)
            idx = idx + 1
            continue while
        end if

        ' Look back past diacritics to see if previous char joins left
        prevJoins = false
        pIdx = idx - 1
        while pIdx >= 0 and TriboonIsArabicDiacritic(codes[pIdx])
            pIdx = pIdx - 1
        end while
        if pIdx >= 0
            pForms = TriboonArabicForms(codes[pIdx])
            if pForms <> invalid and pForms[2] <> 0 then prevJoins = true
        end if

        ' Look forward past diacritics for Lam-Alef ligature or next joining letter
        nIdx = idx + 1
        while nIdx < total and TriboonIsArabicDiacritic(codes[nIdx])
            nIdx = nIdx + 1
        end while

        if cp = &h0644 and nIdx < total
            nextCp = codes[nIdx]
            ligIso = 0
            ligFin = 0
            if nextCp = &h0622
                ligIso = &hFEF5
                ligFin = &hFEF6
            else if nextCp = &h0623
                ligIso = &hFEF7
                ligFin = &hFEF8
            else if nextCp = &h0625
                ligIso = &hFEF9
                ligFin = &hFEFA
            else if nextCp = &h0627
                ligIso = &hFEFB
                ligFin = &hFEFC
            end if
            if ligIso <> 0
                if prevJoins
                    shaped.Push(ligFin)
                else
                    shaped.Push(ligIso)
                end if
                idx = nIdx + 1
                continue while
            end if
        end if

        nextJoins = false
        if forms[2] <> 0 and nIdx < total
            nForms = TriboonArabicForms(codes[nIdx])
            if nForms <> invalid and nForms[1] <> 0 then nextJoins = true
        end if

        if prevJoins and nextJoins and forms[3] <> 0
            shaped.Push(forms[3])
        else if prevJoins and forms[1] <> 0
            shaped.Push(forms[1])
        else if nextJoins and forms[2] <> 0
            shaped.Push(forms[2])
        else
            shaped.Push(forms[0])
        end if
        idx = idx + 1
    end while

    ' Classify each shaped codepoint into RTL ("R"), LTR ("L"), or Neutral ("N")
    ' Note: Arabic/Persian digits 0660..0669 and 06F0..06F9 read LTR like 0..9
    runs = []
    rtlCount = 0
    ltrCount = 0
    firstStrong = ""
    for each sc in shaped
        kind = "N"
        if (sc >= &h0600 and sc <= &h065F) or (sc >= &h066A and sc <= &h06EF) or (sc >= &h06FA and sc <= &h06FF) or (sc >= &hFB50 and sc <= &hFEFF)
            kind = "R"
            rtlCount = rtlCount + 1
            if firstStrong = "" then firstStrong = "R"
        else if (sc >= 48 and sc <= 57) or (sc >= 65 and sc <= 90) or (sc >= 97 and sc <= 122) or (sc >= &h0660 and sc <= &h0669) or (sc >= &h06F0 and sc <= &h06F9)
            kind = "L"
            ltrCount = ltrCount + 1
            if firstStrong = "" then firstStrong = "L"
        end if

        if runs.Count() > 0 and runs[runs.Count() - 1].kind = kind
            runs[runs.Count() - 1].chars.Push(sc)
        else
            runs.Push({ kind: kind, chars: [sc] })
        end if
    end for

    if rtlCount = 0 then return lineStr

    ' Merge neutral runs bounded by two RTL runs into a single RTL run
    merged = []
    rCount = runs.Count()
    for i = 0 to rCount - 1
        cur = runs[i]
        if cur.kind = "N" and merged.Count() > 0 and merged[merged.Count() - 1].kind = "R" and (i + 1) < rCount and runs[i + 1].kind = "R"
            for each ch in cur.chars
                merged[merged.Count() - 1].chars.Push(ch)
            end for
        else if cur.kind = "R" and merged.Count() > 0 and merged[merged.Count() - 1].kind = "R"
            for each ch in cur.chars
                merged[merged.Count() - 1].chars.Push(ch)
            end for
        else
            merged.Push(cur)
        end if
    end for

    isRtlLine = (firstStrong = "R") or (rtlCount > ltrCount)

    outParts = []
    if isRtlLine
        for i = merged.Count() - 1 to 0 step -1
            segRun = merged[i]
            if segRun.kind = "R" or segRun.kind = "N"
                outParts.Push(TriboonReverseCodes(segRun.chars, true))
            else
                outParts.Push(TriboonJoinCodes(segRun.chars))
            end if
        end for
    else
        for each segRun in merged
            if segRun.kind = "R"
                outParts.Push(TriboonReverseCodes(segRun.chars, true))
            else
                outParts.Push(TriboonJoinCodes(segRun.chars))
            end if
        end for
    end if

    res = ""
    for each part in outParts
        res = res + part
    end for
    return res
end function

function TriboonMirrorCode(cp as Integer) as Integer
    if cp = 40 then return 41 ' ( -> )
    if cp = 41 then return 40 ' ) -> (
    if cp = 91 then return 93 ' [ -> ]
    if cp = 93 then return 91 ' ] -> [
    if cp = 123 then return 125
    if cp = 125 then return 123
    if cp = &h00AB then return &h00BB
    if cp = &h00BB then return &h00AB
    return cp
end function

function TriboonReverseCodes(codes as Object, mirrorBrackets as Boolean) as String
    s = ""
    for i = codes.Count() - 1 to 0 step -1
        cp = codes[i]
        if mirrorBrackets then cp = TriboonMirrorCode(cp)
        s = s + Chr(cp)
    end for
    return s
end function

function TriboonJoinCodes(codes as Object) as String
    s = ""
    for each cp in codes
        s = s + Chr(cp)
    end for
    return s
end function

function TriboonFormatText(raw as Dynamic) as String
    if raw = invalid then return ""
    s = raw.ToStr()
    if s = "" then return ""
    if not TriboonHasRtl(s) then return s

    lines = s.Split(Chr(10))
    out = ""
    for i = 0 to lines.Count() - 1
        if i > 0 then out = out + Chr(10)
        ln = lines[i]
        if TriboonHasRtl(ln)
            out = out + TriboonShapeArabicLine(ln)
        else
            out = out + ln
        end if
    end for
    return out
end function

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
    ' Report ac3/eac3/dts false so Triboon always remuxes Dolby/DTS tracks to Roku-universal stereo AAC
    ' instead of sending silent AC-3/E-AC-3 direct MP4s to stereo TVs without an AVR/soundbar.
    return {
        mkv: false,
        mp4: true,
        h264: true,
        hevc: true,
        aac: true,
        ac3: false,
        eac3: false,
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
    playMethod = ""
    if playRes.playback <> invalid and type(playRes.playback) = "roAssociativeArray"
        if playRes.playback.method <> invalid
            playMethod = LCase(playRes.playback.method.ToStr())
        else if playRes.playback.mode <> invalid
            playMethod = LCase(playRes.playback.mode.ToStr())
        end if
    end if

    ' 1. Direct MP4 ONLY when container is MP4/M4V/MOV, starting near 0, and server confirmed method="direct"
    '    (guarantees AAC/MP3 audio instead of silent AC-3/E-AC-3 on stereo Roku TVs).
    if directMp4 and startSec <= 0 and playMethod = "direct" and playRes.streamUrl <> invalid and playRes.streamUrl <> ""
        TriboonAppendLiveCandidate(list, baseOrigin, playRes.streamUrl, "mp4")
    end if

    ' 2. HLS with forced stereo 48kHz AAC (audioSafe=1) and NO padinit.mp4 discontinuity
    '    (Roku's fMP4 player can drop audio across vod=1's silent loading-card discontinuity).
    if playRes.hlsUrl <> invalid and playRes.hlsUrl <> ""
        hlsBase = TriboonResolveUrl(baseOrigin, playRes.hlsUrl)
        sep = "?"
        if Instr(1, hlsBase, "?") > 0 then sep = "&"
        startQ = ""
        if startSec > 1 then startQ = "&start=" + startSec.ToStr()
        if playMethod = "transcode"
            TriboonAppendLiveCandidate(list, baseOrigin, hlsBase + sep + "transcode=1&height=1080&audioSafe=1" + startQ, "hls")
            TriboonAppendLiveCandidate(list, baseOrigin, hlsBase + sep + "audioSafe=1" + startQ, "hls")
        else
            ' Original video quality + guaranteed stereo AAC audio (works on existing & new servers)
            TriboonAppendLiveCandidate(list, baseOrigin, hlsBase + sep + "audioSafe=1" + startQ, "hls")
            ' 1080p H.264/AAC transcode fallback (handles Persian/local Xvid, MPEG-4, High10, exotic codecs)
            TriboonAppendLiveCandidate(list, baseOrigin, hlsBase + sep + "transcode=1&height=1080&audioSafe=1" + startQ, "hls")
        end if
        ' VOD fallback with noPad=1 (skips loading-card discontinuity on updated servers)
        TriboonAppendLiveCandidate(list, baseOrigin, hlsBase + sep + "vod=1&noPad=1&audioSafe=1" + startQ, "hls")
    end if

    ' 3. Remux MP4 with forced stereo AAC fallback
    if playRes.remuxUrl <> invalid and playRes.remuxUrl <> ""
        remuxBase = TriboonResolveUrl(baseOrigin, playRes.remuxUrl)
        rSep = "?"
        if Instr(1, remuxBase, "?") > 0 then rSep = "&"
        rStartQ = ""
        if startSec > 1 then rStartQ = "&start=" + startSec.ToStr()
        TriboonAppendLiveCandidate(list, baseOrigin, remuxBase + rSep + "audioSafe=1" + rStartQ, "mp4")
    end if

    ' 4. Direct streamUrl last-resort fallback
    if playRes.streamUrl <> invalid and playRes.streamUrl <> ""
        fmt = "hls"
        if directMp4 then fmt = "mp4"
        TriboonAppendLiveCandidate(list, baseOrigin, playRes.streamUrl, fmt)
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
