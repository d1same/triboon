package app.triboon.tv;

// Foreground media service for the Music player. Music plays in a WebView <audio> element (not
// ExoPlayer); this service keeps that audio alive when the app is backgrounded / the screen is
// locked (Android kills a plain backgrounded WebView after a few minutes) and shows a
// MediaSession-backed notification with lock-screen play/pause/next/prev controls.
//
// It does NOT play audio itself — the WebView does. The service mirrors the web player's state
// (pushed from MainActivity.musicSession()) into a MediaSessionCompat + MediaStyle notification,
// and forwards transport button presses to active native VOD or WebView audio via MainActivity.

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;
import android.view.KeyEvent;

import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;
import androidx.media.session.MediaButtonReceiver;
import androidx.media3.common.util.UnstableApi;

import java.net.HttpURLConnection;
import java.net.URL;

@UnstableApi
public class MusicService extends Service {
    private static final String TAG = "TriboonMusic";
    static final String CHANNEL_ID = "triboon_music";
    static final int NOTIF_ID = 4321;
    static final String ACTION_UPDATE = "app.triboon.tv.music.UPDATE";
    static final String ACTION_STOP = "app.triboon.tv.music.STOP";

    private MediaSessionCompat session;
    private String artUrl = "";
    private Bitmap art;
    private String lastTitle = "", lastArtist = "", lastAlbum = "";
    private boolean lastPlaying = false;
    private boolean hasMusicSnapshot = false;
    private long lastDurationMs = 0, lastPositionMs = 0;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        ensureChannel();
        session = new MediaSessionCompat(this, "TriboonMusic");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { MainActivity.dispatchMediaTransport("play"); }
            @Override public void onPause() { MainActivity.dispatchMediaTransport("pause"); }
            @Override public void onSkipToNext() { MainActivity.dispatchMediaTransport("next"); }
            @Override public void onSkipToPrevious() { MainActivity.dispatchMediaTransport("prev"); }
            @Override public void onFastForward() { MainActivity.dispatchMediaTransport("fast_forward"); }
            @Override public void onRewind() { MainActivity.dispatchMediaTransport("rewind"); }
            @Override public void onStop() { MainActivity.dispatchMediaTransport("stop"); }
            @Override public void onSeekTo(long pos) { MainActivity.dispatchMediaSeek(pos); }

            // Do not let a cold/stale PlaybackState turn a headset toggle into an unconditional
            // Play. Translate the actual key so native VOD gets true toggle/seek semantics too.
            @Override public boolean onMediaButtonEvent(Intent mediaButtonIntent) {
                if (handleMediaButtonEvent(mediaButtonIntent)) return true;
                return super.onMediaButtonEvent(mediaButtonIntent);
            }
        });
        // A receiver can cold-start this service before the web music bridge has sent an update.
        // Seed the actions so controller commands are still accepted in that state.
        applyMetadata();
        applyState();
        session.setActive(true);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        // Hardware / BT / lock-screen media buttons arrive here and route to the session callback.
        final String action = intent.getAction();
        if (Intent.ACTION_MEDIA_BUTTON.equals(action)) {
            // MediaButtonReceiver uses startForegroundService() on Android 8+, including when the
            // active target is native VOD or there is no target. Enter foreground before dispatch
            // so the OS deadline is always satisfied, then tear down cold transient starts.
            if (!startMediaButtonForeground(startId)) return START_NOT_STICKY;
            MediaButtonReceiver.handleIntent(session, intent);
            if (!hasMusicSnapshot) finishTransientMediaButtonStart(startId);
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action)) { stopEverything(); return START_NOT_STICKY; }
        if (ACTION_UPDATE.equals(action)) {
            hasMusicSnapshot = true;
            lastPlaying = intent.getBooleanExtra("playing", false);
            lastTitle = orEmpty(intent.getStringExtra("title"));
            lastArtist = orEmpty(intent.getStringExtra("artist"));
            lastAlbum = orEmpty(intent.getStringExtra("album"));
            lastDurationMs = Math.max(0, intent.getLongExtra("duration", 0)) * 1000L;
            lastPositionMs = Math.max(0, intent.getLongExtra("position", 0)) * 1000L;
            String url = orEmpty(intent.getStringExtra("artwork"));
            if (!url.equals(artUrl)) { artUrl = url; art = null; if (!url.isEmpty()) loadArt(url); }
            applyMetadata();
            applyState();
            try {
                startForeground(NOTIF_ID, buildNotification());
                // Paused: keep the notification but leave the foreground state so it's dismissible
                // and doesn't hold the process as hard once nothing is playing.
                if (!lastPlaying && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(Service.STOP_FOREGROUND_DETACH);
                }
            } catch (Throwable t) { Log.w(TAG, "startForeground failed", t); }
        }
        return START_NOT_STICKY;
    }

    private boolean startMediaButtonForeground(int startId) {
        try {
            startForeground(NOTIF_ID, buildNotification());
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "media-button foreground start failed", t);
            stopSelfResult(startId);
            return false;
        }
    }

    private void finishTransientMediaButtonStart(int startId) {
        // Give a cold WebView music session one beat to publish ACTION_UPDATE and become a real
        // long-lived music service. Native VOD and idle button starts have no snapshot and exit.
        mainHandler.postDelayed(() -> {
            if (hasMusicSnapshot) return;
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(Service.STOP_FOREGROUND_REMOVE);
                } else {
                    stopForeground(true);
                }
            } catch (Throwable ignored) {}
            stopSelfResult(startId);
        }, 750L);
    }

    @SuppressWarnings("deprecation")
    private boolean handleMediaButtonEvent(Intent mediaButtonIntent) {
        if (mediaButtonIntent == null) return false;
        KeyEvent event = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent.class)
                : mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
        if (event == null) return false;

        String action;
        switch (event.getKeyCode()) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
                action = "toggle";
                break;
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                action = "play";
                break;
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                action = "pause";
                break;
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                action = "next";
                break;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                action = "prev";
                break;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                action = "fast_forward";
                break;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                action = "rewind";
                break;
            case KeyEvent.KEYCODE_MEDIA_STOP:
                action = "stop";
                break;
            default:
                return false;
        }

        if (event.getAction() == KeyEvent.ACTION_DOWN
                && (event.getRepeatCount() == 0
                    || "fast_forward".equals(action) || "rewind".equals(action))) {
            MainActivity.dispatchMediaTransport(action);
        }
        return true;
    }

    private void stopEverything() {
        hasMusicSnapshot = false;
        mainHandler.removeCallbacksAndMessages(null);
        try { session.setActive(false); } catch (Throwable ignored) {}
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(Service.STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
        } catch (Throwable ignored) {}
        stopSelf();
    }

    @Override public void onDestroy() {
        mainHandler.removeCallbacksAndMessages(null);
        try { if (session != null) session.release(); } catch (Throwable ignored) {}
        super.onDestroy();
    }

    private void applyMetadata() {
        MediaMetadataCompat.Builder b = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, lastTitle)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, lastArtist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, lastAlbum)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, lastDurationMs);
        if (art != null) b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art);
        try { session.setMetadata(b.build()); } catch (Throwable ignored) {}
    }

    private void applyState() {
        long actions = PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
            | PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
            | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS | PlaybackStateCompat.ACTION_STOP
            | PlaybackStateCompat.ACTION_SEEK_TO | PlaybackStateCompat.ACTION_FAST_FORWARD
            | PlaybackStateCompat.ACTION_REWIND;
        PlaybackStateCompat state = new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(lastPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                      lastPositionMs, lastPlaying ? 1f : 0f)
            .build();
        try { session.setPlaybackState(state); } catch (Throwable ignored) {}
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentPi = PendingIntent.getActivity(this, 0, open, piFlags);

        NotificationCompat.Builder nb = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(lastTitle.isEmpty() ? "Music" : lastTitle)
            .setContentText(lastArtist)
            .setContentIntent(contentPi)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setDeleteIntent(MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_STOP));
        if (art != null) nb.setLargeIcon(art);

        nb.addAction(new NotificationCompat.Action(android.R.drawable.ic_media_previous, "Previous",
            MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)));
        nb.addAction(new NotificationCompat.Action(
            lastPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
            lastPlaying ? "Pause" : "Play",
            MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_PLAY_PAUSE)));
        nb.addAction(new NotificationCompat.Action(android.R.drawable.ic_media_next, "Next",
            MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_SKIP_TO_NEXT)));

        nb.setStyle(new MediaStyle()
            .setMediaSession(session.getSessionToken())
            .setShowActionsInCompactView(0, 1, 2)
            .setShowCancelButton(true)
            .setCancelButtonIntent(MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_STOP)));
        return nb.build();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Music playback", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        try { nm.createNotificationChannel(ch); } catch (Throwable ignored) {}
    }

    // Album/playlist art for the lock screen + notification. Fetched off the main thread; native
    // HttpURLConnection sends no referrer, so yt3.googleusercontent art (which rejects a full-URL
    // referrer in the browser) loads fine here.
    private void loadArt(final String url) {
        new Thread(() -> {
            Bitmap bmp = null;
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(6000); c.setReadTimeout(6000);
                c.setRequestProperty("User-Agent", "TriboonAndroid");
                bmp = BitmapFactory.decodeStream(c.getInputStream());
                c.disconnect();
            } catch (Throwable ignored) {}
            final Bitmap fb = bmp;
            if (fb == null) return;
            new Handler(Looper.getMainLooper()).post(() -> {
                if (!url.equals(artUrl)) return; // track changed while the art was loading
                art = fb;
                applyMetadata();
                try {
                    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                    if (nm != null) nm.notify(NOTIF_ID, buildNotification());
                } catch (Throwable ignored) {}
            });
        }).start();
    }

    private static String orEmpty(String s) { return s == null ? "" : s; }
}
