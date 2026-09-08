#!/bin/sh
# webosbrew boot hook: start the tvweb monitor server.
# Install to /var/lib/webosbrew/init.d/50-tvweb (chmod +x).
# Note: BusyBox run-parts ignores filenames containing a dot (.),
# so this hook must not have a .sh extension in init.d.
# Remove /var/lib/webosbrew/init.d/50-tvweb to uninstall.
# Nothing on the read-only rootfs is touched.
#
# Deliberately defensive: never block boot, never respawn-loop. If the
# server is missing or node is gone, this exits quietly.

[ -x /usr/bin/node ] || exit 0
[ -f /var/lib/tvweb/tvweb.js ] || exit 0

export PATH=/bin:/sbin:/usr/bin:/usr/sbin:$PATH

# Restore adblock bind-mount if enabled
if [ -f /var/lib/tvweb/adblock_enabled ] && [ -f /var/lib/tvweb/adblock_hosts ]; then
  mount --bind /var/lib/tvweb/adblock_hosts /etc/hosts 2>/dev/null || true
fi

# Detach fully so upstart/webosbrew startup is never held up by this.
(
  sleep 20   # let the TV finish booting before adding load
  /usr/bin/pkill -9 -f tvweb.js 2>/dev/null || true
  sleep 1
  setsid /usr/bin/node /var/lib/tvweb/tvweb.js \
    > /var/lib/tvweb/tvweb.log 2>&1 &
) &

exit 0
