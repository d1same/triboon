import SwiftUI
import TriboonCore

struct TVLoginView: View {
    @ObservedObject var appState: TVAppState
    @State private var usePassword = false
    @State private var qcCode: String?
    @State private var qcStatus = "Requesting Quick Connect code..."
    @State private var username = ""
    @State private var password = ""
    @State private var totpChallenge: String?
    @State private var totpCode = ""
    @State private var isBusy = false
    @State private var errorText: String?

    var body: some View {
        VStack(spacing: 28) {
            Text("Sign in to Triboon")
                .font(.largeTitle.bold())
                .foregroundStyle(.white)

            if let origin = appState.serverOrigin {
                Text(origin)
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.6))
            }

            if !usePassword {
                VStack(spacing: 22) {
                    Text("Approve this code in Triboon on your phone or browser (Settings -> Quick Connect):")
                        .font(.callout)
                        .foregroundStyle(.white.opacity(0.8))
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 780)

                    Text(qcCode ?? "------")
                        .font(.system(size: 76, weight: .heavy, design: .monospaced))
                        .tracking(12)
                        .foregroundStyle(TVTheme.amber)
                        .padding(.horizontal, 44)
                        .padding(.vertical, 22)
                        .background(TVTheme.surface, in: RoundedRectangle(cornerRadius: 24))

                    Text(qcStatus)
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.65))

                    HStack(spacing: 24) {
                        Button("New Code") { Task { await startQuickConnect() } }
                        Button("Sign in with Password") { usePassword = true }
                        Button("Change Server") { appState.changeServer() }
                    }
                }
                .task(id: usePassword) {
                    if !usePassword {
                        await startQuickConnect()
                    }
                }
            } else {
                VStack(spacing: 20) {
                    if totpChallenge == nil {
                        TextField("Username", text: $username)
                            .frame(maxWidth: 540)
                            .autocorrectionDisabled(true)
                        SecureField("Password", text: $password)
                            .frame(maxWidth: 540)
                        Button(isBusy ? "Signing in..." : "Sign In") {
                            Task { await submitPasswordLogin() }
                        }
                        .disabled(isBusy || username.isEmpty || password.isEmpty)
                    } else {
                        TextField("6-digit 2FA code", text: $totpCode)
                            .frame(maxWidth: 420)
                        Button(isBusy ? "Verifying..." : "Verify 2FA") {
                            Task { await submit2FA() }
                        }
                        .disabled(isBusy || totpCode.isEmpty)
                    }

                    HStack(spacing: 24) {
                        Button("Use Quick Connect") {
                            totpChallenge = nil
                            usePassword = false
                        }
                        Button("Change Server") { appState.changeServer() }
                    }
                }
            }

            if let errorText {
                Text(errorText)
                    .font(.callout)
                    .foregroundStyle(Color(red: 1, green: 0.58, blue: 0.58))
            }
        }
        .padding(60)
    }

    private func startQuickConnect() async {
        guard let api = appState.api else { return }
        errorText = nil
        qcStatus = "Requesting Quick Connect code..."
        do {
            let res = try await api.createQuickConnect(deviceName: "Apple TV")
            qcCode = res.code
            qcStatus = "Waiting for approval..."
            while !Task.isCancelled && !usePassword && appState.token == nil {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if Task.isCancelled || usePassword { break }
                if let poll = try? await api.pollQuickConnect(code: res.code) {
                    if poll.status == "approved", let tok = poll.token {
                        await appState.completeSignIn(token: tok, user: poll.user)
                        return
                    }
                    if poll.status == "expired" {
                        qcStatus = "Code expired. Select New Code to try again."
                        return
                    }
                }
            }
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func submitPasswordLogin() async {
        guard let api = appState.api else { return }
        errorText = nil
        isBusy = true
        defer { isBusy = false }
        do {
            let res = try await api.login(name: username, password: password)
            if res.requiresTwoFactor == true, let challenge = res.challenge {
                totpChallenge = challenge
                return
            }
            guard let tok = res.token else {
                errorText = res.error ?? "Sign-in failed."
                return
            }
            await appState.completeSignIn(token: tok, user: res.user)
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func submit2FA() async {
        guard let api = appState.api, let challenge = totpChallenge else { return }
        errorText = nil
        isBusy = true
        defer { isBusy = false }
        do {
            let res = try await api.login2FA(challenge: challenge, code: totpCode)
            guard let tok = res.token else {
                errorText = res.error ?? "Invalid 2FA code."
                return
            }
            await appState.completeSignIn(token: tok, user: res.user)
        } catch {
            errorText = error.localizedDescription
        }
    }
}
