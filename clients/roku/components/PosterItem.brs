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
    if item.HDPosterUrl <> invalid and item.HDPosterUrl <> ""
        m.poster.uri = item.HDPosterUrl
    else
        m.poster.uri = "pkg:/images/icon-focus-hd.png"
    end if

    prog = 0.0
    if item.HasField("progress") then prog = item.progress
    if prog > 0.01 and prog < 0.99
        m.progressTrack.visible = true
        m.progressFill.visible = true
        m.progressFill.width = Int(228 * prog)
    else
        m.progressTrack.visible = false
        m.progressFill.visible = false
    end if
end sub

sub onFocusChanged()
    fp = m.top.focusPercent
    if fp > 0.2
        m.focusRing.color = "0xFFFFFFFF"
    else
        m.focusRing.color = "0xFFFFFF00"
    end if
end sub
