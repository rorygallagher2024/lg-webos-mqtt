#!/usr/bin/env python3
"""
Check that every discovery entity in tvweb.js appears in the entity table, and
that the count the docs quote is the number actually defined.

The table drifted for months without anyone noticing: eight entities were
missing from it, and the README, this table and the code disagreed on how many
there were - 48, 42 and 50 respectively. A count is easy to leave behind when
adding an entity, and nothing failed when it was.

Generating the table instead was the obvious alternative and is the wrong one:
the Entity ID column is what Home Assistant registered at first discovery,
which depends on the device name and on what the entity was called at the
time. That cannot be derived from source, and the descriptions are written for
a reader rather than extracted. So the table stays hand-written and this checks
it, rather than the other way round.

    ./scripts/check-entity-docs.py

Exits non-zero if an entity is undocumented or a quoted count is wrong.
"""
import re, sys, pathlib

root = pathlib.Path(__file__).parent.parent
src = (root / 'server' / 'tvweb.js').read_text(encoding='utf-8')
doc_path = root / 'docs' / 'HOME-ASSISTANT.md'
doc = doc_path.read_text(encoding='utf-8')
readme = (root / 'README.md').read_text(encoding='utf-8')

# Entity definitions, as publishDiscovery lists them. Keyed by domain and
# name: an id is not unique (picture_mode is both a sensor and a select), and
# the id is not what the table lists anyway - see below.
defined = {}
for typ, eid, body in re.findall(r"type: '(\w+)', id: '([\w_]+)',(.*?)\n      \}", src, re.S):
    name = re.search(r"name: '([^']+)'", body)
    defined[(typ, name.group(1) if name else eid)] = eid

# Documented rows: | `domain` | `domain.device_objectid` | Name | Description |
#
# Matched on domain and name rather than entity id. Home Assistant derives the
# entity id at first discovery from the name it had then, so it need not match
# the id in the source - cpu_load is registered as sensor.<device>_cpu_usage -
# and it carries a device prefix that varies with device.id.
documented = {}
for domain, entity_id, name in re.findall(r'\|\s*`(\w+)`\s*\|\s*`([\w.]+)`\s*\|\s*([^|]+?)\s*\|', doc):
    documented[(domain, name)] = entity_id

problems = []
for key in sorted(defined):
    if key not in documented:
        problems.append(f'undocumented: {key[0]}/{defined[key]} ("{key[1]}")')
for key in sorted(documented):
    if key not in defined:
        problems.append(f'documented but not defined: {key[0]} "{key[1]}" ({documented[key]})')

# Any count quoted anywhere has to be the number defined. A set publishes
# fewer - capability-dependent entities are withheld - so the docs say so in
# words; what must not drift is the total.
total = len(defined)
for label, text in (('README.md', readme), ('docs/HOME-ASSISTANT.md', doc)):
    for quoted in re.findall(r'(\d+)\s+(?:native\s+)?entities', text):
        if int(quoted) != total:
            problems.append(f'{label} says {quoted} entities, {total} are defined')

print(f'{total} entities defined, {len(documented)} rows in the table')
if problems:
    print(f'\n{len(problems)} problem(s):')
    for p in problems:
        print('  ' + p)
    sys.exit(1)
print('every entity is documented and the counts agree')
