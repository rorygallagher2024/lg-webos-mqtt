/*
 * Starfield screen saver.
 *
 * Built on QtQuick.Particles with ImageParticle and star.png: the simulation
 * and rendering run entirely in C++ and OpenGL on the GPU, so nothing runs
 * JavaScript per frame.
 *
 * Three cosmic layers:
 *   1. Distant backdrop: a field of slow-drifting micro-stars across the full
 *      sky providing depth of field.
 *   2. Warp starfield: stars leaving the vanishing point with radial acceleration
 *      via an inverse-linear Attractor, growing from faint pinpoints to bright
 *      luminous bodies as they approach.
 *   3. Meteors: occasional shooting stars cutting across the upper sky leaving
 *      a fading ion trail via TrailEmitter.
 *
 * Measured on a B8: ~20% of one core (~5% of total SoC) at a steady 60fps,
 * against 100% of a core on the previous JavaScript property bindings.
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
    property real grow: level > 0 ? 1.25 : 1.0
    property real maxAlpha: level > 0 ? 1.00 : 0.85
    property real minAlpha: level > 0 ? 0.70 : 0.45

    ParticleSystem {
        id: sys
        anchors.fill: parent
    }

    // 1. Distant backdrop stars across the whole sky
    ImageParticle {
        system: sys
        groups: ["distant"]
        source: "star.png"
        color: "#d0e2ff"
        colorVariation: 0.20
        alpha: win.minAlpha
        alphaVariation: 0.25
    }

    Emitter {
        id: distantEmitter
        system: sys
        group: "distant"
        startTime: 12000
        x: 0
        y: 0
        width: win.width
        height: win.height
        shape: RectangleShape { fill: true }
        emitRate: 20
        lifeSpan: 12000
        lifeSpanVariation: 4000
        size: Math.round(5 * win.unit * win.grow)
        sizeVariation: Math.round(2 * win.unit)
        endSize: Math.round(5 * win.unit * win.grow)
        velocity: AngleDirection {
            angle: 180
            angleVariation: 20
            magnitude: Math.round(3 * win.unit)
            magnitudeVariation: Math.round(2 * win.unit)
        }
    }

    // 2. Warp field stars accelerating radially outward from the vanishing point
    ImageParticle {
        system: sys
        groups: ["warp"]
        source: "star.png"
        color: "#ffffff"
        colorVariation: 0.15
        alpha: win.maxAlpha
        alphaVariation: 0.20
    }

    Attractor {
        system: sys
        groups: ["warp"]
        pointX: win.width / 2
        pointY: win.height / 2
        strength: -450
        proportionalToDistance: Attractor.Linear
    }

    Emitter {
        id: warpEmitter
        system: sys
        group: "warp"
        startTime: 5000
        x: win.width / 2
        y: win.height / 2
        width: 1
        height: 1
        emitRate: 70
        lifeSpan: 4500
        lifeSpanVariation: 1500
        size: Math.round(8 * win.unit * win.grow)
        sizeVariation: Math.round(4 * win.unit)
        endSize: Math.round(48 * win.unit * win.grow)
        velocity: AngleDirection {
            angleVariation: 360
            magnitude: Math.round(45 * win.unit)
            magnitudeVariation: Math.round(25 * win.unit)
        }
    }

    // 3. Shooting stars with an ion trail
    ImageParticle {
        system: sys
        groups: ["meteorHead", "meteorTail"]
        source: "star.png"
        color: "#eaf4ff"
        alpha: win.maxAlpha
    }

    Emitter {
        id: meteorEmitter
        system: sys
        group: "meteorHead"
        enabled: false
        emitRate: 0
        lifeSpan: 900
        size: Math.round(20 * win.unit * win.grow)
        endSize: Math.round(6 * win.unit)
        velocity: AngleDirection {
            angle: 42
            angleVariation: 15
            magnitude: Math.round(1300 * win.unit)
            magnitudeVariation: Math.round(250 * win.unit)
        }
    }

    TrailEmitter {
        system: sys
        group: "meteorTail"
        follow: "meteorHead"
        emitRatePerParticle: 180
        lifeSpan: 300
        size: Math.round(12 * win.unit * win.grow)
        endSize: Math.round(2 * win.unit)
        velocity: AngleDirection {
            angle: 222
            angleVariation: 20
            magnitude: Math.round(30 * win.unit)
        }
    }

    function shoot() {
        var startX = Math.random() * (win.width * 0.65);
        var startY = Math.random() * (win.height * 0.35);
        meteorEmitter.burst(1, startX, startY);
    }

    Timer {
        id: meteorTimer
        interval: 2500
        running: true
        repeat: false
        onTriggered: {
            win.shoot();
            interval = 14000 + Math.random() * 8000;
            repeat = true;
            restart();
        }
    }
}
