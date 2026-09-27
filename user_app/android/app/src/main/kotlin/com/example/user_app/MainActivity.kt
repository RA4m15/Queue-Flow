package com.example.user_app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {

    /**
     * Opt the activity in to handling incoming deep links.
     *
     * The Flutter Android embedding IGNORES the VIEW intent filters in the
     * manifest unless this returns true (or the manifest sets
     * `android:value="true"` on the `flutter_deeplinking_enabled` meta-data).
     * Both are set: the override makes the behaviour explicit and greppable from
     * Kotlin, the manifest meta-data makes it visible in the merged manifest.
     *
     * Without this, a perfectly valid `autoVerify` App Link intent filter is
     * dead — Android hands the intent to the activity and Flutter drops it on
     * the floor, so the customer silently lands on the app's normal home screen
     * instead of the queue they just scanned.
     */
    override fun shouldHandleDeeplinking(): Boolean = true

    /**
     * Creates the FCM notification channel before Flutter starts.
     *
     * Android 8.0 (API 26) discards any notification aimed at a channel that
     * does not exist yet, so the very first push after a fresh install would be
     * silently lost. Creating the channel here — rather than from Dart — means
     * it exists even when the app is launched only to service a background
     * message.
     *
     * The id comes from the same string resource referenced by the manifest's
     * `com.google.firebase.messaging.default_notification_channel_id` meta-data
     * and by FCM_ANDROID_CHANNEL_ID on the backend. All three must agree.
     */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ensureNotificationChannel()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Pre-Android 8.0 notifications are not channel-scoped.
            return
        }
        val channelId = getString(R.string.queueflow_alerts_channel_id)
        val manager = getSystemService(NotificationManager::class.java) ?: return

        val channel = NotificationChannel(
            channelId,
            getString(R.string.queueflow_alerts_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = getString(R.string.queueflow_alerts_channel_description)
            enableVibration(true)
            setShowBadge(true)
        }
        manager.createNotificationChannel(channel)
    }
}
