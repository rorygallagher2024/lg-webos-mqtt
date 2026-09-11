# LG webOS TV Dashboard & Home Assistant Bridge

A server that runs **on** a rooted LG webOS TV. It serves a live dashboard to
any browser on the network, and will optionally bridge the TV into Home
Assistant over MQTT as a single auto-discovered device with up to 61 entities.

The dashboard needs nothing but the TV. Home Assistant and MQTT are an optional
second half &mdash; [step 3](#3-home-assistant--mqtt-optional) explains what
they are.

There are no dependencies. This is ES5 on the Node 0.12 runtime that is on the TV.

---

### Web Dashboard & Controls

Four tabs: Control, Metrics, Privacy and MQTT.

<p align="center">
  <a href="docs/screenshots/dashboard.png"><img src="docs/screenshots/dashboard.png" alt="Metrics tab: SoC temperature, system readouts, storage and display panel counters, dark theme (OLED65B8SLC)" width="440"></a>
  &nbsp;
  <a href="docs/screenshots/dashboard-light.png"><img src="docs/screenshots/dashboard-light.png" alt="Control tab: panel, source, volume, playback, picture, sound, apps and power, light theme (OLED65B8SLC)" width="440"></a>
</p>

### Home Assistant (Auto-Discovered Device via MQTT)

Up to 61 native entities arrive over MQTT Discovery as a single unified device
<p align="center">
  <a href="https://github.com/user-attachments/assets/1d76b1a2-68d9-42a4-a497-b107d706b235"><img width="800" alt="Home Assistant MQTT entities" src="https://github.com/user-attachments/assets/1d76b1a2-68d9-42a4-a497-b107d706b235" /></a>
</p>

A custom Home Assistant dashboard for an LG TV:
<p align="center">
  <a href="https://github.com/user-attachments/assets/737b3106-e8a4-4c6b-ba96-b0bad130b600"><img width="800" alt="Custom dashboard leveraging MQTT data" src="https://github.com/user-attachments/assets/737b3106-e8a4-4c6b-ba96-b0bad130b600" /></a>
</p>

### Privacy Panel & On-TV Ad Blocker

The Privacy tab, or `/?tab=privacy`. Reports live state from
the TV rather than repeating a settings menu: whether LG's content recognition
engine is running and sampling frames, your advertising identifier, and every
agreement recorded on the set &mdash; most of which can be switched off from
here. Includes an ad & telemetry blocker that holds a blackhole list over
`/etc/hosts` and survives a reboot, in a tier that spares the Content Store or
one that does not.

<p align="center">
  <a href="docs/screenshots/privacy.png"><img src="docs/screenshots/privacy.png" alt="Privacy tab: ad and telemetry blocker, advertising identifier, the data collection agreements grouped by subject with toggles, and what is running now" width="700"></a>
</p>

---

## What it's for

1. **Controlling the TV without the cloud.** Volume, mute, media playback keys (play, pause, stop, skip), app launcher, picture presets, sound output routing, power and reboot.

2. **Seeing what the TV collects, and switching it off.** Whether LG's
   content-recognition engine is running and sampling your screen, your
   advertising identifier and whether ad tracking is limited, and every data
   agreement recorded on the set with most of them switchable from the
   dashboard. Includes an on-TV blocker for LG's ad and telemetry
   endpoints, and a switch for the two diagnostics services that upload to LG.
   
3. **Integrating the TV into Home Assistant.** Optional, over MQTT: up to 61
   entities arrive as a single auto-discovered device &mdash; no YAML, no LG
   account &mdash; so the TV can be automated and its telemetry recorded
   alongside everything else in the house.
   [Step 3](#3-home-assistant--mqtt-optional) explains what MQTT is.

4. **Seeing what the TV is actually doing.** SoC temperature, per-core CPU
   load, memory, swap, current draw, Wi-Fi signal and throughput.

5. **Observing OLED panel wear.** Cumulative panel hours, compensation cycle
   progress, Pixel Refresher countdown with scheduling, completed cycle counters,
   failure alerts, and ASBL / GSR protection status.


## Core features

* **OLED panel health.** Panel hours, compensation and Pixel Refresher countdowns
  with scheduling, completed cycle counters, failure alerts, ASBL / GSR
  protection status, screen shift and logo dimming. Hidden on LCD/QNED sets.
* **HDMI 2.1 diagnostics.** Link rate, chroma format, HDCP version, cable error
  counter, ALLM, VRR, QMS, and colorimetry. Requires `/proc/lg/hdmi20`.
* **Magic Remote & hardware info.** Battery, model, firmware; SoC architecture,
  OLED cell ID, and TCON firmware where the platform exposes them.
* **Video and audio observability.** Dolby Vision / HDR / SDR detection, picture
  mode, OLED light level, raw HDMI signal (`3840x2160 @ 120Hz`), audio output
  routing, and active app with friendly input names (`Apple TV (HDMI2)`).
* **Hardware diagnostics.** SoC temperature and current draw, CPU and per-core
  load, GPU clock, memory and swap, Wi-Fi RSSI, network throughput, eMMC
  flash wear with JEDEC health translation, and free space on the app partition.
* **Advanced panels.** HDMI link state per port straight off the receiver
  (resolution, refresh rate, colour depth, pixel clock) and a read-only list of
  what is resident in memory. Both load on demand.
* **Bi-directional control.** Volume, mute, input select, media playback (play/pause/stop/skip via native remote key injection), app launching, picture presets, sound outputs, screen blanking, sleep timer, standby LED, on-screen notifications, power and restart (from the dashboard or Home Assistant). The picture presets on offer are the ones the TV will accept for whatever is playing &mdash; a Dolby Vision source has its own set.
* **Ad & telemetry blocker.** Blackholes LG's tracking, ad and ACR
  endpoints on the set itself by bind-mounting a hosts table over `/etc/hosts`.
  Automatically restored on boot. Two tiers: *ads & telemetry* blocks the nine
  ad and diagnostics hosts and leaves LG's own service platform reachable;
  *everything* adds the ten that carry the Content Store and firmware delivery,
  so on that tier the app store and updates may stop working. The store server
  differs by platform &mdash; `com.webos.appInstallService` installs from
  `lgtvsdp.com` on webOS 4 and `nextlgsdp.com` on webOS 9 &mdash; and both are
  in that tier.
* **Privacy panel.** Behind a toggle in the controls: whether LG's screen
  content recognition is actually running and sampling frames, your advertising
  identifier and whether ad tracking is limited, every data-collection
  agreement recorded on the TV, and which of LG's collection
  services are alive &mdash; the two the service bus starts on demand are marked
  as such, and the two upstart supervises can be switched off for good. The agreements can be switched off from the panel and the
  change survives a reboot; acceptance of the terms themselves is left to the
  TV's own menus. Includes buttons to reset the advertising ID, clear ad
  cookies, and toggle the on-TV ad blocker. Deep link: `/?tab=privacy`.
* **Self-contained dashboard.** Fonts and assets are served by the TV, so the
  page works with no internet access.
* **Dark and light themes.** High-contrast light mode with dark text alongside
  the default true-black OLED theme, toggled via the masthead (☾ / ☀) or `/?theme=light`.

## Requirements

* A rooted LG webOS TV ([Root tool here](https://github.com/throwaway96/dejavuln-autoroot/)) with the
  [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel).
* Nothing else for the dashboard.
* An MQTT broker on the network, and usually Home Assistant, only if the
  bridge in [step 3](#3-home-assistant--mqtt-optional) is wanted.

### Tested on

Tested across the following sets so far. The Luna
service names and `/proc/lg` paths this relies on may differ across webOS
versions and panel types.

| Model | webOS | Firmware | Panel | Notes |
| :--- | :--- | :--- | :--- | :--- |
| OLED65B8SLC | 4.4.3 | 05.50.70 | OLED | Development set |
| OLED65C8PUA | 4.4.0 | 05.50.15 | OLED | No `getAdid` on this firmware |
| OLED65C9AUA | 4.9.x (4.5+) | 05.50.00 | OLED | |
| OLED55C9PLA | 4.9.0 | 05.30.40 | OLED | Working fine |
| OLED55C1PUB | 6.x (6.3+) | 03.53.45 | OLED | SSH install and MQTT bridge confirmed |
| 55UH6030-UC | 3.4.3 | &mdash; | LCD | |
| OLED55G42LW | 24 | 33.31.68 | OLED | Rooted with slopbro, not the Homebrew Channel |
| OLED42C24LA | 9.2.2 (22+) | 23.25.55 | OLED | Rooted with jsbro-autoroot |
| OLED65B7V-Z | 3.9.3 | 06.10.65 | OLED | No SoC temperature or eMMC wear readings |

**If you run it on anything else, please open an issue whether it's working or not**
Include your model, webOS version and
`/var/lib/tvweb/tvweb.log` and I will add a row.

---

## 1. Access

`deploy.sh` needs a root shell on the TV. It uses **SSH** when key-based login
works and falls back to the Homebrew Channel's **telnet** otherwise, so you do
not have to change anything to get started.

* **Already using SSH keys with your TV?** Nothing to do. Skip to step 2.
* **Freshly rooted, telnet only?** That works too. Skip to step 2.
* **Want to move to SSH?** Recommended, and it takes about five minutes:
  see [Moving from telnet to SSH](docs/SECURITY.md#moving-from-telnet-to-ssh).
  You can do it before or after installing; `deploy.sh` works either side.

Worth knowing whichever you choose: a rooted TV's telnet is an
**unauthenticated root shell on port 23**. Anyone on your network gets
root with no password. That comes from the rooting rather than from this
project, but it is the largest exposure on the TV and worth closing when you
get the chance.

## 2. Install the dashboard

```bash
cd server
./deploy.sh <tv-ip> --persist
```

Then open **`http://<tv-ip>:8080/`**.

No configuration is needed for this part. Without a config file the dashboard
runs on port 8080, the controls are live, MQTT is off, and power off / reboot
are disabled. Nothing is sent anywhere: the server talks to the TV and to
whoever opens the page.

`--persist` installs a boot hook so it survives reboots. The script copies over
SSH where available, falling back to telnet; `--telnet` forces the old path. The
telnet path has to find this machine's LAN address to serve the files from; if
it cannot, pass it as `MYIP=192.168.x.y ./deploy.sh <tv-ip>`.

Panel hours, Pixel Refresher and Screen Shift are read on OLED sets only. If a
set is detected the wrong way, add `"panel": "lcd"` or `"panel": "oled"` to
`config.json`.

That is a complete install. Everything below is optional.

## 3. Home Assistant & MQTT (optional)

### What these are

**Home Assistant** is open-source home automation software that runs on the
user's own hardware &mdash; a Raspberry Pi, a NUC, a container on a NAS. It
gathers devices from different vendors into one place and automates them. It is
not a service, and nothing here talks to a company's cloud.

**MQTT** is a lightweight messaging protocol. Something publishes a message to a
named topic, and anything subscribed to that topic receives it. It needs a
**broker** &mdash; a small server that relays those messages between publishers
and subscribers. [Mosquitto](https://mosquitto.org/) is the usual one, and Home
Assistant ships it as a one-click add-on.

This project publishes the TV's telemetry to a broker, and describes its own
entities using the **MQTT Discovery** convention. Home Assistant reads that
description and creates the device with all its sensors and controls by itself.
There is no YAML to write.

The bridge needs a broker reachable on the network. Home Assistant is the usual
reason to run one, but not a requirement &mdash; see
[Using MQTT without Home Assistant](#using-mqtt-without-home-assistant).

### Setting it up from the dashboard

Open the dashboard, then the **MQTT** tab. Fill in the
broker address and credentials, switch **MQTT bridge** on, and save. The server
writes `config.json` on the TV and restarts itself; the page reconnects on its
own after a few seconds.

Nothing else is needed. Home Assistant picks up the device within a few seconds
of the bridge connecting.

<p align="center">
  <a href="docs/screenshots/mqtt.png"><img src="docs/screenshots/mqtt.png" alt="MQTT tab: bridge status and switch beside the broker, topic and device fields" width="700"></a>
</p>

The panel reports whether the bridge is connected to the broker and how long ago
it last published, so a wrong address or a rejected password shows up there
rather than in the log on the TV.

### Setting it up from a config file

Equivalent to the above, and the better route for installing several TVs from
one machine or for keeping the settings under version control.

```bash
cp config.example.json server/config.json
```

Set the broker under `mqtt` and set `enabled` to `true`, then run `deploy.sh`
again. Leaving `device.name` and `device.model` empty makes the TV report its
own model and firmware at runtime.

`deploy.sh` only installs this file if the TV does not already have one, so it
will not overwrite settings saved from the dashboard. To replace an existing
config, edit it through the dashboard or remove `/var/lib/tvweb/config.json`
first.

### Which settings live where

The dashboard can change the broker, credentials, topic prefix and device
identity &mdash; the things that decide *where* telemetry goes.

`port`, `host`, `allowControl`, `allowPower` and `token` are file-only. They
decide *who can reach the server at all*, and a web UI able to widen its own
exposure would defeat the point of setting them. Edit those in `config.json`
and redeploy, or edit `/var/lib/tvweb/config.json` on the TV and restart.

`allowPower` ships disabled, because there is no authentication unless `token`
is set &mdash; a fresh install should not expose "turn the TV off" to the whole
network. Enable it deliberately.

Recommended: give the TV its own MQTT user with a restricted ACL rather than
reusing the main Home Assistant credentials. See
[docs/SECURITY.md](docs/SECURITY.md).

### Using MQTT without Home Assistant

The bridge is a plain MQTT publisher, so anything that speaks MQTT can read it.
Telemetry is published as JSON to `<topicPrefix>/telemetry`, availability to
`<topicPrefix>/status`, and commands are accepted on `<topicPrefix>/command/*`.

```bash
mosquitto_sub -h <broker> -t 'lgtv/#' -v
```

Node-RED, Telegraf into InfluxDB, or a script subscribing to that topic all work
the same way. The Discovery messages are simply ignored by anything that is not
Home Assistant.

### Multiple TVs

Each TV on the same broker needs a unique `topicPrefix` and `device.id`,
otherwise they overwrite each other's state and disconnect each other. Both are
editable from each TV's own dashboard.

For the config-file route, `deploy.sh` checks for `server/config.<tv-ip>.json`
before falling back to `server/config.json`, which keeps per-TV settings from
being flattened by a shared file.

### Running one half without the other

| | `web.enabled` | `mqtt.enabled` |
| :--- | :--- | :--- |
| Dashboard and Home Assistant | `true` | `true` |
| Dashboard only *(default)* | `true` | `false` |
| Home Assistant only | `false` | `true` |

With the dashboard disabled the server is an MQTT bridge with no web interface,
which is the safer shape if everything is driven from Home Assistant &mdash; the
dashboard is an unauthenticated control endpoint unless `token` is set. Note
that this also removes the settings UI, so an MQTT-only install is configured by
file. With both disabled the server exits rather than idling.

See [docs/HOME-ASSISTANT.md](docs/HOME-ASSISTANT.md) for the entity list and
example automations.

## Managing it

```bash
ssh root@<tv-ip> /var/lib/tvweb/tvwebctl status    # start | stop | restart | status
```

## Uninstalling

```bash
ssh root@<tv-ip>
/var/lib/tvweb/tvwebctl stop
rm -rf /var/lib/tvweb
rm -f /var/lib/webosbrew/init.d/50-tvweb*
```

Nothing on the TV's read-only rootfs is ever modified.

---

## Security

The dashboard has **no authentication by default** and binds to `0.0.0.0`, so
anyone who can reach the port can use every enabled control. On a home LAN that
is usually the point but you can set `"token": "something-long"` in
`config.json` if you want it gated, and never port-forward it. If you only use
Home Assistant, `"web": { "enabled": false }` removes the endpoint entirely.

The MQTT settings panel is part of that surface: on a default install, anyone
who can reach the port can change the broker the TV publishes to, and so
redirect its telemetry. It is gated by `token` and by `allowControl` like the
rest of the controls, and it cannot change `port`, `host`, `allowControl`,
`allowPower` or `token` themselves &mdash; those stay file-only so the UI cannot
widen its own exposure. The stored broker password is never sent to the browser.

Setting a token affects the dashboard only. **Home Assistant is unaffected**,
since MQTT is a separate channel.

Full detail, including the MQTT ACL guidance and optional TLS, is in
[docs/SECURITY.md](docs/SECURITY.md).

## Documentation

* [docs/SECURITY.md](docs/SECURITY.md) &mdash; threat model, SSH migration, MQTT hardening
* [docs/HOME-ASSISTANT.md](docs/HOME-ASSISTANT.md) &mdash; up to 61 entities, universal media player, example automations
* [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) &mdash; architecture, `/proc/lg` reference, platform quirks

---

## Disclaimer

**Use this software at your own risk.**

- **Root access and hardware.** This runs custom software with `root`
  privileges on an embedded TV OS. It is designed to be lightweight and to
  leave the read-only rootfs untouched, but the authors accept **no
  responsibility** for damage, bootloops, bricked devices, voided warranties,
  data loss or OLED panel issues.
- **Power and control commands.** Reboot, power off, screen blanking and Pixel
  Refresher scheduling issue low-level `luna-send` calls. Understand what each
  does before using it.
- **Trademarks.** An independent, unofficial community project, not affiliated
  with or endorsed by LG Electronics. webOS is a trademark of LG Electronics.
- **Fonts.** Bundles [Outfit](https://github.com/Outfitio/Outfit-Fonts) and
  [Manrope](https://github.com/sharanda/manrope) under the
  [SIL Open Font License 1.1](https://openfontlicense.org/); licence texts ship
  in `server/assets/fonts/`.

## License

MIT. See [LICENSE](LICENSE).
