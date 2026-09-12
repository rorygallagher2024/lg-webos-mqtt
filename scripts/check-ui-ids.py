#!/usr/bin/env python3
"""
Check that every element the dashboard script reaches for actually exists.

q('x') returns null for an id that is not in the markup, and the next property
access throws. The render runs inside a try/catch, so nothing looks broken - the
page simply stops updating part way through, which is how a stale id left behind
after moving a block between tabs went unnoticed until two tabs vanished.

Two kinds of reference are fine and are not reported:

  * a guarded one - `if (q('x'))` or `q('x') && ...` - which is how the page
    reaches for something that is only on one kind of set.
  * an id built at runtime, from a template like id="row-${k}"; anything
    sharing that prefix could exist.

    ./scripts/check-ui-ids.py [file]

Exits non-zero if any id is reached for unguarded and never defined.
"""
import re, sys, pathlib

path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'server/assets/ui.html')
src = path.read_text(encoding='utf-8')
lines = src.split('\n')

defined = set(re.findall(r'\bid="([^"$]+)"', src))
# id="row-${...}" - anything starting with that prefix may be built at runtime
dynamic = [m for m in re.findall(r'\bid="([^"$]*)\$\{', src) if m]

def is_dynamic(name):
    return any(name.startswith(p) for p in dynamic)

problems = []
for n, line in enumerate(lines, 1):
    code = re.sub(r'//.*$', '', line)
    for m in re.finditer(r"""\bq\(\s*['"]([^'"]+)['"]\s*\)""", code):
        name = m.group(1)
        if name in defined or is_dynamic(name):
            continue
        # A name tested anywhere on the line guards every use of it there:
        # `if (q('x')) q('x').hidden = ...` is one statement, not two chances
        # to throw.
        pat = re.escape("q('%s')" % name) + r"\s*(?:\)|&&)"
        guarded = re.search(pat, code) is not None
        if not guarded:
            problems.append((n, name))

for n, name in problems:
    print('%s:%d: no element with id "%s"' % (path, n, name))
print('%d defined, %d dynamic prefixes, %d unguarded and missing'
      % (len(defined), len(dynamic), len(problems)))
sys.exit(1 if problems else 0)
