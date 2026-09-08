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
                  │         (33 Auto-Discovered Entities)   │
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

**Do not read `/proc/lg/pm/ts_enable`** — it segfaults the reading process.

### /proc/stat is not monotonic

LG hot-plugs CPU cores (`/proc/lg/pm/mp_enable`), so the aggregate counters in
`/proc/stat` can go *backwards* between samples — the idle figure has been
observed dropping from 324186 to 228324 across two reads seconds apart. Any
delta-based CPU percentage built on it produces nonsense. `current_load` is the
figure to trust; `/proc/stat` is only used when every delta is non-negative.

## OLED panel counters, and their units

The panel timers do not share a unit, which is the single easiest thing to get
wrong here:

| Value | Unit |
| :--- | :--- |
| `panelUsageTime` (Luna) | 10-minute units — divide by 6 for hours |
| `lastCompensationTimestamp` (Luna) | 10-minute units |
| `/mnt/lg/cmn_data/pnwash/autoOffRsTime` | whole panel **hours** |
| `/mnt/lg/cmn_data/pnwash/autoPnwashTime` | whole panel **hours** |
| `/mnt/lg/cmn_data/pnwash/autoOffRsIntervalHomeMode` | 10-minute units (`24` = **4 hours**) |

The interval file reading `24` means four hours, matching LG's documented
cumulative-viewing cycle — not twenty-four. It is expressed in the same units as
the counters it gets compared against, while `autoOffRsTime` alongside it is in
hours. Confirmed on a live set: `autoOffRsTime` 3426 against a `panelUsageTime`
of 20576 (÷6 = 3429).

The 2,000-hour Pixel Refresher cadence is not exposed anywhere on the set and
remains an assumption, named as a constant rather than buried in an expression.

## Panel detection

Panel-lifecycle features are gated on panel type, detected once via
`/var/luna/preferences/paneltype_oled` or a `panelUsageTime` that actually
responds. On an LCD/QNED set they are omitted from the dashboard and withheld
from MQTT discovery, with retained discovery configs cleared so they do not
linger in Home Assistant as orphans. Reporting `0 hours` would read as a real
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
