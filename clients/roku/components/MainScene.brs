sub init()
    m.serverUrl = TriboonRegRead("serverUrl")
    m.authToken = TriboonRegRead("authToken")
    m.profileId = TriboonRegRead("profileId")
    if m.profileId = "" then m.profileId = "default"
    m.skipProfilePicker = (TriboonRegRead("skipProfilePicker") = "1")
    m.pickedProfileThisSession = false
    m.currentUser = invalid
    m.activeView = "connect"
    m.activeTab = "home"
    m.navFocusIdx = 0
    m.qcCode = ""
    m.pendingLoginName = ""
    m.pending2faChallenge = ""
    m.pendingWatchResume = invalid
    m.detailContext = invalid
    m.playContext = invalid
    m.liveCandidates = []
    m.liveCandidateIdx = 0
    m.vodCandidates = []
    m.vodCandidateIdx = 0
    m.liveChannels = []
    m.liveChannelPos = -1
    m.pendingTasks = {}
    m.homeRowsCache = {}
    m.searchCache = {}
    m.homeLibsMeta = []
    m.librariesMeta = []

    bindNodes()
    setupControls()

    if m.serverUrl <> "" and m.authToken <> ""
        showView("browse")
        m.browseStatus.text = "Connecting to " + m.serverUrl + "..."
        fetchMe()
    else if m.serverUrl <> ""
        showView("login")
        startQuickConnect()
    else
        showView("connect")
    end if

    ' Roku certification beacon: fired as soon as the first view is ready.
    m.top.signalBeacon("AppLaunchComplete")
end sub

sub bindNodes()
    m.connectView = m.top.findNode("connectView")
    m.connectServerDisplay = m.top.findNode("connectServerDisplay")
    m.connectButtons = m.top.findNode("connectButtons")
    m.connectStatus = m.top.findNode("connectStatus")

    m.loginView = m.top.findNode("loginView")
    m.loginServerLabel = m.top.findNode("loginServerLabel")
    m.qcCodeLabel = m.top.findNode("qcCodeLabel")
    m.loginButtons = m.top.findNode("loginButtons")
    m.loginStatus = m.top.findNode("loginStatus")

    m.profileView = m.top.findNode("profileView")
    m.profileList = m.top.findNode("profileList")

    m.browseView = m.top.findNode("browseView")
    m.browseBackdrop = m.top.findNode("browseBackdrop")
    m.browseHeroTitle = m.top.findNode("browseHeroTitle")
    m.browseHeroMeta = m.top.findNode("browseHeroMeta")
    m.browseHeroOverview = m.top.findNode("browseHeroOverview")
    m.navBar = m.top.findNode("navBar")
    m.navBgs = []
    m.navLbls = []
    m.navBars = []
    for i = 0 to 6
        m.navBgs.Push(m.top.findNode("navBg" + i.ToStr()))
        m.navLbls.Push(m.top.findNode("navLbl" + i.ToStr()))
        m.navBars.Push(m.top.findNode("navBar" + i.ToStr()))
    end for
    m.browseStatus = m.top.findNode("browseStatus")
    m.browseRows = m.top.findNode("browseRows")

    m.detailView = m.top.findNode("detailView")
    m.detailBackdrop = m.top.findNode("detailBackdrop")
    m.detailPoster = m.top.findNode("detailPoster")
    m.detailTitle = m.top.findNode("detailTitle")
    m.detailMeta = m.top.findNode("detailMeta")
    m.detailOverview = m.top.findNode("detailOverview")
    m.detailButtons = m.top.findNode("detailButtons")
    m.detailStatus = m.top.findNode("detailStatus")
    m.episodeRows = m.top.findNode("episodeRows")

    m.playerView = m.top.findNode("playerView")
    m.videoPlayer = m.top.findNode("videoPlayer")
    m.playerOverlay = m.top.findNode("playerOverlay")
    m.playerTitle = m.top.findNode("playerTitle")
    m.playerStatus = m.top.findNode("playerStatus")

    m.qcPollTimer = m.top.findNode("qcPollTimer")
    m.watchSaveTimer = m.top.findNode("watchSaveTimer")
    m.channelStore = m.top.findNode("channelStore")
    m.rfiEmail = ""
    m.dialogBeaconOpen = false
    m.pendingDeepLink = invalid
end sub

sub setupControls()
    ' Apply bundled Vazirmatn fonts so both Persian and Latin render crisply everywhere
    btnFont = TriboonMakeFont(24, true)
    rowFont = TriboonMakeFont(28, true)
    listFont = TriboonMakeFont(26, true)

    m.connectButtons.textFont = btnFont
    m.connectButtons.focusedTextFont = btnFont
    m.connectButtons.buttons = ["Enter Server Address", "Connect"]
    m.connectButtons.observeField("buttonSelected", "onConnectButton")

    m.loginButtons.textFont = btnFont
    m.loginButtons.focusedTextFont = btnFont
    m.loginButtons.buttons = ["New Quick Connect Code", "Sign In with Password", "Change Server"]
    m.loginButtons.observeField("buttonSelected", "onLoginButton")

    m.detailButtons.textFont = btnFont
    m.detailButtons.focusedTextFont = btnFont

    m.profileList.font = listFont
    m.profileList.focusedFont = listFont
    m.profileList.observeField("itemSelected", "onProfileSelected")

    m.browseRows.rowLabelFont = rowFont
    m.browseRows.rowLabelColor = "0xF5F5F7FF"
    m.episodeRows.rowLabelFont = rowFont
    m.episodeRows.rowLabelColor = "0xF5F5F7FF"

    m.tabKeys = ["home", "movies", "tv", "libraries", "livetv", "search", "account"]
    updateNavBarVisuals(false)

    m.browseRows.observeField("rowItemSelected", "onBrowseItemSelected")
    m.browseRows.observeField("rowItemFocused", "onBrowseItemFocused")
    m.detailButtons.observeField("buttonSelected", "onDetailButton")
    m.episodeRows.observeField("rowItemSelected", "onEpisodeItemSelected")
    m.episodeRows.observeField("rowItemFocused", "onEpisodeItemFocused")

    m.videoPlayer.observeField("state", "onVideoStateChanged")
    m.qcPollTimer.observeField("fire", "onQuickConnectPollTick")
    m.watchSaveTimer.observeField("fire", "onWatchSaveTick")
    if m.channelStore <> invalid
        m.channelStore.observeField("userData", "onRokuUserData")
    end if
end sub

sub updateNavBarVisuals(barHasFocus as Boolean)
    activeIdx = 0
    for i = 0 to m.tabKeys.Count() - 1
        if m.tabKeys[i] = m.activeTab then activeIdx = i
    end for
    for i = 0 to 6
        bgNode = m.navBgs[i]
        lblNode = m.navLbls[i]
        barNode = m.navBars[i]
        if bgNode = invalid or lblNode = invalid or barNode = invalid then continue for
        isFocused = barHasFocus and (i = m.navFocusIdx)
        isActive = (i = activeIdx)
        if isFocused
            bgNode.color = "0xE11D74FF"
            lblNode.color = "0xFFFFFFFF"
            barNode.color = "0xFFFFFFFF"
        else if isActive
            bgNode.color = "0xFFFFFF12"
            lblNode.color = "0xFFFFFFFF"
            barNode.color = "0xE11D74FF"
        else
            bgNode.color = "0xFFFFFF00"
            lblNode.color = "0x9DA0AEFF"
            barNode.color = "0xE11D7400"
        end if
    end for
end sub

sub requestRokuUserEmail()
    if m.channelStore = invalid then return
    m.channelStore.requestedUserData = "email"
    m.channelStore.command = "getUserData"
end sub

sub onRokuUserData()
    if m.channelStore = invalid then return
    ud = m.channelStore.userData
    if ud <> invalid and ud.email <> invalid and ud.email <> ""
        m.rfiEmail = ud.email.ToStr()
    end if
end sub

sub onDeepLinkArgs(event as Object)
    args = event.getData()
    if args = invalid or args.contentId = invalid or args.contentId.ToStr() = "" then return
    m.pendingDeepLink = {
        contentId: args.contentId.ToStr(),
        mediaType: ""
    }
    if args.mediaType <> invalid then m.pendingDeepLink.mediaType = LCase(args.mediaType.ToStr())
    if m.authToken <> "" and (m.activeView = "browse" or m.activeView = "detail" or m.activeView = "player")
        handlePendingDeepLink()
    end if
end sub

sub handlePendingDeepLink()
    if m.pendingDeepLink = invalid then return
    dl = m.pendingDeepLink
    m.pendingDeepLink = invalid
    rawCid = dl.contentId.Trim()
    if Left(LCase(rawCid), 6) = "local:"
        parts = rawCid.Split(":")
        if parts.Count() >= 3
            libId = parts[1]
            idxVal = Int(Val(parts[2]))
            meta = { title: "Triboon", type: "movie", libId: libId, idx: idxVal }
            startLocalPlayback(libId, idxVal, "Triboon", rawCid, 0, meta)
            return
        end if
    end if
    mType = dl.mediaType
    if mType = "" or mType = "episode" or mType = "series" or mType = "season" then mType = "tv"
    if mType <> "movie" and mType <> "tv" then mType = "movie"
    cid = Val(rawCid)
    if cid > 0
        key = "tmdb:" + mType + ":" + Int(cid).ToStr()
        seasonNum = invalid
        episodeNum = invalid
        if mType = "tv"
            seasonNum = 1
            episodeNum = 1
            key = key + ":s1e1"
        end if
        meta = { title: "Triboon", type: mType, tmdbId: Int(cid) }
        startCatalogPlayback("Triboon", mType, invalid, Int(cid), seasonNum, episodeNum, key, 0, meta)
    end if
end sub

sub showView(name as String)
    m.activeView = name
    m.connectView.visible = (name = "connect")
    m.loginView.visible = (name = "login")
    m.profileView.visible = (name = "profiles")
    m.browseView.visible = (name = "browse")
    m.detailView.visible = (name = "detail")
    m.playerView.visible = (name = "player")

    if name <> "login"
        m.qcPollTimer.control = "stop"
    end if
    if name <> "player"
        m.watchSaveTimer.control = "stop"
    end if

    if name = "connect" or name = "login" or name = "profiles"
        if not m.dialogBeaconOpen
            m.top.signalBeacon("AppDialogInitiate")
            m.dialogBeaconOpen = true
        end if
    else if name = "browse"
        if m.dialogBeaconOpen
            m.top.signalBeacon("AppDialogComplete")
            m.dialogBeaconOpen = false
        end if
    end if

    if name = "connect"
        if m.serverUrl <> ""
            m.connectServerDisplay.text = m.serverUrl
        else
            m.connectServerDisplay.text = "Example: http://192.168.1.50:7777"
        end if
        m.connectButtons.setFocus(true)
    else if name = "login"
        m.loginServerLabel.text = "Server: " + m.serverUrl
        m.loginButtons.setFocus(true)
    else if name = "profiles"
        m.profileList.setFocus(true)
    else if name = "browse"
        updateNavBarVisuals(false)
        m.browseRows.setFocus(true)
    else if name = "detail"
        m.detailButtons.setFocus(true)
    else if name = "player"
        m.videoPlayer.setFocus(true)
    end if
end sub

' =============================================================================
' BACKGROUND API TASK DISPATCH
' =============================================================================

sub apiRequest(tag as String, method as String, path as String, body as Object, authenticated as Boolean, timeoutSec = 15 as Integer)
    task = CreateObject("roSGNode", "TriboonApiTask")
    task.requestTag = tag
    task.method = method
    task.url = m.serverUrl + path
    task.timeoutSec = timeoutSec
    if authenticated then task.token = m.authToken
    if body <> invalid then task.bodyJson = FormatJson(body)
    task.observeField("response", "onApiResponse")
    m.pendingTasks[tag] = task
    task.control = "RUN"
end sub

sub onApiResponse(event as Object)
    res = event.getData()
    if res = invalid then return
    tag = res.tag
    if tag <> invalid and m.pendingTasks.DoesExist(tag)
        m.pendingTasks.Delete(tag)
    end if

    if res.status = 401 and tag <> "login" and tag <> "login_2fa" and tag <> "qc_poll"
        m.authToken = ""
        TriboonRegWrite("authToken", "")
        showView("login")
        m.loginStatus.text = "Session expired. Please sign in again."
        startQuickConnect()
        return
    end if

    if tag = "verify_server"
        handleVerifyServer(res)
    else if tag = "qc_create"
        handleQuickConnectCreate(res)
    else if tag = "qc_poll"
        handleQuickConnectPoll(res)
    else if tag = "login" or tag = "login_2fa"
        handleLoginResponse(res)
    else if tag = "me"
        handleMeResponse(res)
    else if Left(tag, 5) = "home_"
        if tag = "home_libs"
            handleHomeLibrariesList(res)
        else
            handleHomeRowResponse(tag, res)
        end if
    else if Left(tag, 7) = "movies_"
        handleCatalogRowResponse("movies", tag, res)
    else if Left(tag, 3) = "tv_"
        handleCatalogRowResponse("tv", tag, res)
    else if tag = "libraries_list"
        handleLibrariesList(res)
    else if Left(tag, 8) = "lib_row_"
        handleLibraryItemsRow(tag, res)
    else if tag = "local_show_eps"
        handleLocalShowEpisodes(res)
    else if tag = "watch_local_lookup"
        handleWatchLocalLookup(res)
    else if tag = "iptv_channels"
        handleIptvChannels(res)
    else if tag = "iptv_play"
        handleIptvPlay(res)
    else if tag = "search_multi" or tag = "search_local"
        handleSearchResults(tag, res)
    else if tag = "tmdb_detail"
        handleTmdbDetail(res)
    else if tag = "tmdb_season"
        handleTmdbSeason(res)
    else if tag = "play_vod"
        handlePlayVodResponse(res)
    end if
end sub

' =============================================================================
' CONNECT & AUTH FLOWS
' =============================================================================

sub onConnectButton()
    idx = m.connectButtons.buttonSelected
    if idx = 0
        openKeyboardDialog("server_url", "Triboon Server Address", "http://192.168.1.50:7777", m.serverUrl, false)
    else if idx = 1
        verifyAndConnect(m.serverUrl)
    end if
end sub

sub verifyAndConnect(rawUrl as String)
    clean = TriboonNormalizeServerUrl(rawUrl)
    if clean = ""
        m.connectStatus.text = "Enter a valid http:// or https:// Triboon server address."
        return
    end if
    m.serverUrl = clean
    m.connectServerDisplay.text = clean
    m.connectStatus.text = "Checking server..."
    apiRequest("verify_server", "GET", "/api/server", invalid, false, 10)
end sub

sub handleVerifyServer(res as Object)
    if not res.ok or not TriboonIsValidServerInfo(res.data)
        if res.error <> ""
            m.connectStatus.text = res.error
        else
            m.connectStatus.text = "This address did not respond as a Triboon server."
        end if
        return
    end if
    TriboonRegWrite("serverUrl", m.serverUrl)
    m.connectStatus.text = ""
    showView("login")
    startQuickConnect()
end sub

sub startQuickConnect()
    m.qcCode = ""
    m.qcCodeLabel.text = "Requesting..."
    m.loginStatus.text = "Requesting 6-digit Quick Connect code..."
    apiRequest("qc_create", "POST", "/api/quickconnect", { deviceName: "Roku TV" }, false, 10)
end sub

sub handleQuickConnectCreate(res as Object)
    if not res.ok or res.data = invalid or res.data.code = invalid
        m.qcCodeLabel.text = "Unavailable"
        m.loginStatus.text = "Quick Connect unavailable. Use Sign In with Password."
        return
    end if
    m.qcCode = res.data.code.ToStr()
    m.qcCodeLabel.text = m.qcCode
    m.loginStatus.text = "Waiting for approval in Triboon..."
    m.qcPollTimer.control = "start"
end sub

sub onQuickConnectPollTick()
    if m.activeView <> "login" or m.qcCode = "" then return
    apiRequest("qc_poll", "GET", "/api/quickconnect/" + m.qcCode, invalid, false, 8)
end sub

sub handleQuickConnectPoll(res as Object)
    if not res.ok or res.data = invalid then return
    st = ""
    if res.data.status <> invalid then st = LCase(res.data.status.ToStr())
    if st = "approved" and res.data.token <> invalid and res.data.token <> ""
        m.qcPollTimer.control = "stop"
        completeSignIn(res.data.token.ToStr(), res.data.user)
    else if st = "expired"
        m.qcPollTimer.control = "stop"
        m.loginStatus.text = "Code expired. Select New Quick Connect Code."
    end if
end sub

sub onLoginButton()
    idx = m.loginButtons.buttonSelected
    if idx = 0
        startQuickConnect()
    else if idx = 1
        requestRokuUserEmail()
        openKeyboardDialog("login_user", "Username", "Enter Triboon username", m.rfiEmail, false)
    else if idx = 2
        showView("connect")
    end if
end sub

sub handleLoginResponse(res as Object)
    if not res.ok or res.data = invalid
        m.loginStatus.text = res.error
        return
    end if
    if res.data.requiresTwoFactor = true and res.data.challenge <> invalid
        m.pending2faChallenge = res.data.challenge.ToStr()
        openKeyboardDialog("login_2fa", "Two-Factor Code", "Enter 6-digit authenticator code", "", false)
        return
    end if
    if res.data.token <> invalid and res.data.token <> ""
        completeSignIn(res.data.token.ToStr(), res.data.user)
    else
        m.loginStatus.text = "Sign in failed."
    end if
end sub

sub completeSignIn(token as String, userObj as Dynamic)
    m.authToken = token
    TriboonRegWrite("authToken", token)
    if userObj <> invalid
        m.currentUser = userObj
        afterUserLoaded()
    else
        fetchMe()
    end if
end sub

sub fetchMe()
    apiRequest("me", "GET", "/api/me", invalid, true, 12)
end sub

sub handleMeResponse(res as Object)
    if not res.ok or res.data = invalid
        showView("login")
        m.loginStatus.text = res.error
        startQuickConnect()
        return
    end if
    m.currentUser = res.data
    afterUserLoaded()
end sub

sub afterUserLoaded()
    profiles = invalid
    if m.currentUser <> invalid and m.currentUser.profiles <> invalid
        profiles = m.currentUser.profiles
    end if
    if profiles <> invalid and type(profiles) = "roArray" and profiles.Count() > 1
        foundSaved = false
        for each p in profiles
            if p.id <> invalid and p.id.ToStr() = m.profileId
                foundSaved = true
                exit for
            end if
        end for
        if (not foundSaved) or (not m.pickedProfileThisSession and not m.skipProfilePicker)
            openProfilePicker(profiles)
            return
        end if
    else if profiles <> invalid and type(profiles) = "roArray" and profiles.Count() = 1
        if profiles[0].id <> invalid
            m.profileId = profiles[0].id.ToStr()
            TriboonRegWrite("profileId", m.profileId)
        end if
    end if
    showView("browse")
    loadTab("home")
    handlePendingDeepLink()
end sub

sub openProfilePicker(profiles as Object)
    m.profilesListData = profiles
    root = CreateObject("roSGNode", "ContentNode")
    savedIdx = 0
    for i = 0 to profiles.Count() - 1
        p = profiles[i]
        n = root.createChild("ContentNode")
        n.title = TriboonFormatText(p.name)
        if p.id <> invalid and p.id.ToStr() = m.profileId then savedIdx = i
    end for
    m.profileList.content = root
    m.profileList.jumpToItem = savedIdx
    showView("profiles")
end sub

sub onProfileSelected()
    idx = m.profileList.itemSelected
    if m.profilesListData <> invalid and idx >= 0 and idx < m.profilesListData.Count()
        p = m.profilesListData[idx]
        if p.id <> invalid
            m.profileId = p.id.ToStr()
            TriboonRegWrite("profileId", m.profileId)
        end if
    end if
    m.pickedProfileThisSession = true
    showView("browse")
    loadTab("home")
    handlePendingDeepLink()
end sub

' =============================================================================
' BROWSE TABS & ROWS
' =============================================================================

sub loadTab(tabKey as String)
    m.activeTab = tabKey
    for i = 0 to m.tabKeys.Count() - 1
        if m.tabKeys[i] = tabKey then m.navFocusIdx = i
    end for
    updateNavBarVisuals(false)
    m.homeRowsCache = {}
    m.searchCache = {}
    m.browseRows.content = CreateObject("roSGNode", "ContentNode")

    if tabKey = "home"
        m.browseStatus.text = "Loading Home..."
        m.homeLibsMeta = []
        apiRequest("home_watch", "GET", "/api/watch?profile=" + m.profileId, invalid, true, 12)
        apiRequest("home_libs", "GET", "/api/libraries", invalid, true, 12)
        apiRequest("home_trending", "GET", "/api/tmdb/trending/all/day", invalid, true, 12)
        apiRequest("home_movies", "GET", "/api/tmdb/movie/popular", invalid, true, 12)
        apiRequest("home_tv", "GET", "/api/tmdb/tv/popular", invalid, true, 12)
    else if tabKey = "movies"
        m.browseStatus.text = "Loading Movies..."
        apiRequest("movies_pop", "GET", "/api/tmdb/movie/popular", invalid, true, 12)
        apiRequest("movies_now", "GET", "/api/tmdb/movie/now_playing", invalid, true, 12)
        apiRequest("movies_top", "GET", "/api/tmdb/movie/top_rated", invalid, true, 12)
    else if tabKey = "tv"
        m.browseStatus.text = "Loading TV Shows..."
        apiRequest("tv_pop", "GET", "/api/tmdb/tv/popular", invalid, true, 12)
        apiRequest("tv_air", "GET", "/api/tmdb/tv/airing_today", invalid, true, 12)
        apiRequest("tv_top", "GET", "/api/tmdb/tv/top_rated", invalid, true, 12)
    else if tabKey = "libraries"
        m.browseStatus.text = "Loading Libraries..."
        apiRequest("libraries_list", "GET", "/api/libraries", invalid, true, 12)
    else if tabKey = "livetv"
        m.browseStatus.text = "Loading Live TV Channels..."
        apiRequest("iptv_channels", "GET", "/api/iptv/channels", invalid, true, 15)
    else if tabKey = "search"
        m.browseStatus.text = "Enter a movie or show title to search."
        openKeyboardDialog("search_query", "Search Triboon", "Movie or TV show title", "", false)
    else if tabKey = "account"
        renderAccountTab()
    end if
end sub

sub renderAccountTab()
    m.browseStatus.text = "Server: " + m.serverUrl + "  •  Profile: " + m.profileId
    root = CreateObject("roSGNode", "ContentNode")
    row = root.createChild("ContentNode")
    row.title = "Account & Server"
    skipLbl = "Skip Startup Picker: Off"
    if m.skipProfilePicker then skipLbl = "Skip Startup Picker: On"
    actions = [
        { title: "Switch Profile", action: "switch_profile" },
        { title: skipLbl, action: "toggle_skip_picker" },
        { title: "Change Server", action: "change_server" },
        { title: "Sign Out", action: "sign_out" }
    ]
    for each a in actions
        item = row.createChild("ContentNode")
        item.title = a.title
        item.addFields({ itemKind: "account_action", actionId: a.action, rawTitle: a.title })
    end for
    m.browseRows.content = root
    m.browseRows.setFocus(true)
end sub

function smartLibraryDiscoverPath(lib as Object) as String
    mType = "movie"
    if lib.mediaType <> invalid and LCase(lib.mediaType.ToStr()) = "tv" then mType = "tv"
    if lib.kind <> invalid and LCase(lib.kind.ToStr()) = "tv" then mType = "tv"
    sortBy = "popularity.desc"
    if lib.sort <> invalid and lib.sort.ToStr() <> "" then sortBy = lib.sort.ToStr()
    qPath = "/api/tmdb/discover/" + mType + "?sort_by=" + sortBy.EncodeUriComponent()
    if lib.genreId <> invalid and lib.genreId.ToStr() <> ""
        qPath = qPath + "&with_genres=" + lib.genreId.ToStr().EncodeUriComponent()
    end if
    return qPath
end function

sub handleHomeLibrariesList(res as Object)
    if m.activeTab <> "home" then return
    if not res.ok or res.data = invalid then return
    libs = invalid
    if type(res.data) = "roArray"
        libs = res.data
    else if type(res.data) = "roAssociativeArray" and res.data.libraries <> invalid
        libs = res.data.libraries
    end if
    if libs = invalid or type(libs) <> "roArray" then return
    m.homeLibsMeta = libs
    for each lib in m.homeLibsMeta
        if lib.id <> invalid
            if lib.path <> invalid and lib.path.ToStr().Trim() <> ""
                apiRequest("home_lib_" + lib.id.ToStr(), "GET", "/api/libraries/" + lib.id.ToStr() + "/items?offset=0&limit=30", invalid, true, 15)
            else
                apiRequest("home_lib_" + lib.id.ToStr(), "GET", smartLibraryDiscoverPath(lib), invalid, true, 15)
            end if
        end if
    end for
end sub

sub handleHomeRowResponse(tag as String, res as Object)
    if m.activeTab <> "home" then return
    if res.ok and res.data <> invalid
        m.homeRowsCache[tag] = res.data
    end if

    root = CreateObject("roSGNode", "ContentNode")
    if m.homeRowsCache.DoesExist("home_watch")
        addWatchRow(root, "Continue Watching", m.homeRowsCache["home_watch"])
    end if
    if m.homeLibsMeta <> invalid and type(m.homeLibsMeta) = "roArray"
        for each lib in m.homeLibsMeta
            if lib.id <> invalid
                lk = "home_lib_" + lib.id.ToStr()
                if m.homeRowsCache.DoesExist(lk)
                    libData = m.homeRowsCache[lk]
                    if libData.items <> invalid
                        addLocalItemsRow(root, lib, libData.items)
                    else if libData.results <> invalid
                        mType = "movie"
                        if lib.mediaType <> invalid and LCase(lib.mediaType.ToStr()) = "tv" then mType = "tv"
                        addTmdbRow(root, lib.name, libData, mType)
                    end if
                end if
            end if
        end for
    end if
    if m.homeRowsCache.DoesExist("home_trending")
        addTmdbRow(root, "Trending Today", m.homeRowsCache["home_trending"], "")
    end if
    if m.homeRowsCache.DoesExist("home_movies")
        addTmdbRow(root, "Popular Movies", m.homeRowsCache["home_movies"], "movie")
    end if
    if m.homeRowsCache.DoesExist("home_tv")
        addTmdbRow(root, "Popular TV Shows", m.homeRowsCache["home_tv"], "tv")
    end if
    m.browseRows.content = root
    m.browseStatus.text = ""
    if m.activeView = "browse" and not m.navBar.isInFocusChain() then m.browseRows.setFocus(true)
end sub

function localPosterFor(it as Object) as String
    if it = invalid then return ""
    if it.artUrl <> invalid and it.artUrl.ToStr() <> ""
        return TriboonResolveUrl(m.serverUrl, it.artUrl)
    else if it.poster <> invalid and it.poster.ToStr() <> ""
        return TriboonResolveUrl(m.serverUrl, TriboonTmdbImage(it.poster, "w342"))
    else if it.thumbUrl <> invalid and it.thumbUrl.ToStr() <> ""
        return TriboonResolveUrl(m.serverUrl, it.thumbUrl)
    end if
    return ""
end function

sub addLocalItemsRow(root as Object, lib as Object, items as Dynamic)
    if items = invalid or type(items) <> "roArray" or items.Count() = 0 then return
    row = root.createChild("ContentNode")
    rowName = "Library"
    if lib <> invalid and lib.name <> invalid then rowName = lib.name.ToStr()
    row.title = TriboonFormatText(rowName)
    for each it in items
        node = row.createChild("ContentNode")
        rawT = "Untitled"
        if it.title <> invalid and it.title.ToStr() <> "" then rawT = it.title.ToStr()
        node.title = TriboonFormatText(rawT)
        node.HDPosterUrl = localPosterFor(it)
        libIdStr = ""
        if lib <> invalid and lib.id <> invalid
            libIdStr = lib.id.ToStr()
        else if it.libraryId <> invalid
            libIdStr = it.libraryId.ToStr()
        end if
        wk = ""
        if it.watchKey <> invalid and it.watchKey.ToStr() <> "" then wk = it.watchKey.ToStr()
        ovStr = ""
        if it.overview <> invalid then ovStr = it.overview.ToStr()
        yrVal = 0
        if it.year <> invalid then yrVal = Int(Val(it.year.ToStr()))
        locKind = "movie"
        if it.kind <> invalid and it.kind.ToStr() <> "" then locKind = LCase(it.kind.ToStr())
        node.addFields({
            itemKind: "local",
            rawTitle: rawT,
            libId: libIdStr,
            localIdx: Int(Val(it.idx.ToStr())),
            localKind: locKind,
            watchKey: wk,
            year: yrVal,
            overview: ovStr,
            backdropUrl: TriboonResolveUrl(m.serverUrl, TriboonTmdbImage(it.backdrop, "w1280")),
            progress: 0.0
        })
    end for
end sub

sub handleCatalogRowResponse(tabKey as String, tag as String, res as Object)
    if m.activeTab <> tabKey then return
    if res.ok and res.data <> invalid then m.homeRowsCache[tag] = res.data

    root = CreateObject("roSGNode", "ContentNode")
    if tabKey = "movies"
        if m.homeRowsCache.DoesExist("movies_pop") then addTmdbRow(root, "Popular Movies", m.homeRowsCache["movies_pop"], "movie")
        if m.homeRowsCache.DoesExist("movies_now") then addTmdbRow(root, "Now Playing", m.homeRowsCache["movies_now"], "movie")
        if m.homeRowsCache.DoesExist("movies_top") then addTmdbRow(root, "Top Rated Movies", m.homeRowsCache["movies_top"], "movie")
    else
        if m.homeRowsCache.DoesExist("tv_pop") then addTmdbRow(root, "Popular TV Shows", m.homeRowsCache["tv_pop"], "tv")
        if m.homeRowsCache.DoesExist("tv_air") then addTmdbRow(root, "Airing Today", m.homeRowsCache["tv_air"], "tv")
        if m.homeRowsCache.DoesExist("tv_top") then addTmdbRow(root, "Top Rated TV Shows", m.homeRowsCache["tv_top"], "tv")
    end if
    m.browseRows.content = root
    m.browseStatus.text = ""
    if m.activeView = "browse" and not m.navBar.isInFocusChain() then m.browseRows.setFocus(true)
end sub

sub addWatchRow(root as Object, rowTitle as String, watchRows as Dynamic)
    if type(watchRows) <> "roArray" or watchRows.Count() = 0 then return
    row = CreateObject("roSGNode", "ContentNode")
    row.title = TriboonFormatText(rowTitle)
    added = 0
    for each w in watchRows
        if w.watched <> true
            playPos = 0.0
            playDur = 0.0
            if w.position <> invalid then playPos = Val(w.position.ToStr())
            if w.duration <> invalid then playDur = Val(w.duration.ToStr())
            prog = 0.0
            if playDur > 1 then prog = playPos / playDur
            meta = w.meta
            if playPos >= 15 and prog < 0.94 and meta <> invalid
                item = row.createChild("ContentNode")
                rawTitle = "Resume"
                if meta.title <> invalid and meta.title.ToStr() <> "" then rawTitle = meta.title.ToStr()
                displayStr = rawTitle
                if meta.season <> invalid and meta.episode <> invalid
                    if Instr(1, displayStr, "S" + meta.season.ToStr()) = 0
                        displayStr = displayStr + " S" + meta.season.ToStr() + "E" + meta.episode.ToStr()
                    end if
                end if
                item.title = TriboonFormatText(displayStr)
                if meta.poster <> invalid and meta.poster.ToStr() <> ""
                    pRaw = meta.poster.ToStr()
                    if Left(pRaw, 5) = "/api/" or Left(LCase(pRaw), 4) = "http"
                        item.HDPosterUrl = TriboonResolveUrl(m.serverUrl, pRaw)
                    else
                        item.HDPosterUrl = TriboonResolveUrl(m.serverUrl, TriboonTmdbImage(pRaw, "w342"))
                    end if
                end if
                item.addFields({
                    itemKind: "watch",
                    rawTitle: rawTitle,
                    watchKey: w.key,
                    resumePos: Int(playPos),
                    resumeDur: Int(playDur),
                    progress: prog,
                    metaJson: FormatJson(meta)
                })
                added = added + 1
                if added >= 20 then exit for
            end if
        end if
    end for
    if added > 0 then root.appendChild(row)
end sub

sub addTmdbRow(root as Object, rowTitle as String, pageObj as Dynamic, defaultType as String)
    if pageObj = invalid or pageObj.results = invalid or type(pageObj.results) <> "roArray" then return
    row = CreateObject("roSGNode", "ContentNode")
    row.title = TriboonFormatText(rowTitle)
    added = 0
    for each it in pageObj.results
        mType = defaultType
        if it.media_type <> invalid then mType = it.media_type.ToStr()
        if mType <> "person"
            if mType = ""
                if it.name <> invalid and it.title = invalid then mType = "tv" else mType = "movie"
            end if

            titleStr = "Untitled"
            if it.title <> invalid and it.title.ToStr() <> ""
                titleStr = it.title.ToStr()
            else if it.name <> invalid and it.name.ToStr() <> ""
                titleStr = it.name.ToStr()
            end if

            yearVal = 0
            dateStr = ""
            if it.release_date <> invalid then dateStr = it.release_date.ToStr()
            if dateStr = "" and it.first_air_date <> invalid then dateStr = it.first_air_date.ToStr()
            if Len(dateStr) >= 4 then yearVal = Int(Val(Left(dateStr, 4)))

            item = row.createChild("ContentNode")
            item.title = TriboonFormatText(titleStr)
            item.HDPosterUrl = TriboonTmdbImage(it.poster_path, "w342")
            ovStr = ""
            if it.overview <> invalid then ovStr = it.overview.ToStr()
            voteVal = 0.0
            if it.vote_average <> invalid then voteVal = Val(it.vote_average.ToStr())
            item.addFields({
                itemKind: "tmdb",
                rawTitle: titleStr,
                tmdbId: Int(Val(it.id.ToStr())),
                mediaType: mType,
                year: yearVal,
                overview: ovStr,
                backdropUrl: TriboonTmdbImage(it.backdrop_path, "w1280"),
                posterPath: it.poster_path,
                voteAverage: voteVal,
                progress: 0.0
            })
            added = added + 1
            if added >= 24 then exit for
        end if
    end for
    if added > 0 then root.appendChild(row)
end sub

sub handleLibrariesList(res as Object)
    if m.activeTab <> "libraries" then return
    libs = invalid
    if res.ok and res.data <> invalid
        if type(res.data) = "roArray"
            libs = res.data
        else if type(res.data) = "roAssociativeArray" and res.data.libraries <> invalid
            libs = res.data.libraries
        end if
    end if
    if libs = invalid or type(libs) <> "roArray" or libs.Count() = 0
        m.browseStatus.text = "No libraries configured on this Triboon server."
        return
    end if
    m.librariesMeta = libs
    m.homeRowsCache = {}
    for each lib in m.librariesMeta
        if lib.id <> invalid
            if lib.path <> invalid and lib.path.ToStr().Trim() <> ""
                apiRequest("lib_row_" + lib.id.ToStr(), "GET", "/api/libraries/" + lib.id.ToStr() + "/items?offset=0&limit=40", invalid, true, 15)
            else
                apiRequest("lib_row_" + lib.id.ToStr(), "GET", smartLibraryDiscoverPath(lib), invalid, true, 15)
            end if
        end if
    end for
end sub

sub handleLibraryItemsRow(tag as String, res as Object)
    if m.activeTab <> "libraries" then return
    if res.ok and res.data <> invalid then m.homeRowsCache[tag] = res.data

    root = CreateObject("roSGNode", "ContentNode")
    for each lib in m.librariesMeta
        k = "lib_row_" + lib.id.ToStr()
        if m.homeRowsCache.DoesExist(k)
            libData = m.homeRowsCache[k]
            if libData.items <> invalid
                addLocalItemsRow(root, lib, libData.items)
            else if libData.results <> invalid
                mType = "movie"
                if lib.mediaType <> invalid and LCase(lib.mediaType.ToStr()) = "tv" then mType = "tv"
                addTmdbRow(root, lib.name, libData, mType)
            end if
        end if
    end for
    m.browseRows.content = root
    m.browseStatus.text = ""
    if m.activeView = "browse" and not m.navBar.isInFocusChain() then m.browseRows.setFocus(true)
end sub

sub handleIptvChannels(res as Object)
    if m.activeTab <> "livetv" then return
    if not res.ok or res.data = invalid or res.data.channels = invalid or res.data.channels.Count() = 0
        m.browseStatus.text = "No Live TV channels available."
        return
    end if
    m.liveChannels = res.data.channels

    groups = {}
    groupOrder = []
    favList = []
    for each ch in res.data.channels
        if ch.fav = true then favList.Push(ch)
        gName = "All Channels"
        if ch.group <> invalid and ch.group.ToStr().Trim() <> "" then gName = ch.group.ToStr().Trim()
        if not groups.DoesExist(gName)
            groups[gName] = []
            groupOrder.Push(gName)
        end if
        if groups[gName].Count() < 40 then groups[gName].Push(ch)
    end for

    root = CreateObject("roSGNode", "ContentNode")
    if favList.Count() > 0 then addLiveChannelRow(root, "Favorites", favList)
    rowCount = 0
    for each gName in groupOrder
        addLiveChannelRow(root, gName, groups[gName])
        rowCount = rowCount + 1
        if rowCount >= 12 then exit for
    end for
    m.browseRows.content = root
    m.browseStatus.text = ""
    if m.activeView = "browse" and not m.navBar.isInFocusChain() then m.browseRows.setFocus(true)
end sub

sub addLiveChannelRow(root as Object, rowTitle as String, channels as Object)
    row = root.createChild("ContentNode")
    row.title = TriboonFormatText(rowTitle)
    for each ch in channels
        node = row.createChild("ContentNode")
        rawName = "Channel"
        if ch.name <> invalid and ch.name.ToStr() <> "" then rawName = ch.name.ToStr()
        node.title = TriboonFormatText(rawName)
        if ch.logo <> invalid and ch.logo.ToStr() <> ""
            node.HDPosterUrl = TriboonResolveUrl(m.serverUrl, ch.logo)
        end if
        node.addFields({
            itemKind: "livetv",
            rawTitle: rawName,
            channelIdx: Int(Val(ch.idx.ToStr())),
            channelId: ch.id.ToStr(),
            progress: 0.0
        })
    end for
end sub

sub handleSearchResults(tag as String, res as Object)
    if m.activeTab <> "search" then return
    if res.ok and res.data <> invalid
        m.searchCache[tag] = res.data
    end if
    root = CreateObject("roSGNode", "ContentNode")
    if m.searchCache.DoesExist("search_local") and m.searchCache["search_local"].items <> invalid
        addLocalItemsRow(root, { id: "", name: "Local Libraries" }, m.searchCache["search_local"].items)
    end if
    if m.searchCache.DoesExist("search_multi")
        addTmdbRow(root, "Movies & TV", m.searchCache["search_multi"], "")
    end if
    m.browseRows.content = root
    if root.getChildCount() = 0
        if m.searchCache.DoesExist("search_local") and m.searchCache.DoesExist("search_multi")
            m.browseStatus.text = "No matching titles found."
        end if
    else
        m.browseStatus.text = ""
        if not m.navBar.isInFocusChain() then m.browseRows.setFocus(true)
    end if
end sub

' =============================================================================
' SELECTION, DETAIL VIEW & PLAYBACK
' =============================================================================

sub onBrowseItemFocused()
    if m.browseRows = invalid or m.browseRows.content = invalid then return
    foc = m.browseRows.rowItemFocused
    if foc = invalid or foc.Count() < 2 then return
    row = m.browseRows.content.getChild(foc[0])
    if row = invalid then return
    item = row.getChild(foc[1])
    if item = invalid then return

    m.browseHeroTitle.text = item.title
    metaParts = []
    if item.HasField("voteAverage") and item.voteAverage <> invalid and item.voteAverage > 0
        metaParts.Push(Left(item.voteAverage.ToStr(), 3) + "/10")
    end if
    if item.HasField("year") and item.year <> invalid and item.year.ToStr() <> "" and item.year.ToStr() <> "0"
        metaParts.Push(item.year.ToStr())
    end if
    if item.HasField("itemKind") and item.itemKind = "local" and item.HasField("localKind")
        if item.localKind = "show"
            metaParts.Push("Series")
        else
            metaParts.Push("Movie")
        end if
    else if item.HasField("mediaType") and item.mediaType <> invalid and item.mediaType <> ""
        metaParts.Push(UCase(item.mediaType.ToStr()))
    end if
    metaStr = ""
    for each part in metaParts
        if metaStr <> "" then metaStr = metaStr + "  •  "
        metaStr = metaStr + part
    end for
    m.browseHeroMeta.text = metaStr

    ov = ""
    if item.HasField("overview") and item.overview <> invalid then ov = TriboonFormatText(item.overview.ToStr())
    m.browseHeroOverview.text = ov

    bgUrl = ""
    if item.HasField("backdropUrl") and item.backdropUrl <> invalid and item.backdropUrl <> ""
        bgUrl = item.backdropUrl.ToStr()
    else if item.HDPosterUrl <> invalid and item.HDPosterUrl <> ""
        bgUrl = item.HDPosterUrl.ToStr()
    end if
    if m.browseBackdrop <> invalid then m.browseBackdrop.uri = bgUrl
end sub

sub onBrowseItemSelected()
    sel = m.browseRows.rowItemSelected
    if sel = invalid or sel.Count() < 2 then return
    row = m.browseRows.content.getChild(sel[0])
    if row = invalid then return
    item = row.getChild(sel[1])
    if item = invalid then return

    kind = item.itemKind
    rawT = item.title
    if item.HasField("rawTitle") and item.rawTitle <> invalid and item.rawTitle.ToStr() <> ""
        rawT = item.rawTitle.ToStr()
    end if

    if kind = "account_action"
        if item.actionId = "switch_profile"
            if m.currentUser <> invalid and m.currentUser.profiles <> invalid
                openProfilePicker(m.currentUser.profiles)
            end if
        else if item.actionId = "toggle_skip_picker"
            m.skipProfilePicker = not m.skipProfilePicker
            if m.skipProfilePicker
                TriboonRegWrite("skipProfilePicker", "1")
            else
                TriboonRegWrite("skipProfilePicker", "0")
            end if
            renderAccountTab()
        else if item.actionId = "change_server"
            showView("connect")
        else if item.actionId = "sign_out"
            m.authToken = ""
            TriboonRegWrite("authToken", "")
            showView("login")
            startQuickConnect()
        end if
        return
    end if

    if kind = "livetv"
        m.liveChannelPos = -1
        for i = 0 to m.liveChannels.Count() - 1
            ch = m.liveChannels[i]
            if ch <> invalid and ((ch.id <> invalid and ch.id.ToStr() = item.channelId) or ch.idx = item.channelIdx)
                m.liveChannelPos = i
                exit for
            end if
        end for
        tuneLiveChannel(item.channelIdx, item.channelId, rawT)
        return
    end if

    if kind = "watch"
        meta = ParseJson(item.metaJson)
        if meta = invalid then meta = {}
        wKey = ""
        if item.watchKey <> invalid then wKey = item.watchKey.ToStr()
        resumeSec = 0
        if item.resumePos <> invalid then resumeSec = Int(Val(item.resumePos.ToStr()))

        ' Case 1: Local library resume (meta.libId + meta.idx OR legacy "local:<libId>:<idx>" OR modern "local:<libId>:<12hex>")
        locLib = ""
        locIdx = -1
        if meta.libId <> invalid then locLib = meta.libId.ToStr()
        if meta.idx <> invalid and (meta.idx.ToStr() = "0" or Val(meta.idx.ToStr()) > 0)
            locIdx = Int(Val(meta.idx.ToStr()))
        end if
        if Left(LCase(wKey), 6) = "local:"
            parts = wKey.Split(":")
            if parts.Count() >= 3
                if locLib = "" then locLib = parts[1]
                if locIdx < 0 and isDigitsOnly(parts[2])
                    locIdx = Int(Val(parts[2]))
                end if
            end if
        end if
        if locLib <> "" and locIdx >= 0
            startLocalPlayback(locLib, locIdx, rawT, wKey, resumeSec, meta)
            return
        end if
        if Left(LCase(wKey), 6) = "local:"
            m.browseStatus.text = "Locating library file..."
            m.pendingWatchResume = { wKey: wKey, resumeSec: resumeSec, title: rawT, meta: meta }
            apiRequest("watch_local_lookup", "GET", "/api/libraries/local-lookup?key=" + wKey.EncodeUriComponent(), invalid, true, 12)
            return
        end if

        ' Case 2: Catalog / TMDB resume (meta.tmdbId OR key "tmdb:movie:<id>" / "tmdb:tv:<id>:s<S>e<E>")
        mType = "movie"
        if meta.type <> invalid
            rawType = LCase(meta.type.ToStr())
            if rawType = "tv" or rawType = "episode" or rawType = "show" or rawType = "series" then mType = "tv"
        end if
        tmdbNum = 0
        if meta.tmdbId <> invalid then tmdbNum = Int(Val(meta.tmdbId.ToStr()))
        seaNum = invalid
        epNum = invalid
        if meta.season <> invalid then seaNum = Int(Val(meta.season.ToStr()))
        if meta.episode <> invalid then epNum = Int(Val(meta.episode.ToStr()))
        if Left(LCase(wKey), 5) = "tmdb:"
            parts = wKey.Split(":")
            if parts.Count() >= 3
                if LCase(parts[1]) = "tv" then mType = "tv"
                if tmdbNum <= 0 then tmdbNum = Int(Val(parts[2]))
            end if
            if parts.Count() >= 4
                se = LCase(parts[3])
                ePos = Instr(1, se, "e")
                if Left(se, 1) = "s" and ePos > 2
                    if seaNum = invalid then seaNum = Int(Val(Mid(se, 2, ePos - 2)))
                    if epNum = invalid then epNum = Int(Val(Mid(se, ePos + 1)))
                end if
            end if
        end if
        qTitle = rawT
        if meta.showTitle <> invalid and meta.showTitle.ToStr() <> ""
            qTitle = meta.showTitle.ToStr()
        else if meta.title <> invalid and meta.title.ToStr() <> ""
            qTitle = meta.title.ToStr()
        end if
        dashIdx = Instr(1, qTitle, " — S")
        if dashIdx > 1 then qTitle = Left(qTitle, dashIdx - 1)
        yearNum = invalid
        if meta.year <> invalid and Val(meta.year.ToStr()) > 0 then yearNum = Int(Val(meta.year.ToStr()))
        if tmdbNum > 0
            startCatalogPlayback(qTitle, mType, yearNum, tmdbNum, seaNum, epNum, wKey, resumeSec, meta)
        else
            m.browseStatus.text = "Open this item from its library to resume."
        end if
        return
    end if

    if kind = "local"
        if item.localKind = "show"
            openLocalShowDetail(item, rawT)
        else
            openLocalMovieDetail(item, rawT)
        end if
        return
    end if

    if kind = "tmdb"
        openTmdbDetail(item, rawT)
    end if
end sub

function isDigitsOnly(s as String) as Boolean
    if s = "" then return false
    for i = 1 to Len(s)
        c = Asc(Mid(s, i, 1))
        if c < 48 or c > 57 then return false
    end for
    return true
end function

sub handleWatchLocalLookup(res as Object)
    if m.pendingWatchResume = invalid then return
    req = m.pendingWatchResume
    m.pendingWatchResume = invalid
    if not res.ok or res.data = invalid or res.data.items = invalid
        m.browseStatus.text = "Open this item from its library to resume."
        return
    end if
    found = res.data.items[req.wKey]
    if found = invalid
        for each k in res.data.items
            found = res.data.items[k]
            exit for
        end for
    end if
    if found = invalid or found.idx = invalid
        m.browseStatus.text = "Open this item from its library to resume."
        return
    end if
    parts = req.wKey.Split(":")
    locLib = ""
    if parts.Count() >= 2 then locLib = parts[1]
    if found.libraryId <> invalid and found.libraryId.ToStr() <> "" then locLib = found.libraryId.ToStr()
    locIdx = Int(Val(found.idx.ToStr()))
    titleStr = req.title
    if found.title <> invalid and found.title.ToStr() <> "" then titleStr = found.title.ToStr()
    if locLib <> "" and locIdx >= 0
        startLocalPlayback(locLib, locIdx, titleStr, req.wKey, req.resumeSec, req.meta)
    else
        m.browseStatus.text = "Open this item from its library to resume."
    end if
end sub

sub openTmdbDetail(item as Object, rawTitle as String)
    m.detailContext = {
        kind: "tmdb",
        tmdbId: Int(Val(item.tmdbId.ToStr())),
        mediaType: item.mediaType,
        title: rawTitle,
        year: Int(Val(item.year.ToStr())),
        posterPath: item.posterPath,
        backdropUrl: item.backdropUrl,
        overview: item.overview,
        activeSeason: 1,
        seasons: []
    }
    m.detailTitle.text = TriboonFormatText(rawTitle)
    metaTxt = UCase(item.mediaType)
    if item.year <> invalid and item.year > 0 then metaTxt = metaTxt + "  •  " + item.year.ToStr()
    if item.HasField("voteAverage") and item.voteAverage <> invalid and item.voteAverage > 0
        metaTxt = metaTxt + "  •  " + Left(item.voteAverage.ToStr(), 3) + "/10"
    end if
    m.detailMeta.text = metaTxt
    if item.overview <> invalid then m.detailOverview.text = TriboonFormatText(item.overview.ToStr()) else m.detailOverview.text = ""
    m.detailPoster.uri = item.HDPosterUrl
    m.detailBackdrop.uri = item.backdropUrl
    m.detailStatus.text = ""
    m.episodeRows.visible = false
    if item.mediaType = "tv"
        m.detailButtons.buttons = ["Play S1 E1", "Back"]
        m.detailStatus.text = "Loading seasons & episodes..."
    else
        m.detailButtons.buttons = ["Play", "Back"]
    end if
    showView("detail")
    apiRequest("tmdb_detail", "GET", "/api/tmdb/" + item.mediaType + "/" + m.detailContext.tmdbId.ToStr() + "?append_to_response=credits", invalid, true, 12)
end sub

sub handleTmdbDetail(res as Object)
    if m.activeView <> "detail" or m.detailContext = invalid or not res.ok or res.data = invalid then return
    d = res.data
    if d.overview <> invalid and d.overview.ToStr() <> ""
        m.detailContext.overview = d.overview.ToStr()
        m.detailOverview.text = TriboonFormatText(d.overview.ToStr())
    end if
    if m.detailContext.mediaType = "tv" and d.seasons <> invalid and type(d.seasons) = "roArray"
        validSeasons = []
        for each s in d.seasons
            if s.season_number <> invalid and Int(Val(s.season_number.ToStr())) >= 1
                validSeasons.Push(Int(Val(s.season_number.ToStr())))
            end if
        end for
        if validSeasons.Count() = 0 then validSeasons.Push(1)
        m.detailContext.seasons = validSeasons
        firstSeason = validSeasons[0]
        m.detailContext.activeSeason = firstSeason
        updateTmdbTvButtons()
        apiRequest("tmdb_season", "GET", "/api/tmdb/tv/" + m.detailContext.tmdbId.ToStr() + "/season/" + firstSeason.ToStr(), invalid, true, 12)
    end if
end sub

sub updateTmdbTvButtons()
    if m.detailContext = invalid or m.detailContext.kind <> "tmdb" or m.detailContext.mediaType <> "tv" then return
    sNum = m.detailContext.activeSeason
    if sNum = invalid or sNum < 1 then sNum = 1
    seasons = m.detailContext.seasons
    if seasons <> invalid and seasons.Count() > 1
        m.detailButtons.buttons = ["Play S" + sNum.ToStr() + " E1", "Season " + sNum.ToStr() + " of " + seasons.Count().ToStr(), "Back"]
    else
        m.detailButtons.buttons = ["Play S" + sNum.ToStr() + " E1", "Back"]
    end if
end sub

sub openSeasonPickerDialog()
    if m.detailContext = invalid or m.detailContext.seasons = invalid or m.detailContext.seasons.Count() < 2 then return
    dlg = CreateObject("roSGNode", "StandardMessageDialog")
    dlg.title = "Select Season"
    dlg.message = ["Choose a season for " + TriboonFormatText(m.detailContext.title)]
    btns = []
    for each sNum in m.detailContext.seasons
        btns.Push("Season " + sNum.ToStr())
    end for
    dlg.buttons = btns
    dlg.observeField("buttonSelected", "onSeasonDialogButton")
    m.top.dialog = dlg
end sub

sub onSeasonDialogButton()
    dlg = m.top.dialog
    if dlg = invalid then return
    idx = dlg.buttonSelected
    m.top.dialog = invalid
    if m.detailContext = invalid or m.detailContext.seasons = invalid then return
    if idx >= 0 and idx < m.detailContext.seasons.Count()
        picked = m.detailContext.seasons[idx]
        m.detailContext.activeSeason = picked
        updateTmdbTvButtons()
        m.detailStatus.text = "Loading Season " + picked.ToStr() + "..."
        apiRequest("tmdb_season", "GET", "/api/tmdb/tv/" + m.detailContext.tmdbId.ToStr() + "/season/" + picked.ToStr(), invalid, true, 12)
    end if
end sub

sub handleTmdbSeason(res as Object)
    if m.activeView <> "detail" or m.detailContext = invalid or not res.ok or res.data = invalid or res.data.episodes = invalid then return
    root = CreateObject("roSGNode", "ContentNode")
    row = root.createChild("ContentNode")
    seaNum = 1
    if m.detailContext.activeSeason <> invalid then seaNum = Int(Val(m.detailContext.activeSeason.ToStr()))
    row.title = "Season " + seaNum.ToStr() + " (" + res.data.episodes.Count().ToStr() + " Episodes)"
    for each ep in res.data.episodes
        n = row.createChild("ContentNode")
        epNum = Int(Val(ep.episode_number.ToStr()))
        epRaw = "Episode " + epNum.ToStr()
        if ep.name <> invalid and ep.name.ToStr() <> "" then epRaw = "E" + epNum.ToStr() + " • " + ep.name.ToStr()
        n.title = TriboonFormatText(epRaw)
        if ep.still_path <> invalid and ep.still_path.ToStr() <> ""
            n.HDPosterUrl = TriboonTmdbImage(ep.still_path, "w500")
        else if m.detailContext.posterPath <> invalid and m.detailContext.posterPath.ToStr() <> ""
            n.HDPosterUrl = TriboonTmdbImage(m.detailContext.posterPath, "w342")
        end if
        epOv = ""
        if ep.overview <> invalid then epOv = ep.overview.ToStr()
        n.addFields({
            epKind: "tmdb_ep",
            rawTitle: epRaw,
            seasonNum: seaNum,
            episodeNum: epNum,
            epTitle: ep.name,
            epOverview: epOv,
            progress: 0.0
        })
    end for
    m.episodeRows.content = root
    m.episodeRows.visible = true
    m.detailStatus.text = "Press DOWN to choose an episode"
end sub

sub openLocalMovieDetail(item as Object, rawTitle as String)
    wk = ""
    if item.HasField("watchKey") and item.watchKey <> invalid then wk = item.watchKey.ToStr()
    m.detailContext = {
        kind: "local_movie",
        libId: item.libId,
        localIdx: Int(Val(item.localIdx.ToStr())),
        watchKey: wk,
        title: rawTitle,
        year: Int(Val(item.year.ToStr())),
        posterUrl: item.HDPosterUrl
    }
    m.detailTitle.text = TriboonFormatText(rawTitle)
    metaTxt = "LOCAL LIBRARY"
    if item.year <> invalid and item.year > 0 then metaTxt = metaTxt + "  •  " + item.year.ToStr()
    m.detailMeta.text = metaTxt
    if item.overview <> invalid then m.detailOverview.text = TriboonFormatText(item.overview.ToStr()) else m.detailOverview.text = ""
    m.detailPoster.uri = item.HDPosterUrl
    m.detailBackdrop.uri = item.backdropUrl
    m.detailStatus.text = ""
    m.episodeRows.visible = false
    m.detailButtons.buttons = ["Play", "Back"]
    showView("detail")
end sub

sub openLocalShowDetail(item as Object, rawTitle as String)
    m.detailContext = {
        kind: "local_show",
        libId: item.libId,
        showIdx: Int(Val(item.localIdx.ToStr())),
        title: rawTitle,
        overview: item.overview,
        posterUrl: item.HDPosterUrl,
        firstEp: invalid
    }
    m.detailTitle.text = TriboonFormatText(rawTitle)
    m.detailMeta.text = "LOCAL SERIES"
    if item.overview <> invalid then m.detailOverview.text = TriboonFormatText(item.overview.ToStr()) else m.detailOverview.text = ""
    m.detailPoster.uri = item.HDPosterUrl
    m.detailBackdrop.uri = item.backdropUrl
    m.detailStatus.text = "Loading episodes..."
    m.episodeRows.visible = false
    m.detailButtons.buttons = ["Play Episode 1", "Back"]
    showView("detail")
    apiRequest("local_show_eps", "GET", "/api/libraries/" + item.libId + "/items?showIdx=" + m.detailContext.showIdx.ToStr() + "&limit=200", invalid, true, 15)
end sub

sub handleLocalShowEpisodes(res as Object)
    if m.activeView <> "detail" or m.detailContext = invalid or not res.ok or res.data = invalid or res.data.items = invalid then return
    items = res.data.items
    if items.Count() = 0
        m.detailStatus.text = "No playable episodes found for this series."
        return
    end if

    ' Group episodes by season number when present
    seasonBuckets = {}
    seasonOrder = []
    firstEp = invalid
    for each ep in items
        if firstEp = invalid then firstEp = ep
        sKey = "Episodes"
        if ep.s <> invalid and Int(Val(ep.s.ToStr())) > 0
            sKey = "Season " + Int(Val(ep.s.ToStr())).ToStr()
        end if
        if not seasonBuckets.DoesExist(sKey)
            seasonBuckets[sKey] = []
            seasonOrder.Push(sKey)
        end if
        seasonBuckets[sKey].Push(ep)
    end for

    m.detailContext.firstEp = firstEp
    playLbl = "Play Episode 1"
    if firstEp <> invalid and firstEp.s <> invalid and firstEp.e <> invalid
        playLbl = "Play S" + Int(Val(firstEp.s.ToStr())).ToStr() + " E" + Int(Val(firstEp.e.ToStr())).ToStr()
    end if
    m.detailButtons.buttons = [playLbl, "Back"]

    root = CreateObject("roSGNode", "ContentNode")
    for each sKey in seasonOrder
        row = root.createChild("ContentNode")
        epList = seasonBuckets[sKey]
        row.title = sKey + " (" + epList.Count().ToStr() + ")"
        for each ep in epList
            n = row.createChild("ContentNode")
            lbl = "Episode"
            if ep.title <> invalid and ep.title.ToStr() <> "" then lbl = ep.title.ToStr()
            if ep.s <> invalid and ep.e <> invalid
                lbl = "S" + Int(Val(ep.s.ToStr())).ToStr() + "E" + Int(Val(ep.e.ToStr())).ToStr() + " • " + lbl
            end if
            n.title = TriboonFormatText(lbl)
            epImg = localPosterFor(ep)
            if epImg = "" and m.detailContext.posterUrl <> invalid then epImg = m.detailContext.posterUrl
            n.HDPosterUrl = epImg
            epWk = ""
            if ep.watchKey <> invalid and ep.watchKey.ToStr() <> "" then epWk = ep.watchKey.ToStr()
            epOv = ""
            if ep.overview <> invalid then epOv = ep.overview.ToStr()
            n.addFields({
                epKind: "local_ep",
                rawTitle: lbl,
                libId: m.detailContext.libId,
                localIdx: Int(Val(ep.idx.ToStr())),
                watchKey: epWk,
                epOverview: epOv,
                progress: 0.0
            })
        end for
    end for
    m.episodeRows.content = root
    m.episodeRows.visible = true
    m.detailStatus.text = items.Count().ToStr() + " episodes — press DOWN to browse"
end sub

sub onEpisodeItemFocused()
    if m.episodeRows = invalid or m.episodeRows.content = invalid then return
    foc = m.episodeRows.rowItemFocused
    if foc = invalid or foc.Count() < 2 then return
    row = m.episodeRows.content.getChild(foc[0])
    if row = invalid then return
    ep = row.getChild(foc[1])
    if ep = invalid then return
    m.detailStatus.text = ep.title
    if ep.HasField("epOverview") and ep.epOverview <> invalid and ep.epOverview.ToStr() <> ""
        m.detailOverview.text = TriboonFormatText(ep.epOverview.ToStr())
    else if m.detailContext <> invalid and m.detailContext.overview <> invalid
        m.detailOverview.text = TriboonFormatText(m.detailContext.overview.ToStr())
    end if
end sub

sub onDetailButton()
    idx = m.detailButtons.buttonSelected
    if m.detailContext = invalid then return

    if m.detailContext.kind = "local_show"
        if idx = 0
            ep = m.detailContext.firstEp
            if ep = invalid
                m.detailStatus.text = "Still loading episodes..."
                return
            end if
            epIdx = Int(Val(ep.idx.ToStr()))
            key = "local:" + m.detailContext.libId + ":" + epIdx.ToStr()
            if ep.watchKey <> invalid and ep.watchKey.ToStr() <> "" then key = ep.watchKey.ToStr()
            epTitle = m.detailContext.title
            if ep.title <> invalid and ep.title.ToStr() <> "" then epTitle = ep.title.ToStr()
            meta = { title: epTitle, showTitle: m.detailContext.title, type: "tv", libId: m.detailContext.libId, idx: epIdx }
            if ep.s <> invalid then meta.season = Int(Val(ep.s.ToStr()))
            if ep.e <> invalid then meta.episode = Int(Val(ep.e.ToStr()))
            startLocalPlayback(m.detailContext.libId, epIdx, epTitle, key, 0, meta)
        else
            showView("browse")
        end if
        return
    end if

    if m.detailContext.kind = "local_movie"
        if idx = 1
            showView("browse")
            return
        end if
        key = "local:" + m.detailContext.libId + ":" + m.detailContext.localIdx.ToStr()
        if m.detailContext.watchKey <> invalid and m.detailContext.watchKey <> "" then key = m.detailContext.watchKey
        meta = { title: m.detailContext.title, type: "movie", libId: m.detailContext.libId, idx: m.detailContext.localIdx }
        startLocalPlayback(m.detailContext.libId, m.detailContext.localIdx, m.detailContext.title, key, 0, meta)
        return
    end if

    if m.detailContext.kind = "tmdb"
        hasSeasonBtn = (m.detailContext.mediaType = "tv" and m.detailContext.seasons <> invalid and m.detailContext.seasons.Count() > 1)
        if hasSeasonBtn and idx = 1
            openSeasonPickerDialog()
            return
        end if
        if (hasSeasonBtn and idx = 2) or (not hasSeasonBtn and idx = 1)
            showView("browse")
            return
        end if

        seasonNum = invalid
        episodeNum = invalid
        key = "tmdb:" + m.detailContext.mediaType + ":" + m.detailContext.tmdbId.ToStr()
        if m.detailContext.mediaType = "tv"
            seasonNum = 1
            if m.detailContext.activeSeason <> invalid and m.detailContext.activeSeason >= 1
                seasonNum = Int(Val(m.detailContext.activeSeason.ToStr()))
            end if
            episodeNum = 1
            key = key + ":s" + seasonNum.ToStr() + "e1"
        end if
        meta = {
            title: m.detailContext.title,
            type: m.detailContext.mediaType,
            tmdbId: m.detailContext.tmdbId,
            year: m.detailContext.year,
            poster: m.detailContext.posterPath
        }
        if seasonNum <> invalid then meta.season = seasonNum
        if episodeNum <> invalid then meta.episode = episodeNum
        startCatalogPlayback(m.detailContext.title, m.detailContext.mediaType, m.detailContext.year, m.detailContext.tmdbId, seasonNum, episodeNum, key, 0, meta)
    end if
end sub

sub onEpisodeItemSelected()
    sel = m.episodeRows.rowItemSelected
    if sel = invalid or sel.Count() < 2 then return
    row = m.episodeRows.content.getChild(sel[0])
    if row = invalid then return
    ep = row.getChild(sel[1])
    if ep = invalid then return

    rawEpTitle = ep.title
    if ep.HasField("rawTitle") and ep.rawTitle <> invalid and ep.rawTitle.ToStr() <> ""
        rawEpTitle = ep.rawTitle.ToStr()
    end if

    if ep.epKind = "local_ep"
        key = "local:" + ep.libId + ":" + ep.localIdx.ToStr()
        if ep.HasField("watchKey") and ep.watchKey <> invalid and ep.watchKey.ToStr() <> "" then key = ep.watchKey.ToStr()
        meta = { title: rawEpTitle, showTitle: m.detailContext.title, type: "tv", libId: ep.libId, idx: ep.localIdx }
        startLocalPlayback(ep.libId, ep.localIdx, rawEpTitle, key, 0, meta)
    else if ep.epKind = "tmdb_ep"
        seaNum = Int(Val(ep.seasonNum.ToStr()))
        epNum = Int(Val(ep.episodeNum.ToStr()))
        key = "tmdb:tv:" + m.detailContext.tmdbId.ToStr() + ":s" + seaNum.ToStr() + "e" + epNum.ToStr()
        meta = {
            title: m.detailContext.title,
            episodeTitle: ep.epTitle,
            type: "tv",
            tmdbId: m.detailContext.tmdbId,
            season: seaNum,
            episode: epNum,
            poster: m.detailContext.posterPath
        }
        dispTitle = m.detailContext.title + " S" + seaNum.ToStr() + "E" + epNum.ToStr()
        startCatalogPlayback(m.detailContext.title, "tv", m.detailContext.year, m.detailContext.tmdbId, seaNum, epNum, key, 0, meta, dispTitle)
    end if
end sub

sub startCatalogPlayback(title as String, mType as String, yearVal as Dynamic, tmdbId as Integer, seasonVal as Dynamic, epVal as Dynamic, watchKey as String, startSec as Integer, meta as Object, displayTitle = "" as String)
    m.detailStatus.text = "Finding best healthy stream..."
    if m.activeView = "browse" then m.browseStatus.text = "Finding best healthy stream..."
    shownTitle = title
    if displayTitle <> "" then shownTitle = displayTitle
    m.playContext = { kind: "vod", title: shownTitle, watchKey: watchKey, startSec: startSec, hlsOffsetSec: 0, meta: meta }
    body = {
        q: title,
        mediaType: mType,
        tmdbId: tmdbId,
        profileId: m.profileId,
        client: "roku",
        caps: TriboonRokuCaps()
    }
    if yearVal <> invalid and Int(Val(yearVal.ToStr())) > 0 then body.year = Int(Val(yearVal.ToStr()))
    if seasonVal <> invalid then body.season = Int(Val(seasonVal.ToStr()))
    if epVal <> invalid then body.ep = Int(Val(epVal.ToStr()))
    apiRequest("play_vod", "POST", "/api/play", body, true, 60)
end sub

sub startLocalPlayback(libId as String, localIdx as Integer, title as String, watchKey as String, startSec as Integer, meta as Object)
    m.detailStatus.text = "Starting playback..."
    if m.activeView = "browse" then m.browseStatus.text = "Starting playback..."
    m.playContext = { kind: "vod", title: title, watchKey: watchKey, startSec: startSec, hlsOffsetSec: 0, meta: meta }
    body = { profileId: m.profileId, client: "roku", caps: TriboonRokuCaps() }
    apiRequest("play_vod", "POST", "/api/local/" + libId + "/" + localIdx.ToStr() + "/play", body, true, 30)
end sub

function friendlyRokuError(raw as Dynamic, fallback as String) as String
    if raw = invalid then return fallback
    s = raw.ToStr().Trim()
    if s = "" then return fallback
    lower = LCase(s)
    if Instr(1, lower, "timed out") > 0 or Instr(1, lower, "timeout") > 0 or Instr(1, lower, "could not connect") > 0 or Instr(1, lower, "network") > 0
        return "Could not reach the server. Check your connection."
    end if
    if Instr(1, lower, "http 502") > 0 or Instr(1, lower, "http 503") > 0 or Instr(1, lower, "http 504") > 0
        return "Server is temporarily unavailable. Try again."
    end if
    if Instr(1, lower, "http 401") > 0 or Instr(1, lower, "unauthorized") > 0
        return "Session expired. Please sign in again."
    end if
    if Len(s) > 120 then s = Left(s, 117) + "..."
    return s
end function

sub handlePlayVodResponse(res as Object)
    if not res.ok or res.data = invalid
        errMsg = friendlyRokuError(res.error, "Playback could not start.")
        m.detailStatus.text = errMsg
        if m.activeView = "browse" then m.browseStatus.text = errMsg
        return
    end if
    startSec = 0
    if m.playContext <> invalid then startSec = m.playContext.startSec
    m.vodCandidates = TriboonOrderedVodStreams(m.serverUrl, res.data, startSec)
    m.vodCandidateIdx = 0
    if m.vodCandidates.Count() = 0
        m.detailStatus.text = "This title isn't playable right now."
        if m.activeView = "browse" then m.browseStatus.text = "This title isn't playable right now."
        return
    end if
    m.detailStatus.text = ""
    m.browseStatus.text = ""
    cand = m.vodCandidates[0]
    startNativeVideo(cand.url, cand.streamFormat, m.playContext.title, false, startSec)
end sub

sub handleIptvPlay(res as Object)
    if not res.ok or res.data = invalid
        m.browseStatus.text = friendlyRokuError(res.error, "Live TV channel is unavailable.")
        return
    end if
    m.liveCandidates = TriboonOrderedLiveStreams(m.serverUrl, res.data)
    m.liveCandidateIdx = 0
    if m.liveCandidates.Count() = 0
        m.browseStatus.text = "Live TV channel is unavailable right now."
        return
    end if
    m.browseStatus.text = ""
    cand = m.liveCandidates[0]
    startNativeVideo(cand.url, cand.streamFormat, m.playContext.title, true, 0)
end sub

sub tuneLiveChannel(channelIdx as Integer, channelId as String, title as String)
    fmtTitle = TriboonFormatText(title)
    m.browseStatus.text = "Tuning " + fmtTitle + "..."
    m.playerTitle.text = fmtTitle
    m.playerStatus.text = "Tuning..."
    if m.activeView = "player" then m.playerOverlay.visible = true
    m.playContext = { kind: "livetv", title: title, watchKey: "", startSec: 0, hlsOffsetSec: 0 }
    cid = channelId.EncodeUriComponent()
    apiRequest("iptv_play", "GET", "/api/iptv/play/" + channelIdx.ToStr() + "?cid=" + cid, invalid, true, 15)
end sub

sub stepLiveChannel(delta as Integer)
    if m.liveChannels = invalid or m.liveChannels.Count() < 2 then return
    n = m.liveChannels.Count()
    if m.liveChannelPos < 0 then m.liveChannelPos = 0
    m.liveChannelPos = (m.liveChannelPos + delta + n) mod n
    ch = m.liveChannels[m.liveChannelPos]
    if ch = invalid then return
    cid = ""
    if ch.id <> invalid then cid = ch.id.ToStr()
    chName = "Channel"
    if ch.name <> invalid and ch.name.ToStr() <> "" then chName = ch.name.ToStr()
    tuneLiveChannel(Int(Val(ch.idx.ToStr())), cid, chName)
end sub

sub startNativeVideo(url as String, streamFormat as String, title as String, isLive as Boolean, startSec as Integer)
    content = CreateObject("roSGNode", "ContentNode")
    content.url = url
    content.streamFormat = streamFormat
    content.title = TriboonFormatText(title)
    content.live = isLive
    content.HttpCertificatesFile = "common:/certs/ca-bundle.crt"
    if not isLive and startSec > 1 and streamFormat = "mp4"
        content.playStart = startSec
        if m.playContext <> invalid then m.playContext.hlsOffsetSec = 0
    else if not isLive and startSec > 1 and Instr(1, url, "&start=") > 0
        if m.playContext <> invalid then m.playContext.hlsOffsetSec = startSec
    else
        if m.playContext <> invalid then m.playContext.hlsOffsetSec = 0
    end if

    m.playerTitle.text = TriboonFormatText(title)
    m.playerStatus.text = "Buffering..."
    m.playerOverlay.visible = true
    showView("player")

    m.videoPlayer.content = content
    m.videoPlayer.control = "play"
    if not isLive then m.watchSaveTimer.control = "start"
end sub

sub onVideoStateChanged()
    st = m.videoPlayer.state
    if st = "playing"
        m.playerOverlay.visible = false
    else if st = "buffering"
        m.playerStatus.text = "Buffering..."
        m.playerOverlay.visible = true
    else if st = "finished"
        saveWatchProgress(true)
        stopPlayerAndReturn()
    else if st = "error"
        if m.playContext <> invalid and m.playContext.kind = "livetv"
            m.liveCandidateIdx = m.liveCandidateIdx + 1
            if m.liveCandidateIdx < m.liveCandidates.Count()
                cand = m.liveCandidates[m.liveCandidateIdx]
                m.playerStatus.text = "Reconnecting channel..."
                startNativeVideo(cand.url, cand.streamFormat, m.playContext.title, true, 0)
                return
            end if
        else if m.playContext <> invalid and m.playContext.kind = "vod"
            m.vodCandidateIdx = m.vodCandidateIdx + 1
            if m.vodCandidateIdx < m.vodCandidates.Count()
                cand = m.vodCandidates[m.vodCandidateIdx]
                m.playerStatus.text = "Optimizing stream for Roku..."
                startNativeVideo(cand.url, cand.streamFormat, m.playContext.title, false, m.playContext.startSec)
                return
            end if
        end if
        errDetail = ""
        if m.videoPlayer.errorMsg <> invalid and m.videoPlayer.errorMsg <> ""
            errDetail = " (" + m.videoPlayer.errorMsg.ToStr() + ")"
        end if
        m.playerStatus.text = "Playback could not continue" + errDetail + ". Press Back to return."
        m.playerOverlay.visible = true
    end if
end sub

sub onWatchSaveTick()
    if m.activeView = "player" then saveWatchProgress(false)
end sub

sub saveWatchProgress(finished as Boolean)
    if m.playContext = invalid or m.playContext.kind <> "vod" or m.playContext.watchKey = "" then return
    offsetSec = 0
    if m.playContext.hlsOffsetSec <> invalid then offsetSec = m.playContext.hlsOffsetSec
    playPos = m.videoPlayer.position + offsetSec
    playDur = m.videoPlayer.duration
    if offsetSec > 0 and playDur > 0 then playDur = playDur + offsetSec
    if playPos < 5 and not finished then return
    isWatched = finished
    if playDur > 1 and (playPos / playDur) >= 0.94 then isWatched = true

    payload = {
        key: m.playContext.watchKey,
        profile: m.profileId,
        position: playPos,
        duration: playDur,
        watched: isWatched
    }
    if m.playContext.meta <> invalid then payload.meta = m.playContext.meta
    apiRequest("watch_save", "POST", "/api/watch", payload, true, 10)
end sub

sub stopPlayerAndReturn()
    m.watchSaveTimer.control = "stop"
    m.videoPlayer.control = "stop"
    m.videoPlayer.content = invalid
    if m.playContext <> invalid and m.playContext.kind = "livetv"
        showView("browse")
    else if m.detailContext <> invalid
        showView("detail")
    else
        showView("browse")
        if m.activeTab = "home"
            apiRequest("home_watch", "GET", "/api/watch?profile=" + m.profileId, invalid, true, 12)
        end if
    end if
end sub

' =============================================================================
' KEYBOARD DIALOGS & REMOTE NAVIGATION
' =============================================================================

sub openKeyboardDialog(purpose as String, title as String, hint as String, initialText as String, secure as Boolean)
    m.keyboardPurpose = purpose
    dlg = CreateObject("roSGNode", "StandardKeyboardDialog")
    dlg.title = title
    dlg.message = [hint]
    dlg.buttons = ["OK", "Cancel"]
    if initialText <> invalid and initialText <> "" then dlg.text = initialText
    if secure
        dlg.textEditBox.secureMode = true
        dlg.keyboardDomain = "password"
    else if purpose = "login_user"
        dlg.keyboardDomain = "email"
    else if purpose = "login_2fa"
        dlg.keyboardDomain = "pin"
    end if
    dlg.observeField("buttonSelected", "onKeyboardDialogButton")
    m.top.dialog = dlg
end sub

sub onKeyboardDialogButton()
    dlg = m.top.dialog
    if dlg = invalid then return
    idx = dlg.buttonSelected
    inputVal = dlg.text.Trim()
    m.top.dialog = invalid
    if idx <> 0 then return

    if m.keyboardPurpose = "server_url"
        verifyAndConnect(inputVal)
    else if m.keyboardPurpose = "login_user"
        m.pendingLoginName = inputVal
        openKeyboardDialog("login_pass", "Password", "Enter password for " + inputVal, "", true)
    else if m.keyboardPurpose = "login_pass"
        m.loginStatus.text = "Signing in..."
        apiRequest("login", "POST", "/api/login", { name: m.pendingLoginName, password: inputVal }, false, 12)
    else if m.keyboardPurpose = "login_2fa"
        m.loginStatus.text = "Verifying 2FA code..."
        apiRequest("login_2fa", "POST", "/api/login/2fa", { challenge: m.pending2faChallenge, code: inputVal }, false, 12)
    else if m.keyboardPurpose = "search_query"
        if inputVal <> ""
            m.searchCache = {}
            m.browseStatus.text = "Searching for """ + TriboonFormatText(inputVal) + """..."
            qEnc = inputVal.EncodeUriComponent()
            apiRequest("search_local", "GET", "/api/libraries/search?q=" + qEnc, invalid, true, 12)
            apiRequest("search_multi", "GET", "/api/tmdb/search/multi?query=" + qEnc, invalid, true, 12)
        end if
    end if
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false

    if key = "options" and m.activeView = "browse"
        loadTab("search")
        return true
    end if

    if m.activeView = "browse"
        if m.navBar.isInFocusChain()
            if key = "left"
                if m.navFocusIdx > 0 then m.navFocusIdx = m.navFocusIdx - 1
                updateNavBarVisuals(true)
                return true
            else if key = "right"
                if m.navFocusIdx < m.tabKeys.Count() - 1 then m.navFocusIdx = m.navFocusIdx + 1
                updateNavBarVisuals(true)
                return true
            else if key = "OK"
                loadTab(m.tabKeys[m.navFocusIdx])
                return true
            else if key = "down"
                updateNavBarVisuals(false)
                m.browseRows.setFocus(true)
                return true
            end if
        else if key = "up" and m.browseRows.isInFocusChain()
            m.navBar.setFocus(true)
            updateNavBarVisuals(true)
            return true
        end if
    else if m.activeView = "detail"
        if key = "down" and m.detailButtons.isInFocusChain() and m.episodeRows.visible
            m.episodeRows.setFocus(true)
            return true
        else if key = "up" and m.episodeRows.isInFocusChain()
            m.detailButtons.setFocus(true)
            return true
        end if
    else if m.activeView = "player" and m.playContext <> invalid and m.playContext.kind = "livetv"
        if key = "up" or key = "channelup"
            stepLiveChannel(-1)
            return true
        else if key = "down" or key = "channeldown"
            stepLiveChannel(1)
            return true
        end if
    end if

    if key = "back"
        if m.activeView = "player"
            saveWatchProgress(false)
            stopPlayerAndReturn()
            return true
        else if m.activeView = "detail"
            showView("browse")
            if m.activeTab = "home"
                apiRequest("home_watch", "GET", "/api/watch?profile=" + m.profileId, invalid, true, 12)
            end if
            return true
        else if m.activeView = "profiles"
            showView("browse")
            return true
        else if m.activeView = "login"
            showView("connect")
            return true
        else if m.activeView = "browse" and m.navBar.isInFocusChain()
            updateNavBarVisuals(false)
            m.browseRows.setFocus(true)
            return true
        else if m.activeView = "browse" and m.activeTab <> "home"
            loadTab("home")
            return true
        end if
    end if

    return false
end function
