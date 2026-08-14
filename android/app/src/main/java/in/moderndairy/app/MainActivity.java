package in.moderndairy.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

/**
 * External links (http/https to other origins, tel:, mailto:, whatsapp/instagram deep links,
 * maps) are handed off to system apps instead of loading inside the app's WebView.
 *
 * This client MUST extend Capacitor's BridgeWebViewClient (not a plain WebViewClient) — the
 * bridge client's shouldInterceptRequest() is what serves the bundled local assets under
 * https://localhost/*. Replacing it with a bare WebViewClient (as an earlier version of this
 * file did) drops that interception, so the WebView ends up making a real network request to
 * https://localhost/ and fails with ERR_CONNECTION_REFUSED on a physical device.
 */
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    Bridge bridge = this.bridge;
    bridge.getWebView().setWebViewClient(new BridgeWebViewClient(bridge) {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        String scheme = uri.getScheme();
        String host = uri.getHost();

        if (scheme == null) {
          return super.shouldOverrideUrlLoading(view, request);
        }

        boolean isAppOrigin = "file".equals(scheme)
          || ("https".equals(scheme) && "localhost".equals(host))
          || "capacitor".equals(scheme);

        if (isAppOrigin) {
          return super.shouldOverrideUrlLoading(view, request);
        }

        if ("tel".equals(scheme) || "mailto".equals(scheme) || "sms".equals(scheme)
          || "whatsapp".equals(scheme) || "geo".equals(scheme) || "intent".equals(scheme)
          || "http".equals(scheme) || "https".equals(scheme)) {
          return openExternally(uri);
        }

        return super.shouldOverrideUrlLoading(view, request);
      }

      private boolean openExternally(Uri uri) {
        try {
          startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
          // No app installed to handle this link; ignore rather than crash.
        }
        return true;
      }
    });
  }
}
