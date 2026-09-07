# LG webOS TV Monitor & Home Assistant MQTT Integration

A lightweight, zero-dependency on-TV telemetry server, web dashboard, and Home Assistant MQTT Auto-Discovery integration for rooted LG webOS Smart TVs.

Verified on **LG OLED65B8SLC (webOS 4.4.3)**. Compatible with webOS 3.5+ running Node.js v0.12+.

---

## Features

- **Home Assistant MQTT Auto-Discovery**: Automatically creates a single **"LG webOS TV"** device in Home Assistant with 33 native entities and zero YAML configuration needed.
- **OLED Panel Blanking Switch (`switch.lg_tv_display_panel`)**: Turn off the OLED screen while audio/music continues playing (`turnOffScreen`). Perfect for listening to Spotify, Tidal, or AirPlay without risking OLED burn-in or wasting panel hours.
- **OLED Panel Health & Pixel Refresher Observability**:
  - **Total Panel Runtime (`sensor.lg_tv_oled_panel_hours`)**: Live cumulative panel operating hours tracked directly by the display controller.
  - **Short Compensation Cycles (`sensor.lg_tv_oled_hours_since_compensation`, `sensor.lg_tv_oled_hours_until_compensation`)**: Monitors hours since the last 4-hour Off-RS cycle and calculates when the next one will trigger upon standby.
  - **Deep Pixel Refresher (`sensor.lg_tv_oled_hours_since_refresher`, `sensor.lg_tv_oled_hours_until_refresher`)**: Tracks hours since the last 2,000-hour deep Pixel Refresher ("JB / Panel Wash") and estimates hours remaining until the next one.
  - **Pixel Refresher Control (`switch.lg_tv_pixel_refresher_schedule`, `sensor.lg_tv_oled_refresher_status`)**: View refresher state and schedule/cancel a Pixel Refresher run for the next power-off directly from Home Assistant or the web UI.
  - **Burn-In Protection Telemetry (`sensor.lg_tv_oled_screen_shift`, `sensor.lg_tv_oled_logo_dimming`)**: Real-time status of Screen Shift (pixel orbiting) and Logo Luminance Adjustment.
- **Deep Video & Audio Observability**:
  - **Dynamic Range (`sensor.lg_tv_dynamic_range`)**: Real-time detection of **Dolby Vision**, **HDR**, or **SDR**.
  - **Picture Mode (`sensor.lg_tv_picture_mode`)**: Reports current profile (e.g. *Dolby Vision Cinema*, *ISF Expert*, *Game*).
  - **OLED Light (`sensor.lg_tv_oled_light`)**: Live panel backlight brightness level (`0-100%`).
  - **Video Signal (`sensor.lg_tv_video_signal`)**: Raw resolution and refresh rate directly from HDMI status (e.g. `3840x2160 @ 60Hz`).
  - **Audio Output (`sensor.lg_tv_audio_output`)**: Active audio routing scenario (e.g. *Optical / Headphone*, *TV Speaker*, *HDMI ARC*).
  - **Active Input & Friendly CEC Names (`sensor.lg_tv_active_app`)**: Resolves HDMI ports to friendly labels (e.g. `Apple TV (HDMI 2)`, `Xbox (HDMI 1)`).
- **Hardware Telemetry & Health Monitoring**:
  - SoC Temperature (`°C`) with native graph history
  - Overall CPU usage (`%`) and individual core breakdowns
  - Memory and zram Swap utilization
  - Real-time SoC Current draw (`sensor.lg_tv_soc_current` in `mA`, measuring CPU & Core AVS power draw)
  - Wi-Fi RSSI signal strength (`dBm`)
  - Live network download/upload rates (`kB/s`)
  - Flash storage (eMMC) life and wear monitoring with JEDEC health translation
- **Full Local Control**:
  - Volume slider (`number.lg_tv_volume`)
  - Mute switch (`switch.lg_tv_mute`)
  - Input selector (`select.lg_tv_input_source`: HDMI 1–4, Live TV)
  - Screen notifications (`text.lg_tv_screen_notification` for custom on-screen toast messages)
  - Power & Restart buttons (`button.lg_tv_power_off`, `button.lg_tv_restart`)
- **Standalone Mobile Dashboard**: Access live stats and controls directly in your phone or laptop browser at `http://<tv-ip>:8080/`.
- **Zero Dependencies**: Pure ES5 implementation running on the TV's native Node.js v0.12 without `npm`. Minimal footprint (<0.1% CPU).
- **Persistent Boot Hook**: Automatically launches on TV startup via webOS Homebrew Channel (`init.d`).

---

## Architecture & Stability

```
                  ┌─────────────────────────────────────────┐
                  │          LG webOS TV (Rooted)           │
                  │              (Node 0.12)                │
                  │  ┌───────────────────┐ ┌─────────────┐  │
                  │  │ HTTP Dashboard UI │ │  MiniMQTT   │  │
                  │  │ (Port 8080)       │ │  Client     │  │
                  │  └─────────┬─────────┘ └──────┬──────┘  │
                  │            │                  │         │
                  │            ▼                  ▼         │
                  │   In-Flight Concurrency Mutex & Caching │
                  │            │                  │         │
                  │            ▼                  ▼         │
                  │   Direct execFile (luna-send -w 2000)   │
                  │      webOS Luna Bus & /proc telemetry   │
                  └───────────────────────────────┬─────────┘
                                                  │
                                    MQTT TCP 1883 │ (Telemetry + Controls)
                                                  ▼
                  ┌─────────────────────────────────────────┐
                  │          MQTT Broker / Mosquitto        │
                  └───────────────────────┬─────────────────┘
                                          │
                                          ▼
                  ┌─────────────────────────────────────────┐
                  │             Home Assistant              │
                  │        (Auto-Discovered Device)         │
                  └─────────────────────────────────────────┘
```

### High-Stability Process Execution
Older Linux kernels and Node 0.12 can encounter process deadlocks or child leaks when `child_process.exec()` is called frequently (spawning `/bin/sh` without timeout parameters). 

`tvweb.js` solves this with:
1. **Direct `execFile`**: Invokes `/usr/bin/luna-send` directly with zero shell overhead.
2. **Internal Daemon Timeout**: Luna calls use `-w 2000` to prevent orphaned background processes if a system bus stalls.
3. **In-Flight Concurrency Mutex**: If multiple HTTP pollers or MQTT intervals request stats simultaneously, they are coalesced into a single execution pipeline.
4. **Memory Caching**: Telemetry is cached for 1.5 seconds, delivering sub-20ms HTTP responses with zero subprocess spawning during rapid UI updates.

---

## ⚠️ Disclaimer & Safety

**Use this software at your own risk.**

- **Root Access & Hardware**: This project runs custom software with `root` privileges on an embedded Smart TV operating system. While designed to be lightweight, read-only to rootfs, and non-destructive, the authors and contributors assume **no responsibility or liability** for any damage, bootloops, bricked devices, voided warranties, data loss, OLED panel issues, or unexpected behavior resulting from the use or misuse of this software.
- **Power & Control Commands**: Features such as rebooting, power off, screen blanking, and Pixel Refresher scheduling issue low-level commands directly to webOS system services (`luna-send`). Ensure you understand what each command does before executing it.
- **Trademark Notice**: This is an independent, unofficial open-source community project. It is not affiliated with, endorsed by, or associated with LG Electronics Inc. in any way. webOS is a trademark of LG Electronics.

---

## Quick Start

### 1. Prerequisites

- Rooted LG webOS TV with [webosbrew (Homebrew Channel)](https://github.com/webosbrew/webos-homebrew-channel) installed.
- Root Telnet enabled on port 23 (standard on rooted webOS devices).
- (Optional) An MQTT broker (e.g. Mosquitto in Home Assistant) reachable on your LAN.

### 2. Configuration

Copy `config.example.json` to `server/config.json` and set your MQTT broker and device details:

```bash
cp config.example.json server/config.json
```

```json
{
  "port": 8080,
  "host": "0.0.0.0",
  "allowControl": true,
  "allowPower": true,
  "token": "",
  "mqtt": {
    "enabled": true,
    "host": "192.168.1.125",
    "port": 1883,
    "username": "",
    "password": "",
    "topicPrefix": "lgtv",
    "discoveryPrefix": "homeassistant",
    "telemetryIntervalMs": 10000
  },
  "device": {
    "id": "lg_tv",
    "name": "LG webOS TV",
    "model": "",
    "manufacturer": "LG"
  }
}
```

> **Note:** If `name` or `model` are left empty, `tvweb.js` automatically queries the TV's system property service to detect your exact model number (e.g. `OLED65B8SLC`, `OLED55C1PUB`, etc.) and firmware version!

### 3. Deploy to TV

Deploy `tvweb.js` and install the boot hook so it survives TV reboots:

```bash
cd server
./deploy.sh <tv-ip> --persist
```

The script will:
1. Temporarily serve the files from your computer and download them onto the TV (`/var/lib/tvweb/`).
2. Cleanly start `tvweb.js` under `setsid`.
3. If `--persist` is specified, install `/var/lib/webosbrew/init.d/50-tvweb`.
4. Clean up any temporary transfer ports.

---

## Home Assistant Entities

Once the TV connects to MQTT, the following **24 entities** appear under the auto-discovered device (with your TV's actual detected model number):

| Domain | Entity ID | Name | Description |
| :--- | :--- | :--- | :--- |
| `switch` | `switch.lg_tv_display_panel` | OLED Display Panel | Blanks/turns off OLED panel while audio plays |
| `switch` | `switch.lg_tv_mute` | Mute | Toggle audio mute |
| `number` | `number.lg_tv_volume` | Volume | Volume slider (0–100) |
| `select` | `select.lg_tv_input_source` | Input Source | HDMI 1–4, Live TV |
| `text` | `text.lg_tv_screen_notification` | Screen Notification | Sends a toast message to TV screen |
| `button` | `button.lg_tv_restart` | Restart TV | Reboots the TV (when `allowPower: true`) |
| `button` | `button.lg_tv_power_off` | Power Off TV | Powers down the TV (when `allowPower: true`) |
| `sensor` | `sensor.lg_tv_dynamic_range` | Dynamic Range | **Dolby Vision**, **HDR**, or **SDR** |
| `sensor` | `sensor.lg_tv_picture_mode` | Picture Mode | Current picture profile (e.g. *Dolby Vision Cinema*) |
| `sensor` | `sensor.lg_tv_oled_light` | OLED Light | OLED panel backlight level (`0-100%`) |
| `sensor` | `sensor.lg_tv_video_signal` | Video Signal | HDMI resolution & refresh rate (e.g. `3840x2160 @ 60Hz`) |
| `sensor` | `sensor.lg_tv_audio_output` | Audio Output | Audio scenario (e.g. *Optical / Headphone*, *TV Speaker*) |
| `sensor` | `sensor.lg_tv_active_app` | Active App | Current foreground app or friendly CEC device |
| `sensor` | `sensor.lg_tv_soc_current` | SoC Current | Total processor current draw (`mA`) |
| `sensor` | `sensor.lg_tv_soc_temperature` | SoC Temperature | TV processor temperature (`°C`) |
| `sensor` | `sensor.lg_tv_cpu_usage` | CPU Usage | Real-time CPU load (`%`) |
| `sensor` | `sensor.lg_tv_memory_usage` | Memory Usage | System RAM usage (`%`) |
| `sensor` | `sensor.lg_tv_swap_usage` | Swap Usage | zram Swap usage (`%`) |
| `sensor` | `sensor.lg_tv_wifi_signal` | Wi-Fi Signal | Wi-Fi signal strength (`dBm`) |
| `sensor` | `sensor.lg_tv_download_rate` | Download Rate | Live network throughput (`kB/s`) |
| `sensor` | `sensor.lg_tv_upload_rate` | Upload Rate | Live network upload throughput (`kB/s`) |
| `sensor` | `sensor.lg_tv_flash_health` | Flash Storage Health | eMMC remaining health estimate (`>90% (Healthy)`) |
| `sensor` | `sensor.lg_tv_flash_wear` | Flash Wear Level | JEDEC write-cycle consumption (`0-10%`) |
| `sensor` | `sensor.lg_tv_uptime` | Uptime | TV uptime in seconds |

---

## eMMC Flash Storage: Health vs. Wear

Under the **JEDEC eMMC 5.0** specification, `/sys/block/mmcblk0/device/life_time` returns byte estimates for SLC and MLC partition write cycles:
- `0x01` indicates **0% – 10% of rated device write cycles used**.
- This means **>90% of drive life remains** (Healthy).
- `pre_eol_info` returning `01` indicates normal endurance (<80% reserved blocks consumed).

To prevent user confusion, `tvweb.js` translates this into both a human-friendly health state (`>90% (Healthy)`) and a wear estimate (`0-10% used`).

---

## Home Assistant Automation Examples

### 1. Automatically Blank Screen When Playing Music (Spotify / AirPlay)

Save OLED panel hours and prevent burn-in when the TV is used as a music streamer:

```yaml
alias: "TV: Turn Off Screen for Music"
trigger:
  - platform: state
    entity_id: sensor.lg_tv_active_app
    to: "spotify"
    for:
      seconds: 30
condition:
  - condition: state
    entity_id: switch.lg_tv_display_panel
    state: "on"
action:
  - service: switch.turn_off
    target:
      entity_id: switch.lg_tv_display_panel
```

### 2. Turn on Cinema Lighting When Dolby Vision Starts

Trigger an ambient lighting scene whenever 4K Dolby Vision playback begins:

```yaml
alias: "Cinema: Dim Lights on Dolby Vision"
trigger:
  - platform: state
    entity_id: sensor.lg_tv_dynamic_range
    to: "Dolby Vision"
action:
  - service: scene.turn_on
    target:
      entity_id: scene.movie_night
```

### 3. Send Doorbell / Alert Toast to TV Screen

Display a heads-up notification on the TV when a doorbell rings:

```yaml
alias: "Notify TV on Doorbell"
trigger:
  - platform: state
    entity_id: binary_sensor.front_doorbell_motion
    to: "on"
action:
  - service: text.set_value
    target:
      entity_id: text.lg_tv_screen_notification
    data:
      value: "Motion detected at front door"
```

---

## Uninstallation

To completely remove the service and boot hook from the TV:

```bash
# Connect via telnet
nc 192.168.1.134 23

# Inside TV shell:
pkill -9 -f tvweb.js
rm -rf /var/lib/tvweb
rm -f /var/lib/webosbrew/init.d/50-tvweb*
exit
```

Nothing on the TV's read-only rootfs is ever touched.

---

## Technical Notes

- **Node.js v0.12 (2015)**: webOS 4.x ships Node v0.12.2. All code in `tvweb.js` is written in strict ES5 (no `let`/`const`, no arrow functions, no template literals, no `async`/`await`).
- **BusyBox `run-parts` Hook Naming**: The webosbrew startup system invokes user hooks with `run-parts /var/lib/webosbrew/init.d`. BusyBox `run-parts` strictly ignores any filename containing a dot (`.`), so the boot hook must be named `50-tvweb` without `.sh`.
- **Luna Bus Introspection**: Control commands interact with webOS via native `luna-send` calls (`com.webos.audio`, `com.webos.service.tvpower`, `com.webos.applicationManager`, `com.webos.notification`, `com.webos.service.settings`, `com.webos.service.eim`).

---

## License

MIT License. See [LICENSE](LICENSE) for details.
