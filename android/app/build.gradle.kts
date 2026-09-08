plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.shorthand.expander"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.shorthand.expander"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
