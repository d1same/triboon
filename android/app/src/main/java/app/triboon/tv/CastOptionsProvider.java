package app.triboon.tv;

import android.content.Context;

import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.framework.CastOptions;
import com.google.android.gms.cast.framework.OptionsProvider;
import com.google.android.gms.cast.framework.SessionProvider;

import java.util.List;

// Phase 1/3 casting uses Google's Default Media Receiver (CC1AD845): no app registration, no HTTPS
// media, plays a plain tokened MP4/fMP4 URL. Phase 2 swaps the one id line for a custom receiver.
// Loaded reflectively by the Cast SDK via the OPTIONS_PROVIDER_CLASS_NAME manifest meta-data.
public final class CastOptionsProvider implements OptionsProvider {
    @Override
    public CastOptions getCastOptions(Context context) {
        return new CastOptions.Builder()
                .setReceiverApplicationId(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID)
                .setStopReceiverApplicationWhenEndingSession(true)
                .build();
    }

    @Override
    public List<SessionProvider> getAdditionalSessionProviders(Context context) {
        return null;
    }
}
