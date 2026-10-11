package in.moderndairy.drivers;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/*
 * The web page's handle on TrackingService. The page decides WHEN a ride
 * starts (Start Ride) and draws what the service reports; the service does
 * the recording, the saving and the sending on its own, screen or no screen.
 */
@CapacitorPlugin(name = "NativeTracking")
public class NativeTrackingPlugin extends Plugin implements TrackingService.Listener {

    @Override
    public void load() {
        TrackingService.listener = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (TrackingService.listener == this) TrackingService.listener = null;
        super.handleOnDestroy();
    }

    @Override
    public void onFix(JSONObject fix) {
        try { notifyListeners("fix", JSObject.fromJSONObject(fix)); } catch (Exception ignored) { /* no page */ }
    }

    @Override
    public void onState(JSONObject state) {
        try { notifyListeners("state", JSObject.fromJSONObject(state)); } catch (Exception ignored) { /* no page */ }
    }

    private SharedPreferences prefs() {
        return TrackingService.prefs(getContext());
    }

    /* Server address, tokens and intervals — everything the service needs to
     * upload without the page. Sent again whenever any of them changes. */
    @PluginMethod
    public void configure(PluginCall call) {
        SharedPreferences.Editor e = prefs().edit();
        for (String k : new String[] { "apiBase", "accessToken", "refreshToken", "deviceId", "appVersion" }) {
            String v = call.getString(k);
            if (v != null) e.putString(k, v);
        }
        for (String k : new String[] { "sampleIntervalSec", "uploadIntervalSec", "healthIntervalSec", "maxBatchPoints" }) {
            Double v = call.getDouble(k);
            if (v != null && v > 0) e.putInt(k, v.intValue());
        }
        e.apply();
        call.resolve();
    }

    /* Start Ride. registered=false: started with no signal; the service
     * registers it with the server, under this id, once it can. */
    @PluginMethod
    public void start(PluginCall call) {
        String rideId = call.getString("rideId");
        if (rideId == null) { call.reject("rideId is required"); return; }
        Double startedAt = call.getDouble("startedAt");
        Boolean registered = call.getBoolean("registered", true);
        SharedPreferences p = prefs();
        SharedPreferences.Editor e = p.edit();
        boolean sameRide = rideId.equals(p.getString("rideId", null));
        e.putBoolean("active", true);
        e.putString("rideId", rideId);
        e.putLong("rideStartedAt", startedAt == null ? System.currentTimeMillis() : startedAt.longValue());
        e.putBoolean("rideRegistered", registered == null || registered);
        if (!sameRide) {
            e.remove("serverRideId");
            e.putInt("points", 0);
            TrackingService.putDouble(e, "distanceM", 0d);
            e.putLong("keptTs", 0L);
        }
        String alias = call.getString("serverRideId");
        if (alias != null && !alias.equals(rideId)) e.putString("serverRideId", alias);
        e.remove("stoppedReason").remove("stoppedKind").remove("stoppedAt").remove("recorderError");
        e.apply();
        launch(TrackingService.ACTION_START, true);
        call.resolve(status());
    }

    /* The app opened: make sure a running ride is being recorded (after the
     * phone restarted the app, or the service was killed). */
    @PluginMethod
    public void ensure(PluginCall call) {
        if (prefs().getBoolean("active", false) && !TrackingService.recording) launch(TrackingService.ACTION_START, true);
        call.resolve(status());
    }

    /* The ride is over (the office stopped it). Recording stops; fixes still
     * waiting are sent, then the service ends. */
    @PluginMethod
    public void stop(PluginCall call) {
        prefs().edit().putBoolean("active", false).apply();
        if (TrackingService.running) launch(TrackingService.ACTION_STOP, false);
        call.resolve(status());
    }

    /* Send now (network back, app opened). */
    @PluginMethod
    public void flush(PluginCall call) {
        prefs().edit().putLong("nextAttemptAt", 0L).apply();
        if (TrackingService.running || TrackingStore.get(getContext()).unsentCount() > 0) {
            launch(TrackingService.ACTION_FLUSH, prefs().getBoolean("active", false));
        }
        call.resolve(status());
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    /* The ride's route so far, for the map: [[lng, lat, ts], …]. */
    @PluginMethod
    public void track(PluginCall call) {
        String ride = call.getString("rideId", prefs().getString("rideId", null));
        JSObject out = new JSObject();
        try {
            out.put("points", ride == null ? new JSArray() : new JSArray(TrackingStore.get(getContext()).track(ride, 5000).toString()));
        } catch (Exception e) {
            out.put("points", new JSArray());
        }
        call.resolve(out);
    }

    private void launch(String action, boolean foreground) {
        Context c = getContext();
        Intent i = new Intent(c, TrackingService.class).setAction(action);
        try {
            if (foreground && Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (Exception e) {
            prefs().edit().putString("recorderError", "could not start the recorder: " + e.getClass().getSimpleName()).apply();
        }
    }

    private JSObject status() {
        SharedPreferences p = prefs();
        TrackingStore store = TrackingStore.get(getContext());
        JSObject o = new JSObject();
        o.put("available", true);
        o.put("running", TrackingService.running);
        o.put("recording", TrackingService.recording);
        o.put("active", p.getBoolean("active", false));
        o.put("rideId", p.getString("rideId", null));
        o.put("serverRideId", p.getString("serverRideId", null));
        o.put("rideRegistered", p.getBoolean("rideRegistered", true));
        o.put("rideStartedAt", p.getLong("rideStartedAt", 0L));
        o.put("queued", store.unsentCount());
        long oldest = store.oldestUnsent();
        o.put("oldestQueuedAt", oldest > 0 ? oldest : null);
        o.put("lastFixAt", p.getLong("lastFixAt", 0L));
        o.put("lastLat", TrackingService.getDouble(p, "lastLat"));
        o.put("lastLng", TrackingService.getDouble(p, "lastLng"));
        o.put("lastAccuracyM", p.getFloat("lastAcc", -1f));
        o.put("lastUploadOkAt", p.getLong("lastUploadOkAt", 0L));
        o.put("lastUploadError", p.getString("lastUploadError", null));
        o.put("uploadFailures", p.getInt("uploadFailures", 0));
        o.put("nextAttemptAt", p.getLong("nextAttemptAt", 0L));
        o.put("authError", p.getString("authError", null));
        o.put("recorderError", p.getString("recorderError", null));
        o.put("points", p.getInt("points", 0));
        o.put("distanceM", TrackingService.getDouble(p, "distanceM"));
        o.put("stoppedReason", p.getString("stoppedReason", null));
        o.put("stoppedKind", p.getString("stoppedKind", null));
        o.put("stoppedAt", p.getLong("stoppedAt", 0L));
        o.put("gpsEnabled", TrackingService.gpsOn(getContext()));
        o.put("online", TrackingService.online(getContext()));
        return o;
    }
}
