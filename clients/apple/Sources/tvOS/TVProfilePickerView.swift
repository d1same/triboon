import SwiftUI
import TriboonCore

struct TVProfilePickerView: View {
    @ObservedObject var appState: TVAppState
    @FocusState private var focusedProfileId: String?

    var body: some View {
        let profiles = appState.user?.profiles ?? []
        VStack(spacing: 42) {
            Text("Who's watching?")
                .font(.largeTitle.bold())
                .foregroundStyle(.white)

            HStack(spacing: 36) {
                ForEach(profiles) { profile in
                    Button {
                        appState.selectProfile(profile.id)
                    } label: {
                        VStack(spacing: 16) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .fill(TVTheme.surface)
                                    .frame(width: 210, height: 210)
                                Text(String(profile.name.prefix(1)).uppercased())
                                    .font(.system(size: 72, weight: .bold, design: .rounded))
                                    .foregroundStyle(.white)
                            }
                            Text(profile.name)
                                .font(.title3.weight(.semibold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                        }
                        .padding(10)
                    }
                    .buttonStyle(.card)
                    .focused($focusedProfileId, equals: profile.id)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(TVTheme.background)
        .onAppear {
            if profiles.contains(where: { $0.id == appState.activeProfileId }) {
                focusedProfileId = appState.activeProfileId
            } else {
                focusedProfileId = profiles.first?.id
            }
        }
    }
}
