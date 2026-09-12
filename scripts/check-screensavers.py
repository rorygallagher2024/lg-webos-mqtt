#!/usr/bin/env python3
"""
Check the screen saver QML against the QtQuick version it declares.

qml-runner on the TV reports nothing at all for a file it cannot load - not on
stdout, not in the system log - so a QML mistake shows up as a screen saver
that simply never draws. These are the two mistakes that have actually shipped:

  * a property newer than the `import QtQuick x.y` line at the top, which makes
    the whole file fail to load. A B8 runs Qt 5.6 and a C2 runs Qt 5.12, but
    the import version is what decides availability, not the Qt build.
  * anchors on a direct child of a Row or Column, which QML refuses for the
    axis that the layout owns, so the item silently lands somewhere else.

    ./scripts/check-screensavers.py [files...]

Exits non-zero if anything is flagged.
"""
import re, sys, pathlib

# property -> QtQuick version that introduced it
SINCE = {
    'topPadding': (2, 6), 'bottomPadding': (2, 6),
    'leftPadding': (2, 6), 'rightPadding': (2, 6), 'padding': (2, 6),
    'advance': (2, 10), 'renderTypeQuality': (2, 15),
    'palette': (2, 13), 'containmentMask': (2, 11),
}
# anchors a Row or Column will not honour on its own children
BANNED = {
    'Column': ('left', 'right', 'horizontalCenter', 'fill', 'centerIn'),
    'Row':    ('top', 'bottom', 'verticalCenter', 'fill', 'centerIn'),
}

def check(path):
    src = path.read_text(encoding='utf-8')
    lines = src.splitlines()
    bad = []

    # Braces, ignoring those inside strings and comments. An unbalanced file
    # fails to load with no message at all, the same as any other QML mistake.
    # Strings first: a path like "file:///usr/share/fonts/x.ttf" contains //,
    # and stripping comments before strings would eat the rest of that line.
    stripped = re.sub(r'"(?:[^"\\\n]|\\.)*"', '""', src)
    stripped = re.sub(r"'(?:[^'\\\n]|\\.)*'", "''", stripped)
    stripped = re.sub(r'/\*.*?\*/', '', stripped, flags=re.S)
    stripped = re.sub(r'//[^\n]*', '', stripped)
    opens, closes = stripped.count('{'), stripped.count('}')
    if opens != closes:
        bad.append((0, 'unbalanced braces: %d open, %d close' % (opens, closes)))

    m = re.search(r'^\s*import\s+QtQuick\s+(\d+)\.(\d+)\s*$', src, re.M)
    if not m:
        bad.append((0, 'no plain "import QtQuick x.y" line found'))
        ver = (99, 99)
    else:
        ver = (int(m.group(1)), int(m.group(2)))

    # Track brace depth so a Row/Column's direct children can be told apart
    # from anything nested deeper inside them.
    depth = 0
    layouts = []          # (depth_of_body, kind)
    for n, line in enumerate(lines, 1):
        code = re.sub(r'//.*$', '', line)

        for prop, since in SINCE.items():
            if re.search(r'(^|[\s{;])' + prop + r'\s*:', code) and ver < since:
                bad.append((n, '%s needs QtQuick %d.%d, file imports %d.%d'
                            % (prop, since[0], since[1], ver[0], ver[1])))

        am = re.search(r'anchors\.(\w+)\s*:', code)
        if am and layouts:
            body_depth, kind = layouts[-1]
            # Depth at the anchor itself, not at the start of the line: an
            # element written on one line opens its own brace first, and
            # without this a legal `Item { Text { anchors... } }` reads the
            # same as a direct child.
            before = code[:am.start()]
            here = depth + before.count('{') - before.count('}')
            if here == body_depth + 1 and am.group(1) in BANNED[kind]:
                bad.append((n, 'anchors.%s on a direct child of %s is ignored'
                            % (am.group(1), kind)))

        start = re.match(r'\s*(Row|Column)\s*\{', code)
        opens = code.count('{')
        closes = code.count('}')
        if start and opens:
            layouts.append((depth + 1, start.group(1)))
        depth += opens - closes
        while layouts and depth < layouts[-1][0]:
            layouts.pop()

    return bad

files = [pathlib.Path(a) for a in sys.argv[1:]]
if not files:
    files = sorted(pathlib.Path('server/assets/screensavers').glob('*.qml'))

fails = 0
for f in files:
    problems = check(f)
    if problems:
        fails += 1
        for n, msg in problems:
            print('%s:%d: %s' % (f, n, msg))
    else:
        print('%s: ok' % f)

sys.exit(1 if fails else 0)
