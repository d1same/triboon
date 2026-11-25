import SwiftUI
import TriboonCore

struct ConnectView: View {
    @ObservedObject var session: IOSSessionController
    @State private var serverInput = ""
    @State private var isConnecting = false
    @State private var errorMessage: String?

    private let ink = Color(red: 11 / 255, green: 8 / 255, blue: 18 / 255)
    private let surface = Color(red: 22 / 255, green: 16 / 255, blue: 32 / 255)
    private let magenta = Color(red: 193 / 255, green: 59 / 255, blue: 214 / 255)
    private let coral = Color(red: 251 / 255, green: 139 / 255, blue: 60 / 255)

    var body: some View {
        ZStack {
            ink.ignoresSafeArea()
            RadialGradient(
                colors: [magenta.opacity(0.24), .clear],
                center: .topTrailing,
                startRadius: 20,
                endRadius: 360
            )
            .ignoresSafeArea()
            RadialGradient(
                colors: [coral.opacity(0.14), .clear],
                center: .bottomLeading,
                startRadius: 20,
                endRadius: 340
            )
            .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 12) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 12)
                                .fill(LinearGradient(colors: [magenta, coral], startPoint: .topLeading, endPoint: .bottomTrailing))
                                .frame(width: 44, height: 44)
                            Text("T")
                                .font(.system(size: 24, weight: .heavy, design: .rounded))
                                .foregroundStyle(.white)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Connect to Triboon")
                                .font(.title2.bold())
                                .foregroundStyle(.white)
                            Text("iPhone & iPad")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(coral)
                        }
                    }

                    Text("Enter the address of your self-hosted Triboon server. Your account and provider credentials stay on your server.")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.72))

                    VStack(alignment: .leading, spacing: 8) {
                        Text("SERVER ADDRESS")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.white.opacity(0.65))
                            .tracking(1.1)

                        TextField("http://192.168.1.20:7777", text: $serverInput)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled(true)
                            .submitLabel(.go)
                            .onSubmit { submit() }
                            .padding(.horizontal, 14)
                            .frame(height: 50)
                            .background(Color.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12)
                                    .stroke(Color.white.opacity(0.14), lineWidth: 1)
                            )
                            .foregroundStyle(.white)

                        Text("Example: http://192.168.1.20:7777 or https://stream.example.com")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.5))
                    }

                    Button(action: submit) {
                        HStack {
                            if isConnecting {
                                ProgressView()
                                    .tint(.white)
                            }
                            Text(isConnecting ? "Connecting..." : "Connect")
                                .font(.headline)
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .background(
                            LinearGradient(colors: [magenta, coral], startPoint: .leading, endPoint: .trailing),
                            in: RoundedRectangle(cornerRadius: 12)
                        )
                        .foregroundStyle(.white)
                    }
                    .disabled(isConnecting || serverInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .opacity(isConnecting ? 0.7 : 1)

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(Color(red: 1, green: 0.58, blue: 0.58))
                    }
                }
                .padding(26)
                .frame(maxWidth: 480)
                .background(surface.opacity(0.94), in: RoundedRectangle(cornerRadius: 22))
                .overlay(
                    RoundedRectangle(cornerRadius: 22)
                        .stroke(Color.white.opacity(0.1), lineWidth: 1)
                )
                .padding(.horizontal, 20)
                .padding(.vertical, 48)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func submit() {
        guard !isConnecting else { return }
        errorMessage = nil
        isConnecting = true
        let candidate = serverInput
        Task {
            do {
                try await session.connect(to: candidate)
            } catch {
                errorMessage = error.localizedDescription
            }
            isConnecting = false
        }
    }
}
