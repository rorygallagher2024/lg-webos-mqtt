/*
 * Fireworks screen saver.
 *
 * Written rather than borrowed: the screen saver LG ships is proprietary - its
 * source carries "valid license from LG required for possession, use or
 * copying" - so none of it is here. It is built on QtQuick.Particles, which is
 * part of Qt and present on both firmwares, and so is this.
 *
 * ImageParticle with no source draws Qt's own glowdot, so there is no image to
 * ship either.
 *
 * A burst lives about three seconds and leaves nothing behind, which is as
 * kind to the panel as the starfield: no pixel is asked to hold anything.
 */
import QtQuick 2.4
import QtQuick.Particles 2.0
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

    // Dim or bright, written in when the screen saver is staged.
    property int level: __TVWEB_LEVEL__
    property real ink: level > 0 ? 1.0 : 0.62
    property real grow: level > 0 ? 1.2 : 1.0

    ParticleSystem { id: sys; anchors.fill: parent }

    /*
     * One group per colour rather than one emitter recoloured between bursts:
     * ImageParticle paints every particle in its group, so changing the colour
     * would repaint the burst still falling from last time.
     */
    Repeater {
        model: [ "#ff4d3d", "#ffd23d", "#4dc3ff", "#b46dff", "#5dff9b" ]

        Item {
            ImageParticle {
                system: sys
                groups: [ "g" + index ]
                color: modelData
                colorVariation: 0.25
                alpha: 0
                opacity: win.ink
                entryEffect: ImageParticle.Fade
            }

            Emitter {
                id: shell
                system: sys
                group: "g" + index
                enabled: false
                emitRate: 0
                lifeSpan: 2600
                lifeSpanVariation: 800
                size: Math.round(13 * win.unit * win.grow)
                sizeVariation: Math.round(6 * win.unit)
                endSize: 0
                velocity: AngleDirection {
                    angle: 0
                    angleVariation: 360
                    magnitude: Math.round(300 * win.unit)
                    magnitudeVariation: Math.round(140 * win.unit)
                }
                // Falls away rather than hanging, which is what makes it read
                // as a firework instead of a starburst.
                acceleration: PointDirection { y: Math.round(110 * win.unit) }
            }

            Component.onCompleted: win.emitters.push(shell)
        }
    }

    property var emitters: []

    /*
     * Somewhere new each time, and never against an edge: a burst throws
     * particles outward, so a shell fired near the frame spends half of itself
     * off screen.
     */
    function fire() {
        if (emitters.length === 0) return;
        var e = emitters[Math.floor(Math.random() * emitters.length)];
        var mx = win.width * 0.18;
        var my = win.height * 0.18;
        var x = mx + Math.random() * (win.width - mx * 2);
        var y = my + Math.random() * (win.height * 0.62 - my);
        e.burst(120, x, y);
    }

    Timer {
        // Long enough that the last one has finished falling before the next
        // goes up, so the screen is never busy.
        interval: 2400
        running: true
        repeat: true
        onTriggered: win.fire()
    }

    Component.onCompleted: fire()
}
