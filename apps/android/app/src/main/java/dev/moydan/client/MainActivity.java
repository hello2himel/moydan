package dev.moydan.client;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;

/**
 * Moydan Android shell.
 *
 * <p>Loads the web application of a Moydan deployment in a hardened WebView. The
 * untrusted game frames are themselves sandboxed iframes on a separate origin, and this
 * shell deliberately keeps file access, content-provider access and universal file
 * bridging switched off.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "moydan";
    private static final String KEY_SERVER = "server_url";

    private WebView web;
    private TextView status;
    private FrameLayout root;
    private SharedPreferences prefs;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0b0b10"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b0b10"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setGeolocationEnabled(false);
        settings.setSaveFormData(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) {
                    return false;
                }
                if (isSameDeployment(uri)) {
                    return false;
                }
                // Never navigate the shell to a foreign origin: hand it to the
                // system browser instead (share links, licences, repositories).
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    Toast.makeText(MainActivity.this, R.string.cannot_open_link, Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                status.setVisibility(View.GONE);
            }
        });

        web.setWebChromeClient(new WebChromeClient());

        status = new TextView(this);
        status.setTextColor(Color.parseColor("#e8e8f0"));
        status.setTextSize(16);
        status.setPadding(32, 64, 32, 32);
        status.setGravity(android.view.Gravity.CENTER_HORIZONTAL);
        status.setVisibility(View.GONE);

        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(status, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setContentView(root);

        String server = prefs.getString(KEY_SERVER, BuildConfig.DEFAULT_SERVER_URL);
        if (server == null || server.trim().isEmpty()) {
            server = BuildConfig.DEFAULT_SERVER_URL;
        }
        if (!looksLikeUrl(server)) {
            showServerDialog(server);
            return;
        }
        load(server);
    }

    private boolean looksLikeUrl(String value) {
        String v = value.trim();
        if (!v.startsWith("http://") && !v.startsWith("https://")) {
            return false;
        }
        return !v.contains("moydan.example");
    }

    private boolean isSameDeployment(Uri uri) {
        String configured = prefs.getString(KEY_SERVER, BuildConfig.DEFAULT_SERVER_URL);
        try {
            Uri base = Uri.parse(configured == null ? BuildConfig.DEFAULT_SERVER_URL : configured);
            return base.getHost() != null && base.getHost().equals(uri.getHost());
        } catch (Exception e) {
            return false;
        }
    }

    private void load(String url) {
        String normalised = url.trim();
        while (normalised.endsWith("/")) {
            normalised = normalised.substring(0, normalised.length() - 1);
        }
        prefs.edit().putString(KEY_SERVER, normalised).apply();
        status.setVisibility(View.VISIBLE);
        status.setText(getString(R.string.loading_server, normalised));
        web.loadUrl(normalised + "/feed/foryou");
    }

    private void showServerDialog(String current) {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint(getString(R.string.server_url_hint));
        input.setText(current == null ? "" : current);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        input.setPadding(pad, pad, pad, pad);

        new AlertDialog.Builder(this)
                .setTitle(R.string.choose_server)
                .setMessage(R.string.choose_server_message)
                .setView(input)
                .setCancelable(false)
                .setPositiveButton(R.string.connect, (dialog, which) -> {
                    String value = input.getText().toString().trim();
                    if (!value.startsWith("http://") && !value.startsWith("https://")) {
                        Toast.makeText(MainActivity.this, R.string.invalid_url, Toast.LENGTH_LONG).show();
                        showServerDialog(current);
                        return;
                    }
                    load(value);
                })
                .show();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        MenuItem item = menu.add(Menu.NONE, 1, Menu.NONE, R.string.change_server);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) {
            showServerDialog(prefs.getString(KEY_SERVER, BuildConfig.DEFAULT_SERVER_URL));
            return true;
        }
        return super.onOptionsItemSelected(item);
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
    protected void onDestroy() {
        if (web != null) {
            ArrayList<String> unused = new ArrayList<>();
            web.loadUrl("about:blank");
            web.removeAllViews();
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
