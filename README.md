# LG webOS TV Dashboard & Home Assistant Bridge

A telemetry server that runs **on** a rooted LG webOS TV. It serves a live
dashboard to any browser on your network, and bridges the TV into Home
Assistant over MQTT as a single auto-discovered device with 33 entities.

Zero dependencies, zero install step: pure ES5 on the Node 0.12 runtime the TV
already ships.

---

### Local Controls

Controls lead the page, since that is usually why you opened it. Volume, OLED
panel blanking, source switching and power, driven straight over the Luna bus
with no cloud round-trip.

<p align="center">
  <img src="docs/screenshots/controls.png" alt="Local control panel: volume, screen blanking, source switching and power" width="760">
</p>

### Metrics

Typography-led and monochrome, with colour reserved for meaning: headroom bars
run green to amber to red, Dolby Vision is picked out where it appears, and the
temperature stays white right through the normal operating band, taking colour
only above 75&deg;C.

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Metrics: SoC temperature, resource readouts and OLED panel hours" width="900">
</p>

### Home Assistant &mdash; Auto-Discovered Device

All 33 entities arrive over MQTT Discovery as a single device, with no YAML to
write.
<p align="center">
<img width="1061" height="1042" alt="image" src="https://github.com/user-attachments/assets/1d76b1a2-68d9-42a4-a497-b107d706b235" />
</p>

---

## What it's for

1. **Seeing what the TV is actually doing.** SoC temperature, per-core CPU
   load, memory, swap, current draw, Wi-Fi signal and throughput &mdash; none of
   which webOS surfaces anywhere in its own UI.

2. **Watching OLED panel wear.** Cumulative panel hours, where you are in the
   4-hour compensation cycle, and how far off the 2,000-hour Pixel Refresher is.
   You can schedule or cancel a refresher for the next power-off.

3. **Controlling the TV without the cloud.** Volume, mute, input switching,
   on-screen toast messages, power and reboot &mdash; all local Luna calls.

4. **Blanking the screen for music.** Turn the OLED panel off while audio keeps
   playing, so Spotify or AirPlay costs you no panel hours.

## Core features

* **OLED panel health.** Panel hours, compensation cycle, Pixel Refresher
  countdown and scheduling, screen shift and logo dimming state. Automatically
  hidden on LCD/QNED sets, which have no such counters.
* **Video and audio observability.** Dolby Vision / HDR / SDR detection, picture
  mode, OLED light level, raw HDMI signal (`3840x2160 @ 60Hz`), audio output
  routing, and active app with friendly input names (`Apple TV (HDMI2)`).
* **Hardware diagnostics.** SoC temperature and current draw, CPU and per-core
  load, memory and zram swap, Wi-Fi RSSI, network throughput, and eMMC flash
  wear with JEDEC health translation.
* **Bi-directional control.** Volume, mute, input select, screen blanking,
  on-screen notifications, power and restart &mdash; from the dashboard or Home
  Assistant.
* **Self-contained dashboard.** Fonts and assets are served by the TV, so the
  page works with no internet access.

## Requirements

* A rooted LG webOS TV with the
  [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel).
  Verified on a 2018 OLED65B8SLC running webOS 4.4.3 (firmware 05.50.70);
  other versions are untested.
* An MQTT broker reachable on your LAN, if you want the Home Assistant side.
  The dashboard works without one.

---

## 1. Set up access

A rooted TV exposes an **unauthenticated root shell on telnet port 23** &mdash;
anyone on your network gets root with no password. Move to SSH first. The
Homebrew Channel already ships dropbear, so nothing extra is needed.

The order matters. The Homebrew Channel sets a placeholder root password
(`alpine`, a publicly known default) *unless* `/home/root/.ssh/authorized_keys`
already exists, so enabling SSH without a key gets you password login as root
with a password everybody knows.

1. In the Homebrew Channel, turn **SSH** on.
2. **Reboot** &mdash; the flag is only read at boot.
3. Install your key. The placeholder password `alpine` gets you in this once:
   ```bash
   ssh-copy-id root@<tv-ip>
   ```
4. **Reboot again.** With a key present, the placeholder password is no longer
   set and only key auth works.
5. Confirm it: `ssh root@<tv-ip>`
6. Now turn **telnet** off in the Homebrew Channel.

**Do not turn telnet off before step 5.** If SSH does not come up you will have
no root access, and recovery means re-rooting the TV.

> Prefer not to touch the `alpine` password at all? Install your key over telnet
> at step 3 instead &mdash; telnet is on by default on a freshly rooted set.
> Either way, `deploy.sh` prefers SSH and falls back to telnet automatically, so
> it works before and after the switch.

## 2. Configure

```bash
cp config.example.json server/config.json
```

Set your broker under `mqtt` and turn it on. Leave `mqtt.enabled` false if you
only want the dashboard. Leaving `device.name` and `device.model` empty makes
the TV report its own model and firmware at runtime.

`allowPower` ships disabled, because there is no authentication unless you set
`token` &mdash; a fresh install should not expose "turn the TV off" to the whole
network. Enable it deliberately.

Before pointing this at a broker that also drives your lights, read
[docs/SECURITY.md](docs/SECURITY.md): give the TV its own MQTT user with a
restricted ACL, rather than reusing your main Home Assistant credentials.

## 3. Install

```bash
cd server
./deploy.sh <tv-ip> --persist
```

`--persist` installs a boot hook so it survives reboots. The script copies over
SSH where available, falling back to telnet; `--telnet` forces the old path.

Then open **`http://<tv-ip>:8080/`**.

If you configured MQTT, Home Assistant discovers the device automatically &mdash;
no YAML. See [docs/HOME-ASSISTANT.md](docs/HOME-ASSISTANT.md) for the entity
list and example automations.

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

The server has **no authentication by default** and binds to `0.0.0.0`, so
anyone who can reach the port can use every enabled control. On a home LAN that
is usually the point &mdash; but set `"token": "something-long"` in
`config.json` if you want it gated, and never port-forward it.

Setting a token affects the dashboard only. **Home Assistant is unaffected**,
since MQTT is a separate channel.

Full detail, including the MQTT ACL guidance and optional TLS, is in
[docs/SECURITY.md](docs/SECURITY.md).

## Documentation

* [docs/SECURITY.md](docs/SECURITY.md) &mdash; threat model, SSH migration, MQTT hardening
* [docs/HOME-ASSISTANT.md](docs/HOME-ASSISTANT.md) &mdash; all 33 entities, example automations
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
- **Non-OLED sets.** Panel hours, compensation and the Pixel Refresher exist
  only on OLED. They are detected as unavailable and omitted rather than
  reported as zero.
- **Trademarks.** An independent, unofficial community project, not affiliated
  with or endorsed by LG Electronics. webOS is a trademark of LG Electronics.
- **Fonts.** Bundles [Outfit](https://github.com/Outfitio/Outfit-Fonts) and
  [Manrope](https://github.com/sharanda/manrope) under the
  [SIL Open Font License 1.1](https://openfontlicense.org/); licence texts ship
  in `server/assets/fonts/`.

## License

MIT. See [LICENSE](LICENSE).
