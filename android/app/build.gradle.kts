plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.bilimusic.app"
    compileSdk = 35
    // 不写这行的话，AGP 8.7 会默认去装 build-tools 34，
    // 而它从 dl.google.com 拉，慢到能卡十几分钟。指定用已装好的 35。
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.bilimusic.app"
        minSdk = 24              // Android 7.0
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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

// 每次构建前把根目录的播放器脚本同步进 assets，
// 这样改 bili-music.js 后直接重新打包即可，不用手工复制。
val syncPlayerScript = tasks.register<Copy>("syncPlayerScript") {
    from(rootProject.file("../bili-music.js"))
    into(layout.projectDirectory.dir("src/main/assets"))
}

tasks.named("preBuild") {
    dependsOn(syncPlayerScript)
}

dependencies {
    // 全部用系统 API（WebView / Service / Notification），无第三方依赖
}
