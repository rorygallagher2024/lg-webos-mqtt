/*
 * Panel vitals screen saver.
 *
 * Reads the same /api/stats the dashboard does, from the server running on
 * this TV. The address is written in when the screen saver is staged, because
 * the port is configurable and the API needs the token when one is set.
 *
 * Rows are built from what the payload actually carries, so an LCD set shows
 * uptime where an OLED shows panel hours.
 *
 * Everything here stays inside QtQuick 2.4: a B8 runs Qt 5.6, and padding
 * properties and anchors inside a Row or Column are either unavailable or
 * ignored there. Spacing is done with explicit items instead.
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

    FontLoader { id: thinFace;  source: "file:///usr/share/fonts/MuseoSans-Thin.ttf" }
    FontLoader { id: lightFace; source: "file:///usr/share/fonts/MuseoSans-Light.ttf" }

    property real unit: win.height / 1080
    property color inkBright: "#d8dade"
    property color inkDim:    "#6d7076"

    property string heroValue: "—"
    property string heroUnit: ""
    property string heroLabel: "PANEL"
    property var rows: []

    function two(n) { return n < 10 ? "0" + n : "" + n }

    // Written out rather than taken from the locale: a screen saver should not
    // depend on which locale plugins the set happens to ship.
    function grouped(n) {
        var s = String(Math.round(n));
        var out = "";
        for (var i = 0; i < s.length; i++) {
            if (i > 0 && (s.length - i) % 3 === 0) out += ",";
            out += s.charAt(i);
        }
        return out;
    }

    function hours(v) {
        if (v === null || v === undefined) return null;
        return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + " h";
    }

    function uptime(sec) {
        if (sec === null || sec === undefined) return null;
        var d = Math.floor(sec / 86400);
        var h = Math.floor((sec % 86400) / 3600);
        var m = Math.floor((sec % 3600) / 60);
        if (d > 0) return d + "d " + h + "h";
        if (h > 0) return h + "h " + m + "m";
        return m + "m";
    }

    function collect(d) {
        var list = [];
        var oled = d.oled;

        if (oled && oled.panel_hours !== undefined && oled.panel_hours !== null) {
            win.heroValue = grouped(oled.panel_hours);
            win.heroUnit = "hours on the panel";
            win.heroLabel = String(d.model || "OLED PANEL").toUpperCase();
            if (hours(oled.hours_until_refresher)) list.push(["Pixel refresher in", hours(oled.hours_until_refresher)]);
            if (hours(oled.hours_until_comp)) list.push(["Panel maintenance in", hours(oled.hours_until_comp)]);
        } else {
            // Not an OLED, or a set that keeps no counters: lead with what it
            // does report rather than a panel block full of dashes.
            win.heroValue = uptime(d.uptime) || "—";
            win.heroUnit = "since last boot";
            win.heroLabel = String(d.model || "THIS TV").toUpperCase();
        }

        if (d.temp !== undefined && d.temp !== null) list.push(["SoC temperature", Math.round(d.temp) + "°"]);
        if (oled && d.uptime !== undefined) list.push(["Uptime", uptime(d.uptime)]);
        win.rows = list;
    }

    function poll() {
        var x = new XMLHttpRequest();
        x.onreadystatechange = function () {
            if (x.readyState !== XMLHttpRequest.DONE) return;
            if (x.status !== 200) return;
            try { collect(JSON.parse(x.responseText)); } catch (e) { }
        };
        x.open("GET", "__TVWEB_URL__");
        x.send();
    }

    function refreshClock() {
        var now = new Date();
        clockLine.text = win.two(now.getHours()) + ":" + win.two(now.getMinutes());
    }

    Item {
        id: block

        width: column.width
        height: column.height

        Behavior on x { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }
        Behavior on y { NumberAnimation { duration: 2600; easing.type: Easing.InOutQuad } }

        Column {
            id: column
            spacing: Math.round(12 * win.unit)

            Text {
                id: clockLine
                font.family: lightFace.name
                font.pixelSize: Math.round(34 * win.unit)
                font.letterSpacing: Math.round(3 * win.unit)
                color: win.inkDim
                text: "00:00"
            }

            Item { width: 1; height: Math.round(16 * win.unit) }

            Text {
                font.family: lightFace.name
                font.pixelSize: Math.round(26 * win.unit)
                font.letterSpacing: Math.round(6 * win.unit)
                color: win.inkDim
                text: win.heroLabel
            }

            Text {
                font.family: thinFace.name
                font.pixelSize: Math.round(150 * win.unit)
                color: win.inkBright
                text: win.heroValue
            }

            Text {
                font.family: lightFace.name
                font.pixelSize: Math.round(30 * win.unit)
                color: win.inkDim
                text: win.heroUnit
            }

            Item { width: 1; height: Math.round(22 * win.unit) }

            Repeater {
                model: win.rows

                Row {
                    spacing: Math.round(20 * win.unit)

                    Text {
                        width: Math.round(340 * win.unit)
                        font.family: lightFace.name
                        font.pixelSize: Math.round(30 * win.unit)
                        color: win.inkDim
                        text: modelData[0]
                    }
                    Text {
                        font.family: lightFace.name
                        font.pixelSize: Math.round(30 * win.unit)
                        color: win.inkBright
                        text: modelData[1]
                    }
                }
            }
        }
    }

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

    Timer { interval: 1000;  running: true; repeat: true; onTriggered: win.refreshClock() }
    Timer { interval: 60000; running: true; repeat: true; onTriggered: win.move() }
    // The panel counters move in hours. Asking more often would only wake the
    // server for the same numbers.
    Timer { interval: 120000; running: true; repeat: true; onTriggered: win.poll() }

    Component.onCompleted: {
        refreshClock();
        move();
        poll();
    }
}
