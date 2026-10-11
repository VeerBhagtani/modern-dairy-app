package in.moderndairy.drivers;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

/*
 * The phone's own record of every fix kept during a ride, in SQLite.
 *
 * A fix is written here BEFORE any attempt to send it, and marked sent only
 * when the server has confirmed it by id. Nothing here depends on the app's
 * screen or its web page being alive: TrackingService writes and uploads from
 * its own threads. Sent rows stay a couple of days so the map can redraw the
 * day's route, then are purged.
 */
final class TrackingStore extends SQLiteOpenHelper {

    static final class Fix {
        String id;
        String ride;
        double lat;
        double lng;
        long ts;
        Double accuracy;
        Double speed;
        Double bearing;
        Double altitude;
        Integer battery;
        boolean mock;
    }

    private static TrackingStore instance;

    static synchronized TrackingStore get(Context context) {
        if (instance == null) instance = new TrackingStore(context.getApplicationContext());
        return instance;
    }

    private TrackingStore(Context context) {
        super(context, "md_tracking.db", null, 1);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE fixes (id TEXT PRIMARY KEY, ride TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, "
                + "ts INTEGER NOT NULL, acc REAL, spd REAL, brg REAL, alt REAL, bat INTEGER, mock INTEGER NOT NULL DEFAULT 0, "
                + "sent INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE INDEX fixes_unsent ON fixes(sent, ts)");
        db.execSQL("CREATE INDEX fixes_ride ON fixes(ride, ts)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // Version 1 only.
    }

    synchronized void add(Fix f) {
        ContentValues v = new ContentValues();
        v.put("id", f.id);
        v.put("ride", f.ride);
        v.put("lat", f.lat);
        v.put("lng", f.lng);
        v.put("ts", f.ts);
        if (f.accuracy != null) v.put("acc", f.accuracy);
        if (f.speed != null) v.put("spd", f.speed);
        if (f.bearing != null) v.put("brg", f.bearing);
        if (f.altitude != null) v.put("alt", f.altitude);
        if (f.battery != null) v.put("bat", f.battery);
        v.put("mock", f.mock ? 1 : 0);
        getWritableDatabase().insertWithOnConflict("fixes", null, v, SQLiteDatabase.CONFLICT_IGNORE);
    }

    private static Double optDouble(Cursor c, int i) {
        return c.isNull(i) ? null : c.getDouble(i);
    }

    /* The oldest fixes not yet confirmed by the server, oldest first. */
    synchronized List<Fix> unsent(int limit) {
        List<Fix> out = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT id, ride, lat, lng, ts, acc, spd, brg, alt, bat, mock FROM fixes WHERE sent = 0 ORDER BY ts, id LIMIT ?",
                new String[] { String.valueOf(limit) });
        try {
            while (c.moveToNext()) {
                Fix f = new Fix();
                f.id = c.getString(0);
                f.ride = c.getString(1);
                f.lat = c.getDouble(2);
                f.lng = c.getDouble(3);
                f.ts = c.getLong(4);
                f.accuracy = optDouble(c, 5);
                f.speed = optDouble(c, 6);
                f.bearing = optDouble(c, 7);
                f.altitude = optDouble(c, 8);
                f.battery = c.isNull(9) ? null : c.getInt(9);
                f.mock = c.getInt(10) == 1;
                out.add(f);
            }
        } finally {
            c.close();
        }
        return out;
    }

    /* Confirmed by the server (stored, or refused by name): never sent again. */
    synchronized void markSent(List<String> ids) {
        if (ids.isEmpty()) return;
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (String id : ids) db.execSQL("UPDATE fixes SET sent = 1 WHERE id = ?", new Object[] { id });
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    synchronized int unsentCount() {
        Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM fixes WHERE sent = 0", null);
        try {
            return c.moveToFirst() ? c.getInt(0) : 0;
        } finally {
            c.close();
        }
    }

    synchronized long oldestUnsent() {
        Cursor c = getReadableDatabase().rawQuery("SELECT MIN(ts) FROM fixes WHERE sent = 0", null);
        try {
            return c.moveToFirst() && !c.isNull(0) ? c.getLong(0) : 0L;
        } finally {
            c.close();
        }
    }

    /* The ride's route for the map, [lng, lat, ts] each, the last `max` fixes. */
    synchronized JSONArray track(String ride, int max) {
        JSONArray out = new JSONArray();
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT lng, lat, ts FROM (SELECT lng, lat, ts FROM fixes WHERE ride = ? ORDER BY ts DESC LIMIT ?) ORDER BY ts",
                new String[] { ride, String.valueOf(max) });
        try {
            while (c.moveToNext()) {
                JSONArray p = new JSONArray();
                try {
                    p.put(c.getDouble(0));
                    p.put(c.getDouble(1));
                    p.put(c.getLong(2));
                } catch (org.json.JSONException ignored) {
                    continue;
                }
                out.put(p);
            }
        } finally {
            c.close();
        }
        return out;
    }

    /* Sent rows older than this are only map history: dropped. Unsent rows are never dropped here. */
    synchronized void purgeSent(long olderThanTs) {
        getWritableDatabase().execSQL("DELETE FROM fixes WHERE sent = 1 AND ts < ?", new Object[] { olderThanTs });
    }
}
