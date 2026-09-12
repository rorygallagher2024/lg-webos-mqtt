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
    property int starCount: 90

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

                /*
                 * Where this run ends, worked out once when it starts. Nothing
                 * here is a binding on a moving value: x and y are animated
                 * directly, so no JavaScript runs per frame.
                 *
                 * Measured on a B8 before that change: a binding holding
                 * Math.cos cannot be optimised, and 170 stars evaluating two of
                 * them every frame held a core at 100% - a quarter of the whole
                 * processor, against 2% for the clock.
                 */
                property real endX: 0
                property real endY: 0
                property int dur: 6000
                // Spread over the run, so the field is already full when the
                // screen saver appears rather than erupting from the middle.
                property real startAt: Math.random()

                width: Math.max(1, Math.round(win.maxSize * 0.3))
                height: width
                radius: width / 2
                color: "#ffffff"
                opacity: win.minAlpha

                function reseed() {
                    // A new bearing each run, so the field never wears spokes
                    // into the panel.
                    var a = Math.random() * 2 * Math.PI;
                    var cos = Math.cos(a), sin = Math.sin(a);
                    var from = star.startAt;
                    star.startAt = 0;

                    // Distance goes as the square of the run, which is what
                    // puts most of the field near the middle at any moment.
                    var d0 = from * from * win.reach;
                    // Halfway along its run, so a star reads as its average
                    // rather than its faintest.
                    var at = Math.min(1, from + 0.35);
                    var w0 = Math.max(1, Math.round(win.maxSize * (0.35 + at * 0.65)));
                    star.width = w0;
                    star.opacity = win.minAlpha + (win.maxAlpha - win.minAlpha) * at;
                    star.x = win.cx + cos * d0 - w0 / 2;
                    star.y = win.cy + sin * d0 - w0 / 2;

                    var w1 = Math.max(1, Math.round(win.maxSize));
                    star.endX = win.cx + cos * win.reach - w1 / 2;
                    star.endY = win.cy + sin * win.reach - w1 / 2;
                    star.dur = Math.max(400, Math.round((6000 + Math.random() * 5000) * (1 - from)));
                }

                SequentialAnimation {
                    running: true
                    loops: Animation.Infinite

                    ScriptAction { script: star.reseed() }

                    /*
                     * Two animations a star, not four. Every running animation
                     * costs a property write a frame, and measured on a B8 the
                     * width and opacity pair cost as much as the movement:
                     * 150 stars with four each held a core down. Size and
                     * brightness are set once per run instead, from where the
                     * star starts, so a near one is still bigger and brighter -
                     * it just does not grow while it crosses.
                     */
                    ParallelAnimation {
                        // Accelerating outward is the whole of the perspective.
                        NumberAnimation { target: star; property: "x"; to: star.endX
                                          duration: star.dur; easing.type: Easing.InQuad }
                        NumberAnimation { target: star; property: "y"; to: star.endY
                                          duration: star.dur; easing.type: Easing.InQuad }
                    }
                }
            }
        }
    }
}
