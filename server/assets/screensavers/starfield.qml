/*
 * Starfield screen saver.
 *
 * Stars come toward the viewer: each leaves the centre on a fixed bearing and
 * accelerates outward, growing and brightening as it comes.
 *
 * progress runs linearly in time and everything reads off it, but the distance
 * from the centre goes as its square. That is what puts most of the field near
 * the middle at any moment - a star crosses the inner half of the screen in a
 * quarter of its run and the outer half in the rest - which is what flying into
 * a starfield looks like.
 *
 * A star stays visible for its whole run. Fading it in from nothing while it is
 * also at its smallest leaves the middle of the screen empty, since that is
 * where the stars spend most of their time.
 *
 * The motion is declarative, one animation per star, so the scene graph does
 * the work rather than JavaScript moving 150 items every frame.
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
    property int starCount: 170

    // Dim or bright, written in when the screen saver is staged.
    property int level: __TVWEB_LEVEL__
    property real maxAlpha: level > 0 ? 1.00 : 0.70
    property real minAlpha: level > 0 ? 0.34 : 0.20
    property real maxSize: (level > 0 ? 5.4 : 3.8) * win.unit

    property real cx: win.width / 2
    property real cy: win.height / 2
    // Past the corner, so a star leaves the screen rather than vanishing in it.
    property real reach: Math.sqrt(cx * cx + cy * cy) * 1.1

    Item {
        anchors.fill: parent

        Repeater {
            model: win.starCount

            Rectangle {
                id: star

                property real bearing: Math.random() * 2 * Math.PI
                // 0 at the centre, 1 off the edge. Linear in time.
                property real progress: 0
                // Spread over the run, so the field is already full when the
                // screen saver appears rather than erupting from the middle.
                property real startAt: Math.random()
                property int runTime: 6000 + Math.random() * 5000

                property real dist: progress * progress * win.reach

                width: Math.max(1, Math.round(win.maxSize * (0.3 + progress * 0.7)))
                height: width
                radius: width / 2
                color: "#ffffff"
                opacity: win.minAlpha + (win.maxAlpha - win.minAlpha) * progress

                x: win.cx + Math.cos(bearing) * dist - width / 2
                y: win.cy + Math.sin(bearing) * dist - height / 2

                SequentialAnimation {
                    running: true
                    loops: Animation.Infinite

                    ScriptAction {
                        script: {
                            // A new bearing each run, so the field never wears
                            // spokes into the panel.
                            star.bearing = Math.random() * 2 * Math.PI;
                            star.progress = star.startAt;
                            star.startAt = 0;
                        }
                    }
                    NumberAnimation {
                        target: star
                        property: "progress"
                        to: 1.0
                        duration: star.runTime * (1 - star.progress)
                    }
                }
            }
        }
    }
}
