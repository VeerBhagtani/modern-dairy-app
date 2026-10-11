package in.moderndairy.drivers;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/*
 * The ride recorder: GPS, the phone's own queue, and the upload, all here.
 *
 * Why this exists. Until 2.3 the app recorded through a plugin whose service
 * was BOUND to the app's screen: when Android destroyed the screen in the
 * background (to free memory, or when the driver swiped the app away), the
 * plugin stopped its service, the GPS stopped, and the upload code in the web
 * page died with it. The office saw "nothing from the phone since 11:41".
 *
 * This service is STARTED, not bound. It runs as a foreground service with
 * its notification from Start Ride until the office stops the ride, whether
 * or not the app's screen exists; it asks Android to restart it if it is
 * killed (START_STICKY), and it carries on from what it saved. Every kept
 * fix goes into SQLite (TrackingStore) first; uploads run on their own
 * thread every uploadIntervalSec, with back-off, and a fix is marked sent
 * only when the server confirms it by id. A ride started with no signal is
 * registered with the server first, under the id the phone gave it.
 *
 * The web page talks to it through NativeTrackingPlugin and only draws.
 */
public class TrackingService extends Service implements LocationListener {

    static final String ACTION_START = "in.moderndairy.drivers.TRACK_START";
    static final String ACTION_STOP = "in.moderndairy.drivers.TRACK_STOP";
    static final String ACTION_FLUSH = "in.moderndairy.drivers.TRACK_FLUSH";
    static final String PREFS = "md_tracking";
    private static final String CHANNEL = "md_tracking";
    private static final int NOTIFICATION_ID = 4712;
    private static final long TICK_MS = 5000L;
    // GPS is preferred; a network position is used only when GPS has said
    // nothing for this long (indoors).
    private static final long GPS_PREFERRED_MS = 20000L;

    static volatile boolean running = false;     // the service exists
    static volatile boolean recording = false;   // location updates are requested

    /* The plugin, while the app's screen exists; null otherwise. */
    interface Listener {
        void onFix(JSONObject fix);
        void onState(JSONObject state);
    }
    static volatile Listener listener;

    private SharedPreferences prefs;
    private TrackingStore store;
    private LocationManager locations;
    private HandlerThread locThread;
    private HandlerThread netThread;
    private Handler net;
    private boolean foreground = false;
    private long lastGpsAt = 0L;
    private volatile long lastAttemptAt = 0L;

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        prefs = prefs(this);
        store = TrackingStore.get(this);
        locations = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        locThread = new HandlerThread("md-location");
        locThread.start();
        netThread = new HandlerThread("md-upload");
        netThread.start();
        net = new Handler(netThread.getLooper());
        net.post(tick);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopRecording();
        } else if (prefs.getBoolean("active", false)) {
            // Start Ride, the app reopening, or Android restarting a killed
            // service (intent == null): carry on with the saved ride.
            startRecording();
        } else if (store.unsentCount() == 0) {
            stopSelf();
            return START_NOT_STICKY;
        }
        kick();
        return START_STICKY;
    }

    // ── recording ────────────────────────────────────────────────────────

    private void startRecording() {
        if (!goForeground()) return;
        if (recording) return;
        boolean any = false;
        // Both are registered even when switched off: Android delivers fixes
        // as soon as the driver turns Location back on.
        try {
            locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2000L, 0f, this, locThread.getLooper());
            any = true;
        } catch (SecurityException e) {
            note("recorderError", "location permission refused");
        } catch (IllegalArgumentException e) {
            note("recorderError", "this phone has no GPS");
        }
        try {
            locations.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 10000L, 0f, this, locThread.getLooper());
            any = true;
        } catch (SecurityException | IllegalArgumentException ignored) {
            // No network location on this phone: GPS alone.
        }
        recording = any;
        if (any) note("recorderError", null);
        state("recording");
    }

    private void stopRecording() {
        prefs.edit().putBoolean("active", false).apply();
        if (recording) {
            try { locations.removeUpdates(this); } catch (Exception ignored) { /* already gone */ }
        }
        recording = false;
        if (foreground) {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(Service.STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
            foreground = false;
        }
        state("stopped");
    }

    private boolean goForeground() {
        if (foreground) return true;
        try {
            Notification n = notification();
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            foreground = true;
            return true;
        } catch (Exception e) {
            // Android refused (no location permission, or started from the
            // background where it is not allowed). Said, not hidden.
            note("recorderError", "Android did not allow the recorder to start: " + e.getClass().getSimpleName());
            state("refused");
            return false;
        }
    }

    private Notification notification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Ride recording", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while a ride is being recorded");
            nm.createNotificationChannel(ch);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setContentTitle("Modern Drivers — ride in progress")
                .setContentText("Your route is being recorded.")
                .setSmallIcon(getApplicationInfo().icon)
                .setOngoing(true);
        if (tap != null) b.setContentIntent(tap);
        return b.build();
    }

    @Override
    public void onLocationChanged(Location l) {
        long now = System.currentTimeMillis();
        boolean gps = LocationManager.GPS_PROVIDER.equals(l.getProvider());
        if (gps) lastGpsAt = now;
        else if (now - lastGpsAt < GPS_PREFERRED_MS) return;
        long ts = l.getTime() > 0 ? l.getTime() : now;

        SharedPreferences.Editor e = prefs.edit();
        e.putLong("lastFixAt", now);
        putDouble(e, "lastLat", l.getLatitude());
        putDouble(e, "lastLng", l.getLongitude());
        e.putFloat("lastAcc", l.hasAccuracy() ? l.getAccuracy() : -1f);
        e.apply();

        String ride = prefs.getString("rideId", null);
        boolean active = prefs.getBoolean("active", false);
        boolean kept = false;
        if (active && ride != null) {
            long lastTs = prefs.getLong("keptTs", 0L);
            double lastLat = getDouble(prefs, "keptLat");
            double lastLng = getDouble(prefs, "keptLng");
            float[] d = new float[1];
            if (lastTs != 0L) Location.distanceBetween(lastLat, lastLng, l.getLatitude(), l.getLongitude(), d);
            int sample = prefs.getInt("sampleIntervalSec", 30);
            kept = lastTs == 0L || ts - lastTs >= (sample - 5) * 1000L || d[0] >= 25f;
            if (kept) {
                TrackingStore.Fix f = new TrackingStore.Fix();
                long seq = prefs.getLong("seq", 0L) + 1;
                f.id = prefs.getString("deviceId", "dev") + ":n" + String.format(Locale.US, "%09d", seq);
                f.ride = ride;
                f.lat = l.getLatitude();
                f.lng = l.getLongitude();
                f.ts = ts;
                f.accuracy = l.hasAccuracy() ? (double) l.getAccuracy() : null;
                f.speed = l.hasSpeed() ? (double) l.getSpeed() : null;
                f.bearing = l.hasBearing() ? (double) l.getBearing() : null;
                f.altitude = l.hasAltitude() ? l.getAltitude() : null;
                f.battery = battery();
                f.mock = isMock(l);
                store.add(f);
                SharedPreferences.Editor k = prefs.edit();
                k.putLong("seq", seq);
                k.putLong("keptTs", ts);
                putDouble(k, "keptLat", f.lat);
                putDouble(k, "keptLng", f.lng);
                k.putInt("points", prefs.getInt("points", 0) + 1);
                // The phone's own running total, the same filter as the
                // server (12 m jitter, 3 km jump). Indicative only.
                if (lastTs != 0L && d[0] >= 12f && d[0] < 3000f) putDouble(k, "distanceM", getDouble(prefs, "distanceM") + d[0]);
                k.apply();
            }
        }
        Listener li = listener;
        if (li != null) {
            try {
                JSONObject o = new JSONObject();
                o.put("lat", l.getLatitude());
                o.put("lng", l.getLongitude());
                o.put("time", ts);
                if (l.hasAccuracy()) o.put("accuracy", l.getAccuracy());
                if (l.hasSpeed()) o.put("speed", l.getSpeed());
                if (l.hasBearing()) o.put("bearing", l.getBearing());
                o.put("kept", kept);
                o.put("provider", l.getProvider());
                li.onFix(o);
            } catch (Exception ignored) {
                // The screen went away mid-call; the fix is saved regardless.
            }
        }
        if (kept && now - lastAttemptAt >= prefs.getInt("uploadIntervalSec", 15) * 1000L) kick();
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) { /* pre-Q callback */ }

    @Override
    public void onProviderEnabled(String provider) { state("provider"); }

    @Override
    public void onProviderDisabled(String provider) { state("provider"); kick(); }

    @SuppressWarnings("deprecation")
    private static boolean isMock(Location l) {
        if (Build.VERSION.SDK_INT >= 31) return l.isMock();
        return Build.VERSION.SDK_INT >= 18 && l.isFromMockProvider();
    }

    // ── upload ───────────────────────────────────────────────────────────

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            try {
                upload();
            } catch (Throwable t) {
                note("lastUploadError", "upload failed: " + t.getClass().getSimpleName());
            } finally {
                if (running) net.postDelayed(this, TICK_MS);
            }
        }
    };

    private void kick() {
        if (net == null) return;
        net.removeCallbacks(tick);
        net.post(tick);
    }

    private static final class Resp {
        int status;
        boolean ok;
        String code;
        String message;
        JSONObject data;
    }

    private void upload() {
        long now = System.currentTimeMillis();
        if (now < prefs.getLong("nextAttemptAt", 0L)) return;
        String api = prefs.getString("apiBase", "");
        if (api == null || api.isEmpty() || prefs.getString("accessToken", null) == null) return;
        boolean active = prefs.getBoolean("active", false);
        String ride = prefs.getString("rideId", null);

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wake = pm == null ? null : pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "md:upload");
        if (wake != null) wake.acquire(60000L);
        try {
            // 1. A ride started with no signal: registered first, under its own id.
            if (ride != null && !prefs.getBoolean("rideRegistered", true)) {
                lastAttemptAt = now;
                JSONObject body = new JSONObject();
                body.put("rideId", ride);
                body.put("startedAt", prefs.getLong("rideStartedAt", now));
                body.put("sentAt", System.currentTimeMillis());
                body.put("deviceId", prefs.getString("deviceId", null));
                body.put("appVersion", prefs.getString("appVersion", null));
                Resp r = call("POST", "/driver/rides/start", body);
                if (!r.ok) { failed(r); return; }
                String sid = r.data == null ? ride : r.data.optString("rideId", ride);
                SharedPreferences.Editor e = prefs.edit().putBoolean("rideRegistered", true);
                if (!ride.equals(sid)) e.putString("serverRideId", sid);
                e.apply();
                state("registered");
                if (r.data != null && !"active".equals(r.data.optString("status", "active"))) { rideEnded(); }
            }

            // 2. Fixes, oldest first, each to its ride.
            int max = prefs.getInt("maxBatchPoints", 200);
            List<TrackingStore.Fix> batch = store.unsent(max);
            if (!batch.isEmpty()) {
                lastAttemptAt = now;
                Map<String, List<TrackingStore.Fix>> groups = new LinkedHashMap<>();
                for (TrackingStore.Fix f : batch) {
                    List<TrackingStore.Fix> g = groups.get(f.ride);
                    if (g == null) { g = new ArrayList<>(); groups.put(f.ride, g); }
                    g.add(f);
                }
                for (Map.Entry<String, List<TrackingStore.Fix>> g : groups.entrySet()) {
                    String local = g.getKey();
                    boolean current = local.equals(prefs.getString("rideId", null));
                    if (current && !prefs.getBoolean("rideRegistered", true)) continue;
                    String target = current && prefs.getString("serverRideId", null) != null ? prefs.getString("serverRideId", null) : local;
                    JSONArray pts = new JSONArray();
                    List<String> ids = new ArrayList<>();
                    for (TrackingStore.Fix f : g.getValue()) { pts.put(json(f)); ids.add(f.id); }
                    JSONObject body = new JSONObject();
                    body.put("points", pts);
                    body.put("sentAt", System.currentTimeMillis());
                    body.put("health", health());
                    Resp r = call("POST", "/driver/rides/" + target + "/points", body);
                    if (r.ok) {
                        List<String> done = new ArrayList<>();
                        JSONArray acc = r.data == null ? null : r.data.optJSONArray("accepted");
                        JSONArray rej = r.data == null ? null : r.data.optJSONArray("rejected");
                        if (acc != null) for (int i = 0; i < acc.length(); i++) done.add(acc.optString(i));
                        if (rej != null) for (int i = 0; i < rej.length(); i++) {
                            JSONObject x = rej.optJSONObject(i);
                            if (x != null && !x.isNull("clientPointId")) done.add(x.optString("clientPointId"));
                        }
                        store.markSent(done);
                        succeeded(r);
                        if (current && r.data != null && !r.data.optBoolean("rideActive", true)) rideEnded();
                    } else if ("RIDE_NOT_FOUND".equals(r.code) || "NOT_YOUR_RIDE".equals(r.code)) {
                        // No server will ever take these: dropped, by the server's own word.
                        store.markSent(ids);
                    } else {
                        failed(r);
                        return;
                    }
                }
                if (batch.size() >= max) kick();
            } else if (active && now - Math.max(prefs.getLong("lastHealthAt", 0L), prefs.getLong("lastUploadOkAt", 0L))
                    >= prefs.getInt("healthIntervalSec", 60) * 1000L) {
                // 3. Nothing to send: the phone's state instead, which also
                // tells it whether the office has stopped the ride.
                lastAttemptAt = now;
                JSONObject body = health();
                body.put("sentAt", System.currentTimeMillis());
                Resp r = call("POST", "/driver/health", body);
                if (r.ok) {
                    prefs.edit().putLong("lastHealthAt", now).apply();
                    succeeded(r);
                    String expect = prefs.getString("serverRideId", prefs.getString("rideId", null));
                    String serverRide = r.data == null || r.data.isNull("activeRideId") ? null : r.data.optString("activeRideId", null);
                    if (prefs.getBoolean("rideRegistered", true) && expect != null && !expect.equals(serverRide)) rideEnded();
                } else {
                    failed(r);
                }
            }
            if (!prefs.getBoolean("active", false) && store.unsentCount() == 0) {
                store.purgeSent(System.currentTimeMillis() - 2 * 86400000L);
                stopSelf();
            }
        } catch (Exception e) {
            note("lastUploadError", "upload failed: " + e.getClass().getSimpleName());
        } finally {
            if (wake != null && wake.isHeld()) wake.release();
        }
    }

    /* The server says the ride is not running: confirm, then stop recording. */
    private void rideEnded() {
        try {
            Resp r = call("GET", "/driver/rides/active", null);
            if (!r.ok || r.data == null) return;
            String expect = prefs.getString("serverRideId", prefs.getString("rideId", null));
            if (r.data.optBoolean("active", false) && expect != null && expect.equals(r.data.optString("rideId"))) return;
            SharedPreferences.Editor e = prefs.edit();
            e.putString("stoppedReason", r.data.isNull("reason") ? null : r.data.optString("reason"));
            e.putString("stoppedKind", r.data.isNull("kind") ? null : r.data.optString("kind"));
            e.putLong("stoppedAt", r.data.optLong("stoppedAt", System.currentTimeMillis()));
            e.apply();
            stopRecording();
            state("rideStopped");
        } catch (Exception ignored) {
            // Checked again on the next tick.
        }
    }

    private void succeeded(Resp r) {
        SharedPreferences.Editor e = prefs.edit();
        e.putInt("uploadFailures", 0);
        e.putLong("nextAttemptAt", 0L);
        e.putLong("lastUploadOkAt", System.currentTimeMillis());
        e.remove("lastUploadError");
        e.remove("authError");
        if (r.data != null) {
            JSONObject t = r.data.optJSONObject("tracking");
            if (t != null) {
                if (t.has("sampleIntervalSec")) e.putInt("sampleIntervalSec", t.optInt("sampleIntervalSec", 30));
                if (t.has("uploadIntervalSec")) e.putInt("uploadIntervalSec", t.optInt("uploadIntervalSec", 15));
                if (t.has("healthIntervalSec")) e.putInt("healthIntervalSec", t.optInt("healthIntervalSec", 60));
                if (t.has("maxBatchPoints")) e.putInt("maxBatchPoints", t.optInt("maxBatchPoints", 200));
            }
        }
        e.apply();
    }

    /* Exponential back-off with jitter: 5 s, 10 s … 5 min, ±50 %. */
    private void failed(Resp r) {
        int n = prefs.getInt("uploadFailures", 0) + 1;
        long base = Math.min(300000L, 5000L * (1L << Math.min(n - 1, 10)));
        long wait = (long) (base * (0.5 + Math.random()));
        String why;
        if (r.status == 0) why = "no connection to the server";
        else if (r.status == 401) why = "signed out: " + (r.message == null ? "session expired" : r.message);
        else if (r.status == 429) why = "server busy (too many requests)";
        else if (r.status >= 500) why = "server error " + r.status;
        else why = (r.message == null ? "request failed" : r.message) + " (" + r.status + ")";
        prefs.edit().putInt("uploadFailures", n).putLong("nextAttemptAt", System.currentTimeMillis() + wait)
                .putString("lastUploadError", why).apply();
    }

    private Resp call(String method, String path, JSONObject body) {
        Resp r = send(method, path, body, prefs.getString("accessToken", null));
        if (r.status == 401 && refresh()) r = send(method, path, body, prefs.getString("accessToken", null));
        return r;
    }

    /* A new access token from the refresh token; a refusal that will not fix
     * itself (another phone, account off) is kept as authError. */
    private boolean refresh() {
        String rt = prefs.getString("refreshToken", null);
        if (rt == null) return false;
        try {
            JSONObject b = new JSONObject();
            b.put("refreshToken", rt);
            Resp r = send("POST", "/driver/refresh", b, null);
            if (r.ok && r.data != null && r.data.has("accessToken")) {
                prefs.edit().putString("accessToken", r.data.getString("accessToken")).remove("authError").apply();
                return true;
            }
            if (r.status == 401 || r.status == 403) prefs.edit().putString("authError", r.message == null ? "Signed out" : r.message).apply();
        } catch (Exception ignored) {
            // Network: tried again later.
        }
        return false;
    }

    private Resp send(String method, String path, JSONObject body, String token) {
        Resp r = new Resp();
        HttpURLConnection c = null;
        try {
            String base = prefs.getString("apiBase", "");
            c = (HttpURLConnection) new URL(base.replaceAll("/+$", "") + path).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Accept", "application/json");
            if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                c.setDoOutput(true);
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                OutputStream os = c.getOutputStream();
                os.write(bytes);
                os.close();
            }
            r.status = c.getResponseCode();
            InputStream in = r.status >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = in == null ? "" : read(in);
            JSONObject j = text.isEmpty() ? new JSONObject() : new JSONObject(text);
            r.ok = r.status >= 200 && r.status < 300 && j.optBoolean("success", true);
            r.code = j.isNull("code") ? null : j.optString("code", null);
            r.message = j.isNull("message") ? null : j.optString("message", null);
            r.data = j.optJSONObject("data");
        } catch (Exception e) {
            r.status = 0;
            r.ok = false;
            r.message = e.getClass().getSimpleName();
        } finally {
            if (c != null) c.disconnect();
        }
        return r;
    }

    private static String read(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    private static JSONObject json(TrackingStore.Fix f) throws org.json.JSONException {
        JSONObject o = new JSONObject();
        o.put("clientPointId", f.id);
        o.put("lat", f.lat);
        o.put("lng", f.lng);
        o.put("deviceTs", f.ts);
        if (f.accuracy != null) o.put("accuracyM", Math.round(f.accuracy));
        if (f.speed != null) o.put("speedMps", f.speed);
        if (f.bearing != null) o.put("headingDeg", f.bearing);
        if (f.altitude != null) o.put("altitudeM", f.altitude);
        if (f.battery != null) o.put("batteryPct", f.battery);
        o.put("provider", "native");
        o.put("mock", f.mock);
        return o;
    }

    // ── the phone's state, for the office ─────────────────────────────────

    JSONObject health() {
        JSONObject h = new JSONObject();
        try {
            boolean fine = granted(this, Manifest.permission.ACCESS_FINE_LOCATION) || granted(this, Manifest.permission.ACCESS_COARSE_LOCATION);
            h.put("locationPermission", fine ? "granted" : "denied");
            h.put("backgroundPermission", Build.VERSION.SDK_INT < 29 || granted(this, "android.permission.ACCESS_BACKGROUND_LOCATION") ? "granted" : "denied");
            h.put("gpsEnabled", gpsOn(this));
            h.put("watcherRunning", recording);
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (Build.VERSION.SDK_INT >= 23 && pm != null) h.put("batteryOptimised", !pm.isIgnoringBatteryOptimizations(getPackageName()));
            h.put("online", online(this));
            h.put("queuedPoints", store.unsentCount());
            long oldest = store.oldestUnsent();
            if (oldest > 0) h.put("oldestQueuedAt", oldest);
            long lf = prefs.getLong("lastFixAt", 0L);
            if (lf > 0) h.put("lastFixAt", lf);
            float acc = prefs.getFloat("lastAcc", -1f);
            if (acc >= 0) h.put("lastFixAccuracyM", Math.round(acc));
            long ok = prefs.getLong("lastUploadOkAt", 0L);
            if (ok > 0) h.put("lastUploadOkAt", ok);
            h.put("lastUploadError", prefs.getString("lastUploadError", null) == null ? JSONObject.NULL : prefs.getString("lastUploadError", null));
            h.put("uploadFailures", prefs.getInt("uploadFailures", 0));
            h.put("pointsRecorded", prefs.getInt("points", 0));
            h.put("authError", prefs.getString("authError", null) == null ? JSONObject.NULL : prefs.getString("authError", null));
            Integer b = battery();
            if (b != null) h.put("batteryPct", b);
            h.put("appVersion", prefs.getString("appVersion", null));
            h.put("recorder", "native");
        } catch (Exception ignored) {
            // A partial report is still a report.
        }
        return h;
    }

    static boolean granted(Context c, String permission) {
        if (Build.VERSION.SDK_INT >= 23) return c.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
        return c.checkCallingOrSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean gpsOn(Context c) {
        try {
            LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
            return lm != null && lm.isProviderEnabled(LocationManager.GPS_PROVIDER);
        } catch (Exception e) {
            return false;
        }
    }

    static boolean online(Context c) {
        try {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return false;
            if (Build.VERSION.SDK_INT >= 23) {
                Network n = cm.getActiveNetwork();
                NetworkCapabilities caps = n == null ? null : cm.getNetworkCapabilities(n);
                return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            }
            @SuppressWarnings("deprecation")
            android.net.NetworkInfo info = cm.getActiveNetworkInfo();
            return info != null && info.isConnected();
        } catch (Exception e) {
            return false;
        }
    }

    private Integer battery() {
        try {
            BatteryManager bm = (BatteryManager) getSystemService(Context.BATTERY_SERVICE);
            if (bm == null || Build.VERSION.SDK_INT < 21) return null;
            int v = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            return v >= 0 && v <= 100 ? v : null;
        } catch (Exception e) {
            return null;
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────

    static void putDouble(SharedPreferences.Editor e, String k, double v) {
        e.putLong(k, Double.doubleToRawLongBits(v));
    }

    static double getDouble(SharedPreferences p, String k) {
        return Double.longBitsToDouble(p.getLong(k, Double.doubleToRawLongBits(0d)));
    }

    private void note(String key, String value) {
        if (value == null) prefs.edit().remove(key).apply();
        else prefs.edit().putString(key, value).apply();
    }

    private void state(String what) {
        Listener li = listener;
        if (li == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("event", what);
            o.put("recording", recording);
            o.put("active", prefs.getBoolean("active", false));
            li.onState(o);
        } catch (Exception ignored) {
            // No screen to tell.
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The driver swiped the app away. The ride goes on: this service is
        // started, not bound, and keeps recording with its notification.
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        recording = false;
        try { locations.removeUpdates(this); } catch (Exception ignored) { /* none */ }
        if (net != null) net.removeCallbacks(tick);
        if (locThread != null) locThread.quitSafely();
        if (netThread != null) netThread.quitSafely();
        state("destroyed");
        super.onDestroy();
    }
}
