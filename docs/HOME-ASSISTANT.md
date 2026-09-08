# Home Assistant

Entity reference and example automations.

---

## Entities

Once connected to your MQTT broker, Home Assistant automatically discovers **33 native entities** under a single unified device:

| Domain | Entity ID | Name | Description |
| :--- | :--- | :--- | :--- |
| `switch` | `switch.lg_tv_display_panel` | OLED Display Panel | Blanks/turns off OLED panel while audio plays |
| `switch` | `switch.lg_tv_mute` | Mute | Toggle audio mute |
| `switch` | `switch.lg_tv_pixel_refresher_schedule` | Schedule Pixel Refresher | Schedule/cancel 1-hour calibration for next standby |
| `number` | `number.lg_tv_volume` | Volume | Volume slider (0–100) |
| `select` | `select.lg_tv_input_source` | Input Source | HDMI 1–4, Live TV |
| `text` | `text.lg_tv_screen_notification` | Screen Notification | Send custom toast messages to TV screen |
| `button` | `button.lg_tv_restart` | Restart TV | Reboots the TV (requires `allowPower: true`) |
| `button` | `button.lg_tv_power_off` | Power Off TV | Powers off the TV (requires `allowPower: true`) |
| `sensor` | `sensor.lg_tv_oled_panel_hours` | OLED Panel Hours | Total cumulative operating hours (`h`) |
| `sensor` | `sensor.lg_tv_oled_hours_since_compensation` | OLED Hours Since Short Cycle | Hours elapsed since last 4h compensation (`h`) |
| `sensor` | `sensor.lg_tv_oled_hours_until_compensation` | OLED Hours Until Short Cycle | Hours until next short compensation due (`h`) |
| `sensor` | `sensor.lg_tv_oled_hours_since_refresher` | OLED Hours Since Pixel Refresher | Hours elapsed since last 2,000h deep refresher (`h`) |
| `sensor` | `sensor.lg_tv_oled_hours_until_refresher` | OLED Hours Until Pixel Refresher | Hours until next 2,000h deep refresher due (`h`) |
| `sensor` | `sensor.lg_tv_oled_refresher_status` | Pixel Refresher Status | `Idle` or `Scheduled` |
| `sensor` | `sensor.lg_tv_oled_screen_shift` | OLED Screen Shift | Pixel orbiting state (`ON` / `OFF`) |
| `sensor` | `sensor.lg_tv_oled_logo_dimming` | OLED Logo Dimming | Logo luminance reduction (`Low`, `Strong`, `Off`) |
| `sensor` | `sensor.lg_tv_dynamic_range` | Dynamic Range | **Dolby Vision**, **HDR**, or **SDR** |
| `sensor` | `sensor.lg_tv_picture_mode` | Picture Mode | Current profile (e.g. *Dolby Vision Cinema*) |
| `sensor` | `sensor.lg_tv_oled_light` | OLED Light | OLED panel backlight level (`0–100%`) |
| `sensor` | `sensor.lg_tv_video_signal` | Video Signal | HDMI resolution & refresh rate (e.g. `3840x2160 @ 60Hz`) |
| `sensor` | `sensor.lg_tv_audio_output` | Audio Output | Audio scenario (e.g. *Optical / Headphone*, *Internal*) |
| `sensor` | `sensor.lg_tv_active_app` | Active App | Current foreground app or friendly CEC device |
| `sensor` | `sensor.lg_tv_soc_temperature` | SoC Temperature | TV processor temperature (`°C`) |
| `sensor` | `sensor.lg_tv_soc_current` | SoC Current | Processor current draw (`mA`, CPU + Core AVS) |
| `sensor` | `sensor.lg_tv_cpu_usage` | CPU Usage | Real-time CPU load (`%`) |
| `sensor` | `sensor.lg_tv_memory_usage` | Memory Usage | System RAM usage (`%`) |
| `sensor` | `sensor.lg_tv_swap_usage` | Swap Usage | zram Swap usage (`%`) |
| `sensor` | `sensor.lg_tv_wifi_signal` | Wi-Fi Signal | Wi-Fi signal strength (`dBm`) |
| `sensor` | `sensor.lg_tv_download_rate` | Download Rate | Live network throughput (`kB/s`) |
| `sensor` | `sensor.lg_tv_upload_rate` | Upload Rate | Live network upload throughput (`kB/s`) |
| `sensor` | `sensor.lg_tv_flash_health` | Flash Storage Health | eMMC remaining health estimate (`>90% (Healthy)`) |
| `sensor` | `sensor.lg_tv_flash_wear` | Flash Wear Level | JEDEC write-cycle consumption (`0–10%`) |
| `sensor` | `sensor.lg_tv_uptime` | Uptime | TV uptime in seconds |

---

---

## Example automations

### 1. Automatically Blank Screen When Playing Music (Spotify / AirPlay)
Save OLED panel hours and eliminate burn-in risk when streaming audio:

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

### 2. Dim Cinema Lighting on Dolby Vision Playback
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

### 3. Display Doorbell / Security Toast on TV Screen
Display a notification directly on the TV when a doorbell rings:

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
