import SwiftUI
import TriboonCore

struct TVConnectView: View {
    @ObservedObject var appState: TVAppState
    @State private var serverInput = ""
    @State private var isConnecting = false
    @State private var errorText: String?

    var body: some View {
        VStack(spacing: 32) {
            HStack(spacing: 18) {
                ZStack {
                    RoundedRectangle(cornerRadius: 18)
                        .fill(TVTheme.accentGradient)
                        .frame(width: 72, height: 72)
                    Text("T")
                        .font(.system(size: 40, weight: .heavy, design: .rounded))
                        .foregroundStyle(.white)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Connect to Triboon")
                        .font(.largeTitle.bold())
                        .foregroundStyle(.white)
                    Text("Apple TV")
                        .font(.headline)
                        .foregroundStyle(TVTheme.coral)
                }
            }

            Text("Enter the address of your self-hosted Triboon server (for example: 192.168.1.20 or https://stream.example.com).")
                .font(.callout)
                .foregroundStyle(.white.opacity(0.75))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 760)

            TextField(
                "",
                text: $serverInput,
                prompt: Text(verbatim: "http://192.168.1.20:7777")
            )
                .frame(maxWidth: 680)
                .autocorrectionDisabled(true)

            Button {
                submit()
            } label: {
                HStack(spacing: 14) {
                    if isConnecting { ProgressView() }
                    Text(isConnecting ? "Connecting..." : "Connect")
                        .font(.headline)
                }
                .frame(width: 360)
            }
            .disabled(isConnecting || serverInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            if let errorText {
                Text(errorText)
                    .font(.callout)
                    .foregroundStyle(Color(red: 1, green: 0.58, blue: 0.58))
            }
        }
        .padding(60)
    }

    private func submit() {
        guard !isConnecting else { return }
        errorText = nil
        isConnecting = true
        let candidate = serverInput
        Task {
            do {
                try await appState.connect(to: candidate)
            } catch {
                errorText = error.localizedDescription
            }
            isConnecting = false
        }
    }
}
