package in.moderndairy.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.BridgeActivity;

/**
 * External links (http/https to other origins, tel:, mailto:, whatsapp/instagram deep links,
 * maps) are handed off to system apps instead of loading inside the app's WebView. Local
 * bundled assets and Capacitor's own scheme stay inside the WebView untouched.
 */
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    this.bridge.getWebView().setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        String scheme = uri.getScheme();
        String host = uri.getHost();

        if (scheme == null) {
          return false;
        }

        boolean isAppOrigin = "file".equals(scheme)
          || "https".equals(scheme) && "localhost".equals(host)
          || "capacitor".equals(scheme);

        if (isAppOrigin) {
          return false;
        }

        if ("tel".equals(scheme) || "mailto".equals(scheme) || "sms".equals(scheme)
          || "whatsapp".equals(scheme) || "geo".equals(scheme) || "intent".equals(scheme)) {
          return openExternally(uri);
        }

        if ("http".equals(scheme) || "https".equals(scheme)) {
          return openExternally(uri);
        }

        return false;
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
