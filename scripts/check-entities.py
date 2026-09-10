#!/usr/bin/env python3
"""
Check that every Home Assistant entity derives its state from something the TV
actually reports.

The display panel switch once published its state only when the command
arrived over MQTT, so blanking the panel from the dashboard or the remote left
Home Assistant asserting the opposite forever. Templates can also drift from
the telemetry payload silently - a renamed field just yields an entity stuck
at "unknown", which nobody notices for weeks.

This walks every discovery entity in tvweb.js, extracts the value_json paths
its template references, and resolves each against a live /api/stats response.

    ./scripts/check-entities.py [tv-ip] [--token TOKEN] [--stats FILE]

A set with `token` configured - which the README recommends - answers /api/
with 401, so pass the same token here. TVWEB_TOKEN works too, and is the
better place for it: an argument is visible to every other process on the
machine for as long as the run takes.

--stats reads a saved /api/stats response instead of fetching one, so the
check can run against a recorded payload with no TV on the network.

Exits non-zero if any path fails to resolve.
"""
import json, os, re, sys, urllib.request, urllib.error, urllib.parse, pathlib

args = sys.argv[1:]


def take(flag):
    """Pull `--flag value` out of args, returning the value."""
    if flag not in args:
        return None
    i = args.index(flag)
    if i + 1 >= len(args):
        sys.exit(f'{flag} needs a value')
    args.pop(i)
    return args.pop(i)


stats_file = take('--stats')
token = take('--token') or os.environ.get('TVWEB_TOKEN')
tv = args[0] if args else '192.168.1.134'
src = (pathlib.Path(__file__).parent.parent / 'server' / 'tvweb.js').read_text(encoding='utf-8')

if stats_file:
    try:
        stats = json.loads(pathlib.Path(stats_file).read_text(encoding='utf-8'))
    except Exception as e:
        sys.exit(f'could not read {stats_file}: {e}')
else:
    url = f'http://{tv}:8080/api/stats'
    if token:
        url += '?k=' + urllib.parse.quote(token, safe='')
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            stats = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            sys.exit(f'{tv} rejected the request: pass --token, or set TVWEB_TOKEN, '
                     'to match `token` in its config.json')
        sys.exit(f'could not reach {tv}: {e}')
    except Exception as e:
        sys.exit(f'could not reach {tv}: {e}')

if not isinstance(stats, dict) or not stats.get('ok'):
    sys.exit(f'not a usable /api/stats payload: {str(stats)[:120]}')


def resolve(path):
    cur = stats
    for part in path.split('.'):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return False
    return True


blocks = re.findall(
    r"type: '(switch|number|select|sensor|binary_sensor)', id: '([a-z0-9_]+)',\s*payload: \{(.*?)\n        \}",
    src, re.S)

failures, checked = [], 0
print(f'{"entity":30} {"state source":14} paths')
print('-' * 74)
for typ, eid, body in blocks:
    source = ('telemetry' if 'telemetryTopic' in body
              else 'own topic' if 'Topic' in body else 'none')
    tmpl = re.search(r"value_template:\s*'(.*?)'", body, re.S)
    paths = sorted(set(re.findall(r'value_json\.([A-Za-z0-9_.]+)', tmpl.group(1)))) if tmpl else []
    # A template that guards its own path (`... if value_json.x else none`) is
    # allowed to reference something absent: that is how optional hardware is
    # handled. Only an unguarded missing path is a real failure.
    body = tmpl.group(1) if tmpl else ''
    guarded = 'else none' in body or 'else "' in body
    missing = [p for p in paths if not resolve(p)]
    bad = [] if guarded else missing
    optional = missing if guarded else []
    checked += len(paths)
    status = ', '.join(paths) if paths else '(no template)'
    note = 'FAIL ' if bad else ('optional, absent: ' if optional else '')
    print(f'{eid:30} {source:14} {note}{status}')
    for p in bad:
        print(f'{"":46} MISSING: {p}')
        failures.append(f'{eid}: {p}')

    # Entities on their own topic cannot self-correct from the telemetry
    # payload, so flag them for a human to confirm something republishes them
    # from real state. Only display_panel is in this position today.
    if source == 'own topic':
        print(f'{"":46} note: own topic - confirm it is republished from real state')

print()
print(f'{checked} paths checked across {len(blocks)} entities')
if failures:
    print(f'{len(failures)} unresolved:')
    for f in failures:
        print('  ' + f)
    sys.exit(1)
print('all entity templates resolve against the live payload')
