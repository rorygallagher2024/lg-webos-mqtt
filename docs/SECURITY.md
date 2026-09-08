# Security

This server has **no authentication by default**, and binds to `0.0.0.0` so it
is reachable from anywhere on your network. Anyone who can reach the port can
use every enabled control. On a home LAN that is usually the point; understand
it before exposing it more widely.

- **Set a token.** Put `"token": "something-long"` in `config.json` and every
  `/api/` request must carry `?k=something-long`. Bookmark the dashboard with
  the token in the URL. This gates the HTTP API only &mdash; **MQTT and the Home
  Assistant integration are unaffected**, since they use a separate channel.
- **`allowPower` ships disabled**, so a fresh install cannot be told to turn the
  TV off by anything that finds the port. Enable it deliberately.
- **Never port-forward this.** It is designed for a trusted LAN.
- Bind to `127.0.0.1` instead of `0.0.0.0` if you only want the TV itself to
  reach it.
- No CORS headers are sent, so other websites cannot read your telemetry from
  your browser. Cross-origin `POST`s are refused, and `/api/control` requires
  `Content-Type: application/json`.
- Remember the wider context: rooted webOS exposes an **unauthenticated root
  telnet on port 23**. That is a far bigger exposure than this server, and it
  is worth closing off if you have not already.

---

---

## Why telnet has to go

A rooted webOS TV exposes an **unauthenticated root shell on port 23**. Anyone
on your network gets root with no credentials, which makes every other measure
here mitigation rather than a fix &mdash; nothing stored on the TV is secret
while it is open.

The Homebrew Channel ships dropbear, so moving to key-based SSH needs no extra
software. The step-by-step migration is in the
[README](../README.md#1-set-up-access), including the ordering trap: the
Homebrew Channel sets the well-known `alpine` root password unless
`authorized_keys` already exists, so enabling SSH without a key installed is no
safer than telnet.

---

## Hardening the MQTT bridge

Worth doing properly, because this is the part that reaches beyond the TV. The
broker credentials live in `config.json` **on the TV**, and a rooted webOS set
has an unauthenticated root shell on port 23 &mdash; so treat anything stored
there as readable by anyone on your network. `tvweb` tightens the file to `0600`
at startup, but that is mitigation, not a fix.

The question that matters is not whether the bridge is authenticated (it is),
but **what that credential is allowed to do**. Reuse your main Home Assistant
MQTT user and a compromised TV can publish to any topic on the broker &mdash;
including the ones driving your lights, locks or alarms.

**1. Give the TV its own broker user with a restricted ACL.** With this in
place, a compromised TV can only lie about its own telemetry:

```conf
# /etc/mosquitto/aclfile
user lgtv
topic write  lgtv/#
topic read   lgtv/command/#
topic write  homeassistant/+/lg_tv/#
```

The last line is deliberately narrow: unrestricted write access to
`homeassistant/#` would let a compromised TV register arbitrary new entities
via MQTT Discovery.

**2. Encrypt the connection.** Without TLS the username and password cross your
network in cleartext in every CONNECT packet, and a reconnect loop resends them
every few seconds:

```json
"mqtt": { "tls": true, "port": 8883 }
```

Set `"tlsRejectUnauthorized": false` only if your broker uses a self-signed
certificate &mdash; the traffic stays encrypted, but the broker is no longer
authenticated, so only do it on a network you trust.

**3. Consider network segmentation.** Putting the TV on its own VLAN that can
reach only the broker is sound defence in depth. It does not replace the ACL:
the TV must reach the broker by definition, so a stolen credential still works
from inside the segment. The ACL is what limits the blast radius.

**4. Close the root telnet.** While port 23 is an open root shell, nothing
stored on the TV is secret and every measure above is mitigation around that
fact. Installing openssh via the Homebrew Channel and disabling telnet is the
single biggest improvement you can make.

---
