/*
 * Starfield screen saver.
 *
 * Small moving points on black, which is the gentlest thing an OLED can be
 * asked to show: no pixel holds a colour for longer than it takes one star to
 * cross it, so this one needs no repositioning of its own.
 *
 * Stars are plain Rectangles rather than a repainted Canvas - the scene graph
 * composites them on the GPU, and a 2018 SoC has no trouble with a few hundred.
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

    property real unit: win.height / 1080
    property int starCount: 150

    /*
     * Dim or bright, written in when the screen saver is staged. Bright lifts
     * the floor as well as the ceiling, so the far stars read as stars rather
     * than as dust, and adds a little size with it.
     */
    property int level: __TVWEB_LEVEL__
    property real dimmest:  level > 0 ? 0.42 : 0.13
    property real brightest: level > 0 ? 1.00 : 0.63
    property real sizeScale: level > 0 ? 1.5 : 1.0

    Item {
        anchors.fill: parent

        Repeater {
            model: win.starCount

            Rectangle {
                id: star

                /*
                 * Three depths' worth of parallax out of one number: the near
                 * stars are bigger, brighter and quicker, and everything else
                 * follows from it.
                 */
                property real depth: Math.random()
                property real size: Math.max(1, Math.round((1.0 + depth * 2.6) * win.unit * win.sizeScale))
                property int travel: Math.round(26000 - depth * 17000)

                /*
                 * Where this pass begins. The first is somewhere across the
                 * screen so the field is already full when the screen saver
                 * appears; every pass after that enters from the right edge.
                 */
                property real startX: Math.random() * win.width
                property int dur: travel

                width: size
                height: size
                radius: size / 2
                color: "#ffffff"
                opacity: win.dimmest + depth * (win.brightest - win.dimmest)

                SequentialAnimation {
                    running: true
                    loops: Animation.Infinite

                    ScriptAction {
                        script: {
                            star.x = star.startX;
                            // A new lane each pass, or the field settles into
                            // fixed tracks across the panel.
                            star.y = Math.random() * win.height;
                            // Time proportional to the distance left, so a
                            // short first pass does not crawl.
                            star.dur = Math.max(250, Math.round(
                                star.travel * (star.x + 8) / (win.width + star.size + 8)));
                            star.startX = win.width + star.size;
                        }
                    }
                    NumberAnimation {
                        target: star
                        property: "x"
                        to: -8
                        duration: star.dur
                    }
                }
            }
        }
    }
}
