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
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
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
       v3.9 OFFLINE GAMES — local file server on 127.0.0.1.
       Games are downloaded to app storage (yrgames/{gid}/...) and served
       to the HTML5 player from loopback, so relative asset paths, ren'py's
       Range reads and wasm loads all work with zero network access.
       ------------------------------------------------------------------ */
    private static final String GAME_CDN = "https://content-cdn.adultgames.games/games-html/";
    private File gameRoot;
    private int gamePort = 8791;
    private final Object dlLock = new Object();

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
            // interstitial / 18+-gate networks (the "Attention!" popups)
            "revenuehits.com", "monetag.com", "media.net", "a-ads.com",
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
            // v3.9: offline-games bridge + allow the loopback http player inside the https app
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            startGameServer();
            wv.addJavascriptInterface(new YRGames(), "YRGames");
        }
    }

    /* ================= v3.9: offline game store + loopback server ================= */

    private void startGameServer() {
        try {
            File ext = getExternalFilesDir(null);
            gameRoot = new File(ext != null ? ext : getFilesDir(), "yrgames");
            if (!gameRoot.exists()) gameRoot.mkdirs();
        } catch (Exception e) {
            gameRoot = new File(getFilesDir(), "yrgames");
            gameRoot.mkdirs();
        }
        for (int p = 8791; p <= 8800; p++) {
            try {
                final ServerSocket ss = new ServerSocket(p);
                gamePort = p;
                Thread t = new Thread(() -> {
                    while (true) {
                        try {
                            Socket sock = ss.accept();
                            serveGameSocket(sock);
                        } catch (Exception ignored) {
                        }
                    }
                });
                t.setDaemon(true);
                t.start();
                return;
            } catch (Exception ignored) {
            }
        }
    }

    private void serveGameSocket(Socket sock) {
        try {
            sock.setSoTimeout(15000);
            BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), "UTF-8"));
            String req = in.readLine();
            if (req == null) { sock.close(); return; }
            String[] parts = req.split(" ");
            if (parts.length < 2) { sock.close(); return; }
            String method = parts[0];
            String rawPath = parts[1];
            String range = null;
            String line;
            while ((line = in.readLine()) != null && !line.isEmpty()) {
                if (line.toLowerCase().startsWith("range:")) range = line.substring(6).trim();
            }
            String path = rawPath;
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);
            try { path = URLDecoder.decode(path, "UTF-8"); } catch (Exception ignored) {
            }
            if (!path.startsWith("/g/")) { writeGame(sock, 404, "text/plain", "not found".getBytes()); return; }
            String rest = path.substring(3);
            int slash = rest.indexOf('/');
            if (slash <= 0) { writeGame(sock, 404, "text/plain", "not found".getBytes()); return; }
            String gid = rest.substring(0, slash);
            String file = rest.substring(slash + 1);
            if (!gid.matches("[0-9]+") || file.contains("..") || file.startsWith("/")) {
                writeGame(sock, 404, "text/plain", "not found".getBytes());
                return;
            }
            File f = gameFile(gid, file);
            if (f == null) { writeGame(sock, 404, "text/plain", "not found".getBytes()); return; }
            byte[] all = readFile(f);
            String mime = guessMime(file);
            if (range != null && range.startsWith("bytes=")) {
                try {
                    String spec = range.substring(6);
                    int dash = spec.indexOf('-');
                    long a = Long.parseLong(spec.substring(0, dash).trim());
                    long b = dash + 1 < spec.length() && !spec.substring(dash + 1).trim().isEmpty()
                            ? Long.parseLong(spec.substring(dash + 1).trim())
                            : all.length - 1;
                    if (b >= all.length) b = all.length - 1;
                    if (a > b || a >= all.length) { writeGame(sock, 416, "text/plain", "bad range".getBytes()); return; }
                    int len = (int) (b - a + 1);
                    byte[] chunk = new byte[len];
                    System.arraycopy(all, (int) a, chunk, 0, len);
                    OutputStream os = sock.getOutputStream();
                    String h = "HTTP/1.1 206 Partial Content\r\nContent-Type: " + mime
                            + "\r\nContent-Length: " + len
                            + "\r\nContent-Range: bytes " + a + "-" + b + "/" + all.length
                            + "\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n";
                    os.write(h.getBytes("UTF-8"));
                    if (!method.equals("HEAD")) os.write(chunk);
                    os.flush();
                    sock.close();
                    return;
                } catch (Exception ignored) {
                }
            }
            OutputStream os = sock.getOutputStream();
            String h = "HTTP/1.1 200 OK\r\nContent-Type: " + mime
                    + "\r\nContent-Length: " + all.length
                    + "\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n";
            os.write(h.getBytes("UTF-8"));
            if (!method.equals("HEAD")) os.write(all);
            os.flush();
            sock.close();
        } catch (Exception ignored) {
            try { sock.close(); } catch (Exception ignored2) {
            }
        }
    }

    private void writeGame(Socket sock, int code, String mime, byte[] body) {
        try {
            OutputStream os = sock.getOutputStream();
            String reason = code == 404 ? "Not Found" : "Bad Request";
            String h = "HTTP/1.1 " + code + " " + reason + "\r\nContent-Type: " + mime
                    + "\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n";
            os.write(h.getBytes("UTF-8"));
            os.write(body);
            os.flush();
            sock.close();
        } catch (Exception ignored) {
        }
    }

    private File gameFile(String gid, String file) {
        File f = new File(new File(gameRoot, gid), file);
        if (f.isFile() && f.length() > 0) return f;
        fetchToGame(gid, file);
        f = new File(new File(gameRoot, gid), file);
        return (f.isFile() && f.length() > 0) ? f : null;
    }

    /** Download one game file from the CDN into local storage. */
    private boolean fetchToGame(String gid, String file) {
        synchronized (dlLock) {
            File f = new File(new File(gameRoot, gid), file);
            if (f.isFile() && f.length() > 0) return true;
            try {
                File parent = f.getParentFile();
                if (parent != null) parent.mkdirs();
                HttpURLConnection c = (HttpURLConnection) new URL(GAME_CDN + gid + "/" + file).openConnection();
                c.setConnectTimeout(20000);
                c.setReadTimeout(120000);
                c.setInstanceFollowRedirects(true);
                c.setRequestProperty("User-Agent",
                        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
                int code = c.getResponseCode();
                if (code >= 400) { c.disconnect(); return false; }
                File tmp = new File(f.getAbsolutePath() + ".part");
                InputStream is = c.getInputStream();
                FileOutputStream fos = new FileOutputStream(tmp);
                byte[] buf = new byte[65536];
                int n;
                while ((n = is.read(buf)) > 0) fos.write(buf, 0, n);
                fos.flush();
                fos.close();
                is.close();
                c.disconnect();
                if (tmp.length() == 0) { tmp.delete(); return false; }
                if (f.exists()) f.delete();
                tmp.renameTo(f);
                return true;
            } catch (Exception e) {
                return false;
            }
        }
    }

    private static byte[] readFile(File f) throws Exception {
        FileInputStream fis = new FileInputStream(f);
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = fis.read(buf)) > 0) bos.write(buf, 0, n);
        fis.close();
        return bos.toByteArray();
    }

    private static String guessMime(String file) {
        String f = file.toLowerCase(Locale.ROOT);
        if (f.endsWith(".html") || f.endsWith(".htm")) return "text/html; charset=utf-8";
        if (f.endsWith(".js")) return "application/javascript";
        if (f.endsWith(".wasm")) return "application/wasm";
        if (f.endsWith(".json")) return "application/json";
        if (f.endsWith(".zip")) return "application/zip";
        if (f.endsWith(".png")) return "image/png";
        if (f.endsWith(".jpg") || f.endsWith(".jpeg")) return "image/jpeg";
        if (f.endsWith(".gif")) return "image/gif";
        if (f.endsWith(".webp")) return "image/webp";
        if (f.endsWith(".css")) return "text/css";
        if (f.endsWith(".ico")) return "image/x-icon";
        if (f.endsWith(".mp3")) return "audio/mpeg";
        if (f.endsWith(".ogg")) return "audio/ogg";
        if (f.endsWith(".wav")) return "audio/wav";
        if (f.endsWith(".ttf")) return "font/ttf";
        if (f.endsWith(".woff")) return "font/woff";
        if (f.endsWith(".data")) return "application/octet-stream";
        return "application/octet-stream";
    }

    /** JS bridge: window.YRGames — offline game downloads. */
    private class YRGames {
        @JavascriptInterface
        public int getPort() {
            return gamePort;
        }

        @JavascriptInterface
        public String list() {
            try {
                org.json.JSONObject o = new org.json.JSONObject();
                File[] ds = gameRoot.listFiles();
                if (ds != null) {
                    for (File d : ds) {
                        if (d.isDirectory() && new File(d, "game.zip").isFile()) {
                            o.put(d.getName(), true);
                        }
                    }
                }
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void download(final String gid, final String cbId) {
            httpPool.execute(() -> {
                String[] core = {
                        "play.html", "index.html", "renpy-pre.js", "renpy.js",
                        "renpy.data", "renpy.wasm", "datafile_renpy.data",
                        "game.zip", "savegames.zip", "pwa_catalog.json",
                        "web-presplash.jpg", "manifest.json"
                };
                int done = 0;
                boolean gameZipOk = false;
                for (String file : core) {
                    emitDL(cbId, done, core.length, file);
                    boolean ok = fetchToGame(gid, file);
                    if (file.equals("game.zip")) gameZipOk = ok;
                    done++;
                }
                if (gameZipOk) {
                    emitDL(cbId, core.length, core.length, "done");
                } else {
                    emitDL(cbId, -1, core.length, "failed");
                }
            });
        }

        @JavascriptInterface
        public void remove(final String gid) {
            httpPool.execute(() -> {
                try {
                    if (gid != null && gid.matches("[0-9]+")) {
                        deleteRecursive(new File(gameRoot, gid));
                    }
                } catch (Exception ignored) {
                }
            });
        }
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) {
            for (File k : kids) deleteRecursive(k);
        }
        f.delete();
    }

    private void emitDL(String cbId, int done, int total, String note) {
        final WebView vw = mainWv;
        if (vw != null) {
            final String safeNote = note == null ? "" : note.replace("\\", "").replace("\"", "");
            vw.post(() -> vw.evaluateJavascript(
                    "window.__yrgdl && window.__yrgdl(" + cbId + "," + done + "," + total + ",\"" + safeNote + "\")",
                    null));
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
