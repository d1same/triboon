import SwiftUI
import TriboonCore

struct TVHomeView: View {
    @ObservedObject var appState: TVAppState

    var body: some View {
        TabView {
            NavigationStack {
                TVHomeShelfTab(appState: appState)
            }
            .tabItem { Label("Home", systemImage: "house.fill") }

            NavigationStack {
                TVCatalogGridTab(
                    appState: appState,
                    title: "Movies",
                    items: appState.trendingMovies + appState.popularMovies
                )
            }
            .tabItem { Label("Movies", systemImage: "film.fill") }

            NavigationStack {
                TVCatalogGridTab(
                    appState: appState,
                    title: "Shows",
                    items: appState.trendingShows + appState.popularShows
                )
            }
            .tabItem { Label("Shows", systemImage: "tv.fill") }

            if !appState.libraries.isEmpty {
                NavigationStack {
                    TVLibrariesTab(appState: appState)
                }
                .tabItem { Label("Libraries", systemImage: "folder.fill") }
            }

            if !appState.iptvChannels.isEmpty {
                NavigationStack {
                    TVLiveTab(appState: appState)
                }
                .tabItem { Label("Live TV", systemImage: "dot.radiowaves.left.and.right") }
            }

            NavigationStack {
                TVSearchTab(appState: appState)
            }
            .tabItem { Label("Search", systemImage: "magnifyingglass") }

            NavigationStack {
                TVSettingsTab(appState: appState)
            }
            .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
    }
}

private struct TVHomeShelfTab: View {
    @ObservedObject var appState: TVAppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 44) {
                if !appState.continueWatching.isEmpty {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Continue Watching")
                            .font(.title2.bold())
                            .foregroundStyle(.white)
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyHStack(spacing: 34) {
                                ForEach(appState.continueWatching) { row in
                                    Button {
                                        Task { await resumeWatchRow(row) }
                                    } label: {
                                        TVPosterCard(
                                            title: row.meta?.title ?? row.key,
                                            subtitle: rowSubtitle(row),
                                            imageURL: rowPosterURL(row),
                                            progress: row.progress
                                        )
                                    }
                                    .buttonStyle(.card)
                                }
                            }
                            .padding(.vertical, 20)
                        }
                    }
                }

                if !appState.trendingMovies.isEmpty {
                    catalogRow(title: "Trending Movies", items: appState.trendingMovies)
                }
                if !appState.trendingShows.isEmpty {
                    catalogRow(title: "Trending Shows", items: appState.trendingShows)
                }
            }
            .padding(56)
        }
    }

    private func catalogRow(title: String, items: [TMDBTitle]) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(title)
                .font(.title2.bold())
                .foregroundStyle(.white)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 34) {
                    ForEach(items) { item in
                        NavigationLink {
                            TVDetailView(appState: appState, item: item)
                        } label: {
                            TVPosterCard(
                                title: item.displayTitle,
                                subtitle: item.year.map(String.init),
                                imageURL: item.posterURL(),
                                progress: nil
                            )
                        }
                        .buttonStyle(.card)
                    }
                }
                .padding(.vertical, 20)
            }
        }
    }

    private func rowSubtitle(_ row: WatchRow) -> String {
        if let s = row.meta?.season, let e = row.meta?.episode {
            return "S\(s)E\(e) · \(Int(row.position / 60))m"
        }
        return "\(Int(row.position / 60))m watched"
    }

    private func rowPosterURL(_ row: WatchRow) -> URL? {
        guard let p = row.meta?.poster, !p.isEmpty else { return nil }
        if p.hasPrefix("/") {
            return URL(string: "https://image.tmdb.org/t/p/w500\(p)")
        }
        return URL(string: p)
    }

    private func resumeWatchRow(_ row: WatchRow) async {
        if let meta = row.meta, let libId = meta.libId, let idx = meta.idx {
            let item = LocalItem(
                idx: idx,
                showIdx: nil,
                kind: meta.type == "tv" ? "episode" : "movie",
                title: meta.title ?? "Video",
                epTitle: meta.episodeTitle,
                year: meta.year,
                s: meta.season,
                e: meta.episode,
                runtime: row.duration / 60,
                overview: nil,
                poster: meta.poster,
                backdrop: meta.backdrop,
                artUrl: nil,
                thumbUrl: nil,
                tmdbId: meta.tmdbId,
                episodeCount: nil
            )
            await appState.playLocalItem(libId: libId, item: item, resumeAt: row.position)
            return
        }
        if let meta = row.meta, let tmdbId = meta.tmdbId {
            let title = TMDBTitle(
                id: tmdbId,
                mediaType: meta.type == "tv" ? "tv" : "movie",
                title: meta.type == "tv" ? nil : meta.title,
                name: meta.type == "tv" ? meta.title : nil,
                overview: nil,
                posterPath: meta.poster,
                backdropPath: meta.backdrop,
                releaseDate: meta.year.map { "\($0)-01-01" },
                firstAirDate: meta.year.map { "\($0)-01-01" },
                voteAverage: nil,
                runtime: nil,
                numberOfSeasons: nil,
                seasons: nil
            )
            if meta.type == "tv", let s = meta.season, let e = meta.episode {
                let ep = TMDBEpisode(id: nil, episodeNumber: e, seasonNumber: s, name: meta.episodeTitle, overview: nil, stillPath: nil, runtime: nil, airDate: nil)
                await appState.playCatalogEpisode(show: title, season: s, episode: ep, resumeAt: row.position)
            } else {
                await appState.playCatalogMovie(title, resumeAt: row.position)
            }
        }
    }
}

private struct TVCatalogGridTab: View {
    @ObservedObject var appState: TVAppState
    let title: String
    let items: [TMDBTitle]

    private let columns = [GridItem(.adaptive(minimum: 250, maximum: 280), spacing: 38)]

    var body: some View {
        let deduped = uniqueTitles(items)
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text(title)
                    .font(.largeTitle.bold())
                    .foregroundStyle(.white)
                LazyVGrid(columns: columns, spacing: 44) {
                    ForEach(deduped) { item in
                        NavigationLink {
                            TVDetailView(appState: appState, item: item)
                        } label: {
                            TVPosterCard(
                                title: item.displayTitle,
                                subtitle: item.year.map(String.init),
                                imageURL: item.posterURL(),
                                progress: nil
                            )
                        }
                        .buttonStyle(.card)
                    }
                }
            }
            .padding(56)
        }
    }

    private func uniqueTitles(_ list: [TMDBTitle]) -> [TMDBTitle] {
        var seen = Set<Int>()
        return list.filter { seen.insert($0.id).inserted }
    }
}

private struct TVLibrariesTab: View {
    @ObservedObject var appState: TVAppState
    @State private var selectedLib: LocalLibrary?
    @State private var items: [LocalItem] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            HStack(spacing: 18) {
                ForEach(appState.libraries) { lib in
                    Button(lib.name) {
                        selectedLib = lib
                        Task { await loadLibrary(lib) }
                    }
                }
            }

            if let lib = selectedLib ?? appState.libraries.first {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 250, maximum: 280), spacing: 38)], spacing: 44) {
                        ForEach(items) { item in
                            if item.isShow {
                                NavigationLink {
                                    TVLocalShowView(appState: appState, libId: lib.id, show: item)
                                } label: {
                                    TVPosterCard(title: item.title, subtitle: item.year.map(String.init), imageURL: localArtURL(item), progress: nil)
                                }
                                .buttonStyle(.card)
                            } else {
                                Button {
                                    Task { await appState.playLocalItem(libId: lib.id, item: item) }
                                } label: {
                                    TVPosterCard(title: item.title, subtitle: item.year.map(String.init), imageURL: localArtURL(item), progress: nil)
                                }
                                .buttonStyle(.card)
                            }
                        }
                    }
                }
                .task(id: lib.id) {
                    await loadLibrary(lib)
                }
            }
        }
        .padding(56)
    }

    private func loadLibrary(_ lib: LocalLibrary) async {
        guard let api = appState.api else { return }
        if let resp = try? await api.fetchLibraryItems(libId: lib.id, offset: 0, limit: 80) {
            items = resp.items
        }
    }

    private func localArtURL(_ item: LocalItem) -> URL? {
        guard let origin = appState.serverOrigin else { return nil }
        if let art = item.artUrl, let u = URL(string: "\(origin)\(art)") { return u }
        if let thumb = item.thumbUrl, let u = URL(string: "\(origin)\(thumb)") { return u }
        if let p = item.poster, p.hasPrefix("/") { return URL(string: "https://image.tmdb.org/t/p/w500\(p)") }
        return nil
    }
}

private struct TVLocalShowView: View {
    @ObservedObject var appState: TVAppState
    let libId: String
    let show: LocalItem
    @State private var episodes: [LocalItem] = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text(show.title)
                    .font(.largeTitle.bold())
                    .foregroundStyle(.white)
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(episodes) { ep in
                        Button {
                            Task { await appState.playLocalItem(libId: libId, item: ep) }
                        } label: {
                            HStack(spacing: 18) {
                                Text("S\(ep.s ?? 1)E\(ep.e ?? 1)")
                                    .font(.headline.monospaced())
                                    .foregroundStyle(TVTheme.amber)
                                Text(ep.epTitle ?? ep.title)
                                    .font(.headline)
                                    .foregroundStyle(.white)
                                Spacer()
                                Image(systemName: "play.fill")
                                    .foregroundStyle(TVTheme.coral)
                            }
                            .padding(.horizontal, 24)
                            .padding(.vertical, 16)
                        }
                    }
                }
            }
            .padding(56)
        }
        .task {
            guard let api = appState.api else { return }
            if let resp = try? await api.fetchLibraryItems(libId: libId, offset: 0, limit: 200, showIdx: show.idx) {
                episodes = resp.items
            }
        }
    }
}

private struct TVLiveTab: View {
    @ObservedObject var appState: TVAppState
    @State private var favoritesOnly = false

    var body: some View {
        let list = favoritesOnly ? appState.iptvChannels.filter { $0.fav == true } : appState.iptvChannels
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 20) {
                Text("Live TV")
                    .font(.largeTitle.bold())
                    .foregroundStyle(.white)
                Spacer()
                Button(favoritesOnly ? "Showing Favorites" : "All Channels") {
                    favoritesOnly.toggle()
                }
            }
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 340, maximum: 420), spacing: 28)], spacing: 24) {
                    ForEach(list.prefix(200)) { ch in
                        Button {
                            Task { await appState.playIPTVChannel(ch) }
                        } label: {
                            HStack(spacing: 16) {
                                Image(systemName: ch.fav == true ? "star.fill" : "tv")
                                    .foregroundStyle(ch.fav == true ? TVTheme.amber : TVTheme.coral)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(ch.name)
                                        .font(.headline)
                                        .foregroundStyle(.white)
                                        .lineLimit(1)
                                    if let group = ch.group {
                                        Text(group)
                                            .font(.caption)
                                            .foregroundStyle(.white.opacity(0.6))
                                            .lineLimit(1)
                                    }
                                }
                                Spacer()
                            }
                            .padding(20)
                            .background(TVTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                        }
                        .buttonStyle(.card)
                    }
                }
            }
        }
        .padding(56)
    }
}

private struct TVSearchTab: View {
    @ObservedObject var appState: TVAppState
    @State private var query = ""
    @State private var results: [TMDBTitle] = []

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 250, maximum: 280), spacing: 38)], spacing: 44) {
                ForEach(results.filter { $0.mediaType == "movie" || $0.mediaType == "tv" }) { item in
                    NavigationLink {
                        TVDetailView(appState: appState, item: item)
                    } label: {
                        TVPosterCard(
                            title: item.displayTitle,
                            subtitle: item.year.map(String.init),
                            imageURL: item.posterURL(),
                            progress: nil
                        )
                    }
                    .buttonStyle(.card)
                }
            }
            .padding(56)
        }
        .searchable(text: $query, prompt: "Search movies and shows")
        .onChange(of: query) { _, newValue in
            let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.count >= 2 else {
                results = []
                return
            }
            Task {
                if let page = try? await appState.api?.searchTMDB(query: trimmed) {
                    results = page.results
                }
            }
        }
    }
}

private struct TVSettingsTab: View {
    @ObservedObject var appState: TVAppState

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            Text("Settings")
                .font(.largeTitle.bold())
                .foregroundStyle(.white)

            VStack(alignment: .leading, spacing: 12) {
                Text("Server: \(appState.serverOrigin ?? "Not connected")")
                    .font(.headline)
                    .foregroundStyle(.white)
                Text("Account: \(appState.user?.name ?? "Unknown")")
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.75))
            }
            .padding(28)
            .background(TVTheme.surface, in: RoundedRectangle(cornerRadius: 20))

            if let profiles = appState.user?.profiles, profiles.count > 1 {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Profiles")
                        .font(.title3.bold())
                        .foregroundStyle(.white)
                    HStack(spacing: 18) {
                        ForEach(profiles) { profile in
                            Button(profile.id == appState.activeProfileId ? "✓ \(profile.name)" : profile.name) {
                                appState.selectProfile(profile.id)
                            }
                        }
                    }
                }
            }

            HStack(spacing: 24) {
                Button("Refresh Home") { Task { await appState.refreshHome() } }
                Button("Sign Out", role: .destructive) { appState.signOut() }
                Button("Change Server", role: .destructive) { appState.changeServer() }
            }

            Spacer()
        }
        .padding(56)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
