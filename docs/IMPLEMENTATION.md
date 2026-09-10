# Implementation notes

How this works on the inside, and the platform quirks that shaped it. Nothing
here is needed to use the project - see the [README](../README.md) for that.

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
                  │              Home Assistant             │
                  │       (Up to 61 Auto-Discovered)        │
                  └─────────────────────────────────────────┘
```

### High-Stability Process Execution
Older Linux kernels and Node 0.12 can encounter process deadlocks or child leaks when `child_process.exec()` is called frequently (spawning `/bin/sh` without timeout parameters). 

`tvweb.js` solves this with:
1. **Direct `execFile`**: Invokes `/usr/bin/luna-send` directly with zero shell overhead.
2. **Internal Daemon Timeout**: Luna calls use `-w 2000` to prevent orphaned background processes if a system bus stalls.
3. **In-Flight Concurrency Mutex**: If multiple HTTP pollers or MQTT intervals request stats simultaneously, they are coalesced into a single execution pipeline.
4. **Memory Caching**: Telemetry is cached for 1.5 seconds, delivering sub-20ms HTTP responses with zero subprocess spawning during rapid UI updates.
5. **Deterministic MQTT Client Session**: Uses a static client ID and periodic availability reaffirmation so TV reboots or network reconnects never leave entities trapped in an "Unavailable" state.

---

---

## Platform constraints

- **Node.js v0.12 (2015)**: webOS 4.x ships Node v0.12.2. All code in `tvweb.js` is written in strict ES5 (no `let`/`const`, no arrow functions, no template literals, no `async`/`await`).
- **BusyBox `run-parts` Hook Naming**: The webosbrew startup system invokes user hooks with `run-parts /var/lib/webosbrew/init.d`. BusyBox `run-parts` strictly ignores any filename containing a dot (`.`), so the boot hook must be named `50-tvweb` without `.sh`.
- **Luna Bus Introspection**: Control commands interact with webOS via native `luna-send` calls (`com.webos.audio`, `com.webos.service.tvpower`, `com.webos.applicationManager`, `com.webos.notification`, `com.webos.service.settings`, `com.webos.service.eim`).

---

---

## eMMC health vs wear

Under the **JEDEC eMMC 5.0** specification, `/sys/block/mmcblk0/device/life_time` returns byte estimates for SLC and MLC partition write cycles:
- `0x01` indicates **0% – 10% of rated device write cycles used**.
- This means **>90% of drive life remains** (Healthy).
- `pre_eol_info` returning `01` indicates normal endurance (<80% reserved blocks consumed).

To prevent user confusion, `tvweb.js` translates this into both a human-friendly health state (`>90% (Healthy)`) and a wear estimate (`0-10% used · Normal EOL`).

---

---

## Where the telemetry comes from

webOS 4.x has **no generic Linux thermal interface**. `/sys/class/thermal` exists
but is empty, and there is no `hwmon` at all, so any guide pointing at
`thermal_zone*/temp` returns nothing on this hardware. LG exposes its own tree
instead:

| Path | Meaning |
| :--- | :--- |
| `/proc/lg/pm/temperature` | SoC temperature, **plain °C** (not millidegrees) |
| `/proc/lg/pm/current_load` | CPU load, % |
| `/proc/lg/pm/frequency` | kHz |
| `/proc/lg/pm/status` | per-core load, governor, AVS currents |
| `/sys/block/mmcblk0/device/life_time` | eMMC wear (`0x01` = 0–10% used) |
| `/sys/block/mmcblk0/device/pre_eol_info` | `01` Normal / `02` Warning / `03` Urgent |
| `/mnt/lg/cmn_data/mrcu/mrcu1.info` | Magic Remote battery percentage, remote model, BDAddr, and firmware |
| `/proc/lg/hdmi20/port[0-3]/status` | Real-time HDMI receiver PHY mode (FRL 48 Gbps vs TMDS), chroma (RGB 4:4:4), HDCP, cable error counter, ALLM, VRR |
| `/proc/lg/pe/hdr_status` | Picture engine live video format, colorimetry standard (`BT.709`, `BT.2020`), and peak nit levels |
| `/var/luna/preferences/environmentCondition` | Hardware configuration (SoC generation `_O22_`, DDR RAM, refresh rate, eye sensor) |

**Do not read `/proc/lg/pm/ts_enable`** — it segfaults the reading process.

webOS 3.9 has no temperature source at all: `/proc/lg/pm/temperature` is absent,
nothing under `/proc/lg` or `/sys` is named for temperature, `/sys/class/thermal` is
empty, there is no `hwmon`, and `systemproperty` rejects every temperature key. The
server reports this as `capabilities.thermal: false` so the dashboard can distinguish
it from the ~80s post-boot window where the file exists but reads 0.

### /proc/stat is not monotonic

LG hot-plugs CPU cores (`/proc/lg/pm/mp_enable`), so the aggregate counters in
`/proc/stat` can go *backwards* between samples — the idle figure has been
observed dropping from 324186 to 228324 across two reads seconds apart. Any
delta-based CPU percentage built on it produces nonsense. `current_load` is the
figure to trust; `/proc/stat` is only used when every delta is non-negative.

## OLED panel counters, and their units

The panel timers do not share a unit, which is the single easiest thing to get
wrong here. Furthermore, webOS 9+ (webOS 22+, e.g. LG C2) moved several counters
to a dedicated service and changed filesystem file paths:

| Value | Older webOS (B8, 4.x–8.x) | Modern webOS (C2, 9.x / 22+) | Unit |
| :--- | :--- | :--- | :--- |
| **Panel usage time** | `com.webos.service.tv.systemproperty/getSystemProperties` (`panelUsageTime`) | `com.webos.service.panelcontroller/getPanelUsageTime` (`panelUsageTime`) | 10-minute units — divide by 6 for hours |
| **Last compensation** | `lastCompensationTimestamp` (Luna) | `/mnt/lg/cmn_data/pnwash/autoOffRsLastTime` | 10-minute units (Luna) / whole hours (fs) |
| **Off-RS hours (fs)** | `/mnt/lg/cmn_data/pnwash/autoOffRsTime` | `/mnt/lg/cmn_data/pnwash/autoOffRsLastTime` | whole panel **hours** |
| **Refresher hours (fs)**| `/mnt/lg/cmn_data/pnwash/autoPnwashTime` | `/mnt/lg/cmn_data/pnwash/autoJbLastTime` | whole panel **hours** |
| **Off-RS interval** | `/mnt/lg/cmn_data/pnwash/autoOffRsIntervalHomeMode` (`24`) | `/mnt/lg/cmn_data/pnwash/autoOffRsInterval` (`4`) | 10-min units (older) / whole hours (newer) |
| **Refresher cadence** | Constant (2,000h) | `/mnt/lg/cmn_data/pnwash/autoJbInterval` (`2000 ok`) | whole panel **hours** |
| **Off-RS completed cycles** | &mdash; | `/mnt/lg/cmn_data/pnwash/completedOffRsCount` | integer count |
| **JB refresher cycles** | &mdash; | `/mnt/lg/cmn_data/pnwash/completedJbCount` | integer count |
| **Compensation failures** | &mdash; | `/mnt/lg/cmn_data/pnwash/failAlertCount` | integer count |
| **Panel silicon info** | &mdash; | `com.webos.service.panelcontroller/getOledCellInfo` / `getOledTconInfo` | Cell ID & TCON FPGA FW |

On older sets, the interval file reading `24` means four hours, matching LG's documented
cumulative-viewing cycle — not twenty-four. It is expressed in the same 10-minute units as
the Luna counters it gets compared against, while `autoOffRsTime` alongside it is in
hours. Confirmed on a live set: `autoOffRsTime` 3426 against a `panelUsageTime`
of 20576 (÷6 = 3429).

On webOS 9+ sets, `autoOffRsInterval` is expressed directly in whole hours (`4`),
`autoJbInterval` reports `2000 ok`, and `panelcontroller/getPanelUsageTime` provides
the live usage counter in 10-minute units. Confirmed on an LG C2: `autoOffRsLastTime` 4767
against a `panelUsageTime` of 28614 (÷6 = 4769).

## Panel detection

Panel-lifecycle features are gated on panel type, detected once via
model name matching (`OLED...`), `/var/luna/preferences/paneltype_oled`, pnwash filesystem
records, or a `panelUsageTime` query that actually responds. On an LCD/QNED set they are
omitted from the dashboard and withheld from MQTT discovery, with retained discovery configs
cleared so they do not linger in Home Assistant as orphans. Reporting `0 hours` would read as a real
measurement.

## Deploying over ssh

Two things bite when moving off telnet, both because an inline `ssh` command
becomes the remote shell's own `argv`:

- **`pkill -f tvweb.js` kills the shell running it.** Its command line contains
  that path, so it matches itself. The bracket trick does not save you either,
  since the path appears again in the start command. Hence `tvwebctl`: inside a
  script file the shell's argv is just the script.
- **`setsid ... &` does not detach.** The child inherits the ssh session's stdin
  and dies when the connection closes — the server starts, publishes discovery,
  then vanishes. `start-stop-daemon -b -m` survives.

`rsync` ships with the Homebrew Channel but is broken on-device: it cannot load
`libcrypto.so.1.1`. Use `scp`, which works over the sftp subsystem.

## Fonts

The dashboard bundles [Outfit](https://github.com/Outfitio/Outfit-Fonts) and
[Manrope](https://github.com/sharanda/manrope) as variable fonts, both under the
SIL Open Font License, served by the TV so the page needs no internet access.
Licence texts ship alongside them in `server/assets/fonts/`.

---

## Consent flags cannot be changed from outside the Settings UI

Writing `/var/luna/preferences/eula` looks like it works and does not. Tested
on a live set:

1. Flipped `thirdPartySharingAllowed` from `true` to `false`, validating the
   JSON before replacing the file and regenerating `eula.md5` (which is simply
   `md5sum` output, path included).
2. The change persisted, was picked up by the dashboard, and survived 75
   seconds with nothing rewriting it. All collection daemons stayed healthy.
3. **After a genuine reboot the file was byte-identical to the original**
   (md5 back to `85aca988…`, mtime set during boot). The platform restores or
   regenerates it at startup.

So the panel reports these flags and does not offer to change them. A toggle
here would appear to work, survive inspection, and quietly revert on the next
restart - worse than no toggle, because it manufactures confidence. Change them
on the TV under Settings > General > About This TV > User Agreements.

Note also that even a flag that *did* stick would only prove what the TV has
recorded locally. It would not prove LG honours it, and the value may be
mirrored against the account server-side.

## tvpower reboot does not reboot

`luna://com.webos.service.tvpower/power/reboot` accepts the request, validates
its parameters (omitting `reason` returns `errorCode -7`) and reports success -
but the kernel never restarts. Measured on an OLED65B8SLC running webOS 4.4.3:

| | uptime |
| :--- | :--- |
| before the call | 12810s |
| after (set was off the network ~65s) | 12871s |

It behaves like a standby transition. `/sbin/reboot` performs a real restart:
uptime reset to 60s, with services and the webosbrew boot hook all returning
cleanly. The reboot control therefore uses the kernel path, replying to the
client first because the process is about to go down with the system.

## The thermal sensor lags boot

`/proc/lg/pm/temperature` reads a literal `0` for roughly the first 80 seconds
after a restart - valid at 83s uptime on the test set, still `0` at 73s. That
is not a measurement, so it is reported as `null`, kept out of the history ring
buffer, and shown as a dash. Publishing it would put a false 0&deg;C spike into
Home Assistant's history on every reboot.

---

## The ad sinkhole blocks more than ads

The blocklist is applied by bind-mounting a generated hosts file over
`/etc/hosts`, which is the only way to change it on a read-only rootfs - the
same technique webosbrew uses for `/etc/shadow` and `/etc/motd`. Verified
working: `getent hosts ad.lgsmartad.com` returns `0.0.0.0`.

Two of the fifteen domains are **LG infrastructure rather than advertising**:

| Domain | What it actually serves |
| :--- | :--- |
| `ngfts.lge.com` | Content and firmware delivery CDN |
| `lgtvsdp.com` (and `us.`/`gb.`/`eu.`) | Service Delivery Platform behind the LG Content Store |

Blocking them is a defensible choice, but it means **firmware updates and the
app store may stop working** while the sinkhole is enabled. Anyone who turns
this on and later finds the Content Store broken will not connect the two
events unless told, so it is stated at the toggle in the UI as well as here.

Removing those two entries from `ADBLOCK_DOMAINS` gives a conservative list
that only targets advertising and telemetry.

---

## Entity state must come from the TV, not from the command

Entities derive state from the telemetry payload via a `value_template`, so
they re-assert the truth on every tick whatever changed it - dashboard, remote,
the TV's own menus, or Home Assistant.

The display panel switch originally published only when a command arrived over
MQTT, plus a retained `ON` on every connect. Blanking the panel from the
dashboard left Home Assistant showing it on indefinitely. It is now reconciled
against `powerState` each telemetry publish.

So: prefer `state_topic: telemetryTopic` with a template. An entity on its own
topic must be republished from real state every tick, or it is a guess that
holds until someone notices.

`scripts/check-entities.py` resolves every entity's `value_json` paths against a
live `/api/stats`. A renamed field otherwise leaves an entity at `unknown` with
no error anywhere.
