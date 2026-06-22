-keepattributes *Annotation*

# WebView calls these methods by their JavaScript names.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Activity and Media3 callbacks are reached by framework reflection/callback dispatch.
-keep class app.triboon.tv.MainActivity { *; }
-keep class app.triboon.tv.MainActivity$Native* { *; }
