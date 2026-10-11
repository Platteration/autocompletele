import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing. The upload key is read from android/keystore.properties (git-ignored)
// or from the environment (CI secrets); see README.md "Release build". When neither is
// present the release build is left unsigned, so `bundleRelease` still works for checks.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) FileInputStream(file).use { load(it) }
}
fun signingValue(name: String): String? =
    keystoreProperties.getProperty(name) ?: System.getenv(name)
val hasUploadKey = listOf("KEYSTORE_FILE", "KEYSTORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD")
    .all { !signingValue(it).isNullOrBlank() }

android {
    namespace = "com.shorthand.expander"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.shorthand.expander"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (hasUploadKey) {
            create("upload") {
                storeFile = rootProject.file(signingValue("KEYSTORE_FILE")!!)
                storePassword = signingValue("KEYSTORE_PASSWORD")
                keyAlias = signingValue("KEY_ALIAS")
                keyPassword = signingValue("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasUploadKey) signingConfig = signingConfigs.getByName("upload")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // The app deliberately uses only framework classes (no AndroidX) to stay small.
    testImplementation("junit:junit:4.13.2")
    // org.json is part of Android but not of the JVM used for unit tests.
    testImplementation("org.json:json:20240303")
}
