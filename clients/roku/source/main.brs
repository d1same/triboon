sub Main(args as Object)
    screen = CreateObject("roSGScreen")
    m.port = CreateObject("roMessagePort")
    screen.SetMessagePort(m.port)

    inputObj = CreateObject("roInput")
    inputObj.SetMessagePort(m.port)

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
        else if msgType = "roInputEvent"
            if msg.IsInput()
                info = msg.GetInfo()
                if info <> invalid
                    scene.inputArgs = info
                end if
            end if
        end if
    end while
end sub
