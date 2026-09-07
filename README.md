# LG webOS TV Monitor & Home Assistant MQTT Integration

A lightweight, zero-dependency on-TV telemetry server, web dashboard, and Home Assistant MQTT Auto-Discovery integration for rooted LG webOS Smart TVs.

Verified on **LG OLED65B8SLC (webOS 4.4.3)**. Compatible with webOS 3.5+ running Node.js v0.12+.

---

## Features

- **Home Assistant MQTT Auto-Discovery**: Automatically creates a single **"LG OLED TV"** device in Home Assistant with zero YAML configuration needed.
- **OLED Panel Blanking Switch (`switch.lg_b8_display_panel`)**: Turn off the OLED screen while audio/music continues playing (`turnOffScreen`). Perfect for listening to Spotify, Tidal, or AirPlay without risking OLED burn-in or wasting panel hours.
- **Hardware Telemetry & Health Monitoring**:
  - SoC Temperature (`°C`) with native graph history
  - Overall CPU usage (`%`) and individual core breakdowns
  - Memory and zram Swap utilization
  - Wi-Fi RSSI signal strength (`dBm`)
  - Live network download/upload rates (`kB/s`)
  - Flash storage (eMMC) life wear indicator (`life_time` / `pre_eol_info`)
- **Full Local Control**:
  - Volume slider (`number.lg_b8_volume`)
  - Mute switch (`switch.lg_b8_mute`)
  - Input selector (`select.lg_b8_input_source`: HDMI 1–4, Live TV)
  - Screen notifications (`text.lg_b8_screen_notification` for custom on-screen toast messages)
- **Standalone Mobile Dashboard**: Access live stats and controls directly in your phone or laptop browser at `http://<tv-ip>:8080/`.
- **Zero Dependencies**: Pure ES5 implementation running on the TV's native Node.js v0.12 without `npm`. Minimal footprint (<0.1% CPU).
- **Persistent Boot Hook**: Automatically launches on TV startup via webOS Homebrew Channel (`init.d`).

---

## Architecture

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
  "allowPower": false,
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
    "id": "lg_b8_tv",
    "name": "LG OLED B8 TV",
    "model": "OLED65B8SLC",
    "manufacturer": "LG"
  }
}
```

### 3. Deploy to TV

Deploy `tvweb.js` and install the boot hook so it survives TV reboots:

```bash
cd server
./deploy.sh 192.168.1.134 --persist
```

The script will:
1. Temporarily serve the files from your computer and download them onto the TV (`/var/lib/tvweb/`).
2. Cleanly start `tvweb.js` under `setsid`.
3. If `--persist` is specified, install `/var/lib/webosbrew/init.d/50-tvweb`.
4. Clean up any temporary transfer ports.

---

## Home Assistant Entities

Once the TV connects to MQTT, the following entities appear under the **LG OLED B8 TV** device:

| Domain | Entity ID | Name | Description |
| :--- | :--- | :--- | :--- |
| `switch` | `switch.lg_b8_display_panel` | OLED Display Panel | Blanks/turns off OLED panel while audio plays |
| `switch` | `switch.lg_b8_mute` | Mute | Toggle audio mute |
| `number` | `number.lg_b8_volume` | Volume | Volume slider (0–100) |
| `select` | `select.lg_b8_input_source` | Input Source | HDMI 1, HDMI 2, HDMI 3, HDMI 4, Live TV |
| `text` | `text.lg_b8_screen_notification` | Screen Notification | Sends a toast message to TV screen |
| `sensor` | `sensor.lg_b8_soc_temperature` | SoC Temperature | TV processor temperature (`°C`) |
| `sensor` | `sensor.lg_b8_cpu_usage` | CPU Usage | Real-time CPU load (`%`) |
| `sensor` | `sensor.lg_b8_memory_usage` | Memory Usage | System RAM usage (`%`) |
| `sensor` | `sensor.lg_b8_swap_usage` | Swap Usage | zram Swap usage (`%`) |
| `sensor` | `sensor.lg_b8_wifi_signal` | Wi-Fi Signal | Wi-Fi signal strength (`dBm`) |
| `sensor` | `sensor.lg_b8_download_rate` | Download Rate | Live network throughput (`kB/s`) |
| `sensor` | `sensor.lg_b8_upload_rate` | Upload Rate | Live network upload throughput (`kB/s`) |
| `sensor` | `sensor.lg_b8_flash_health` | Flash Life Time | eMMC wear estimate (e.g. `0-10%`, `Normal`) |
| `sensor` | `sensor.lg_b8_active_app` | Active App | Current foreground app/input (`hdmi2`, `youtube`, etc.) |
| `sensor` | `sensor.lg_b8_uptime` | Uptime | TV uptime in seconds |

---

## Home Assistant Automation Examples

### 1. Automatically Blank Screen When Playing Music (Spotify / AirPlay)

Save OLED panel hours and prevent burn-in when the TV is used as a music streamer:

```yaml
alias: "TV: Turn Off Screen for Music"
trigger:
  - platform: state
    entity_id: sensor.lg_b8_active_app
    to: "spotify"
    for:
      seconds: 30
condition:
  - condition: state
    entity_id: switch.lg_b8_display_panel
    state: "on"
action:
  - service: switch.turn_off
    target:
      entity_id: switch.lg_b8_display_panel
```

### 2. Send Doorbell / Alert Toast to TV Screen

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
      entity_id: text.lg_b8_screen_notification
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
- **Luna Bus Introspection**: Control commands interact with webOS via native `luna-send` calls (`com.webos.audio`, `com.webos.service.tvpower`, `com.webos.applicationManager`, `com.webos.notification`).

---

## License

MIT License. See [LICENSE](LICENSE) for details.
