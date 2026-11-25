package dev.transdesk.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.ConsoleMessage;
import android.webkit.MimeTypeMap;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

/**
 * 译台 TransDesk 的安卓外壳：一个只做本地文件服务的 WebView。
 *
 * <p>没有 INTERNET 权限，也没有任何第三方域名。页面挂在虚拟域 {@code https://transdesk.local}
 * 下，所有请求都被 {@link WebViewClient#shouldInterceptRequest} 拦下来，从 APK 的
 * {@code assets/www/} 里读文件返回。之所以要套一个 https 域而不是直接用
 * {@code file:///android_asset/}：Web Worker、ES Module、fetch、IndexedDB 都要求安全上下文，
 * file:// 下这些一律不可用，而译台的神经模型层正是跑在 Worker 里的。</p>
 *
 * <p>资源压缩交给系统：APK 里的 assets 是压缩存放的，{@code getAssets().open()} 会边读边解压，
 * 所以 100 MB 的模型不会额外占一份磁盘。</p>
 */
public class MainActivity extends Activity {

    private static final String DOMAIN = "transdesk.local";
    private static final String ROOT = "https://" + DOMAIN + "/index.html";
    private static final String ASSET_ROOT = "www";

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // 主题、方向等偏好存在 localStorage
        s.setDatabaseEnabled(true);            // 「我的词典」存在 IndexedDB
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);         // 图片翻译要从相册取图
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setTextZoom(100);

        web.setBackgroundColor(0xFFF4F1EA);
        web.setWebViewClient(new LocalAssetClient());
        web.setWebChromeClient(new Chrome());
        web.loadUrl(ROOT);
    }

    /** 把 https://transdesk.local/... 映射到 assets/www/...，其余一律拒绝。 */
    private final class LocalAssetClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri uri = req == null ? null : req.getUrl();
            if (uri == null || !DOMAIN.equals(uri.getHost())) {
                return reject(404, "Not Found");
            }
            String path = uri.getPath();
            if (path == null || path.isEmpty() || "/".equals(path)) {
                path = "/index.html";
            }
            if (path.contains("..")) {
                return reject(403, "Forbidden");
            }
            try {
                InputStream in = getAssets().open(ASSET_ROOT + path);
                WebResourceResponse res = new WebResourceResponse(mime(path), null, in);
                res.setStatusCodeAndReasonPhrase(200, "OK");
                return res;
            } catch (IOException e) {
                // 404 要如实返回：可选资源（例如模型清单）探测失败是正常流程。
                return reject(404, "Not Found");
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri uri = req.getUrl();
            if (uri != null && DOMAIN.equals(uri.getHost())) {
                return false;
            }
            return true;   // 外部链接一概不打开：这个 APP 不该出网
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
        }

        private WebResourceResponse reject(int code, String reason) {
            WebResourceResponse res = new WebResourceResponse(
                    "text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
            res.setStatusCodeAndReasonPhrase(code, reason);
            return res;
        }
    }

    /** 图片翻译的「选择文件」按钮：交给系统相册，不需要任何权限。 */
    private final class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
            }
            fileCallback = cb;
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("image/*");
            try {
                startActivityForResult(Intent.createChooser(pick, "选择图片"), 1);
            } catch (Exception e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            return true;   // 不把网页日志刷进 logcat
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (fileCallback == null) {
            return;
        }
        Uri[] out = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            out = new Uri[]{data.getData()};
        }
        fileCallback.onReceiveValue(out);
        fileCallback = null;
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) {
            web.onPause();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private static String mime(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".txt")) return "text/plain";
        String ext = MimeTypeMap.getFileExtensionFromUrl(p);
        String m = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m != null ? m : "application/octet-stream";
    }
}
