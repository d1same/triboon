import SwiftUI
import TriboonCore

struct TVDetailView: View {
    @ObservedObject var appState: TVAppState
    let item: TMDBTitle

    @State private var detail: TMDBTitle?
    @State private var selectedSeason = 1
    @State private var episodes: [TMDBEpisode] = []

    private var shown: TMDBTitle { detail ?? item }

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let bg = shown.backdropURL() {
                AsyncImage(url: bg) { phase in
                    if case .success(let img) = phase {
                        img.resizable()
                            .scaledToFill()
                            .opacity(0.32)
                            .ignoresSafeArea()
                    }
                }
            }

            LinearGradient(
                colors: [TVTheme.ink.opacity(0.95), TVTheme.ink.opacity(0.65), TVTheme.ink],
                startPoint: .leading,
                endPoint: .trailing
            )
            .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 36) {
                    HStack(alignment: .top, spacing: 44) {
                        TVPosterCard(title: shown.displayTitle, subtitle: nil, imageURL: shown.posterURL(), progress: nil)

                        VStack(alignment: .leading, spacing: 18) {
                            Text(shown.displayTitle)
                                .font(.largeTitle.bold())
                                .foregroundStyle(.white)

                            HStack(spacing: 18) {
                                if let y = shown.year {
                                    Text(String(y)).foregroundStyle(TVTheme.amber)
                                }
                                if let rating = shown.voteAverage, rating > 0 {
                                    Text(String(format: "★ %.1f", rating)).foregroundStyle(.white.opacity(0.85))
                                }
                                if let runtime = shown.runtime, runtime > 0 {
                                    Text("\(runtime) min").foregroundStyle(.white.opacity(0.75))
                                }
                            }
                            .font(.headline)

                            if let overview = shown.overview, !overview.isEmpty {
                                Text(overview)
                                    .font(.callout)
                                    .foregroundStyle(.white.opacity(0.84))
                                    .lineLimit(6)
                                    .frame(maxWidth: 900, alignment: .leading)
                            }

                            HStack(spacing: 24) {
                                if !shown.isTV {
                                    Button {
                                        Task { await appState.playCatalogMovie(shown) }
                                    } label: {
                                        Label(appState.isStartingPlayback ? "Starting..." : "Play", systemImage: "play.fill")
                                            .font(.headline)
                                    }
                                    .disabled(appState.isStartingPlayback)
                                } else if let firstEp = episodes.first {
                                    Button {
                                        Task { await appState.playCatalogEpisode(show: shown, season: selectedSeason, episode: firstEp) }
                                    } label: {
                                        Label(
                                            appState.isStartingPlayback ? "Starting..." : "Play S\(selectedSeason)E\(firstEp.episodeNumber)",
                                            systemImage: "play.fill"
                                        )
                                        .font(.headline)
                                    }
                                    .disabled(appState.isStartingPlayback)
                                }
                            }
                            .padding(.top, 8)
                        }
                    }

                    if shown.isTV, let seasons = shown.seasons?.filter({ $0.seasonNumber > 0 }), !seasons.isEmpty {
                        VStack(alignment: .leading, spacing: 20) {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 18) {
                                    ForEach(seasons) { season in
                                        Button(season.displayName) {
                                            selectedSeason = season.seasonNumber
                                            Task { await loadSeason(season.seasonNumber) }
                                        }
                                    }
                                }
                            }

                            ScrollView(.horizontal, showsIndicators: false) {
                                LazyHStack(spacing: 30) {
                                    ForEach(episodes) { ep in
                                        Button {
                                            Task { await appState.playCatalogEpisode(show: shown, season: selectedSeason, episode: ep) }
                                        } label: {
                                            VStack(alignment: .leading, spacing: 10) {
                                                ZStack {
                                                    RoundedRectangle(cornerRadius: 14)
                                                        .fill(TVTheme.raise)
                                                        .frame(width: 360, height: 202)
                                                    if let still = ep.stillURL() {
                                                        AsyncImage(url: still) { phase in
                                                            if case .success(let img) = phase {
                                                                img.resizable().scaledToFill()
                                                            }
                                                        }
                                                        .frame(width: 360, height: 202)
                                                        .clipped()
                                                        .clipShape(RoundedRectangle(cornerRadius: 14))
                                                    }
                                                }
                                                Text("E\(ep.episodeNumber) · \(ep.displayName)")
                                                    .font(.callout.weight(.semibold))
                                                    .foregroundStyle(.white)
                                                    .lineLimit(1)
                                                    .frame(width: 360, alignment: .leading)
                                            }
                                        }
                                        .buttonStyle(.card)
                                    }
                                }
                                .padding(.vertical, 16)
                            }
                        }
                    }
                }
                .padding(56)
            }
        }
        .task {
            guard let api = appState.api else { return }
            let mediaType = item.isTV ? "tv" : "movie"
            if let loaded = try? await api.fetchTMDBDetail(mediaType: mediaType, tmdbId: item.id) {
                detail = loaded
                if loaded.isTV {
                    let firstSeason = loaded.seasons?.first(where: { $0.seasonNumber > 0 })?.seasonNumber ?? 1
                    selectedSeason = firstSeason
                    await loadSeason(firstSeason)
                }
            }
        }
    }

    private func loadSeason(_ num: Int) async {
        guard let api = appState.api else { return }
        if let season = try? await api.fetchTMDBSeason(tmdbId: item.id, season: num) {
            episodes = season.episodes
        }
    }
}
