package com.example.user_app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {


    /**
     * Opt the activity in to handling incoming deep links.
     */
    override fun shouldHandleDeeplinking(): Boolean = true

    /**
     * Creates the FCM notification channel before Flutter starts.
     */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ensureNotificationChannel()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }

        val channelId = "queueflow_alerts"
        val soundUri = Uri.parse(
            "android.resource://$packageName/raw/token_approaching"
        )

        val audioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

        val channel = NotificationChannel(
            channelId,
            "QueueFlow Alerts",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Notifications for approaching queue tokens"
            enableVibration(true)
            setShowBadge(true)
            setSound(soundUri, audioAttributes)
        }

        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(channel)
    }
}
