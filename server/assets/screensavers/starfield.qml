/*
 * Starfield screen saver.
 *
 * Stars come toward the viewer: each one leaves the centre on a fixed bearing
 * and accelerates outward, growing and brightening as it comes, which is what
 * flying through a starfield looks like.
 *
 * The motion is declarative - one animation per star on its distance from the
 * centre, with x and y bound to it - so the scene graph does the work and
 * nothing recomputes 150 positions in JavaScript every frame.
 *
 * Nothing holds a pixel for more than the second or so a star takes to cross
 * it, so this one needs no repositioning of its own.
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

    // Dim or bright, written in when the screen saver is staged.
    property int level: __TVWEB_LEVEL__
    property real maxAlpha: level > 0 ? 1.00 : 0.72
    property real maxSize: (level > 0 ? 5.0 : 3.4) * win.unit

    property real cx: win.width / 2
    property real cy: win.height / 2
    // Past the corner, so a star leaves the screen rather than vanishing in it.
    property real reach: Math.sqrt(cx * cx + cy * cy) * 1.08

    Item {
        anchors.fill: parent

        Repeater {
            model: win.starCount

            Rectangle {
                id: star

                property real bearing: Math.random() * 2 * Math.PI
                /*
                 * How far along its run this star is, 0 at the centre and 1 at
                 * the edge. Everything else follows from it: position, size and
                 * brightness all read off the same number, so a star that is
                 * nearly on top of you is necessarily the biggest and brightest.
                 */
                property real progress: 0
                // Spread over the run so the field is already full when the
                // screen saver appears, rather than erupting from the middle.
                property real startAt: Math.random()
                property int runTime: 5200 + Math.random() * 4200

                width: Math.max(1, Math.round(win.maxSize * (0.18 + progress * 0.82)))
                height: width
                radius: width / 2
                color: "#ffffff"
                // Held at nothing for the first stretch: a star far enough away
                // to be a point of light should arrive, not appear.
                opacity: win.maxAlpha * Math.min(1, progress * 2.2)

                x: win.cx + Math.cos(bearing) * progress * win.reach - width / 2
                y: win.cy + Math.sin(bearing) * progress * win.reach - height / 2

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
                        // Accelerating, which is the whole of the perspective:
                        // a star covers ground faster the closer it gets.
                        easing.type: Easing.InQuad
                        duration: star.runTime * (1 - star.progress)
                    }
                }
            }
        }
    }
}
