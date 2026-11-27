sub Main(args as Object)
    screen = CreateObject("roSGScreen")
    m.port = CreateObject("roMessagePort")
    screen.SetMessagePort(m.port)

    scene = screen.CreateScene("MainScene")
    screen.Show()

    if args <> invalid and args.contentId <> invalid
        scene.launchArgs = args
    end if

    while true
        msg = wait(0, m.port)
        msgType = type(msg)
        if msgType = "roSGScreenEvent"
            if msg.IsScreenClosed() then return
        end if
    end while
end sub
