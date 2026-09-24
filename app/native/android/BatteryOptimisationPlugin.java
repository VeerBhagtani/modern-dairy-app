package in.moderndairy.drivers;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/*
 * Whether Android may close this app to save battery, and a way to ask it not
 * to.
 *
 * The single most common reason a ride stops recording on a phone in India:
 * Xiaomi, Realme, Vivo, Oppo and Samsung all close background apps to save
 * battery, and a foreground service with its notification showing does not
 * reliably prevent it. The exemption is one system dialog that only the driver
 * can answer; this plugin reports the current answer and opens that dialog.
 *
 * Copied into the generated Android project by scripts/add-native.js and
 * registered in MainActivity, because android/ is generated rather than
 * committed.
 */
@CapacitorPlugin(name = "BatteryOptimisation")
public class BatteryOptimisationPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("exempt", isExempt());
        // Named so the app can give the maker-specific steps that Android's own
        // exemption does not cover (Xiaomi's Autostart, Vivo's background power).
        result.put("manufacturer", Build.MANUFACTURER);
        result.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(result);
    }

    @PluginMethod
    public void requestExemption(PluginCall call) {
        JSObject result = new JSObject();
        if (isExempt()) {
            result.put("exempt", true);
            call.resolve(result);
            return;
        }
        Context context = getContext();
        // The direct dialog: "Let Modern Drivers always run in background?"
        Intent ask = new Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + context.getPackageName())
        );
        ask.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(ask);
        } catch (Exception direct) {
            // Some makers remove that dialog. The full list is the fallback,
            // where the driver has to find the app themselves.
            try {
                Intent list = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                list.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(list);
            } catch (Exception none) {
                call.reject("This phone has no battery optimisation screen.", "UNAVAILABLE");
                return;
            }
        }
        // The driver's answer arrives after they come back to the app, which
        // asks status() again then; this only says the dialog was shown.
        result.put("exempt", false);
        result.put("opened", true);
        call.resolve(result);
    }

    private boolean isExempt() {
        // Before Android 6 there was no battery optimisation to be exempt from.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return power != null && power.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }
}
