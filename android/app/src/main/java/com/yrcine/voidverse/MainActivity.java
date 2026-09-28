package com.yrcine.voidverse;

import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    private final ExecutorService httpPool = Executors.newFixedThreadPool(4);
    private WebView mainWv;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        w.setStatusBarColor(0xFF0D0C1E);
        w.setNavigationBarColor(0xFF0D0C1E);

        WebView wv = bridge.getWebView();
        mainWv = wv;
        if (wv != null) {
            // kill web-only feel: no overscroll glow, no scrollbars, no pinch zoom
            wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
            wv.setHorizontalScrollBarEnabled(false);
            wv.setVerticalScrollBarEnabled(false);
            // perf: keep the renderer alive under memory pressure (stops random reloads)
            wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            WebSettings s = wv.getSettings();
            s.setSupportZoom(false);
            s.setBuiltInZoomControls(false);
            s.setDisplayZoomControls(false);
            s.setTextZoom(100);
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptThirdPartyCookies(wv, true);
            wv.setHapticFeedbackEnabled(false);
            // suppress the native long-press text-selection menu; the app's own JS gestures still work
            wv.setOnLongClickListener(v -> true);
            // native fetch bridge: CORS-free HTTP GET for the app's JS (public CORS proxies are dead)
            wv.addJavascriptInterface(new NativeFetch(), "AndroidFetch");
        }
    }

    /** JS: window.AndroidFetch.get(url, id) -> window.__nfd(id, ok, {v: body}) */
    private class NativeFetch {
        @JavascriptInterface
        public void get(final String url, final String cbId) {
            httpPool.execute(() -> {
                String body = null;
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(12000);
                    c.setReadTimeout(12000);
                    c.setInstanceFollowRedirects(true);
                    c.setRequestProperty("User-Agent",
                            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
                    c.setRequestProperty("Accept", "application/json, text/plain, */*");
                    int code = c.getResponseCode();
                    BufferedReader r = new BufferedReader(new InputStreamReader(
                            code >= 400 ? c.getErrorStream() : c.getInputStream(), "UTF-8"));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = r.readLine()) != null) sb.append(line);
                    r.close();
                    body = sb.toString();
                } catch (Exception e) {
                    body = null;
                }
                final String payload = body;
                final WebView vw = mainWv;
                if (vw != null) {
                    vw.post(() -> {
                        String safe = "null";
                        if (payload != null) {
                            try {
                                safe = new org.json.JSONObject().put("v", payload).toString();
                            } catch (Exception ignored) {
                            }
                        }
                        vw.evaluateJavascript(
                                "window.__nfd && window.__nfd(" + cbId + ","
                                        + (payload == null ? "false" : "true") + "," + safe + ")",
                                null);
                    });
                }
            });
        }
    }
}
