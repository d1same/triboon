package app.triboon.tv;

import java.util.Locale;

/** Pure update-chain policy shared by the Android shell and local unit tests. */
final class UpdateVerifier {
    static final String PACKAGE_NAME = "app.triboon.tv";
    static final String RELEASE_CERT_SHA256 =
            "c0b1e2d90b443b07fe4ec4001496539aeb810d2bb9bba9a5f1d8781aa7e28d42";

    private UpdateVerifier() {}

    static boolean allowedGithubReleasePath(String path) {
        if (path == null) return false;
        return "/d1same/triboon/releases/latest/download/triboon.apk".equals(path);
    }

    static boolean metadataAllowed(String packageName, long candidateVersionCode,
                                   long installedVersionCode, String signerSha256) {
        return PACKAGE_NAME.equals(packageName)
                && candidateVersionCode > installedVersionCode
                && RELEASE_CERT_SHA256.equals(normalizeSha256(signerSha256));
    }

    // B15A-01 (A1-1): on API 28+ the new signingInfo list wins. Only when it is missing or empty
    // (Android 9/10 can leave it empty for an archive) does the old signatures list count.
    // Exactly one non-empty signer, or null: never a mix of the two lists, never two signers.
    static byte[] pickSingleSigner(byte[][] signingInfoSigners, byte[][] legacySigners) {
        byte[][] list = signingInfoSigners != null && signingInfoSigners.length > 0
                ? signingInfoSigners : legacySigners;
        if (list == null || list.length != 1) return null;
        byte[] only = list[0];
        return only == null || only.length == 0 ? null : only;
    }

    static String normalizeSha256(String value) {
        return value == null ? "" : value.replace(":", "").trim().toLowerCase(Locale.US);
    }
}
