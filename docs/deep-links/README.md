# Customer Queue Deep Links — App Links, Universal Links, and the one canonical QR

This document covers the **one** customer queue QR format and everything needed
for a phone to open the QueueFlow app from it.

---

## 1. The one canonical format

There is exactly one customer queue QR. It is a plain HTTPS URL:

```
https://<customer-web-host>/join?centerId=<24-hex MongoDB ObjectId>
https://<customer-web-host>/join?centerId=<24-hex MongoDB ObjectId>&serviceId=<24-hex MongoDB ObjectId>
```

- `centerId` is **required** and is always a real backend ID supplied by the
  Live Counter from live data. Nothing is hardcoded.
- `serviceId` is **optional**. Without it the customer chooses a service; with
  it the customer lands directly on that service's queue preview.
- The URL carries **no** token, secret, password, customer PII, or any other
  credential. Only the two IDs.

One URL covers every case, which is why it is the format that gets encoded:

| Situation | What happens |
|---|---|
| Phone camera, app installed, domain verified | App Link / Universal Link opens the Flutter app |
| Phone camera, app **not** installed | Browser opens Customer Web on the same `/join` route |
| In-app QR scanner | `parseQrPayload` recognises the identical string and routes internally |

The legacy custom scheme is still supported but is **never** the primary QR:

```
queueflow://join?centerId=…[&serviceId=…]
```

A custom scheme only works on a phone that already has the app, so it cannot
serve the customers who do not.

---

## 2. The values that must agree

The same host string appears in five places. If they disagree, the QR will not
open the app (it will still open the web page).

| # | Where | Value |
|---|---|---|
| 1 | `live_counter/.env` → `VITE_CUSTOMER_WEB_URL` | `https://<host>` — the URL the QR encodes |
| 2 | `user_app/android/queueflow_join_host.properties` (or `-PqueueflowJoinHost=`) | `<host>` — Android App Link intent filter |
| 3 | `user_app/ios/Runner/Runner.entitlements` → `applinks:<host>` | `<host>` — iOS Universal Link |
| 4 | The domain serving the two `.well-known` files (below) | `<host>` |

And the Flutter app must trust that host when parsing a scanned QR:

```
flutter build apk \
  --dart-define=QUEUEFLOW_JOIN_HOSTS=<host> \
  --dart-define-allow-listed-env-vars
```

Without `QUEUEFLOW_JOIN_HOSTS` the app trusts **only** local dev hosts
(`localhost`, `127.0.0.1`, `10.0.2.2`). That is deliberate: a mis-built release
must not accept join links from arbitrary domains. The app logs a warning at
startup when the define is missing.

---

## 3. Android App Links

### 3a. What is already in this repository

`user_app/android/app/src/main/AndroidManifest.xml` declares:

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https"
          android:host="${queueflowJoinHost}"
          android:pathPrefix="/join" />
</intent-filter>
```

plus a legacy `queueflow://join` filter. The host is injected from
`android/app/build.gradle.kts` so there is a single source of truth.

It also carries the opt-in that makes those filters do anything at all:

```xml
<meta-data android:name="flutter_deeplinking_enabled" android:value="true" />
```

plus `override fun shouldHandleDeeplinking(): Boolean = true` in
`MainActivity.kt`. The Flutter Android embedding ignores incoming `VIEW`
intents unless deep-link handling is explicitly enabled, so without one of
these a correct, verified, `autoVerify` filter is still dead. See §5.

### 3b. What is NOT done and cannot be done from here

`android:autoVerify` only succeeds when the domain serves a valid
`/.well-known/assetlinks.json`. **This cannot be created, published or verified
from inside this repository.** It requires a real deployed HTTPS domain.

### 3c. Publish `assetlinks.json`

At `https://<host>/.well-known/assetlinks.json`, served as
`Content-Type: application/json`, **no redirects**:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.example.user_app",
      "sha256_cert_fingerprints": [
        "<SHA-256 of the certificate the RELEASE build is signed with>"
      ]
    }
  }
]
```

Get the fingerprint from the keystore that signs the release build:

```bash
keytool -list -v -keystore <release.keystore> -alias <alias> | grep SHA256
```

Include **both** the upload key and the Play App Signing key if the app is
distributed through Google Play, otherwise Play-installed builds will not
verify.

> The package name above is still the Flutter template default
> (`com.example.user_app`). Change it in `android/app/build.gradle.kts`
> *and* here, together, or the link will never verify.

### 3d. Verify

```bash
# Install the real release-signed APK on a device, then:
adb shell pm get-app-links com.example.user_app
adb shell pm verify-app-links --re-verify com.example.user_app
adb shell pm get-app-links com.example.user_app
```

`verifiedAppLinks: true` means it works.

Also usable: <https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://<host>&relation=delegate_permission/common.handle_all_urls>

---

## 4. iOS Universal Links

### 4a. What is already in this repository

- `user_app/ios/Runner/Runner.entitlements` declares
  `com.apple.developer.associated-domains` = `applinks:<host>`.
- `user_app/ios/Runner.xcodeproj/project.pbxproj` references that file via
  `CODE_SIGN_ENTITLEMENTS` in the Debug, Release and Profile configurations.
- `user_app/ios/Runner/Info.plist` registers the legacy `queueflow` scheme.

### 4b. What is NOT done and cannot be done from here

- The provisioning profile must have the **Associated Domains** capability
  enabled, which is an Apple Developer account action.
- The domain must publish `apple-app-site-association` (below).
- The domain must be submitted to Apple's CDN — propagation can take ~24 h.

### 4c. Publish `apple-app-site-association`

At `https://<host>/.well-known/apple-app-site-association` (or
`https://<host>/apple-app-site-association`), served as `application/json`,
**no redirect, no `.json` extension**:

```json
{
  "applinks": {
    "details": [
      {
        "appID": "<APPLE_TEAM_ID>.com.example.userApp",
        "components": [
          { "/": "/join", "*": "*" }
        ]
      }
    ]
  }
}
```

`appID` is `<Team ID>.<Bundle ID>`. The bundle ID is
`com.example.userApp` per `project.pbxproj`.

### 4d. Verify

After installing on a physical device (simulators do not fetch the file):

```bash
# 1. The file must be fetchable and well formed.
curl -sS https://<host>/.well-known/apple-app-site-association | python -m json.tool

# 2. Ask Apple's CDN whether it has it. This returns {} until it does.
curl -sS "https://app-site-association.cdn-apple.com/a/v1/<host>"
```

Then open the link in Safari on the device (not Chrome — Universal Links do not
work in Chrome on iOS). With the app installed, the app opens. Without it,
Safari shows the Customer Web page. Either outcome is a working system; the
first is the goal.

---

## 5. How the app handles an inbound link

The Flutter engine delivers an App Link / Universal Link to the app as a
**route**, not as an app-level callback:

| Situation | Where the link appears |
| --- | --- |
| Cold start (app not running) | `WidgetsBinding.instance.platformDispatcher.defaultRouteName` |
| App already running | `WidgetsBindingObserver.didPushRouteInformation` |

`user_app/lib/utils/join_link_service.dart` reads both:

- `captureInitialJoinLink()` is called from `main()` before `runApp`. It has to
  be, because `GoRouter` is configured with an explicit `initialLocation`
  (`/splash`) and would otherwise never see the launch route.
- `JoinLinkRouteObserver` is registered as a `WidgetsBindingObserver` and
  watches for later links.

`classifyJoinLink()` runs the **same** `parseQrPayload` the in-app QR scanner
uses, so a link opened by the phone camera and a QR read inside the app produce
an identical `QrJoinPayload`. There is one queue flow, not two.

> **Validate against the engine's copy of the route, not the router's.**
> `GoRouter` rebuilds a matched route's URI relative to the app
> (`/join?centerId=…`, host stripped). Validating `GoRouterState.uri` would
> silently drop the host allowlist and accept a join link from any domain.
> `JoinLinkService` therefore reads the platform route directly, and a test
> (`16c`) fails the build if the router ever starts validating its own copy.

A link that is not a customer join link — a staff check-in link, an unrelated
deep link, a third-party URL — is ignored silently. Opening the app via a link
never shows a QR error.

### Android: the intent filters are inert without an explicit opt-in

The Flutter Android embedding **discards** incoming `VIEW` intents unless
deep-link handling is enabled. A perfect `android:autoVerify="true"` filter can
still be dead. Two settings are required, and both are present:

- `MainActivity.shouldHandleDeeplinking()` returns `true`
  (`android/app/src/main/kotlin/com/example/user_app/MainActivity.kt`).
- `<meta-data android:name="flutter_deeplinking_enabled" android:value="true"/>`
  in `AndroidManifest.xml`, so the opt-in is visible in the merged manifest and
  not only in Kotlin.

Test `16b` fails the build if either is removed.

### The link survives the login redirect

Every route in this app redirects an unauthenticated user to `/login`. A parked
join payload therefore lives in `pendingJoinLinkProvider`, not in a widget, so
that "scan the QR, then sign in" — the normal order for a first-time customer —
runs the join flow immediately after sign-in instead of dropping the link.

`JoinLinkListener` (mounted above the router in `main.dart`) drains it through
the same `JoinFlowController`.

A `/join` route exists in `app_router.dart` purely so go_router does not render
its 404 screen while the flow runs. `JoinLinkTransitScreen` steps aside on its
own if nothing takes over, so an unresolvable link never leaves the customer
staring at a spinner.

`user_app/lib/utils/join_flow_controller.dart` holds the shared
resolve-and-route logic used by both the scanner and the link handler. It never
creates a token: joining still requires the explicit user action in the queue
preview, behind the server-authoritative document gate.

---

## 6. Accepted / rejected payloads

Accepted (both normalize to one `QrJoinPayload{centerId, serviceId?}`):

- `https://<trusted-host>/join?centerId=…[&serviceId=…]` — canonical
- `queueflow://join?centerId=…[&serviceId=…]` — legacy

Rejected:

| Payload | Result |
|---|---|
| Staff HMAC check-in QR | `QrUnrecognized` — never a customer join path |
| `https://<untrusted-host>/join?centerId=…` | `QrUnrecognized` (`untrusted_join_host`) |
| `http://<production-host>/join?…` | `QrUnrecognized` (`insecure_join_scheme`) |
| Trusted host, path other than `/join` | `QrInvalid` |
| Missing or non-24-hex `centerId` | `QrInvalid` |
| `serviceId` present but invalid, or equal to `centerId` | `QrInvalid` |
| Any other scheme or arbitrary text | `QrUnrecognized` |

The host allowlist is what stops a QR from an arbitrary website entering the
queue flow. It must not be removed.

---

## 7. Tests

```bash
cd user_app       && flutter test test/canonical_join_qr_test.dart   # cases 1-14, 17
cd customer_web   && npm test                                       # cases 15-16
cd live_counter   && npm test                                       # cases 17-20
```

`canonical_join_qr_test.dart` group 16 asserts the App Link / Universal Link
configuration is real and not decorative:

- the `autoVerify` filter exists **and** `flutter_deeplinking_enabled` is set
  (16b — a filter without the opt-in is dead)
- the router has a `/join` route and does **not** validate `state.uri` (16c)
- the legacy custom scheme is still registered on both platforms (16d, 16f)
- the App Link host is injected, not hardcoded (16e)
- `CODE_SIGN_ENTITLEMENTS` is set on all three iOS configurations (16g)
- no `localhost` in any shipped link config (16h)
- the shipped placeholder host is a reserved TLD that can never resolve (16i)

---

## 8. Manual tests

A, C and the two verification steps in §3d / §4d require a physical Android/iOS
device. They cannot be run from a development machine and are **not** covered by
the automated tests.

| # | Steps | Expected |
|---|---|---|
| A | Configure a real host in all 5 places, build, and scan the Live Counter QR with the phone camera. App installed. | App opens straight to the centre's queue preview |
| B | Same QR, app uninstalled. | Browser opens Customer Web at the same `/join` route, same centre |
| C | Same QR, app installed but signed out. | App opens, customer signs in, and the join flow runs **without re-scanning** |
| D | Scan the QR with the in-app scanner instead. | Identical result to A — same payload, same flow |
| E | Scan a staff check-in QR and a QR from an unrelated site with the in-app scanner. | Both rejected; neither enters the queue flow |
| F | Confirm the QR image payload. | Canonical HTTPS, two real IDs, no token/secret/PII, no `localhost` |
| G | Set `VITE_CUSTOMER_WEB_URL` to a reserved TLD (`https://join.invalid`) and rebuild. | `qr-config-warning` is visible; the QR is not silently wrong |
