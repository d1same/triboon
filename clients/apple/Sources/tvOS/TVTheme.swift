import SwiftUI

enum TVTheme {
    static let ink = Color(red: 11 / 255, green: 8 / 255, blue: 18 / 255)
    static let surface = Color(red: 22 / 255, green: 16 / 255, blue: 32 / 255)
    static let raise = Color(red: 34 / 255, green: 25 / 255, blue: 52 / 255)
    static let magenta = Color(red: 193 / 255, green: 59 / 255, blue: 214 / 255)
    static let coral = Color(red: 251 / 255, green: 139 / 255, blue: 60 / 255)
    static let amber = Color(red: 255 / 255, green: 198 / 255, blue: 92 / 255)

    static var accentGradient: LinearGradient {
        LinearGradient(colors: [magenta, coral], startPoint: .leading, endPoint: .trailing)
    }

    static var background: some View {
        ZStack {
            ink.ignoresSafeArea()
            RadialGradient(colors: [magenta.opacity(0.18), .clear], center: .topTrailing, startRadius: 40, endRadius: 720)
                .ignoresSafeArea()
            RadialGradient(colors: [coral.opacity(0.10), .clear], center: .bottomLeading, startRadius: 40, endRadius: 680)
                .ignoresSafeArea()
        }
    }
}

struct TVPosterCard: View {
    let title: String
    let subtitle: String?
    let imageURL: URL?
    let progress: Double?
    var posterWidth: CGFloat = 240

    private var posterHeight: CGFloat { posterWidth * 1.5 }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .bottomLeading) {
                RoundedRectangle(cornerRadius: 16)
                    .fill(TVTheme.raise)
                    .frame(width: posterWidth, height: posterHeight)

                if let imageURL {
                    AsyncImage(url: imageURL) { phase in
                        switch phase {
                        case .success(let img):
                            img.resizable().scaledToFill()
                        default:
                            Color.clear
                        }
                    }
                    .frame(width: posterWidth, height: posterHeight)
                    .clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                } else {
                    VStack(spacing: 8) {
                        Image(systemName: "film")
                            .font(.system(size: 40))
                            .foregroundStyle(.white.opacity(0.35))
                        Text(title)
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.7))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 12)
                    }
                    .frame(width: posterWidth, height: posterHeight)
                }

                if let progress, progress > 0.01 {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(Color.black.opacity(0.55))
                            Rectangle()
                                .fill(TVTheme.accentGradient)
                                .frame(width: geo.size.width * min(1, max(0, progress)))
                        }
                    }
                    .frame(height: 6)
                    .clipShape(Capsule())
                    .padding(10)
                }
            }
            .frame(width: posterWidth, height: posterHeight)

            Text(title)
                .font(.callout.weight(.semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
                .frame(width: posterWidth, alignment: .leading)

            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.65))
                    .lineLimit(1)
                    .frame(width: posterWidth, alignment: .leading)
            }
        }
    }
}
