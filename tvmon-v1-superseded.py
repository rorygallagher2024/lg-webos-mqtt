#!/usr/bin/env python3
"""
tvmon - live CPU / thermal / memory monitor for a rooted LG webOS TV.
Tested against OLED65B8SLC, webOS 4.4.3, kernel 4.4.84 (glacier / m16pc0).

Reads LG's own /proc/lg/pm/* nodes over the Homebrew Channel root telnet.
Stdlib only. Usage:  ./tvmon.py [ip] [--interval 1.0]
"""

import socket, sys, time, re, argparse, os, signal

MARK_A, MARK_B = "<<<TVMON", "TVMON>>>"

PROBE = (
    'echo "<<<TV""MON"; '
    'echo "temp=$(cat /proc/lg/pm/temperature 2>/dev/null)"; '
    'echo "load=$(cat /proc/lg/pm/current_load 2>/dev/null)"; '
    'echo "freq=$(cat /proc/lg/pm/frequency 2>/dev/null)"; '
    'echo "cores=$(grep -m1 \'^load:\' /proc/lg/pm/status 2>/dev/null | cut -d: -f2)"; '
    'echo "gov=$(grep -m1 \'^governor:\' /proc/lg/pm/status 2>/dev/null | cut -d: -f2)"; '
    'echo "cpuavs=$(cat /proc/lg/pm/cpuavs 2>/dev/null)"; '
    'echo "coreavs=$(cat /proc/lg/pm/coreavs 2>/dev/null)"; '
    'echo "stat=$(grep -m1 \'^cpu \' /proc/stat)"; '
    'echo "loadavg=$(cat /proc/loadavg)"; '
    'echo "uptime=$(cut -d. -f1 /proc/uptime)"; '
    'grep -E \'^(MemTotal|MemFree|MemAvailable|Buffers|^Cached|SwapTotal|SwapFree)\' /proc/meminfo '
    '| tr -d \' \' | tr \':\' \'=\'; '
    'echo "procs=$(ps -e 2>/dev/null | wc -l)"; '
    'echo "top=$(ps -eo rss,comm 2>/dev/null | sort -rn | head -6 | tail -5 | tr \'\\n\' \'|\')"; '
    'echo "TV""MON>>>"\n'
)

RESET, BOLD, DIM = "\033[0m", "\033[1m", "\033[2m"
RED, YEL, GRN, CYA, MAG, BLU = ("\033[31m", "\033[33m", "\033[32m",
                                "\033[36m", "\033[35m", "\033[34m")
SPARK = "▁▂▃▄▅▆▇█"


def strip_iac(buf: bytes) -> bytes:
    """Remove telnet IAC negotiation sequences without replying to them."""
    out, i = bytearray(), 0
    while i < len(buf):
        if buf[i] == 255:                       # IAC
            if i + 1 < len(buf) and buf[i + 1] in (251, 252, 253, 254):
                i += 3; continue
            i += 2; continue
        out.append(buf[i]); i += 1
    return bytes(out)


class TV:
    def __init__(self, host, port=23, timeout=6.0):
        self.host, self.port, self.timeout = host, port, timeout
        self.sock = None

    def connect(self):
        self.close()
        s = socket.create_connection((self.host, self.port), timeout=self.timeout)
        s.settimeout(self.timeout)
        self.sock = s
        time.sleep(0.6)
        try:
            s.recv(65536)                        # drain banner + negotiation
        except socket.timeout:
            pass
        self.sock.sendall(b"stty -echo 2>/dev/null; PS1=''; unset PROMPT_COMMAND\n")
        time.sleep(0.5)
        try:
            s.recv(65536)
        except socket.timeout:
            pass

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def poll(self):
        if not self.sock:
            self.connect()
        self.sock.sendall(PROBE.encode())
        buf = b""
        deadline = time.time() + self.timeout
        while time.time() < deadline:
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                break
            if not chunk:
                raise ConnectionError("closed")
            buf += chunk
            if MARK_A.encode() in buf and MARK_B.encode() in buf:
                break
        text = strip_iac(buf).decode("utf-8", "replace").replace("\r", "")
        if MARK_A not in text:
            raise ConnectionError("no marker")
        body = text.split(MARK_A)[-1].split(MARK_B)[0]
        d = {}
        for line in body.splitlines():
            if "=" in line:
                k, _, v = line.partition("=")
                d[k.strip()] = v.strip()
        return d


def col_for(v, warn, crit):
    return RED if v >= crit else (YEL if v >= warn else GRN)


def bar(pct, width=34, warn=101, crit=101):
    pct = max(0.0, min(100.0, pct))
    fill = int(round(pct / 100 * width))
    c = col_for(pct, warn, crit)
    return c + "█" * fill + DIM + "·" * (width - fill) + RESET


def spark(hist, width=46):
    if not hist:
        return ""
    h = hist[-width:]
    lo, hi = min(h), max(h)
    rng = (hi - lo) or 1
    return "".join(SPARK[min(7, int((v - lo) / rng * 7.99))] for v in h)


def hhmm(sec):
    sec = int(sec)
    d, r = divmod(sec, 86400)
    h, r = divmod(r, 3600)
    m = r // 60
    return (f"{d}d " if d else "") + f"{h}h {m}m"


def kb(n):
    return f"{n/1024:,.0f} MB"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("host", nargs="?", default="192.168.1.134")
    ap.add_argument("--interval", type=float, default=1.5)
    a = ap.parse_args()

    tv = TV(a.host)
    t_hist, l_hist = [], []
    prev_stat, err, ok = None, None, 0

    signal.signal(signal.SIGINT, lambda *_: (sys.stdout.write("\033[?25h\n"), sys.exit(0)))
    sys.stdout.write("\033[?25l\033[2J")

    while True:
        try:
            d = tv.poll()
            err = None
            ok += 1
        except Exception as e:
            err = str(e) or e.__class__.__name__
            tv.close()
            d = {}

        out = ["\033[H"]
        W = 64
        title = f" LG B8 · {a.host} "
        out.append(f"{BOLD}{CYA}┌{title}{'─'*(W-len(title))}┐{RESET}\033[K\n")

        if err:
            out.append(f"{RED}  ✖ unreachable — {err}{RESET}\033[K\n")
            out.append(f"{DIM}  TV is probably powered off. Retrying…{RESET}\033[K\n")
            out.append("\033[J")
            sys.stdout.write("".join(out)); sys.stdout.flush()
            time.sleep(3.0)
            continue

        temp = int(d.get("temp") or 0)
        lgload = int(d.get("load") or 0)
        freq = int(d.get("freq") or 0) // 1000
        t_hist.append(temp); l_hist.append(lgload)
        del t_hist[:-200], l_hist[:-200]

        # CPU% from /proc/stat deltas
        cpu_pct = None
        parts = (d.get("stat") or "").split()[1:]
        if len(parts) >= 4:
            cur = [int(x) for x in parts]
            if prev_stat and len(prev_stat) == len(cur):
                dt = [c - p for c, p in zip(cur, prev_stat)]
                # LG hot-plugs cores (see /proc/lg/pm/mp_enable), so the
                # aggregate /proc/stat counters are NOT monotonic. Any
                # negative delta means a core went away -> sample is void.
                if all(x >= 0 for x in dt) and sum(dt) > 0:
                    cpu_pct = (sum(dt) - dt[3]) / sum(dt) * 100
            prev_stat = cur

        tc = col_for(temp, 60, 75)
        out.append(f"{BOLD}  TEMP {RESET}{tc}{BOLD}{temp:3d}°C{RESET}  {bar(temp, 30, 60, 75)}\033[K\n")
        out.append(f"{DIM}       {spark(t_hist)}{RESET}\033[K\n")
        lo, hi = (min(t_hist), max(t_hist)) if t_hist else (0, 0)
        out.append(f"{DIM}       min {lo}°  max {hi}°  ({len(t_hist)} samples){RESET}\033[K\n\033[K\n")

        shown = float(lgload)
        out.append(f"{BOLD}  CPU  {RESET}{col_for(shown,60,85)}{BOLD}{shown:5.1f}%{RESET} {bar(shown, 28, 60, 85)}\033[K\n")
        out.append(f"{DIM}       {spark(l_hist)}{RESET}\033[K\n")
        stat_txt = f"{cpu_pct:.0f}%" if cpu_pct is not None else "n/a"
        out.append(f"{DIM}       {freq} MHz  ·  /proc/stat {stat_txt}"
                   f"  ·  {d.get('gov','?').replace('GOV_','').lower()}{RESET}\033[K\n")

        cores = (d.get("cores") or "").split()
        if cores:
            seg = "  ".join(
                f"c{i} {col_for(int(c),60,85)}{int(c):3d}%{RESET}"
                for i, c in enumerate(cores) if c.isdigit())
            out.append(f"{DIM}       {RESET}{seg}\033[K\n")
        out.append("\033[K\n")

        mt = int(d.get("MemTotal", "0kB").rstrip("kB") or 0)
        ma = int(d.get("MemAvailable", "0kB").rstrip("kB") or 0)
        st = int(d.get("SwapTotal", "0kB").rstrip("kB") or 0)
        sf = int(d.get("SwapFree", "0kB").rstrip("kB") or 0)
        if mt:
            used = mt - ma
            mp = used / mt * 100
            out.append(f"{BOLD}  MEM  {RESET}{col_for(mp,75,90)}{BOLD}{mp:5.1f}%{RESET} {bar(mp, 28, 75, 90)}\033[K\n")
            out.append(f"{DIM}       {kb(used)} used · {kb(ma)} available of {kb(mt)}{RESET}\033[K\n")
        if st:
            sp = (st - sf) / st * 100
            out.append(f"{BOLD}  SWAP {RESET}{col_for(sp,40,70)}{BOLD}{sp:5.1f}%{RESET} {bar(sp, 28, 40, 70)}\033[K\n")
            out.append(f"{DIM}       {kb(st-sf)} of {kb(st)} (zram){RESET}\033[K\n")
        out.append("\033[K\n")

        la = (d.get("loadavg") or "").split()[:3]
        out.append(f"{DIM}  load {' '.join(la)}   up {hhmm(d.get('uptime') or 0)}"
                   f"   {d.get('procs','?').strip()} procs{RESET}\033[K\n")
        avs = f"{d.get('cpuavs','')} {d.get('coreavs','')}"
        m = re.findall(r"(\w+avs)_current\(mA\):(\d+)", avs)
        if m:
            out.append(f"{DIM}  {'  '.join(f'{k} {v} mA' for k, v in m)}{RESET}\033[K\n")
        out.append("\033[K\n")

        out.append(f"{BOLD}{MAG}  top processes{RESET}\033[K\n")
        for e in [x for x in (d.get("top") or "").split("|") if x.strip()][:5]:
            p = e.split()
            if len(p) >= 2:
                out.append(f"{DIM}    {int(p[0])/1024:6.1f} MB  {' '.join(p[1:])}{RESET}\033[K\n")

        out.append(f"\033[K\n{DIM}  {time.strftime('%H:%M:%S')} · {ok} polls · ctrl-c to quit{RESET}\033[K\n")
        out.append("\033[J")
        sys.stdout.write("".join(out)); sys.stdout.flush()
        time.sleep(a.interval)


if __name__ == "__main__":
    main()
