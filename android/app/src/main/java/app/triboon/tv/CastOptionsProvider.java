package app.triboon.tv;

import android.content.Context;
import android.content.SharedPreferences;

import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.framework.CastOptions;
import com.google.android.gms.cast.framework.OptionsProvider;
import com.google.android.gms.cast.framework.SessionProvider;

import java.util.List;

// Phase 1/3 casting uses Google's Default Media Receiver (CC1AD845): no app registration, no HTTPS
// media, plays a plain tokened MP4/fMP4 URL.
//
// Phase 2 makes the receiver app-id CONFIGURABLE. The owner registers a Custom Web Receiver in the
// Google Cast SDK Developer Console (pointed at https://<host>/cast/receiver), then sets the issued
// app-id in Triboon Settings. The web UI persists that id into SharedPreferences via the JS bridge
// (setCastReceiverAppId). This provider reads it here; if it is absent or malformed we fall back to
// the Default Media Receiver so NOTHING breaks until the owner opts in.
//
// The Cast SDK calls getCastOptions() once, reflectively, at process start (via the
// OPTIONS_PROVIDER_CLASS_NAME manifest meta-data), so a newly-set custom id takes effect on the
// next app launch — the standard behavior for a Cast app-id on Android.
public final class CastOptionsProvider implements OptionsProvider {
    // Kept in sync with server effectiveCastReceiverAppId() and the web sender castReceiverAppId().
    private static final String PREFS = "triboon";
    private static final String KEY_CAST_APP_ID = "castReceiverAppId";

    private static String receiverAppId(Context context) {
        try {
            SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String id = p.getString(KEY_CAST_APP_ID, "");
            if (id != null) {
                id = id.trim().toUpperCase();
                // Cast app-ids are 8 hex characters. Anything else -> default (never brick casting).
                if (id.matches("[0-9A-F]{8}")) return id;
            }
        } catch (Exception ignored) {}
        return CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID;
    }

    @Override
    public CastOptions getCastOptions(Context context) {
        return new CastOptions.Builder()
                .setReceiverApplicationId(receiverAppId(context))
                .setStopReceiverApplicationWhenEndingSession(true)
                .build();
    }

    @Override
    public List<SessionProvider> getAdditionalSessionProviders(Context context) {
        return null;
    }
}
