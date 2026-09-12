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
    // firmwares.
    FontLoader { id: thinFace;  source: "file:///usr/share/fonts/MuseoSans-Thin.ttf" }

    // Candidates for the digits, best first. Miso and LG Display Regular are on
    // both firmwares; LG Display Light is on webOS 4 only.
    FontLoader { id: misoFace;  source: "file:///usr/share/fonts/Miso-Light.ttf" }
    FontLoader { id: lgLight;   source: "file:///usr/share/fonts/LG_Display-Light.ttf" }
    FontLoader { id: lgRegular; source: "file:///usr/share/fonts/LG_Display-Regular.ttf" }

    Text { id: metric; visible: false; text: "0" }

    property string digitFamily: ""

    /*
     * Pick a face by measuring it at the size it will actually be drawn.
     *
     * Measured on a B8: Museo Sans lays a digit out at 1.6em at 232px and at a
     * correct 0.6em at 38px, so the same face is fine for the date line and
     * useless for the clock. Rather than encode which face is good on which
     * model, ask each one how wide a "0" comes out and take the first answer
     * that is plausible for a digit.
     */
    function chooseDigitFamily(px) {
        var cands = [misoFace, lgLight, lgRegular, thinFace];
        metric.font.pixelSize = px;
        for (var i = 0; i < cands.length; i++) {
            if (cands[i].status !== FontLoader.Ready) continue;
            metric.font.family = cands[i].name;
            if (metric.width > 0 && metric.width / px < 0.9) return cands[i].name;
        }
        return "";   // whatever the platform defaults to
    }

    property real unit: win.height / 1080

    /*
     * Dim or bright, written in when the screen saver is staged.
     *
     * Dim is deliberately short of white: a screen saver is shown for hours at
     * a time and the point of it is to spare the panel. Bright is for a set in
     * a bright room, and is the reason the position still changes every minute.
     */
    property int level: __TVWEB_LEVEL__
    property color inkBright: level > 0 ? "#ffffff" : "#a8aeb6"
    property color inkDim:    level > 0 ? "#c2c8d0" : "#5c6066"

    function two(n) { return n < 10 ? "0" + n : "" + n }

    Item {
        id: block

        width: timeRow.width
        height: timeRow.height

        // The move itself is slow and eased, so a glance at the screen never
        // catches it jumping.
        Behavior on x { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }
        Behavior on y { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }

        Row {
            id: timeRow
            spacing: 0

            // One Text per digit, each boxed to the width of a "0", so the
            // clock does not shift as the time changes - these figures are
            // proportional, and a "1" is half the width of a "0".
            
            Text {
                id: gauge
                visible: false
                font.family: win.digitFamily
                font.pixelSize: Math.round(232 * win.unit)
                text: "0"
            }

            Text {
                id: hourTens
                width: gauge.width
                horizontalAlignment: Text.AlignHCenter
                font.family: win.digitFamily
                font.pixelSize: Math.round(232 * win.unit)
                color: win.inkBright
                text: "0"
            }
            Text {
                id: hourUnits
                width: gauge.width
                horizontalAlignment: Text.AlignHCenter
                font.family: win.digitFamily
                font.pixelSize: Math.round(232 * win.unit)
                color: win.inkBright
                text: "0"
            }
            // Drawn rather than set as a ":" so the gap either side and the
            // pulse are ours to set, whichever face the measuring picks.
            Item {
                id: colon
                width: Math.round(74 * win.unit)
                height: gauge.height

                // A second of fade each way, so it reads as a pulse rather
                // than a flash.
                SequentialAnimation on opacity {
                    loops: Animation.Infinite
                    running: true
                    NumberAnimation { from: 1.0; to: 0.25; duration: 1000; easing.type: Easing.InOutSine }
                    NumberAnimation { from: 0.25; to: 1.0; duration: 1000; easing.type: Easing.InOutSine }
                }

                Rectangle {
                    width: Math.round(19 * win.unit)
                    height: width
                    radius: width / 2
                    color: win.inkBright
                    x: (colon.width - width) / 2
                    y: Math.round(colon.height * 0.36)
                }
                Rectangle {
                    width: Math.round(19 * win.unit)
                    height: width
                    radius: width / 2
                    color: win.inkBright
                    x: (colon.width - width) / 2
                    y: Math.round(colon.height * 0.63)
                }
            }
            Text {
                id: minTens
                width: gauge.width
                horizontalAlignment: Text.AlignHCenter
                font.family: win.digitFamily
                font.pixelSize: Math.round(232 * win.unit)
                color: win.inkBright
                text: "0"
            }
            Text {
                id: minUnits
                width: gauge.width
                horizontalAlignment: Text.AlignHCenter
                font.family: win.digitFamily
                font.pixelSize: Math.round(232 * win.unit)
                color: win.inkBright
                text: "0"
            }
        }
    }

    function refresh() {
        var now = new Date();
        var h = win.two(now.getHours());
        var m = win.two(now.getMinutes());
        hourTens.text = h.charAt(0);
        hourUnits.text = h.charAt(1);
        minTens.text = m.charAt(0);
        minUnits.text = m.charAt(1);
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
        digitFamily = chooseDigitFamily(Math.round(232 * win.unit));
        refresh();
        move();
    }
}
