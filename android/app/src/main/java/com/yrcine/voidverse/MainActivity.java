package com.yrcine.voidverse;

import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        w.setStatusBarColor(0xFF0D0C1E);
        w.setNavigationBarColor(0xFF0D0C1E);

        WebView wv = bridge.getWebView();
        if (wv != null) {
            // kill web-only feel: no overscroll glow, no scrollbars, no pinch zoom
            wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
            wv.setHorizontalScrollBarEnabled(false);
            wv.setVerticalScrollBarEnabled(false);
            WebSettings s = wv.getSettings();
            s.setSupportZoom(false);
            s.setBuiltInZoomControls(false);
            s.setDisplayZoomControls(false);
            s.setTextZoom(100);
            // players: allow autoplay and keep embeds working
            s.setMediaPlaybackRequiresUserGesture(false);
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptThirdPartyCookies(wv, true);
            wv.setHapticFeedbackEnabled(false);
            // suppress the native long-press text-selection menu; the app's own JS gestures still work
            wv.setOnLongClickListener(v -> true);
        }
    }
}
