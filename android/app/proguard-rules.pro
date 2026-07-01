-keepattributes *Annotation*

# WebView calls these methods by their JavaScript names.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Activity and Media3 callbacks are reached by framework reflection/callback dispatch.
-keep class app.triboon.tv.MainActivity { *; }
-keep class app.triboon.tv.MainActivity$Native* { *; }

# The Cast OptionsProvider is instantiated reflectively from the manifest meta-data — R8 must not
# strip or rename it, or Cast silently fails to initialize on release builds.
-keep class app.triboon.tv.CastOptionsProvider { *; }
