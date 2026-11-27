sub init()
    m.top.functionName = "executeRequest"
end sub

sub executeRequest()
    reqUrl = m.top.url
    reqMethod = UCase(m.top.method)
    if reqMethod = "" then reqMethod = "GET"
    timeoutMs = m.top.timeoutSec * 1000
    if timeoutMs < 3000 then timeoutMs = 15000

    out = {
        ok: false,
        status: 0,
        data: invalid,
        error: "",
        tag: m.top.requestTag
    }

    if reqUrl = invalid or reqUrl = ""
        out.error = "Missing request URL."
        m.top.response = out
        return
    end if

    xfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)
    xfer.SetUrl(reqUrl)
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    xfer.EnableEncodings(true)
    xfer.RetainBodyOnError(true)
    xfer.AddHeader("Accept", "application/json")
    xfer.AddHeader("User-Agent", "TriboonRoku/3.5")

    if m.top.token <> invalid and m.top.token <> ""
        xfer.AddHeader("Authorization", "Bearer " + m.top.token)
    end if

    started = false
    if reqMethod = "POST"
        xfer.AddHeader("Content-Type", "application/json")
        body = m.top.bodyJson
        if body = invalid then body = "{}"
        started = xfer.AsyncPostFromString(body)
    else
        started = xfer.AsyncGetToString()
    end if

    if not started
        out.error = "Unable to start network request."
        m.top.response = out
        return
    end if

    msg = wait(timeoutMs, port)
    if msg = invalid
        xfer.AsyncCancel()
        out.error = "Request timed out."
        m.top.response = out
        return
    end if

    if type(msg) = "roUrlEvent"
        code = msg.GetResponseCode()
        raw = msg.GetString()
        out.status = code

        parsed = invalid
        if raw <> invalid and raw <> ""
            parsed = ParseJson(raw)
        end if

        if code >= 200 and code < 300
            out.ok = true
            out.data = parsed
        else if code = 401
            out.error = "Session expired. Please sign in again."
        else if parsed <> invalid and type(parsed) = "roAssociativeArray" and parsed.error <> invalid
            out.error = parsed.error.ToStr()
        else if code <= 0
            out.error = "Could not reach Triboon server (" + msg.GetFailureReason() + ")."
        else
            out.error = "Server returned HTTP " + code.ToStr() + "."
        end if
    else
        out.error = "Unexpected network response."
    end if

    m.top.response = out
end sub
