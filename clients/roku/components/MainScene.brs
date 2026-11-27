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
    m.qcCode = ""
    m.pendingLoginName = ""
    m.pending2faChallenge = ""
    m.detailContext = invalid
    m.playContext = invalid
    m.liveCandidates = []
    m.liveCandidateIdx = 0
    m.liveChannels = []
    m.liveChannelPos = -1
    m.pendingTasks = {}
    m.homeRowsCache = {}

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
    m.navTabs = m.top.findNode("navTabs")
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
end sub

sub setupControls()
    m.connectButtons.buttons = ["Enter Server Address", "Connect"]
    m.connectButtons.observeField("buttonSelected", "onConnectButton")

    m.loginButtons.buttons = ["New Quick Connect Code", "Sign In with Password", "Change Server"]
    m.loginButtons.observeField("buttonSelected", "onLoginButton")

    m.profileList.observeField("itemSelected", "onProfileSelected")

    tabNames = ["Home", "Movies", "TV Shows", "Libraries", "Live TV", "Search", "Account"]
    tabKeys = ["home", "movies", "tv", "libraries", "livetv", "search", "account"]
    m.tabKeys = tabKeys
    tabContent = CreateObject("roSGNode", "ContentNode")
    for each t in tabNames
        n = tabContent.createChild("ContentNode")
        n.title = t
    end for
    m.navTabs.content = tabContent
    m.navTabs.observeField("itemSelected", "onNavTabSelected")

    m.browseRows.observeField("rowItemSelected", "onBrowseItemSelected")
    m.detailButtons.observeField("buttonSelected", "onDetailButton")
    m.episodeRows.observeField("rowItemSelected", "onEpisodeItemSelected")

    m.videoPlayer.observeField("state", "onVideoStateChanged")
    m.qcPollTimer.observeField("fire", "onQuickConnectPollTick")
    m.watchSaveTimer.observeField("fire", "onWatchSaveTick")
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
        handleHomeRowResponse(tag, res)
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
    else if tag = "iptv_channels"
        handleIptvChannels(res)
    else if tag = "iptv_play"
        handleIptvPlay(res)
    else if tag = "search_multi"
        handleSearchResults(res)
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
        openKeyboardDialog("login_user", "Username", "Enter Triboon username", "", false)
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
end sub

sub openProfilePicker(profiles as Object)
    m.profilesListData = profiles
    root = CreateObject("roSGNode", "ContentNode")
    savedIdx = 0
    for i = 0 to profiles.Count() - 1
        p = profiles[i]
        n = root.createChild("ContentNode")
        n.title = p.name
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
end sub

' =============================================================================
' BROWSE TABS & ROWS
' =============================================================================

sub onNavTabSelected()
    idx = m.navTabs.itemSelected
    if idx >= 0 and idx < m.tabKeys.Count()
        loadTab(m.tabKeys[idx])
    end if
end sub

sub loadTab(tabKey as String)
    m.activeTab = tabKey
    m.homeRowsCache = {}
    m.browseRows.content = CreateObject("roSGNode", "ContentNode")

    if tabKey = "home"
        m.browseStatus.text = "Loading Home..."
        apiRequest("home_watch", "GET", "/api/watch?profile=" + m.profileId, invalid, true, 12)
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
        m.browseStatus.text = "Loading Local Libraries..."
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
        item.addFields({ itemKind: "account_action", actionId: a.action })
    end for
    m.browseRows.content = root
    m.browseRows.setFocus(true)
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
    if m.activeView = "browse" then m.browseRows.setFocus(true)
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
    if m.activeView = "browse" then m.browseRows.setFocus(true)
end sub

sub addWatchRow(root as Object, rowTitle as String, watchRows as Dynamic)
    if type(watchRows) <> "roArray" or watchRows.Count() = 0 then return
    row = CreateObject("roSGNode", "ContentNode")
    row.title = rowTitle
    added = 0
    for each w in watchRows
        if w.watched <> true
            playPos = 0.0
            playDur = 0.0
            if w.position <> invalid then playPos = w.position
            if w.duration <> invalid then playDur = w.duration
            prog = 0.0
            if playDur > 1 then prog = playPos / playDur
            meta = w.meta
            if playPos >= 15 and prog < 0.94 and meta <> invalid
                item = row.createChild("ContentNode")
                titleStr = "Resume"
                if meta.title <> invalid then titleStr = meta.title.ToStr()
                if meta.season <> invalid and meta.episode <> invalid
                    titleStr = titleStr + " S" + meta.season.ToStr() + "E" + meta.episode.ToStr()
                end if
                item.title = titleStr
                if meta.poster <> invalid and meta.poster <> ""
                    item.HDPosterUrl = TriboonResolveUrl(m.serverUrl, TriboonTmdbImage(meta.poster, "w342"))
                end if
                item.addFields({
                    itemKind: "watch",
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
    row.title = rowTitle
    added = 0
    for each it in pageObj.results
        mType = defaultType
        if it.media_type <> invalid then mType = it.media_type.ToStr()
        if mType <> "person"
            if mType = ""
                if it.name <> invalid and it.title = invalid then mType = "tv" else mType = "movie"
            end if

            titleStr = "Untitled"
            if it.title <> invalid and it.title <> ""
                titleStr = it.title.ToStr()
            else if it.name <> invalid and it.name <> ""
                titleStr = it.name.ToStr()
            end if

            yearVal = 0
            dateStr = ""
            if it.release_date <> invalid then dateStr = it.release_date.ToStr()
            if dateStr = "" and it.first_air_date <> invalid then dateStr = it.first_air_date.ToStr()
            if Len(dateStr) >= 4 then yearVal = Val(Left(dateStr, 4))

            item = row.createChild("ContentNode")
            item.title = titleStr
            item.HDPosterUrl = TriboonTmdbImage(it.poster_path, "w342")
            item.addFields({
                itemKind: "tmdb",
                tmdbId: it.id,
                mediaType: mType,
                year: yearVal,
                overview: it.overview,
                backdropUrl: TriboonTmdbImage(it.backdrop_path, "w1280"),
                posterPath: it.poster_path,
                voteAverage: it.vote_average,
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
    if not res.ok or res.data = invalid or res.data.libraries = invalid or res.data.libraries.Count() = 0
        m.browseStatus.text = "No local libraries configured on this Triboon server."
        return
    end if
    m.librariesMeta = res.data.libraries
    m.homeRowsCache = {}
    for each lib in m.librariesMeta
        if lib.id <> invalid
            apiRequest("lib_row_" + lib.id.ToStr(), "GET", "/api/libraries/" + lib.id.ToStr() + "/items?offset=0&limit=40", invalid, true, 15)
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
            items = m.homeRowsCache[k].items
            if items <> invalid and type(items) = "roArray" and items.Count() > 0
                row = root.createChild("ContentNode")
                row.title = lib.name
                for each it in items
                    node = row.createChild("ContentNode")
                    node.title = it.title
                    poster = ""
                    if it.artUrl <> invalid and it.artUrl <> ""
                        poster = TriboonResolveUrl(m.serverUrl, it.artUrl)
                    else if it.poster <> invalid and it.poster <> ""
                        poster = TriboonResolveUrl(m.serverUrl, TriboonTmdbImage(it.poster, "w342"))
                    end if
                    node.HDPosterUrl = poster
                    node.addFields({
                        itemKind: "local",
                        libId: lib.id.ToStr(),
                        localIdx: it.idx,
                        localKind: it.kind,
                        year: it.year,
                        overview: it.overview,
                        backdropUrl: TriboonResolveUrl(m.serverUrl, TriboonTmdbImage(it.backdrop, "w1280")),
                        progress: 0.0
                    })
                end for
            end if
        end if
    end for
    m.browseRows.content = root
    m.browseStatus.text = ""
    if m.activeView = "browse" then m.browseRows.setFocus(true)
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
    if m.activeView = "browse" then m.browseRows.setFocus(true)
end sub

sub addLiveChannelRow(root as Object, rowTitle as String, channels as Object)
    row = root.createChild("ContentNode")
    row.title = rowTitle
    for each ch in channels
        node = row.createChild("ContentNode")
        node.title = ch.name
        if ch.logo <> invalid and ch.logo <> ""
            node.HDPosterUrl = TriboonResolveUrl(m.serverUrl, ch.logo)
        end if
        node.addFields({
            itemKind: "livetv",
            channelIdx: ch.idx,
            channelId: ch.id.ToStr(),
            progress: 0.0
        })
    end for
end sub

sub handleSearchResults(res as Object)
    if m.activeTab <> "search" then return
    if not res.ok or res.data = invalid
        m.browseStatus.text = res.error
        return
    end if
    root = CreateObject("roSGNode", "ContentNode")
    addTmdbRow(root, "Search Results", res.data, "")
    m.browseRows.content = root
    if root.getChildCount() = 0
        m.browseStatus.text = "No matching titles found."
    else
        m.browseStatus.text = ""
        m.browseRows.setFocus(true)
    end if
end sub

' =============================================================================
' SELECTION, DETAIL VIEW & PLAYBACK
' =============================================================================

sub onBrowseItemSelected()
    sel = m.browseRows.rowItemSelected
    if sel = invalid or sel.Count() < 2 then return
    row = m.browseRows.content.getChild(sel[0])
    if row = invalid then return
    item = row.getChild(sel[1])
    if item = invalid then return

    kind = item.itemKind
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
        tuneLiveChannel(item.channelIdx, item.channelId, item.title)
        return
    end if

    if kind = "watch"
        meta = ParseJson(item.metaJson)
        if meta <> invalid
            if meta.libId <> invalid and meta.idx <> invalid
                startLocalPlayback(meta.libId.ToStr(), meta.idx, item.title, item.watchKey, item.resumePos, meta)
            else if meta.tmdbId <> invalid
                mType = "movie"
                if meta.type <> invalid then mType = meta.type.ToStr()
                startCatalogPlayback(meta.title, mType, meta.year, meta.tmdbId, meta.season, meta.episode, item.watchKey, item.resumePos, meta)
            end if
        end if
        return
    end if

    if kind = "local"
        if item.localKind = "show"
            openLocalShowDetail(item)
        else
            openLocalMovieDetail(item)
        end if
        return
    end if

    if kind = "tmdb"
        openTmdbDetail(item)
    end if
end sub

sub openTmdbDetail(item as Object)
    m.detailContext = {
        kind: "tmdb",
        tmdbId: item.tmdbId,
        mediaType: item.mediaType,
        title: item.title,
        year: item.year,
        posterPath: item.posterPath,
        backdropUrl: item.backdropUrl
    }
    m.detailTitle.text = item.title
    metaTxt = UCase(item.mediaType)
    if item.year <> invalid and item.year > 0 then metaTxt = metaTxt + "  •  " + item.year.ToStr()
    m.detailMeta.text = metaTxt
    if item.overview <> invalid then m.detailOverview.text = item.overview.ToStr() else m.detailOverview.text = ""
    m.detailPoster.uri = item.HDPosterUrl
    m.detailBackdrop.uri = item.backdropUrl
    m.detailStatus.text = ""
    m.episodeRows.visible = false
    if item.mediaType = "tv"
        m.detailButtons.buttons = ["Play S1 E1", "Back"]
    else
        m.detailButtons.buttons = ["Play", "Back"]
    end if
    showView("detail")
    apiRequest("tmdb_detail", "GET", "/api/tmdb/" + item.mediaType + "/" + item.tmdbId.ToStr() + "?append_to_response=credits", invalid, true, 12)
end sub

sub handleTmdbDetail(res as Object)
    if m.activeView <> "detail" or not res.ok or res.data = invalid then return
    d = res.data
    if d.overview <> invalid and d.overview <> "" then m.detailOverview.text = d.overview.ToStr()
    if m.detailContext.mediaType = "tv" and d.seasons <> invalid and type(d.seasons) = "roArray"
        firstSeason = 1
        for each s in d.seasons
            if s.season_number <> invalid and s.season_number >= 1
                firstSeason = s.season_number
                exit for
            end if
        end for
        m.detailContext.activeSeason = firstSeason
        apiRequest("tmdb_season", "GET", "/api/tmdb/tv/" + m.detailContext.tmdbId.ToStr() + "/season/" + firstSeason.ToStr(), invalid, true, 12)
    end if
end sub

sub handleTmdbSeason(res as Object)
    if m.activeView <> "detail" or not res.ok or res.data = invalid or res.data.episodes = invalid then return
    root = CreateObject("roSGNode", "ContentNode")
    row = root.createChild("ContentNode")
    sNum = 1
    if m.detailContext.activeSeason <> invalid then sNum = m.detailContext.activeSeason
    row.title = "Season " + sNum.ToStr()
    for each ep in res.data.episodes
        n = row.createChild("ContentNode")
        epName = "Episode " + ep.episode_number.ToStr()
        if ep.name <> invalid and ep.name <> "" then epName = "E" + ep.episode_number.ToStr() + " • " + ep.name.ToStr()
        n.title = epName
        n.HDPosterUrl = TriboonTmdbImage(ep.still_path, "w500")
        n.addFields({
            epKind: "tmdb_ep",
            seasonNum: sNum,
            episodeNum: ep.episode_number,
            epTitle: ep.name,
            progress: 0.0
        })
    end for
    m.episodeRows.content = root
    m.episodeRows.visible = true
end sub

sub openLocalMovieDetail(item as Object)
    m.detailContext = {
        kind: "local_movie",
        libId: item.libId,
        localIdx: item.localIdx,
        title: item.title,
        year: item.year
    }
    m.detailTitle.text = item.title
    m.detailMeta.text = "LOCAL LIBRARY"
    if item.overview <> invalid then m.detailOverview.text = item.overview.ToStr() else m.detailOverview.text = ""
    m.detailPoster.uri = item.HDPosterUrl
    m.detailBackdrop.uri = item.backdropUrl
    m.detailStatus.text = ""
    m.episodeRows.visible = false
    m.detailButtons.buttons = ["Play", "Back"]
    showView("detail")
end sub

sub openLocalShowDetail(item as Object)
    m.detailContext = {
        kind: "local_show",
        libId: item.libId,
        showIdx: item.localIdx,
        title: item.title
    }
    m.detailTitle.text = item.title
    m.detailMeta.text = "LOCAL SERIES"
    if item.overview <> invalid then m.detailOverview.text = item.overview.ToStr() else m.detailOverview.text = ""
    m.detailPoster.uri = item.HDPosterUrl
    m.detailBackdrop.uri = item.backdropUrl
    m.detailStatus.text = "Loading episodes..."
    m.episodeRows.visible = false
    m.detailButtons.buttons = ["Back"]
    showView("detail")
    apiRequest("local_show_eps", "GET", "/api/libraries/" + item.libId + "/items?showIdx=" + item.localIdx.ToStr() + "&limit=60", invalid, true, 12)
end sub

sub handleLocalShowEpisodes(res as Object)
    if m.activeView <> "detail" or not res.ok or res.data = invalid or res.data.items = invalid then return
    root = CreateObject("roSGNode", "ContentNode")
    row = root.createChild("ContentNode")
    row.title = "Episodes"
    for each ep in res.data.items
        n = row.createChild("ContentNode")
        lbl = ep.title
        if ep.s <> invalid and ep.e <> invalid
            lbl = "S" + ep.s.ToStr() + "E" + ep.e.ToStr() + " • " + lbl
        end if
        n.title = lbl
        if ep.thumbUrl <> invalid and ep.thumbUrl <> ""
            n.HDPosterUrl = TriboonResolveUrl(m.serverUrl, ep.thumbUrl)
        else if ep.artUrl <> invalid and ep.artUrl <> ""
            n.HDPosterUrl = TriboonResolveUrl(m.serverUrl, ep.artUrl)
        end if
        n.addFields({
            epKind: "local_ep",
            libId: m.detailContext.libId,
            localIdx: ep.idx,
            progress: 0.0
        })
    end for
    m.episodeRows.content = root
    m.episodeRows.visible = true
    m.detailStatus.text = ""
end sub

sub onDetailButton()
    idx = m.detailButtons.buttonSelected
    if m.detailContext = invalid then return
    if m.detailContext.kind = "local_show" or idx = 1
        showView("browse")
        return
    end if

    if m.detailContext.kind = "local_movie"
        key = "local:" + m.detailContext.libId + ":" + m.detailContext.localIdx.ToStr()
        meta = { title: m.detailContext.title, type: "movie", libId: m.detailContext.libId, idx: m.detailContext.localIdx }
        startLocalPlayback(m.detailContext.libId, m.detailContext.localIdx, m.detailContext.title, key, 0, meta)
    else if m.detailContext.kind = "tmdb"
        seasonNum = invalid
        episodeNum = invalid
        key = "tmdb:" + m.detailContext.mediaType + ":" + m.detailContext.tmdbId.ToStr()
        if m.detailContext.mediaType = "tv"
            seasonNum = 1
            episodeNum = 1
            key = key + ":s1e1"
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

    if ep.epKind = "local_ep"
        key = "local:" + ep.libId + ":" + ep.localIdx.ToStr()
        meta = { title: ep.title, type: "tv", libId: ep.libId, idx: ep.localIdx }
        startLocalPlayback(ep.libId, ep.localIdx, ep.title, key, 0, meta)
    else if ep.epKind = "tmdb_ep"
        key = "tmdb:tv:" + m.detailContext.tmdbId.ToStr() + ":s" + ep.seasonNum.ToStr() + "e" + ep.episodeNum.ToStr()
        meta = {
            title: m.detailContext.title,
            episodeTitle: ep.epTitle,
            type: "tv",
            tmdbId: m.detailContext.tmdbId,
            season: ep.seasonNum,
            episode: ep.episodeNum,
            poster: m.detailContext.posterPath
        }
        startCatalogPlayback(m.detailContext.title, "tv", m.detailContext.year, m.detailContext.tmdbId, ep.seasonNum, ep.episodeNum, key, 0, meta)
    end if
end sub

sub startCatalogPlayback(title as String, mType as String, yearVal as Dynamic, tmdbId as Integer, seasonVal as Dynamic, epVal as Dynamic, watchKey as String, startSec as Integer, meta as Object)
    m.detailStatus.text = "Finding best healthy stream..."
    m.playContext = { kind: "vod", title: title, watchKey: watchKey, startSec: startSec, meta: meta }
    body = {
        title: title,
        type: mType,
        tmdbId: tmdbId,
        profileId: m.profileId,
        caps: TriboonRokuCaps()
    }
    if yearVal <> invalid and yearVal > 0 then body.year = yearVal
    if seasonVal <> invalid then body.season = seasonVal
    if epVal <> invalid then body.episode = epVal
    apiRequest("play_vod", "POST", "/api/play", body, true, 60)
end sub

sub startLocalPlayback(libId as String, localIdx as Integer, title as String, watchKey as String, startSec as Integer, meta as Object)
    m.detailStatus.text = "Starting playback..."
    m.playContext = { kind: "vod", title: title, watchKey: watchKey, startSec: startSec, meta: meta }
    body = { profileId: m.profileId, caps: TriboonRokuCaps() }
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
        m.detailStatus.text = friendlyRokuError(res.error, "Playback could not start.")
        return
    end if
    startSec = 0
    if m.playContext <> invalid then startSec = m.playContext.startSec
    stream = TriboonPreferredVodStream(m.serverUrl, res.data, startSec)
    if stream.url = ""
        m.detailStatus.text = "This title isn't playable right now."
        return
    end if
    m.detailStatus.text = ""
    startNativeVideo(stream.url, stream.streamFormat, m.playContext.title, false, startSec)
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
    m.browseStatus.text = "Tuning " + title + "..."
    m.playerTitle.text = title
    m.playerStatus.text = "Tuning " + title + "..."
    if m.activeView = "player" then m.playerOverlay.visible = true
    m.playContext = { kind: "livetv", title: title, watchKey: "", startSec: 0 }
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
    tuneLiveChannel(ch.idx, cid, chName)
end sub

sub startNativeVideo(url as String, streamFormat as String, title as String, isLive as Boolean, startSec as Integer)
    content = CreateObject("roSGNode", "ContentNode")
    content.url = url
    content.streamFormat = streamFormat
    content.title = title
    content.live = isLive
    if not isLive and startSec > 1 and streamFormat = "mp4"
        content.playStart = startSec
    end if

    m.playerTitle.text = title
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
        end if
        m.playerStatus.text = "Playback could not continue. Press Back to return."
        m.playerOverlay.visible = true
    end if
end sub

sub onWatchSaveTick()
    if m.activeView = "player" then saveWatchProgress(false)
end sub

sub saveWatchProgress(finished as Boolean)
    if m.playContext = invalid or m.playContext.kind <> "vod" or m.playContext.watchKey = "" then return
    playPos = m.videoPlayer.position
    playDur = m.videoPlayer.duration
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
    end if
end sub

' =============================================================================
' KEYBOARD DIALOGS & REMOTE BACK NAVIGATION
' =============================================================================

sub openKeyboardDialog(purpose as String, title as String, hint as String, initialText as String, secure as Boolean)
    m.keyboardPurpose = purpose
    dlg = CreateObject("roSGNode", "KeyboardDialog")
    dlg.title = title
    dlg.message = [hint]
    dlg.buttons = ["OK", "Cancel"]
    if initialText <> invalid and initialText <> "" then dlg.text = initialText
    if secure then dlg.keyboard.textEditBox.secureMode = true
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
            m.browseStatus.text = "Searching for """ + inputVal + """..."
            apiRequest("search_multi", "GET", "/api/tmdb/search/multi?query=" + inputVal.EncodeUriComponent(), invalid, true, 12)
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
        if key = "up" and m.browseRows.hasFocus()
            m.navTabs.setFocus(true)
            return true
        else if key = "down" and m.navTabs.hasFocus()
            m.browseRows.setFocus(true)
            return true
        end if
    else if m.activeView = "detail"
        if key = "down" and m.detailButtons.hasFocus() and m.episodeRows.visible
            m.episodeRows.setFocus(true)
            return true
        else if key = "up" and m.episodeRows.hasFocus()
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
            return true
        else if m.activeView = "profiles"
            showView("browse")
            return true
        else if m.activeView = "login"
            showView("connect")
            return true
        else if m.activeView = "browse" and m.activeTab <> "home"
            loadTab("home")
            return true
        end if
    end if

    return false
end function
