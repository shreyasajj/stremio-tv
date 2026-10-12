import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import StremioTV.Player 1.0

ApplicationWindow {
    id: window
    visible: true
    visibility: Window.FullScreen
    title: "Stremio TV Native"
    color: "#0c0d16"
    property bool controlsVisible: true

    function formatSeconds(value) {
        let s = Math.max(0, Math.floor(value))
        return Math.floor(s / 3600) + ":" + String(Math.floor(s / 60) % 60).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0")
    }

    MpvVideo {
        id: player
        anchors.fill: parent
        focus: true
        Keys.onPressed: event => {
            if (event.key === Qt.Key_Space || event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                player.togglePause(); event.accepted = true
            } else if (event.key === Qt.Key_Left) {
                player.seekRelative(-10); event.accepted = true
            } else if (event.key === Qt.Key_Right) {
                player.seekRelative(10); event.accepted = true
            } else if (event.key === Qt.Key_Up || event.key === Qt.Key_Down) {
                controlsVisible = !controlsVisible; event.accepted = true
            } else if (event.key === Qt.Key_Escape || event.key === Qt.Key_Back) {
                if (controlsVisible) controlsVisible = false
                else { player.stop(); controlsVisible = true }
                event.accepted = true
            }
        }
    }

    Rectangle {
        id: overlay
        visible: controlsVisible
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: 245
        color: "#dd131724"
        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 24
            spacing: 12
            Label { text: "STREMIO TV  •  NATIVE WAYLAND PLAYER"; color: "white"; font.pixelSize: 23; font.bold: true }
            RowLayout {
                TextField {
                    id: urlInput
                    Layout.fillWidth: true
                    placeholderText: "Paste a direct HTTP(S) media URL to test playback"
                    color: "white"
                    selectByMouse: true
                    onAccepted: { player.source = text; player.forceActiveFocus() }
                }
                Button { text: "Play URL"; onClicked: { player.source = urlInput.text; player.forceActiveFocus() } }
            }
            Label { text: "Audio codec: " + (player.codec || "not detected") + "    HDMI output: " + player.audioDevice; color: "#d2dae8" }
            Label { text: window.formatSeconds(player.position) + " / " + window.formatSeconds(player.duration); color: "white" }
            RowLayout {
                Button { text: player.paused ? "▶ Play" : "⏸ Pause"; onClicked: { player.togglePause(); player.forceActiveFocus() } }
                Button { text: "−10s"; onClicked: { player.seekRelative(-10); player.forceActiveFocus() } }
                Button { text: "+10s"; onClicked: { player.seekRelative(10); player.forceActiveFocus() } }
                Button { text: "Stop"; onClicked: { player.stop(); player.forceActiveFocus() } }
                Item { Layout.fillWidth: true }
                Label { text: "↑↓ Controls • ←→ Seek • OK Pause • Back Hide/Stop"; color: "#d2dae8" }
            }
        }
    }
}
