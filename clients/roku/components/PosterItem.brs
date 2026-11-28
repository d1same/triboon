sub init()
    m.focusRing = m.top.findNode("focusRing")
    m.poster = m.top.findNode("poster")
    m.titleLabel = m.top.findNode("titleLabel")
    m.progressTrack = m.top.findNode("progressTrack")
    m.progressFill = m.top.findNode("progressFill")
end sub

sub onItemContentChanged()
    item = m.top.itemContent
    if item = invalid then return

    m.titleLabel.text = item.title

    ' Live TV channel logos and account cards should fit cleanly without cropping
    kind = ""
    if item.HasField("itemKind") and item.itemKind <> invalid then kind = item.itemKind.ToStr()
    if kind = "livetv" or kind = "account_action"
        m.poster.loadDisplayMode = "scaleToFit"
        m.poster.width = 164
        m.poster.height = 258
        m.poster.translation = [20, 20]
    else
        m.poster.loadDisplayMode = "scaleToZoom"
        m.poster.width = 204
        m.poster.height = 298
        m.poster.translation = [0, 0]
    end if

    if item.HDPosterUrl <> invalid and item.HDPosterUrl <> ""
        m.poster.uri = item.HDPosterUrl
    else
        m.poster.loadDisplayMode = "scaleToFit"
        m.poster.width = 156
        m.poster.height = 240
        m.poster.translation = [24, 28]
        m.poster.uri = "pkg:/images/icon-focus-hd.png"
    end if

    prog = 0.0
    if item.HasField("progress") then prog = item.progress
    if prog > 0.01 and prog < 0.99
        m.progressTrack.visible = true
        m.progressFill.visible = true
        m.progressFill.width = Int(204 * prog)
    else
        m.progressTrack.visible = false
        m.progressFill.visible = false
    end if
end sub

sub onFocusChanged()
    fp = m.top.focusPercent
    if fp > 0.2
        m.focusRing.color = "0xE11D74FF"
    else
        m.focusRing.color = "0xE11D7400"
    end if
end sub
