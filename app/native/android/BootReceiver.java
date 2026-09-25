package in.moderndairy.drivers;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

/*
 * After a restart (or an app update), tell the driver their ride is not being
 * recorded.
 *
 * Recording runs inside the app. A reboot ends it, and Android 10+ does not let
 * an app start a location service or open itself from the background after
 * boot, so silently resuming is not possible. What IS allowed is a notification:
 * if a ride was being recorded when the phone went down, one tap reopens the
 * app, which asks the server whether the ride is still on and restarts
 * recording by itself. If the office stopped the ride meanwhile, opening the
 * app just clears this.
 *
 * The flag is written by BatteryOptimisationPlugin.setRideActive whenever the
 * recorder starts or stops. The office still sees the gap: the server raises
 * gps_missing once no position has arrived for the configured time.
 */
public class BootReceiver extends BroadcastReceiver {
    static final String PREFS = "modern_drivers_native";
    static final String KEY_ACTIVE = "rideActive";
    private static final String CHANNEL = "ride_resume";
    private static final int NOTIFICATION_ID = 4201;

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) return;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) return;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_ACTIVE, false)) return;
        notifyResume(context);
    }

    static void notifyResume(Context context) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Ride not recording", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("Shown after a phone restart while a ride was being recorded.");
            nm.createNotificationChannel(ch);
        }
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (open == null) return;
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        // FLAG_IMMUTABLE is API 23 and required from 31; the app runs from 22.
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent tap = PendingIntent.getActivity(context, 0, open, flags);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(context, CHANNEL)
                : new Notification.Builder(context);
        b.setSmallIcon(context.getApplicationInfo().icon)
                .setContentTitle("Your ride is not being recorded")
                .setContentText("The phone restarted. Tap to open Modern Drivers and continue.")
                .setContentIntent(tap)
                .setAutoCancel(true);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH);
        try {
            nm.notify(NOTIFICATION_ID, b.build());
        } catch (SecurityException ignored) {
            // Android 13+ without notification permission: nothing to show.
        }
    }

    static void clear(Context context) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIFICATION_ID);
    }
}
