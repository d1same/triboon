package app.triboon.tv;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UpdateVerifierTest {
    @Test
    public void releaseUrlIsPinnedToOfficialStableAssets() {
        assertTrue(UpdateVerifier.allowedGithubReleasePath(
                "/d1same/triboon/releases/latest/download/triboon.apk"));
        assertFalse(UpdateVerifier.allowedGithubReleasePath(
                "/d1same/triboon/releases/latest/download/triboon-tv.apk"));
        assertFalse(UpdateVerifier.allowedGithubReleasePath(
                "/d1same/triboon/releases/latest/download/triboon-mobile.apk"));
        assertFalse(UpdateVerifier.allowedGithubReleasePath(
                "/attacker/repo/releases/latest/download/triboon.apk"));
        assertFalse(UpdateVerifier.allowedGithubReleasePath(
                "/d1same/triboon/releases/download/v2.8.0/triboon.apk"));
    }

    @Test
    public void updateMustBeNewerTriboonAndProductionSigned() {
        String signer = UpdateVerifier.RELEASE_CERT_SHA256;
        assertTrue(UpdateVerifier.metadataAllowed("app.triboon.tv", 305, 304, signer));
        assertTrue(UpdateVerifier.metadataAllowed("app.triboon.tv", 305, 304,
                signer.toUpperCase().replaceAll("(..)(?!$)", "$1:")));
        assertFalse(UpdateVerifier.metadataAllowed("other.app", 305, 304, signer));
        assertFalse(UpdateVerifier.metadataAllowed("app.triboon.tv", 304, 304, signer));
        assertFalse(UpdateVerifier.metadataAllowed("app.triboon.tv", 303, 304, signer));
        assertFalse(UpdateVerifier.metadataAllowed("app.triboon.tv", 305, 304,
                "00".repeat(32)));
    }

    // B15A-01 (A1-1): Android 9/10 can leave signingInfo empty for an archive; the old
    // signatures field is then the only signer list. Never more than one signer, never a mix.
    @Test
    public void signerComesFromSigningInfoFirstAndTheOldFieldOnlyAsFallback() {
        byte[] modern = {1, 2, 3};
        byte[] legacy = {9, 9};
        assertArrayEquals(modern, UpdateVerifier.pickSingleSigner(new byte[][] {modern}, new byte[][] {legacy}));
        assertArrayEquals(modern, UpdateVerifier.pickSingleSigner(new byte[][] {modern}, null));
        assertArrayEquals(legacy, UpdateVerifier.pickSingleSigner(null, new byte[][] {legacy}));
        assertArrayEquals(legacy, UpdateVerifier.pickSingleSigner(new byte[0][], new byte[][] {legacy}));
    }

    @Test
    public void noReadableSingleSignerIsRefused() {
        byte[] a = {1};
        byte[] b = {2};
        assertNull(UpdateVerifier.pickSingleSigner(null, null));
        assertNull(UpdateVerifier.pickSingleSigner(new byte[0][], new byte[0][]));
        assertNull(UpdateVerifier.pickSingleSigner(new byte[][] {a, b}, new byte[][] {a}));
        assertNull(UpdateVerifier.pickSingleSigner(null, new byte[][] {a, b}));
        assertNull(UpdateVerifier.pickSingleSigner(new byte[][] {null}, new byte[][] {a}));
        assertNull(UpdateVerifier.pickSingleSigner(null, new byte[][] {new byte[0]}));
    }
}
