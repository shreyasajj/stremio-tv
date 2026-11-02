import QtQuick
import QtQuick.Window
import QtWebEngine
import QtWebChannel
import StremioTV.Native

// libmpv video underneath, the existing remote-first web UI on top. The page
// goes transparent while the player is open so the video shows through.
Window {
    id: window
    visible: true
    visibility: shell.windowed ? Window.Windowed : Window.FullScreen
    width: 1280
    height: 720
    color: "black"
    title: "Stremio TV"

    // Like the Electron kiosk window: if something drops us out of
    // fullscreen, go back.
    onVisibilityChanged: {
        if (!shell.windowed && window.visibility !== Window.FullScreen && window.visibility !== Window.Hidden)
            Qt.callLater(window.showFullScreen)
    }
    // Losing focus pauses playback (handled in the UI).
    onActiveChanged: active ? shell.windowFocus() : shell.windowBlur()

    ShellBridge {
        id: shell
        WebChannel.id: "native"
    }

    MpvController {
        id: mpv
        WebChannel.id: "mpv"
    }

    MpvVideo {
        anchors.fill: parent
        controller: mpv
    }

    WebEngineProfile {
        id: profile
        // Persistent so localStorage (addons, settings, progress) survives.
        storageName: "StremioTV"
        offTheRecord: false
        httpCacheType: WebEngineProfile.DiskHttpCache
        persistentCookiesPolicy: WebEngineProfile.ForcePersistentCookies
    }

    WebEngineView {
        id: web
        anchors.fill: parent
        focus: true
        profile: profile
        backgroundColor: "transparent"
        settings.localContentCanAccessRemoteUrls: true
        settings.playbackRequiresUserGesture: false
        settings.javascriptCanAccessClipboard: true
        settings.showScrollBars: false
        settings.focusOnNavigationEnabled: true
        webChannel: WebChannel {
            registeredObjects: [shell, mpv]
        }

        Component.onCompleted: {
            const script = WebEngine.script()
            script.name = "stremio-tv-bridge"
            script.sourceCode = shell.injectScript
            script.injectionPoint = WebEngineScript.DocumentCreation
            script.worldId = WebEngineScript.MainWorld
            userScripts.insert(script)
            url = shell.uiUrl
            forceActiveFocus()
        }

        onRenderProcessTerminated: (status, code) => {
            console.warn("Web UI process terminated (" + status + ", " + code + "), reloading")
            mpv.command(["stop"])
            reloadTimer.start()
        }
        Timer {
            id: reloadTimer
            interval: 500
            onTriggered: web.reload()
        }

        // Never navigate away from the UI (e.g. a stray link); open nothing.
        onNewWindowRequested: request => request.action = WebEngineNewWindowRequest.IgnoreRequest
        onFeaturePermissionRequested: (origin, feature) => web.grantFeaturePermission(origin, feature, false)
        onJavaScriptConsoleMessage: (level, message, line, source) => {
            if (shell.testMode || level >= WebEngineView.WarningMessageLevel)
                console.log("[ui]", message, "(" + source + ":" + line + ")")
        }
    }
}
