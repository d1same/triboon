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
import android.app.Activity;
import android.content.res.ColorStateList;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.PlayerView;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.List;
import java.util.Map;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {

    private static final String PREFS = "triboon";
    private static final String KEY_SERVER = "server";
    private static final String KEY_CACHE_VERSION = "cacheVersion";
    private static final int REQ_VOICE = 31;
    private static final int REQ_MIC = 32;

    private WebView web;
    private LinearLayout setup;
    private EditText addr;
    private TextView setupMsg;
    private FrameLayout root;
    private View fullscreenVideo;            // WebChromeClient custom view (HTML5 fullscreen)
    private FrameLayout nativePlayerLayer;   // Android-native player overlay
    private PlayerView nativePlayerView;
    private LinearLayout nativeTop;
    private TextView nativePlayerTitle;
    private TextView nativePlayerSubline;
    private TextView nativePlayerBadge;
    private TextView nativeChromeTitle;
    private TextView nativeChromeQuality;
    private TextView nativeClock;
    private TextView nativeEndsAt;
    private FrameLayout nativeLoading;
    private ImageView nativeLoadingBackdrop;
    private TextView nativeLoadingTitle;
    private int nativeLoadingToken;
    private View nativeControlShade;
    private LinearLayout nativeMetaBar;
    private LinearLayout nativeChrome;
    private SeekBar nativeSeek;
    private TextView nativeElapsed;
    private TextView nativeTime;
    private ImageButton nativePlayBtn;
    private ImageButton nativeRewBtn;
    private ImageButton nativeFwdBtn;
    private ImageButton nativeGuideBtn;
    private ImageButton nativeCcBtn;
    private ImageButton nativeAudioBtn;
    private ImageButton nativeQualityBtn;
    private ImageButton nativeNextBtn;
    private LinearLayout nativeSheet;
    private View nativeSheetReturnFocus;
    private int nativeSheetRestoreIndex = -1;
    private TextView nativeSubtitleOverlay;
    private ExoPlayer nativePlayer;
    private String nativeMode = "";          // "live" or "video"
    private String nativeKind = "direct";
    private String nativeQualityLabel = "1080p";
    private String nativeUrl = "";
    private String nativeMime = "";
    private String nativeFallbackUrl = "";
    private String nativeFallbackMime = "";
    private String nativePlaybackTitle = "Triboon";
    private String nativePlaybackBackdropUrl = "";
    private boolean nativeTriedFallback = false;
    private boolean nativeHasNext = false;
    private boolean nativeHasQualityChoices = false;
    private String nativeSubtitleUrl = "";
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
    private boolean nativeUserSeeking;
    private boolean nativeSeekDpadMode;
    private boolean nativeGuideMode;
    private int nativeGuideEpoch;
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
    private static final long NATIVE_VIDEO_STARTUP_STALL_MS = 7000L;
    private static final long NATIVE_LIVE_STALL_RECOVERY_MS = 45000L;
    private static final long NATIVE_LIVE_RECOVERY_COOLDOWN_MS = 15000L;
    private static final int NATIVE_LIVE_READ_TIMEOUT_MS = 60000;
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
    private boolean pageReady;               // main frame finished at least once
    private boolean pageTvReady;             // web focus model installed and has a target
    private volatile boolean pageInputFocused; // page reports text-field focus via the JS bridge
    private android.speech.SpeechRecognizer speech; // in-app voice search (created per use)
    private boolean voicePending;            // mic permission was requested BY a voice tap
    private int focusRecoveryEpoch;
    private final java.util.ArrayList<String> pendingTvKeys = new java.util.ArrayList<>();

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0B0812); // --ink
        root.setFocusable(true);
        root.setFocusableInTouchMode(true);
        setContentView(root);

        buildWebView();
        buildSetupScreen();

        String server = prefs().getString(KEY_SERVER, "");
        if (server.isEmpty()) showSetup(null);
        else web.loadUrl(server);

        // First launch: ask for the mic up front so voice search Just Works later. One-shot —
        // if the user declines here, we only re-ask when they actually tap the mic button.
        if (Build.VERSION.SDK_INT >= 23
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
        scheduleTvFocusRecovery("resume");
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) scheduleTvFocusRecovery("window");
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
            if (addr != null) addr.requestFocus();
            return;
        }
        if (nativePlayerOpen()) {
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

    private SharedPreferences prefs() { return getSharedPreferences(PREFS, MODE_PRIVATE); }

    // ---------- WebView ----------
    @SuppressLint("SetJavaScriptEnabled")
    private void buildWebView() {
        // Lets chrome://inspect (or the DevTools protocol over adb) attach to the page —
        // adb access is owner-gated anyway, and this is how TV-side issues get diagnosed.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web = new WebView(this);
        // The shell HTML is served no-cache by the server. Keep WebView's normal disk cache
        // for art/assets between launches; only flush once after an APK version change.
        String cacheVersion = prefs().getString(KEY_CACHE_VERSION, "");
        if (!BuildConfig.VERSION_NAME.equals(cacheVersion)) {
            web.clearCache(true);
            prefs().edit().putString(KEY_CACHE_VERSION, BuildConfig.VERSION_NAME).apply();
        }
        web.setBackgroundColor(0xFF0B0812);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                       // login token lives in localStorage
        s.setMediaPlaybackRequiresUserGesture(false);       // press-play = instant playback
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setSupportZoom(false);
        // Tag the UA so the web UI can adapt (hide fullscreen/volume, direct-play-first).
        s.setUserAgentString(s.getUserAgentString() + " TriboonTV/" + BuildConfig.VERSION_NAME);

        // TV surfaces vary (1080p UI on onn-class boxes, true 4K on a Shield set to 4K UI).
        // Left to its own devices the WebView lays the page out at a tablet-ish width and
        // upscales — soft on a 4K panel. Instead: lay out at a fixed 1920 CSS px (the web
        // UI's designed TV layout) and scale it 1:1 onto the REAL surface — 100% on a
        // 1080p surface, 200% on a 4K surface, i.e. native-resolution rendering either way.
        android.util.DisplayMetrics dm = new android.util.DisplayMetrics();
        getWindowManager().getDefaultDisplay().getRealMetrics(dm);
        boolean isTv = ((android.app.UiModeManager) getSystemService(UI_MODE_SERVICE))
                .getCurrentModeType() == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION;
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
                pendingTvKeys.clear();
            }

            @Override public void onPageFinished(WebView v, String url) {
                pageReady = true;
                scheduleTvFocusRecovery("page");
            }

            @Override public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (Build.VERSION.SDK_INT >= 23 && req.isForMainFrame()) {
                    pageReady = false;
                    pageTvReady = false;
                    pendingTvKeys.clear();
                    showSetup("Couldn't reach the server — check the address and that Triboon is running.");
                }
            }

            // Stay inside the app: only the configured server's pages render here. The web UI
            // hands video off to intent URLs only on desktop (VLC), so anything else is noise.
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                String server = prefs().getString(KEY_SERVER, "");
                Uri u = req.getUrl();
                return server.isEmpty() || u == null || !server.contains(u.getHost() == null ? "__no_host__" : u.getHost());
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
            }
            @Override public void onHideCustomView() {
                if (fullscreenVideo == null) return;
                root.removeView(fullscreenVideo);
                fullscreenVideo = null;
                web.setVisibility(View.VISIBLE);
                web.requestFocus();
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
            public void inputFocus(boolean focused) { pageInputFocused = focused; }

            @android.webkit.JavascriptInterface
            public void appReady() {
                runOnUiThread(() -> {
                    pageTvReady = true;
                    scheduleTvFocusRecovery("appReady");
                    flushPendingTvKeys();
                });
            }

            @android.webkit.JavascriptInterface
            public void startVoice() {
                runOnUiThread(MainActivity.this::startVoiceFlow);
            }

            @android.webkit.JavascriptInterface
            public int nativeChromeVersion() {
                return 1;
            }

            @android.webkit.JavascriptInterface
            public String nativePlaybackCaps() {
                return buildNativePlaybackCaps();
            }

            @android.webkit.JavascriptInterface
            public void playLive(String json) {
                runOnUiThread(() -> startNativeLive(json));
            }

            @android.webkit.JavascriptInterface
            public void playVideo(String json) {
                runOnUiThread(() -> startNativeVideo(json));
            }

            @android.webkit.JavascriptInterface
            public void showVideoLoading(String json) {
                runOnUiThread(() -> showNativeVideoLoading(json));
            }

            @android.webkit.JavascriptInterface
            public void closeVideo() {
                runOnUiThread(() -> closeNativePlayback(false));
            }

            @android.webkit.JavascriptInterface
            public void updateSubtitleChoices(String json) {
                runOnUiThread(() -> updateNativeSubtitleChoices(json));
            }

            @android.webkit.JavascriptInterface
            public void closeGuide() {
                runOnUiThread(MainActivity.this::closeNativeGuideMode);
            }

            @android.webkit.JavascriptInterface
            public void setGuidePipRect(String json) {
                runOnUiThread(() -> applyNativeGuidePipRect(json));
            }
        }, "TriboonTV");

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.requestFocus(View.FOCUS_DOWN);
    }

    private String buildNativePlaybackCaps() {
        try {
            org.json.JSONObject j = new org.json.JSONObject();
            j.put("native", true);
            j.put("sdk", Build.VERSION.SDK_INT);
            j.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
            j.put("brand", Build.BRAND == null ? "" : Build.BRAND);
            j.put("model", Build.MODEL == null ? "" : Build.MODEL);
            j.put("device", Build.DEVICE == null ? "" : Build.DEVICE);
            j.put("mkv", true); // ExoPlayer's Matroska extractor owns container support.
            j.put("mp4", true);
            j.put("h264", nativeDecoderAvailable("video/avc"));
            j.put("hevc", nativeDecoderAvailable("video/hevc"));
            j.put("av1", nativeDecoderAvailable("video/av01"));
            j.put("vp9", nativeDecoderAvailable("video/x-vnd.on2.vp9"));
            j.put("mpeg2", nativeDecoderAvailable("video/mpeg2"));
            j.put("aac", nativeDecoderAvailable("audio/mp4a-latm"));
            j.put("ac3", nativeDecoderAvailable("audio/ac3"));
            j.put("eac3", nativeDecoderAvailable("audio/eac3") || nativeDecoderAvailable("audio/eac3-joc"));
            j.put("dts", nativeDecoderAvailable("audio/vnd.dts") || nativeDecoderAvailable("audio/vnd.dts.hd"));
            j.put("source", "exo-mediacodec");
            return j.toString();
        } catch (Exception e) {
            return "{\"native\":true,\"mkv\":true,\"mp4\":true,\"source\":\"exo-mediacodec\"}";
        }
    }

    private boolean nativeDecoderAvailable(String mime) {
        if (mime == null || mime.isEmpty()) return false;
        try {
            MediaCodecInfo[] infos = new MediaCodecList(MediaCodecList.ALL_CODECS).getCodecInfos();
            for (MediaCodecInfo info : infos) {
                if (info == null || info.isEncoder()) continue;
                for (String type : info.getSupportedTypes()) {
                    if (mime.equalsIgnoreCase(type)) return true;
                }
            }
        } catch (Exception ignored) {}
        return false;
    }

    // ---------- native Live TV playback ----------
    private void buildNativePlayerLayer() {
        if (nativePlayerLayer != null) return;
        nativePlayerLayer = new FrameLayout(this);
        nativePlayerLayer.setBackgroundColor(Color.BLACK);
        nativePlayerLayer.setFocusable(true);
        nativePlayerLayer.setFocusableInTouchMode(true);
        nativePlayerLayer.setOnKeyListener((v, code, e) -> handleNativeSurfaceKey(e));
        nativePlayerLayer.setVisibility(View.GONE);

        nativePlayerView = (PlayerView) getLayoutInflater().inflate(R.layout.native_player_view, nativePlayerLayer, false);
        nativePlayerView.setUseController(false);
        nativePlayerView.setOnKeyListener((v, code, e) -> handleNativeSurfaceKey(e));
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

        nativeChromeTitle = new TextView(this);
        nativeChromeTitle.setTextColor(Color.WHITE);
        nativeChromeTitle.setTextSize(18);
        nativeChromeTitle.setTypeface(Typeface.DEFAULT_BOLD);
        nativeChromeTitle.setSingleLine(true);
        nativeChromeTitle.setShadowLayer(6, 0, 2, Color.BLACK);
        nativeMetaBar.addView(nativeChromeTitle, new LinearLayout.LayoutParams(
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

        nativeFwdBtn = nativeButton(R.drawable.ic_player_forward, "Forward 30 seconds", false);
        nativeFwdBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) nativeSeekBy(30000); });
        centerControls.addView(nativeFwdBtn);

        nativeNextBtn = nativeButton(R.drawable.ic_player_next, "Next episode", false);
        nativeNextBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) playNativeNextEpisode(); });
        centerControls.addView(nativeNextBtn);

        nativeCcBtn = nativeButton(R.drawable.ic_player_cc, "Subtitles", false);
        nativeCcBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) showNativeTrackMenu(C.TRACK_TYPE_TEXT); });
        rightControls.addView(nativeCcBtn);

        nativeAudioBtn = nativeButton(R.drawable.ic_player_audio, "Audio language", false);
        nativeAudioBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) showNativeTrackMenu(C.TRACK_TYPE_AUDIO); });
        rightControls.addView(nativeAudioBtn);

        nativeQualityBtn = nativeButton(R.drawable.ic_player_quality, "Quality", false);
        nativeQualityBtn.setOnClickListener(v -> { if (consumeNativeControlClick(v)) showNativeQualityMenu(); });
        rightControls.addView(nativeQualityBtn);

        controls.addView(leftControls, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        controls.addView(centerControls, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        controls.addView(rightControls, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        nativeChrome.addView(controls, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) nativeSheet.setElevation(dp(10));
        FrameLayout.LayoutParams sheetLp = new FrameLayout.LayoutParams(
                dp(280), ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.END | android.view.Gravity.BOTTOM);
        sheetLp.setMargins(0, 0, dp(38), dp(78));
        nativePlayerLayer.addView(nativeSheet, sheetLp);

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

        ImageView loadingLogo = new ImageView(this);
        loadingLogo.setImageResource(R.drawable.ic_loading_logo);
        loadingLogo.setAlpha(0.96f);
        loadingCenter.addView(loadingLogo, new LinearLayout.LayoutParams(dp(112), dp(112)));

        nativeLoadingTitle = new TextView(this);
        nativeLoadingTitle.setTextColor(0xDDF3EFF7);
        nativeLoadingTitle.setTextSize(15);
        nativeLoadingTitle.setTypeface(Typeface.DEFAULT_BOLD);
        nativeLoadingTitle.setGravity(android.view.Gravity.CENTER);
        nativeLoadingTitle.setSingleLine(true);
        nativeLoadingTitle.setPadding(0, dp(8), 0, 0);
        loadingCenter.addView(nativeLoadingTitle, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        ProgressBar loadingSpinner = new ProgressBar(this);
        loadingSpinner.setIndeterminate(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            loadingSpinner.setIndeterminateTintList(ColorStateList.valueOf(0xFFC13BD6));
        }
        LinearLayout.LayoutParams spinLp = new LinearLayout.LayoutParams(dp(34), dp(34));
        spinLp.topMargin = dp(18);
        loadingCenter.addView(loadingSpinner, spinLp);

        TextView loadingStage = new TextView(this);
        loadingStage.setText("Opening playback");
        loadingStage.setTextColor(0xAAFFC65C);
        loadingStage.setTextSize(11);
        loadingStage.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        loadingStage.setGravity(android.view.Gravity.CENTER);
        loadingStage.setPadding(0, dp(12), 0, 0);
        loadingCenter.addView(loadingStage, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

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

    private void showNativeLoading(String title, String backdropUrl) {
        if (nativeLoading == null) return;
        int token = ++nativeLoadingToken;
        nativeLoadingTitle.setText(title == null || title.isEmpty() ? "Preparing stream" : title);
        nativeLoadingBackdrop.setImageDrawable(null);
        nativeLoading.setVisibility(View.VISIBLE);
        nativeLoading.bringToFront();
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
                bitmap = BitmapFactory.decodeStream(conn.getInputStream());
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

    private void hideNativeLoading() {
        nativeLoadingToken++;
        if (nativeLoading != null) nativeLoading.setVisibility(View.GONE);
        if (nativeLoadingBackdrop != null) nativeLoadingBackdrop.setImageDrawable(null);
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
                new int[]{0xE80B0812, 0xE812091D});
        d.setShape(GradientDrawable.RECTANGLE);
        d.setCornerRadius(dp(12));
        d.setStroke(dp(1), 0x22F3EFF7);
        return d;
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
        buildNativePlayerLayer();
        releaseNativePlayer(false);
        nativeMode = "video";
        enterNativeFullscreenMode();
        showNativeLoading(title, backdropUrl);
    }

    private void startNativePlayback(String json, String mode) {
        String title = "video".equals(mode) ? "Triboon" : "Live TV";
        String backdropUrl = "";
        try {
            org.json.JSONObject j = new org.json.JSONObject(json == null ? "{}" : json);
            String url = j.optString("url", "");
            if (url.isEmpty()) throw new IllegalArgumentException("missing stream url");
            title = j.optString("title", title);
            String source = j.optString("source", "");
            String mime = j.optString("mime", "");
            String fallbackUrl = j.optString("fallbackUrl", "");
            String fallbackMime = j.optString("fallbackMime", "");
            backdropUrl = j.optString("backdropUrl", "");
            long startMs = Math.max(0, Math.round(j.optDouble("start", 0) * 1000));
            long startOffsetMs = Math.max(0, Math.round(j.optDouble("startOffset", 0) * 1000));
            String subtitleUrl = j.optString("subtitleUrl", "");
            String subtitleLang = j.optString("subtitleLang", "");
            String subtitleLabel = j.optString("subtitleLabel", "");
            String subtitleRel = j.optString("subtitleRel", "");
            String qualityLabel = j.optString("qualityLabel", "");
            boolean hasNext = j.optBoolean("hasNext", false);
            boolean hasQualityChoices = j.optBoolean("qualityChoices", false);
            boolean guide = j.optBoolean("guide", false);
            boolean quietSeek = j.optBoolean("quietSeek", false);
            long knownDurationMs = Math.max(0L, Math.round(j.optDouble("duration", 0) * 1000));
            buildNativePlayerLayer();
            releaseNativePlayer(false, guide);
            nativeMode = mode;
            nativeKind = j.optString("kind", "direct");
            nativeQualityLabel = qualityLabel.isEmpty() ? ("live".equals(mode) ? "LIVE" : "1080p") : qualityLabel;
            nativeUrl = url;
            nativeMime = mime;
            nativeFallbackUrl = fallbackUrl;
            nativeFallbackMime = fallbackMime;
            nativePlaybackTitle = title == null || title.isEmpty() ? "Triboon" : title;
            nativePlaybackBackdropUrl = backdropUrl == null ? "" : backdropUrl;
            nativeTriedFallback = false;
            nativeLiveUnhealthySinceMs = 0L;
            nativeLiveLastRecoveryMs = 0L;
            nativeVideoUnhealthySinceMs = 0L;
            nativeKnownDurationMs = knownDurationMs;
            nativePendingStartMs = "video".equals(mode) ? startMs : 0L;
            nativeStartSeekIssuedAtMs = 0L;
            nativeStartOffsetMs = "video".equals(mode) ? startOffsetMs : 0L;
            nativeHasNext = hasNext;
            nativeHasQualityChoices = hasQualityChoices;
            nativeSubtitleShift = (float) j.optDouble("subtitleShift", nativeShiftFromUrl(subtitleUrl));
            nativeSubtitleUrl = stripNativeQueryParam(subtitleUrl, "shift");
            nativeSubtitleLang = subtitleLang;
            nativeSubtitleRel = subtitleRel;
            nativeSubtitleLabel = subtitleLabel.isEmpty()
                    ? (!subtitleLang.isEmpty() ? nativeLangName(subtitleLang) : "Subtitles")
                    : subtitleLabel;
            nativeHasWyzieSubtitle = !subtitleUrl.isEmpty();
            applyNativeSubtitleChoices(j.optJSONArray("subtitleChoices"));

            DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                    .setBufferDurationsMs("video".equals(mode) ? 6000 : 8000,
                            "video".equals(mode) ? 60000 : 60000,
                            "video".equals(mode) ? 700 : 700,
                            "video".equals(mode) ? 1800 : 4000)
                    .setPrioritizeTimeOverSizeThresholds(true)
                    .build();
            nativePlayer = new ExoPlayer.Builder(this)
                    .setMediaSourceFactory(nativeMediaSourceFactory())
                    .setLoadControl(loadControl)
                    .build();
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
                    if (state == Player.STATE_READY) applyNativeStartSeekIfReady();
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
                    if ("video".equals(nativeMode) && isPlaying) nativeVideoUnhealthySinceMs = 0L;
                    scheduleNativeChromeHide();
                }
            });

            nativePlayerView.setPlayer(nativePlayer);
            nativePlayerTitle.setText(title);
            nativePlayerTitle.setVisibility(View.INVISIBLE);
            if (nativeChromeTitle != null) nativeChromeTitle.setText(title);
            if ("live".equals(mode)) {
                nativePlayerSubline.setText(source.isEmpty() ? "Live TV" : source);
                nativePlayerSubline.setVisibility(View.VISIBLE);
            } else {
                nativePlayerSubline.setText("");
                nativePlayerSubline.setVisibility(View.GONE);
            }
            String chromeQuality = "live".equals(mode) ? "LIVE" : nativeQualityLabel;
            nativePlayerBadge.setText(chromeQuality);
            nativePlayerBadge.setVisibility(View.GONE);
            if (nativeChromeQuality != null) nativeChromeQuality.setText(chromeQuality);
            if (nativeGuideBtn != null) nativeGuideBtn.setVisibility(View.VISIBLE);
            nativeNextBtn.setVisibility(hasNext ? View.VISIBLE : View.GONE);
            nativePlayerLayer.setVisibility(View.VISIBLE);
            if (!guide && "video".equals(mode) && !quietSeek) {
                enterNativeFullscreenMode();
                showNativeLoading(title, backdropUrl);
            }
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
        } catch (Exception e) {
            String msg = e.getMessage() == null ? "native player failed" : e.getMessage();
            if ("video".equals(mode)) {
                buildNativePlayerLayer();
                releaseNativePlayer(false);
                nativeMode = "video";
                enterNativeFullscreenMode();
                showNativeLoading(title, backdropUrl);
                web.evaluateJavascript("window.__tvNativeVideoError && __tvNativeVideoError("
                        + org.json.JSONObject.quote(msg) + ",0,0)", null);
            } else {
                closeNativePlayback(false);
                web.evaluateJavascript("window.__tvNativeLiveError && __tvNativeLiveError("
                        + org.json.JSONObject.quote(msg) + ")", null);
            }
        }
    }

    private boolean nativePlayerOpen() {
        return nativePlayerLayer != null && nativePlayerLayer.getVisibility() == View.VISIBLE;
    }

    private void showNativeChrome(boolean focusPlay) {
        if (nativeChrome == null) return;
        if (nativeControlShade != null) nativeControlShade.setVisibility(View.VISIBLE);
        if (nativeMetaBar != null) nativeMetaBar.setVisibility(View.VISIBLE);
        nativeChrome.setVisibility(View.VISIBLE);
        nativeTop.setVisibility(View.VISIBLE);
        setNativeSubtitleLift(true);
        if (focusPlay && nativePlayBtn != null && !nativeSheetOpen()) nativePlayBtn.requestFocus();
        scheduleNativeChromeHide();
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
            if (nativeUserSeeking || nativeSheetOpen()) return;
            if (nativeControlShade != null) nativeControlShade.setVisibility(View.GONE);
            if (nativeMetaBar != null) nativeMetaBar.setVisibility(View.GONE);
            nativeChrome.setVisibility(View.GONE);
            nativeTop.setVisibility(View.GONE);
            nativePlayerLayer.requestFocus();
            setNativeSubtitleLift(false);
        }
    };

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
        if (!alreadyGuideMode) {
            int screenW = getResources().getDisplayMetrics().widthPixels;
            int pipW = Math.max(dp(260), Math.min(dp(430), Math.round(screenW * 0.27f)));
            int pipH = Math.round(pipW * 9f / 16f);
            FrameLayout.LayoutParams pipLp = new FrameLayout.LayoutParams(
                    pipW, pipH, android.view.Gravity.TOP | android.view.Gravity.START);
            pipLp.setMargins(dp(38), dp(30), 0, 0);
            nativePlayerView.setLayoutParams(pipLp);
            nativePlayerView.setAlpha(0f);
            nativePlayerView.animate().alpha(1f).setDuration(180).setStartDelay(220).start();
        }
        nativePlayerView.setVisibility(View.VISIBLE);
        setNativeSubtitleLift(false);
        if (nativeSubtitleOverlay != null) nativeSubtitleOverlay.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        if (!alreadyGuideMode) web.requestFocus();
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
            nativePlayerView.animate().cancel();
            nativePlayerView.animate().alpha(1f).setDuration(160).start();
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
        nativePlayerView.setVisibility(View.VISIBLE);
        nativePlayerView.animate().cancel();
        nativePlayerView.setAlpha(1f);
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

    private ImageButton[] nativeControlButtons() {
        return new ImageButton[]{
                nativeGuideBtn, nativeRewBtn, nativePlayBtn, nativeFwdBtn,
                nativeNextBtn, nativeCcBtn, nativeAudioBtn, nativeQualityBtn
        };
    }

    private boolean moveNativeControlFocus(int dir) {
        if (nativeChrome == null || nativeChrome.getVisibility() != View.VISIBLE) return false;
        nativeSeekDpadMode = false;
        ImageButton[] buttons = nativeControlButtons();
        View current = getCurrentFocus();
        int first = -1, last = -1, cur = -1;
        for (int i = 0; i < buttons.length; i++) {
            ImageButton b = buttons[i];
            if (b == null || b.getVisibility() != View.VISIBLE || !b.isEnabled()) continue;
            if (first < 0) first = i;
            last = i;
            if (current == b) cur = i;
        }
        if (first < 0) return false;
        int target = cur < 0
                ? (nativePlayBtn != null && nativePlayBtn.getVisibility() == View.VISIBLE
                    && nativePlayBtn.isEnabled() ? java.util.Arrays.asList(buttons).indexOf(nativePlayBtn) : first)
                : Math.max(first, Math.min(last, cur + dir));
        while (target >= first && target <= last) {
            ImageButton b = buttons[target];
            if (b != null && b.getVisibility() == View.VISIBLE && b.isEnabled()) {
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
        for (ImageButton b : nativeControlButtons()) {
            if (b != null && b.getVisibility() == View.VISIBLE && b.isEnabled() && current == b) {
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
        long now = SystemClock.elapsedRealtime();
        boolean ok = v != null && v == nativeClickArmedView && now - nativeClickArmedAtMs < 800L;
        nativeClickArmedView = null;
        nativeClickArmedAtMs = 0L;
        return ok;
    }

    private boolean isNativeControl(View current) {
        if (current == null) return false;
        for (ImageButton b : nativeControlButtons()) {
            if (b != null && b.getVisibility() == View.VISIBLE && b.isEnabled() && current == b) return true;
        }
        return false;
    }

    private boolean focusNativeDefaultControl() {
        nativeSeekDpadMode = false;
        ImageButton[] buttons = nativeControlButtons();
        ImageButton target = nativePlayBtn != null && nativePlayBtn.getVisibility() == View.VISIBLE && nativePlayBtn.isEnabled() ? nativePlayBtn : null;
        if (target == null) {
            for (ImageButton b : buttons) {
                if (b != null && b.getVisibility() == View.VISIBLE && b.isEnabled()) { target = b; break; }
            }
        }
        if (target == null) return false;
        target.requestFocus();
        showNativeChrome(false);
        return true;
    }

    private boolean focusNativeSeekControl() {
        if (nativeSeek == null || nativeSheetOpen() || !nativeCanSeekVod()) return false;
        showNativeChrome(false);
        updateNativeChrome();
        if (nativeSeek.getVisibility() != View.VISIBLE || !nativeSeek.isEnabled()) return false;
        nativeSeekDpadMode = true;
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
        if (code == KeyEvent.KEYCODE_DPAD_DOWN || code == KeyEvent.KEYCODE_DPAD_LEFT
                || code == KeyEvent.KEYCODE_DPAD_RIGHT) {
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
        java.util.ArrayList<View> rows = new java.util.ArrayList<>();
        for (int i = 1; i < nativeSheet.getChildCount(); i++) {
            View row = nativeSheet.getChildAt(i);
            if (row != null && row.getVisibility() == View.VISIBLE && row.isFocusable()) rows.add(row);
        }
        if (rows.isEmpty()) return true;
        int cur = rows.indexOf(getCurrentFocus());
        if (cur < 0) {
            cur = 0;
            rows.get(cur).requestFocus();
        }
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN) {
                int next = code == KeyEvent.KEYCODE_DPAD_UP ? Math.max(0, cur - 1) : Math.min(rows.size() - 1, cur + 1);
                rows.get(next).requestFocus();
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

    private void updateNativeChrome() {
        if (nativePlayer == null || nativeSeek == null || nativeTime == null) return;
        long pos = nativePosSeconds();
        long dur = nativeDurSeconds();
        boolean isLive = "live".equals(nativeMode);
        boolean canSeek = !isLive && nativeVodSeekable();
        if (!nativeUserSeeking) {
            nativeSeek.setEnabled(canSeek);
            nativeSeek.setVisibility(isLive ? View.GONE : View.VISIBLE);
            nativeSeek.setProgress(!isLive && dur > 0 ? (int) Math.min(1000, Math.max(0, (pos * 1000) / dur)) : 0);
        }
        if (nativeGuideBtn != null) nativeGuideBtn.setVisibility(View.VISIBLE);
        if (nativeRewBtn != null) nativeRewBtn.setVisibility(isLive ? View.GONE : View.VISIBLE);
        if (nativeFwdBtn != null) nativeFwdBtn.setVisibility(isLive ? View.GONE : View.VISIBLE);
        setNativeButtonEnabled(nativeCcBtn, nativeSubtitleHasOptions());
        setNativeButtonEnabled(nativeAudioBtn, nativeAudioHasOptions());
        setNativeButtonEnabled(nativeQualityBtn, "video".equals(nativeMode) && nativeHasQualityChoices);
        setNativeButtonEnabled(nativeNextBtn, "video".equals(nativeMode) && nativeHasNext);
        if (nativeElapsed != null) nativeElapsed.setText(isLive ? "LIVE" : fmtNative(pos));
        nativeTime.setText(!isLive ? (dur > 0 ? fmtNative(dur) : "--:--") : "");
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
                nativeEndsAt.setText("Live TV");
                nativeEndsAt.setVisibility(View.VISIBLE);
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

    private MediaItem buildNativeMediaItem() {
        MediaItem.Builder media = new MediaItem.Builder().setUri(nativeUrl);
        if ("application/x-mpegURL".equals(nativeMime)) media.setMimeType(MimeTypes.APPLICATION_M3U8);
        else if ("video/mp2t".equals(nativeMime)) media.setMimeType(MimeTypes.VIDEO_MP2T);
        else if ("video/mp4".equals(nativeMime)) media.setMimeType(MimeTypes.VIDEO_MP4);
        return media.build();
    }

    private DefaultMediaSourceFactory nativeMediaSourceFactory() {
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(true)
                .setUserAgent("TriboonTV/" + BuildConfig.VERSION_NAME)
                .setConnectTimeoutMs(12000)
                .setReadTimeoutMs("live".equals(nativeMode) ? NATIVE_LIVE_READ_TIMEOUT_MS : 18000);
        return new DefaultMediaSourceFactory(http);
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
        if (!"live".equals(nativeMode) || nativePlayer == null || nativeTriedFallback
                || nativeFallbackUrl == null || nativeFallbackUrl.isEmpty()) return false;
        nativeTriedFallback = true;
        nativeUrl = nativeFallbackUrl;
        nativeMime = nativeFallbackMime == null ? "" : nativeFallbackMime;
        nativeQualityLabel = "LIVE";
        nativeLiveUnhealthySinceMs = 0L;
        nativeLiveLastRecoveryMs = SystemClock.elapsedRealtime();
        if (nativePlayer.getPlaybackState() != Player.STATE_IDLE) nativePlayer.stop();
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
        if (nativePlayer.getPlaybackState() != Player.STATE_IDLE) nativePlayer.stop();
        nativePlayer.setMediaItem(buildNativeMediaItem());
        nativePlayer.prepare();
        nativePlayer.play();
    }

    private void notifyNativeVideoError(String msg, long pos, long dur) {
        String title = nativePlaybackTitle;
        String backdropUrl = nativePlaybackBackdropUrl;
        releaseNativePlayer(false);
        enterNativeFullscreenMode();
        showNativeLoading(title, backdropUrl);
        web.evaluateJavascript("window.__tvNativeVideoError && __tvNativeVideoError("
                + org.json.JSONObject.quote(msg == null || msg.isEmpty() ? "native startup stalled" : msg)
                + "," + pos + "," + dur + ")", null);
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
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(cleanUrl).openConnection();
                c.setConnectTimeout(7000);
                c.setReadTimeout(12000);
                c.setRequestProperty("Accept", "text/vtt,text/plain,*/*");
                StringBuilder sb = new StringBuilder();
                try (java.io.BufferedReader br = new java.io.BufferedReader(
                        new java.io.InputStreamReader(c.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = br.readLine()) != null) sb.append(line).append('\n');
                } finally {
                    c.disconnect();
                }
                java.util.ArrayList<NativeCue> cues = parseNativeVtt(sb.toString());
                runOnUiThread(() -> {
                    if (token != nativeSubtitleLoadToken) return;
                    nativeSubtitleCues.clear();
                    nativeSubtitleCues.addAll(cues);
                    nativeSubtitleHandler.removeCallbacks(nativeSubtitleTick);
                    updateNativeSubtitleOverlay();
                    if (!nativeSubtitleCues.isEmpty()) nativeSubtitleHandler.postDelayed(nativeSubtitleTick, 250);
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    if (token != nativeSubtitleLoadToken) return;
                    clearNativeSubtitleOverlay();
                    Toast.makeText(this, "Subtitles could not load", Toast.LENGTH_SHORT).show();
                });
            }
        }, "triboon-subtitles").start();
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
                if (label == null || label.isEmpty()) label = rel.isEmpty() ? "Show subtitle versions" : nativeLabelForSubtitleRel(rel);
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
            labels.add("Sync: subtitles later +0.5s" + nativeSubShiftLabel());
            selected.add(false);
            syncEarlierIndex = labels.size();
            labels.add("Sync: subtitles earlier -0.5s" + nativeSubShiftLabel());
            selected.add(false);
            if (Math.abs(nativeSubtitleShift) >= 0.05f) {
                resetIndex = labels.size();
                labels.add("Reset subtitle sync");
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
        if (trackType == C.TRACK_TYPE_TEXT && choice.subtitleRel != null) {
            nativeSubtitleRel = choice.subtitleRel;
            nativeSubtitleLabel = choice.label;
            nativeSubtitleLang = nativeLangFromSubtitleRel(choice.subtitleRel);
            String selectedSubtitleUrl = subtitleUrlForRel(choice.subtitleRel);
            nativeSubtitleShift = nativeShiftFromUrl(selectedSubtitleUrl);
            nativeSubtitleUrl = stripNativeQueryParam(selectedSubtitleUrl, "shift");
            nativeHasWyzieSubtitle = !nativeSubtitleUrl.isEmpty();
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
                nativeSubtitleShift = 0f;
                nativeHasWyzieSubtitle = false;
                clearNativeSubtitleOverlay();
                notifyNativeSubtitleSelect(null);
            }
        } else {
            if (trackType == C.TRACK_TYPE_TEXT) {
                nativeSubtitleRel = "";
                nativeSubtitleUrl = "";
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
        return (lang.isEmpty() ? "Subtitles" : lang) + " - Auto match";
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

    private String nativeCodecName(String mime, String codecs) {
        String v = (mime != null && !mime.isEmpty()) ? mime : (codecs == null ? "" : codecs);
        v = v.toLowerCase(java.util.Locale.US);
        if (v.contains("eac3") || v.contains("e-ac-3")) return "E-AC3";
        if (v.contains("ac3") || v.contains("ac-3")) return "AC3";
        if (v.contains("dts")) return "DTS";
        if (v.contains("aac")) return "AAC";
        if (v.contains("opus")) return "Opus";
        if (v.contains("flac")) return "FLAC";
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
        if (nativeSheetReturnFocus != null) nativeSheetReturnFocus.requestFocus();
        nativeSheetReturnFocus = null;
        nativeSheetRestoreIndex = -1;
        showNativeChrome(false);
    }

    private void showNativeChoiceSheet(String title, String[] labels, NativeChoiceHandler handler) {
        showNativeChoiceSheet(title, labels, null, handler);
    }

    private void showNativeChoiceSheet(String title, String[] labels, boolean[] selectedRows, NativeChoiceHandler handler) {
        if (nativeSheet == null) return;
        nativeProgress.removeCallbacks(nativeHideChrome);
        nativeSheetReturnFocus = getCurrentFocus();
        nativeSheet.removeAllViews();

        TextView head = new TextView(this);
        head.setText(title);
        head.setTextColor(0xFFF9F4FF);
        head.setTextSize(13);
        head.setTypeface(Typeface.DEFAULT_BOLD);
        head.setPadding(dp(6), 0, dp(6), dp(8));
        nativeSheet.addView(head, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        for (int i = 0; i < labels.length; i++) {
            final int index = i;
            boolean selected = selectedRows != null && i < selectedRows.length && selectedRows[i];
            TextView row = nativeSheetRow(labels[i], selected);
            row.setOnClickListener(v -> {
                hideNativeSheet();
                handler.choose(index);
            });
            nativeSheet.addView(row);
        }

        nativeSheet.setVisibility(View.VISIBLE);
        nativeSheet.bringToFront();
        int focusIndex = nativeSheetRestoreIndex >= 0 ? nativeSheetRestoreIndex + 1 : 1;
        nativeSheetRestoreIndex = -1;
        if (nativeSheet.getChildCount() > 1) {
            focusIndex = Math.max(1, Math.min(nativeSheet.getChildCount() - 1, focusIndex));
            nativeSheet.getChildAt(focusIndex).requestFocus();
        }
    }

    private TextView nativeSheetRow(String label, boolean selected) {
        TextView row = new TextView(this);
        row.setText(label);
        row.setTextColor(selected ? 0xFFF9F4FF : 0xDDF3EFF7);
        row.setTextSize(11);
        row.setTypeface(Typeface.DEFAULT_BOLD);
        row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setSingleLine(true);
        row.setFocusable(true);
        row.setClickable(true);
        row.setPadding(dp(12), 0, dp(12), 0);
        row.setBackground(nativeSheetRowBg(false, selected));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(32));
        lp.topMargin = dp(3);
        row.setLayoutParams(lp);
        row.setOnFocusChangeListener((v, hasFocus) -> {
            v.setBackground(nativeSheetRowBg(hasFocus, selected));
            ((TextView) v).setTextColor(hasFocus ? 0xFF0B0812 : selected ? 0xFFF9F4FF : 0xDDF3EFF7);
        });
        return row;
    }

    private GradientDrawable nativeSheetRowBg(boolean focused, boolean selected) {
        GradientDrawable d = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                focused
                        ? new int[]{0xFFEDE8F5, 0xFFD8C8E8}
                        : selected
                        ? new int[]{0x553A1647, 0x44281436}
                        : new int[]{0x1812091D, 0x2212091D});
        d.setCornerRadius(dp(8));
        d.setStroke(dp(1), focused ? 0x77F3EFF7 : selected ? 0x55F3EFF7 : 0x00000000);
        return d;
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
                    web.evaluateJavascript("window.__tvNativeVideoProgress && __tvNativeVideoProgress("
                            + nativePosSeconds() + "," + nativeDurSeconds() + ")", null);
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
        if (now - nativeLiveUnhealthySinceMs >= NATIVE_LIVE_STALL_RECOVERY_MS) {
            recoverNativeLivePlayback(state == Player.STATE_IDLE ? "idle" : (state == Player.STATE_BUFFERING ? "buffering" : "stalled"));
        }
    }

    private void updateNativeVideoWatchdog() {
        if (!"video".equals(nativeMode) || nativePlayer == null) return;
        int state = nativePlayer.getPlaybackState();
        if (state == Player.STATE_READY && nativePlayer.isPlaying()) {
            nativeVideoUnhealthySinceMs = 0L;
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
        if (now - nativeVideoUnhealthySinceMs >= NATIVE_VIDEO_STARTUP_STALL_MS) {
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
        if (nativeSheet != null) {
            nativeSheet.setVisibility(View.GONE);
            nativeSheet.removeAllViews();
        }
        if (nativeControlShade != null) nativeControlShade.setVisibility(View.GONE);
        if (nativeMetaBar != null) nativeMetaBar.setVisibility(View.GONE);
        nativeSheetReturnFocus = null;
        String mode = nativeMode;
        long pos = nativePosSeconds();
        long dur = nativeDurSeconds();
        boolean guideMode = nativeGuideMode;
        nativeGuideMode = preserveGuideMode && guideMode;
        if (nativePlayer != null) {
            nativePlayerView.setPlayer(null);
            nativePlayer.release();
            nativePlayer = null;
        }
        nativeMode = "";
        nativeKind = "direct";
        nativeQualityLabel = "1080p";
        nativeUrl = "";
        nativeMime = "";
        nativeFallbackUrl = "";
        nativeFallbackMime = "";
        nativePlaybackTitle = "Triboon";
        nativePlaybackBackdropUrl = "";
        nativeTriedFallback = false;
        nativeLiveUnhealthySinceMs = 0L;
        nativeLiveLastRecoveryMs = 0L;
        nativeVideoUnhealthySinceMs = 0L;
        nativeSeekDpadMode = false;
        nativeOpenSubtitleMenuAfterRefresh = false;
        nativeKnownDurationMs = 0L;
        nativePendingStartMs = 0L;
        nativeStartSeekIssuedAtMs = 0L;
        nativeStartOffsetMs = 0L;
        nativeHasNext = false;
        nativeHasQualityChoices = false;
        nativeSubtitleUrl = "";
        nativeSubtitleLang = "";
        nativeSubtitleLabel = "";
        nativeSubtitleRel = "";
        clearNativeSubtitleChoices();
        nativeSubtitleCues.clear();
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
        if (nativePlayerLayer != null) nativePlayerLayer.setVisibility(View.GONE);
        if (waitForLiveClose) {
            web.postDelayed(this::showWebAfterNativePlayback, 80);
            return;
        }
        showWebAfterNativePlayback();
    }

    private void showWebAfterNativePlayback() {
        web.setVisibility(View.VISIBLE);
        web.requestFocus();
    }

    // ---------- first-run / connection-error screen ----------
    private void buildSetupScreen() {
        setup = new LinearLayout(this);
        setup.setOrientation(LinearLayout.VERTICAL);
        setup.setGravity(android.view.Gravity.CENTER);
        setup.setBackgroundColor(0xFF0B0812);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        setup.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText(R.string.setup_title);
        title.setTextColor(Color.WHITE);
        title.setTextSize(26);
        title.setPadding(0, 0, 0, pad / 2);
        setup.addView(title);

        setupMsg = new TextView(this);
        setupMsg.setTextColor(0xFFFB8B3C); // --coral
        setupMsg.setTextSize(15);
        setupMsg.setPadding(0, 0, 0, pad / 2);
        setup.addView(setupMsg);

        addr = new EditText(this);
        addr.setHint(R.string.setup_hint);
        addr.setTextColor(Color.WHITE);
        addr.setHintTextColor(0x66FFFFFF);
        addr.setSingleLine(true);
        addr.setMinWidth((int) (420 * getResources().getDisplayMetrics().density));
        setup.addView(addr);

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
        setup.addView(help);

        setup.setVisibility(View.GONE);
        root.addView(setup, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void showSetup(String message) {
        setupMsg.setText(message == null ? "" : message);
        String saved = prefs().getString(KEY_SERVER, "");
        if (!saved.isEmpty()) addr.setText(saved);
        setup.setVisibility(View.VISIBLE);
        addr.requestFocus();
    }

    private void connect() {
        String url = addr.getText().toString().trim();
        if (url.isEmpty()) return;
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://" + url;
        url = url.replaceAll("/+$", "");
        prefs().edit().putString(KEY_SERVER, url).apply();
        setup.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.requestFocus();
        web.loadUrl(url);
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
                    if (e.getAction() == KeyEvent.ACTION_UP) closeNativeGuideMode();
                    return true;
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
                if (guideDomKey != null && !pageInputFocused) {
                    if (e.getAction() == KeyEvent.ACTION_DOWN) jsKey("keydown", guideDomKey, e.getRepeatCount() > 0);
                    else if (e.getAction() == KeyEvent.ACTION_UP) jsKey("keyup", guideDomKey, false);
                    return true;
                }
                return super.dispatchKeyEvent(e);
            }
            if (code == KeyEvent.KEYCODE_BACK) {
                if (e.getAction() == KeyEvent.ACTION_UP) {
                    if (nativeSheetOpen()) hideNativeSheet();
                    else closeNativePlayback(true);
                }
                return true;
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
            if (e.getAction() == KeyEvent.ACTION_UP) handleBack();
            return true; // never let the WebView do raw history.back()
        }

        // The shell OWNS the D-pad: every arrow/OK press becomes a synthetic DOM key event
        // (keydown with the repeat flag + keyup, which the web app's long-press OK needs).
        // Letting the WebView see them would ALSO run its built-in spatial navigation —
        // two focus systems fighting is exactly the "D-pad is a mess" failure mode.
        // Exception: while the page has a text field/dropdown focused, native handling
        // (caret movement, IME, select pickers) must win — the JS bridge tells us.
        String domKey = domKeyFor(code);
        if (domKey != null && !pageInputFocused && setup.getVisibility() != View.VISIBLE) {
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
        web.evaluateJavascript("window.__tvMusicTransport && window.__tvMusicTransport('"
                + action + "')", null);
    }

    // BACK walks up through the web app (player → detail → home). The page's __tvBack()
    // answers 'exit' only at the home root; then BACK-twice within 2s leaves the app.
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
            android.content.Intent i = new android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            startActivityForResult(i, REQ_VOICE);
        } catch (Exception ex) {
            Toast.makeText(this, "Voice input isn't available on this device", Toast.LENGTH_SHORT).show();
            voiceResult("");
        }
    }

    private void listenInApp() {
        if (speech != null) { speech.destroy(); speech = null; }
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
            private void done() { if (speech != null) { speech.destroy(); speech = null; } }
        });
        speech.startListening(i);
    }

    // Empty text = cancelled/failed: the page just stops the mic pulse animation.
    private void voiceResult(String text) {
        web.evaluateJavascript("window.__tvVoice && __tvVoice(" + org.json.JSONObject.quote(text) + ")", null);
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
        web.evaluateJavascript("window.__tvVoice && __tvVoice(" + org.json.JSONObject.quote(text) + ")", null);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Stop playback/audio when the app is backgrounded (TV home button).
        closeNativePlayback(true);
        web.evaluateJavascript("document.querySelectorAll('video').forEach(v=>v.pause())", null);
    }

    @Override
    protected void onDestroy() {
        releaseNativePlayer(false);
        if (speech != null) { speech.destroy(); speech = null; }
        super.onDestroy();
    }
}
