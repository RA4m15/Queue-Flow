# QueueFlow — Firebase Cloud Messaging setup

**Status in this repository: NOT CONFIGURED.**

Every line of code required for real FCM push delivery is present and tested.
What is *not* present is a Firebase project. There is no
`android/app/google-services.json`, no `ios/Runner/GoogleService-Info.plist`,
and no Firebase service account in the backend environment. The application is
deliberately honest about this: it reports push as **"Not Available"** and
refuses to claim a registration it cannot perform.

Nothing below may be fabricated. Each value must come from a Firebase project
you create and own.

---

## 1. What is already done

| Layer | File | State |
|---|---|---|
| Client SDK | `user_app/pubspec.yaml` | `firebase_core` + `firebase_messaging` declared |
| Client transport | `user_app/lib/services/firebase_push_messaging_client.dart` | Real implementation |
| Transport resolution | `user_app/lib/services/push_transport.dart` | Real, falls back truthfully |
| Background handler | `user_app/lib/services/firebase_push_messaging_client.dart` | `@pragma('vm:entry-point')`, registered in `main.dart` before `runApp` |
| Provider wiring | `user_app/lib/services/push_notification_service.dart` | `useTransport()` / `markUnavailable()` |
| Android permission | `android/app/src/main/AndroidManifest.xml` | `POST_NOTIFICATIONS` declared |
| Android channel | `android/app/src/main/kotlin/.../MainActivity.kt` | Channel created before Flutter starts |
| Android channel id | `android/app/src/main/res/values/strings.xml` | `queueflow_alerts` |
| iOS background mode | `ios/Runner/Info.plist` | `UIBackgroundModes: remote-notification` |
| Backend provider | `backend/src/channels/fcmPushProvider.js` | Real, credential-gated |
| Backend integration | `backend/src/services/notificationService.js` step 8 | Calls the provider, honours dedupe |
| Backend env | `backend/.env.example` | Placeholder names only |

**Not done (requires your Firebase project):** the `google-services` Gradle
plugin, `google-services.json`, `GoogleService-Info.plist`, the iOS
`aps-environment` entitlement, and the backend service account.

---

## 2. Create the Firebase project

1. <https://console.firebase.google.com> → **Add project**.
2. **Project settings → Your apps → Add app → Android**.
   - Package name **must** be `com.example.user_app` (it comes from
     `android/app/build.gradle.kts` → `applicationId`). Change the
     `applicationId` *first* if you intend to ship under a different id, then
     register that id in Firebase.
   - Download `google-services.json` and place it at
     `user_app/android/app/google-services.json`.
3. **Project settings → Your apps → Add app → iOS**.
   - Bundle id **must** be `com.example.userApp` (from
     `ios/Runner.xcodeproj` → `PRODUCT_BUNDLE_IDENTIFIER`).
   - Download `GoogleService-Info.plist` and place it at
     `user_app/ios/Runner/GoogleService-Info.plist`.

`google-services.json` and `GoogleService-Info.plist` are **client**
configuration, not secrets. Committing them is normal practice. They contain no
private key and cannot send a push on their own — only the backend service
account can.

---

## 3. Enable the Android `google-services` Gradle plugin

The plugin is deliberately **not** applied by default: applying it without
`google-services.json` fails the build. Add it once the file is in place.

`user_app/android/settings.gradle.kts`:

```kotlin
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.1.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.0" apply false
    // Add once android/app/google-services.json exists:
    id("com.google.gms.google-services") version "4.4.2" apply false
}
```

`user_app/android/app/build.gradle.kts`, inside `android { }`:

```kotlin
apply(plugin = "com.google.gms.google-services")
```

Then re-run `flutter clean && flutter pub get && flutter build apk`.

---

## 4. Enable iOS push

Push cannot work on iOS until the Apple Developer App ID has the capability.
This repository does **not** contain the entitlement, because adding it without
a matching provisioning profile breaks the Xcode build.

1. <https://developer.apple.com/account> → Certificates, Identifiers &
   Profiles → App ID `com.example.userApp` → **Push Notifications** → enable.
2. In Xcode: select the **Runner** target → **Signing & Capabilities** →
   **+ Capability** → **Push Notifications**. Xcode creates
   `ios/Runner/Runner.entitlements` and wires `CODE_SIGN_ENTITLEMENTS` for you.
3. `UIBackgroundModes: remote-notification` is already present in
   `ios/Runner/Info.plist`.
4. No `AppDelegate.swift` change is required — `firebase_messaging` performs
   APNs registration when `Firebase.initializeApp()` runs.

---

## 5. Backend service account

1. Firebase Console → **Project settings → Service accounts → Generate new
   private key**.
2. Keep the downloaded JSON outside the repository. On Render there is no
   writable filesystem, so paste the minified JSON into one environment
   variable:

   ```
   FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"...","client_id":"..."}
   ```

   Alternatively, mount the file and set:
   ```
   GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/firebase-service-account.json
   FIREBASE_PROJECT_ID=your-project-id
   ```

3. Verify the provider reports ready:

   ```bash
   node -e "process.env.FCM_ANDROID_CHANNEL_ID='';console.log(require('./src/channels/fcmPushProvider').getStatus())"
   ```

4. Redeploy. `npm run test:all` must stay green with the credential absent —
   the notification service reports `PROVIDER_NOT_CONFIGURED` and still
   delivers over Socket.IO.

**Never commit the service account JSON.** The backend `.env` is git-ignored and
`backend/test/notification_security.test.js` test 18 fails the build if key
material appears anywhere in `src/` or `test/`.

---

## 6. Notification channel id

Three places and the backend must agree on `queueflow_alerts`:

- `android/app/src/main/res/values/strings.xml` → `queueflow_alerts_channel_id`
- `MainActivity.kt` → `R.string.queueflow_alerts_channel_id`
- backend `FCM_ANDROID_CHANNEL_ID` (default `queueflow_alerts`)

Changing it without changing all three silently drops every notification on
Android 8+.

---

## 7. Verify end to end

There is **no automated test for this step** — it requires a real device, a
real Firebase project and a real APNs/Play Services registration.

1. Install the app on a physical Android device (an emulator without Google
   Play Services will report "unavailable on this device").
2. Grant the notification permission.
3. Confirm the profile screen shows push **On** and a registered device.
4. Join a real queue, then move two tokens closer using the admin panel, or
   call the token.
5. Background the app, then confirm the system notification appears.
6. Tap it: the app must restore the session, re-fetch the token, and open live
   tracking. The number shown must come from the backend, never the payload.

If step 3 still shows "Not Available", `Firebase.initializeApp()` failed — check
that `google-services.json` matches `applicationId`
(`com.example.user_app`) and that the `google-services` Gradle plugin is
applied.

---

## 8. What the app does with no Firebase project

`push_transport.dart` resolves to `UnavailablePushMessagingClient`, so:

- permission reads and requests return `PushPermissionStatus.unavailable`;
- `initialize()` returns `false` and registers nothing with the backend;
- no device token is ever invented client side;
- the profile screen shows the reason rather than implying push works.

This behaviour is asserted in `user_app/test/fcm_push_integration_test.dart`
and `user_app/test/push_notification_test.dart`.
