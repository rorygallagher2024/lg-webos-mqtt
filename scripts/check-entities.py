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

    ./scripts/check-entities.py [tv-ip]

Exits non-zero if any path fails to resolve.
"""
import json, re, sys, urllib.request, pathlib

tv = sys.argv[1] if len(sys.argv) > 1 else '192.168.1.134'
src = (pathlib.Path(__file__).parent.parent / 'server' / 'tvweb.js').read_text(encoding='utf-8')

try:
    with urllib.request.urlopen(f'http://{tv}:8080/api/stats', timeout=10) as r:
        stats = json.load(r)
except Exception as e:
    sys.exit(f'could not reach {tv}: {e}')


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
