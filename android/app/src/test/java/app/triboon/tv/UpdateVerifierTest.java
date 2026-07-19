package app.triboon.tv;

import static org.junit.Assert.assertFalse;
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
}
