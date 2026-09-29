import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    // START: FlutterFire Configuration
    id("com.google.gms.google-services")
    // END: FlutterFire Configuration
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.example.user_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.example.user_app"

        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APk-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName

        // ── Android App Link host for the canonical customer queue QR ──────
        //
        // The canonical QR encodes https://<host>/join?centerId=...
        // This host is the single source of truth for the Android App Link
        // intent filter in AndroidManifest.xml.
        //
        // Override per build without touching source:
        //   flutter build apk --dart-define=... (Dart side)
        //   (cd android && ./gradlew assembleRelease \
        //        -PqueueflowJoinHost=join.your-domain.com)
        //
        // The same value must be used for:
        //   * QUEFLOW_JOIN_HOSTS on the Dart side (so the app trusts the host)
        //   * the host serving /.well-known/assetlinks.json (so Android can
        //     actually verify the App Link)
        //
        // Until assetlinks.json is published and matches this app's signing
        // certificate, Android will NOT launch the app from the HTTPS QR; it
        // will open the Customer Web page instead, which is the intended
        // graceful fallback.
        //
        // Resolution order (first match wins):
        //   1. -PqueueflowJoinHost=<host> on the Gradle command line
        //   2. queueflowJoinHost= in android/queueflow_join_host.properties
        //   3. QUEUEFLOW_JOIN_HOST_HOSTNAME environment variable
        //   4. the placeholder below
        //
        // The placeholder uses the reserved .invalid TLD (RFC 2606), which can
        // never resolve. A build that ships the default therefore cannot be
        // mistaken for a verified App Link: Android cannot verify a domain that
        // does not exist, so the QR falls back to the Customer Web page.
        // Set a real host before shipping.
        val joinHostOverride = (project.findProperty("queueflowJoinHost") as String?)
            ?: rootProject.file("queueflow_join_host.properties")
                .takeIf { it.exists() }
                ?.readLines()
                ?.firstOrNull { it.trimStart().startsWith("queueflowJoinHost=") }
                ?.substringAfter('=')
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
            ?: System.getenv("QUEUEFLOW_JOIN_HOST_HOSTNAME")
            ?: "join.invalid"
        manifestPlaceholders["queueflowJoinHost"] = joinHostOverride
        // Optional secondary host (e.g. an apex + www pair). Repeating the same
        // host in two <data> elements is a manifest-merge error, so the
        // alternative defaults to the primary only when explicitly overridden.
        manifestPlaceholders["queueflowJoinHostAlt"] =
            (project.findProperty("queueflowJoinHostAlt") as String?) ?: joinHostOverride
    }

    val keystorePropertiesFile = rootProject.file("key.properties")
    val keystoreProperties = Properties()
    val hasReleaseSigning = keystorePropertiesFile.exists()

    if (hasReleaseSigning) {
        keystoreProperties.load(FileInputStream(keystorePropertiesFile))
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")

                val storePath = keystoreProperties.getProperty("storeFile")

                if (storePath != null) {
                    storeFile = file(storePath)
                }

                storePassword = keystoreProperties.getProperty("storePassword")
            }
        }
    }

    buildTypes {
        release {
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }

            // Do NOT fall back to debug signing key in release.
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}

flutter {
    source = "../.."
}