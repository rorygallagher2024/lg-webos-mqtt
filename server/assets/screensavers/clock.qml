/*
 * Clock screen saver.
 *
 * Mounted over com.webos.app.screensaver, so it runs as the platform's own
 * screen saver and is dismissed the same way. QtQuick 2.4 and Eos.Window are
 * the versions a webOS 4 set has; a webOS 9 set imports them too.
 *
 * Black ground rather than a dark grey: on an OLED that is the pixels off.
 */
import QtQuick 2.4
import Eos.Window 0.1
import QtQuick.Window 2.2

WebOSWindow {
    id: win

    width: Screen.width > 0 ? Screen.width : 1920
    height: Screen.height > 0 ? Screen.height : 1080

    windowType: "_WEBOS_WINDOW_TYPE_SCREENSAVER"
    appId: "com.webos.app.screensaver"
    title: "Screen Saver"
    visible: true
    color: "black"

    // Loaded by path rather than family name, which differs between the two
    // firmwares. Both carry these two faces.
    FontLoader { id: thinFace;  source: "file:///usr/share/fonts/MuseoSans-Thin.ttf" }
    FontLoader { id: lightFace; source: "file:///usr/share/fonts/MuseoSans-Light.ttf" }

    property real unit: win.height / 1080
    // Never full white. A screen saver is shown for hours at a time, and the
    // point of it is to spare the panel.
    property color inkBright: "#d8dade"
    property color inkDim:    "#6d7076"

    function two(n) { return n < 10 ? "0" + n : "" + n }

    Item {
        id: block

        width: column.width
        height: column.height

        // The move itself is slow and eased, so a glance at the screen never
        // catches it jumping.
        Behavior on x { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }
        Behavior on y { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }

        Column {
            id: column
            spacing: Math.round(28 * win.unit)

            Row {
                id: timeRow
                spacing: 0

                Text {
                    id: hours
                    font.family: thinFace.name
                    font.pixelSize: Math.round(232 * win.unit)
                    color: win.inkBright
                    text: "00"
                }
                Text {
                    id: colon
                    font.family: thinFace.name
                    font.pixelSize: Math.round(232 * win.unit)
                    color: win.inkBright
                    text: ":"
                    // A second of fade each way, so it reads as a pulse rather
                    // than a flash.
                    SequentialAnimation on opacity {
                        loops: Animation.Infinite
                        running: true
                        NumberAnimation { from: 1.0; to: 0.25; duration: 1000; easing.type: Easing.InOutSine }
                        NumberAnimation { from: 0.25; to: 1.0; duration: 1000; easing.type: Easing.InOutSine }
                    }
                }
                Text {
                    id: minutes
                    font.family: thinFace.name
                    font.pixelSize: Math.round(232 * win.unit)
                    color: win.inkBright
                    text: "00"
                }
            }

            Text {
                id: dateLine
                anchors.horizontalCenter: timeRow.horizontalCenter
                font.family: lightFace.name
                font.pixelSize: Math.round(38 * win.unit)
                font.letterSpacing: Math.round(7 * win.unit)
                color: win.inkDim
                text: ""
            }
        }
    }

    function refresh() {
        var now = new Date();
        hours.text = win.two(now.getHours());
        minutes.text = win.two(now.getMinutes());
        dateLine.text = Qt.formatDate(now, "dddd d MMMM").toUpperCase();
    }

    /*
     * Somewhere new every minute, inside a margin wide enough that the block
     * never touches an edge. Rejecting a spot close to the current one keeps it
     * from shuffling in place, which would defeat the point.
     */
    function move() {
        var margin = Math.round(120 * win.unit);
        var spanX = Math.max(0, win.width - block.width - margin * 2);
        var spanY = Math.max(0, win.height - block.height - margin * 2);
        var nx = 0, ny = 0;
        for (var i = 0; i < 8; i++) {
            nx = margin + Math.random() * spanX;
            ny = margin + Math.random() * spanY;
            if (Math.abs(nx - block.x) > win.width / 6 || Math.abs(ny - block.y) > win.height / 6) break;
        }
        block.x = nx;
        block.y = ny;
    }

    Timer { interval: 1000;  running: true; repeat: true; onTriggered: win.refresh() }
    Timer { interval: 60000; running: true; repeat: true; onTriggered: win.move() }

    Component.onCompleted: {
        refresh();
        move();
    }
}
