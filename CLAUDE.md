# Working conventions

## Never push to main

Branch, push the branch, open a PR. This applies to "commit and push" too.
Push to an existing PR branch rather than opening a second one for the same
line of work. Merging is the maintainer's call.

# Writing conventions

Applies to commit messages, PR descriptions, release notes, README and docs.

## Keep it short

State what changed and why. Stop. A PR description is usually a paragraph or
two, not a report.

Length should track the size of the change, not the effort behind it. A
one-line fix gets one line.

## Don't narrate the work

No process commentary: what was tried, what was ruled out, what turned out to
be a false alarm, how something was verified. If a check found nothing, that
is not a finding worth writing down.

Record decisions and their reasons, not the route taken to reach them.

## Third person, always

These are project artefacts, not messages to a reader. Never "you", "your TV",
"as you asked". Write "the TV", "the panel switch".

## No filler structure

Don't add headings, tables or bullet lists to a short change. Tables are for
genuine matrices - a compatibility list, a unit reference - not for restating
three sentences.

Don't list things that did not change.

## Comments in code

Explain why, where a reader would otherwise wonder or get it wrong: a platform
quirk, a non-obvious ordering constraint, a value that looks wrong but isn't.
Skip comments that restate the code.

Keep the measured facts that justify a decision (an observed value, a version,
a threshold). Drop the story around them.
