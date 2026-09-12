/*
 * Starscape screen saver.
 *
 * Polished, serene cosmic starscape for OLED panels:
 *   1. Deep backdrop: dense field of slow-drifting micro-stars across the full
 *      sky providing celestial depth of field.
 *   2. Mid-field stars: crisp celestial bodies with parallax drift and spectral
 *      variation (diamond, ice blue, and warm golden tones).
 *   3. Bright stellar gems: luminous glowing stars with soft halo aura.
 *   4. Shooting stars (meteors): realistic meteors entering from off-screen,
 *      streaking smoothly across the sky, and flying completely off-screen
 *      with a continuous luminous ion trail.
 *
 * Runs entirely in compiled C++ and OpenGL on the GPU via QtQuick.Particles 2.0.
 * Zero per-frame JavaScript evaluations, steady 60fps, low CPU load.
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
    property real midAlpha: level > 0 ? 0.85 : 0.65
    property real minAlpha: level > 0 ? 0.65 : 0.40

    ParticleSystem {
        id: sys
        anchors.fill: parent
    }

    // ------------------------------------------------ 1. Distant micro-stars
    ImageParticle {
        system: sys
        groups: ["micro"]
        source: "star.png"
        color: "#d4e6ff"
        colorVariation: 0.15
        alpha: win.minAlpha
        alphaVariation: 0.25
    }

    Emitter {
        id: microEmitter
        system: sys
        group: "micro"
        startTime: 16000
        x: 0
        y: 0
        width: win.width
        height: win.height
        shape: RectangleShape { fill: true }
        emitRate: 45
        lifeSpan: 16000
        lifeSpanVariation: 4000
        size: Math.round(3.5 * win.unit * win.grow)
        sizeVariation: Math.round(1.5 * win.unit)
        endSize: Math.round(3.5 * win.unit * win.grow)
        velocity: AngleDirection {
            angle: 210
            angleVariation: 10
            magnitude: Math.round(1.8 * win.unit)
        }
    }

    // ------------------------------------------------ 2. Mid-field luminous stars
    ImageParticle {
        system: sys
        groups: ["midfield"]
        source: "star.png"
        color: "#ffffff"
        colorVariation: 0.20
        alpha: win.midAlpha
        alphaVariation: 0.20
    }

    Emitter {
        id: midEmitter
        system: sys
        group: "midfield"
        startTime: 14000
        x: 0
        y: 0
        width: win.width
        height: win.height
        shape: RectangleShape { fill: true }
        emitRate: 18
        lifeSpan: 14000
        lifeSpanVariation: 3000
        size: Math.round(7 * win.unit * win.grow)
        sizeVariation: Math.round(2.5 * win.unit)
        endSize: Math.round(7 * win.unit * win.grow)
        velocity: AngleDirection {
            angle: 210
            angleVariation: 8
            magnitude: Math.round(3.8 * win.unit)
        }
    }

    // ------------------------------------------------ 3. Bright stellar gems
    ImageParticle {
        system: sys
        groups: ["gems"]
        source: "star.png"
        color: "#fff9f0"
        colorVariation: 0.25
        alpha: win.maxAlpha
        alphaVariation: 0.15
    }

    Emitter {
        id: gemEmitter
        system: sys
        group: "gems"
        startTime: 12000
        x: 0
        y: 0
        width: win.width
        height: win.height
        shape: RectangleShape { fill: true }
        emitRate: 4
        lifeSpan: 12000
        lifeSpanVariation: 3000
        size: Math.round(13 * win.unit * win.grow)
        sizeVariation: Math.round(3.5 * win.unit)
        endSize: Math.round(13 * win.unit * win.grow)
        velocity: AngleDirection {
            angle: 210
            angleVariation: 6
            magnitude: Math.round(6.5 * win.unit)
        }
    }

    // ------------------------------------------------ 4. Shooting stars (meteors)
    ImageParticle {
        system: sys
        groups: ["meteorHead", "meteorTail"]
        source: "star.png"
        color: "#f0f6ff"
        alpha: win.maxAlpha
    }

    Emitter {
        id: meteorEmitter
        system: sys
        group: "meteorHead"
        enabled: false
        emitRate: 0
        // Positioned safely off-screen so initialization never paints a corner artifact
        x: -500
        y: -500
        width: 1
        height: 1
        lifeSpan: 1600
        size: Math.round(18 * win.unit * win.grow)
        endSize: Math.round(12 * win.unit * win.grow)
        velocity: AngleDirection {
            angle: 38
            angleVariation: 6
            magnitude: Math.round(1900 * win.unit)
        }
    }

    TrailEmitter {
        system: sys
        group: "meteorTail"
        follow: "meteorHead"
        emitRatePerParticle: 550
        lifeSpan: 380
        size: Math.round(13 * win.unit * win.grow)
        endSize: Math.round(1 * win.unit)
        velocity: AngleDirection {
            angle: 218
            angleVariation: 10
            magnitude: Math.round(30 * win.unit)
        }
    }

    function shoot() {
        // Start off-screen: either above the top edge or to the left of the left edge
        if (Math.random() < 0.65) {
            meteorEmitter.x = Math.random() * (win.width * 0.70);
            meteorEmitter.y = -50;
        } else {
            meteorEmitter.x = -50;
            meteorEmitter.y = Math.random() * (win.height * 0.45);
        }
        meteorEmitter.burst(1);
    }

    Timer {
        id: meteorTimer
        interval: 3500
        running: true
        repeat: false
        onTriggered: {
            win.shoot();
            interval = 11000 + Math.random() * 9000;
            repeat = true;
            restart();
        }
    }
}
