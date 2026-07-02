package app.triboon.tv;

// Triboon TV shell — a deliberately thin wrapper around the Triboon web UI (which already
// speaks D-pad natively: spatial nav, focus ring, long-press OK menus). The shell's job:
//   1. TV launcher integration (leanback intent, banner) + fullscreen ink-black WebView.
//   2. First-run "connect to server" screen, remembered in SharedPreferences.
//   3. BACK key → the web app's Escape handling via window.__tvBack(); it answers 'exit'
//      only at the home root, where BACK-twice leaves the app (Plex behavior).
//   4. Remote media keys (play/pause/ff/rew) → the web player's keyboard shortcuts.
// D-pad arrows/OK need no bridging: Android WebView translates DPAD_* to DOM arrow/Enter
// key events, including auto-repeat — which the web UI's long-press OK detection expects.

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.ActivityManager;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioDeviceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.text.TextUtils;
import android.util.Rational;
import android.util.Base64;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.LinearInterpolator;
import android.view.WindowManager;
import android.window.OnBackInvokedDispatcher;
import android.webkit.WebChromeClient;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.SeekParameters;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.upstream.DefaultBandwidthMeter;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.PlayerView;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.KeyStore;
import java.net.URLEncoder;
import java.util.List;
import java.util.Map;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class MainActivity extends Activity {

    private static final String TAG = "TriboonTV";
    private static final String PREFS = "triboon";
    private static final String KEY_SERVER = "server";
    private static final String KEY_CACHE_VERSION = "cacheVersion";
    private static final String KEY_PERSONAL_IPTV = "personalIptvSources";
    private static final String KEY_PERSONAL_IPTV_CHANNEL_CACHE = "personalIptvChannelCache";
    private static final String KEY_PERSONAL_IPTV_GUIDE_CACHE = "personalIptvGuideCache";
    private static final String PERSONAL_IPTV_KEY_ALIAS = "triboon_personal_iptv";
    private static final String PERSONAL_IPTV_ENC_PREFIX = "v1:";
    private static final int PERSONAL_IPTV_MAX_CHANNELS = 20000;
    private static final int PERSONAL_IPTV_MAX_BYTES = 32 * 1024 * 1024;
    private static final int PERSONAL_IPTV_GUIDE_MAX_CHANNELS = 48;
    private static final long PERSONAL_IPTV_CACHE_TTL_MS = 24L * 60L * 60L * 1000L;
    private static final long PERSONAL_IPTV_STALE_TTL_MS = 7L * 24L * 60L * 60L * 1000L;
    private static final int PERSONAL_IPTV_CONNECT_TIMEOUT_MS = 12000;
    private static final int PERSONAL_IPTV_READ_TIMEOUT_MS = 20000;
    private static final int REQ_VOICE = 31;
    private static final int REQ_MIC = 32;
    private static final int REQ_NOTIF = 33; // POST_NOTIFICATIONS for the music media notification (API 33+)
    private static final long WEB_RENDERER_CRASH_WINDOW_MS = 15000L;
    private static final int WEB_RENDERER_CRASH_LIMIT = 2;
    private static final int MIN_WEBVIEW_MAJOR = 88;
    private static final long PERSONAL_IPTV_HOST_SAFETY_TTL_MS = 60000L;
    private static final int NATIVE_BACKDROP_MAX_BYTES = 6 * 1024 * 1024;
    private static final int NATIVE_BACKDROP_MAX_WIDTH = 1280;
    private static final int NATIVE_BACKDROP_MAX_HEIGHT = 720;

    private WebView web;
    private LinearLayout setup;
    private EditText addr;
    private TextView setupMsg;
    private FrameLayout root;
    private View fullscreenVideo;            // WebChromeClient custom view (HTML5 fullscreen)
    private FrameLayout nativePlayerLayer;   // Android-native player overlay
    private PlayerView nativePlayerView;
    private int phoneOrientationBeforePlayback = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    private boolean phonePlaybackOrientationLocked = false;
    private TextView nativeGuidePipRevealScrim;
    private LinearLayout nativeTop;
    private TextView nativePlayerTitle;
    private TextView nativePlayerSubline;
    private TextView nativePlayerBadge;
    private TextView nativeChromeTitle;
    private TextView nativeChromeSubline;
    private TextView nativeChromeQuality;
    private TextView nativeClock;
    private TextView nativeEndsAt;
    private FrameLayout nativeLoading;
    private ImageView nativeLoadingBackdrop;
    private TextView nativeLoadingTitle;
    private TextView nativeLoadingStatus;
    private View nativeLoadingLaneGlow;
    private ObjectAnimator nativeLoadingLaneAnimator;
    private int nativeLoadingToken;
    private int nativeLoadingStatusIndex;
    private final String[] nativeLoadingStatuses = new String[]{"Preparing", "Finding source", "Mounting", "Checking health...", "Starting stream"};
    private final Runnable nativeLoadingStatusTick = new Runnable() {
        @Override public void run() {
            if (nativeLoading == null || nativeLoading.getVisibility() != View.VISIBLE || nativeLoadingStatus == null) return;
            nativeLoadingStatusIndex = Math.min(nativeLoadingStatusIndex + 1, nativeLoadingStatuses.length - 1);
            nativeLoadingStatus.setText(nativeLoadingStatuses[nativeLoadingStatusIndex]);
            if (nativeLoadingStatusIndex < nativeLoadingStatuses.length - 1) {
                nativeProgress.postDelayed(this, 1050L);
            }
        }
    };
    private View nativeControlShade;
    private LinearLayout nativeMetaBar;
    private LinearLayout nativeChrome;
    private SeekBar nativeSeek;
    private TextView nativeElapsed;
    private TextView nativeTime;
    private HorizontalScrollView nativeEpisodeStrip;
    private LinearLayout nativeEpisodeList;
    private ImageButton nativePlayBtn;
    private ImageButton nativeRewBtn;
    private ImageButton nativeFwdBtn;
    private ImageButton nativeGuideBtn;
    private ImageButton nativeCcBtn;
    private ImageButton nativeAudioBtn;
    private ImageButton nativeQualityBtn;
    private ImageButton nativeStatsBtn;
    private ImageButton nativeCastBtn;
    private ImageButton nativeNextBtn;
    private ImageButton nativeFavBtn;
    private TextView nativeLiveBtn;          // live: red "LIVE" pill — jump back to the live edge
    private LinearLayout nativeEpgStrip;     // live: channel schedule strip above the seek bar
    private org.json.JSONArray nativeEpgData; // programmes the web pushes via setLiveEpg()
    private boolean nativeLiveFav = false;
    private View nativeUpNextCard;
    private TextView nativeUpNextKicker;
    private TextView nativeUpNextTitle;
    private TextView nativeUpNextSub;
    private Button nativeUpNextPlay;
    private Button nativeUpNextDismiss;
    private boolean nativeUpNextVisible = false;
    private LinearLayout nativeSheet;
    private ScrollView nativeSheetScroll;
    private LinearLayout nativeSheetRows;
    private View nativeSheetReturnFocus;
    private int nativeSheetRestoreIndex = -1;
    private int nativeControlIndex = -1;
    private TextView nativeSubtitleOverlay;
    private ExoPlayer nativePlayer;
    private DefaultBandwidthMeter nativeBandwidthMeter;
    private DefaultHttpDataSource.Factory nativeHttpDataSourceFactory;
    private String nativeMode = "";          // "live" or "video"
    private String nativeKind = "direct";
    private String nativeQualityLabel = "1080p";
    private String nativeUrl = "";
    private String nativeMime = "";
    private String nativeHostHeader = "";
    private String nativeFallbackUrl = "";
    private String nativeFallbackMime = "";
    private final java.util.ArrayList<String> nativeFallbackUrls = new java.util.ArrayList<>();
    private final java.util.ArrayList<String> nativeFallbackMimes = new java.util.ArrayList<>();
    private final java.util.ArrayList<String> nativeFallbackHostHeaders = new java.util.ArrayList<>();
    private int nativeFallbackIndex = 0;
    private String nativePlaybackTitle = "Triboon";
    private String nativePlaybackSubline = "";
    private String nativePlaybackBackdropUrl = "";
    private long nativePlaybackSizeBytes = 0L;
    private int nativeBufferGoalSec = 0;        // server read-ahead goal (s) for this stream's resolution
    private double nativePlaybackDurationSec = 0; // for turning the goal (s) into a byte budget
    private boolean nativeTriedFallback = false;
    private boolean nativeHasNext = false;
    private boolean nativeHasQualityChoices = false;
    private final java.util.ArrayList<NativeEpisode> nativeEpisodes = new java.util.ArrayList<>();
    private int nativeEpisodeIndex = 0;
    private boolean nativeEpisodeStripOpen = false;
    private long nativeEpisodeScrollAtMs = 0L;
    private String nativeSubtitleUrl = "";
    private String nativeSubtitleHostHeader = "";
    private String nativeSubtitleLang = "";
    private String nativeSubtitleLabel = "";
    private String nativeSubtitleRel = "";
    private final java.util.ArrayList<String> nativeSubtitleChoiceRels = new java.util.ArrayList<>();
    private final java.util.ArrayList<String> nativeSubtitleChoiceLabels = new java.util.ArrayList<>();
    private final java.util.ArrayList<String> nativeSubtitleChoiceActions = new java.util.ArrayList<>();
    private final java.util.ArrayList<String> nativeSubtitleChoiceLangs = new java.util.ArrayList<>();
    private final java.util.ArrayList<String> nativeSubtitleChoiceUrls = new java.util.ArrayList<>();
    private final java.util.ArrayList<NativeCue> nativeSubtitleCues = new java.util.ArrayList<>();
    private final Handler nativeSubtitleHandler = new Handler(Looper.getMainLooper());
    private int nativeSubtitleLoadToken;
    private float nativeSubtitleShift;
    private boolean nativeHasWyzieSubtitle;
    private boolean nativeLiveStarted;
    private boolean nativeUserSeeking;
    private boolean nativeSeekDpadMode;
    private boolean nativeBackConsumedChromeDown;
    private boolean nativeGuideMode;
    private int nativeGuideEpoch;
    // Set from the web music player (TriboonTV.musicSession). When true, onPause() must NOT pause the
    // WebView, so music keeps playing with the screen off / app backgrounded. volatile: written on the
    // JS binder thread, read on the UI thread.
    private volatile boolean musicPlaying;
    private boolean musicServiceUp; // whether the foreground MusicService is currently running
    // Weak-ish static handle so the MusicService can forward lock-screen transport to the WebView.
    static MainActivity active;
    private View nativeClickArmedView;
    private long nativeClickArmedAtMs;
    private boolean nativeOpenSubtitleMenuAfterRefresh;
    private long nativeKnownDurationMs;
    private long nativePendingStartMs;
    private long nativeStartSeekIssuedAtMs;
    private long nativeStartOffsetMs;
    private long nativeLiveUnhealthySinceMs;
    private long nativeLiveLastRecoveryMs;
    private long nativeVideoUnhealthySinceMs;
    private boolean nativeVideoStarted;
    private boolean nativeVideoMemoryTrimmedDuringBuffer;
    private boolean nativeVideoErrorNotified;
    private long nativeLastVideoDisplayMs;
    private long nativeLastAutoResumeSeekMs;
    private int nativeBackwardTicks;
    private long nativeLastStatsMs;
    private static final long NATIVE_VIDEO_STARTUP_STALL_MS = 7000L;
    private static final long NATIVE_VIDEO_HEAVY_STARTUP_STALL_MS = 12000L;
    private static final long NATIVE_VIDEO_REBUFFER_TRIM_MS = 15000L;
    private static final long NATIVE_VIDEO_REBUFFER_RECOVERY_MS = 45000L;
    private static final long NATIVE_LIVE_STALL_RECOVERY_MS = 45000L;
    private static final long NATIVE_LIVE_STARTUP_STALL_RECOVERY_MS = 12000L;
    private static final long NATIVE_LIVE_RECOVERY_COOLDOWN_MS = 15000L;
    private static final int NATIVE_LIVE_READ_TIMEOUT_MS = 60000;
    // ---- Google Cast (sender) ----
    private com.google.android.gms.cast.framework.CastContext castContext;
    private com.google.android.gms.cast.framework.SessionManagerListener<com.google.android.gms.cast.framework.CastSession> castSessionListener;
    private com.google.android.gms.cast.framework.CastStateListener castStateListener;
    private com.google.android.gms.cast.framework.media.RemoteMediaClient.ProgressListener castProgress;
    private com.google.android.gms.cast.framework.media.RemoteMediaClient.Callback castCallback;
    private boolean castUnavailable;   // Play Services / SDK missing → never retry, keep the button hidden
    private boolean castHasDevices;    // a Cast route is discoverable right now (updated by castStateListener)
    private String castPendingJson;    // stream intent held until the picked session connects
    private final Handler nativeProgress = new Handler(Looper.getMainLooper());
    private final Runnable nativeSubtitleTick = new Runnable() {
        @Override public void run() {
            updateNativeSubtitleOverlay();
            if (nativePlayerOpen() && nativeHasWyzieSubtitle && !nativeSubtitleCues.isEmpty()) {
                nativeSubtitleHandler.postDelayed(this, 250);
            }
        }
    };
    private long lastBackAtRoot;             // BACK-twice-to-exit window
    private long lastSystemBackAt;           // guard duplicate dispatch + OnBackInvoked callbacks
    private boolean pageReady;               // main frame finished at least once
    private boolean pageTvReady;             // web focus model installed and has a target
    private volatile String currentWebUrl = ""; // WebView URL mirrored on UI thread for JavaBridge checks
    private volatile boolean pageInputFocused; // page reports text-field focus via the JS bridge
    private android.speech.SpeechRecognizer speech; // in-app voice search (created per use)
    private boolean voicePending;            // mic permission was requested BY a voice tap
    private int focusRecoveryEpoch;
    private android.window.OnBackInvokedCallback backInvokedCallback; // stored so onDestroy can unregister it
    private long lastWebRendererGoneAt;
    private int webRendererGoneCount;
    private final java.util.ArrayList<String> pendingTvKeys = new java.util.ArrayList<>();
    private final java.util.HashMap<String, PersonalIptvHostPin> personalIptvHostSafetyCache = new java.util.HashMap<>();
    private String nativePlaybackCapsCache;
    private MediaCodecInfo[] nativeDecoderInfoCache;
    private boolean nativeVoiceDucked;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        active = this; // MusicService forwards lock-screen transport back to this Activity
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0B0812); // --ink
        root.setFocusable(true);
        root.setFocusableInTouchMode(true);
        setContentView(root);
        // Phones show the system bars, and on modern Android (targetSdk 35+) the window is edge-to-edge
        // — content can draw UNDER the status/nav bars. Pad the content below the status bar and above
        // the nav bar so nothing (e.g. the top-left menu button) hides under a bar. Immersive (TV, or
        // fullscreen video) takes zero padding so the picture stays truly edge-to-edge. root's ink
        // background fills the bar regions, so the bars sit on the app's own color.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            boolean immersive = isTvDevice() || phonePlaybackOrientationLocked;
            if (immersive) {
                v.setPadding(0, 0, 0, 0);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(
                        android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        applySystemUiPolicy();

        buildSetupScreen();
        if (!ensureWebViewReady()) {
            showSetup(webViewUnavailableMessage());
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            backInvokedCallback = this::handleSystemBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    backInvokedCallback);
        }

        String server = normalizeServerUrl(prefs().getString(KEY_SERVER, ""));
        if (!server.equals(prefs().getString(KEY_SERVER, ""))) {
            prefs().edit().putString(KEY_SERVER, server).apply();
        }
        if (server.isEmpty()) showSetup(null);
        else {
            String serverError = serverUrlValidationError(server);
            if (!serverError.isEmpty()) showSetup(serverError);
            else web.loadUrl(server);
        }

        // First launch: ask for the mic up front so voice search Just Works later. One-shot —
        // if the user declines here, we only re-ask when they actually tap the mic button.
        if (isTvDevice()
                && Build.VERSION.SDK_INT >= 23
                && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                   != android.content.pm.PackageManager.PERMISSION_GRANTED
                && !prefs().getBoolean("askedMic", false)) {
            prefs().edit().putBoolean("askedMic", true).apply();
            requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        applySystemUiPolicy();
        if (web != null) {
            web.onResume();
            web.resumeTimers();
        }
        // Lazily bring up Google Cast (guarded on Play Services; a no-op on degoogled/Fire boxes).
        try { castCtx(); } catch (Throwable ignored) {}
        scheduleTvFocusRecovery("resume");
        // Returned from granting "install unknown apps"? Continue the update the user already started,
        // so they never have to press Update a second time.
        if (pendingUpdateUrl != null
                && (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getPackageManager().canRequestPackageInstalls())) {
            String u = pendingUpdateUrl; pendingUpdateUrl = null;
            downloadAndInstallUpdate(u);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            applySystemUiPolicy();
            scheduleTvFocusRecovery("window");
        }
    }

    private void scheduleTvFocusRecovery(String reason) {
        final int epoch = ++focusRecoveryEpoch;
        recoverTvFocus(reason);
        long[] delays = new long[] { 80L, 220L, 520L, 1100L };
        for (long delay : delays) {
            root.postDelayed(() -> {
                if (epoch == focusRecoveryEpoch) recoverTvFocus(reason);
            }, delay);
        }
    }

    private void recoverTvFocus(String reason) {
        if (root == null) return;
        if (setup != null && setup.getVisibility() == View.VISIBLE) {
            if (isTvDevice()) {
                if (addr != null) addr.requestFocus();
            } else {
                root.requestFocus();
            }
            return;
        }
        // In native GUIDE mode the WebView owns focus (the EPG is web-rendered), so fall through to
        // the web.requestFocus() branch below. Without this guard a lost focus in guide/PiP mode
        // requested focus on the non-focusable player layer (a no-op) and the guide went dead to
        // the D-pad until BACK was pressed.
        if (nativePlayerOpen() && !nativeGuideMode) {
            View current = getCurrentFocus();
            if (current == null || !current.isShown()) {
                if (nativePlayBtn != null && nativeChrome != null && nativeChrome.getVisibility() == View.VISIBLE) {
                    nativePlayBtn.requestFocus();
                } else if (nativePlayerLayer != null) {
                    nativePlayerLayer.requestFocus();
                }
            }
            return;
        }
        if (web != null && web.getVisibility() == View.VISIBLE) {
            web.setFocusable(true);
            web.setFocusableInTouchMode(true);
            web.requestFocus();
            if (pageTvReady) flushPendingTvKeys();
        } else {
            root.requestFocus();
        }
    }

    private void applySystemUiPolicy() {
        try {
            // Immersive (bars hidden) on TV always; on a phone only while a video is fullscreen.
            // Otherwise (phone, browsing) the status bar (top) and back/home/recents nav bar
            // (bottom) stay visible so the app sits inside the normal system UI.
            boolean immersive = isTvDevice() || phonePlaybackOrientationLocked;
            if (isTvDevice()) {
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
            } else if (!phonePlaybackOrientationLocked) {
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            }
            View decor = getWindow().getDecorView();
            if (immersive) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                    getWindow().setAttributes(lp);
                }
                decor.setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                                | View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
            } else {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
                    getWindow().setAttributes(lp);
                }
                // Bars VISIBLE, but lay the content out edge-to-edge UNDER them; the root inset
                // listener pads it back below the status bar / above the nav bar. Doing it this way
                // (rather than relying on the framework to inset) is consistent across Android
                // versions — API 35+ is edge-to-edge regardless of these flags.
                decor.setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
            }
            // Re-run the inset padding for the new immersive state (e.g. entering/leaving fullscreen video).
            if (root != null) root.requestApplyInsets();
        } catch (Exception ignored) {
        }
    }

    private boolean ensureWebViewReady() {
        String problem = webViewSupportProblem();
        if (problem != null) {
            Log.e(TAG, problem);
            return false;
        }
        if (web != null) return true;
        try {
            buildWebView();
            return true;
        } catch (Throwable t) {
            Log.e(TAG, "WebView startup failed", t);
            disposeWebView(web, false);
            return false;
        }
    }

    private String webViewUnavailableMessage() {
        String problem = webViewSupportProblem();
        if (problem != null) return problem;
        return "Android System WebView could not start. Update Android System WebView or Chrome, then reopen Triboon.";
    }

    private String webViewSupportProblem() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null;
        try {
            PackageInfo pkg = WebView.getCurrentWebViewPackage();
            if (pkg == null) {
                return "Android System WebView is missing or disabled. Update or enable Android System WebView or Chrome, then reopen Triboon.";
            }
            int major = parseMajorVersion(pkg.versionName);
            if (major > 0 && major < MIN_WEBVIEW_MAJOR) {
                return "Android System WebView is too old for Triboon. Update Android System WebView or Chrome, then reopen the app.";
            }
            return null;
        } catch (Throwable t) {
            Log.e(TAG, "WebView provider check failed", t);
            return "Android System WebView is not available. Update Android System WebView or Chrome, then reopen Triboon.";
        }
    }

    private int parseMajorVersion(String versionName) {
        if (versionName == null) return 0;
        try {
            String first = versionName.trim().split("\\.", 2)[0];
            return first.isEmpty() ? 0 : Integer.parseInt(first);
        } catch (Exception ignored) {
            return 0;
        }
    }

    private SharedPreferences prefs() { return getSharedPreferences(PREFS, MODE_PRIVATE); }

    private String normalizeServerUrl(String raw) {
        String url = raw == null ? "" : raw.trim();
        if (url.isEmpty()) return "";
        url = url.replaceAll("(?i)%3a", ":").replaceAll("(?i)%2f", "/");
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://" + url;
        return url.replaceAll("/+$", "");
    }

    private String serverUrlValidationError(String url) {
        try {
            Uri u = Uri.parse(url == null ? "" : url.trim());
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.US);
            if ("https".equals(scheme)) return "";
            if (!"http".equals(scheme)) return "Use an http or https Triboon server address.";
            if (isLocalCleartextServerHost(u.getHost())) return "";
        } catch (Exception ignored) {
        }
        return "Use HTTPS for remote Triboon addresses. Plain HTTP is limited to local/private LAN servers.";
    }

    private boolean isLocalCleartextServerHost(String host) {
        if (host == null) return false;
        String h = host.trim().toLowerCase(Locale.US);
        if (h.isEmpty()) return false;
        if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length() - 1);
        if (isAndroidLoopbackAlias(h)) return true;
        if (h.indexOf('.') < 0) return true; // short LAN names like "triboon" or "nas".
        if (h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
        if (!hostLooksLiteral(h)) return false;
        try {
            return isLocalCleartextServerAddress(InetAddress.getByName(h));
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean isLocalCleartextServerAddress(InetAddress addr) {
        if (addr == null) return false;
        if (addr.isLoopbackAddress() || addr.isLinkLocalAddress() || addr.isSiteLocalAddress()) return true;
        byte[] b = addr.getAddress();
        if (b == null) return false;
        if (b.length == 4) return isLocalCleartextIpv4Bytes(b, 0);
        if (b.length == 16) {
            int b0 = b[0] & 0xff;
            if ((b0 & 0xfe) == 0xfc) return true; // Unique local fc00::/7
            boolean mapped = true;
            for (int i = 0; i < 10; i++) mapped = mapped && b[i] == 0;
            if (mapped && (b[10] & 0xff) == 0xff && (b[11] & 0xff) == 0xff) {
                return isLocalCleartextIpv4Bytes(b, 12);
            }
            if (b0 == 0 && (b[1] & 0xff) == 0x64 && (b[2] & 0xff) == 0xff && (b[3] & 0xff) == 0x9b) {
                return isLocalCleartextIpv4Bytes(b, 12); // Well-known NAT64 prefix.
            }
        }
        return false;
    }

    private boolean isLocalCleartextIpv4Bytes(byte[] b, int offset) {
        if (b == null || b.length < offset + 4) return false;
        int a = b[offset] & 0xff;
        int c = b[offset + 1] & 0xff;
        if (a == 10 || a == 127) return true;
        if (a == 100 && c >= 64 && c <= 127) return true; // Private overlay/Tailscale-style CGNAT.
        if (a == 169 && c == 254) return true;
        if (a == 172 && c >= 16 && c <= 31) return true;
        return a == 192 && c == 168;
    }

    private int normalizedPort(Uri u) {
        if (u == null) return -1;
        int port = u.getPort();
        if (port > 0) return port;
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.US);
        if ("https".equals(scheme)) return 443;
        if ("http".equals(scheme)) return 80;
        return -1;
    }

    private boolean sameOrigin(Uri a, Uri b) {
        if (a == null || b == null) return false;
        String as = a.getScheme() == null ? "" : a.getScheme().toLowerCase(Locale.US);
        String bs = b.getScheme() == null ? "" : b.getScheme().toLowerCase(Locale.US);
        String ah = a.getHost() == null ? "" : a.getHost().toLowerCase(Locale.US);
        String bh = b.getHost() == null ? "" : b.getHost().toLowerCase(Locale.US);
        if (as.isEmpty() || !as.equals(bs) || ah.isEmpty() || normalizedPort(a) != normalizedPort(b)) {
            return false;
        }
        return ah.equals(bh) || (isAndroidLoopbackAlias(ah) && isAndroidLoopbackAlias(bh));
    }

    private boolean isAndroidLoopbackAlias(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.US);
        return "localhost".equals(h) || "127.0.0.1".equals(h) || "::1".equals(h) || "10.0.2.2".equals(h);
    }

    private boolean isTrustedServerUrl(String raw) {
        String server = normalizeServerUrl(prefs().getString(KEY_SERVER, ""));
        if (server.isEmpty() || raw == null || raw.trim().isEmpty()) return false;
        try {
            return sameOrigin(Uri.parse(raw), Uri.parse(server));
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean trustedBridgeOrigin() {
        return isTrustedServerUrl(currentWebUrl);
    }

    private String jsonEscape(String value) {
        if (value == null) return "";
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private boolean allowedAppUpdateUrl(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.US);
        String path = uri.getPath() == null ? "" : uri.getPath();
        if (!"https".equals(scheme) || !"github.com".equals(host)) return false;
        // Accept the stable Triboon release asset under ANY owner/repo on github.com. This allowlist
        // is baked into the installed APK, so pinning it to a single repo name meant a future GitHub
        // rename would strand the in-app updater on every existing device. Still strictly locked to
        // https + github.com + the Triboon asset filenames + the /releases/latest/download/ path, and
        // the URL itself only ever comes from the trusted server-served UI — so a rename just works.
        // Accept the canonical single asset (triboon.apk) AND the legacy tv/mobile aliases, so this
        // build can update from either during the one-APK migration.
        return path.matches("/[^/]+/[^/]+/releases/latest/download/triboon(-(tv|mobile))?\\.apk");
    }

    private void openExternalUrl(String rawUrl) {
        try {
            Uri uri = Uri.parse(rawUrl == null ? "" : rawUrl.trim());
            if (!allowedAppUpdateUrl(uri)) {
                Toast.makeText(this, "Update link was blocked", Toast.LENGTH_SHORT).show();
                return;
            }
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, "Could not open update link", Toast.LENGTH_SHORT).show();
        }
    }

    private volatile boolean updateInProgress = false;
    private String pendingUpdateUrl = null;       // set when we bounce the user to grant "install unknown apps"
    private java.io.File cachedUpdateApk = null;   // last APK downloaded this session — a re-press installs it instantly

    // Download the signed release APK (same allowlisted GitHub URL the browser path uses) and hand
    // it straight to the system package installer — no browser/downloader detour. Any failure
    // falls back to openExternalUrl so the user can still get the update.
    private void downloadAndInstallUpdate(String rawUrl) {
        final String url = rawUrl == null ? "" : rawUrl.trim();
        Uri uri = Uri.parse(url);
        if (!allowedAppUpdateUrl(uri)) { Toast.makeText(this, "Update link was blocked", Toast.LENGTH_SHORT).show(); return; }
        if (updateInProgress) { Toast.makeText(this, "Update is already downloading…", Toast.LENGTH_SHORT).show(); return; }
        // Android 8+: the app needs the one-time "install unknown apps" grant. Send the user there and
        // REMEMBER the URL so onResume continues automatically once it's granted — no second press.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            pendingUpdateUrl = url;
            Toast.makeText(this, "Allow Triboon to install apps — the update continues automatically", Toast.LENGTH_LONG).show();
            try {
                Intent perm = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName()));
                perm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(perm);
            } catch (Exception e) { pendingUpdateUrl = null; openExternalUrl(url); }
            return;
        }
        // Already downloaded this session? Go straight to the installer — if the install prompt didn't
        // surface the first time, a re-press installs instantly instead of downloading all over again.
        if (cachedUpdateApk != null && cachedUpdateApk.isFile() && cachedUpdateApk.length() > 100000) {
            launchApkInstall(cachedUpdateApk);
            return;
        }
        updateInProgress = true;
        Toast.makeText(this, "Downloading update…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            java.io.File out = new java.io.File(getCacheDir(), "triboon-update.apk");
            try {
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);
                conn.setRequestProperty("User-Agent", "TriboonTV/" + BuildConfig.VERSION_NAME);
                int code = conn.getResponseCode();
                if (code != 200) throw new java.io.IOException("HTTP " + code);
                try (java.io.InputStream in = conn.getInputStream();
                     java.io.FileOutputStream fos = new java.io.FileOutputStream(out)) {
                    byte[] buf = new byte[65536]; int n;
                    while ((n = in.read(buf)) != -1) fos.write(buf, 0, n);
                }
                conn.disconnect();
                if (out.length() < 100000) throw new java.io.IOException("downloaded file too small");
                runOnUiThread(() -> { updateInProgress = false; cachedUpdateApk = out; launchApkInstall(out); });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    updateInProgress = false;
                    Toast.makeText(this, "In-app update failed; opening the download instead", Toast.LENGTH_SHORT).show();
                    openExternalUrl(url);
                });
            }
        }, "triboon-update-dl").start();
    }

    private void launchApkInstall(java.io.File apk) {
        try {
            Uri apkUri = androidx.core.content.FileProvider.getUriForFile(this, getPackageName() + ".updateprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, "Could not start the installer", Toast.LENGTH_SHORT).show();
        }
    }

    private boolean isBlockedPersonalIptvAddress(InetAddress addr) {
        if (addr == null) return true;
        if (addr.isAnyLocalAddress() || addr.isLoopbackAddress() || addr.isLinkLocalAddress()
                || addr.isSiteLocalAddress() || addr.isMulticastAddress()) return true;
        byte[] b = addr.getAddress();
        if (b == null) return true;
        if (b.length == 4) return isBlockedIpv4Bytes(b, 0);
        if (b.length == 16) {
            int b0 = b[0] & 0xff;
            int b1 = b[1] & 0xff;
            int b2 = b[2] & 0xff;
            int b3 = b[3] & 0xff;
            if ((b0 & 0xfe) == 0xfc) return true;                 // Unique local fc00::/7
            if (b0 == 0x20 && b1 == 0x02) return true;             // 6to4 can embed private IPv4
            if (b0 == 0x20 && b1 == 0x01 && b2 == 0 && b3 == 0) return true; // Teredo
            boolean mapped = true;
            for (int i = 0; i < 10; i++) mapped = mapped && b[i] == 0;
            if (mapped && (b[10] & 0xff) == 0xff && (b[11] & 0xff) == 0xff) {
                return isBlockedIpv4Bytes(b, 12);
            }
            if (b0 == 0 && b1 == 0x64 && b2 == 0xff && b3 == 0x9b) {
                return isBlockedIpv4Bytes(b, 12);                 // Well-known NAT64 prefix
            }
        }
        return false;
    }

    private boolean isBlockedIpv4Bytes(byte[] b, int offset) {
        if (b == null || b.length < offset + 4) return true;
        int a = b[offset] & 0xff;
        int c = b[offset + 1] & 0xff;
        if (a == 0 || a == 10 || a == 127) return true;
        if (a == 100 && c >= 64 && c <= 127) return true;          // CGNAT
        if (a == 169 && c == 254) return true;
        if (a == 172 && c >= 16 && c <= 31) return true;
        if (a == 192 && (c == 0 || c == 168)) return true;
        if (a == 198 && (c == 18 || c == 19)) return true;
        return a >= 224;
    }

    private static class ValidatedNativeUrl {
        final String originalUrl;
        final String connectUrl;
        final String hostHeader;

        ValidatedNativeUrl(String originalUrl, String connectUrl, String hostHeader) {
            this.originalUrl = originalUrl == null ? "" : originalUrl;
            this.connectUrl = connectUrl == null ? "" : connectUrl;
            this.hostHeader = hostHeader == null ? "" : hostHeader;
        }
    }

    private static class PersonalIptvHostPin {
        final InetAddress address;
        final long expiresAt;

        PersonalIptvHostPin(InetAddress address, long expiresAt) {
            this.address = address;
            this.expiresAt = expiresAt;
        }
    }

    private String hostHeaderFor(Uri u) {
        if (u == null || u.getHost() == null || u.getHost().trim().isEmpty()) return "";
        String host = u.getHost().trim();
        if (host.indexOf(':') >= 0 && !host.startsWith("[") && !host.endsWith("]")) {
            host = "[" + host + "]";
        }
        int port = u.getPort();
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.US);
        boolean defaultPort = ("http".equals(scheme) && port == 80) || ("https".equals(scheme) && port == 443);
        return port > 0 && !defaultPort ? host + ":" + port : host;
    }

    private String addressAuthority(InetAddress address, int port, String scheme) {
        String host = address == null ? "" : address.getHostAddress();
        if (host.indexOf('%') >= 0) host = host.substring(0, host.indexOf('%'));
        if (host.indexOf(':') >= 0 && !host.startsWith("[") && !host.endsWith("]")) {
            host = "[" + host + "]";
        }
        boolean defaultPort = ("http".equals(scheme) && port == 80) || ("https".equals(scheme) && port == 443);
        return port > 0 && !defaultPort ? host + ":" + port : host;
    }

    private boolean hostHeaderSafe(String hostHeader) {
        return hostHeader != null && !hostHeader.trim().isEmpty()
                && hostHeader.indexOf('\r') < 0 && hostHeader.indexOf('\n') < 0;
    }

    private boolean hostLooksLiteral(String host) {
        if (host == null) return false;
        String h = host.trim();
        if (h.isEmpty()) return false;
        return h.indexOf(':') >= 0 || h.matches("^[0-9.]+$");
    }

    private ValidatedNativeUrl validateAndPinPersonalIptvUrl(String raw) throws IOException {
        String url = normalizeHttpUrl(raw, false);
        Uri u = Uri.parse(url);
        String scheme = u == null || u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.US);
        String host = u == null || u.getHost() == null ? "" : u.getHost().trim();
        if (!"http".equals(scheme) && !"https".equals(scheme)) throw new IOException("only http/https URLs are supported");
        if (host.isEmpty()) throw new IOException("host is missing");
        if ("localhost".equalsIgnoreCase(host) || host.toLowerCase(Locale.US).endsWith(".localhost")) {
            throw new IOException("local/private IPTV hosts are blocked on this device");
        }
        String cacheKey = scheme + "|" + host.toLowerCase(Locale.US) + "|" + normalizedPort(u);
        long now = SystemClock.elapsedRealtime();
        PersonalIptvHostPin cached = personalIptvHostSafetyCache.get(cacheKey);
        InetAddress picked = cached != null && cached.expiresAt > now ? cached.address : null;
        if (picked == null) {
            InetAddress[] addresses = InetAddress.getAllByName(host);
            if (addresses == null || addresses.length == 0) throw new IOException("host could not be resolved");
            for (InetAddress address : addresses) {
                if (isBlockedPersonalIptvAddress(address)) {
                    throw new IOException("local/private IPTV hosts are blocked on this device");
                }
            }
            picked = addresses[0];
            personalIptvHostSafetyCache.put(cacheKey, new PersonalIptvHostPin(picked, now + PERSONAL_IPTV_HOST_SAFETY_TTL_MS));
        }
        if ("https".equals(scheme) && !hostLooksLiteral(host)) {
            throw new IOException("device-local HTTPS IPTV cannot be DNS-pinned on this Android build; add this playlist to the server instead");
        }
        String hostHeader = hostHeaderFor(u);
        if (!hostHeaderSafe(hostHeader)) throw new IOException("invalid IPTV host");
        String pinnedAuthority = addressAuthority(picked, u.getPort(), scheme);
        String pinnedUrl = u.buildUpon().encodedAuthority(pinnedAuthority).build().toString();
        return new ValidatedNativeUrl(url, pinnedUrl, hostHeader);
    }

    private String validatedPersonalIptvUrl(String raw) throws IOException {
        return validateAndPinPersonalIptvUrl(raw).originalUrl;
    }

    private ValidatedNativeUrl validateNativePlaybackUrl(String raw) throws IOException {
        String url = normalizeHttpUrl(raw, false);
        if (url.isEmpty()) throw new IOException("missing stream url");
        if (isTrustedServerUrl(url)) return new ValidatedNativeUrl(url, url, "");
        return validateAndPinPersonalIptvUrl(url);
    }

    private String nativeThrowableMessage(Throwable e) {
        String msg = e == null ? "" : e.getMessage();
        if (msg == null || msg.trim().isEmpty()) {
            msg = e == null ? "native player failed" : e.getClass().getSimpleName();
        }
        return msg;
    }

    private ValidatedNativeUrl optionalNativeFallbackUrl(String raw, String label) {
        String url = raw == null ? "" : raw.trim();
        if (url.isEmpty()) return null;
        try {
            return validateNativePlaybackUrl(url);
        } catch (Exception e) {
            Log.w(TAG, "Skipping invalid native fallback " + label + ": " + nativeThrowableMessage(e));
            return null;
        }
    }

    private ValidatedNativeUrl validateNativeSubtitleOverlayUrl(String raw, String pinnedHostHeader) throws IOException {
        ValidatedNativeUrl safe = validateNativePlaybackUrl(raw);
        String hostHeader = safe.hostHeader;
        try {
            String connectHost = Uri.parse(safe.connectUrl).getHost();
            if (hostHeaderSafe(pinnedHostHeader) && hostLooksLiteral(connectHost)) {
                hostHeader = pinnedHostHeader.trim();
            }
        } catch (Exception ignored) {}
        return new ValidatedNativeUrl(safe.originalUrl, safe.connectUrl, hostHeader);
    }

    private String validatedNativePlaybackUrl(String raw) throws IOException {
        return validateNativePlaybackUrl(raw).connectUrl;
    }

    private boolean isTvDevice() {
        android.app.UiModeManager ui = (android.app.UiModeManager) getSystemService(UI_MODE_SERVICE);
        return ui != null && ui.getCurrentModeType() == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION;
    }

    private void setPhonePlaybackOrientation(boolean active) {
        if (isTvDevice()) return;
        try {
            if (active) {
                if (!phonePlaybackOrientationLocked) {
                    phoneOrientationBeforePlayback = getRequestedOrientation();
                    phonePlaybackOrientationLocked = true;
                }
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            } else if (phonePlaybackOrientationLocked) {
                phonePlaybackOrientationLocked = false;
                setRequestedOrientation(phoneOrientationBeforePlayback);
                phoneOrientationBeforePlayback = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
            }
            // The lock flag just flipped — re-apply so bars hide on entering fullscreen video
            // and the status/nav bars come back on exit.
            applySystemUiPolicy();
        } catch (Exception ignored) {
        }
    }

    private void hidePhoneKeyboard(View tokenView) {
        if (isTvDevice()) return;
        try {
            View v = tokenView == null ? root : tokenView;
            if (v == null) return;
            ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
                    .hideSoftInputFromWindow(v.getWindowToken(), 0);
        } catch (Exception ignored) {
        }
    }

    // ---------- WebView ----------
    @SuppressLint("SetJavaScriptEnabled")
    private void buildWebView() {
        // Lets chrome://inspect (or the DevTools protocol over adb) attach to the page —
        // adb access is owner-gated anyway, and this is how TV-side issues get diagnosed.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web = new WebView(this);
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        // The shell HTML is served no-cache by the server. Keep WebView's normal disk cache
        // for art/assets between launches; only flush once after an APK version change.
        String cacheVersion = prefs().getString(KEY_CACHE_VERSION, "");
        if (!BuildConfig.VERSION_NAME.equals(cacheVersion)) {
            web.postDelayed(() -> {
                if (web == null) return;
                web.clearCache(true);
                prefs().edit().putString(KEY_CACHE_VERSION, BuildConfig.VERSION_NAME).apply();
            }, 5500);
        }
        web.setBackgroundColor(0xFF0B0812);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                       // login token lives in localStorage
        s.setMediaPlaybackRequiresUserGesture(false);       // press-play = instant playback
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            s.setOffscreenPreRaster(true);
        }
        s.setSupportZoom(false);
        // Tag the UA so the web UI can adapt. Phones stay in responsive touch mode; TVs get
        // the D-pad shell class and direct-play-first TV treatment.
        boolean isTv = isTvDevice();
        s.setUserAgentString(s.getUserAgentString() + (isTv ? " TriboonTV/" : " TriboonAndroid/") + BuildConfig.VERSION_NAME);

        // TV surfaces vary (1080p UI on onn-class boxes, true 4K on a Shield set to 4K UI).
        // Left to its own devices the WebView lays the page out at a tablet-ish width and
        // upscales — soft on a 4K panel. Instead: lay out at a fixed 1920 CSS px (the web
        // UI's designed TV layout) and scale it 1:1 onto the REAL surface — 100% on a
        // 1080p surface, 200% on a 4K surface, i.e. native-resolution rendering either way.
        android.util.DisplayMetrics dm = new android.util.DisplayMetrics();
        getWindowManager().getDefaultDisplay().getRealMetrics(dm);
        if (isTv) {
            s.setUseWideViewPort(false);
            // 1280 CSS px layout (not 1920): sized against Plex's Android TV app — fonts,
            // icons and posters land at Plex proportions on the same panel.
            // Only the page LAYOUT scales — video still decodes at full surface resolution.
            web.setInitialScale((int) Math.round(Math.max(dm.widthPixels, dm.heightPixels) / 1280.0 * 100));
        } else {
            // Phone/tablet sideloads keep stock responsive behavior.
            s.setLoadWithOverviewMode(true);
            s.setUseWideViewPort(true);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap favicon) {
                pageReady = false;
                pageTvReady = false;
                currentWebUrl = url == null ? "" : url;
                pendingTvKeys.clear();
            }

            @Override public void onPageFinished(WebView v, String url) {
                pageReady = true;
                currentWebUrl = url == null ? "" : url;
                scheduleTvFocusRecovery("page");
                if (!isTvDevice()) clearPhoneInitialWebInputFocus();
            }

            @Override public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (Build.VERSION.SDK_INT >= 23 && req.isForMainFrame()) {
                    resetWebPageState();
                    showSetup("Couldn't reach the server — check the address and that Triboon is running.");
                }
            }

            @Override
            @TargetApi(Build.VERSION_CODES.O)
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                final boolean didCrash = detail != null && detail.didCrash();
                final int priorityAtExit = detail == null ? -1 : detail.rendererPriorityAtExit();
                root.post(() -> recoverWebRenderer(v, didCrash, priorityAtExit));
                return true;
            }

            // Stay inside the app: only the configured server's pages render here. The web UI
            // hands video off to intent URLs only on desktop (VLC), so anything else is noise.
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                return u == null || !isTrustedServerUrl(u.toString());
            }
        });

        // HTML5 fullscreen (the player's F toggle) → swap in the custom view like a video app.
        // JS dialogs (the web app's add-profile prompt()s, delete confirm()s) get native,
        // D-pad-friendly dialogs — a WebView silently returns null for them otherwise.
        web.setWebChromeClient(new WebChromeClient() {
            // WebView paints a DEFAULT gray play-button bitmap whenever a <video> has no
            // frame — a giant icon flashing on every seek restart. A 1×1 transparent
            // bitmap keeps the screen on the last frame / black instead.
            @Override public android.graphics.Bitmap getDefaultVideoPoster() {
                return android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888);
            }

            @Override public void onShowCustomView(View view, CustomViewCallback cb) {
                if (fullscreenVideo != null) { cb.onCustomViewHidden(); return; }
                fullscreenVideo = view;
                web.setVisibility(View.GONE);
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                // Phone HTML5 fullscreen video (trailers / web player) goes immersive like native
                // playback; hides the now-visible phone bars. No-op on TV (already immersive).
                setPhonePlaybackOrientation(true);
            }
            @Override public void onHideCustomView() {
                if (fullscreenVideo == null) return;
                root.removeView(fullscreenVideo);
                fullscreenVideo = null;
                web.setVisibility(View.VISIBLE);
                web.requestFocus();
                // Exit fullscreen video → restore phone orientation + bring the bars back.
                setPhonePlaybackOrientation(false);
            }

            @Override public boolean onJsAlert(WebView v, String url, String msg, android.webkit.JsResult r) {
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(msg)
                        .setPositiveButton(android.R.string.ok, (d, w) -> r.confirm())
                        .setOnCancelListener(d -> r.cancel())
                        .show();
                return true;
            }

            @Override public boolean onJsConfirm(WebView v, String url, String msg, android.webkit.JsResult r) {
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(msg)
                        .setPositiveButton(android.R.string.ok, (d, w) -> r.confirm())
                        .setNegativeButton(android.R.string.cancel, (d, w) -> r.cancel())
                        .setOnCancelListener(d -> r.cancel())
                        .show();
                return true;
            }

            @Override public boolean onJsPrompt(WebView v, String url, String msg, String def, android.webkit.JsPromptResult r) {
                EditText input = new EditText(MainActivity.this);
                input.setText(def == null ? "" : def);
                input.setSingleLine(true);
                new android.app.AlertDialog.Builder(MainActivity.this)
                        .setMessage(msg)
                        .setView(input)
                        .setPositiveButton(android.R.string.ok, (d, w) -> r.confirm(input.getText().toString()))
                        .setNegativeButton(android.R.string.cancel, (d, w) -> r.cancel())
                        .setOnCancelListener(d -> r.cancel())
                        .show();
                return true;
            }
        });

        // The page reports whether a text field has real focus (see __tvInputState in the
        // web UI) — while it does, D-pad keys are handed back to native/IME handling.
        // startVoice() runs the platform speech recognizer (WebView has no speech backend);
        // the transcript goes back to the page through window.__tvVoice.
        web.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void inputFocus(boolean focused) {
                if (!trustedBridgeOrigin()) return;
                pageInputFocused = focused;
            }

            @android.webkit.JavascriptInterface
            public void appReady() {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> {
                    pageTvReady = true;
                    scheduleTvFocusRecovery("appReady");
                    flushPendingTvKeys();
                });
            }

            @android.webkit.JavascriptInterface
            public void startVoice() {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(MainActivity.this::startVoiceFlow);
            }

            @android.webkit.JavascriptInterface
            public int nativeChromeVersion() {
                if (!trustedBridgeOrigin()) return 0;
                return 4; // v4: native live EPG strip + Go-live; v3: in-app self-update; v2: Up Next card
            }

            // Cast Phase 2: the web UI relays the server's configured custom-receiver app-id here so
            // the native Cast sender (CastOptionsProvider) launches the right receiver. Persisted to
            // SharedPreferences; validated to 8 hex chars (empty clears it -> Default Media Receiver).
            // The Cast SDK reads the app-id once at process start, so a change takes effect on next
            // launch — until then the previous/default receiver is used, which is always safe.
            @android.webkit.JavascriptInterface
            public void setCastReceiverAppId(String id) {
                if (!trustedBridgeOrigin()) return;
                String v = (id == null) ? "" : id.trim().toUpperCase();
                if (!v.matches("[0-9A-F]{8}")) v = ""; // empty = fall back to Default Media Receiver
                try {
                    SharedPreferences p = prefs();
                    if (!v.equals(p.getString("castReceiverAppId", ""))) {
                        p.edit().putString("castReceiverAppId", v).apply();
                    }
                } catch (Exception ignored) {}
            }

            @android.webkit.JavascriptInterface
            public void setLiveEpg(String json) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> {
                    try { nativeEpgData = (json == null || json.isEmpty()) ? null : new org.json.JSONArray(json); }
                    catch (Exception e) { nativeEpgData = null; }
                    renderNativeEpgStrip();
                });
            }

            @android.webkit.JavascriptInterface
            public void upNext(String json) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> showNativeUpNext(json));
            }

            @android.webkit.JavascriptInterface
            public void upNextHide() {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> dismissNativeUpNext(false));
            }

            @android.webkit.JavascriptInterface
            public void setLiveFav(boolean on) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> { nativeLiveFav = on; applyNativeFavIcon(); });
            }

            @android.webkit.JavascriptInterface
            public String nativePlaybackCaps() {
                if (!trustedBridgeOrigin()) return "{}";
                return buildNativePlaybackCaps();
            }

            @android.webkit.JavascriptInterface
            public String appVersion() {
                if (!trustedBridgeOrigin()) return "{}";
                return "{\"versionName\":\"" + jsonEscape(BuildConfig.VERSION_NAME)
                        + "\",\"versionCode\":" + BuildConfig.VERSION_CODE
                        + ",\"tv\":" + (isTvDevice() ? "true" : "false") + "}";
            }

            @android.webkit.JavascriptInterface
            public void openAppUpdate(String url) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> openExternalUrl(url));
            }

            // In-app self-update: download the signed APK and launch the system installer directly,
            // instead of bouncing to a browser/downloader. Falls back to openExternalUrl on failure.
            @android.webkit.JavascriptInterface
            public void installAppUpdate(String url) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> downloadAndInstallUpdate(url));
            }

            @android.webkit.JavascriptInterface
            public int personalIptvVersion() {
                if (!trustedBridgeOrigin()) return 0;
                return 1;
            }

            @android.webkit.JavascriptInterface
            public String personalIptvSources() {
                if (!trustedBridgeOrigin()) return "[]";
                return personalIptvSourcesRedacted();
            }

            @android.webkit.JavascriptInterface
            public String personalIptvSave(String json) {
                if (!trustedBridgeOrigin()) return "{\"ok\":false,\"error\":\"untrusted page\"}";
                return savePersonalIptvSource(json);
            }

            @android.webkit.JavascriptInterface
            public String personalIptvDelete(String id) {
                if (!trustedBridgeOrigin()) return "{\"ok\":false,\"error\":\"untrusted page\"}";
                return deletePersonalIptvSource(id);
            }

            @android.webkit.JavascriptInterface
            public void personalIptvLoad(String token) {
                if (!trustedBridgeOrigin()) return;
                loadPersonalIptvChannels(token);
            }

            @android.webkit.JavascriptInterface
            public void personalIptvGuide(String token, String json) {
                if (!trustedBridgeOrigin()) return;
                loadPersonalIptvGuide(token, json);
            }

            @android.webkit.JavascriptInterface
            public void playLive(String json) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> startNativeLive(json));
            }

            @android.webkit.JavascriptInterface
            public void playVideo(String json) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> startNativeVideo(json));
            }

            @android.webkit.JavascriptInterface
            public void showVideoLoading(String json) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> showNativeVideoLoading(json));
            }

            @android.webkit.JavascriptInterface
            public void closeVideo() {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> closeNativePlayback(false));
            }

            @android.webkit.JavascriptInterface
            public void updateSubtitleChoices(String json) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> updateNativeSubtitleChoices(json));
            }

            @android.webkit.JavascriptInterface
            public void updateActiveSubtitle(String json) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> updateNativeActiveSubtitle(json));
            }

            @android.webkit.JavascriptInterface
            public void updateVideoDuration(String seconds) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> updateNativeVideoDuration(seconds));
            }

            @android.webkit.JavascriptInterface
            public void updateEpisodeChoices(String json) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> updateNativeEpisodeChoices(json));
            }

            @android.webkit.JavascriptInterface
            public void closeGuide() {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(MainActivity.this::closeNativeGuideMode);
            }

            @android.webkit.JavascriptInterface
            public void openGuide() {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(MainActivity.this::openNativeLiveGuide);
            }

            @android.webkit.JavascriptInterface
            public void setGuidePipRect(String json) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> applyNativeGuidePipRect(json));
            }

            // Web music player pushes now-playing state (title/artist/artwork/duration/position +
            // playing). The shell keeps the WebView alive (onPause guard) AND mirrors it into the
            // foreground MusicService for background playback + lock-screen/notification controls.
            @android.webkit.JavascriptInterface
            public void musicSession(String json) {
                if (!trustedBridgeOrigin()) return;
                org.json.JSONObject j;
                try { j = new org.json.JSONObject(json); } catch (Throwable ignored) { return; }
                final boolean playing = j.optBoolean("playing", false);
                musicPlaying = playing;
                runOnUiThread(() -> updateMusicService(j, playing));
            }
            @android.webkit.JavascriptInterface
            public void musicStop() {
                if (!trustedBridgeOrigin()) return;
                musicPlaying = false;
                runOnUiThread(MainActivity.this::stopMusicService);
            }
            // Google Cast (sender): the web player's Cast button routes here when running in the app.
            // castRequest shows the route picker + loads the stream on the receiver; the web reflects
            // cast state via window.__tvCast(...). VOD only (the web gates Live TV out).
            @android.webkit.JavascriptInterface
            public void castRequest(String json) {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> handleCastRequest(json));
            }
            @android.webkit.JavascriptInterface
            public void castControl(String action) { // "play" | "pause" | "seek:<seconds>"
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(() -> handleCastControl(action));
            }
            @android.webkit.JavascriptInterface
            public void castStop() {
                if (!trustedBridgeOrigin()) return;
                runOnUiThread(MainActivity.this::handleCastStop);
            }
            // Is a Cast device discoverable right now? Cached flag updated on the UI thread by the
            // CastStateListener (this runs on the JS bridge thread, so it must not init CastContext).
            @android.webkit.JavascriptInterface
            public boolean castAvailable() {
                return castHasDevices;
            }
        }, "TriboonTV");

        addWebViewBehindOverlays();
        web.requestFocus(View.FOCUS_DOWN);
    }

    private void addWebViewBehindOverlays() {
        root.addView(web, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void resetWebPageState() {
        pageReady = false;
        pageTvReady = false;
        currentWebUrl = "";
        pageInputFocused = false;
        pendingTvKeys.clear();
        // A reloaded/recovered WebView has thrown away the <audio> element, so the music session is
        // gone: clear the flag (else onPause would skip suspending the WebView, thinking music is
        // live) and tear down the now-orphaned foreground service + its stale notification. A real
        // resume re-arms both via the musicSession() JS bridge.
        if (musicPlaying) {
            musicPlaying = false;
            stopMusicService();
        }
    }

    private void clearPhoneInitialWebInputFocus() {
        if (web == null) return;
        web.postDelayed(() -> {
            if (web == null || isTvDevice()) return;
            web.evaluateJavascript("(function(){var a=document.activeElement;if(a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)){a.blur();}document.body&&document.body.focus&&document.body.focus();})()", null);
            hidePhoneKeyboard(web);
        }, 350);
    }

    private org.json.JSONArray personalIptvStoredSources() {
        try {
            org.json.JSONArray arr = new org.json.JSONArray(readPersonalIptvJson());
            return arr;
        } catch (Exception ignored) {
            return new org.json.JSONArray();
        }
    }

    private void savePersonalIptvStoredSources(org.json.JSONArray arr) {
        writePersonalEncryptedPref(KEY_PERSONAL_IPTV, arr == null ? "[]" : arr.toString());
    }

    private String readPersonalIptvJson() {
        return readPersonalEncryptedPref(KEY_PERSONAL_IPTV, "[]");
    }

    private String readPersonalEncryptedPref(String key, String fallback) {
        android.content.SharedPreferences p = prefs();
        if (!p.contains(key)) return fallback;
        String stored = p.getString(key, fallback);
        if (stored == null || stored.isEmpty()) return fallback;
        if (!stored.startsWith(PERSONAL_IPTV_ENC_PREFIX)) {
            p.edit().remove(key).apply();
            Log.w(TAG, "Cleared legacy plaintext personal IPTV pref");
            return fallback;
        }
        try {
            String body = stored.substring(PERSONAL_IPTV_ENC_PREFIX.length());
            int sep = body.indexOf(':');
            if (sep <= 0) return fallback;
            byte[] iv = Base64.decode(body.substring(0, sep), Base64.NO_WRAP);
            byte[] cipherText = Base64.decode(body.substring(sep + 1), Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, personalIptvSecretKey(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(cipherText), StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.w(TAG, "Personal IPTV pref decrypt failed: " + e.getClass().getSimpleName());
            return fallback;
        }
    }

    private void writePersonalEncryptedPref(String key, String json) {
        prefs().edit().putString(key, encryptPersonalIptvJson(json == null ? "{}" : json)).apply();
    }

    private org.json.JSONObject readPersonalCacheObject(String key) {
        try {
            return new org.json.JSONObject(readPersonalEncryptedPref(key, "{}"));
        } catch (Exception ignored) {
            return new org.json.JSONObject();
        }
    }

    private void writePersonalCacheObject(String key, org.json.JSONObject obj) {
        try {
            writePersonalEncryptedPref(key, obj == null ? "{}" : obj.toString());
        } catch (RuntimeException e) {
            Log.w(TAG, "Personal IPTV cache write skipped: " + e.getMessage());
        }
    }

    private String encryptPersonalIptvJson(String json) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, personalIptvSecretKey());
            byte[] iv = cipher.getIV();
            byte[] cipherText = cipher.doFinal((json == null ? "[]" : json).getBytes(StandardCharsets.UTF_8));
            return PERSONAL_IPTV_ENC_PREFIX
                    + Base64.encodeToString(iv, Base64.NO_WRAP)
                    + ":"
                    + Base64.encodeToString(cipherText, Base64.NO_WRAP);
        } catch (Exception e) {
            Log.w(TAG, "Personal IPTV encrypt failed: " + e.getClass().getSimpleName());
            throw new IllegalStateException("secure personal IPTV storage is unavailable", e);
        }
    }

    private SecretKey personalIptvSecretKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(PERSONAL_IPTV_KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(PERSONAL_IPTV_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return kg.generateKey();
    }

    private org.json.JSONArray personalIptvRedactedArray() {
        org.json.JSONArray stored = personalIptvStoredSources();
        org.json.JSONArray out = new org.json.JSONArray();
        for (int i = 0; i < stored.length(); i++) {
            org.json.JSONObject src = stored.optJSONObject(i);
            if (src == null) continue;
            org.json.JSONObject row = new org.json.JSONObject();
            try {
                String mode = src.optString("mode", "xtream");
                row.put("id", src.optString("id", ""));
                row.put("mode", mode);
                row.put("name", src.optString("name", "Personal IPTV"));
                row.put("host", "m3u".equals(mode) ? hostLabel(src.optString("url", "")) : hostLabel(src.optString("host", "")));
                row.put("hasUser", !src.optString("user", "").isEmpty());
                out.put(row);
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    private String personalIptvSourcesRedacted() {
        return personalIptvRedactedArray().toString();
    }

    private String savePersonalIptvSource(String json) {
        try {
            org.json.JSONObject j = new org.json.JSONObject(json == null ? "{}" : json);
            String id = j.optString("id", "").trim();
            org.json.JSONArray stored = personalIptvStoredSources();
            org.json.JSONObject existing = null;
            if (!id.isEmpty()) {
                for (int i = 0; i < stored.length(); i++) {
                    org.json.JSONObject old = stored.optJSONObject(i);
                    if (old != null && id.equals(old.optString("id", ""))) {
                        existing = old;
                        break;
                    }
                }
            }
            String existingMode = existing == null ? "" : existing.optString("mode", "xtream");
            String mode = "m3u".equals(j.optString("mode", existingMode.isEmpty() ? "xtream" : existingMode)) ? "m3u" : "xtream";
            boolean sameMode = existing != null && mode.equals(existingMode);
            String name = cleanText(j.optString("name", ""));
            if (name.isEmpty() && existing != null) name = cleanText(existing.optString("name", ""));
            org.json.JSONObject src = new org.json.JSONObject();
            src.put("mode", mode);
            if ("m3u".equals(mode)) {
                String rawUrl = j.optString("url", j.optString("host", ""));
                String url = normalizeHttpUrl(rawUrl, false);
                if (url.isEmpty() && sameMode) url = existing.optString("url", "");
                if (url.isEmpty()) throw new IllegalArgumentException("M3U URL required");
                src.put("url", url);
                if (name.isEmpty()) name = hostLabel(url);
            } else {
                String host = normalizeHttpUrl(j.optString("host", ""), true);
                String user = j.optString("user", "").trim();
                String pass = j.optString("pass", "");
                if (host.isEmpty() && sameMode) host = existing.optString("host", "");
                if (user.isEmpty() && sameMode) user = existing.optString("user", "");
                if (pass.isEmpty() && sameMode) pass = existing.optString("pass", "");
                if (host.isEmpty() || user.isEmpty() || pass.isEmpty()) {
                    throw new IllegalArgumentException("Xtream host, username and password required");
                }
                src.put("host", host);
                src.put("user", user);
                src.put("pass", pass);
                if (name.isEmpty()) name = hostLabel(host);
            }
            String epg = normalizeHttpUrl(j.optString("epgUrl", ""), false);
            if (!epg.isEmpty()) src.put("epgUrl", epg);
            else if (existing != null && existing.has("epgUrl")) src.put("epgUrl", existing.optString("epgUrl", ""));
            src.put("name", name.isEmpty() ? "Personal IPTV" : name);
            if (id.isEmpty()) {
                id = "p" + shaHex(mode + "|" + src.optString("host", "") + "|" + src.optString("url", "")
                        + "|" + src.optString("user", "")).substring(0, 14);
            }
            src.put("id", id);

            org.json.JSONArray next = new org.json.JSONArray();
            boolean replaced = false;
            for (int i = 0; i < stored.length(); i++) {
                org.json.JSONObject old = stored.optJSONObject(i);
                if (old == null) continue;
                if (id.equals(old.optString("id", ""))) {
                    next.put(src);
                    replaced = true;
                } else {
                    next.put(old);
                }
            }
            if (!replaced) next.put(src);
            savePersonalIptvStoredSources(next);
            clearPersonalIptvSourceCache(id);
            return new org.json.JSONObject()
                    .put("ok", true)
                    .put("sources", personalIptvRedactedArray())
                    .toString();
        } catch (Exception e) {
            return bridgeError(e);
        }
    }

    private String deletePersonalIptvSource(String id) {
        try {
            String wanted = id == null ? "" : id.trim();
            org.json.JSONArray stored = personalIptvStoredSources();
            org.json.JSONArray next = new org.json.JSONArray();
            for (int i = 0; i < stored.length(); i++) {
                org.json.JSONObject src = stored.optJSONObject(i);
                if (src == null || wanted.equals(src.optString("id", ""))) continue;
                next.put(src);
            }
            savePersonalIptvStoredSources(next);
            clearPersonalIptvSourceCache(wanted);
            return new org.json.JSONObject()
                    .put("ok", true)
                    .put("sources", personalIptvRedactedArray())
                    .toString();
        } catch (Exception e) {
            return bridgeError(e);
        }
    }

    private String bridgeError(Exception e) {
        try {
            return new org.json.JSONObject()
                    .put("ok", false)
                    .put("error", e == null || e.getMessage() == null ? "failed" : e.getMessage())
                    .toString();
        } catch (Exception ignored) {
            return "{\"ok\":false,\"error\":\"failed\"}";
        }
    }

    private void loadPersonalIptvChannels(String token) {
        final String callbackToken = token == null ? "" : token;
        new Thread(() -> {
            String result;
            try {
                org.json.JSONArray sources = personalIptvStoredSources();
                org.json.JSONArray channels = new org.json.JSONArray();
                org.json.JSONArray errors = new org.json.JSONArray();
                int[] idx = new int[]{-900000};
                for (int i = 0; i < sources.length() && channels.length() < PERSONAL_IPTV_MAX_CHANNELS; i++) {
                    org.json.JSONObject src = sources.optJSONObject(i);
                    if (src == null) continue;
                    try {
                        if ("m3u".equals(src.optString("mode", ""))) loadPersonalM3uSource(src, channels, idx);
                        else loadPersonalXtreamSource(src, channels, idx);
                    } catch (Exception e) {
                        errors.put(new org.json.JSONObject()
                                .put("sourceName", src.optString("name", "Personal IPTV"))
                                .put("error", e == null || e.getMessage() == null ? "source failed" : e.getMessage()));
                    }
                }
                result = new org.json.JSONObject()
                        .put("configured", sources.length() > 0)
                        .put("epg", personalIptvHasGuideSource(sources))
                        .put("channels", channels)
                        .put("sourceErrors", errors)
                        .put("sources", personalIptvRedactedArray())
                        .toString();
            } catch (Exception e) {
                try {
                    result = new org.json.JSONObject()
                            .put("configured", personalIptvStoredSources().length() > 0)
                            .put("channels", new org.json.JSONArray())
                            .put("sourceErrors", new org.json.JSONArray()
                                    .put(new org.json.JSONObject().put("sourceName", "This device").put("error", e.getMessage())))
                            .toString();
                } catch (Exception ignored) {
                    result = "{\"configured\":false,\"channels\":[],\"sourceErrors\":[]}";
                }
            }
            final String callbackResult = result;
            runOnUiThread(() -> {
                if (web == null) return;
                web.evaluateJavascript("window.__tvPersonalIptvLoaded && window.__tvPersonalIptvLoaded("
                        + org.json.JSONObject.quote(callbackToken) + ","
                        + org.json.JSONObject.quote(callbackResult) + ")", null);
            });
        }, "TriboonPersonalIptv").start();
    }

    private boolean personalIptvHasGuideSource(org.json.JSONArray sources) {
        for (int i = 0; i < sources.length(); i++) {
            org.json.JSONObject src = sources.optJSONObject(i);
            if (src == null) continue;
            if ("xtream".equals(src.optString("mode", "xtream"))) return true;
            if (!src.optString("epgUrl", "").trim().isEmpty()) return true;
        }
        return false;
    }

    private String personalSourceKey(org.json.JSONObject src) {
        if (src == null) return "";
        try {
            return shaHex(src.optString("mode", "xtream") + "|"
                    + src.optString("host", "") + "|"
                    + src.optString("url", "") + "|"
                    + src.optString("user", "") + "|"
                    + src.optString("epgUrl", ""));
        } catch (Exception ignored) {
            return "";
        }
    }

    private org.json.JSONObject personalCacheEntry(String prefKey, org.json.JSONObject src) {
        try {
            String id = src.optString("id", "");
            org.json.JSONObject sources = readPersonalCacheObject(prefKey).optJSONObject("sources");
            return sources == null ? null : sources.optJSONObject(id);
        } catch (Exception ignored) {
            return null;
        }
    }

    private void writePersonalSourceCacheEntry(String prefKey, org.json.JSONObject src, org.json.JSONObject entry) {
        try {
            String id = src.optString("id", "");
            if (id.isEmpty()) return;
            org.json.JSONObject root = readPersonalCacheObject(prefKey);
            org.json.JSONObject sources = root.optJSONObject("sources");
            if (sources == null) sources = new org.json.JSONObject();
            sources.put(id, entry);
            root.put("sources", sources);
            writePersonalCacheObject(prefKey, root);
        } catch (Exception ignored) {
        }
    }

    private void clearPersonalIptvSourceCache(String sourceId) {
        if (sourceId == null || sourceId.trim().isEmpty()) return;
        clearPersonalIptvSourceCacheIn(KEY_PERSONAL_IPTV_CHANNEL_CACHE, sourceId);
        clearPersonalIptvSourceCacheIn(KEY_PERSONAL_IPTV_GUIDE_CACHE, sourceId);
    }

    private void clearPersonalIptvSourceCacheIn(String prefKey, String sourceId) {
        try {
            org.json.JSONObject root = readPersonalCacheObject(prefKey);
            org.json.JSONObject sources = root.optJSONObject("sources");
            if (sources == null) return;
            sources.remove(sourceId);
            root.put("sources", sources);
            writePersonalCacheObject(prefKey, root);
        } catch (Exception ignored) {
        }
    }

    private org.json.JSONArray personalXtreamChannelCache(org.json.JSONObject src, boolean freshOnly) {
        org.json.JSONObject entry = personalCacheEntry(KEY_PERSONAL_IPTV_CHANNEL_CACHE, src);
        if (entry == null || !personalSourceKey(src).equals(entry.optString("key", ""))) return null;
        long at = entry.optLong("at", 0L);
        long maxAge = freshOnly ? PERSONAL_IPTV_CACHE_TTL_MS : PERSONAL_IPTV_STALE_TTL_MS;
        if (at <= 0L || System.currentTimeMillis() - at > maxAge) return null;
        org.json.JSONArray rows = entry.optJSONArray("channels");
        return rows == null || rows.length() == 0 ? null : rows;
    }

    private void putPersonalXtreamCachedChannels(org.json.JSONObject src, org.json.JSONArray rows) {
        try {
            writePersonalSourceCacheEntry(KEY_PERSONAL_IPTV_CHANNEL_CACHE, src, new org.json.JSONObject()
                    .put("key", personalSourceKey(src))
                    .put("at", System.currentTimeMillis())
                    .put("channels", rows == null ? new org.json.JSONArray() : rows));
        } catch (Exception ignored) {
        }
    }

    private void appendPersonalXtreamCachedChannels(org.json.JSONObject src, org.json.JSONArray cached,
                                                    org.json.JSONArray channels, int[] idx) throws Exception {
        for (int i = 0; i < cached.length() && channels.length() < PERSONAL_IPTV_MAX_CHANNELS; i++) {
            org.json.JSONObject row = cached.optJSONObject(i);
            if (row == null) continue;
            String streamId = row.optString("streamId", "");
            if (streamId.isEmpty()) continue;
            String base = normalizeHttpUrl(src.optString("host", ""), true);
            String user = src.optString("user", "");
            String pass = src.optString("pass", "");
            String ts = base + "/live/" + path(user) + "/" + path(pass) + "/" + path(streamId) + ".ts";
            String hls = base + "/live/" + path(user) + "/" + path(pass) + "/" + path(streamId) + ".m3u8";
            channels.put(personalChannel(src, idx[0]--, row.optString("name", "Live channel"),
                    row.optString("logo", ""), row.optString("group", "Other"),
                    ts, "video/mp2t", hls, "application/x-mpegURL",
                    streamId, row.optString("tvgId", "")));
        }
    }

    private org.json.JSONArray personalM3uChannelCache(org.json.JSONObject src, boolean freshOnly) {
        org.json.JSONObject entry = personalCacheEntry(KEY_PERSONAL_IPTV_CHANNEL_CACHE, src);
        if (entry == null || !personalSourceKey(src).equals(entry.optString("key", ""))) return null;
        long at = entry.optLong("at", 0L);
        long maxAge = freshOnly ? PERSONAL_IPTV_CACHE_TTL_MS : PERSONAL_IPTV_STALE_TTL_MS;
        if (at <= 0L || System.currentTimeMillis() - at > maxAge) return null;
        org.json.JSONArray rows = entry.optJSONArray("channels");
        return rows == null || rows.length() == 0 ? null : rows;
    }

    private void putPersonalM3uCachedChannels(org.json.JSONObject src, org.json.JSONArray rows) {
        try {
            writePersonalSourceCacheEntry(KEY_PERSONAL_IPTV_CHANNEL_CACHE, src, new org.json.JSONObject()
                    .put("key", personalSourceKey(src))
                    .put("at", System.currentTimeMillis())
                    .put("channels", rows == null ? new org.json.JSONArray() : rows));
        } catch (Exception ignored) {
        }
    }

    private void appendPersonalM3uCachedChannels(org.json.JSONObject src, org.json.JSONArray cached,
                                                 org.json.JSONArray channels, int[] idx) throws Exception {
        for (int i = 0; i < cached.length() && channels.length() < PERSONAL_IPTV_MAX_CHANNELS; i++) {
            org.json.JSONObject row = cached.optJSONObject(i);
            if (row == null) continue;
            String stream = row.optString("stream", "");
            if (stream.isEmpty()) continue;
            channels.put(personalChannel(src, idx[0]--, row.optString("name", "Live channel"),
                    row.optString("logo", ""), row.optString("group", "Other"),
                    stream, row.optString("mime", liveMime(stream)), "", "",
                    "", row.optString("tvgId", "")));
        }
    }

    private void loadPersonalXtreamSource(org.json.JSONObject src, org.json.JSONArray channels, int[] idx) throws Exception {
        org.json.JSONArray fresh = personalXtreamChannelCache(src, true);
        if (fresh != null) {
            appendPersonalXtreamCachedChannels(src, fresh, channels, idx);
            return;
        }
        org.json.JSONArray stale = personalXtreamChannelCache(src, false);
        String base = normalizeHttpUrl(src.optString("host", ""), true);
        String user = src.optString("user", "");
        String pass = src.optString("pass", "");
        if (base.isEmpty() || user.isEmpty() || pass.isEmpty()) throw new IOException("Xtream credentials missing");
        org.json.JSONArray streams;
        try {
            String streamsUrl = base + "/player_api.php?username=" + q(user) + "&password=" + q(pass) + "&action=get_live_streams";
            streams = new org.json.JSONArray(personalHttpGetText(streamsUrl, PERSONAL_IPTV_MAX_BYTES));
        } catch (Exception e) {
            if (stale != null) {
                appendPersonalXtreamCachedChannels(src, stale, channels, idx);
                return;
            }
            throw e;
        }
        org.json.JSONObject cats = new org.json.JSONObject();
        try {
            String catUrl = base + "/player_api.php?username=" + q(user) + "&password=" + q(pass) + "&action=get_live_categories";
            org.json.JSONArray catRows = new org.json.JSONArray(personalHttpGetText(catUrl, 2 * 1024 * 1024));
            for (int i = 0; i < catRows.length(); i++) {
                org.json.JSONObject c = catRows.optJSONObject(i);
                if (c != null) cats.put(String.valueOf(c.opt("category_id")), c.optString("category_name", ""));
            }
        } catch (Exception ignored) {
        }
        org.json.JSONArray cacheRows = new org.json.JSONArray();
        for (int i = 0; i < streams.length() && channels.length() < PERSONAL_IPTV_MAX_CHANNELS; i++) {
            org.json.JSONObject row = streams.optJSONObject(i);
            if (row == null) continue;
            String streamId = String.valueOf(row.opt("stream_id"));
            if (streamId == null || streamId.equals("null") || streamId.trim().isEmpty()) continue;
            String name = cleanText(row.optString("name", "Live channel"));
            String group = cleanText(cats.optString(String.valueOf(row.opt("category_id")), row.optString("category_name", "Other")));
            String logo = row.optString("stream_icon", "");
            String tvgId = row.optString("epg_channel_id", "");
            String ts = base + "/live/" + path(user) + "/" + path(pass) + "/" + path(streamId) + ".ts";
            String hls = base + "/live/" + path(user) + "/" + path(pass) + "/" + path(streamId) + ".m3u8";
            channels.put(personalChannel(src, idx[0]--, name, logo, group, ts, "video/mp2t", hls, "application/x-mpegURL", streamId, tvgId));
            cacheRows.put(new org.json.JSONObject()
                    .put("streamId", streamId)
                    .put("name", name)
                    .put("logo", logo)
                    .put("group", group)
                    .put("tvgId", tvgId));
        }
        putPersonalXtreamCachedChannels(src, cacheRows);
    }

    private void loadPersonalM3uSource(org.json.JSONObject src, org.json.JSONArray channels, int[] idx) throws Exception {
        org.json.JSONArray fresh = personalM3uChannelCache(src, true);
        if (fresh != null) {
            appendPersonalM3uCachedChannels(src, fresh, channels, idx);
            return;
        }
        org.json.JSONArray stale = personalM3uChannelCache(src, false);
        String url = normalizeHttpUrl(src.optString("url", ""), false);
        if (url.isEmpty()) throw new IOException("M3U URL missing");
        HttpURLConnection conn = openPersonalHttpFollowingRedirects(url);
        try {
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new IOException("m3u playlist HTTP " + code);
            org.json.JSONArray cacheRows = new org.json.JSONArray();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String ext = "";
                String line;
                long bytes = 0L;
                URL baseUrl = new URL(url);
                while ((line = reader.readLine()) != null && channels.length() < PERSONAL_IPTV_MAX_CHANNELS) {
                    bytes += line.length() + 1L;
                    if (bytes > 128L * 1024L * 1024L) break;
                    line = line.trim();
                    if (line.isEmpty()) continue;
                    if (line.startsWith("#EXTINF")) {
                        ext = line;
                        continue;
                    }
                    if (line.startsWith("#")) continue;
                    if (ext.isEmpty()) continue;
                    String stream = line;
                    if (!stream.startsWith("http://") && !stream.startsWith("https://")) {
                        stream = new URL(baseUrl, stream).toString();
                    }
                    String name = cleanText(m3uName(ext));
                    String logo = m3uAttr(ext, "tvg-logo");
                    String group = cleanText(m3uAttr(ext, "group-title"));
                    if (name.isEmpty()) name = "Live channel";
                    if (group.isEmpty()) group = "Other";
                    String tvgId = m3uAttr(ext, "tvg-id");
                    channels.put(personalChannel(src, idx[0]--, name, logo, group, stream, liveMime(stream), "", "", "", tvgId));
                    cacheRows.put(new org.json.JSONObject()
                            .put("stream", stream)
                            .put("mime", liveMime(stream))
                            .put("name", name)
                            .put("logo", logo)
                            .put("group", group)
                            .put("tvgId", tvgId));
                    ext = "";
                }
            }
            putPersonalM3uCachedChannels(src, cacheRows);
        } catch (Exception e) {
            if (stale != null) {
                appendPersonalM3uCachedChannels(src, stale, channels, idx);
                return;
            }
            throw e;
        } finally {
            conn.disconnect();
        }
    }

    private void loadPersonalIptvGuide(String token, String json) {
        final String callbackToken = token == null ? "" : token;
        new Thread(() -> {
            String result;
            try {
                result = personalIptvGuideResult(json).toString();
            } catch (Exception e) {
                try {
                    result = new org.json.JSONObject()
                            .put("epg", false)
                            .put("channels", new org.json.JSONArray())
                            .put("error", e == null || e.getMessage() == null ? "guide failed" : e.getMessage())
                            .toString();
                } catch (Exception ignored) {
                    result = "{\"epg\":false,\"channels\":[]}";
                }
            }
            final String callbackResult = result;
            runOnUiThread(() -> {
                if (web == null) return;
                web.evaluateJavascript("window.__tvPersonalIptvGuideLoaded && window.__tvPersonalIptvGuideLoaded("
                        + org.json.JSONObject.quote(callbackToken) + ","
                        + org.json.JSONObject.quote(callbackResult) + ")", null);
            });
        }, "TriboonPersonalIptvGuide").start();
    }

    private org.json.JSONObject personalIptvGuideResult(String json) throws Exception {
        org.json.JSONArray requested = new org.json.JSONObject(json == null ? "{}" : json).optJSONArray("channels");
        org.json.JSONArray out = new org.json.JSONArray();
        if (requested == null || requested.length() == 0) {
            return new org.json.JSONObject().put("epg", false).put("channels", out);
        }
        java.util.HashMap<String, String> xmltvBatchCache = new java.util.HashMap<>();
        for (int i = 0; i < requested.length() && i < PERSONAL_IPTV_GUIDE_MAX_CHANNELS; i++) {
            org.json.JSONObject ch = requested.optJSONObject(i);
            if (ch == null) continue;
            org.json.JSONObject src = personalSourceById(ch.optString("sourceId", ""));
            org.json.JSONArray programmes = new org.json.JSONArray();
            if (src != null) {
                if ("xtream".equals(src.optString("mode", "xtream")) && !ch.optString("xtreamId", "").isEmpty()) {
                    programmes = personalXtreamGuide(src, ch.optString("xtreamId", ""), ch);
                }
                if (programmes.length() == 0 && !src.optString("epgUrl", "").isEmpty()) {
                    programmes = personalXmltvGuide(src, ch, xmltvBatchCache);
                }
            }
            if (programmes.length() == 0) programmes.put(personalFallbackProgramme(ch));
            out.put(new org.json.JSONObject()
                    .put("idx", ch.optInt("idx", -1))
                    .put("programmes", programmes));
        }
        return new org.json.JSONObject().put("epg", true).put("channels", out);
    }

    private org.json.JSONObject personalSourceById(String id) {
        org.json.JSONArray sources = personalIptvStoredSources();
        String wanted = id == null ? "" : id;
        for (int i = 0; i < sources.length(); i++) {
            org.json.JSONObject src = sources.optJSONObject(i);
            if (src != null && wanted.equals(src.optString("id", ""))) return src;
        }
        return null;
    }

    private org.json.JSONArray personalXtreamGuide(org.json.JSONObject src, String streamId, org.json.JSONObject ch) {
        org.json.JSONObject sourceEntry = personalCacheEntry(KEY_PERSONAL_IPTV_GUIDE_CACHE, src);
        String key = personalSourceKey(src);
        org.json.JSONObject streams = null;
        org.json.JSONObject hit = null;
        if (sourceEntry != null && key.equals(sourceEntry.optString("key", ""))) {
            streams = sourceEntry.optJSONObject("streams");
            hit = streams == null ? null : streams.optJSONObject(streamId);
            if (hit != null && System.currentTimeMillis() - hit.optLong("at", 0L) < PERSONAL_IPTV_CACHE_TTL_MS) {
                org.json.JSONArray list = hit.optJSONArray("list");
                if (list != null && list.length() > 0) return list;
            }
        }
        org.json.JSONArray stale = hit != null && System.currentTimeMillis() - hit.optLong("at", 0L) < PERSONAL_IPTV_STALE_TTL_MS
                ? hit.optJSONArray("list")
                : null;
        try {
            org.json.JSONArray list = fetchPersonalXtreamGuide(src, streamId);
            if (list.length() == 0) list.put(personalFallbackProgramme(ch));
            if (streams == null) streams = new org.json.JSONObject();
            streams.put(streamId, new org.json.JSONObject()
                    .put("at", System.currentTimeMillis())
                    .put("list", list));
            writePersonalSourceCacheEntry(KEY_PERSONAL_IPTV_GUIDE_CACHE, src, new org.json.JSONObject()
                    .put("key", key)
                    .put("at", System.currentTimeMillis())
                    .put("streams", streams));
            return list;
        } catch (Exception e) {
            if (stale != null && stale.length() > 0) return stale;
            org.json.JSONArray fallback = new org.json.JSONArray();
            try { fallback.put(personalFallbackProgramme(ch)); } catch (Exception ignored) {}
            return fallback;
        }
    }

    private org.json.JSONArray fetchPersonalXtreamGuide(org.json.JSONObject src, String streamId) throws Exception {
        org.json.JSONArray list = fetchPersonalXtreamGuideAction(src, streamId, "get_short_epg");
        if (list.length() > 0) return list;
        try {
            return fetchPersonalXtreamGuideAction(src, streamId, "get_simple_data_table");
        } catch (Exception ignored) {
            return list;
        }
    }

    private org.json.JSONArray fetchPersonalXtreamGuideAction(org.json.JSONObject src, String streamId, String action) throws Exception {
        String base = normalizeHttpUrl(src.optString("host", ""), true);
        String user = src.optString("user", "");
        String pass = src.optString("pass", "");
        String url = base + "/player_api.php?username=" + q(user) + "&password=" + q(pass)
                + "&action=" + q(action) + "&stream_id=" + q(streamId) + "&limit=24";
        String text = personalHttpGetText(url, 2 * 1024 * 1024);
        Object parsed = new org.json.JSONTokener(text.isEmpty() ? "[]" : text).nextValue();
        org.json.JSONArray raw;
        if (parsed instanceof org.json.JSONArray) raw = (org.json.JSONArray) parsed;
        else if (parsed instanceof org.json.JSONObject) {
            org.json.JSONObject obj = (org.json.JSONObject) parsed;
            raw = obj.optJSONArray("epg_listings");
            if (raw == null) raw = obj.optJSONArray("epg");
            if (raw == null) raw = obj.optJSONArray("listings");
            if (raw == null) raw = obj.optJSONArray("programmes");
            if (raw == null) raw = obj.optJSONArray("programs");
            if (raw == null) raw = new org.json.JSONArray();
        } else raw = new org.json.JSONArray();
        org.json.JSONArray out = new org.json.JSONArray();
        for (int i = 0; i < raw.length() && out.length() < 24; i++) {
            org.json.JSONObject programme = personalXtreamProgramme(raw.optJSONObject(i));
            if (programme != null) out.put(programme);
        }
        return sortProgrammes(out);
    }

    private org.json.JSONObject personalXtreamProgramme(org.json.JSONObject e) {
        if (e == null) return null;
        String title = maybeBase64(e.optString("title", e.optString("name", "")));
        long start = parsePersonalGuideTime(firstJsonValue(e, "start_timestamp", "start", "start_time"));
        long stop = parsePersonalGuideTime(firstJsonValue(e, "stop_timestamp", "end_timestamp", "stop", "end", "end_time"));
        if (title.trim().isEmpty() || start <= 0L || stop <= start) return null;
        try {
            return new org.json.JSONObject().put("title", title.trim()).put("start", start).put("stop", stop);
        } catch (Exception ignored) {
            return null;
        }
    }

    private Object firstJsonValue(org.json.JSONObject obj, String... keys) {
        for (String key : keys) if (obj.has(key)) return obj.opt(key);
        return null;
    }

    private String maybeBase64(String raw) {
        String compact = raw == null ? "" : raw.trim().replaceAll("\\s+", "");
        if (compact.isEmpty() || compact.length() % 4 == 1 || !compact.matches("^[A-Za-z0-9+/]+={0,2}$")) {
            return raw == null ? "" : raw;
        }
        try {
            String decoded = new String(Base64.decode(compact, Base64.DEFAULT), StandardCharsets.UTF_8)
                    .replace("\u0000", "").trim();
            if (decoded.isEmpty() || decoded.indexOf('\uFFFD') >= 0 || !decoded.matches("(?s).*[A-Za-z0-9].*")) {
                return raw;
            }
            int printable = 0;
            for (int i = 0; i < decoded.length(); i++) {
                char c = decoded.charAt(i);
                if (c >= 0x20 && c <= 0x7e) printable++;
            }
            return printable >= Math.max(1, decoded.length() * 85 / 100) ? decoded : raw;
        } catch (Exception ignored) {
            return raw == null ? "" : raw;
        }
    }

    private long parsePersonalGuideTime(Object v) {
        if (v == null || org.json.JSONObject.NULL.equals(v)) return 0L;
        String s = String.valueOf(v).trim();
        if (s.isEmpty()) return 0L;
        if (s.matches("^\\d+$")) {
            try {
                long n = Long.parseLong(s);
                return n > 100000000000L ? n : n * 1000L;
            } catch (Exception ignored) {
                return 0L;
            }
        }
        String[] patterns = new String[]{"yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd'T'HH:mm"};
        for (String pattern : patterns) {
            try {
                SimpleDateFormat fmt = new SimpleDateFormat(pattern, Locale.US);
                Date d = fmt.parse(s.replace("Z", ""));
                if (d != null) return d.getTime();
            } catch (Exception ignored) {
            }
        }
        return 0L;
    }

    private org.json.JSONArray personalXmltvGuide(org.json.JSONObject src, org.json.JSONObject ch,
                                                  java.util.HashMap<String, String> xmltvBatchCache) {
        org.json.JSONObject cacheSrc = personalCacheSource(src, "xmltv");
        String guideKey = ch.optString("tvgId", "");
        if (guideKey.isEmpty()) guideKey = "name:" + normGuideName(ch.optString("name", ""));
        if (guideKey.isEmpty()) return new org.json.JSONArray();
        org.json.JSONObject sourceEntry = personalCacheEntry(KEY_PERSONAL_IPTV_GUIDE_CACHE, cacheSrc);
        String sourceKey = personalSourceKey(src) + "|xmltv";
        org.json.JSONObject streams = null;
        org.json.JSONObject hit = null;
        if (sourceEntry != null && sourceKey.equals(sourceEntry.optString("key", ""))) {
            streams = sourceEntry.optJSONObject("streams");
            hit = streams == null ? null : streams.optJSONObject(guideKey);
            if (hit != null && System.currentTimeMillis() - hit.optLong("at", 0L) < PERSONAL_IPTV_CACHE_TTL_MS) {
                org.json.JSONArray list = hit.optJSONArray("list");
                if (list != null && list.length() > 0) return list;
            }
        }
        org.json.JSONArray stale = hit != null && System.currentTimeMillis() - hit.optLong("at", 0L) < PERSONAL_IPTV_STALE_TTL_MS
                ? hit.optJSONArray("list")
                : null;
        try {
            org.json.JSONArray list = fetchPersonalXmltvGuide(src, ch, xmltvBatchCache);
            if (list.length() == 0) return stale == null ? new org.json.JSONArray() : stale;
            if (streams == null) streams = new org.json.JSONObject();
            streams.put(guideKey, new org.json.JSONObject()
                    .put("at", System.currentTimeMillis())
                    .put("list", list));
            writePersonalSourceCacheEntry(KEY_PERSONAL_IPTV_GUIDE_CACHE, cacheSrc, new org.json.JSONObject()
                    .put("key", sourceKey)
                    .put("at", System.currentTimeMillis())
                    .put("streams", streams));
            return list;
        } catch (Exception ignored) {
            return stale == null ? new org.json.JSONArray() : stale;
        }
    }

    private org.json.JSONObject personalCacheSource(org.json.JSONObject src, String suffix) {
        try {
            org.json.JSONObject copy = new org.json.JSONObject(src == null ? "{}" : src.toString());
            copy.put("id", copy.optString("id", "personal") + ":" + suffix);
            return copy;
        } catch (Exception ignored) {
            return src;
        }
    }

    private org.json.JSONArray fetchPersonalXmltvGuide(org.json.JSONObject src, org.json.JSONObject ch,
                                                       java.util.HashMap<String, String> xmltvBatchCache) throws Exception {
        String epgUrl = src.optString("epgUrl", "");
        String xml = xmltvBatchCache == null ? null : xmltvBatchCache.get(epgUrl);
        if (xml == null) {
            int maxGuideBytes = nativeConservativePlaybackDevice() ? 32 * 1024 * 1024 : 96 * 1024 * 1024;
            xml = personalHttpGetText(epgUrl, maxGuideBytes);
            if (xmltvBatchCache != null) xmltvBatchCache.put(epgUrl, xml);
        }
        String wantedId = ch.optString("tvgId", "");
        String wantedName = normGuideName(ch.optString("name", ""));
        if (wantedId.isEmpty() && !wantedName.isEmpty()) {
            java.util.regex.Matcher cm = java.util.regex.Pattern.compile("<channel[^>]*id=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</channel>").matcher(xml);
            while (cm.find()) {
                java.util.regex.Matcher dm = java.util.regex.Pattern.compile("<display-name[^>]*>([\\s\\S]*?)</display-name>").matcher(cm.group(2));
                while (dm.find()) {
                    if (wantedName.equals(normGuideName(xmlText(dm.group(1))))) {
                        wantedId = cm.group(1);
                        break;
                    }
                }
                if (!wantedId.isEmpty()) break;
            }
        }
        if (wantedId.isEmpty()) return new org.json.JSONArray();
        long from = System.currentTimeMillis() - 90L * 60000L;
        long to = System.currentTimeMillis() + 4L * 3600000L;
        org.json.JSONArray out = new org.json.JSONArray();
        java.util.regex.Matcher pm = java.util.regex.Pattern.compile("<programme[^>]*start=\"([^\"]+)\"[^>]*stop=\"([^\"]+)\"[^>]*channel=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</programme>").matcher(xml);
        while (pm.find() && out.length() < 24) {
            if (!wantedId.equals(pm.group(3))) continue;
            long start = parseXmltvDate(pm.group(1));
            long stop = parseXmltvDate(pm.group(2));
            if (stop < from || start > to) continue;
            java.util.regex.Matcher tm = java.util.regex.Pattern.compile("<title[^>]*>([\\s\\S]*?)</title>").matcher(pm.group(4));
            if (!tm.find()) continue;
            String title = xmlText(tm.group(1)).trim();
            if (title.isEmpty() || start <= 0L || stop <= start) continue;
            out.put(new org.json.JSONObject().put("title", title).put("start", start).put("stop", stop));
        }
        return sortProgrammes(out);
    }

    private long parseXmltvDate(String s) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(?:\\s*([+-]\\d{4}))?").matcher(s == null ? "" : s);
        if (!m.find()) return 0L;
        long utc = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).getTimeInMillis();
        try {
            java.util.Calendar cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"));
            cal.set(java.util.Calendar.YEAR, Integer.parseInt(m.group(1)));
            cal.set(java.util.Calendar.MONTH, Integer.parseInt(m.group(2)) - 1);
            cal.set(java.util.Calendar.DAY_OF_MONTH, Integer.parseInt(m.group(3)));
            cal.set(java.util.Calendar.HOUR_OF_DAY, Integer.parseInt(m.group(4)));
            cal.set(java.util.Calendar.MINUTE, Integer.parseInt(m.group(5)));
            cal.set(java.util.Calendar.SECOND, Integer.parseInt(m.group(6)));
            cal.set(java.util.Calendar.MILLISECOND, 0);
            utc = cal.getTimeInMillis();
            if (m.group(7) != null) {
                String off = m.group(7);
                int sign = off.charAt(0) == '-' ? -1 : 1;
                int hours = Integer.parseInt(off.substring(1, 3));
                int mins = Integer.parseInt(off.substring(3, 5));
                utc -= sign * (hours * 60L + mins) * 60000L;
            }
        } catch (Exception ignored) {
            return 0L;
        }
        return utc;
    }

    private org.json.JSONObject personalFallbackProgramme(org.json.JSONObject ch) throws Exception {
        long now = System.currentTimeMillis();
        long from = now - (now % 1800000L) - 1800000L;
        long to = now + 2L * 3600000L;
        String title = cleanText(ch.optString("name", "Live channel"))
                .replaceAll("^\\w{2,3}\\s*[:|-]\\s*", "")
                .replaceAll("\\[[^\\]]*\\]", "")
                .trim();
        if (title.isEmpty()) title = "Live channel";
        return new org.json.JSONObject().put("title", title).put("start", from).put("stop", to).put("synthetic", true);
    }

    private org.json.JSONArray sortProgrammes(org.json.JSONArray input) throws Exception {
        java.util.ArrayList<org.json.JSONObject> rows = new java.util.ArrayList<>();
        for (int i = 0; i < input.length(); i++) {
            org.json.JSONObject row = input.optJSONObject(i);
            if (row != null) rows.add(row);
        }
        rows.sort((a, b) -> Long.compare(a.optLong("start", 0L), b.optLong("start", 0L)));
        org.json.JSONArray out = new org.json.JSONArray();
        for (org.json.JSONObject row : rows) out.put(row);
        return out;
    }

    private String normGuideName(String s) {
        return cleanText(s).toLowerCase(Locale.US)
                .replaceAll("^[a-z]{2,3}\\s*[:|-]\\s*", "")
                .replaceAll("\\[[^\\]]*\\]|\\([^)]*\\)", " ")
                .replaceAll("\\b(uhd|fhd|hd|sd|4k|8k|1080p?|720p?|h26[45]|hevc|raw|vip|plus|backup)\\b", " ")
                .replaceAll("[^a-z0-9]", "");
    }

    private String xmlText(String s) {
        return (s == null ? "" : s)
                .replace("<![CDATA[", "")
                .replace("]]>", "")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'");
    }

    private org.json.JSONObject personalChannel(org.json.JSONObject src, int idx, String name, String logo,
                                                String group, String url, String mime,
                                                String fallbackUrl, String fallbackMime,
                                                String xtreamId, String tvgId) throws Exception {
        String safeUrl = validatedPersonalIptvUrl(url);
        String safeFallbackUrl = fallbackUrl == null || fallbackUrl.trim().isEmpty()
                ? ""
                : validatedPersonalIptvUrl(fallbackUrl);
        String sourceId = src.optString("id", "personal");
        return new org.json.JSONObject()
                .put("id", "device:" + sourceId + ":" + shaHex(safeUrl).substring(0, 14))
                .put("idx", idx)
                .put("personal", true)
                .put("sourceId", sourceId)
                .put("sourceName", src.optString("name", "This device"))
                .put("xtreamId", xtreamId == null ? "" : xtreamId)
                .put("tvgId", tvgId == null ? "" : tvgId)
                .put("name", name == null || name.trim().isEmpty() ? "Live channel" : name.trim())
                .put("logo", logo == null ? "" : logo.trim())
                .put("group", group == null || group.trim().isEmpty() ? "Other" : group.trim())
                .put("streamUrl", safeUrl)
                .put("nativeUrl", safeUrl)
                .put("nativeMime", mime == null ? "" : mime)
                .put("nativeFallbackUrl", safeFallbackUrl)
                .put("nativeFallbackMime", fallbackMime == null ? "" : fallbackMime);
    }

    private HttpURLConnection openPersonalHttp(String url) throws IOException {
        ValidatedNativeUrl safe = validateAndPinPersonalIptvUrl(url);
        HttpURLConnection conn = (HttpURLConnection) new URL(safe.connectUrl).openConnection();
        conn.setInstanceFollowRedirects(false);
        conn.setConnectTimeout(PERSONAL_IPTV_CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(PERSONAL_IPTV_READ_TIMEOUT_MS);
        conn.setRequestProperty("User-Agent", "TriboonTV/" + BuildConfig.VERSION_NAME);
        conn.setRequestProperty("Accept", "*/*");
        conn.setRequestProperty("Connection", "close");
        if (hostHeaderSafe(safe.hostHeader)) conn.setRequestProperty("Host", safe.hostHeader);
        return conn;
    }

    private HttpURLConnection openPersonalHttpFollowingRedirects(String url) throws IOException {
        String current = validatedPersonalIptvUrl(url);
        for (int hop = 0; hop < 5; hop++) {
            HttpURLConnection conn = openPersonalHttp(current);
            int code = conn.getResponseCode();
            if (code < 300 || code >= 400) return conn;
            String location = conn.getHeaderField("Location");
            conn.disconnect();
            if (location == null || location.trim().isEmpty()) throw new IOException("redirect without location");
            current = validatedPersonalIptvUrl(new URL(new URL(current), location).toString());
        }
        throw new IOException("too many redirects");
    }

    private String personalHttpGetText(String url, int maxBytes) throws Exception {
        HttpURLConnection conn = openPersonalHttpFollowingRedirects(url);
        try {
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new IOException("HTTP " + code);
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            int total = 0;
            while ((n = in.read(buf)) >= 0) {
                total += n;
                if (total > maxBytes) throw new IOException("provider response too large");
                out.write(buf, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            conn.disconnect();
        }
    }

    private String normalizeHttpUrl(String input, boolean stripPath) {
        String s = input == null ? "" : input.trim();
        if (s.isEmpty()) return "";
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        if (stripPath) {
            try {
                Uri u = Uri.parse(s);
                if (u == null || u.getHost() == null || u.getHost().isEmpty()) return "";
                String scheme = u.getScheme() == null ? "http" : u.getScheme();
                String out = scheme + "://" + u.getHost();
                if (u.getPort() > 0) out += ":" + u.getPort();
                return out;
            } catch (Exception ignored) {
            }
        }
        return s;
    }

    private String hostLabel(String input) {
        try {
            Uri u = Uri.parse(input == null ? "" : input);
            String host = u == null ? "" : u.getHost();
            return host == null || host.isEmpty() ? cleanText(input) : host;
        } catch (Exception ignored) {
            return cleanText(input);
        }
    }

    private String q(String s) throws Exception {
        return URLEncoder.encode(s == null ? "" : s, StandardCharsets.UTF_8.name());
    }

    private String path(String s) throws Exception {
        return q(s).replace("+", "%20");
    }

    private String liveMime(String url) {
        String u = url == null ? "" : url.toLowerCase(Locale.US);
        if (u.contains(".m3u8")) return "application/x-mpegURL";
        if (u.contains(".ts")) return "video/mp2t";
        if (u.contains(".mp4")) return "video/mp4";
        return "";
    }

    private String cleanText(String s) {
        return s == null ? "" : s.replace('\n', ' ').replace('\r', ' ').trim();
    }

    private String m3uAttr(String line, String attr) {
        String needle = attr + "=\"";
        int start = line == null ? -1 : line.indexOf(needle);
        if (start < 0) return "";
        start += needle.length();
        int end = line.indexOf('"', start);
        return end > start ? line.substring(start, end).trim() : "";
    }

    private String m3uName(String line) {
        String byName = m3uAttr(line, "tvg-name");
        if (!byName.isEmpty()) return byName;
        int comma = line == null ? -1 : line.lastIndexOf(',');
        return comma >= 0 && comma + 1 < line.length() ? line.substring(comma + 1).trim() : "";
    }

    private String shaHex(String input) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] hash = md.digest((input == null ? "" : input).getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder(hash.length * 2);
        for (byte b : hash) sb.append(String.format(Locale.US, "%02x", b & 0xff));
        return sb.toString();
    }

    private void recoverWebRenderer(WebView crashedWeb, boolean didCrash, int priorityAtExit) {
        boolean setupVisible = setup != null && setup.getVisibility() == View.VISIBLE;
        boolean nativeVisible = nativePlayerOpen();
        String url = crashedWeb != null ? crashedWeb.getUrl() : null;
        if (url == null || url.isEmpty() || "about:blank".equals(url)) {
            url = prefs().getString(KEY_SERVER, "");
        }

        long now = SystemClock.uptimeMillis();
        if (now - lastWebRendererGoneAt > WEB_RENDERER_CRASH_WINDOW_MS) {
            webRendererGoneCount = 0;
        }
        lastWebRendererGoneAt = now;
        webRendererGoneCount++;
        boolean tooManyCrashes = webRendererGoneCount > WEB_RENDERER_CRASH_LIMIT;

        Log.e(TAG, "WebView renderer gone"
                + " didCrash=" + didCrash
                + " priorityAtExit=" + priorityAtExit
                + " count=" + webRendererGoneCount
                + " url=" + redactedWebUrl(url));

        if (fullscreenVideo != null) {
            try { root.removeView(fullscreenVideo); } catch (Exception ignored) {}
            fullscreenVideo = null;
        }
        trimAndroidMemoryCaches(true);
        disposeWebView(crashedWeb, true);
        resetWebPageState();
        if (!ensureWebViewReady()) {
            showSetup(webViewUnavailableMessage());
            return;
        }

        if (tooManyCrashes) {
            showSetup("The TV page crashed repeatedly. Reconnect to your server, or restart Triboon if it keeps happening.");
            return;
        }

        if (setupVisible || url == null || url.isEmpty()) {
            showSetup("The TV page crashed and was restarted.");
            return;
        }

        setup.setVisibility(View.GONE);
        web.loadUrl(url);
        if (nativeVisible) {
            if (nativeGuideMode) {
                enterNativeFullscreenMode();
            } else {
                web.setVisibility(View.GONE);
                nativePlayerLayer.bringToFront();
                nativePlayerLayer.requestFocus();
            }
        } else {
            web.setVisibility(View.VISIBLE);
            scheduleTvFocusRecovery("renderer");
        }
    }

    private void disposeWebView(WebView target, boolean rendererGone) {
        if (target == null) return;
        try {
            if (root != null) root.removeView(target);
        } catch (Exception ignored) {}
        try {
            target.setWebChromeClient(null);
            target.setWebViewClient(null);
            if (!rendererGone) {
                target.stopLoading();
                target.loadUrl("about:blank");
                target.removeAllViews();
            }
            target.destroy();
        } catch (Exception ignored) {}
        if (target == web) web = null;
    }

    private String redactedWebUrl(String url) {
        if (url == null || url.isEmpty()) return "";
        try {
            Uri u = Uri.parse(url);
            if (u == null || u.getHost() == null) return "";
            StringBuilder out = new StringBuilder();
            out.append(u.getScheme() == null ? "http" : u.getScheme())
                    .append("://")
                    .append(u.getHost());
            if (u.getPort() >= 0) out.append(":").append(u.getPort());
            if (u.getPath() != null) out.append(u.getPath());
            if (u.getQuery() != null) out.append("?[redacted]");
            if (u.getFragment() != null) out.append("#").append(u.getFragment());
            return out.toString();
        } catch (Exception ignored) {
            return "";
        }
    }

    private String buildNativePlaybackCaps() {
        if (nativePlaybackCapsCache != null) return nativePlaybackCapsCache;
        try {
            org.json.JSONObject j = new org.json.JSONObject();
            boolean conservative = nativeConservativePlaybackDevice();
            org.json.JSONObject sink = nativeAudioSinkCaps(conservative);
            boolean sinkAc3 = sink.optBoolean("ac3");
            boolean sinkEac3 = sink.optBoolean("eac3");
            boolean sinkEac3Joc = sink.optBoolean("eac3Joc");
            boolean sinkDts = sink.optBoolean("dts");
            boolean sinkDtsHd = sink.optBoolean("dtsHd");
            boolean sinkTrueHd = sink.optBoolean("truehd");
            boolean passthrough = sink.optBoolean("passthrough");
            j.put("native", true);
            j.put("sdk", Build.VERSION.SDK_INT);
            j.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
            j.put("brand", Build.BRAND == null ? "" : Build.BRAND);
            j.put("model", Build.MODEL == null ? "" : Build.MODEL);
            j.put("device", Build.DEVICE == null ? "" : Build.DEVICE);
            j.put("ramMb", nativeTotalRamMb());
            j.put("deviceClass", conservative ? "budget-android-tv" : "android-tv");
            j.put("lowPower", conservative);
            j.put("mkv", true); // ExoPlayer's Matroska extractor owns container support.
            j.put("mp4", true);
            j.put("h264", nativeDecoderAvailable("video/avc"));
            j.put("hevc", nativeDecoderAvailable("video/hevc"));
            j.put("dovi", nativeDecoderAvailable("video/dolby-vision"));
            j.put("av1", nativeHardwareDecoderAvailable("video/av01")); // HW-only: software AV1 can't do 4K on budget boxes
            j.put("vp9", nativeDecoderAvailable("video/x-vnd.on2.vp9"));
            j.put("mpeg2", nativeDecoderAvailable("video/mpeg2"));
            j.put("aac", nativeDecoderAvailable("audio/mp4a-latm"));
            j.put("ac3", nativeDecoderAvailable("audio/ac3") || sinkAc3);
            j.put("eac3", nativeDecoderAvailable("audio/eac3") || nativeDecoderAvailable("audio/eac3-joc") || sinkEac3 || sinkEac3Joc);
            j.put("eac3Joc", !conservative && (nativeDecoderAvailable("audio/eac3-joc") || sinkEac3Joc));
            // Budget TV boxes often expose DTS decoders that still fail in fMP4/remux paths or
            // burn CPU. Force AAC audio remux there; Shield-class devices can still copy DTS.
            j.put("dts", !conservative && (nativeDecoderAvailable("audio/vnd.dts") || nativeDecoderAvailable("audio/vnd.dts.hd") || sinkDts || sinkDtsHd));
            j.put("dtsHd", !conservative && sinkDtsHd);
            j.put("truehd", !conservative && sinkTrueHd);
            j.put("passthrough", !conservative && passthrough);
            j.put("audioOutput", sink.optString("output", ""));
            j.put("source", "exo-mediacodec+audio-output");
            nativePlaybackCapsCache = j.toString();
            return nativePlaybackCapsCache;
        } catch (Exception e) {
            nativePlaybackCapsCache = "{\"native\":true,\"mkv\":true,\"mp4\":true,\"source\":\"exo-mediacodec\"}";
            return nativePlaybackCapsCache;
        }
    }

    private int nativeTotalRamMb() {
        try {
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return 0;
            am.getMemoryInfo(mi);
            return (int) Math.max(0L, mi.totalMem / (1024L * 1024L));
        } catch (Exception ignored) {
            return 0;
        }
    }

    private boolean nativeIsShieldDevice() {
        String s = ((Build.MANUFACTURER == null ? "" : Build.MANUFACTURER) + " "
                + (Build.BRAND == null ? "" : Build.BRAND) + " "
                + (Build.MODEL == null ? "" : Build.MODEL) + " "
                + (Build.DEVICE == null ? "" : Build.DEVICE)).toLowerCase(Locale.US);
        return s.contains("nvidia") || s.contains("shield");
    }

    private boolean nativeIsOnnDevice() {
        String s = ((Build.MANUFACTURER == null ? "" : Build.MANUFACTURER) + " "
                + (Build.BRAND == null ? "" : Build.BRAND) + " "
                + (Build.MODEL == null ? "" : Build.MODEL) + " "
                + (Build.DEVICE == null ? "" : Build.DEVICE)).toLowerCase(Locale.US);
        return s.contains("onn") || s.contains("walmart");
    }

    private boolean nativeConservativePlaybackDevice() {
        if (nativeIsShieldDevice()) return false;
        if (nativeIsOnnDevice()) return true;
        int ram = nativeTotalRamMb();
        return ram > 0 && ram <= 2600;
    }

    private org.json.JSONObject nativeAudioSinkCaps(boolean conservative) {
        org.json.JSONObject out = new org.json.JSONObject();
        try {
            out.put("ac3", false);
            out.put("eac3", false);
            out.put("eac3Joc", false);
            out.put("dts", false);
            out.put("dtsHd", false);
            out.put("truehd", false);
            out.put("passthrough", false);
            out.put("output", "");
            if (conservative || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return out;
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return out;
            AudioDeviceInfo[] devices = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
            boolean any = false;
            String output = "";
            for (AudioDeviceInfo d : devices) {
                if (d == null || !nativePassthroughAudioDevice(d)) continue;
                int[] enc = d.getEncodings();
                if (enc == null || enc.length == 0) continue;
                if (output.isEmpty()) output = nativeAudioDeviceLabel(d);
                boolean ac3 = nativeEncodingSupported(enc, AudioFormat.ENCODING_AC3);
                boolean eac3 = nativeEncodingSupported(enc, AudioFormat.ENCODING_E_AC3);
                boolean eac3Joc = nativeEncodingSupported(enc, AudioFormat.ENCODING_E_AC3_JOC);
                boolean dts = nativeEncodingSupported(enc, AudioFormat.ENCODING_DTS);
                boolean dtsHd = nativeEncodingSupported(enc, AudioFormat.ENCODING_DTS_HD);
                boolean truehd = nativeEncodingSupported(enc, AudioFormat.ENCODING_DOLBY_TRUEHD);
                out.put("ac3", out.optBoolean("ac3") || ac3);
                out.put("eac3", out.optBoolean("eac3") || eac3 || eac3Joc);
                out.put("eac3Joc", out.optBoolean("eac3Joc") || eac3Joc);
                out.put("dts", out.optBoolean("dts") || dts || dtsHd);
                out.put("dtsHd", out.optBoolean("dtsHd") || dtsHd);
                out.put("truehd", out.optBoolean("truehd") || truehd);
                any = any || ac3 || eac3 || eac3Joc || dts || dtsHd || truehd;
            }
            out.put("passthrough", any);
            out.put("output", output);
        } catch (Exception ignored) {}
        return out;
    }

    private boolean nativePassthroughAudioDevice(AudioDeviceInfo d) {
        if (d == null) return false;
        int type = d.getType();
        return type == AudioDeviceInfo.TYPE_HDMI
                || type == AudioDeviceInfo.TYPE_HDMI_ARC
                || type == AudioDeviceInfo.TYPE_HDMI_EARC;
    }

    private boolean nativeEncodingSupported(int[] encodings, int encoding) {
        if (encodings == null) return false;
        for (int e : encodings) if (e == encoding) return true;
        return false;
    }

    private String nativeAudioDeviceLabel(AudioDeviceInfo d) {
        if (d == null) return "";
        int type = d.getType();
        if (type == AudioDeviceInfo.TYPE_HDMI_EARC) return "eARC";
        if (type == AudioDeviceInfo.TYPE_HDMI_ARC) return "ARC";
        if (type == AudioDeviceInfo.TYPE_HDMI) return "HDMI";
        return "";
    }

    private boolean nativeDecoderAvailable(String mime) {
        if (mime == null || mime.isEmpty()) return false;
        try {
            MediaCodecInfo[] infos = nativeDecoderInfos();
            for (MediaCodecInfo info : infos) {
                if (info == null || info.isEncoder()) continue;
                for (String type : info.getSupportedTypes()) {
                    if (mime.equalsIgnoreCase(type)) return true;
                }
            }
        } catch (Exception ignored) {}
        return false;
    }

    // HARDWARE decode only. A SOFTWARE decoder (Google's c2.android.* / OMX.google.*) "supports" the
    // codec but can't keep up with 4K — on a budget box (Onn / Fire TV / Chromecast) software AV1 4K
    // stutters exactly like it does on a Shield with no AV1 decoder at all. We report av1 capability
    // through THIS so a software-only AV1 decoder reads as "no AV1" and the server picks HEVC instead.
    private boolean nativeHardwareDecoderAvailable(String mime) {
        if (mime == null || mime.isEmpty()) return false;
        try {
            for (MediaCodecInfo info : nativeDecoderInfos()) {
                if (info == null || info.isEncoder()) continue;
                boolean handles = false;
                for (String type : info.getSupportedTypes()) {
                    if (mime.equalsIgnoreCase(type)) { handles = true; break; }
                }
                if (handles && nativeIsHardwareDecoder(info)) return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    private boolean nativeIsHardwareDecoder(MediaCodecInfo info) {
        if (Build.VERSION.SDK_INT >= 29) {
            try { return info.isHardwareAccelerated(); } catch (Throwable ignored) {}
        }
        // Pre-29 fallback: exclude the known software-decoder name prefixes.
        String name = info.getName() == null ? "" : info.getName().toLowerCase(Locale.US);
        return !(name.startsWith("omx.google.") || name.startsWith("c2.android.") || name.contains(".sw."));
    }

    private MediaCodecInfo[] nativeDecoderInfos() {
        if (nativeDecoderInfoCache == null) {
            nativeDecoderInfoCache = new MediaCodecList(MediaCodecList.ALL_CODECS).getCodecInfos();
        }
        return nativeDecoderInfoCache;
    }

    // ---------- native Live TV playback ----------
    private void buildNativePlayerLayer() {
        if (nativePlayerLayer != null) return;
        nativePlayerLayer = new FrameLayout(this);
        nativePlayerLayer.setBackgroundColor(Color.BLACK);
        nativePlayerLayer.setFocusable(true);
        nativePlayerLayer.setFocusableInTouchMode(true);
        nativePlayerLayer.setOnKeyListener((v, code, e) -> handleNativeSurfaceKey(e));
        nativePlayerLayer.setOnClickListener(v -> toggleNativeChromeByTouch());
        nativePlayerLayer.setVisibility(View.GONE);

        nativePlayerView = (PlayerView) getLayoutInflater().inflate(R.layout.native_player_view, nativePlayerLayer, false);
        nativePlayerView.setUseController(false);
        nativePlayerView.setOnKeyListener((v, code, e) -> handleNativeSurfaceKey(e));
        nativePlayerView.setOnClickListener(v -> toggleNativeChromeByTouch());
        nativePlayerView.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        nativePlayerView.setBackgroundColor(Color.BLACK);
        nativePlayerView.setShutterBackgroundColor(Color.TRANSPARENT);
        nativePlayerView.setKeepContentOnPlayerReset(true);
        nativePlayerView.setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING);
        if (nativePlayerView.getSubtitleView() != null) {
            nativePlayerView.getSubtitleView().setApplyEmbeddedStyles(false);
            nativePlayerView.getSubtitleView().setFractionalTextSize(0.052f);
            nativePlayerView.getSubtitleView().setBottomPaddingFraction(0.08f);
            nativePlayerView.getSubtitleView().setStyle(new CaptionStyleCompat(
                    Color.WHITE, Color.TRANSPARENT, Color.TRANSPARENT,
                    CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW, Color.BLACK, Typeface.DEFAULT_BOLD));
        }
        nativePlayerLayer.addView(nativePlayerView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        nativeGuidePipRevealScrim = new TextView(this);
        nativeGuidePipRevealScrim.setText("Tuning channel...");
        nativeGuidePipRevealScrim.setTextColor(0xDDF3EFF7);
        nativeGuidePipRevealScrim.setTextSize(10);
        nativeGuidePipRevealScrim.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        nativeGuidePipRevealScrim.setGravity(android.view.Gravity.CENTER);
        nativeGuidePipRevealScrim.setBackgroundColor(0xFF050309);
        nativeGuidePipRevealScrim.setFocusable(false);
        nativeGuidePipRevealScrim.setClickable(false);
        nativeGuidePipRevealScrim.setVisibility(View.GONE);
        nativePlayerLayer.addView(nativeGuidePipRevealScrim, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        nativeSubtitleOverlay = new TextView(this);
        nativeSubtitleOverlay.setTextColor(Color.WHITE);
        nativeSubtitleOverlay.setTextSize(25);
        nativeSubtitleOverlay.setGravity(android.view.Gravity.CENTER);
        nativeSubtitleOverlay.setMaxLines(3);
        nativeSubtitleOverlay.setIncludeFontPadding(false);
        nativeSubtitleOverlay.setTypeface(Typeface.DEFAULT_BOLD);
        nativeSubtitleOverlay.setShadowLayer(dp(2), 0, dp(1), Color.BLACK);
        nativeSubtitleOverlay.setPadding(dp(24), dp(8), dp(24), dp(8));
        nativeSubtitleOverlay.setVisibility(View.GONE);
        FrameLayout.LayoutParams subLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.BOTTOM | android.view.Gravity.CENTER_HORIZONTAL);
        subLp.setMargins(dp(64), 0, dp(64), dp(82));
        nativePlayerLayer.addView(nativeSubtitleOverlay, subLp);

        nativeTop = new LinearLayout(this);
        nativeTop.setOrientation(LinearLayout.VERTICAL);
        nativeTop.setPadding(dp(36), dp(22), dp(36), dp(30));
        nativeTop.setBackgroundColor(Color.TRANSPARENT);

        LinearLayout titleRow = new LinearLayout(this);
        titleRow.setOrientation(LinearLayout.HORIZONTAL);
        titleRow.setGravity(android.view.Gravity.CENTER_VERTICAL);

        nativePlayerTitle = new TextView(this);
        nativePlayerTitle.setTextColor(Color.WHITE);
        nativePlayerTitle.setTextSize(23);
        nativePlayerTitle.setTypeface(Typeface.DEFAULT_BOLD);
        nativePlayerTitle.setSingleLine(true);
        nativePlayerTitle.setShadowLayer(6, 0, 2, Color.BLACK);
        titleRow.addView(nativePlayerTitle, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        LinearLayout metaCol = new LinearLayout(this);
        metaCol.setOrientation(LinearLayout.VERTICAL);
        metaCol.setGravity(android.view.Gravity.END);
        metaCol.setPadding(dp(18), 0, 0, 0);

        nativeClock = new TextView(this);
        nativeClock.setTextColor(0xFFF9F4FF);
        nativeClock.setTextSize(13);
        nativeClock.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        nativeClock.setGravity(android.view.Gravity.END);
        metaCol.addView(nativeClock, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        nativeEndsAt = new TextView(this);
        nativeEndsAt.setTextColor(0xB8F3EFF7);
        nativeEndsAt.setTextSize(11);
        nativeEndsAt.setTypeface(Typeface.DEFAULT_BOLD);
        nativeEndsAt.setGravity(android.view.Gravity.END);
        nativeEndsAt.setPadding(0, dp(3), 0, 0);
        metaCol.addView(nativeEndsAt, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        titleRow.addView(metaCol, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        nativeTop.addView(titleRow, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout subRow = new LinearLayout(this);
        subRow.setOrientation(LinearLayout.HORIZONTAL);
        subRow.setGravity(android.view.Gravity.CENTER_VERTICAL);
        subRow.setPadding(0, dp(6), 0, 0);

        nativePlayerBadge = new TextView(this);
        nativePlayerBadge.setTextColor(0xFFEDE8F5);
        nativePlayerBadge.setTextSize(10);
        nativePlayerBadge.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        nativePlayerBadge.setGravity(android.view.Gravity.CENTER);
        nativePlayerBadge.setPadding(dp(9), dp(3), dp(9), dp(4));
        nativePlayerBadge.setBackground(nativePillBg(0x55221934, 0x66C9B8D8, dp(14)));
        subRow.addView(nativePlayerBadge, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        nativePlayerSubline = new TextView(this);
        nativePlayerSubline.setTextColor(0xB8F3EFF7);
        nativePlayerSubline.setTextSize(11);
        nativePlayerSubline.setSingleLine(true);
        nativePlayerSubline.setPadding(dp(10), 0, 0, 0);
        subRow.addView(nativePlayerSubline, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        nativeTop.addView(subRow, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        FrameLayout.LayoutParams titleLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.TOP | android.view.Gravity.START);
        nativePlayerLayer.addView(nativeTop, titleLp);

        nativeChrome = new LinearLayout(this);
        nativeChrome.setOrientation(LinearLayout.VERTICAL);
        nativeChrome.setPadding(dp(34), dp(12), dp(34), dp(18));
        nativeChrome.setBackgroundColor(Color.TRANSPARENT);
        nativeChrome.setClipChildren(false);
        nativeChrome.setClipToPadding(false);

        nativeControlShade = new View(this);
        nativeControlShade.setBackground(nativeFade(0x00000000, 0xE0000000));
        nativeControlShade.setVisibility(View.GONE);
        nativeControlShade.setFocusable(false);
        nativeControlShade.setClickable(false);
        FrameLayout.LayoutParams shadeLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(430),
                android.view.Gravity.BOTTOM);
        nativePlayerLayer.addView(nativeControlShade, shadeLp);

        nativeMetaBar = new LinearLayout(this);
        nativeMetaBar.setOrientation(LinearLayout.HORIZONTAL);
        nativeMetaBar.setGravity(android.view.Gravity.CENTER_VERTICAL);
        nativeMetaBar.setPadding(dp(34), 0, dp(34), dp(10));
        nativeMetaBar.setVisibility(View.GONE);
        nativeMetaBar.setClipChildren(false);
        nativeMetaBar.setClipToPadding(false);

        LinearLayout chromeText = new LinearLayout(this);
        chromeText.setOrientation(LinearLayout.VERTICAL);
        chromeText.setGravity(android.view.Gravity.CENTER_VERTICAL);
        chromeText.setClipChildren(false);
        chromeText.setClipToPadding(false);

        nativeChromeTitle = new TextView(this);
        nativeChromeTitle.setTextColor(Color.WHITE);
        nativeChromeTitle.setTextSize(18);
        nativeChromeTitle.setTypeface(Typeface.DEFAULT_BOLD);
        nativeChromeTitle.setSingleLine(true);
        nativeChromeTitle.setShadowLayer(6, 0, 2, Color.BLACK);
        chromeText.addView(nativeChromeTitle, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        nativeChromeSubline = new TextView(this);
        nativeChromeSubline.setTextColor(0xB8F3EFF7);
        nativeChromeSubline.setTextSize(12);
        nativeChromeSubline.setTypeface(Typeface.DEFAULT_BOLD);
        nativeChromeSubline.setSingleLine(true);
        nativeChromeSubline.setShadowLayer(5, 0, 2, Color.BLACK);
        nativeChromeSubline.setPadding(0, dp(3), 0, 0);
        nativeChromeSubline.setVisibility(View.GONE);
        chromeText.addView(nativeChromeSubline, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        nativeMetaBar.addView(chromeText, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        nativeChromeQuality = new TextView(this);
        nativeChromeQuality.setTextColor(0xFFF3EFF7);
        nativeChromeQuality.setTextSize(12);
        nativeChromeQuality.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        nativeChromeQuality.setGravity(android.view.Gravity.CENTER);
        nativeChromeQuality.setPadding(dp(11), dp(5), dp(11), dp(6));
        nativeChromeQuality.setBackground(nativePillBg(0x66050309, 0x3AF3EFF7, dp(14)));
        LinearLayout.LayoutParams qualityLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        qualityLp.setMargins(dp(18), 0, 0, 0);
        nativeMetaBar.addView(nativeChromeQuality, qualityLp);
        FrameLayout.LayoutParams metaLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.BOTTOM);
        metaLp.setMargins(0, 0, 0, dp(150));
        nativePlayerLayer.addView(nativeMetaBar, metaLp);

        // Live EPG strip — the channel's "what's on" for ~2h, sitting directly ABOVE the seek bar
        // (matches the web overlay). Populated from the programmes the web pushes via setLiveEpg().
        nativeEpgStrip = new LinearLayout(this);
        nativeEpgStrip.setOrientation(LinearLayout.HORIZONTAL);
        nativeEpgStrip.setClipChildren(false);
        nativeEpgStrip.setVisibility(View.GONE);
        LinearLayout.LayoutParams epgLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        epgLp.setMargins(0, 0, 0, dp(10));
        nativeChrome.addView(nativeEpgStrip, epgLp);

        LinearLayout seekRow = new LinearLayout(this);
        seekRow.setOrientation(LinearLayout.HORIZONTAL);
        seekRow.setGravity(android.view.Gravity.CENTER_VERTICAL);
        seekRow.setClipChildren(false);

        nativeElapsed = new TextView(this);
        nativeElapsed.setTextColor(0xC8F3EFF7);
        nativeElapsed.setTextSize(11);
        nativeElapsed.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        nativeElapsed.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL);
        seekRow.addView(nativeElapsed, new LinearLayout.LayoutParams(dp(56), dp(28)));

        nativeSeek = new SeekBar(this);
        nativeSeek.setMax(1000);
        nativeSeek.setFocusable(true);
        nativeSeek.setOnKeyListener((v, code, e) -> handleNativeSurfaceKey(e));
        nativeSeek.setPadding(dp(4), 0, dp(4), 0);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            nativeSeek.setProgressTintList(ColorStateList.valueOf(0xFFC13BD6));
            nativeSeek.setProgressBackgroundTintList(ColorStateList.valueOf(0x55F3EFF7));
            nativeSeek.setThumbTintList(ColorStateList.valueOf(0xFFF9F4FF));
        }
        nativeSeek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                if (!fromUser || nativePlayer == null) return;
                long d = nativeDurationMs();
                if (d > 0 && d != C.TIME_UNSET) nativeSeekToDisplayPosition((d * progress) / 1000);
            }
            @Override public void onStartTrackingTouch(SeekBar seekBar) {
                nativeUserSeeking = true;
                showNativeChrome(false);
            }
            @Override public void onStopTrackingTouch(SeekBar seekBar) {
                nativeUserSeeking = false;
                scheduleNativeChromeHide();
            }
        });
        seekRow.addView(nativeSeek, new LinearLayout.LayoutParams(0, dp(28), 1));

        nativeTime = new TextView(this);
        nativeTime.setTextColor(0xC8F3EFF7);
        nativeTime.setTextSize(11);
        nativeTime.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        nativeTime.setGravity(android.view.Gravity.END | android.view.Gravity.CENTER_VERTICAL);
        nativeTime.setMinWidth(dp(72));
        seekRow.addView(nativeTime, new LinearLayout.LayoutParams(dp(76), dp(28)));
        nativeChrome.addView(seekRow, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.HORIZONTAL);
        controls.setGravity(android.view.Gravity.CENTER_VERTICAL);
        controls.setPadding(0, dp(18), 0, 0);
        controls.setClipChildren(false);
        controls.setClipToPadding(false);

        LinearLayout leftControls = new LinearLayout(this);
        leftControls.setOrientation(LinearLayout.HORIZONTAL);
        leftControls.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL);
        leftControls.setClipChildren(false);
        leftControls.setClipToPadding(false);

        LinearLayout centerControls = new LinearLayout(this);
        centerControls.setOrientation(LinearLayout.HORIZONTAL);
        centerControls.setGravity(android.view.Gravity.CENTER);
        centerControls.setClipChildren(false);
        centerControls.setClipToPadding(false);

        LinearLayout rightControls = new LinearLayout(this);
        rightControls.setOrientation(LinearLayout.HORIZONTAL);
        rightControls.setGravity(android.view.Gravity.END | android.view.Gravity.CENTER_VERTICAL);
        rightControls.setClipChildren(false);
        rightControls.setClipToPadding(false);

        nativeGuideBtn = nativeButton(R.drawable.ic_player_guide, "TV guide", false);
        nativeGuideBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) openNativeLiveGuide(); });
        leftControls.addView(nativeGuideBtn);

        nativeRewBtn = nativeButton(R.drawable.ic_player_rewind, "Back 10 seconds", false);
        nativeRewBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) nativeSeekBy(-10000); });
        centerControls.addView(nativeRewBtn);

        nativePlayBtn = nativeButton(R.drawable.ic_player_pause, "Pause", true);
        nativePlayBtn.setOnClickListener(v -> {
            if (!consumeNativeControlClick(v)) return;
            if (nativePlayer == null) return;
            if (nativePlayer.isPlaying()) nativePlayer.pause();
            else nativePlayer.play();
            updateNativeChrome();
        });
        centerControls.addView(nativePlayBtn);

        // Live only: a neutral "LIVE" pill styled like the other transport controls (not a big red
        // block) — just a small red dot signals live. Tap to jump back to the live edge after a
        // pause/rewind and resume.
        nativeLiveBtn = new TextView(this);
        android.text.SpannableString liveLabel = new android.text.SpannableString("● LIVE");
        liveLabel.setSpan(new android.text.style.ForegroundColorSpan(0xFFFF5A5A), 0, 1, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        nativeLiveBtn.setText(liveLabel);
        nativeLiveBtn.setTextColor(0xFFF3EFF7);
        nativeLiveBtn.setTextSize(10);
        nativeLiveBtn.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        nativeLiveBtn.setGravity(android.view.Gravity.CENTER);
        nativeLiveBtn.setPadding(dp(12), 0, dp(12), 0);
        nativeLiveBtn.setContentDescription("Go to live");
        nativeLiveBtn.setBackground(nativeButtonBg(false, false));
        nativeLiveBtn.setFocusable(true);
        nativeLiveBtn.setClickable(true);
        nativeLiveBtn.setOnFocusChangeListener((v, has) -> {
            v.setBackground(nativeButtonBg(has, false));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) v.setElevation(has ? dp(4) : 0);
            if (has) showNativeChrome(false);
        });
        nativeLiveBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) goNativeLive(); });
        nativeLiveBtn.setOnKeyListener((v, code, e) -> handleNativeSurfaceKey(e));
        LinearLayout.LayoutParams liveLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, dp(36));
        liveLp.setMargins(dp(8), 0, dp(8), 0);
        centerControls.addView(nativeLiveBtn, liveLp);

        nativeFwdBtn = nativeButton(R.drawable.ic_player_forward, "Forward 30 seconds", false);
        nativeFwdBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) nativeSeekBy(30000); });
        centerControls.addView(nativeFwdBtn);

        nativeNextBtn = nativeButton(R.drawable.ic_player_next, "Next episode", false);
        nativeNextBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) playNativeNextEpisode(); });
        centerControls.addView(nativeNextBtn);

        // Favorite toggle — only shown for live IPTV (the owner's "IPTV player should show
        // add/remove favorite"). The web layer owns the favorites store; this forwards the tap and
        // renders the on/off star from the state the web pushes back via setLiveFav().
        nativeFavBtn = nativeButton(R.drawable.ic_player_fav, "Favorite", false);
        nativeFavBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) toggleNativeLiveFavorite(); });
        rightControls.addView(nativeFavBtn);

        nativeCcBtn = nativeButton(R.drawable.ic_player_cc, "Subtitles", false);
        nativeCcBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) showNativeTrackMenu(C.TRACK_TYPE_TEXT); });
        rightControls.addView(nativeCcBtn);

        nativeAudioBtn = nativeButton(R.drawable.ic_player_audio, "Audio language", false);
        nativeAudioBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) showNativeTrackMenu(C.TRACK_TYPE_AUDIO); });
        rightControls.addView(nativeAudioBtn);

        nativeCastBtn = nativeButton(R.drawable.ic_player_cast, "Cast to TV", false);
        nativeCastBtn.setVisibility(View.GONE); // shown by updateNativeCastButton when a Cast device is available
        nativeCastBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) castCurrentNativeVideo(); });
        rightControls.addView(nativeCastBtn);

        nativeQualityBtn = nativeButton(R.drawable.ic_player_quality, "Quality", false);
        nativeQualityBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) showNativeQualityMenu(); });
        rightControls.addView(nativeQualityBtn);

        nativeStatsBtn = nativeButton(R.drawable.ic_player_info, "Playback stats", false);
        nativeStatsBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) showNativeStatsSheet(); });
        rightControls.addView(nativeStatsBtn);

        controls.addView(leftControls, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        controls.addView(centerControls, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        controls.addView(rightControls, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        nativeChrome.addView(controls, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        nativeEpisodeStrip = new HorizontalScrollView(this);
        nativeEpisodeStrip.setHorizontalScrollBarEnabled(false);
        nativeEpisodeStrip.setFillViewport(false);
        nativeEpisodeStrip.setVisibility(View.GONE);
        nativeEpisodeStrip.setClipChildren(false);
        nativeEpisodeStrip.setClipToPadding(false);
        nativeEpisodeStrip.setPadding(0, dp(16), 0, 0);
        nativeEpisodeList = new LinearLayout(this);
        nativeEpisodeList.setOrientation(LinearLayout.HORIZONTAL);
        nativeEpisodeList.setClipChildren(false);
        nativeEpisodeList.setClipToPadding(false);
        nativeEpisodeStrip.addView(nativeEpisodeList, new HorizontalScrollView.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        nativeChrome.addView(nativeEpisodeStrip, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(198)));

        FrameLayout.LayoutParams chromeLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.BOTTOM);
        chromeLp.setMargins(0, 0, 0, dp(28));
        nativePlayerLayer.addView(nativeChrome, chromeLp);

        nativeSheet = new LinearLayout(this);
        nativeSheet.setOrientation(LinearLayout.VERTICAL);
        nativeSheet.setPadding(dp(12), dp(10), dp(12), dp(12));
        nativeSheet.setBackground(nativePanelBg());
        nativeSheet.setFocusable(true);
        nativeSheet.setFocusableInTouchMode(true);
        nativeSheet.setClickable(true);
        nativeSheet.setDescendantFocusability(ViewGroup.FOCUS_AFTER_DESCENDANTS);
        nativeSheet.setVisibility(View.GONE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) nativeSheet.setElevation(dp(8));
        FrameLayout.LayoutParams sheetLp = new FrameLayout.LayoutParams(
                nativeSheetWidthPx(), ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.END | android.view.Gravity.BOTTOM);
        int sheetSide = nativeSheetSideMarginPx();
        sheetLp.setMargins(sheetSide, 0, sheetSide, nativeSheetBottomMarginPx());
        nativePlayerLayer.addView(nativeSheet, sheetLp);

        nativeUpNextCard = buildNativeUpNextCard();
        FrameLayout.LayoutParams upNextLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.END | android.view.Gravity.BOTTOM);
        upNextLp.setMargins(0, 0, dp(40), dp(58));
        nativePlayerLayer.addView(nativeUpNextCard, upNextLp);

        nativeLoading = new FrameLayout(this);
        nativeLoading.setBackgroundColor(0xFF050309);
        nativeLoading.setVisibility(View.GONE);
        nativeLoading.setClickable(true);
        nativeLoading.setFocusable(false);

        nativeLoadingBackdrop = new ImageView(this);
        nativeLoadingBackdrop.setScaleType(ImageView.ScaleType.CENTER_CROP);
        nativeLoadingBackdrop.setAlpha(0.42f);
        nativeLoading.addView(nativeLoadingBackdrop, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        View loadingWash = new View(this);
        loadingWash.setBackground(nativeLoadingWash());
        nativeLoading.addView(loadingWash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout loadingCenter = new LinearLayout(this);
        loadingCenter.setOrientation(LinearLayout.VERTICAL);
        loadingCenter.setGravity(android.view.Gravity.CENTER);
        loadingCenter.setPadding(dp(36), dp(36), dp(36), dp(36));

        ImageView loadingMark = new ImageView(this);
        loadingMark.setImageResource(R.drawable.native_loading_wordmark);
        loadingMark.setAdjustViewBounds(true);
        loadingMark.setScaleType(ImageView.ScaleType.FIT_CENTER);
        loadingMark.setAlpha(0.96f);
        LinearLayout.LayoutParams markLp = new LinearLayout.LayoutParams(dp(250), ViewGroup.LayoutParams.WRAP_CONTENT);
        loadingCenter.addView(loadingMark, markLp);

        nativeLoadingTitle = new TextView(this);
        nativeLoadingTitle.setTextColor(0xDDF3EFF7);
        nativeLoadingTitle.setTextSize(24);
        nativeLoadingTitle.setTypeface(Typeface.DEFAULT_BOLD);
        nativeLoadingTitle.setGravity(android.view.Gravity.CENTER);
        nativeLoadingTitle.setMaxLines(2);
        nativeLoadingTitle.setEllipsize(TextUtils.TruncateAt.END);
        nativeLoadingTitle.setPadding(0, dp(18), 0, 0);
        loadingCenter.addView(nativeLoadingTitle, new LinearLayout.LayoutParams(
                dp(620), ViewGroup.LayoutParams.WRAP_CONTENT));

        FrameLayout loadingLane = new FrameLayout(this);
        loadingLane.setBackground(nativeLoadingLaneBg());
        loadingLane.setClipChildren(true);
        nativeLoadingLaneGlow = new View(this);
        nativeLoadingLaneGlow.setBackground(nativeLoadingLaneGlowBg());
        FrameLayout.LayoutParams glowLp = new FrameLayout.LayoutParams(dp(92), dp(4));
        glowLp.leftMargin = -dp(92);
        loadingLane.addView(nativeLoadingLaneGlow, glowLp);
        LinearLayout.LayoutParams laneLp = new LinearLayout.LayoutParams(dp(300), dp(4));
        laneLp.setMargins(0, dp(16), 0, 0);
        loadingCenter.addView(loadingLane, laneLp);

        nativeLoadingStatus = new TextView(this);
        nativeLoadingStatus.setTextColor(0xAAF3EFF7);
        nativeLoadingStatus.setTextSize(12);
        nativeLoadingStatus.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        nativeLoadingStatus.setGravity(android.view.Gravity.CENTER);
        nativeLoadingStatus.setSingleLine(true);
        nativeLoadingStatus.setEllipsize(TextUtils.TruncateAt.END);
        nativeLoadingStatus.setText("Preparing");
        LinearLayout.LayoutParams statusLp = new LinearLayout.LayoutParams(
                dp(360), ViewGroup.LayoutParams.WRAP_CONTENT);
        statusLp.setMargins(0, dp(10), 0, 0);
        loadingCenter.addView(nativeLoadingStatus, statusLp);

        nativeLoading.addView(loadingCenter, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.CENTER));
        nativePlayerLayer.addView(nativeLoading, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(nativePlayerLayer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    private GradientDrawable nativeLoadingWash() {
        GradientDrawable d = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[]{0xEE050309, 0xB80B0812, 0xD8110618});
        d.setShape(GradientDrawable.RECTANGLE);
        return d;
    }

    private GradientDrawable nativeLoadingLaneBg() {
        GradientDrawable d = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{0x18FFFFFF, 0x2AF3EFF7, 0x18FFFFFF});
        d.setStroke(dp(1), 0x22FFFFFF);
        d.setCornerRadius(dp(999));
        return d;
    }

    private GradientDrawable nativeLoadingLaneGlowBg() {
        GradientDrawable d = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{0x00FFFFFF, 0xCCB8A46A, 0xFFFFFFFF, 0xCCB8A46A, 0x00FFFFFF});
        d.setCornerRadius(dp(999));
        return d;
    }

    private void showNativeLoading(String title, String backdropUrl) {
        if (nativeLoading == null) return;
        int token = ++nativeLoadingToken;
        nativeLoadingTitle.setText(title == null || title.isEmpty() ? "Preparing stream" : title);
        startNativeLoadingStatus();
        nativeLoadingBackdrop.setImageDrawable(null);
        nativeLoading.setVisibility(View.VISIBLE);
        nativeLoading.bringToFront();
        startNativeLoadingLane();
        if (backdropUrl == null || backdropUrl.trim().isEmpty()) return;
        String art = backdropUrl.trim();
        new Thread(() -> {
            Bitmap bitmap = null;
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(art).openConnection();
                conn.setConnectTimeout(3500);
                conn.setReadTimeout(5000);
                conn.setInstanceFollowRedirects(true);
                bitmap = decodeNativeBackdrop(readLimitedBytes(conn.getInputStream(), NATIVE_BACKDROP_MAX_BYTES));
            } catch (Exception ignored) {
            } finally {
                if (conn != null) conn.disconnect();
            }
            Bitmap finalBitmap = bitmap;
            runOnUiThread(() -> {
                if (token != nativeLoadingToken || nativeLoading == null
                        || nativeLoading.getVisibility() != View.VISIBLE) return;
                if (finalBitmap != null) nativeLoadingBackdrop.setImageBitmap(finalBitmap);
            });
        }, "TriboonNativeBackdrop").start();
    }

    private byte[] readLimitedBytes(InputStream in, int maxBytes) throws IOException {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.min(maxBytes, 256 * 1024));
            byte[] buf = new byte[16384];
            int total = 0;
            int n;
            while ((n = in.read(buf)) >= 0) {
                total += n;
                if (total > maxBytes) throw new IOException("image too large");
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } finally {
            try { in.close(); } catch (Exception ignored) {}
        }
    }

    private Bitmap decodeNativeBackdrop(byte[] bytes) {
        if (bytes == null || bytes.length == 0) return null;
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = 1;
        while ((bounds.outWidth / opts.inSampleSize) > NATIVE_BACKDROP_MAX_WIDTH
                || (bounds.outHeight / opts.inSampleSize) > NATIVE_BACKDROP_MAX_HEIGHT) {
            opts.inSampleSize *= 2;
        }
        opts.inPreferredConfig = Bitmap.Config.RGB_565;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
    }

    private void hideNativeLoading() {
        nativeLoadingToken++;
        stopNativeLoadingStatus();
        if (nativeLoadingLaneAnimator != null) {
            nativeLoadingLaneAnimator.cancel();
            nativeLoadingLaneAnimator = null;
        }
        if (nativeLoadingLaneGlow != null) nativeLoadingLaneGlow.setTranslationX(-dp(92));
        if (nativeLoading != null) nativeLoading.setVisibility(View.GONE);
        if (nativeLoadingBackdrop != null) nativeLoadingBackdrop.setImageDrawable(null);
    }

    private void startNativeLoadingStatus() {
        if (nativeLoadingStatus == null) return;
        nativeProgress.removeCallbacks(nativeLoadingStatusTick);
        nativeLoadingStatusIndex = 0;
        nativeLoadingStatus.setText(nativeLoadingStatuses[nativeLoadingStatusIndex]);
        nativeProgress.postDelayed(nativeLoadingStatusTick, 850L);
    }

    private void stopNativeLoadingStatus() {
        nativeProgress.removeCallbacks(nativeLoadingStatusTick);
        nativeLoadingStatusIndex = 0;
        if (nativeLoadingStatus != null) nativeLoadingStatus.setText(nativeLoadingStatuses[nativeLoadingStatusIndex]);
    }

    private void startNativeLoadingLane() {
        if (nativeLoadingLaneGlow == null) return;
        if (nativeLoadingLaneAnimator != null) {
            nativeLoadingLaneAnimator.cancel();
            nativeLoadingLaneAnimator = null;
        }
        nativeLoadingLaneGlow.setTranslationX(-dp(92));
        nativeLoadingLaneAnimator = ObjectAnimator.ofFloat(nativeLoadingLaneGlow, "translationX", -dp(92), dp(320));
        nativeLoadingLaneAnimator.setDuration(1350L);
        nativeLoadingLaneAnimator.setRepeatCount(ValueAnimator.INFINITE);
        nativeLoadingLaneAnimator.setInterpolator(new LinearInterpolator());
        nativeLoadingLaneAnimator.start();
    }

    private GradientDrawable nativeFade(int start, int end) {
        return new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{start, end});
    }

    private GradientDrawable nativePillBg(int fill, int stroke, float radius) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.RECTANGLE);
        d.setCornerRadius(radius);
        d.setColor(fill);
        d.setStroke(dp(1), stroke);
        return d;
    }

    private GradientDrawable nativePanelBg() {
        GradientDrawable d = new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0xF0181A1D, 0xF00D0F12});
        d.setShape(GradientDrawable.RECTANGLE);
        d.setCornerRadius(dp(10));
        d.setStroke(dp(1), 0x12FFFFFF);
        return d;
    }

    // Up Next card — the native twin of the web #upNext overlay. The countdown + "what plays
    // next" logic lives in the web layer (single source of truth, and it keeps running while the
    // WebView is hidden behind the ExoPlayer surface); this card just renders what web pushes via
    // TriboonTV.upNext(...) and forwards Play/Dismiss back to web.
    private View buildNativeUpNextCard() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(13), dp(16), dp(14));
        card.setBackground(nativePanelBg());
        card.setVisibility(View.GONE);
        card.setClipChildren(false);
        card.setClipToPadding(false);
        card.setDescendantFocusability(ViewGroup.FOCUS_AFTER_DESCENDANTS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) card.setElevation(dp(10));

        nativeUpNextKicker = new TextView(this);
        nativeUpNextKicker.setText("UP NEXT");
        nativeUpNextKicker.setTextColor(0xFFF2B441);
        nativeUpNextKicker.setTextSize(11);
        nativeUpNextKicker.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        card.addView(nativeUpNextKicker);

        nativeUpNextTitle = new TextView(this);
        nativeUpNextTitle.setTextColor(Color.WHITE);
        nativeUpNextTitle.setTextSize(17);
        nativeUpNextTitle.setTypeface(Typeface.DEFAULT_BOLD);
        nativeUpNextTitle.setSingleLine(true);
        nativeUpNextTitle.setEllipsize(TextUtils.TruncateAt.END);
        nativeUpNextTitle.setPadding(0, dp(5), 0, 0);
        card.addView(nativeUpNextTitle, new LinearLayout.LayoutParams(dp(300), ViewGroup.LayoutParams.WRAP_CONTENT));

        nativeUpNextSub = new TextView(this);
        nativeUpNextSub.setTextColor(0xB8F3EFF7);
        nativeUpNextSub.setTextSize(12);
        nativeUpNextSub.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        nativeUpNextSub.setPadding(0, dp(2), 0, 0);
        card.addView(nativeUpNextSub);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(12), 0, 0);
        nativeUpNextPlay = nativeUpNextButton("Play Next", true);
        nativeUpNextPlay.setOnClickListener(v -> triggerNativeUpNextPlay());
        row.addView(nativeUpNextPlay);
        nativeUpNextDismiss = nativeUpNextButton("Dismiss", false);
        nativeUpNextDismiss.setOnClickListener(v -> dismissNativeUpNext(true));
        row.addView(nativeUpNextDismiss);
        card.addView(row, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return card;
    }

    private Button nativeUpNextButton(String label, boolean primary) {
        Button b = new Button(this);
        b.setAllCaps(false);
        b.setText(label);
        b.setTextColor(primary ? 0xFF0B0A0F : Color.WHITE);
        b.setTextSize(14);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setFocusable(true);
        b.setFocusableInTouchMode(false);
        b.setClickable(true);
        b.setMinWidth(0);
        b.setMinHeight(0);
        b.setMinimumWidth(0);
        b.setMinimumHeight(0);
        b.setPadding(dp(18), dp(9), dp(18), dp(9));
        b.setBackground(nativeUpNextButtonBg(false, primary));
        b.setOnFocusChangeListener((v, hasFocus) -> v.setBackground(nativeUpNextButtonBg(hasFocus, primary)));
        b.setOnKeyListener((v, code, e) -> handleNativeUpNextKey(e));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(8);
        b.setLayoutParams(lp);
        return b;
    }

    private GradientDrawable nativeUpNextButtonBg(boolean focused, boolean primary) {
        int fill = primary ? (focused ? 0xFFFFFFFF : 0xFFF3EFF7) : (focused ? 0x33FFFFFF : 0x14FFFFFF);
        int stroke = focused ? 0xFFF2B441 : 0x22FFFFFF;
        return nativePillBg(fill, stroke, dp(8));
    }

    private void showNativeUpNext(String json) {
        if (nativeUpNextCard == null || !"video".equals(nativeMode) || !nativePlayerOpen()) return;
        String title = "";
        String sub = "";
        int seconds = -1;
        boolean autoplay = false;
        try {
            org.json.JSONObject j = new org.json.JSONObject(json == null ? "{}" : json);
            title = j.optString("title", "");
            sub = j.optString("sub", "");
            seconds = j.optInt("seconds", -1);
            autoplay = j.optBoolean("autoplay", false);
        } catch (Exception e) { return; }
        nativeUpNextTitle.setText(title.isEmpty() ? "Next episode" : title);
        nativeUpNextSub.setText(sub);
        nativeUpNextSub.setVisibility(sub.isEmpty() ? View.GONE : View.VISIBLE);
        nativeUpNextPlay.setText(autoplay && seconds >= 0 ? ("Play Next · " + seconds) : "Play Next");
        boolean wasVisible = nativeUpNextVisible;
        nativeUpNextCard.setVisibility(View.VISIBLE);
        nativeUpNextVisible = true;
        if (!wasVisible) nativeUpNextPlay.requestFocus();
    }

    private void dismissNativeUpNext(boolean notifyWeb) {
        boolean was = nativeUpNextVisible;
        nativeUpNextVisible = false;
        if (nativeUpNextCard != null) nativeUpNextCard.setVisibility(View.GONE);
        if (was && nativePlayerLayer != null) nativePlayerLayer.requestFocus();
        if (notifyWeb && web != null) {
            web.evaluateJavascript("window.__upNextDismissNative && __upNextDismissNative()", null);
        }
    }

    private void triggerNativeUpNextPlay() {
        nativeUpNextVisible = false;
        if (nativeUpNextCard != null) nativeUpNextCard.setVisibility(View.GONE);
        if (web != null) web.evaluateJavascript("window.__upNextPlayNative && __upNextPlayNative()", null);
    }

    private boolean handleNativeUpNextKey(KeyEvent e) {
        if (e == null) return false;
        int code = e.getKeyCode();
        boolean ok = code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                || code == KeyEvent.KEYCODE_NUMPAD_ENTER || code == KeyEvent.KEYCODE_BUTTON_A;
        boolean nav = ok || code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT
                || code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN;
        // Swallow the matching key-up for anything we act on below so it can't double-fire or leak
        // into the seek/chrome path once the card hides.
        if (e.getAction() != KeyEvent.ACTION_DOWN) return nav;
        if (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_ESCAPE) {
            dismissNativeUpNext(true);
            return true;
        }
        if (ok) {
            // OK activates whichever button holds focus; default to Play Next.
            if (nativeUpNextDismiss != null && nativeUpNextDismiss.hasFocus()) dismissNativeUpNext(true);
            else triggerNativeUpNextPlay();
            return true;
        }
        if (code == KeyEvent.KEYCODE_DPAD_LEFT) {
            if (nativeUpNextPlay != null) nativeUpNextPlay.requestFocus();
            return true;
        }
        if (code == KeyEvent.KEYCODE_DPAD_RIGHT) {
            if (nativeUpNextDismiss != null) nativeUpNextDismiss.requestFocus();
            return true;
        }
        if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN) return true; // single-row card: trap, no-op
        return false;
    }

    private ImageButton nativeButton(int iconRes, String label, boolean primary) {
        ImageButton b = new ImageButton(this);
        b.setContentDescription(label);
        b.setFocusable(true);
        b.setClickable(true);
        b.setOnKeyListener((v, code, e) -> handleNativeSurfaceKey(e));
        b.setTag(iconRes);
        b.setPadding(dp(primary ? 9 : 8), dp(primary ? 9 : 8), dp(primary ? 9 : 8), dp(primary ? 9 : 8));
        b.setScaleType(ImageButton.ScaleType.CENTER_INSIDE);
        b.setBackground(nativeButtonBg(false, primary));
        setNativeButtonIcon(b, iconRes, primary, false);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                dp(primary ? 46 : 36), dp(primary ? 46 : 36));
        lp.rightMargin = dp(6);
        b.setLayoutParams(lp);
        b.setOnFocusChangeListener((v, hasFocus) -> {
            v.setBackground(nativeButtonBg(hasFocus, primary));
            Object tag = v.getTag();
            if (tag instanceof Integer) setNativeButtonIcon((ImageButton) v, (Integer) tag, primary, hasFocus);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                v.setElevation(hasFocus ? dp(4) : 0);
            }
            if (hasFocus) showNativeChrome(false);
        });
        return b;
    }

    private View nativeControlSpacer(int widthDp) {
        View spacer = new View(this);
        spacer.setFocusable(false);
        spacer.setClickable(false);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(dp(widthDp), dp(1)));
        return spacer;
    }

    private void setNativeButtonIcon(ImageButton b, int iconRes, boolean primary, boolean focused) {
        b.setImageResource(iconRes);
        int tint = !b.isEnabled() ? 0x88EDE8F5 : (focused ? 0xFF0B0812 : 0xFFEDE8F5);
        b.setImageTintList(ColorStateList.valueOf(tint));
    }

    private void setNativeButtonEnabled(ImageButton b, boolean enabled) {
        if (b == null) return;
        b.setEnabled(enabled);
        b.setClickable(enabled);
        b.setFocusable(enabled);
        b.setAlpha(enabled ? 1f : 0.45f);
        boolean primary = b == nativePlayBtn;
        b.setBackground(nativeButtonBg(b.hasFocus() && enabled, primary));
        Object tag = b.getTag();
        if (tag instanceof Integer) setNativeButtonIcon(b, (Integer) tag, primary, b.hasFocus() && enabled);
        if (!enabled && getCurrentFocus() == b) focusNativeDefaultControl();
    }

    // Live IPTV favorite: forward the tap to the web layer (which owns the favorites store); the
    // web pushes the resulting on/off state back via setLiveFav() so the star reflects reality.
    private void toggleNativeLiveFavorite() {
        if (web != null) web.evaluateJavascript("window.__tvLiveFavToggle && __tvLiveFavToggle()", null);
    }

    private void applyNativeFavIcon() {
        if (nativeFavBtn == null) return;
        int icon = nativeLiveFav ? R.drawable.ic_player_fav_on : R.drawable.ic_player_fav;
        nativeFavBtn.setTag(icon);
        nativeFavBtn.setContentDescription(nativeLiveFav ? "Remove from favorites" : "Add to favorites");
        setNativeButtonIcon(nativeFavBtn, icon, false, nativeFavBtn.hasFocus());
    }

    private GradientDrawable nativeButtonBg(boolean focused, boolean primary) {
        GradientDrawable d = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                focused
                        ? new int[]{0xFFEDE8F5, 0xFFD9CBE7}
                        : new int[]{0x18F3EFF7, 0x18F3EFF7});
        d.setShape(GradientDrawable.RECTANGLE);
        d.setCornerRadius(dp(primary ? 23 : 18));
        d.setStroke(0, 0x00000000);
        return d;
    }

    private void startNativeLive(String json) { startNativePlayback(json, "live"); }

    private void startNativeVideo(String json) { startNativePlayback(json, "video"); }

    private void showNativeVideoLoading(String json) {
        String title = "Triboon";
        String backdropUrl = "";
        try {
            org.json.JSONObject j = new org.json.JSONObject(json == null ? "{}" : json);
            title = j.optString("title", title);
            backdropUrl = j.optString("backdropUrl", "");
        } catch (Exception ignored) {
        }
        try {
            setPhonePlaybackOrientation(true);
            releaseNativePlayer(false);
            buildNativePlayerLayer();
            nativeMode = "video";
            enterNativeFullscreenMode();
            showNativeLoading(title, backdropUrl);
        } catch (Throwable e) {
            handleNativePlaybackStartFailure(e, "video", title, backdropUrl, "direct", "", "", 0L);
        }
    }

    private void startNativePlayback(String json, String mode) {
        String title = "video".equals(mode) ? "Triboon" : "Live TV";
        String backdropUrl = "";
        String loadingKind = "direct";
        String loadingQuality = "";
        String loadingSource = "";
        long loadingStartOffsetMs = 0L;
        try {
            org.json.JSONObject j = new org.json.JSONObject(json == null ? "{}" : json);
            ValidatedNativeUrl primaryUrl = validateNativePlaybackUrl(j.optString("url", ""));
            String url = primaryUrl.connectUrl;
            if (url.isEmpty()) throw new IllegalArgumentException("missing stream url");
            title = j.optString("title", title);
            String mime = j.optString("mime", "");
            String fallbackRaw = j.optString("fallbackUrl", "");
            ValidatedNativeUrl fallbackPin = optionalNativeFallbackUrl(fallbackRaw, "primary fallback");
            String fallbackUrl = fallbackPin == null ? "" : fallbackPin.connectUrl;
            String fallbackMime = j.optString("fallbackMime", "");
            backdropUrl = j.optString("backdropUrl", "");
            long startMs = Math.max(0, Math.round(j.optDouble("start", 0) * 1000));
            long startOffsetMs = Math.max(0, Math.round(j.optDouble("startOffset", 0) * 1000));
            String episodeLabel = j.optString("episodeLabel", "");
            String subtitleUrl = j.optString("subtitleUrl", "");
            String subtitleLang = j.optString("subtitleLang", "");
            String subtitleLabel = j.optString("subtitleLabel", "");
            String subtitleRel = j.optString("subtitleRel", "");
            String qualityLabel = j.optString("qualityLabel", "");
            loadingQuality = qualityLabel;
            loadingSource = j.optString("source", "");
            boolean hasNext = j.optBoolean("hasNext", false);
            boolean hasQualityChoices = j.optBoolean("qualityChoices", false);
            boolean guide = j.optBoolean("guide", false);
            boolean quietSeek = j.optBoolean("quietSeek", false);
            long knownDurationMs = Math.max(0L, Math.round(j.optDouble("duration", 0) * 1000));
            long playbackSizeBytes = Math.max(0L, j.optLong("size", 0L));
            int bufferGoalSec = Math.max(0, j.optInt("bufferGoalSec", 0));
            double playbackDurationSec = Math.max(0, j.optDouble("duration", 0));
            loadingStartOffsetMs = startOffsetMs;
            if (!guide) setPhonePlaybackOrientation(true);
            buildNativePlayerLayer();
            boolean reuseQuietVideo = quietSeek && "video".equals(mode) && nativePlayer != null
                    && nativePlayerView != null && nativePlayerOpen() && !guide;
            boolean reuseLivePlayer = "live".equals(mode) && nativePlayer != null
                    && nativePlayerView != null && nativePlayerOpen() && !guide;
            if (!reuseQuietVideo && !reuseLivePlayer) {
                releaseNativePlayer(false, guide);
            } else {
                nativeProgress.removeCallbacks(nativeHideChrome);
                hideNativeLoading();
                if (nativeSheet != null) {
                    nativeSheet.setVisibility(View.GONE);
                    nativeSheet.removeAllViews();
                }
            }
            nativeMode = mode;
            boolean isLiveMode = "live".equals(mode);
            nativeKind = j.optString("kind", "direct");
            loadingKind = nativeKind;
            nativeQualityLabel = qualityLabel.isEmpty() ? (isLiveMode ? "LIVE" : "1080p") : qualityLabel;
            loadingQuality = nativeQualityLabel;
            nativeUrl = url;
            nativeHostHeader = primaryUrl.hostHeader;
            nativeMime = mime;
            nativeFallbackUrl = fallbackUrl;
            nativeFallbackMime = fallbackMime;
            nativeFallbackUrls.clear();
            nativeFallbackMimes.clear();
            nativeFallbackHostHeaders.clear();
            nativeFallbackIndex = 0;
            addNativeFallback(fallbackUrl, fallbackMime, nativeUrl, fallbackPin == null ? "" : fallbackPin.hostHeader);
            org.json.JSONArray fallbacks = j.optJSONArray("fallbacks");
            if (fallbacks != null) {
                for (int i = 0; i < fallbacks.length(); i++) {
                    org.json.JSONObject fb = fallbacks.optJSONObject(i);
                    if (fb == null) continue;
                    String fbUrl = fb.optString("url", "");
                    if (!fbUrl.trim().isEmpty()) {
                        ValidatedNativeUrl fbPin = optionalNativeFallbackUrl(fbUrl, "fallback " + i);
                        if (fbPin != null) {
                            addNativeFallback(fbPin.connectUrl, fb.optString("mime", ""), nativeUrl, fbPin.hostHeader);
                        }
                    }
                }
            }
            nativePlaybackTitle = title == null || title.isEmpty() ? "Triboon" : title;
            nativePlaybackSubline = episodeLabel == null ? "" : episodeLabel;
            nativePlaybackBackdropUrl = backdropUrl == null ? "" : backdropUrl;
            nativePlaybackSizeBytes = playbackSizeBytes;
            nativeBufferGoalSec = bufferGoalSec;
            nativePlaybackDurationSec = playbackDurationSec;
            nativeTriedFallback = false;
            nativeLiveUnhealthySinceMs = 0L;
            nativeLiveLastRecoveryMs = 0L;
            nativeLiveStarted = false;
            nativeVideoUnhealthySinceMs = 0L;
            nativeVideoMemoryTrimmedDuringBuffer = false;
            nativeVideoErrorNotified = false;
            nativeKnownDurationMs = knownDurationMs;
            nativePendingStartMs = "video".equals(mode) ? startMs : 0L;
            nativeStartSeekIssuedAtMs = 0L;
            nativeStartOffsetMs = "video".equals(mode) ? startOffsetMs : 0L;
            nativeVideoStarted = false;
            nativeLastVideoDisplayMs = "video".equals(mode) ? Math.max(startMs, startOffsetMs) : 0L;
            nativeLastAutoResumeSeekMs = 0L;
            nativeHasNext = hasNext;
            nativeHasQualityChoices = hasQualityChoices;
            nativeSubtitleShift = (float) j.optDouble("subtitleShift", nativeShiftFromUrl(subtitleUrl));
            String cleanSubtitleUrl = stripNativeQueryParam(subtitleUrl, "shift");
            ValidatedNativeUrl subtitlePin = cleanSubtitleUrl.isEmpty() ? null : validateNativePlaybackUrl(cleanSubtitleUrl);
            nativeSubtitleUrl = subtitlePin == null ? "" : subtitlePin.connectUrl;
            nativeSubtitleHostHeader = subtitlePin == null ? "" : subtitlePin.hostHeader;
            nativeSubtitleLang = subtitleLang;
            nativeSubtitleRel = subtitleRel;
            nativeSubtitleLabel = subtitleLabel.isEmpty()
                    ? (!subtitleLang.isEmpty() ? nativeLangName(subtitleLang) : "Subtitles")
                    : subtitleLabel;
            nativeHasWyzieSubtitle = subtitlePin != null;
            applyNativeSubtitleChoices(j.optJSONArray("subtitleChoices"));
            updateNativeEpisodeChoices(new org.json.JSONObject()
                    .put("episodes", j.optJSONArray("episodeChoices"))
                    .toString());

            if (!reuseQuietVideo && !reuseLivePlayer) {
                nativePlayer = new ExoPlayer.Builder(this, nativeRenderersFactory())
                        .setMediaSourceFactory(nativeMediaSourceFactory())
                        .setLoadControl(nativeLoadControlForMode(mode))
                        .setBandwidthMeter(nativeBandwidthMeterForMode(mode))
                        .setSeekParameters(SeekParameters.CLOSEST_SYNC)
                        .build();
                nativePlayer.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA)
                        .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                        .build(), true);
                nativePlayer.setHandleAudioBecomingNoisy(true);
                nativePlayer.addListener(new Player.Listener() {
                @Override public void onPlayerError(PlaybackException error) {
                    String msg = nativePlaybackErrorMessage(error);
                    long pos = nativePosSeconds();
                    long dur = nativeDurSeconds();
                    String m = nativeMode;
                    if ("video".equals(m)) {
                        notifyNativeVideoError(msg, pos, dur);
                    } else if (tryNativeLiveFallback()) {
                        return;
                    } else {
                        closeNativePlayback(false);
                        web.evaluateJavascript("window.__tvNativeLiveError && __tvNativeLiveError("
                                + org.json.JSONObject.quote(msg) + ")", null);
                    }
                }

                @Override public void onPlaybackStateChanged(int state) {
                    updateNativeChrome();
                    if (state == Player.STATE_READY) {
                        if ("video".equals(nativeMode)) {
                            nativeVideoStarted = true;
                            rememberNativeVideoPosition();
                            web.evaluateJavascript("window.__tvNativeVideoReady && __tvNativeVideoReady("
                                    + nativePosSeconds() + "," + nativeDurSeconds() + ")", null);
                        } else if ("live".equals(nativeMode)) {
                            nativeLiveStarted = true;
                            hideNativeGuidePipReveal();
                            web.evaluateJavascript("window.__tvNativeLiveReady && __tvNativeLiveReady()", null);
                        }
                        applyNativeStartSeekIfReady();
                    }
                    if (state == Player.STATE_READY && nativeLoading != null
                            && nativeLoading.getVisibility() == View.VISIBLE) {
                        nativeVideoUnhealthySinceMs = 0L;
                        hideNativeLoading();
                        if (!nativeGuideMode) showNativeChrome(true);
                    }
                    if (state == Player.STATE_ENDED && "video".equals(nativeMode)) {
                        long dur = nativeDurSeconds();
                        long pos = dur > 0 ? dur : nativePosSeconds();
                        closeNativePlayback(false);
                        web.evaluateJavascript("window.__tvNativeVideoClosed && __tvNativeVideoClosed("
                                + pos + "," + dur + ",true)", null);
                    } else if (state == Player.STATE_ENDED && "live".equals(nativeMode)) {
                        recoverNativeLivePlayback("ended");
                    }
                }

                @Override public void onTracksChanged(Tracks tracks) {
                    updateNativeChrome();
                }

                @Override public void onIsPlayingChanged(boolean isPlaying) {
                    updateNativeChrome();
                    if ("live".equals(nativeMode) && isPlaying) nativeLiveUnhealthySinceMs = 0L;
                    if ("live".equals(nativeMode) && isPlaying) nativeLiveStarted = true;
                    if ("video".equals(nativeMode) && isPlaying) {
                        nativeVideoStarted = true;
                        nativeVideoUnhealthySinceMs = 0L;
                        rememberNativeVideoPosition();
                        web.evaluateJavascript("window.__tvNativeVideoPlaying && __tvNativeVideoPlaying("
                                + nativePosSeconds() + "," + nativeDurSeconds() + ")", null);
                    } else if ("video".equals(nativeMode) && nativeVideoStarted
                            && nativePlayer != null
                            && nativePlayer.getPlaybackState() == Player.STATE_READY
                            && !nativePlayer.getPlayWhenReady()) {
                        rememberNativeVideoPosition();
                        web.evaluateJavascript("window.__tvNativeVideoPaused && __tvNativeVideoPaused("
                                + nativePosSeconds() + "," + nativeDurSeconds() + ")", null);
                    }
                    scheduleNativeChromeHide();
                }
            });
            }

            nativePlayerView.setPlayer(nativePlayer);
            applyNativeTrackSelectionDefaults(isLiveMode);
            nativePlayerTitle.setText(title);
            nativePlayerTitle.setVisibility(View.VISIBLE);
            if (nativeChromeTitle != null) nativeChromeTitle.setText("");
            String subline = isLiveMode ? "" : nativePlaybackSubline;
            if (nativeChromeSubline != null) {
                nativeChromeSubline.setText("");
                nativeChromeSubline.setVisibility(View.GONE);
            }
            String chromeQuality = isLiveMode ? "LIVE" : "";
            nativePlayerSubline.setText(subline);
            nativePlayerSubline.setVisibility(subline.isEmpty() ? View.GONE : View.VISIBLE);
            nativePlayerBadge.setText(chromeQuality);
            nativePlayerBadge.setVisibility(chromeQuality.isEmpty() ? View.GONE : View.VISIBLE);
            if (nativeChromeQuality != null) nativeChromeQuality.setText("");
            if (nativeGuideBtn != null) nativeGuideBtn.setVisibility(View.VISIBLE);
            nativeNextBtn.setVisibility(hasNext ? View.VISIBLE : View.GONE);
            nativePlayerLayer.setVisibility(View.VISIBLE);
            if (!guide && isLiveMode) {
                enterNativeFullscreenMode();
            }
            if (!guide && "video".equals(mode) && !quietSeek) {
                enterNativeFullscreenMode();
                showNativeLoading(title, backdropUrl);
            }
            if (reuseLivePlayer) {
                nativePlayer.stop();
                nativePlayer.clearMediaItems();
            }
            applyNativeHttpHostHeader();
            nativePlayer.setMediaItem(buildNativeMediaItem());
            nativePlayer.prepare();
            if (startMs > 0) nativePlayer.seekTo(startMs);
            nativePlayer.play();
            if ("video".equals(mode) && nativeHasWyzieSubtitle && !nativeSubtitleUrl.isEmpty()) {
                loadNativeSubtitleOverlay(nativeSubtitleUrl);
            } else {
                clearNativeSubtitleOverlay();
            }
            startNativeProgress();
            if (guide) {
                enterNativeGuideMode();
                web.evaluateJavascript("window.__tvNativeGuideEpoch && window.__tvNativeGuideEpoch("
                        + nativeGuideEpoch + ")", null);
            }
            else if (!"video".equals(mode)) showNativeChrome(true);
        } catch (Throwable e) {
            handleNativePlaybackStartFailure(e, mode, title, backdropUrl, loadingKind,
                    loadingQuality, loadingSource, loadingStartOffsetMs);
        }
    }

    private void handleNativePlaybackStartFailure(Throwable e, String mode, String title, String backdropUrl,
                                                  String loadingKind, String loadingQuality,
                                                  String loadingSource, long loadingStartOffsetMs) {
        String msg = nativeThrowableMessage(e);
        Log.e(TAG, "Native playback startup failed (" + mode + "): " + msg, e);
        try {
            trimAndroidMemoryCaches(true);
        } catch (Throwable ignored) {
        }
        if ("video".equals(mode)) {
            try {
                releaseNativePlayer(false);
                buildNativePlayerLayer();
                nativeMode = "video";
                enterNativeFullscreenMode();
                showNativeLoading(title, backdropUrl);
            } catch (Throwable overlayError) {
                Log.w(TAG, "Native retry overlay failed: " + nativeThrowableMessage(overlayError));
            }
            try {
                web.evaluateJavascript("window.__tvNativeVideoError && __tvNativeVideoError("
                        + org.json.JSONObject.quote(msg) + ",0,0)", null);
            } catch (Throwable ignored) {
            }
        } else {
            try {
                closeNativePlayback(false);
            } catch (Throwable closeError) {
                Log.w(TAG, "Native live close after startup failure ignored: " + nativeThrowableMessage(closeError));
            }
            try {
                web.evaluateJavascript("window.__tvNativeLiveError && __tvNativeLiveError("
                        + org.json.JSONObject.quote(msg) + ")", null);
            } catch (Throwable ignored) {
            }
        }
    }

    private boolean nativePlayerOpen() {
        return nativePlayerLayer != null && nativePlayerLayer.getVisibility() == View.VISIBLE;
    }

    private void showNativeChrome(boolean focusPlay) {
        if (nativeChrome == null) return;
        if (nativeControlShade != null) nativeControlShade.setVisibility(View.VISIBLE);
        if (nativeMetaBar != null) nativeMetaBar.setVisibility(View.GONE);
        nativeChrome.setVisibility(View.VISIBLE);
        nativeTop.setVisibility(View.VISIBLE);
        setNativeSubtitleLift(true);
        if (focusPlay && nativePlayBtn != null && !nativeSheetOpen()) nativePlayBtn.requestFocus();
        scheduleNativeChromeHide();
    }

    private void toggleNativeChromeByTouch() {
        if (!nativePlayerOpen() || nativeGuideMode || nativeSheetOpen() || nativeEpisodeStripOpen) return;
        if (nativeChromeShowingForBack()) hideNativeChromeNow();
        else showNativeChrome(false);
    }

    private void scheduleNativeChromeHide() {
        nativeProgress.removeCallbacks(nativeHideChrome);
        if (nativePlayer != null && nativePlayer.isPlaying()) {
            nativeProgress.postDelayed(nativeHideChrome, 4200);
        }
    }

    private final Runnable nativeHideChrome = new Runnable() {
        @Override public void run() {
            if (!nativePlayerOpen() || nativeChrome == null) return;
            if (nativeUserSeeking || nativeSheetOpen() || nativeEpisodeStripOpen) return;
            hideNativeChromeNow();
        }
    };

    private void hideNativeChromeNow() {
        if (nativeControlShade != null) nativeControlShade.setVisibility(View.GONE);
        if (nativeMetaBar != null) nativeMetaBar.setVisibility(View.GONE);
        if (nativeChrome != null) nativeChrome.setVisibility(View.GONE);
        if (nativeTop != null) nativeTop.setVisibility(View.GONE);
        parkNativeHiddenFocusOnSeek();
        setNativeSubtitleLift(false);
    }

    private boolean nativeChromeShowingForBack() {
        return (nativeChrome != null && nativeChrome.getVisibility() == View.VISIBLE)
                || (nativeControlShade != null && nativeControlShade.getVisibility() == View.VISIBLE)
                || (nativeMetaBar != null && nativeMetaBar.getVisibility() == View.VISIBLE)
                || (nativeTop != null && nativeTop.getVisibility() == View.VISIBLE);
    }

    private boolean dismissNativeChromeForBack() {
        if (!nativeChromeShowingForBack()) return false;
        nativeProgress.removeCallbacks(nativeHideChrome);
        hideNativeChromeNow();
        return true;
    }

    private boolean handleNativeBackKey(KeyEvent e) {
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            if (e.getRepeatCount() == 0) nativeBackConsumedChromeDown = false;
            if (!nativeGuideMode && !nativeSheetOpen() && !nativeEpisodeStripOpen
                    && dismissNativeChromeForBack()) {
                nativeBackConsumedChromeDown = true;
                lastSystemBackAt = SystemClock.uptimeMillis();
            }
            return true;
        }
        if (e.getAction() == KeyEvent.ACTION_UP) {
            if (nativeBackConsumedChromeDown) {
                nativeBackConsumedChromeDown = false;
                return true;
            }
            handleSystemBack();
            return true;
        }
        return true;
    }

    private void parkNativeHiddenFocusOnSeek() {
        nativeSeekDpadMode = nativeCanSeekVod();
        nativeControlIndex = -1;
        if (nativePlayerLayer != null) nativePlayerLayer.requestFocus();
    }

    private void setNativeSubtitleLift(boolean lift) {
        if (nativePlayerView != null && nativePlayerView.getSubtitleView() != null) {
            nativePlayerView.getSubtitleView().setBottomPaddingFraction(lift ? 0.30f : 0.08f);
            nativePlayerView.getSubtitleView().setPadding(0, 0, 0, lift ? dp(178) : dp(28));
        }
        if (nativeSubtitleOverlay != null) {
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) nativeSubtitleOverlay.getLayoutParams();
            lp.bottomMargin = lift ? dp(206) : dp(82);
            nativeSubtitleOverlay.setLayoutParams(lp);
        }
    }

    private long nativePosSeconds() {
        return nativeDisplayPositionMs() / 1000;
    }

    private long nativeDurSeconds() {
        if (nativePlayer == null) return 0;
        long d = nativeDurationMs();
        return d > 0 && d != C.TIME_UNSET ? d / 1000 : 0;
    }

    private long nativeDurationMs() {
        if (nativePlayer == null) return nativeKnownDurationMs;
        if (nativeStartOffsetMs > 0L && nativeKnownDurationMs > 0L) return nativeKnownDurationMs;
        long d = nativePlayer.getDuration();
        if (d > 0 && d != C.TIME_UNSET) return d;
        return nativeKnownDurationMs;
    }

    private long nativeRawPositionMs() {
        return nativePlayer == null ? 0L : Math.max(0L, nativePlayer.getCurrentPosition());
    }

    private long nativeDisplayPositionMs() {
        if (nativePlayer == null) return 0L;
        return Math.max(0L, nativeStartOffsetMs + nativeRawPositionMs());
    }

    private void rememberNativeVideoPosition() {
        if (!"video".equals(nativeMode) || nativePlayer == null) return;
        long pos = nativeDisplayPositionMs();
        if (nativeServerSeekMode() && nativeVideoStarted && nativeLastVideoDisplayMs > 0L) {
            long backwardsBy = nativeLastVideoDisplayMs - pos;
            if (backwardsBy > 5000L) {
                // A benign PTS/GOP wobble in a server-seek (remux/transcode) stream dips the reported
                // position for a SINGLE ~1s tick then recovers; a genuine segment restart stays
                // backward. Require a SMALL regression to persist across 2 consecutive ticks before
                // re-mounting, so a one-tick wobble no longer causes a visible dip-then-snap. But a
                // LARGE jump (>60s) is unambiguously a stream restart — ExoPlayer reconnected the
                // non-resumable piped stream and the server replayed from the start — so recover it on
                // the first tick, with no dwell in the previous section.
                boolean bigRestart = backwardsBy > 60000L;
                if (!bigRestart && ++nativeBackwardTicks < 2) return; // small regression — wait one more tick
                long now = SystemClock.elapsedRealtime();
                if (nativeLastAutoResumeSeekMs <= 0L || now - nativeLastAutoResumeSeekMs >= 1500L) {
                    nativeLastAutoResumeSeekMs = now;
                    nativeBackwardTicks = 0;
                    Log.w(TAG, "Native VOD segment jumped back by " + backwardsBy + "ms"
                            + (bigRestart ? " (stream restart)" : "") + "; resuming same source at "
                            + nativeLastVideoDisplayMs + "ms");
                    requestNativeVideoSeek(nativeLastVideoDisplayMs);
                }
                return;
            }
            nativeBackwardTicks = 0; // forward / normal reading — reset the confirmation counter
        }
        if (pos > 0L) nativeLastVideoDisplayMs = pos;
    }

    private long safeNativeVideoPosSeconds(long reportedSeconds) {
        long reportedMs = Math.max(0L, reportedSeconds * 1000L);
        if (reportedMs <= 1000L && nativeLastVideoDisplayMs > 30000L) {
            return nativeLastVideoDisplayMs / 1000L;
        }
        return Math.max(0L, reportedSeconds);
    }

    private boolean nativeVodSeekable() {
        if (nativePlayer == null || "live".equals(nativeMode)) return false;
        long d = nativeDurationMs();
        return nativePlayer.isCurrentMediaItemSeekable() || (d > 0 && d != C.TIME_UNSET);
    }

    private boolean nativeServerSeekMode() {
        return "remux".equals(nativeKind) || "transcode".equals(nativeKind);
    }

    private boolean nativeCanSeekVod() {
        return nativePlayer != null && "video".equals(nativeMode)
                && (nativeVodSeekable() || nativeServerSeekMode());
    }

    private void nativeSeekBy(long deltaMs) {
        if (nativePlayer == null) return;
        long d = nativeDurationMs();
        if ("live".equals(nativeMode) || (!nativeVodSeekable() && !nativeServerSeekMode())) {
            showNativeChrome(false);
            return;
        }
        long target = Math.max(0, nativeDisplayPositionMs() + deltaMs);
        if (d > 0 && d != C.TIME_UNSET) target = Math.min(d, target);
        nativeSeekToDisplayPosition(target);
        updateNativeChrome();
        showNativeChrome(false);
    }

    private void nativeSeekToDisplayPosition(long displayMs) {
        if (nativePlayer == null) return;
        long target = Math.max(0L, displayMs);
        long d = nativeDurationMs();
        if (d > 0 && d != C.TIME_UNSET) target = Math.min(d, target);
        nativeLastVideoDisplayMs = target;
        if (nativeServerSeekMode()) {
            requestNativeVideoSeek(target);
            return;
        }
        nativePlayer.seekTo(Math.max(0L, target - nativeStartOffsetMs));
    }

    private void requestNativeVideoSeek(long displayMs) {
        if (web == null || !"video".equals(nativeMode)) return;
        long pos = Math.max(0L, displayMs / 1000L);
        web.evaluateJavascript("window.__tvNativeVideoSeek && window.__tvNativeVideoSeek("
                + pos + "," + nativeDurSeconds() + ")", null);
    }

    private void applyNativeStartSeekIfReady() {
        if (nativePlayer == null || nativePendingStartMs <= 0L || !"video".equals(nativeMode)) return;
        if (nativePlayer.getPlaybackState() != Player.STATE_READY || !nativeVodSeekable()) return;
        long target = nativePendingStartMs;
        long d = nativeDurationMs();
        if (d > 0 && d != C.TIME_UNSET) target = Math.min(d, target);
        long current = nativeDisplayPositionMs();
        if (current >= Math.max(0L, target - 3000L)) {
            nativePendingStartMs = 0L;
            nativeStartSeekIssuedAtMs = 0L;
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (nativeStartSeekIssuedAtMs > 0L && now - nativeStartSeekIssuedAtMs < 1200L) return;
        nativeStartSeekIssuedAtMs = now;
        nativeSeekToDisplayPosition(target);
        updateNativeChrome();
    }

    private void zapNativeLiveChannel(int dir) {
        if (!"live".equals(nativeMode) || nativeGuideMode || nativeSheetOpen() || web == null) return;
        showNativeChrome(false);
        web.evaluateJavascript("window.__tvNativeLiveZap && window.__tvNativeLiveZap("
                + (dir >= 0 ? 1 : -1) + ")", null);
    }

    private void openNativeLiveGuide() {
        if (nativePlayer != null && "video".equals(nativeMode)) {
            web.evaluateJavascript("window.__tvNativeVideoProgress && __tvNativeVideoProgress("
                    + nativePosSeconds() + "," + nativeDurSeconds() + ")", null);
        }
        enterNativeGuideMode();
        web.evaluateJavascript("window.__tvNativeLiveGuide && window.__tvNativeLiveGuide("
                + nativeGuideEpoch + ")", null);
    }

    private void syncNativeGuidePipRevealScrim(FrameLayout.LayoutParams pipLp) {
        if (nativeGuidePipRevealScrim == null || pipLp == null) return;
        FrameLayout.LayoutParams scrimLp = new FrameLayout.LayoutParams(
                pipLp.width, pipLp.height, pipLp.gravity);
        scrimLp.setMargins(pipLp.leftMargin, pipLp.topMargin, pipLp.rightMargin, pipLp.bottomMargin);
        nativeGuidePipRevealScrim.setLayoutParams(scrimLp);
    }

    private void revealNativeGuidePip(FrameLayout.LayoutParams pipLp) {
        revealNativeGuidePip(pipLp, false);
    }

    private void revealNativeGuidePip(FrameLayout.LayoutParams pipLp, boolean holdUntilReady) {
        if (nativeGuidePipRevealScrim == null || pipLp == null) return;
        syncNativeGuidePipRevealScrim(pipLp);
        nativeGuidePipRevealScrim.animate().cancel();
        nativeGuidePipRevealScrim.setText("Tuning channel...");
        nativeGuidePipRevealScrim.setAlpha(1f);
        nativeGuidePipRevealScrim.setVisibility(View.VISIBLE);
        nativeGuidePipRevealScrim.bringToFront();
        if (holdUntilReady) return;
        nativeGuidePipRevealScrim.animate()
                .alpha(0f)
                .setDuration(180)
                .setStartDelay(220)
                .withEndAction(() -> {
                    if (nativeGuidePipRevealScrim != null) nativeGuidePipRevealScrim.setVisibility(View.GONE);
                })
                .start();
    }

    private void hideNativeGuidePipReveal() {
        if (nativeGuidePipRevealScrim == null) return;
        nativeGuidePipRevealScrim.animate().cancel();
        nativeGuidePipRevealScrim.setVisibility(View.GONE);
        nativeGuidePipRevealScrim.setAlpha(1f);
    }

    private void enterNativeGuideMode() {
        if (nativePlayerLayer == null || nativePlayerView == null) return;
        boolean alreadyGuideMode = nativeGuideMode
                && web != null && web.getVisibility() == View.VISIBLE
                && nativePlayerLayer.getVisibility() == View.VISIBLE;
        nativeGuideEpoch++;
        nativeGuideMode = true;
        nativeProgress.removeCallbacks(nativeHideChrome);
        if (nativeSheet != null) nativeSheet.setVisibility(View.GONE);
        if (nativeTop != null) nativeTop.setVisibility(View.GONE);
        if (nativeMetaBar != null) nativeMetaBar.setVisibility(View.GONE);
        if (nativeChrome != null) nativeChrome.setVisibility(View.GONE);
        if (nativeControlShade != null) nativeControlShade.setVisibility(View.GONE);
        if (nativeMetaBar != null) nativeMetaBar.setVisibility(View.GONE);
        nativePlayerLayer.setBackgroundColor(Color.TRANSPARENT);
        nativePlayerLayer.setFocusable(false);
        nativePlayerLayer.setFocusableInTouchMode(false);
        // The full-screen player layer is brought to front over the web EPG in guide mode so the PiP
        // video renders on top — but it also carries a tap-to-toggle-chrome click listener, which
        // makes it CLICKABLE across the whole screen and swallows taps meant for the web guide rows
        // (a phone/touch bug; TV is fine because D-pad routes to the focused WebView, not touch).
        // Drop click-consumption here so guide-area taps fall through to the WebView; the PiP
        // PlayerView keeps its own listener. Restored in closeNativeGuideMode().
        nativePlayerLayer.setOnClickListener(null);
        nativePlayerLayer.setClickable(false);
        if (!alreadyGuideMode) {
            int screenW = getResources().getDisplayMetrics().widthPixels;
            int pipW = Math.max(dp(260), Math.min(dp(430), Math.round(screenW * 0.27f)));
            int pipH = Math.round(pipW * 9f / 16f);
            FrameLayout.LayoutParams pipLp = new FrameLayout.LayoutParams(
                    pipW, pipH, android.view.Gravity.TOP | android.view.Gravity.START);
            pipLp.setMargins(dp(38), dp(30), 0, 0);
            nativePlayerView.setLayoutParams(pipLp);
            revealNativeGuidePip(pipLp);
        } else if ("live".equals(nativeMode)) {
            try {
                revealNativeGuidePip((FrameLayout.LayoutParams) nativePlayerView.getLayoutParams(), true);
            } catch (Throwable ignored) {
            }
        }
        nativePlayerView.setAlpha(1f);
        nativePlayerView.setVisibility(View.VISIBLE);
        setNativeSubtitleLift(false);
        if (nativeSubtitleOverlay != null) nativeSubtitleOverlay.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        if (!alreadyGuideMode) web.requestFocus();
        else web.postDelayed(() -> {
            if (nativeGuideMode && web != null) web.requestFocus();
        }, 40);
        web.bringToFront();
        nativePlayerLayer.setVisibility(View.VISIBLE);
        nativePlayerLayer.bringToFront();
    }

    private void applyNativeGuidePipRect(String json) {
        if (!nativeGuideMode || nativePlayerView == null || web == null) return;
        try {
            org.json.JSONObject j = new org.json.JSONObject(json == null ? "{}" : json);
            if (web.getWidth() <= 0 || web.getHeight() <= 0) return;
            float vw = Math.max(1f, (float) j.optDouble("vw", web.getWidth()));
            float vh = Math.max(1f, (float) j.optDouble("vh", web.getHeight()));
            float rawW = (float) j.optDouble("width", 0);
            float rawH = (float) j.optDouble("height", 0);
            if (rawW <= 1f || rawH <= 1f) return;
            float scaleX = web.getWidth() / vw;
            float scaleY = web.getHeight() / vh;
            int screenW = getResources().getDisplayMetrics().widthPixels;
            int screenH = getResources().getDisplayMetrics().heightPixels;
            int width = Math.max(dp(120), Math.round(rawW * scaleX));
            int height = Math.max(dp(68), Math.round(rawH * scaleY));
            width = Math.min(width, Math.max(dp(120), screenW));
            height = Math.min(height, Math.max(dp(68), screenH));
            int left = Math.round((float) j.optDouble("x", 0) * scaleX);
            int top = Math.round((float) j.optDouble("y", 0) * scaleY);
            left = Math.max(0, Math.min(left, Math.max(0, screenW - width)));
            top = Math.max(0, Math.min(top, Math.max(0, screenH - height)));
            FrameLayout.LayoutParams pipLp = new FrameLayout.LayoutParams(
                    width, height, android.view.Gravity.TOP | android.view.Gravity.START);
            pipLp.setMargins(left, top, 0, 0);
            nativePlayerView.setLayoutParams(pipLp);
            nativePlayerView.setAlpha(1f);
            syncNativeGuidePipRevealScrim(pipLp);
        } catch (Exception ignored) {
            // The fixed fallback from enterNativeGuideMode stays in place.
        }
    }

    private void enterNativeFullscreenMode() {
        if (nativePlayerLayer == null || nativePlayerView == null) return;
        nativeGuideMode = false;
        nativePlayerLayer.setBackgroundColor(Color.BLACK);
        nativePlayerLayer.setFocusable(true);
        nativePlayerLayer.setFocusableInTouchMode(true);
        // Restore full-screen tap-to-toggle-chrome (guide mode had dropped it so guide taps could
        // reach the web EPG). setOnClickListener re-marks the layer clickable.
        nativePlayerLayer.setOnClickListener(v -> toggleNativeChromeByTouch());
        nativePlayerView.setVisibility(View.VISIBLE);
        nativePlayerView.animate().cancel();
        nativePlayerView.setAlpha(1f);
        hideNativeGuidePipReveal();
        nativePlayerView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        nativePlayerLayer.setVisibility(View.VISIBLE);
        nativePlayerLayer.bringToFront();
        web.setVisibility(View.GONE);
        nativePlayerLayer.requestFocus();
        updateNativeSubtitleOverlay();
    }

    private void closeNativeGuideMode() {
        if (!nativeGuideMode) return;
        int closingEpoch = nativeGuideEpoch;
        web.evaluateJavascript("window.__tvNativeGuideClosed && window.__tvNativeGuideClosed("
                + closingEpoch + ")", null);
        enterNativeFullscreenMode();
        showNativeChrome(true);
    }

    private void renderNativeEpgStrip() {
        if (nativeEpgStrip == null) return;
        nativeEpgStrip.removeAllViews();
        org.json.JSONArray data = nativeEpgData;
        if (!"live".equals(nativeMode) || data == null || data.length() == 0) {
            nativeEpgStrip.setVisibility(View.GONE);
            return;
        }
        long now = System.currentTimeMillis();
        long horizon = now + 2L * 3600000L;
        // Fewer cells on a narrow phone (4 across a phone width truncates every title to nothing).
        int dpWidth = (int) (getResources().getDisplayMetrics().widthPixels
                / getResources().getDisplayMetrics().density);
        int maxCells = dpWidth < 600 ? 2 : 4;
        int shown = 0;
        for (int i = 0; i < data.length() && shown < maxCells; i++) {
            org.json.JSONObject p = data.optJSONObject(i);
            if (p == null) continue;
            long start = p.optLong("start", 0), stop = p.optLong("stop", 0);
            if (stop <= now || start >= horizon) continue;
            boolean isNow = start <= now && stop > now;
            LinearLayout cell = new LinearLayout(this);
            cell.setOrientation(LinearLayout.VERTICAL);
            cell.setPadding(dp(10), dp(6), dp(10), dp(7));
            cell.setBackground(nativePillBg(isNow ? 0x30F3EFF7 : 0x14F3EFF7,
                    isNow ? 0x66F3EFF7 : 0x18F3EFF7, 0));
            TextView when = new TextView(this);
            when.setTextColor(0xCCBFBFBF);
            when.setTextSize(9);
            when.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
            when.setText(isNow ? "NOW" : fmtNativeClock(start));
            cell.addView(when, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            TextView title = new TextView(this);
            title.setTextColor(0xFFF3EFF7);
            title.setTextSize(12.5f);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            title.setSingleLine(true);
            title.setEllipsize(android.text.TextUtils.TruncateAt.END);
            title.setText(p.optString("title", ""));
            cell.addView(title, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.WRAP_CONTENT, isNow ? 2.4f : 1f);
            if (shown > 0) lp.setMargins(dp(5), 0, 0, 0);
            nativeEpgStrip.addView(cell, lp);
            shown++;
        }
        nativeEpgStrip.setVisibility(shown > 0 ? View.VISIBLE : View.GONE);
    }

    private void goNativeLive() {
        if (nativePlayer == null || !"live".equals(nativeMode)) return;
        try {
            nativePlayer.seekToDefaultPosition(); // a live window's default position IS the live edge
            nativePlayer.play();
        } catch (Exception ignored) {}
        updateNativeChrome();
    }

    private View[] nativeControlButtons() {
        return new View[]{
                nativeGuideBtn, nativeRewBtn, nativePlayBtn, nativeLiveBtn, nativeFwdBtn,
                nativeNextBtn, nativeFavBtn, nativeCcBtn, nativeAudioBtn, nativeCastBtn, nativeQualityBtn, nativeStatsBtn
        };
    }

    private boolean moveNativeControlFocus(int dir) {
        if (nativeChrome == null || nativeChrome.getVisibility() != View.VISIBLE) return false;
        nativeSeekDpadMode = false;
        View[] buttons = nativeControlButtons();
        View current = getCurrentFocus();
        int first = -1, last = -1, cur = -1;
        for (int i = 0; i < buttons.length; i++) {
            View b = buttons[i];
            if (b == null || b.getVisibility() != View.VISIBLE || !b.isEnabled()) continue;
            if (first < 0) first = i;
            last = i;
            if (current == b) cur = i;
        }
        if (first < 0) return false;
        if (cur < 0 && nativeControlIndex >= first && nativeControlIndex <= last) {
            View remembered = buttons[nativeControlIndex];
            if (remembered != null && remembered.getVisibility() == View.VISIBLE && remembered.isEnabled()) {
                cur = nativeControlIndex;
            }
        }
        int target = cur < 0
                ? (nativePlayBtn != null && nativePlayBtn.getVisibility() == View.VISIBLE
                    && nativePlayBtn.isEnabled() ? java.util.Arrays.asList(buttons).indexOf(nativePlayBtn) : first)
                : Math.max(first, Math.min(last, cur + dir));
        while (target >= first && target <= last) {
            View b = buttons[target];
            if (b != null && b.getVisibility() == View.VISIBLE && b.isEnabled()) {
                nativeControlIndex = target;
                b.requestFocus();
                showNativeChrome(false);
                return true;
            }
            target += dir < 0 ? -1 : 1;
        }
        return false;
    }

    private boolean clickNativeControlFocus() {
        if (nativeChrome == null || nativeChrome.getVisibility() != View.VISIBLE) return false;
        View current = getCurrentFocus();
        View[] buttons = nativeControlButtons();
        for (int i = 0; i < buttons.length; i++) {
            View b = buttons[i];
            if (b != null && b.getVisibility() == View.VISIBLE && b.isEnabled() && current == b) {
                nativeControlIndex = i;
                armNativeControlClick(b);
                b.performClick();
                return true;
            }
        }
        if (nativeControlIndex >= 0 && nativeControlIndex < buttons.length) {
            View b = buttons[nativeControlIndex];
            if (b != null && b.getVisibility() == View.VISIBLE && b.isEnabled()) {
                armNativeControlClick(b);
                b.performClick();
                return true;
            }
        }
        return false;
    }

    private void armNativeControlClick(View v) {
        nativeClickArmedView = v;
        nativeClickArmedAtMs = SystemClock.elapsedRealtime();
    }

    private boolean consumeNativeControlClick(View v) {
        if (v == null) return false;
        // Touch (phones/tablets): a real tap IS a genuine click — accept it directly. The arm/consume
        // dance below only exists to gate D-pad OK on TV; without this, touch taps were never armed,
        // so NO player button worked on a phone (couldn't even pause).
        if (v.isInTouchMode()) { nativeClickArmedView = null; nativeClickArmedAtMs = 0L; return true; }
        long now = SystemClock.elapsedRealtime();
        boolean ok = v == nativeClickArmedView && now - nativeClickArmedAtMs < 800L;
        nativeClickArmedView = null;
        nativeClickArmedAtMs = 0L;
        return ok;
    }

    private boolean isNativeControl(View current) {
        if (current == null) return false;
        for (View b : nativeControlButtons()) {
            if (b != null && b.getVisibility() == View.VISIBLE && b.isEnabled() && current == b) return true;
        }
        return false;
    }

    private boolean focusNativeDefaultControl() {
        nativeSeekDpadMode = false;
        View[] buttons = nativeControlButtons();
        View target = nativePlayBtn != null && nativePlayBtn.getVisibility() == View.VISIBLE && nativePlayBtn.isEnabled() ? nativePlayBtn : null;
        if (target == null) {
            for (View b : buttons) {
                if (b != null && b.getVisibility() == View.VISIBLE && b.isEnabled()) { target = b; break; }
            }
        }
        if (target == null) return false;
        showNativeChrome(false);
        nativeControlIndex = java.util.Arrays.asList(buttons).indexOf(target);
        target.requestFocus();
        return true;
    }

    private boolean focusNativeSeekControl() {
        if (nativeSeek == null || nativeSheetOpen() || !nativeCanSeekVod()) return false;
        showNativeChrome(false);
        updateNativeChrome();
        if (nativeSeek.getVisibility() != View.VISIBLE || !nativeSeek.isEnabled()) return false;
        nativeSeekDpadMode = true;
        nativeControlIndex = -1;
        Runnable focusSeek = new Runnable() {
            @Override public void run() {
                if (!nativePlayerOpen() || nativeSeek == null || nativeSheetOpen()) return;
                if (nativeSeek.getVisibility() == View.VISIBLE && nativeSeek.isEnabled()) {
                    nativeSeek.requestFocus();
                }
            }
        };
        focusSeek.run();
        nativeSeek.postDelayed(focusSeek, 60);
        return true;
    }

    private boolean moveNativeVerticalFocus(int dir) {
        if (nativeChrome == null || nativeSheetOpen()) return false;
        View current = getCurrentFocus();
        if (dir < 0 && current != nativeSeek) {
            return focusNativeSeekControl();
        }
        if (dir > 0 && (current == nativeSeek || nativeSeekDpadMode || !isNativeControl(current))) {
            return focusNativeDefaultControl();
        }
        return isNativeControl(current) || current == nativeSeek;
    }

    private boolean handleNativeSeekBarKey(KeyEvent e) {
        View current = getCurrentFocus();
        if (nativeSeek == null || !nativeCanSeekVod()
                || (current != nativeSeek && (!nativeSeekDpadMode || isNativeControl(current)))
                || nativeSeek.getVisibility() != View.VISIBLE || !nativeSeek.isEnabled()) return false;
        int code = e.getKeyCode();
        if (code != KeyEvent.KEYCODE_DPAD_LEFT && code != KeyEvent.KEYCODE_DPAD_RIGHT) return false;
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            nativeSeekBy(code == KeyEvent.KEYCODE_DPAD_RIGHT ? 30000 : -10000);
        }
        return true;
    }

    private boolean handleNativeSurfaceKey(KeyEvent e) {
        if (!nativePlayerOpen()) return false;
        int code = e.getKeyCode();
        if (handleNativeSheetKey(e)) return true;
        if (handleNativeEpisodeStripKey(e)) return true;
        // The Up Next card owns the remote while it's up — otherwise OK/arrows fell through to
        // toggle-chrome / seek and the user could never trigger Play Next (binge flow was broken).
        if (nativeUpNextVisible) return handleNativeUpNextKey(e);
        if (nativeGuideMode) return false;
        if ("live".equals(nativeMode) && (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN)) {
            if (e.getAction() == KeyEvent.ACTION_UP) {
                zapNativeLiveChannel(code == KeyEvent.KEYCODE_DPAD_UP ? 1 : -1);
            }
            return true;
        }
        if (nativeChrome != null && nativeChrome.getVisibility() == View.VISIBLE) {
            if (handleNativeSeekBarKey(e)) return true;
            if (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) {
                View current = getCurrentFocus();
                if (nativeCanSeekVod() && (current == nativeSeek || (nativeSeekDpadMode && !isNativeControl(current)))) {
                    if (e.getAction() == KeyEvent.ACTION_DOWN) {
                        nativeSeekBy(code == KeyEvent.KEYCODE_DPAD_RIGHT ? 30000 : -10000);
                    }
                    return true;
                }
                if (e.getAction() == KeyEvent.ACTION_DOWN) {
                    moveNativeControlFocus(code == KeyEvent.KEYCODE_DPAD_LEFT ? -1 : 1);
                }
                return true;
            }
            if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN) {
                if (e.getAction() == KeyEvent.ACTION_DOWN) {
                    if (code == KeyEvent.KEYCODE_DPAD_DOWN && isNativeControl(getCurrentFocus()) && openNativeEpisodeStrip()) return true;
                    moveNativeVerticalFocus(code == KeyEvent.KEYCODE_DPAD_UP ? -1 : 1);
                }
                return true;
            }
            if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) {
                if (e.getAction() == KeyEvent.ACTION_UP && clickNativeControlFocus()) return true;
                return true;
            }
        }
        if (e.getAction() != KeyEvent.ACTION_DOWN) {
            return code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN
                    || code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT
                    || code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER;
        }
        if (code == KeyEvent.KEYCODE_DPAD_UP) return focusNativeSeekControl();
        if ((code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT)
                && nativeCanSeekVod()) {
            nativeSeekDpadMode = true;
            nativeSeekBy(code == KeyEvent.KEYCODE_DPAD_RIGHT ? 30000 : -10000);
            return true;
        }
        if (code == KeyEvent.KEYCODE_DPAD_DOWN) {
            if (nativeSeekDpadMode && nativeCanSeekVod()) return focusNativeDefaultControl();
            if (openNativeEpisodeStrip()) return true;
            showNativeChrome(true);
            return true;
        }
        if (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) {
            showNativeChrome(true);
            return true;
        }
        if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) {
            showNativeChrome(true);
            return true;
        }
        return false;
    }

    private boolean handleNativeSheetKey(KeyEvent e) {
        if (!nativeSheetOpen()) return false;
        int code = e.getKeyCode();
        if (code != KeyEvent.KEYCODE_DPAD_UP && code != KeyEvent.KEYCODE_DPAD_DOWN
                && code != KeyEvent.KEYCODE_DPAD_LEFT && code != KeyEvent.KEYCODE_DPAD_RIGHT
                && code != KeyEvent.KEYCODE_DPAD_CENTER && code != KeyEvent.KEYCODE_ENTER) return false;
        java.util.ArrayList<View> rows = nativeSheetFocusableRows();
        if (rows.isEmpty()) return true;
        int cur = rows.indexOf(getCurrentFocus());
        if (cur < 0) {
            cur = 0;
            focusNativeSheetRow(rows, cur);
        }
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN) {
                int next = code == KeyEvent.KEYCODE_DPAD_UP ? Math.max(0, cur - 1) : Math.min(rows.size() - 1, cur + 1);
                focusNativeSheetRow(rows, next);
            }
            return true;
        }
        if ((code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER)
                && e.getAction() == KeyEvent.ACTION_UP) {
            rows.get(cur).performClick();
        }
        return true;
    }

    private String fmtNative(long seconds) {
        seconds = Math.max(0, seconds);
        long h = seconds / 3600;
        long m = (seconds % 3600) / 60;
        long s = seconds % 60;
        if (h > 0) return h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
        return m + ":" + (s < 10 ? "0" : "") + s;
    }

    private String fmtNativeClock(long whenMs) {
        return new SimpleDateFormat("h:mm a", Locale.US).format(new Date(whenMs));
    }

    private int nativeSupportedTrackCount(int trackType) {
        if (nativePlayer == null) return 0;
        int count = 0;
        for (Tracks.Group group : nativePlayer.getCurrentTracks().getGroups()) {
            if (group.getType() != trackType) continue;
            for (int i = 0; i < group.length; i++) {
                if (!group.isTrackSupported(i)) continue;
                if (trackType == C.TRACK_TYPE_TEXT && !nativeIsWyzieTrack(group.getTrackFormat(i))) continue;
                count++;
            }
        }
        return count;
    }

    private boolean nativeSubtitleHasOptions() {
        return !nativeSubtitleRel.isEmpty()
                || !nativeSubtitleChoiceRels.isEmpty()
                || nativeSupportedTrackCount(C.TRACK_TYPE_TEXT) > 0;
    }

    private boolean nativeAudioHasOptions() {
        return nativeSupportedTrackCount(C.TRACK_TYPE_AUDIO) > 1;
    }

    private void updateNativeVideoDuration(String seconds) {
        if (nativePlayer == null || !"video".equals(nativeMode)) return;
        try {
            double s = Double.parseDouble(seconds == null ? "0" : seconds);
            if (s <= 0 || Double.isNaN(s) || Double.isInfinite(s)) return;
            nativeKnownDurationMs = Math.max(nativeKnownDurationMs, Math.round(s * 1000));
            updateNativeChrome();
        } catch (Exception ignored) {
        }
    }

    // Show the native Cast button only for VOD when a Cast route is discoverable and we're not
    // already casting (while casting, local playback is stopped and the web OSD is the remote).
    private void updateNativeCastButton() {
        if (nativeCastBtn == null) return;
        runOnUiThread(() -> {
            if (nativeCastBtn == null) return;
            boolean show = castHasDevices && !castActive() && "video".equals(nativeMode) && nativePlayerOpen();
            nativeCastBtn.setVisibility(show ? View.VISIBLE : View.GONE);
        });
    }
    private void updateNativeChrome() {
        if (nativePlayer == null || nativeSeek == null || nativeTime == null) return;
        updateNativeCastButton();
        long pos = nativePosSeconds();
        long dur = nativeDurSeconds();
        boolean isLive = "live".equals(nativeMode);
        boolean canSeek = !isLive && nativeCanSeekVod();
        if (!nativeUserSeeking) {
            nativeSeek.setEnabled(canSeek);
            nativeSeek.setVisibility(isLive ? View.GONE : View.VISIBLE);
            nativeSeek.setProgress(!isLive && dur > 0 ? (int) Math.min(1000, Math.max(0, (pos * 1000) / dur)) : 0);
        }
        boolean isVideo = "video".equals(nativeMode);
        if (nativeGuideBtn != null) nativeGuideBtn.setVisibility(View.VISIBLE);
        if (nativeRewBtn != null) nativeRewBtn.setVisibility(isLive ? View.GONE : View.VISIBLE);
        if (nativeFwdBtn != null) nativeFwdBtn.setVisibility(isLive ? View.GONE : View.VISIBLE);
        // Live IPTV has no CC/audio/quality/next-episode choices — hide them entirely (the owner's
        // "no need to show sound/HD on the IPTV player"); they return for movies/episodes.
        if (nativeCcBtn != null) nativeCcBtn.setVisibility(isLive ? View.GONE : View.VISIBLE);
        if (nativeAudioBtn != null) nativeAudioBtn.setVisibility(isLive ? View.GONE : View.VISIBLE);
        if (nativeQualityBtn != null) nativeQualityBtn.setVisibility(isLive ? View.GONE : View.VISIBLE);
        if (nativeNextBtn != null) nativeNextBtn.setVisibility(isLive ? View.GONE : View.VISIBLE);
        if (nativeFavBtn != null) nativeFavBtn.setVisibility(isLive ? View.VISIBLE : View.GONE);
        if (nativeLiveBtn != null) nativeLiveBtn.setVisibility(isLive ? View.VISIBLE : View.GONE);
        renderNativeEpgStrip(); // refresh the live EPG strip (now/next advances) — hides itself for video
        setNativeButtonEnabled(nativeStatsBtn, nativePlayer != null);
        setNativeButtonEnabled(nativeCcBtn, nativeSubtitleHasOptions());
        setNativeButtonEnabled(nativeAudioBtn, nativeAudioHasOptions());
        setNativeButtonEnabled(nativeQualityBtn, isVideo && nativeHasQualityChoices);
        setNativeButtonEnabled(nativeNextBtn, isVideo && nativeHasNext);
        if (isLive && nativeFavBtn != null) { setNativeButtonEnabled(nativeFavBtn, true); applyNativeFavIcon(); }
        if (nativeElapsed != null) {
            nativeElapsed.setText(isLive ? "" : fmtNative(pos));
            nativeElapsed.setVisibility(isLive ? View.GONE : View.VISIBLE);
        }
        nativeTime.setText(!isLive ? (dur > 0 ? fmtNative(dur) : "--:--") : "");
        nativeTime.setVisibility(isLive ? View.GONE : View.VISIBLE);
        long now = System.currentTimeMillis();
        if (nativeClock != null) nativeClock.setText(fmtNativeClock(now));
        if (nativeEndsAt != null) {
            if (!isLive && dur > 0 && pos <= dur) {
                nativeEndsAt.setText("Ends at " + fmtNativeClock(now + ((dur - pos) * 1000)));
                nativeEndsAt.setVisibility(View.VISIBLE);
            } else if (!isLive) {
                nativeEndsAt.setText("Ends at --:--");
                nativeEndsAt.setVisibility(View.VISIBLE);
            } else {
                nativeEndsAt.setText("");
                nativeEndsAt.setVisibility(View.GONE);
            }
        }
        if (nativePlayBtn != null) {
            int icon = nativePlayer.isPlaying()
                    ? R.drawable.ic_player_pause
                    : R.drawable.ic_player_play;
            nativePlayBtn.setTag(icon);
            nativePlayBtn.setContentDescription(nativePlayer.isPlaying() ? "Pause" : "Play");
            setNativeButtonIcon(nativePlayBtn, icon, true, nativePlayBtn.hasFocus());
        }
    }

    private DefaultRenderersFactory nativeRenderersFactory() {
        return new DefaultRenderersFactory(this)
                .setEnableDecoderFallback(true)
                .setEnableAudioOutputPlaybackParameters(true);
    }

    private DefaultBandwidthMeter nativeBandwidthMeterForMode(String mode) {
        boolean conservative = nativeConservativePlaybackDevice();
        long estimate = "live".equals(mode)
                ? (conservative ? 5_000_000L : 12_000_000L)
                : (conservative ? 22_000_000L : 80_000_000L);
        nativeBandwidthMeter = new DefaultBandwidthMeter.Builder(this)
                .setInitialBitrateEstimate(estimate)
                .build();
        return nativeBandwidthMeter;
    }

    private void applyNativeTrackSelectionDefaults(boolean isLiveMode) {
        if (nativePlayer == null) return;
        androidx.media3.common.TrackSelectionParameters.Builder params =
                nativePlayer.getTrackSelectionParameters().buildUpon()
                        .setPreferredAudioLanguages("en")
                        .setViewportSizeToPhysicalDisplaySize(true);
        if (isLiveMode && nativeConservativePlaybackDevice()) {
            params.setMaxVideoSize(1920, 1080)
                    .setMaxVideoBitrate(10_000_000);
        } else {
            params.clearVideoSizeConstraints();
        }
        if (!isLiveMode && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            params.setAudioOffloadPreferences(
                    new androidx.media3.common.TrackSelectionParameters.AudioOffloadPreferences.Builder()
                            .setAudioOffloadMode(androidx.media3.common.TrackSelectionParameters.AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED)
                            .build());
        }
        nativePlayer.setTrackSelectionParameters(params.build());
    }

    private MediaItem buildNativeMediaItem() {
        MediaItem.Builder media = new MediaItem.Builder().setUri(nativeUrl);
        if ("application/x-mpegURL".equals(nativeMime)) media.setMimeType(MimeTypes.APPLICATION_M3U8);
        else if ("video/mp2t".equals(nativeMime)) media.setMimeType(MimeTypes.VIDEO_MP2T);
        else if ("video/mp4".equals(nativeMime)) media.setMimeType(MimeTypes.VIDEO_MP4);
        if ("live".equals(nativeMode)) {
            media.setLiveConfiguration(new MediaItem.LiveConfiguration.Builder()
                    .setTargetOffsetMs(nativeConservativePlaybackDevice() ? 8000L : 5000L)
                    .setMinOffsetMs(2500L)
                    .setMaxOffsetMs(nativeConservativePlaybackDevice() ? 18000L : 14000L)
                    .setMinPlaybackSpeed(0.97f)
                    .setMaxPlaybackSpeed(1.03f)
                    .build());
        }
        return media.build();
    }

    private DefaultMediaSourceFactory nativeMediaSourceFactory() {
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(false)
                .setUserAgent("TriboonTV/" + BuildConfig.VERSION_NAME)
                .setConnectTimeoutMs(12000)
                // A piped remux/transcode stream is NON-resumable: if the socket read times out,
                // ExoPlayer reconnects and the server replays from the stream's start, so the position
                // jumps backward (then the guard in rememberNativeVideoPosition re-seeks to "now" — the
                // ~10-min dip the owner reported). A self-hosted usenet-mounted source can briefly stall
                // on provider-connection contention; a generous read timeout rides that out (playing
                // from the deep buffer meanwhile) instead of triggering a replay-from-start.
                .setReadTimeoutMs("live".equals(nativeMode)
                        ? NATIVE_LIVE_READ_TIMEOUT_MS
                        : (nativeLikelyHeavyVod() ? 45000 : 30000));
        nativeHttpDataSourceFactory = http;
        applyNativeHttpHostHeader();
        return new DefaultMediaSourceFactory(http);
    }

    private void applyNativeHttpHostHeader() {
        if (nativeHttpDataSourceFactory == null) return;
        java.util.HashMap<String, String> headers = new java.util.HashMap<>();
        if (hostHeaderSafe(nativeHostHeader)) headers.put("Host", nativeHostHeader);
        nativeHttpDataSourceFactory.setDefaultRequestProperties(headers);
    }

    private DefaultLoadControl nativeLoadControlForMode(String mode) {
        boolean conservative = nativeConservativePlaybackDevice();
        boolean video = "video".equals(mode);
        boolean heavyVod = video && nativeLikelyHeavyVod();
        int minMs = video ? (conservative ? (heavyVod ? 14000 : 5000) : (heavyVod ? 22000 : 5000)) : (conservative ? 8000 : 4000);
        int maxMs = video ? (conservative ? (heavyVod ? 75000 : 30000) : (heavyVod ? 120000 : 75000)) : 60000;
        int startMs = video ? (conservative ? (heavyVod ? 3500 : 1200) : (heavyVod ? 3500 : 900)) : (conservative ? 1800 : 700);
        int rebufferMs = video ? (conservative ? (heavyVod ? 7000 : 3000) : (heavyVod ? 8000 : 1800)) : (conservative ? 3500 : 1800);
        // Buffer the player holds is DERIVED from the owner's "read-ahead goal" (Settings →
        // Streaming performance) for THIS resolution: goalSec × the file's real bitrate, CLAMPED to
        // a safe share of THIS device's RAM. So a 300 s goal gives a deep buffer on a Shield while a
        // cheap box stays small — it scales with the setting AND the device instead of a hard-coded
        // constant. Falls back to a device-tier default when the goal/duration is unknown (older
        // server, live, or not-yet-probed). maxMs follows the same goal.
        int defTargetMb = video ? (conservative ? (heavyVod ? 72 : 24) : (heavyVod ? 384 : 96)) : (conservative ? 24 : 48);
        int targetMb = defTargetMb;
        if (video && nativeBufferGoalSec > 0) {
            int ceilMb = nativeBufferCeilingMb(conservative, heavyVod);
            int floorMb = conservative ? 24 : 48;
            if (nativePlaybackDurationSec > 0 && nativePlaybackSizeBytes > 0) {
                double bytesPerSec = nativePlaybackSizeBytes / nativePlaybackDurationSec;
                long goalMb = (long) (nativeBufferGoalSec * bytesPerSec / (1024.0 * 1024.0));
                targetMb = (int) Math.max(floorMb, Math.min(ceilMb, goalMb));
            } else {
                // Duration unknown — a first-time play (no watch row, server sends no duration) so
                // the exact size/duration bitrate isn't available yet. Estimate the byte budget from
                // a typical bitrate for this resolution tier so the deep buffer engages on the FIRST
                // play, not only on re-watches. ~48 Mbps 4K / ~13 Mbps 1080p / ~5 Mbps SD-ish.
                double estBytesPerSec = heavyVod ? 6.0 * 1024 * 1024 : (conservative ? 0.65 * 1024 * 1024 : 1.6 * 1024 * 1024);
                long goalMb = (long) (nativeBufferGoalSec * estBytesPerSec / (1024.0 * 1024.0));
                targetMb = (int) Math.max(floorMb, Math.min(ceilMb, Math.max(defTargetMb, goalMb)));
            }
            maxMs = (int) Math.max(30000L, Math.min(conservative ? 120000L : 300000L, nativeBufferGoalSec * 1000L));
        }
        int targetBytes = (int) Math.min(Integer.MAX_VALUE, (long) targetMb * 1024 * 1024); // long math: no overflow if a future tier raises the ceiling past 2047MB
        int backBufferMs = video ? (conservative ? (heavyVod ? 6000 : 3000) : (heavyVod ? 12000 : 8000)) : 3000;
        if (video) {
            Log.i(TAG, "Native VOD buffer profile quality=" + nativeQualityLabel
                    + " sizeMB=" + nativePlaybackSizeBytes / (1024 * 1024)
                    + " conservative=" + conservative
                    + " goalSec=" + nativeBufferGoalSec
                    + " targetMB=" + targetMb
                    + " maxMs=" + maxMs
                    + " backBufferMs=" + backBufferMs);
        }
        return new DefaultLoadControl.Builder()
                .setBufferDurationsMs(minMs, maxMs, startMs, rebufferMs)
                .setTargetBufferBytes(targetBytes)
                .setBackBuffer(backBufferMs, false)
                .setPrioritizeTimeOverSizeThresholds(true)
                .build();
    }

    // Safe upper bound for the on-device video buffer: ~22% of THIS device's RAM, capped per tier
    // so a setting like 300s deepens the buffer on a roomy box (Shield) but a cheap/low-RAM device
    // never over-commits memory. Pairs with the owner's read-ahead-goal setting in nativeLoadControl.
    private int nativeBufferCeilingMb(boolean conservative, boolean heavyVod) {
        long totalRamMb = 2048;
        try {
            android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
            if (am != null) {
                android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
                am.getMemoryInfo(mi);
                if (mi.totalMem > 0) totalRamMb = mi.totalMem / (1024 * 1024);
            }
        } catch (Exception ignored) { }
        long byRam = totalRamMb * 22 / 100;
        int tierCap = conservative ? (heavyVod ? 96 : 48) : (heavyVod ? 768 : 256);
        int floor = conservative ? 48 : 96;
        return (int) Math.max(floor, Math.min(tierCap, byRam));
    }

    private boolean nativeLikelyHeavyVod() {
        if (nativePlaybackSizeBytes >= 18L * 1024L * 1024L * 1024L) return true;
        String label = nativeQualityLabel == null ? "" : nativeQualityLabel.toLowerCase(Locale.US);
        return label.contains("2160") || label.contains("4k") || label.contains("uhd");
    }

    private void addNativeFallback(String url, String mime, String primaryUrl, String hostHeader) {
        String u = url == null ? "" : url.trim();
        if (u.isEmpty() || u.equals(primaryUrl)) return;
        for (String existing : nativeFallbackUrls) {
            if (u.equals(existing)) return;
        }
        nativeFallbackUrls.add(u);
        nativeFallbackMimes.add(mime == null ? "" : mime.trim());
        nativeFallbackHostHeaders.add(hostHeaderSafe(hostHeader) ? hostHeader.trim() : "");
    }

    private String nativePlaybackErrorMessage(PlaybackException error) {
        if (error == null) return "playback failed";
        Throwable t = error;
        while (t != null) {
            if (t instanceof HttpDataSource.InvalidResponseCodeException) {
                HttpDataSource.InvalidResponseCodeException http =
                        (HttpDataSource.InvalidResponseCodeException) t;
                String reason = nativeHeader(http.headerFields, "x-triboon-iptv-error");
                if (reason == null || reason.trim().isEmpty()) {
                    reason = http.responseCode == 401 || http.responseCode == 403
                            ? "provider rejected this channel"
                            : "live stream unavailable";
                }
                return reason + " (HTTP " + http.responseCode + ")";
            }
            t = t.getCause();
        }
        String name = error.getErrorCodeName();
        return name == null || name.isEmpty() ? "playback failed" : name;
    }

    private String nativeHeader(Map<String, List<String>> headers, String wanted) {
        if (headers == null || wanted == null) return "";
        for (Map.Entry<String, List<String>> e : headers.entrySet()) {
            if (e.getKey() == null || !wanted.equalsIgnoreCase(e.getKey())) continue;
            List<String> vals = e.getValue();
            if (vals != null && !vals.isEmpty() && vals.get(0) != null) return vals.get(0);
        }
        return "";
    }

    private boolean tryNativeLiveFallback() {
        if (!"live".equals(nativeMode) || nativePlayer == null) return false;
        if (nativeFallbackIndex >= nativeFallbackUrls.size()) return false;
        String nextUrl = nativeFallbackUrls.get(nativeFallbackIndex);
        String nextMime = nativeFallbackIndex < nativeFallbackMimes.size()
                ? nativeFallbackMimes.get(nativeFallbackIndex) : "";
        String nextHostHeader = nativeFallbackIndex < nativeFallbackHostHeaders.size()
                ? nativeFallbackHostHeaders.get(nativeFallbackIndex) : "";
        nativeFallbackIndex++;
        nativeTriedFallback = true;
        nativeUrl = nextUrl;
        nativeHostHeader = hostHeaderSafe(nextHostHeader) ? nextHostHeader : "";
        nativeMime = nextMime == null ? "" : nextMime;
        nativeQualityLabel = "LIVE";
        nativeLiveUnhealthySinceMs = 0L;
        nativeLiveStarted = false;
        nativeLiveLastRecoveryMs = SystemClock.elapsedRealtime();
        Log.w(TAG, "Live playback switching to fallback " + nativeFallbackIndex + "/" + nativeFallbackUrls.size());
        nativePlayer.stop();
        nativePlayer.clearMediaItems();
        applyNativeHttpHostHeader();
        if (nativePlayerBadge != null) nativePlayerBadge.setText("LIVE");
        if (nativeChromeQuality != null) nativeChromeQuality.setText("LIVE");
        nativePlayer.setMediaItem(buildNativeMediaItem());
        nativePlayer.prepare();
        nativePlayer.play();
        return true;
    }

    private void recoverNativeLivePlayback(String reason) {
        if (!"live".equals(nativeMode) || nativePlayer == null || nativeUrl == null || nativeUrl.isEmpty()) return;
        long now = SystemClock.elapsedRealtime();
        if (now - nativeLiveLastRecoveryMs < NATIVE_LIVE_RECOVERY_COOLDOWN_MS) return;
        if (tryNativeLiveFallback()) return;
        nativeLiveLastRecoveryMs = now;
        nativeLiveUnhealthySinceMs = 0L;
        nativePlayer.stop();
        nativePlayer.clearMediaItems();
        nativePlayer.setMediaItem(buildNativeMediaItem());
        nativePlayer.prepare();
        nativePlayer.play();
    }

    private void notifyNativeVideoError(String msg, long pos, long dur) {
        if (nativeVideoErrorNotified) return;
        nativeVideoErrorNotified = true;
        String title = nativePlaybackTitle;
        String backdropUrl = nativePlaybackBackdropUrl;
        String kind = nativeKind;
        String quality = nativeQualityLabel;
        long startOffsetMs = nativeStartOffsetMs;
        long safePos = safeNativeVideoPosSeconds(pos);
        releaseNativePlayer(false);
        enterNativeFullscreenMode();
        showNativeLoading(title, backdropUrl);
        web.evaluateJavascript("window.__tvNativeVideoError && __tvNativeVideoError("
                + org.json.JSONObject.quote(msg == null || msg.isEmpty() ? "native startup stalled" : msg)
                + "," + safePos + "," + dur + ")", null);
    }

    private float nativeShiftFromUrl(String url) {
        try {
            String shift = Uri.parse(url).getQueryParameter("shift");
            return shift == null ? 0f : Float.parseFloat(shift);
        } catch (Exception e) {
            return 0f;
        }
    }

    private void loadNativeSubtitleOverlay(String url) {
        final String cleanUrl = stripNativeQueryParam(url, "shift");
        final int token = ++nativeSubtitleLoadToken;
        nativeSubtitleCues.clear();
        if (nativeSubtitleOverlay != null) {
            nativeSubtitleOverlay.setText("");
            nativeSubtitleOverlay.setVisibility(View.GONE);
        }
        if (cleanUrl.isEmpty()) return;
        final ValidatedNativeUrl subtitleUrl;
        try {
            subtitleUrl = validateNativeSubtitleOverlayUrl(cleanUrl, nativeSubtitleHostHeader);
        } catch (Exception e) {
            Log.w(TAG, "Subtitles could not load: " + redactNativeLogMessage(e.getMessage()));
            clearNativeSubtitleOverlay();
            Toast.makeText(this, "Subtitles could not load", Toast.LENGTH_SHORT).show();
            return;
        }
        final String fetchUrl = subtitleUrl.connectUrl;
        final String hostHeader = hostHeaderSafe(subtitleUrl.hostHeader) ? subtitleUrl.hostHeader : "";
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(fetchUrl).openConnection();
                c.setConnectTimeout(7000);
                c.setReadTimeout(nativeSubtitleReadTimeoutMs(cleanUrl));
                c.setRequestProperty("Accept", "text/vtt,text/plain,*/*");
                if (hostHeaderSafe(hostHeader)) {
                    c.setRequestProperty("Host", hostHeader);
                }
                int status = c.getResponseCode();
                String body;
                try {
                    body = readNativeSubtitleResponse(c, status >= 400);
                    if (status >= 400) {
                        throw new java.io.IOException("subtitle HTTP " + status + ": " + subtitleErrorSnippet(body));
                    }
                } finally {
                    try { c.disconnect(); } catch (Exception ignored) {}
                }
                java.util.ArrayList<NativeCue> cues = parseNativeVtt(body);
                runOnUiThread(() -> {
                    if (token != nativeSubtitleLoadToken) return;
                    nativeSubtitleCues.clear();
                    nativeSubtitleCues.addAll(cues);
                    nativeSubtitleHandler.removeCallbacks(nativeSubtitleTick);
                    updateNativeSubtitleOverlay();
                    if (!nativeSubtitleCues.isEmpty()) nativeSubtitleHandler.postDelayed(nativeSubtitleTick, 250);
                });
            } catch (Exception e) {
                Log.w(TAG, "Subtitles could not load: " + redactNativeLogMessage(e.getMessage()));
                runOnUiThread(() -> {
                    if (token != nativeSubtitleLoadToken) return;
                    clearNativeSubtitleOverlay();
                    Toast.makeText(this, "Subtitles could not load", Toast.LENGTH_SHORT).show();
                });
            }
        }, "triboon-subtitles").start();
    }

    private int nativeSubtitleReadTimeoutMs(String url) {
        String raw = url == null ? "" : url;
        return raw.contains("/api/subtitle/") ? 135000 : 20000;
    }

    private String readNativeSubtitleResponse(HttpURLConnection c, boolean errorStream) throws java.io.IOException {
        StringBuilder sb = new StringBuilder();
        java.io.InputStream in = errorStream ? c.getErrorStream() : c.getInputStream();
        if (in == null) return "";
        try (java.io.BufferedReader br = new java.io.BufferedReader(
                new java.io.InputStreamReader(in, java.nio.charset.StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                if (sb.length() < 4 * 1024 * 1024) sb.append(line).append('\n');
            }
        }
        return sb.toString();
    }

    private String subtitleErrorSnippet(String body) {
        String s = String.valueOf(body == null ? "" : body).replaceAll("\\s+", " ").trim();
        if (s.length() > 180) s = s.substring(0, 180);
        return redactNativeLogMessage(s);
    }

    private String redactNativeLogMessage(String msg) {
        return String.valueOf(msg == null ? "" : msg)
                .replaceAll("(?i)([?&](?:t|key|token|apikey|api_key|password|pass)=)[^&\\s]+", "$1[redacted]");
    }

    private void clearNativeSubtitleOverlay() {
        nativeSubtitleLoadToken++;
        nativeSubtitleHandler.removeCallbacks(nativeSubtitleTick);
        nativeSubtitleCues.clear();
        if (nativeSubtitleOverlay != null) {
            nativeSubtitleOverlay.setText("");
            nativeSubtitleOverlay.setVisibility(View.GONE);
        }
    }

    private void updateNativeSubtitleOverlay() {
        if (nativeSubtitleOverlay == null) return;
        if (nativePlayer == null || nativeGuideMode || !"video".equals(nativeMode)
                || !nativeHasWyzieSubtitle || nativeSubtitleCues.isEmpty()) {
            nativeSubtitleOverlay.setText("");
            nativeSubtitleOverlay.setVisibility(View.GONE);
            return;
        }
        double t = Math.max(0, nativeDisplayPositionMs() / 1000.0 - nativeSubtitleShift);
        StringBuilder active = new StringBuilder();
        for (NativeCue cue : nativeSubtitleCues) {
            if (t + 0.05 < cue.start) {
                if (active.length() > 0) break;
                continue;
            }
            if (t <= cue.end + 0.05) {
                if (active.length() > 0) active.append('\n');
                active.append(cue.text);
            }
        }
        String text = active.toString().trim();
        nativeSubtitleOverlay.setText(text);
        nativeSubtitleOverlay.setVisibility(text.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private java.util.ArrayList<NativeCue> parseNativeVtt(String vtt) {
        java.util.ArrayList<NativeCue> cues = new java.util.ArrayList<>();
        if (vtt == null || vtt.isEmpty()) return cues;
        String[] lines = vtt.replace("\r\n", "\n").replace('\r', '\n').split("\n");
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            if (line.isEmpty() || line.equalsIgnoreCase("WEBVTT") || line.startsWith("NOTE")
                    || line.startsWith("STYLE") || line.startsWith("REGION")) continue;
            if (!line.contains("-->") && i + 1 < lines.length && lines[i + 1].contains("-->")) {
                line = lines[++i].trim();
            }
            if (!line.contains("-->")) continue;
            String[] parts = line.split("-->", 2);
            double start = parseNativeVttTime(parts[0].trim());
            double end = parseNativeVttTime(parts[1].trim().split("\\s+", 2)[0]);
            if (end <= start) continue;
            StringBuilder text = new StringBuilder();
            while (i + 1 < lines.length && !lines[i + 1].trim().isEmpty()) {
                String t = cleanNativeCueText(lines[++i].trim());
                if (t.isEmpty()) continue;
                if (text.length() > 0) text.append('\n');
                text.append(t);
            }
            if (text.length() > 0) cues.add(new NativeCue(start, end, text.toString()));
        }
        return cues;
    }

    private double parseNativeVttTime(String s) {
        try {
            String[] parts = s.replace(',', '.').split(":");
            double sec = Double.parseDouble(parts[parts.length - 1]);
            double min = parts.length >= 2 ? Double.parseDouble(parts[parts.length - 2]) : 0;
            double hour = parts.length >= 3 ? Double.parseDouble(parts[parts.length - 3]) : 0;
            return hour * 3600 + min * 60 + sec;
        } catch (Exception e) {
            return 0;
        }
    }

    private String cleanNativeCueText(String s) {
        return s.replaceAll("<[^>]+>", "")
                .replace("&nbsp;", " ")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .trim();
    }

    private String stripNativeQueryParam(String url, String key) {
        if (url == null || url.isEmpty()) return "";
        try {
            Uri u = Uri.parse(url);
            Uri.Builder b = u.buildUpon().clearQuery();
            for (String name : u.getQueryParameterNames()) {
                if (key.equals(name)) continue;
                for (String value : u.getQueryParameters(name)) b.appendQueryParameter(name, value);
            }
            return b.build().toString();
        } catch (Exception e) {
            return url;
        }
    }

    private String nativeSubShiftLabel() {
        return Math.abs(nativeSubtitleShift) < 0.05f
                ? ""
                : String.format(Locale.US, " (%+.1fs)", nativeSubtitleShift);
    }

    private void shiftNativeSubtitles(float delta) {
        if (nativePlayer == null || !nativeHasWyzieSubtitle || nativeSubtitleUrl.isEmpty()) {
            Toast.makeText(this, "Turn subtitles on first", Toast.LENGTH_SHORT).show();
            return;
        }
        nativeSubtitleShift = Math.round((nativeSubtitleShift + delta) * 10f) / 10f;
        applyNativeSubtitleShift();
    }

    private void resetNativeSubtitleShift() {
        if (nativePlayer == null) return;
        nativeSubtitleShift = 0f;
        applyNativeSubtitleShift();
    }

    private void applyNativeSubtitleShift() {
        if (nativePlayer == null) return;
        updateNativeSubtitleOverlay();
        web.evaluateJavascript("window.__tvNativeSubtitleShift && window.__tvNativeSubtitleShift("
                + String.format(Locale.US, "%.1f", nativeSubtitleShift) + ")", null);
        showNativeTrackMenu(C.TRACK_TYPE_TEXT);
    }

    private void clearNativeSubtitleChoices() {
        nativeSubtitleChoiceRels.clear();
        nativeSubtitleChoiceLabels.clear();
        nativeSubtitleChoiceActions.clear();
        nativeSubtitleChoiceLangs.clear();
        nativeSubtitleChoiceUrls.clear();
    }

    private void applyNativeSubtitleChoices(org.json.JSONArray subtitleChoices) {
        clearNativeSubtitleChoices();
        if (subtitleChoices == null) {
            updateNativeChrome();
            return;
        }
        java.util.HashSet<String> seen = new java.util.HashSet<>();
        for (int i = 0; i < subtitleChoices.length(); i++) {
            org.json.JSONObject choice = subtitleChoices.optJSONObject(i);
            if (choice == null) continue;
            String rel = choice.optString("rel", "");
            String action = choice.optString("action", "");
            String lang = choice.optString("lang", "");
            String url = choice.optString("url", "");
            if (rel.isEmpty() && action.isEmpty()) continue;
            String key = rel.isEmpty() ? action + ":" + lang : "rel:" + rel;
            if (seen.contains(key)) continue;
            seen.add(key);
            String label = choice.optString("label", "");
            nativeSubtitleChoiceRels.add(rel);
            nativeSubtitleChoiceLabels.add(label.isEmpty() && !rel.isEmpty() ? nativeLabelForSubtitleRel(rel) : label);
            nativeSubtitleChoiceActions.add(action);
            nativeSubtitleChoiceLangs.add(lang);
            nativeSubtitleChoiceUrls.add(url);
        }
        updateNativeChrome();
    }

    private void updateNativeSubtitleChoices(String json) {
        try {
            Object parsed = new org.json.JSONTokener(json == null ? "{}" : json).nextValue();
            org.json.JSONArray choices = null;
            if (parsed instanceof org.json.JSONArray) {
                choices = (org.json.JSONArray) parsed;
            } else if (parsed instanceof org.json.JSONObject) {
                org.json.JSONObject obj = (org.json.JSONObject) parsed;
                choices = obj.optJSONArray("choices");
                if (choices == null) choices = obj.optJSONArray("subtitleChoices");
            }
            applyNativeSubtitleChoices(choices);
            if (nativeOpenSubtitleMenuAfterRefresh && nativePlayer != null && "video".equals(nativeMode)) {
                nativeOpenSubtitleMenuAfterRefresh = false;
                showNativeTrackMenu(C.TRACK_TYPE_TEXT);
            } else {
                nativeOpenSubtitleMenuAfterRefresh = false;
            }
        } catch (Exception e) {
            nativeOpenSubtitleMenuAfterRefresh = false;
            Toast.makeText(this, "Could not load subtitle versions", Toast.LENGTH_SHORT).show();
        }
    }

    private void updateNativeActiveSubtitle(String json) {
        if (nativePlayer == null || !"video".equals(nativeMode)) return;
        try {
            org.json.JSONObject j = new org.json.JSONObject(json == null ? "{}" : json);
            org.json.JSONArray choices = j.optJSONArray("subtitleChoices");
            if (choices != null) applyNativeSubtitleChoices(choices);
            String rel = j.optString("subtitleRel", "");
            String subtitleUrl = j.optString("subtitleUrl", "");
            if (rel.isEmpty() || subtitleUrl.isEmpty()) return;
            nativeSubtitleShift = (float) j.optDouble("subtitleShift", nativeShiftFromUrl(subtitleUrl));
            String cleanSubtitleUrl = stripNativeQueryParam(subtitleUrl, "shift");
            ValidatedNativeUrl subtitlePin = cleanSubtitleUrl.isEmpty() ? null : validateNativePlaybackUrl(cleanSubtitleUrl);
            if (subtitlePin == null) return;
            nativeSubtitleRel = rel;
            nativeSubtitleUrl = subtitlePin.connectUrl;
            nativeSubtitleHostHeader = subtitlePin.hostHeader;
            nativeSubtitleLang = j.optString("subtitleLang", nativeLangFromSubtitleRel(rel));
            nativeSubtitleLabel = j.optString("subtitleLabel", "");
            if (nativeSubtitleLabel.isEmpty()) {
                nativeSubtitleLabel = !nativeSubtitleLang.isEmpty() ? nativeLangName(nativeSubtitleLang) : "Subtitles";
            }
            nativeHasWyzieSubtitle = true;
            disableNativeTextTracks();
            loadNativeSubtitleOverlay(nativeSubtitleUrl);
            updateNativeChrome();
        } catch (Exception e) {
            Log.w(TAG, "Subtitles could not load: " + redactNativeLogMessage(e.getMessage()));
        }
    }

    private void clearNativeEpisodes() {
        nativeEpisodes.clear();
        nativeEpisodeIndex = 0;
        nativeEpisodeStripOpen = false;
        nativeEpisodeScrollAtMs = 0L;
        if (nativeEpisodeStrip != null) {
            nativeEpisodeStrip.animate().cancel();
            nativeEpisodeStrip.setAlpha(1f);
            nativeEpisodeStrip.setTranslationY(0f);
            nativeEpisodeStrip.setVisibility(View.GONE);
        }
        if (nativeEpisodeList != null) nativeEpisodeList.removeAllViews();
    }

    private void updateNativeEpisodeChoices(String json) {
        try {
            Object parsed = new org.json.JSONTokener(json == null ? "{}" : json).nextValue();
            org.json.JSONArray episodes = null;
            int focusIndex = -1;
            if (parsed instanceof org.json.JSONArray) {
                episodes = (org.json.JSONArray) parsed;
            } else if (parsed instanceof org.json.JSONObject) {
                org.json.JSONObject obj = (org.json.JSONObject) parsed;
                episodes = obj.optJSONArray("episodes");
                focusIndex = obj.optInt("focusIndex", -1);
            }
            nativeEpisodes.clear();
            nativeEpisodeIndex = 0;
            if (episodes != null) {
                for (int i = 0; i < episodes.length(); i++) {
                    org.json.JSONObject ep = episodes.optJSONObject(i);
                    if (ep == null) continue;
                    NativeEpisode item = new NativeEpisode(
                            ep.optInt("index", i),
                            ep.optString("tag", ""),
                            ep.optString("name", ""),
                            ep.optString("still", ""),
                            ep.optBoolean("current", false),
                            ep.optBoolean("watched", false));
                    if (item.current) nativeEpisodeIndex = nativeEpisodes.size();
                    nativeEpisodes.add(item);
                }
            }
            if (focusIndex >= 0 && focusIndex < nativeEpisodes.size()) nativeEpisodeIndex = focusIndex;
            renderNativeEpisodeStrip(false);
        } catch (Exception ignored) {
            clearNativeEpisodes();
        }
    }

    private GradientDrawable nativeEpisodeCardBg(boolean focused, boolean current) {
        GradientDrawable d = new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0x00000000, 0x00000000});
        d.setCornerRadius(dp(16));
        return d;
    }

    private GradientDrawable nativeEpisodeStillFrame(boolean focused, boolean current) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.RECTANGLE);
        d.setColor(0x00000000);
        d.setCornerRadius(dp(12));
        if (focused || current) d.setStroke(dp(1), focused ? 0x88C6B37A : 0x66C6B37A);
        return d;
    }

    private void animateNativeEpisodeStripIn() {
        if (nativeEpisodeStrip == null) return;
        nativeEpisodeStrip.animate().cancel();
        nativeEpisodeStrip.setVisibility(View.VISIBLE);
        nativeEpisodeStrip.setAlpha(0f);
        nativeEpisodeStrip.setTranslationY(dp(24));
        nativeEpisodeStrip.animate()
                .alpha(1f)
                .translationY(0f)
                .setDuration(190)
                .start();
    }

    private void animateNativeEpisodeStripOut() {
        if (nativeEpisodeStrip == null) return;
        nativeEpisodeStrip.animate().cancel();
        nativeEpisodeStrip.animate()
                .alpha(0f)
                .translationY(dp(18))
                .setDuration(120)
                .withEndAction(() -> {
                    if (!nativeEpisodeStripOpen && nativeEpisodeStrip != null) {
                        nativeEpisodeStrip.setVisibility(View.GONE);
                        nativeEpisodeStrip.setAlpha(1f);
                        nativeEpisodeStrip.setTranslationY(0f);
                    }
                })
                .start();
    }

    private void loadNativeEpisodeStill(ImageView view, String url) {
        if (url == null || url.isEmpty()) return;
        new Thread(() -> {
            Bitmap bm = null;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(4500);
                c.setReadTimeout(6000);
                c.setInstanceFollowRedirects(true);
                c.setRequestProperty("Accept", "image/*,*/*");
                // Downsample to RGB_565 + cap bytes (mirrors the backdrop loader). The old path
                // decoded each still at full-res ARGB_8888 and never disconnected the socket — a
                // season strip could spike heap by tens of MB and leak keep-alive connections.
                bm = decodeNativeBackdrop(readLimitedBytes(c.getInputStream(), NATIVE_BACKDROP_MAX_BYTES));
            } catch (Exception ignored) {
            } finally {
                if (c != null) try { c.disconnect(); } catch (Exception ignored2) {}
            }
            final Bitmap finalBm = bm;
            if (finalBm != null) runOnUiThread(() -> {
                if (nativePlayerOpen()) view.setImageBitmap(finalBm);
            });
        }, "TriboonNativeStill").start();
    }

    private void scrollNativeEpisodeIntoView(View child) {
        if (nativeEpisodeStrip == null || child == null) return;
        int target = Math.max(0, child.getLeft() - dp(60));
        if (Math.abs(nativeEpisodeStrip.getScrollX() - target) < dp(4)) return;
        long now = SystemClock.elapsedRealtime();
        if (now - nativeEpisodeScrollAtMs < 140) {
            nativeEpisodeStrip.scrollTo(target, 0);
        } else {
            nativeEpisodeStrip.smoothScrollTo(target, 0);
        }
        nativeEpisodeScrollAtMs = now;
    }

    private void renderNativeEpisodeStrip(boolean open) {
        if (nativeEpisodeStrip == null || nativeEpisodeList == null) return;
        nativeEpisodeList.removeAllViews();
        boolean wasOpen = nativeEpisodeStripOpen;
        nativeEpisodeStripOpen = open && "video".equals(nativeMode) && nativeEpisodes.size() > 0;
        if (nativeEpisodeStripOpen) {
            nativeEpisodeStrip.setVisibility(View.VISIBLE);
        } else {
            nativeEpisodeStrip.animate().cancel();
            nativeEpisodeStrip.setAlpha(1f);
            nativeEpisodeStrip.setTranslationY(0f);
            nativeEpisodeStrip.setVisibility(View.GONE);
        }
        if (nativeEpisodes.isEmpty()) return;
        for (int i = 0; i < nativeEpisodes.size(); i++) {
            NativeEpisode ep = nativeEpisodes.get(i);
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setFocusable(true);
            card.setFocusableInTouchMode(true);
            card.setClickable(true);
            card.setClipChildren(false);
            card.setClipToPadding(false);
            card.setPadding(dp(2), dp(2), dp(2), dp(2));
            card.setBackground(nativeEpisodeCardBg(i == nativeEpisodeIndex && nativeEpisodeStripOpen, ep.current));
            card.setElevation(0);
            card.setOnKeyListener((v, code, e) -> handleNativeSurfaceKey(e));
            final int idx = i;
            card.setOnFocusChangeListener((v, hasFocus) -> {
                v.animate().cancel();
                if (hasFocus) {
                    nativeEpisodeIndex = idx;
                    showNativeChrome(false);
                    v.setBackground(nativeEpisodeCardBg(true, nativeEpisodes.get(idx).current));
                    ImageView focusedStill = v.findViewWithTag("nativeEpisodeStill");
                    if (focusedStill != null) focusedStill.setForeground(nativeEpisodeStillFrame(true, nativeEpisodes.get(idx).current));
                    v.setElevation(0);
                    v.animate().translationY(-dp(3)).setDuration(120).start();
                    scrollNativeEpisodeIntoView(v);
                } else {
                    v.setBackground(nativeEpisodeCardBg(false, nativeEpisodes.get(idx).current));
                    ImageView blurredStill = v.findViewWithTag("nativeEpisodeStill");
                    if (blurredStill != null) blurredStill.setForeground(nativeEpisodeStillFrame(false, nativeEpisodes.get(idx).current));
                    v.setElevation(0);
                    v.animate().translationY(0f).setDuration(100).start();
                }
            });
            card.setOnClickListener(v -> chooseNativeEpisode(idx));

            ImageView still = new ImageView(this);
            still.setTag("nativeEpisodeStill");
            still.setScaleType(ImageView.ScaleType.CENTER_CROP);
            GradientDrawable stillBg = new GradientDrawable();
            stillBg.setColor(0xFF16101F);
            stillBg.setCornerRadius(dp(12));
            still.setBackground(stillBg);
            still.setForeground(nativeEpisodeStillFrame(i == nativeEpisodeIndex && nativeEpisodeStripOpen, ep.current));
            still.setClipToOutline(true);
            card.addView(still, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(126)));
            loadNativeEpisodeStill(still, ep.still);

            TextView label = new TextView(this);
            label.setText((ep.watched ? "WATCHED  " : "") + ep.tag);
            label.setSingleLine(true);
            label.setTextColor(0xEFFFCC67);
            label.setTextSize(10);
            label.setTypeface(Typeface.DEFAULT_BOLD);
            label.setPadding(dp(1), dp(7), dp(1), 0);
            card.addView(label, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

            TextView name = new TextView(this);
            name.setText(ep.name.isEmpty() ? "Episode " + (idx + 1) : ep.name);
            name.setMaxLines(2);
            name.setTextColor(0xFFF3EFF7);
            name.setTextSize(12);
            name.setTypeface(Typeface.DEFAULT_BOLD);
            name.setPadding(dp(1), dp(1), dp(1), 0);
            card.addView(name, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(236), dp(182));
            lp.setMargins(0, 0, dp(14), 0);
            nativeEpisodeList.addView(card, lp);
        }
        if (nativeEpisodeStripOpen) {
            focusNativeEpisode(nativeEpisodeIndex);
            if (!wasOpen) animateNativeEpisodeStripIn();
        }
    }

    private boolean openNativeEpisodeStrip() {
        if (!"video".equals(nativeMode) || nativeEpisodes.isEmpty() || nativeSheetOpen()) return false;
        showNativeChrome(false);
        renderNativeEpisodeStrip(true);
        return true;
    }

    private boolean closeNativeEpisodeStrip() {
        if (!nativeEpisodeStripOpen) return false;
        nativeEpisodeStripOpen = false;
        animateNativeEpisodeStripOut();
        focusNativeDefaultControl();
        return true;
    }

    private boolean focusNativeEpisode(int idx) {
        if (nativeEpisodeList == null || nativeEpisodeList.getChildCount() == 0) return false;
        nativeEpisodeIndex = Math.max(0, Math.min(nativeEpisodeList.getChildCount() - 1, idx));
        View child = nativeEpisodeList.getChildAt(nativeEpisodeIndex);
        if (child != null) {
            boolean alreadyFocused = child.hasFocus();
            child.requestFocus();
            if (alreadyFocused) scrollNativeEpisodeIntoView(child);
            return true;
        }
        return false;
    }

    private void chooseNativeEpisode(int idx) {
        if (idx < 0 || idx >= nativeEpisodes.size()) return;
        NativeEpisode ep = nativeEpisodes.get(idx);
        if (ep.current) {
            closeNativeEpisodeStrip();
            return;
        }
        web.evaluateJavascript("window.__tvNativeEpisodeSelect && window.__tvNativeEpisodeSelect("
                + ep.index + "," + nativePosSeconds() + "," + nativeDurSeconds() + ")", null);
    }

    private boolean handleNativeEpisodeStripKey(KeyEvent e) {
        if (!nativeEpisodeStripOpen) return false;
        int code = e.getKeyCode();
        if (code != KeyEvent.KEYCODE_DPAD_LEFT && code != KeyEvent.KEYCODE_DPAD_RIGHT
                && code != KeyEvent.KEYCODE_DPAD_UP && code != KeyEvent.KEYCODE_DPAD_DOWN
                && code != KeyEvent.KEYCODE_DPAD_CENTER && code != KeyEvent.KEYCODE_ENTER
                && code != KeyEvent.KEYCODE_BACK) return false;
        if (e.getAction() != KeyEvent.ACTION_DOWN) return true;
        if (code == KeyEvent.KEYCODE_DPAD_LEFT) return focusNativeEpisode(nativeEpisodeIndex - 1);
        if (code == KeyEvent.KEYCODE_DPAD_RIGHT) return focusNativeEpisode(nativeEpisodeIndex + 1);
        if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_BACK) return closeNativeEpisodeStrip();
        if (code == KeyEvent.KEYCODE_DPAD_DOWN) return focusNativeEpisode(nativeEpisodeIndex);
        chooseNativeEpisode(nativeEpisodeIndex);
        return true;
    }

    private interface NativeChoiceHandler {
        void choose(int index);
    }

    private static final class NativeCue {
        final double start;
        final double end;
        final String text;
        NativeCue(double start, double end, String text) {
            this.start = start;
            this.end = end;
            this.text = text;
        }
    }

    private static final class NativeEpisode {
        final int index;
        final String tag;
        final String name;
        final String still;
        final boolean current;
        final boolean watched;
        NativeEpisode(int index, String tag, String name, String still, boolean current, boolean watched) {
            this.index = index;
            this.tag = tag == null ? "" : tag;
            this.name = name == null ? "" : name;
            this.still = still == null ? "" : still;
            this.current = current;
            this.watched = watched;
        }
    }

    private static final class NativeTrackChoice {
        final Tracks.Group group;
        final int index;
        final String label;
        final boolean off;
        final boolean selected;
        final String subtitleRel;
        final String subtitleAction;
        final String subtitleLang;

        NativeTrackChoice(Tracks.Group group, int index, String label, boolean off, boolean selected) {
            this(group, index, label, off, selected, null);
        }

        NativeTrackChoice(Tracks.Group group, int index, String label, boolean off, boolean selected, String subtitleRel) {
            this(group, index, label, off, selected, subtitleRel, "", "");
        }

        NativeTrackChoice(Tracks.Group group, int index, String label, boolean off, boolean selected,
                          String subtitleRel, String subtitleAction, String subtitleLang) {
            this.group = group;
            this.index = index;
            this.label = label;
            this.off = off;
            this.selected = selected;
            this.subtitleRel = subtitleRel;
            this.subtitleAction = subtitleAction == null ? "" : subtitleAction;
            this.subtitleLang = subtitleLang == null ? "" : subtitleLang;
        }
    }

    private void showNativeTrackMenu(int trackType) {
        if (nativePlayer == null) return;
        if (trackType == C.TRACK_TYPE_TEXT && !nativeSubtitleHasOptions()) return;
        if (trackType == C.TRACK_TYPE_AUDIO && !nativeAudioHasOptions()) return;
        showNativeChrome(false);

        java.util.ArrayList<NativeTrackChoice> choices = new java.util.ArrayList<>();
        if (trackType == C.TRACK_TYPE_TEXT) {
            choices.add(new NativeTrackChoice(null, -1,
                    "Off", true, nativeSubtitleRel.isEmpty()));
            for (int i = 0; i < nativeSubtitleChoiceRels.size(); i++) {
                String rel = nativeSubtitleChoiceRels.get(i);
                String label = i < nativeSubtitleChoiceLabels.size() ? nativeSubtitleChoiceLabels.get(i) : "";
                String action = i < nativeSubtitleChoiceActions.size() ? nativeSubtitleChoiceActions.get(i) : "";
                String lang = i < nativeSubtitleChoiceLangs.size() ? nativeSubtitleChoiceLangs.get(i) : "";
                if (label == null || label.isEmpty()) label = rel.isEmpty() ? "More subtitle versions" : nativeLabelForSubtitleRel(rel);
                choices.add(new NativeTrackChoice(null, -1, label, false,
                        !rel.isEmpty() && rel.equals(nativeSubtitleRel), rel, action, lang));
            }
        }

        for (Tracks.Group group : nativePlayer.getCurrentTracks().getGroups()) {
            if (group.getType() != trackType) continue;
            if (trackType == C.TRACK_TYPE_TEXT && nativeSubtitleChoiceRels.size() > 0) continue;
            for (int i = 0; i < group.length; i++) {
                if (!group.isTrackSupported(i)) continue;
                Format f = group.getTrackFormat(i);
                if (trackType == C.TRACK_TYPE_TEXT && !nativeIsWyzieTrack(f)) continue;
                boolean selected = group.isTrackSelected(i);
                choices.add(new NativeTrackChoice(group, i,
                        nativeTrackLabel(f, trackType, choices.size()), false, selected));
            }
        }

        if (choices.size() == (trackType == C.TRACK_TYPE_TEXT ? 1 : 0)) {
            Toast.makeText(this,
                    trackType == C.TRACK_TYPE_TEXT
                            ? "No online subtitle choices are available"
                            : "No alternate audio tracks are available",
                    Toast.LENGTH_SHORT).show();
            return;
        }

        java.util.ArrayList<String> labels = new java.util.ArrayList<>();
        java.util.ArrayList<Boolean> selected = new java.util.ArrayList<>();
        for (NativeTrackChoice choice : choices) {
            labels.add(choice.label);
            selected.add(choice.selected);
        }
        int syncLaterIndex = -1;
        int syncEarlierIndex = -1;
        int resetIndex = -1;
        if (trackType == C.TRACK_TYPE_TEXT) {
            syncLaterIndex = labels.size();
            labels.add("Sync: subtitles later");
            selected.add(false);
            syncEarlierIndex = labels.size();
            labels.add("Sync: subtitles earlier");
            selected.add(false);
            if (Math.abs(nativeSubtitleShift) >= 0.05f) {
                resetIndex = labels.size();
                labels.add("Reset subtitle sync" + nativeSubShiftLabel());
                selected.add(false);
            }
        }
        String[] labelArray = labels.toArray(new String[0]);
        boolean[] selectedArray = new boolean[selected.size()];
        for (int i = 0; i < selected.size(); i++) selectedArray[i] = selected.get(i);
        final int later = syncLaterIndex;
        final int earlier = syncEarlierIndex;
        final int reset = resetIndex;
        showNativeChoiceSheet(trackType == C.TRACK_TYPE_TEXT ? "Subtitles" : "Audio",
                labelArray, selectedArray, which -> {
                    if (which == later) {
                        nativeSheetRestoreIndex = later;
                        shiftNativeSubtitles(0.5f);
                    } else if (which == earlier) {
                        nativeSheetRestoreIndex = earlier;
                        shiftNativeSubtitles(-0.5f);
                    } else if (which == reset) {
                        nativeSheetRestoreIndex = later >= 0 ? later : 0;
                        resetNativeSubtitleShift();
                    }
                    else applyNativeTrackChoice(trackType, choices.get(which));
                });
    }

    private boolean nativeIsWyzieTrack(Format f) {
        String label = f == null || f.label == null ? "" : f.label.toLowerCase(Locale.US);
        return label.contains("wyzie") || (!nativeSubtitleLabel.isEmpty()
                && label.contains(nativeSubtitleLabel.toLowerCase(Locale.US)));
    }

    private void applyNativeTrackChoice(int trackType, NativeTrackChoice choice) {
        if (nativePlayer == null) return;
        if (trackType == C.TRACK_TYPE_TEXT && "versions".equals(choice.subtitleAction)) {
            requestNativeSubtitleVersions(choice.subtitleLang);
            showNativeChrome(false);
            return;
        }
        if (trackType == C.TRACK_TYPE_TEXT && "missing".equals(choice.subtitleAction)) {
            Toast.makeText(this, choice.label == null || choice.label.isEmpty()
                    ? "No subtitles found for this title" : choice.label, Toast.LENGTH_SHORT).show();
            showNativeChrome(false);
            return;
        }
        if (trackType == C.TRACK_TYPE_TEXT && "local_all".equals(choice.subtitleAction)) {
            requestNativeSubtitleShowAll();
            showNativeChrome(false);
            return;
        }
        if (trackType == C.TRACK_TYPE_TEXT && choice.subtitleRel != null) {
            nativeSubtitleRel = choice.subtitleRel;
            nativeSubtitleLabel = choice.label;
            nativeSubtitleLang = nativeLangFromSubtitleRel(choice.subtitleRel);
            String selectedSubtitleUrl = subtitleUrlForRel(choice.subtitleRel);
            nativeSubtitleShift = nativeShiftFromUrl(selectedSubtitleUrl);
            String cleanSubtitleUrl = stripNativeQueryParam(selectedSubtitleUrl, "shift");
            try {
                ValidatedNativeUrl subtitlePin = cleanSubtitleUrl.isEmpty() ? null : validateNativePlaybackUrl(cleanSubtitleUrl);
                nativeSubtitleUrl = subtitlePin == null ? "" : subtitlePin.connectUrl;
                nativeSubtitleHostHeader = subtitlePin == null ? "" : subtitlePin.hostHeader;
                nativeHasWyzieSubtitle = subtitlePin != null;
            } catch (Exception ex) {
                Log.w(TAG, "Blocked subtitle URL: " + redactNativeLogMessage(ex.getMessage()));
                nativeSubtitleUrl = "";
                nativeSubtitleHostHeader = "";
                nativeHasWyzieSubtitle = false;
                Toast.makeText(this, "Subtitle URL was blocked", Toast.LENGTH_SHORT).show();
                showNativeChrome(false);
                return;
            }
            disableNativeTextTracks();
            loadNativeSubtitleOverlay(nativeSubtitleUrl);
            notifyNativeSubtitleSelect(choice.subtitleRel);
            showNativeChrome(false);
            return;
        }
        androidx.media3.common.TrackSelectionParameters.Builder b =
                nativePlayer.getTrackSelectionParameters().buildUpon();
        if (choice.off) {
            b.clearOverridesOfType(trackType).setTrackTypeDisabled(trackType, true);
            if (trackType == C.TRACK_TYPE_TEXT) {
                nativeSubtitleRel = "";
                nativeSubtitleUrl = "";
                nativeSubtitleHostHeader = "";
                nativeSubtitleShift = 0f;
                nativeHasWyzieSubtitle = false;
                clearNativeSubtitleOverlay();
                notifyNativeSubtitleSelect(null);
            }
        } else {
            if (trackType == C.TRACK_TYPE_TEXT) {
                nativeSubtitleRel = "";
                nativeSubtitleUrl = "";
                nativeSubtitleHostHeader = "";
                nativeSubtitleShift = 0f;
                nativeHasWyzieSubtitle = false;
                clearNativeSubtitleOverlay();
            }
            b.setTrackTypeDisabled(trackType, false)
                    .setOverrideForType(new TrackSelectionOverride(choice.group.getMediaTrackGroup(), choice.index));
        }
        nativePlayer.setTrackSelectionParameters(b.build());
        showNativeChrome(false);
    }

    private void disableNativeTextTracks() {
        if (nativePlayer == null) return;
        androidx.media3.common.TrackSelectionParameters.Builder b =
                nativePlayer.getTrackSelectionParameters().buildUpon();
        b.clearOverridesOfType(C.TRACK_TYPE_TEXT).setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);
        nativePlayer.setTrackSelectionParameters(b.build());
    }

    private String subtitleUrlForRel(String rel) {
        if (rel == null || rel.isEmpty()) return "";
        for (int i = 0; i < nativeSubtitleChoiceRels.size(); i++) {
            if (rel.equals(nativeSubtitleChoiceRels.get(i)) && i < nativeSubtitleChoiceUrls.size()) {
                return nativeSubtitleChoiceUrls.get(i);
            }
        }
        return "";
    }

    private String nativeTrackLabel(Format f, int trackType, int ordinal) {
        if (trackType == C.TRACK_TYPE_TEXT) {
            return nativeSubtitleLabel == null || nativeSubtitleLabel.isEmpty() ? "Subtitles" : nativeSubtitleLabel;
        }
        StringBuilder s = new StringBuilder();
        if (f.label != null && !f.label.trim().isEmpty()) s.append(f.label.trim());
        String lang = nativeLangName(f.language);
        if (!lang.isEmpty()) {
            if (s.length() > 0) s.append(" - ");
            s.append(lang);
        }
        if (trackType == C.TRACK_TYPE_AUDIO) {
            if (f.channelCount > 0) {
                if (s.length() > 0) s.append(" - ");
                s.append(f.channelCount).append("ch");
            }
            String codec = nativeCodecName(f.sampleMimeType, f.codecs);
            if (!codec.isEmpty()) {
                if (s.length() > 0) s.append(" - ");
                s.append(codec);
            }
        }
        if (s.length() == 0) s.append(trackType == C.TRACK_TYPE_TEXT ? "Subtitle " : "Audio ").append(ordinal + 1);
        return s.toString();
    }

    private String nativeLangName(String language) {
        if (language == null || language.trim().isEmpty() || "und".equalsIgnoreCase(language)) return "";
        java.util.Locale loc = java.util.Locale.forLanguageTag(language);
        String name = loc.getDisplayLanguage(java.util.Locale.US);
        return name == null || name.isEmpty() ? language.toUpperCase(java.util.Locale.US) : name;
    }

    private String nativeLangFromSubtitleRel(String rel) {
        if (rel == null) return "";
        String[] parts = rel.split(":");
        return parts.length >= 2 ? parts[1] : "";
    }

    private String nativeLabelForSubtitleRel(String rel) {
        String lang = nativeLangName(nativeLangFromSubtitleRel(rel));
        return lang.isEmpty() ? "Subtitles" : lang;
    }

    private void notifyNativeSubtitleSelect(String rel) {
        if (web == null) return;
        web.evaluateJavascript("window.__tvNativeSubtitleSelect && window.__tvNativeSubtitleSelect("
                + (rel == null ? "null" : org.json.JSONObject.quote(rel))
                + "," + nativePosSeconds() + "," + nativeDurSeconds() + ")", null);
    }

    private void requestNativeSubtitleVersions(String lang) {
        if (web == null) return;
        nativeOpenSubtitleMenuAfterRefresh = true;
        Toast.makeText(this, "Loading subtitle versions...", Toast.LENGTH_SHORT).show();
        web.evaluateJavascript("window.__tvNativeSubtitleVersions && window.__tvNativeSubtitleVersions("
                + org.json.JSONObject.quote(lang == null || lang.isEmpty() ? "en" : lang)
                + "," + nativePosSeconds() + "," + nativeDurSeconds() + ")", null);
    }

    private void requestNativeSubtitleShowAll() {
        if (web == null) return;
        nativeOpenSubtitleMenuAfterRefresh = true;
        Toast.makeText(this, "Showing all subtitle languages", Toast.LENGTH_SHORT).show();
        web.evaluateJavascript("window.__tvNativeSubtitleShowAll && window.__tvNativeSubtitleShowAll("
                + nativePosSeconds() + "," + nativeDurSeconds() + ")", null);
    }

    private String nativeCodecName(String mime, String codecs) {
        String m = (mime == null ? "" : mime).toLowerCase(Locale.US);
        String c = (codecs == null ? "" : codecs).toLowerCase(Locale.US);
        String v = m + " " + c;
        if (v.contains("dvh") || v.contains("dovi") || v.contains("dolby-vision")) return "Dolby Vision";
        if (v.contains("h265") || v.contains("hevc")) return "HEVC";
        if (v.contains("h264") || v.contains("avc")) return "H.264";
        if (v.contains("av01") || v.contains("av1")) return "AV1";
        if (v.contains("vp9")) return "VP9";
        if (v.contains("true-hd") || v.contains("truehd")) return "TrueHD";
        if (v.contains("eac3-joc")) return "E-AC3 Atmos";
        if (v.contains("eac3") || v.contains("e-ac-3")) return "E-AC3";
        if (v.contains("ac3") || v.contains("ac-3")) return "AC3";
        if (v.contains("dts")) return "DTS";
        if (v.contains("aac")) return "AAC";
        if (v.contains("opus")) return "Opus";
        if (v.contains("flac")) return "FLAC";
        if (!m.isEmpty()) return m.replace("video/", "").replace("audio/", "").toUpperCase(Locale.US);
        return "";
    }

    private void showNativeQualityMenu() {
        if (nativePlayer == null) return;
        if (!"video".equals(nativeMode) || !nativeHasQualityChoices) return;
        showNativeChrome(false);
        String label = nativeQualityLabel == null || nativeQualityLabel.isEmpty() ? "1080p" : nativeQualityLabel;
        String[] labels = new String[]{
                "Original (" + label + ")",
                "1080p optimized",
                "720p optimized",
                "480p optimized"
        };
        boolean[] selected = new boolean[]{
                !"transcode".equals(nativeKind),
                "transcode".equals(nativeKind) && label.contains("1080"),
                "transcode".equals(nativeKind) && label.contains("720"),
                "transcode".equals(nativeKind) && label.contains("480")
        };
        showNativeChoiceSheet("Quality", labels, selected, this::chooseNativeQuality);
    }

    private void chooseNativeQuality(int which) {
        if (web == null) return;
        String quality = which <= 0 ? "orig" : (which == 1 ? "1080" : (which == 2 ? "720" : "480"));
        web.evaluateJavascript("window.__tvNativeVideoQuality && window.__tvNativeVideoQuality("
                + org.json.JSONObject.quote(quality) + "," + nativePosSeconds() + "," + nativeDurSeconds() + ")", null);
        showNativeChrome(false);
    }

    private boolean nativeSheetOpen() {
        return nativeSheet != null && nativeSheet.getVisibility() == View.VISIBLE;
    }

    private void hideNativeSheet() {
        if (nativeSheet == null) return;
        nativeSheet.setVisibility(View.GONE);
        nativeSheet.removeAllViews();
        nativeSheetScroll = null;
        nativeSheetRows = null;
        if (nativeSheetReturnFocus != null) nativeSheetReturnFocus.requestFocus();
        nativeSheetReturnFocus = null;
        nativeSheetRestoreIndex = -1;
        showNativeChrome(false);
    }

    private void showNativeChoiceSheet(String title, String[] labels, NativeChoiceHandler handler) {
        showNativeChoiceSheet(title, labels, null, handler);
    }

    private int nativeSheetWidthPx() {
        int screen = Math.max(1, getResources().getDisplayMetrics().widthPixels);
        if (isTvDevice()) return dp(328);
        return Math.max(dp(260), Math.min(dp(328), screen - dp(32)));
    }

    private int nativeSheetSideMarginPx() {
        return isTvDevice() ? dp(42) : dp(16);
    }

    private int nativeSheetBottomMarginPx() {
        if (isTvDevice()) return dp(96);
        int screen = Math.max(1, getResources().getDisplayMetrics().heightPixels);
        return Math.max(dp(68), Math.min(dp(96), screen / 5));
    }

    private int nativeSheetVerticalReservePx() {
        return isTvDevice() ? dp(260) : dp(190);
    }

    private void updateNativeSheetLayout() {
        if (nativeSheet == null) return;
        ViewGroup.LayoutParams raw = nativeSheet.getLayoutParams();
        if (!(raw instanceof FrameLayout.LayoutParams)) return;
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) raw;
        int side = nativeSheetSideMarginPx();
        lp.width = nativeSheetWidthPx();
        lp.height = ViewGroup.LayoutParams.WRAP_CONTENT;
        lp.gravity = android.view.Gravity.END | android.view.Gravity.BOTTOM;
        lp.setMargins(side, 0, side, nativeSheetBottomMarginPx());
        nativeSheet.setLayoutParams(lp);
    }

    private int nativeSheetRowsViewportHeight(int count) {
        int screen = Math.max(1, getResources().getDisplayMetrics().heightPixels);
        int max = Math.max(dp(96), Math.min(dp(360), screen - nativeSheetVerticalReservePx()));
        int needed = Math.max(dp(43), count * dp(43) + dp(6));
        return Math.min(max, needed);
    }

    private java.util.ArrayList<View> nativeSheetFocusableRows() {
        java.util.ArrayList<View> rows = new java.util.ArrayList<>();
        ViewGroup parent = nativeSheetRows != null ? nativeSheetRows : nativeSheet;
        if (parent == null) return rows;
        int start = parent == nativeSheet ? 1 : 0;
        for (int i = start; i < parent.getChildCount(); i++) {
            View row = parent.getChildAt(i);
            if (row != null && row.getVisibility() == View.VISIBLE && row.isFocusable()) rows.add(row);
        }
        return rows;
    }

    private void focusNativeSheetRow(java.util.ArrayList<View> rows, int index) {
        if (rows == null || rows.isEmpty()) return;
        int safe = Math.max(0, Math.min(rows.size() - 1, index));
        View row = rows.get(safe);
        row.requestFocus();
        if (nativeSheetScroll != null) {
            nativeSheetScroll.post(() -> nativeSheetScroll.scrollTo(0, Math.max(0, row.getTop() - dp(8))));
        }
    }

    private void showNativeChoiceSheet(String title, String[] labels, boolean[] selectedRows, NativeChoiceHandler handler) {
        if (nativeSheet == null) return;
        nativeProgress.removeCallbacks(nativeHideChrome);
        nativeSheetReturnFocus = getCurrentFocus();
        nativeSheet.removeAllViews();
        nativeSheetScroll = null;
        nativeSheetRows = null;
        updateNativeSheetLayout();

        TextView head = new TextView(this);
        head.setText(title);
        head.setTextColor(0xFFEDE8F5);
        head.setTextSize(13);
        head.setTypeface(Typeface.DEFAULT_BOLD);
        head.setPadding(dp(8), 0, dp(8), dp(9));
        nativeSheet.addView(head, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        nativeSheetScroll = new ScrollView(this);
        nativeSheetScroll.setFillViewport(false);
        nativeSheetScroll.setClipToPadding(false);
        nativeSheetScroll.setPadding(0, 0, 0, dp(2));
        nativeSheetRows = new LinearLayout(this);
        nativeSheetRows.setOrientation(LinearLayout.VERTICAL);
        nativeSheetScroll.addView(nativeSheetRows, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        for (int i = 0; i < labels.length; i++) {
            final int index = i;
            boolean selected = selectedRows != null && i < selectedRows.length && selectedRows[i];
            TextView row = nativeSheetRow(labels[i], selected);
            row.setOnClickListener(v -> {
                hideNativeSheet();
                handler.choose(index);
            });
            nativeSheetRows.addView(row);
        }
        nativeSheet.addView(nativeSheetScroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, nativeSheetRowsViewportHeight(labels.length)));

        nativeSheet.setVisibility(View.VISIBLE);
        nativeSheet.bringToFront();
        int focusIndex = nativeSheetRestoreIndex >= 0 ? nativeSheetRestoreIndex : 0;
        nativeSheetRestoreIndex = -1;
        java.util.ArrayList<View> rows = nativeSheetFocusableRows();
        if (!rows.isEmpty()) focusNativeSheetRow(rows, focusIndex);
    }

    private TextView nativeSheetRow(String label, boolean selected) {
        TextView row = new TextView(this);
        row.setText(label);
        row.setTextColor(selected ? 0xFFF4E6B7 : 0xDDF3EFF7);
        row.setTextSize(12);
        row.setTypeface(Typeface.DEFAULT_BOLD);
        row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setSingleLine(true);
        row.setEllipsize(TextUtils.TruncateAt.END);
        row.setFocusable(true);
        row.setClickable(true);
        row.setPadding(dp(12), 0, dp(12), 0);
        row.setBackground(nativeSheetRowBg(false, selected));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(40));
        lp.topMargin = dp(4);
        row.setLayoutParams(lp);
        row.setOnFocusChangeListener((v, hasFocus) -> {
            v.setBackground(nativeSheetRowBg(hasFocus, selected));
            ((TextView) v).setTextColor(hasFocus ? 0xFFF9F4FF : selected ? 0xFFF4E6B7 : 0xDDF3EFF7);
        });
        return row;
    }

    private GradientDrawable nativeSheetRowBg(boolean focused, boolean selected) {
        GradientDrawable d = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                focused
                        ? new int[]{0xFF2B3137, 0xFF252A30}
                        : selected
                        ? new int[]{0x403A3424, 0x30312D22}
                        : new int[]{0x0012091D, 0x0012091D});
        d.setCornerRadius(dp(8));
        d.setStroke(dp(1), focused ? 0x66B8A46A : selected ? 0x55B8A46A : 0x00000000);
        return d;
    }

    private Format nativeSelectedFormat(int trackType) {
        if (nativePlayer == null) return null;
        for (Tracks.Group group : nativePlayer.getCurrentTracks().getGroups()) {
            if (group.getType() != trackType) continue;
            for (int i = 0; i < group.length; i++) {
                if (group.isTrackSelected(i)) return group.getTrackFormat(i);
            }
        }
        return null;
    }

    private String nativeBitrateLabel(int bitrate) {
        if (bitrate <= 0) return "";
        double mbps = bitrate / 1_000_000.0;
        return mbps >= 10
                ? Math.round(mbps) + " Mbps"
                : String.format(Locale.US, "%.1f Mbps", mbps);
    }

    private String nativeFileSizeLabel(long bytes) {
        if (bytes <= 0) return "";
        double n = bytes;
        if (n >= 1099511627776.0) return String.format(Locale.US, "%.2f TB", n / 1099511627776.0);
        if (n >= 1073741824.0) return String.format(Locale.US, "%.2f GB", n / 1073741824.0);
        if (n >= 1048576.0) return String.format(Locale.US, "%.1f MB", n / 1048576.0);
        if (n >= 1024.0) return Math.round(n / 1024.0) + " KB";
        return bytes + " B";
    }

    private String nativeVideoStatsLabel(Format f) {
        if (f == null) return "";
        java.util.ArrayList<String> parts = new java.util.ArrayList<>();
        if (f.width > 0 && f.height > 0) parts.add(f.width + "x" + f.height);
        String codec = nativeCodecName(f.sampleMimeType, f.codecs);
        if (!codec.isEmpty()) parts.add(codec);
        if (f.frameRate > 0) parts.add(String.format(Locale.US, "%.0f fps", f.frameRate));
        String br = nativeBitrateLabel(f.averageBitrate > 0 ? f.averageBitrate : f.peakBitrate);
        if (!br.isEmpty()) parts.add(br);
        return TextUtils.join(" - ", parts);
    }

    private String nativeAudioStatsLabel(Format f) {
        if (f == null) return "";
        java.util.ArrayList<String> parts = new java.util.ArrayList<>();
        String codec = nativeCodecName(f.sampleMimeType, f.codecs);
        if (!codec.isEmpty()) parts.add(codec);
        if (f.channelCount > 0) parts.add(f.channelCount + "ch");
        if (f.sampleRate > 0) parts.add(Math.round(f.sampleRate / 1000.0) + " kHz");
        if (f.language != null && !f.language.trim().isEmpty()) parts.add(f.language.trim());
        return TextUtils.join(" - ", parts);
    }

    private long nativeBufferedAheadMs() {
        if (nativePlayer == null) return 0L;
        long pos = nativePlayer.getCurrentPosition();
        long buf = nativePlayer.getBufferedPosition();
        if (pos == C.TIME_UNSET || buf == C.TIME_UNSET || buf < pos) return 0L;
        return Math.max(0L, buf - pos);
    }

    private long nativeBandwidthEstimate() {
        if (nativeBandwidthMeter == null) return 0L;
        long estimate = nativeBandwidthMeter.getBitrateEstimate();
        return estimate > 0 ? estimate : 0L;
    }

    private String nativeStatsJson() {
        try {
            Format video = nativeSelectedFormat(C.TRACK_TYPE_VIDEO);
            Format audio = nativeSelectedFormat(C.TRACK_TYPE_AUDIO);
            org.json.JSONObject j = new org.json.JSONObject();
            j.put("player", "ExoPlayer");
            j.put("mode", nativeMode == null ? "" : nativeMode);
            j.put("kind", nativeKind == null ? "" : nativeKind);
            j.put("quality", nativeQualityLabel == null ? "" : nativeQualityLabel);
            j.put("title", nativePlaybackTitle == null ? "" : nativePlaybackTitle);
            j.put("size", nativePlaybackSizeBytes);
            j.put("video", nativeVideoStatsLabel(video));
            j.put("audio", nativeAudioStatsLabel(audio));
            j.put("bufferedSec", Math.round(nativeBufferedAheadMs() / 1000.0));
            j.put("bandwidth", nativeBandwidthEstimate());
            return j.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    private String[] nativeStatsRows() {
        java.util.ArrayList<String> rows = new java.util.ArrayList<>();
        String mode = "live".equals(nativeMode) ? "Live TV" : ("video".equals(nativeMode) ? "Movie / episode" : "Player");
        rows.add("Player: ExoPlayer");
        rows.add("Mode: " + mode);
        rows.add("Path: " + (nativeKind == null || nativeKind.isEmpty() ? "direct" : nativeKind));
        rows.add("Quality: " + (nativeQualityLabel == null || nativeQualityLabel.isEmpty() ? "Auto" : nativeQualityLabel));
        rows.add("Size: " + (nativePlaybackSizeBytes > 0 ? nativeFileSizeLabel(nativePlaybackSizeBytes) : "Unknown"));
        String video = nativeVideoStatsLabel(nativeSelectedFormat(C.TRACK_TYPE_VIDEO));
        String audio = nativeAudioStatsLabel(nativeSelectedFormat(C.TRACK_TYPE_AUDIO));
        rows.add("Video: " + (video.isEmpty() ? "Detecting" : video));
        rows.add("Audio: " + (audio.isEmpty() ? "Detecting" : audio));
        long buffered = nativeBufferedAheadMs();
        rows.add("Buffered: " + (buffered > 0 ? Math.round(buffered / 1000.0) + "s ahead" : "Detecting"));
        long bw = nativeBandwidthEstimate();
        rows.add("Bandwidth: " + (bw > 0 ? nativeBitrateLabel((int) Math.min(Integer.MAX_VALUE, bw)) : "Detecting"));
        return rows.toArray(new String[0]);
    }

    private void showNativeStatsSheet() {
        showNativeChoiceSheet("Playback stats", nativeStatsRows(), null, index -> {});
    }

    private void playNativeNextEpisode() {
        String mode = nativeMode;
        long pos = nativePosSeconds();
        long dur = nativeDurSeconds();
        closeNativePlayback(false);
        if (!"video".equals(mode)) return;
        web.evaluateJavascript("window.__tvNativeVideoNext && __tvNativeVideoNext("
                + pos + "," + dur + ")", null);
    }

    private void startNativeProgress() {
        nativeProgress.removeCallbacksAndMessages(null);
        nativeProgress.post(new Runnable() {
            @Override public void run() {
                if (!nativePlayerOpen()) return;
                applyNativeStartSeekIfReady();
                updateNativeChrome();
                updateNativeLiveWatchdog();
                updateNativeVideoWatchdog();
                if ("video".equals(nativeMode)) {
                    rememberNativeVideoPosition();
                    web.evaluateJavascript("window.__tvNativeVideoProgress && __tvNativeVideoProgress("
                            + nativePosSeconds() + "," + nativeDurSeconds() + ")", null);
                }
                long now = SystemClock.elapsedRealtime();
                if (now - nativeLastStatsMs >= 2000L) {
                    nativeLastStatsMs = now;
                    web.evaluateJavascript("window.__tvNativeVideoStats && window.__tvNativeVideoStats("
                            + nativeStatsJson() + ")", null);
                }
                nativeProgress.postDelayed(this, 1000);
            }
        });
    }

    private void updateNativeLiveWatchdog() {
        if (!"live".equals(nativeMode) || nativePlayer == null) return;
        int state = nativePlayer.getPlaybackState();
        boolean waitingForLiveData = state == Player.STATE_BUFFERING
                || (state == Player.STATE_READY && nativePlayer.getPlayWhenReady()
                && !nativePlayer.isPlaying() && nativePlayer.isLoading());
        boolean unhealthy = state == Player.STATE_IDLE || state == Player.STATE_ENDED || waitingForLiveData;
        if (!unhealthy) {
            nativeLiveUnhealthySinceMs = 0L;
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (nativeLiveUnhealthySinceMs <= 0L) {
            nativeLiveUnhealthySinceMs = now;
            return;
        }
        long threshold = nativeLiveStarted ? NATIVE_LIVE_STALL_RECOVERY_MS : NATIVE_LIVE_STARTUP_STALL_RECOVERY_MS;
        if (now - nativeLiveUnhealthySinceMs >= threshold) {
            recoverNativeLivePlayback(state == Player.STATE_IDLE ? "idle" : (state == Player.STATE_BUFFERING ? "buffering" : "stalled"));
        }
    }

    private void updateNativeVideoWatchdog() {
        if (!"video".equals(nativeMode) || nativePlayer == null) return;
        int state = nativePlayer.getPlaybackState();
        if (state == Player.STATE_READY) {
            nativeVideoStarted = true;
            rememberNativeVideoPosition();
            nativeVideoUnhealthySinceMs = 0L;
            nativeVideoMemoryTrimmedDuringBuffer = false;
            return;
        }
        if (nativeVideoStarted) {
            boolean waitingForData = state == Player.STATE_BUFFERING
                    || (nativePlayer.getPlayWhenReady() && !nativePlayer.isPlaying() && nativePlayer.isLoading());
            boolean unhealthy = state == Player.STATE_IDLE || waitingForData;
            if (!unhealthy) {
                nativeVideoUnhealthySinceMs = 0L;
                nativeVideoMemoryTrimmedDuringBuffer = false;
                return;
            }
            long now = SystemClock.elapsedRealtime();
            if (nativeVideoUnhealthySinceMs <= 0L) {
                nativeVideoUnhealthySinceMs = now;
                return;
            }
            long elapsed = now - nativeVideoUnhealthySinceMs;
            if (!nativeVideoMemoryTrimmedDuringBuffer && elapsed >= NATIVE_VIDEO_REBUFFER_TRIM_MS) {
                nativeVideoMemoryTrimmedDuringBuffer = true;
                Log.w(TAG, "Native VOD rebuffer still waiting after " + elapsed + "ms; trimming UI caches");
                trimAndroidMemoryCaches(false);
            }
            if (elapsed >= NATIVE_VIDEO_REBUFFER_RECOVERY_MS) {
                Log.w(TAG, "Native VOD rebuffer stalled after " + elapsed + "ms; retrying same source");
                notifyNativeVideoError(state == Player.STATE_IDLE ? "native player idle" : "native rebuffer stalled",
                        nativePosSeconds(), nativeDurSeconds());
            }
            return;
        }
        boolean unhealthy = state == Player.STATE_IDLE || state == Player.STATE_BUFFERING
                || (nativePlayer.getPlayWhenReady() && !nativePlayer.isPlaying());
        if (!unhealthy) {
            nativeVideoUnhealthySinceMs = 0L;
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (nativeVideoUnhealthySinceMs <= 0L) {
            nativeVideoUnhealthySinceMs = now;
            return;
        }
        long startupThreshold = nativeLikelyHeavyVod()
                ? NATIVE_VIDEO_HEAVY_STARTUP_STALL_MS
                : NATIVE_VIDEO_STARTUP_STALL_MS;
        if (now - nativeVideoUnhealthySinceMs >= startupThreshold) {
            notifyNativeVideoError(state == Player.STATE_IDLE ? "native player idle" : "native startup stalled",
                    nativePosSeconds(), nativeDurSeconds());
        }
    }

    private void releaseNativePlayer(boolean notifyClosed) {
        releaseNativePlayer(notifyClosed, false);
    }

    private void releaseNativePlayer(boolean notifyClosed, boolean preserveGuideMode) {
        nativeProgress.removeCallbacksAndMessages(null);
        nativeSubtitleHandler.removeCallbacksAndMessages(null);
        nativeSubtitleLoadToken++;
        hideNativeLoading();
        hideNativeGuidePipReveal();
        if (nativeSheet != null) {
            nativeSheet.setVisibility(View.GONE);
            nativeSheet.removeAllViews();
        }
        clearNativeEpisodes();
        nativeUpNextVisible = false;
        if (nativeUpNextCard != null) nativeUpNextCard.setVisibility(View.GONE);
        if (nativeControlShade != null) nativeControlShade.setVisibility(View.GONE);
        if (nativeMetaBar != null) nativeMetaBar.setVisibility(View.GONE);
        nativeSheetReturnFocus = null;
        String mode = nativeMode;
        long pos = nativePosSeconds();
        long dur = nativeDurSeconds();
        boolean guideMode = nativeGuideMode;
        nativeGuideMode = preserveGuideMode && guideMode;
        ExoPlayer player = nativePlayer;
        nativePlayer = null;
        if (player != null) {
            if (nativePlayerView != null) {
                try {
                    nativePlayerView.setPlayer(null);
                } catch (Throwable e) {
                    Log.w(TAG, "Native player view detach ignored: " + nativeThrowableMessage(e));
                }
            }
            try {
                player.release();
            } catch (Throwable e) {
                Log.w(TAG, "Native player release ignored: " + nativeThrowableMessage(e));
            }
        }
        nativeMode = "";
        nativeKind = "direct";
        nativeQualityLabel = "1080p";
        nativeUrl = "";
        nativeHostHeader = "";
        nativeMime = "";
        nativeFallbackUrl = "";
        nativeFallbackMime = "";
        nativeFallbackUrls.clear();
        nativeFallbackMimes.clear();
        nativeFallbackHostHeaders.clear();
        nativeHttpDataSourceFactory = null;
        nativeBandwidthMeter = null;
        nativeFallbackIndex = 0;
        nativePlaybackTitle = "Triboon";
        nativePlaybackSubline = "";
        nativePlaybackBackdropUrl = "";
        nativeTriedFallback = false;
        nativeLiveUnhealthySinceMs = 0L;
        nativeLiveLastRecoveryMs = 0L;
        nativeLiveStarted = false;
        nativeVideoUnhealthySinceMs = 0L;
        nativeVideoMemoryTrimmedDuringBuffer = false;
        nativeVideoStarted = false;
        nativeLastVideoDisplayMs = 0L;
        nativeLastStatsMs = 0L;
        nativeSeekDpadMode = false;
        nativeBackConsumedChromeDown = false;
        nativeOpenSubtitleMenuAfterRefresh = false;
        nativeKnownDurationMs = 0L;
        nativePendingStartMs = 0L;
        nativeStartSeekIssuedAtMs = 0L;
        nativeStartOffsetMs = 0L;
        nativeHasNext = false;
        nativeHasQualityChoices = false;
        nativeSubtitleUrl = "";
        nativeSubtitleHostHeader = "";
        nativeSubtitleLang = "";
        nativeSubtitleLabel = "";
        nativeSubtitleRel = "";
        clearNativeSubtitleChoices();
        nativeSubtitleCues.clear();
        nativeControlIndex = -1;
        if (nativeSubtitleOverlay != null) {
            nativeSubtitleOverlay.setText("");
            nativeSubtitleOverlay.setVisibility(View.GONE);
        }
        nativeSubtitleShift = 0f;
        nativeHasWyzieSubtitle = false;
        if (notifyClosed && "video".equals(mode)) {
            web.evaluateJavascript("window.__tvNativeVideoClosed && __tvNativeVideoClosed("
                    + pos + "," + dur + ",false)", null);
        } else if (notifyClosed) {
            web.evaluateJavascript("window.__tvNativeLiveClosed && __tvNativeLiveClosed()", null);
        }
    }

    private void closeNativePlayback(boolean notifyClosed) {
        boolean waitForLiveClose = notifyClosed && "live".equals(nativeMode);
        releaseNativePlayer(notifyClosed);
        setPhonePlaybackOrientation(false);
        if (nativePlayerLayer != null) nativePlayerLayer.setVisibility(View.GONE);
        if (waitForLiveClose) {
            web.postDelayed(this::showWebAfterNativePlayback, 80);
            return;
        }
        showWebAfterNativePlayback();
    }

    private void showWebAfterNativePlayback() {
        if (web == null) return;
        web.setVisibility(View.VISIBLE);
        web.requestFocus();
        web.postDelayed(() -> {
            if (web == null) return;
            web.evaluateJavascript("window.__tvNativePlaybackSurfaceReady && window.__tvNativePlaybackSurfaceReady()", null);
        }, 40);
    }

    /* ============ Google Cast (sender) ============ */
    // Lazy CastContext init on the UI thread, guarded on Google Play Services so degoogled / Fire /
    // sideloaded boxes never crash — they simply never show a Cast button. All Cast SDK callbacks
    // (session/state/progress) fire on the main thread; we still wrap web pushes in runOnUiThread.
    private com.google.android.gms.cast.framework.CastContext castCtx() {
        if (castUnavailable) return null;
        if (castContext != null) return castContext;
        try {
            int gp = com.google.android.gms.common.GoogleApiAvailability.getInstance()
                    .isGooglePlayServicesAvailable(this);
            if (gp != com.google.android.gms.common.ConnectionResult.SUCCESS) { castUnavailable = true; return null; }
            castContext = com.google.android.gms.cast.framework.CastContext.getSharedInstance(this);
            installCastListeners();
            return castContext;
        } catch (Throwable t) {
            castUnavailable = true;
            Log.w(TAG, "Cast unavailable: " + nativeThrowableMessage(t));
            return null;
        }
    }
    private void installCastListeners() {
        if (castContext == null) return;
        if (castStateListener == null) castStateListener = newState -> {
            castHasDevices = newState != com.google.android.gms.cast.framework.CastState.NO_DEVICES_AVAILABLE;
            updateNativeCastButton();
        };
        if (castSessionListener == null) castSessionListener = new CastSessionWatcher();
        try {
            castContext.addCastStateListener(castStateListener);
            castHasDevices = castContext.getCastState() != com.google.android.gms.cast.framework.CastState.NO_DEVICES_AVAILABLE;
            castContext.getSessionManager().addSessionManagerListener(
                    castSessionListener, com.google.android.gms.cast.framework.CastSession.class);
        } catch (Throwable ignored) {}
        updateNativeCastButton();
    }
    private void removeCastListeners() {
        if (castContext == null) return;
        try { if (castStateListener != null) castContext.removeCastStateListener(castStateListener); } catch (Throwable ignored) {}
        try { if (castSessionListener != null) castContext.getSessionManager().removeSessionManagerListener(
                castSessionListener, com.google.android.gms.cast.framework.CastSession.class); } catch (Throwable ignored) {}
    }
    private com.google.android.gms.cast.framework.CastSession currentCastSession() {
        try { return castContext == null ? null : castContext.getSessionManager().getCurrentCastSession(); }
        catch (Throwable t) { return null; }
    }
    private boolean castActive() {
        com.google.android.gms.cast.framework.CastSession s = currentCastSession();
        return s != null && s.isConnected();
    }
    // Cast whatever the native player is currently showing (VOD only). Captures the live position so
    // the receiver resumes where the phone left off.
    private void castCurrentNativeVideo() {
        if (castCtx() == null) { pushCastError("Casting is not available on this device"); return; }
        if (nativePlayer == null || !"video".equals(nativeMode)) return;
        String url = "";
        try {
            androidx.media3.common.MediaItem mi = nativePlayer.getCurrentMediaItem();
            if (mi != null && mi.localConfiguration != null && mi.localConfiguration.uri != null) url = mi.localConfiguration.uri.toString();
        } catch (Throwable ignored) {}
        if (url.isEmpty()) { pushCastError("No stream to cast"); return; }
        String title = nativeChromeTitle != null && nativeChromeTitle.getText() != null ? nativeChromeTitle.getText().toString() : "Triboon";
        org.json.JSONObject j = new org.json.JSONObject();
        try { j.put("url", url); j.put("title", title); j.put("position", nativePosSeconds()); j.put("contentType", "video/mp4"); } catch (Throwable ignored) {}
        handleCastRequest(j.toString());
    }
    private void handleCastRequest(String json) {
        com.google.android.gms.cast.framework.CastContext ctx = castCtx();
        if (ctx == null) { pushCastError("Casting is not available on this device"); return; }
        castPendingJson = (json == null ? "{}" : json);
        com.google.android.gms.cast.framework.CastSession cur = currentCastSession();
        if (cur != null && cur.isConnected()) { String j = castPendingJson; castPendingJson = null; loadCastMedia(cur, j); }
        else showCastRoutePicker();
    }
    // Show the MediaRouter chooser through an AppCompat-themed ContextThemeWrapper so the app-wide
    // theme stays ink-black DeviceDefault (no white flash). On route selection the Cast framework
    // auto-starts a CastSession → CastSessionWatcher.onSessionStarted loads the pending media.
    private void showCastRoutePicker() {
        try {
            android.view.ContextThemeWrapper ctw = new android.view.ContextThemeWrapper(
                    this, androidx.appcompat.R.style.Theme_AppCompat_DayNight_Dialog);
            androidx.mediarouter.app.MediaRouteChooserDialog dialog =
                    new androidx.mediarouter.app.MediaRouteChooserDialog(ctw);
            dialog.setRouteSelector(new androidx.mediarouter.media.MediaRouteSelector.Builder()
                    .addControlCategory(com.google.android.gms.cast.CastMediaControlIntent.categoryForCast(
                            com.google.android.gms.cast.CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
                    .build());
            dialog.show();
        } catch (Throwable t) {
            Log.w(TAG, "Cast picker failed: " + nativeThrowableMessage(t));
            pushCastError("Could not open the Cast menu");
        }
    }
    private void loadCastMedia(com.google.android.gms.cast.framework.CastSession session, String json) {
        if (session == null) return;
        com.google.android.gms.cast.framework.media.RemoteMediaClient rmc = session.getRemoteMediaClient();
        if (rmc == null) { pushCastError("Cast device is not ready"); return; }
        String url, title, poster, contentType; long posMs;
        try {
            org.json.JSONObject j = new org.json.JSONObject(json == null ? "{}" : json);
            url = j.optString("url", "");
            title = j.optString("title", "Triboon");
            poster = j.optString("poster", "");
            contentType = j.optString("contentType", "video/mp4");
            posMs = Math.max(0L, (long) (j.optDouble("position", 0) * 1000));
        } catch (Throwable t) { pushCastError("Bad cast request"); return; }
        if (url.isEmpty()) { pushCastError("No stream URL to cast"); return; }
        // Stop local ExoPlayer so we never double-play; false = do NOT tell the web playback ended
        // (the web keeps its player open to render the cast OSD state).
        closeNativePlayback(false);
        com.google.android.gms.cast.MediaMetadata md =
                new com.google.android.gms.cast.MediaMetadata(com.google.android.gms.cast.MediaMetadata.MEDIA_TYPE_MOVIE);
        md.putString(com.google.android.gms.cast.MediaMetadata.KEY_TITLE, title);
        if (!poster.isEmpty()) { try { md.addImage(new com.google.android.gms.common.images.WebImage(android.net.Uri.parse(poster))); } catch (Throwable ignored) {} }
        com.google.android.gms.cast.MediaInfo info = new com.google.android.gms.cast.MediaInfo.Builder(url)
                .setStreamType(com.google.android.gms.cast.MediaInfo.STREAM_TYPE_BUFFERED)
                .setContentType(contentType)
                .setMetadata(md)
                .build();
        com.google.android.gms.cast.MediaLoadRequestData req =
                new com.google.android.gms.cast.MediaLoadRequestData.Builder()
                        .setMediaInfo(info).setAutoplay(true).setCurrentTime(posMs).build();
        attachCastMediaListeners(rmc);
        try { rmc.load(req); } catch (Throwable t) { pushCastError("Cast could not load this title"); return; }
        pushCast("connected", session);
    }
    private void attachCastMediaListeners(com.google.android.gms.cast.framework.media.RemoteMediaClient rmc) {
        if (rmc == null) return;
        if (castProgress == null) castProgress = (pos, dur) -> pushCastProgress();
        if (castCallback == null) castCallback = new com.google.android.gms.cast.framework.media.RemoteMediaClient.Callback() {
            @Override public void onStatusUpdated() { pushCastProgress(); }
        };
        try { rmc.removeProgressListener(castProgress); } catch (Throwable ignored) {}
        try { rmc.unregisterCallback(castCallback); } catch (Throwable ignored) {}
        try { rmc.addProgressListener(castProgress, 1000); rmc.registerCallback(castCallback); } catch (Throwable ignored) {}
    }
    private void detachCastMediaListeners() {
        com.google.android.gms.cast.framework.CastSession s = currentCastSession();
        com.google.android.gms.cast.framework.media.RemoteMediaClient rmc = (s == null) ? null : s.getRemoteMediaClient();
        if (rmc == null) return;
        try { if (castProgress != null) rmc.removeProgressListener(castProgress); } catch (Throwable ignored) {}
        try { if (castCallback != null) rmc.unregisterCallback(castCallback); } catch (Throwable ignored) {}
    }
    private void handleCastControl(String action) {
        com.google.android.gms.cast.framework.CastSession s = currentCastSession();
        com.google.android.gms.cast.framework.media.RemoteMediaClient rmc = (s == null) ? null : s.getRemoteMediaClient();
        if (rmc == null || action == null) return;
        try {
            if ("play".equals(action)) rmc.play();
            else if ("pause".equals(action)) rmc.pause();
            else if (action.startsWith("seek:")) {
                long ms = (long) (Double.parseDouble(action.substring(5)) * 1000);
                rmc.seek(new com.google.android.gms.cast.MediaSeekOptions.Builder().setPosition(Math.max(0, ms)).build());
            }
        } catch (Throwable ignored) {}
    }
    private void handleCastStop() {
        try { if (castContext != null) castContext.getSessionManager().endCurrentSession(true); } catch (Throwable ignored) {}
    }
    private String castStateName(int playerState) {
        switch (playerState) {
            case com.google.android.gms.cast.MediaStatus.PLAYER_STATE_PLAYING: return "playing";
            case com.google.android.gms.cast.MediaStatus.PLAYER_STATE_PAUSED: return "paused";
            case com.google.android.gms.cast.MediaStatus.PLAYER_STATE_BUFFERING: return "buffering";
            case com.google.android.gms.cast.MediaStatus.PLAYER_STATE_IDLE: return "idle";
            default: return "unknown";
        }
    }
    private void pushCastProgress() {
        com.google.android.gms.cast.framework.CastSession s = currentCastSession();
        com.google.android.gms.cast.framework.media.RemoteMediaClient rmc = (s == null) ? null : s.getRemoteMediaClient();
        pushCast(rmc != null ? castStateName(rmc.getPlayerState()) : "unknown", s);
    }
    private void pushCast(String state, com.google.android.gms.cast.framework.CastSession s) {
        if (web == null) return;
        com.google.android.gms.cast.framework.media.RemoteMediaClient rmc = (s != null) ? s.getRemoteMediaClient() : null;
        long posSec = 0, durSec = 0; String device = "";
        try {
            if (rmc != null) { posSec = rmc.getApproximateStreamPosition() / 1000; durSec = rmc.getStreamDuration() / 1000; }
            if (s != null && s.getCastDevice() != null) device = s.getCastDevice().getFriendlyName();
        } catch (Throwable ignored) {}
        org.json.JSONObject j = new org.json.JSONObject();
        try {
            j.put("connected", s != null && s.isConnected());
            j.put("device", device == null ? "" : device);
            j.put("position", posSec);
            j.put("duration", durSec);
            j.put("state", state == null ? "" : state);
        } catch (Throwable ignored) {}
        final String payload = j.toString();
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript("window.__tvCast && window.__tvCast(" + payload + ")", null); });
    }
    private void pushCastError(String msg) {
        if (web == null) return;
        final String m = msg == null ? "" : msg;
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript("window.__tvCastError && __tvCastError(" + org.json.JSONObject.quote(m) + ")", null); });
    }
    private final class CastSessionWatcher implements com.google.android.gms.cast.framework.SessionManagerListener<com.google.android.gms.cast.framework.CastSession> {
        @Override public void onSessionStarted(com.google.android.gms.cast.framework.CastSession s, String id) {
            if (castPendingJson != null) { String j = castPendingJson; castPendingJson = null; loadCastMedia(s, j); }
            else { attachCastMediaListeners(s.getRemoteMediaClient()); pushCast("connected", s); }
            updateNativeCastButton();
        }
        @Override public void onSessionResumed(com.google.android.gms.cast.framework.CastSession s, boolean wasSuspended) {
            attachCastMediaListeners(s.getRemoteMediaClient()); pushCast("connected", s); updateNativeCastButton();
        }
        @Override public void onSessionEnded(com.google.android.gms.cast.framework.CastSession s, int error) {
            detachCastMediaListeners();
            updateNativeCastButton();
            if (web != null) runOnUiThread(() -> { if (web != null) web.evaluateJavascript("window.__tvCast && window.__tvCast({\"connected\":false})", null); });
        }
        @Override public void onSessionStarting(com.google.android.gms.cast.framework.CastSession s) {}
        @Override public void onSessionStartFailed(com.google.android.gms.cast.framework.CastSession s, int error) { pushCastError("Cast connection failed"); }
        @Override public void onSessionResuming(com.google.android.gms.cast.framework.CastSession s, String id) {}
        @Override public void onSessionResumeFailed(com.google.android.gms.cast.framework.CastSession s, int error) {}
        @Override public void onSessionSuspended(com.google.android.gms.cast.framework.CastSession s, int reason) {}
        @Override public void onSessionEnding(com.google.android.gms.cast.framework.CastSession s) {}
    }

    // ---------- first-run / connection-error screen ----------
    private void buildSetupScreen() {
        setup = new LinearLayout(this);
        setup.setOrientation(LinearLayout.VERTICAL);
        setup.setGravity(android.view.Gravity.CENTER);
        setup.setBackgroundColor(0xFF0B0812);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        int contentWidth = Math.max(dp(260), Math.min(getResources().getDisplayMetrics().widthPixels - (pad * 2), dp(520)));
        setup.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText(R.string.setup_title);
        title.setTextColor(Color.WHITE);
        title.setTextSize(26);
        title.setPadding(0, 0, 0, pad / 2);
        setup.addView(title, new LinearLayout.LayoutParams(contentWidth, ViewGroup.LayoutParams.WRAP_CONTENT));

        setupMsg = new TextView(this);
        setupMsg.setTextColor(0xFFFB8B3C); // --coral
        setupMsg.setTextSize(15);
        setupMsg.setPadding(0, 0, 0, pad / 2);
        setup.addView(setupMsg, new LinearLayout.LayoutParams(contentWidth, ViewGroup.LayoutParams.WRAP_CONTENT));

        addr = new EditText(this);
        addr.setHint(R.string.setup_hint);
        addr.setTextColor(Color.WHITE);
        addr.setHintTextColor(0x66FFFFFF);
        addr.setSingleLine(true);
        setup.addView(addr, new LinearLayout.LayoutParams(contentWidth, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button go = new Button(this);
        go.setText(R.string.setup_connect);
        go.setOnClickListener(v -> connect());
        addr.setOnEditorActionListener((v, id, ev) -> { connect(); return true; });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = pad / 2;
        setup.addView(go, lp);

        TextView help = new TextView(this);
        help.setText(R.string.setup_help);
        help.setTextColor(0x99FFFFFF);
        help.setTextSize(13);
        help.setPadding(0, pad / 2, 0, 0);
        setup.addView(help, new LinearLayout.LayoutParams(contentWidth, ViewGroup.LayoutParams.WRAP_CONTENT));

        setup.setVisibility(View.GONE);
        root.addView(setup, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void showSetup(String message) {
        setupMsg.setText(message == null ? "" : message);
        String saved = prefs().getString(KEY_SERVER, "");
        if (!saved.isEmpty()) addr.setText(saved);
        setup.setVisibility(View.VISIBLE);
        if (isTvDevice()) {
            addr.requestFocus();
        } else {
            root.requestFocus();
        }
    }

    private void connect() {
        String url = normalizeServerUrl(addr.getText().toString());
        if (url.isEmpty()) return;
        String serverError = serverUrlValidationError(url);
        if (!serverError.isEmpty()) {
            setupMsg.setText(serverError);
            addr.requestFocus();
            return;
        }
        prefs().edit().putString(KEY_SERVER, url).apply();
        if (!isTvDevice()) {
            hidePhoneKeyboard(addr);
            addr.clearFocus();
            root.requestFocus();
        }
        setup.setVisibility(View.GONE);
        if (!ensureWebViewReady()) {
            showSetup(webViewUnavailableMessage());
            return;
        }
        web.setVisibility(View.VISIBLE);
        if (isTvDevice()) web.requestFocus();
        web.loadUrl(url);
        if (!isTvDevice()) clearPhoneInitialWebInputFocus();
    }

    // ---------- keys: BACK + media transport ----------
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();

        // Setup screen keeps stock behavior (IME owns BACK, D-pad walks the fields).
        if (setup.getVisibility() == View.VISIBLE) {
            if (code == KeyEvent.KEYCODE_BACK && e.getAction() == KeyEvent.ACTION_UP
                    && !prefs().getString(KEY_SERVER, "").isEmpty() && pageReady) {
                setup.setVisibility(View.GONE);
                web.requestFocus();
                return true;
            }
            return super.dispatchKeyEvent(e);
        }

        if (nativePlayerOpen()) {
            if (nativeGuideMode) {
                if (code == KeyEvent.KEYCODE_BACK) {
                    return handleNativeBackKey(e);
                }
                if (e.getAction() == KeyEvent.ACTION_DOWN && nativePlayer != null) {
                    boolean repeat = e.getRepeatCount() > 0;
                    switch (code) {
                        case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                            if (!repeat) {
                                if (nativePlayer.isPlaying()) nativePlayer.pause();
                                else nativePlayer.play();
                            }
                            return true;
                        case KeyEvent.KEYCODE_MEDIA_PLAY:
                            if (!repeat) nativePlayer.play(); return true;
                        case KeyEvent.KEYCODE_MEDIA_PAUSE:
                            if (!repeat) nativePlayer.pause(); return true;
                        case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                            nativeSeekBy(30000);
                            return true;
                        case KeyEvent.KEYCODE_MEDIA_REWIND:
                            nativeSeekBy(-10000);
                            return true;
                        case KeyEvent.KEYCODE_MEDIA_STOP:
                            if (!repeat) closeNativePlayback(true); return true;
                    }
                }
                String guideDomKey = domKeyFor(code);
                boolean guideDpad = code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN
                        || code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT
                        || code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER;
                if (guideDomKey != null && (!pageInputFocused || guideDpad)) {
                    if (e.getAction() == KeyEvent.ACTION_DOWN) jsKey("keydown", guideDomKey, e.getRepeatCount() > 0);
                    else if (e.getAction() == KeyEvent.ACTION_UP) jsKey("keyup", guideDomKey, false);
                    return true;
                }
                return super.dispatchKeyEvent(e);
            }
            if (code == KeyEvent.KEYCODE_BACK) {
                return handleNativeBackKey(e);
            }
            if (handleNativeSurfaceKey(e)) return true;
            if (e.getAction() == KeyEvent.ACTION_DOWN && nativePlayer != null) {
                boolean repeat = e.getRepeatCount() > 0;
                switch (code) {
                    case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                        if (!repeat) {
                            if (nativePlayer.isPlaying()) nativePlayer.pause();
                            else nativePlayer.play();
                        }
                        return true;
                    case KeyEvent.KEYCODE_MEDIA_PLAY:
                        if (!repeat) nativePlayer.play(); return true;
                    case KeyEvent.KEYCODE_MEDIA_PAUSE:
                        if (!repeat) nativePlayer.pause(); return true;
                    case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                        nativeSeekBy(30000);
                        return true;
                    case KeyEvent.KEYCODE_MEDIA_REWIND:
                        nativeSeekBy(-10000);
                        return true;
                    case KeyEvent.KEYCODE_MEDIA_STOP:
                        if (!repeat) closeNativePlayback(true); return true;
                }
            }
            return super.dispatchKeyEvent(e);
        }

        if (code == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP) handleSystemBack();
            return true; // never let the WebView do raw history.back()
        }

        // The shell OWNS the D-pad: every arrow/OK press becomes a synthetic DOM key event
        // (keydown with the repeat flag + keyup, which the web app's long-press OK needs).
        // Letting the WebView see them would ALSO run its built-in spatial navigation —
        // two focus systems fighting is exactly the "D-pad is a mess" failure mode.
        // Exception: while the page has a text field/dropdown focused, native handling
        // (caret movement, IME, select pickers) must win — the JS bridge tells us.
        String domKey = domKeyFor(code);
        boolean dpadArrow = code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN
                || code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT;
        if (domKey != null && (!pageInputFocused || dpadArrow) && setup.getVisibility() != View.VISIBLE) {
            if (e.getAction() == KeyEvent.ACTION_DOWN) jsKey("keydown", domKey, e.getRepeatCount() > 0);
            else if (e.getAction() == KeyEvent.ACTION_UP) jsKey("keyup", domKey, false);
            return true;
        }

        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            boolean repeat = e.getRepeatCount() > 0;
            switch (code) {
                case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                    if (!repeat) jsMusicTransport("toggle"); return true;
                case KeyEvent.KEYCODE_MEDIA_PLAY:
                    if (!repeat) jsMusicTransport("play"); return true;
                case KeyEvent.KEYCODE_MEDIA_PAUSE:
                    if (!repeat) jsMusicTransport("pause"); return true;
                case KeyEvent.KEYCODE_MEDIA_NEXT:
                    if (!repeat) jsMusicTransport("next"); return true;
                case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                    if (!repeat) jsMusicTransport("prev"); return true;
                case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                    jsKey("keydown", "ArrowRight", false); return true; // player view: +30s
                case KeyEvent.KEYCODE_MEDIA_REWIND:
                    jsKey("keydown", "ArrowLeft", false); return true;  // player view: -10s
                case KeyEvent.KEYCODE_MEDIA_STOP:
                    if (!repeat) jsMusicTransport("stop"); return true;
            }
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (nativePlayerOpen() && handleNativeSurfaceKey(event)) return true;
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (nativePlayerOpen() && handleNativeSurfaceKey(event)) return true;
        return super.onKeyUp(keyCode, event);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleSystemBack();
    }

    private static String domKeyFor(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP: return "ArrowUp";
            case KeyEvent.KEYCODE_DPAD_DOWN: return "ArrowDown";
            case KeyEvent.KEYCODE_DPAD_LEFT: return "ArrowLeft";
            case KeyEvent.KEYCODE_DPAD_RIGHT: return "ArrowRight";
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER: return "Enter";
            default: return null;
        }
    }

    private void jsKey(String type, String key, boolean repeat) {
        if (!pageTvReady && !"keyup".equals(type)) {
            queuePendingTvKey(key, repeat);
            return;
        }
        web.evaluateJavascript(
                "document.dispatchEvent(new KeyboardEvent('" + type + "',{key:'" + key
                        + "',repeat:" + repeat + ",bubbles:true,cancelable:true}))",
                null);
    }

    private void queuePendingTvKey(String key, boolean repeat) {
        if (key == null || repeat) return;
        if (pendingTvKeys.size() >= 8) pendingTvKeys.remove(0);
        pendingTvKeys.add(key);
    }

    private void flushPendingTvKeys() {
        if (web == null || pendingTvKeys.isEmpty()) return;
        java.util.ArrayList<String> copy = new java.util.ArrayList<>(pendingTvKeys);
        pendingTvKeys.clear();
        for (String key : copy) {
            web.evaluateJavascript(
                    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'" + key
                            + "',repeat:false,bubbles:true,cancelable:true}));"
                            + "document.dispatchEvent(new KeyboardEvent('keyup',{key:'" + key
                            + "',repeat:false,bubbles:true,cancelable:true}))",
                    null);
        }
    }

    private void jsMusicTransport(String action) {
        if (web == null) return;
        web.evaluateJavascript("window.__tvMusicTransport && window.__tvMusicTransport('"
                + action + "')", null);
    }

    // ---- MusicService bridge: background playback + lock-screen controls ----
    // The service (a different component) forwards lock-screen/BT transport back to the web player.
    static void dispatchMusicTransport(String action) {
        MainActivity a = active;
        if (a != null) a.runOnUiThread(() -> a.jsMusicTransport(action));
    }
    static void dispatchMusicSeek(long positionMs) {
        MainActivity a = active;
        if (a != null) a.runOnUiThread(() -> {
            if (a.web != null) a.web.evaluateJavascript(
                "window.__tvMusicSeek && window.__tvMusicSeek(" + (positionMs / 1000) + ")", null);
        });
    }
    private void updateMusicService(org.json.JSONObject j, boolean playing) {
        try {
            ensureNotificationPermission();
            Intent i = new Intent(this, MusicService.class).setAction(MusicService.ACTION_UPDATE)
                .putExtra("playing", playing)
                .putExtra("title", j.optString("title", "Music"))
                .putExtra("artist", j.optString("artist", ""))
                .putExtra("album", j.optString("album", ""))
                .putExtra("artwork", j.optString("artwork", ""))
                .putExtra("duration", j.optLong("duration", 0))
                .putExtra("position", j.optLong("position", 0));
            if (!musicServiceUp && playing) {
                // First start happens while the user is in the app (they pressed play), so a
                // foreground-service start is permitted. Subsequent updates use startService — the
                // service is already running, avoiding the Android-12+ background-FGS-start block.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i);
                else startService(i);
                musicServiceUp = true;
            } else if (musicServiceUp) {
                startService(i);
            }
        } catch (Throwable t) { Log.w(TAG, "music service update failed", t); }
    }
    private void stopMusicService() {
        if (!musicServiceUp) return;
        musicServiceUp = false;
        try { startService(new Intent(this, MusicService.class).setAction(MusicService.ACTION_STOP)); }
        catch (Throwable ignored) {}
    }
    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        try {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{ android.Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIF);
            }
        } catch (Throwable ignored) {}
    }

    // BACK walks up through the web app (player → detail → home). The page's __tvBack()
    // answers 'exit' only at the home root; then BACK-twice within 2s leaves the app.
    private void handleSystemBack() {
        long now = SystemClock.uptimeMillis();
        if (now - lastSystemBackAt < 160) return;
        lastSystemBackAt = now;

        if (setup != null && setup.getVisibility() == View.VISIBLE) {
            if (!prefs().getString(KEY_SERVER, "").isEmpty() && pageReady) {
                setup.setVisibility(View.GONE);
                web.requestFocus();
            } else finish();
            return;
        }

        if (nativePlayerOpen()) {
            if (nativeGuideMode) closeNativeGuideMode();
            else if (nativeUpNextVisible) dismissNativeUpNext(true);
            else if (nativeSheetOpen()) hideNativeSheet();
            else if (nativeEpisodeStripOpen) closeNativeEpisodeStrip();
            else if (!dismissNativeChromeForBack()) closeNativePlayback(true);
            return;
        }

        handleBack();
    }

    private void handleBack() {
        if (!pageReady) { finish(); return; }
        web.evaluateJavascript("window.__tvBack ? window.__tvBack() : 'exit'", result -> {
            if (result != null && result.contains("exit")) {
                long now = System.currentTimeMillis();
                if (now - lastBackAtRoot < 2000) finish();
                else {
                    lastBackAtRoot = now;
                    Toast.makeText(this, R.string.press_back_again, Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    // ---------- voice search ----------
    // The WebView has no speech backend. On TV the RecognizerIntent ACTIVITY typically
    // resolves to the launcher's GLOBAL search (Katniss) — it opens, but never returns a
    // transcript to us, which is exactly the "voice didn't work" symptom. The reliable path
    // is the in-app SpeechRecognizer SERVICE; it needs RECORD_AUDIO granted at runtime.
    private void startVoiceFlow() {
        if (Build.VERSION.SDK_INT >= 23
                && checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                   != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            voicePending = true; // so the grant callback resumes the voice session
            requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return; // resumes in onRequestPermissionsResult
        }
        if (android.speech.SpeechRecognizer.isRecognitionAvailable(this)) { listenInApp(); return; }
        // Last resort: some boxes ship a recognizer activity that DOES return results.
        try {
            duckNativePlaybackForVoice();
            android.content.Intent i = new android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            startActivityForResult(i, REQ_VOICE);
        } catch (Exception ex) {
            restoreNativePlaybackAfterVoice();
            Toast.makeText(this, "Voice input isn't available on this device", Toast.LENGTH_SHORT).show();
            voiceResult("");
        }
    }

    private void listenInApp() {
        if (speech != null) { speech.destroy(); speech = null; }
        duckNativePlaybackForVoice();
        speech = android.speech.SpeechRecognizer.createSpeechRecognizer(this);
        android.content.Intent i = new android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(android.speech.RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        speech.setRecognitionListener(new android.speech.RecognitionListener() {
            @Override public void onResults(Bundle b) {
                java.util.ArrayList<String> r = b.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
                voiceResult(r != null && !r.isEmpty() && r.get(0) != null ? r.get(0) : "");
                done();
            }
            @Override public void onError(int code) { voiceResult(""); done(); }
            @Override public void onReadyForSpeech(Bundle b) {}
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rms) {}
            @Override public void onBufferReceived(byte[] buf) {}
            @Override public void onEndOfSpeech() {}
            @Override public void onPartialResults(Bundle b) {}
            @Override public void onEvent(int type, Bundle b) {}
            private void done() {
                restoreNativePlaybackAfterVoice();
                if (speech != null) { speech.destroy(); speech = null; }
            }
        });
        speech.startListening(i);
    }

    // Empty text = cancelled/failed: the page just stops the mic pulse animation.
    private void voiceResult(String text) {
        if (web == null) return;
        web.evaluateJavascript("window.__tvVoice && __tvVoice(" + org.json.JSONObject.quote(text) + ")", null);
    }

    private void duckNativePlaybackForVoice() {
        if (nativePlayer == null || nativeVoiceDucked) return;
        try {
            nativePlayer.setVolume(0.25f);
            nativeVoiceDucked = true;
        } catch (Exception ignored) {
        }
    }

    private void restoreNativePlaybackAfterVoice() {
        if (nativePlayer == null || !nativeVoiceDucked) {
            nativeVoiceDucked = false;
            return;
        }
        try {
            nativePlayer.setVolume(1f);
        } catch (Exception ignored) {
        }
        nativeVoiceDucked = false;
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] grants) {
        super.onRequestPermissionsResult(req, perms, grants);
        if (req != REQ_MIC) return;
        boolean fromVoiceTap = voicePending; voicePending = false;
        boolean granted = grants.length > 0 && grants[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
        // Only a mic-button tap continues into a live voice session — the first-launch ask
        // must never start listening (or nag) on its own.
        if (!fromVoiceTap) return;
        if (granted) startVoiceFlow();
        else {
            Toast.makeText(this, "Microphone permission is needed for voice search", Toast.LENGTH_SHORT).show();
            voiceResult("");
        }
    }

    @Override
    protected void onActivityResult(int req, int res, android.content.Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_VOICE) return;
        String text = "";
        if (res == RESULT_OK && data != null) {
            java.util.ArrayList<String> r = data.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS);
            if (r != null && !r.isEmpty() && r.get(0) != null) text = r.get(0);
        }
        restoreNativePlaybackAfterVoice();
        voiceResult(text);
    }

    @Override
    protected void onPause() {
        super.onPause();
        boolean inPip = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode();
        if (nativePlayer != null && !inPip) nativePlayer.pause();
        if (web != null) {
            web.evaluateJavascript("document.querySelectorAll('video').forEach(v=>v.pause())", null);
            // Keep the WebView + its timers alive while music is playing (or during PiP) so audio
            // continues in the background; only <video> was paused above. Otherwise suspend as usual.
            if (!inPip && !musicPlaying) {
                web.onPause();
                web.pauseTimers();
            }
        }
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level >= android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            trimAndroidMemoryCaches(level >= android.content.ComponentCallbacks2.TRIM_MEMORY_MODERATE);
        }
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        enterNativePictureInPictureIfUseful();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        if (isInPictureInPictureMode) hideNativeChromeNow();
        else if (nativePlayerOpen()) showNativeChrome(false);
    }

    private boolean enterNativePictureInPictureIfUseful() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || isTvDevice()) return false;
        if (!nativePlayerOpen() || nativePlayer == null || nativeGuideMode) return false;
        try {
            PictureInPictureParams params = new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(16, 9))
                    .build();
            return enterPictureInPictureMode(params);
        } catch (Exception ignored) {
            return false;
        }
    }

    private void trimAndroidMemoryCaches(boolean aggressive) {
        personalIptvHostSafetyCache.clear();
        if (nativeLoadingBackdrop != null) nativeLoadingBackdrop.setImageDrawable(null);
        if (web != null) {
            web.evaluateJavascript("window.__tvTrimMemory && window.__tvTrimMemory()", null);
            if (aggressive) {
                web.clearCache(false);
                web.freeMemory();
            }
        }
        if (aggressive) System.gc();
    }

    @Override
    protected void onDestroy() {
        focusRecoveryEpoch++; // neutralize any pending postDelayed focus-recovery so it can't touch a dead Activity
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && backInvokedCallback != null) {
            try { getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backInvokedCallback); } catch (Exception ignored) {}
            backInvokedCallback = null;
        }
        releaseNativePlayer(false);
        setPhonePlaybackOrientation(false);
        // Detach Cast listeners so the framework doesn't hold this Activity (do NOT end the session —
        // the user expects the TV to keep playing after leaving the app).
        detachCastMediaListeners();
        removeCastListeners();
        disposeWebView(web, false);
        if (speech != null) { speech.destroy(); speech = null; }
        stopMusicService(); // tear down the media notification + foreground service with the app
        if (active == this) active = null;
        super.onDestroy();
    }
}
