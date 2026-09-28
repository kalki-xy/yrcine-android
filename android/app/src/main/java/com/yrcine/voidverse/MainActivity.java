package com.yrcine.voidverse;

import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    private final ExecutorService httpPool = Executors.newFixedThreadPool(4);
    private WebView mainWv;

    /* ------------------------------------------------------------------
       v3.2 AD SHIELD — native-level blocker for the embed players.
       Every subresource the WebView loads (including inside cross-origin
       player iframes) is checked against this denylist; ad networks get
       an empty 404 and top-level ad redirects are swallowed whole.
       ------------------------------------------------------------------ */
    private static final Set<String> AD_HOSTS = new HashSet<>(Arrays.asList(
            // Google ads / measurement
            "doubleclick.net", "googlesyndication.com", "googletagservices.com",
            "googleadservices.com", "adservice.google.com", "google-analytics.com",
            // major programmatic networks
            "adnxs.com", "criteo.com", "criteo.net", "taboola.com", "outbrain.com",
            "mgid.com", "revcontent.com", "adsrvr.org", "bidswitch.net",
            "casalemedia.com", "rubiconproject.com", "pubmatic.com", "openx.net",
            "smartadserver.com", "33across.com", "sharethrough.com", "yieldmo.com",
            "sonobi.com", "adform.net", "adroll.com", "agkn.com", "quantserve.com",
            "scorecardresearch.com", "adition.com", "smaato.net", "advertising.com",
            "lijit.com", "sovrn.com", "zergnet.com", "engageya.com", "plista.com",
            "buysellads.com", "carbonads.net", "adcash.com",
            // popunder / popup networks (the embed-player plague)
            "popads.net", "popcash.net", "hilltopads.net", "adsterra.com",
            "adsterra.net", "clickadu.com", "galaksion.com", "propellerads.com",
            "propellerclick.com", "popunder.net", "poptm.com", "onclickads.net",
            "bidvertiser.com", "infolinks.com", "ad-maven.com", "admaven.com",
            "realsrv.com", "exoclick.com", "exosrv.com", "exdynsrv.com",
            "tsyndicate.com", "juicyads.com", "juicyads.rocks", "trafficjunky.com",
            "trafficjunky.net", "popmyads.com", "adspyglass.com", "adspyglass.net",
            "adskeeper.com", "adskeeper.co.uk", "directexpose.com",
            // video-ad servers (pre-rolls / overlays)
            "teads.tv", "springserve.com", "spotxchange.com", "spotx.tv",
            "freewheel.tv", "freewheel.net", "servenobid.com",
            "doubleverify.com", "moatads.com",
            "adsafeprotected.com", "iasds01.com",
            // push-notification spam
            "onesignal.com", "notix.io", "gravitec.net", "sendpulse.com",
            "truepush.com", "pushwoosh.com", "webpushs.com",
            // misc counters
            "histats.com", "statcounter.com", "amung.us", "adriver.ru"
    ));

    static boolean isAdHost(String host) {
        if (host == null || host.isEmpty()) return false;
        host = host.toLowerCase(Locale.ROOT);
        if (AD_HOSTS.contains(host)) return true;
        // block any subdomain of a denied host
        int dot = host.indexOf('.');
        while (dot != -1) {
            if (AD_HOSTS.contains(host.substring(dot + 1))) return true;
            dot = host.indexOf('.', dot + 1);
        }
        return false;
    }

    private class AdBlockClient extends com.getcapacitor.BridgeWebViewClient {
        AdBlockClient(Bridge b) { super(b); }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            try {
                Uri u = request.getUrl();
                if (u != null && isAdHost(u.getHost())) {
                    return new WebResourceResponse("text/plain", "utf-8",
                            new ByteArrayInputStream(new byte[0]));
                }
            } catch (Exception ignored) {
            }
            return super.shouldInterceptRequest(view, request);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            try {
                Uri u = request.getUrl();
                // swallow ad redirects silently — never let them take the app over
                if (u != null && isAdHost(u.getHost())) return true;
            } catch (Exception ignored) {
            }
            return super.shouldOverrideUrlLoading(view, request);
        }
    }

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
            // v3.2: native ad shield rides on top of Capacitor's client
            wv.setWebViewClient(new AdBlockClient(bridge));
            // v3.3: popups die at the native level (onCreateWindow unhandled -> dropped).
            // This replaces the iframe sandbox approach, which broke embed playback.
            s.setSupportMultipleWindows(true);
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
