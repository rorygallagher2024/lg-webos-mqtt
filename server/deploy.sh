#!/bin/bash
#
# Push tvweb to the TV and (re)start it.
#
# Prefers SSH: if key-based login works, files go over scp and commands over
# ssh. That is the recommended setup - see the Security section of the README.
#
# Falls back to the Homebrew Channel's root telnet on port 23 for TVs that
# have not enabled SSH. That path serves the files over HTTP from this machine
# for a few seconds, because telnet gives us no file transfer.
#
# Usage: ./deploy.sh [tv-ip] [--persist] [--telnet]
#   --persist  also install the boot hook so it survives a reboot
#   --telnet   force the telnet path even if SSH is available

set -e

TV=""
PERSIST=""
FORCE_TELNET=""
for a in "$@"; do
  case "$a" in
    --persist) PERSIST=1 ;;
    --telnet)  FORCE_TELNET=1 ;;
    -*)        echo "unknown option: $a" >&2; exit 2 ;;
    *)         TV="$a" ;;
  esac
done
TV="${TV:-192.168.1.134}"

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8771
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new)

# ---------------------------------------------------------------- transport
use_ssh() {
  [ -n "$FORCE_TELNET" ] && return 1
  ssh "${SSH_OPTS[@]}" "root@$TV" true >/dev/null 2>&1
}

tvsh() {   # run stdin on the TV over the homebrew root telnet
  { printf '\n'; sleep 1; cat; printf '\nexit\n'; sleep "${W:-8}"; } \
    | nc -w $(( ${W:-8} + 5 )) "$TV" 23 2>/dev/null | tr -d '\r'
}

start_http() {
  ( python3 -m http.server "$PORT" --directory "$DIR" --bind 0.0.0.0 >/dev/null 2>&1 &
    echo $! > /tmp/.tvweb_httpd )
  sleep 1
}
stop_http() { kill "$(cat /tmp/.tvweb_httpd 2>/dev/null)" 2>/dev/null || true; rm -f /tmp/.tvweb_httpd; }

FILES="tvweb.js tvwebctl assets/ui.html assets/fonts/Outfit.ttf assets/fonts/Manrope.ttf \
assets/fonts/OFL-Outfit.txt assets/fonts/OFL-Manrope.txt"

# ---------------------------------------------------------------- ssh path
deploy_ssh() {
  echo "deploying to $TV over ssh ..."
  ssh "${SSH_OPTS[@]}" "root@$TV" 'mkdir -p /var/lib/tvweb/assets/fonts'
  for f in $FILES; do
    scp "${SSH_OPTS[@]}" -q "$DIR/$f" "root@$TV:/var/lib/tvweb/$f"
  done
  [ -f "$DIR/config.json" ] && scp "${SSH_OPTS[@]}" -q "$DIR/config.json" "root@$TV:/var/lib/tvweb/config.json"

  if [ -n "$PERSIST" ]; then
    ssh "${SSH_OPTS[@]}" "root@$TV" 'mkdir -p /var/lib/webosbrew/init.d'
    # run-parts ignores filenames containing a dot, so the hook must not end .sh
    scp "${SSH_OPTS[@]}" -q "$DIR/50-tvweb.sh" "root@$TV:/var/lib/webosbrew/init.d/50-tvweb"
    ssh "${SSH_OPTS[@]}" "root@$TV" 'chmod +x /var/lib/webosbrew/init.d/50-tvweb'
    echo "boot hook installed"
  fi

  # Restart via the on-TV control script. Doing this inline over ssh does not
  # work: any pkill pattern matching tvweb.js also matches the remote shell,
  # whose argv contains that path, so it kills itself first.
  ssh "${SSH_OPTS[@]}" "root@$TV" '
    chmod +x /var/lib/tvweb/tvwebctl
    /var/lib/tvweb/tvwebctl restart
    sleep 4
    /var/lib/tvweb/tvwebctl status
    tail -6 /var/lib/tvweb/tvweb.log'
}

# ---------------------------------------------------------------- telnet path
deploy_telnet() {
  MYIP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null \
         || hostname -I 2>/dev/null | awk '{print $1}')
  [ -z "$MYIP" ] && { echo "could not determine this machine's LAN IP" >&2; exit 1; }
  echo "deploying to $TV over telnet (no ssh); serving from $MYIP:$PORT ..."
  start_http
  trap stop_http EXIT

  # NOTE: this heredoc is unquoted so $MYIP/$PORT expand HERE. Anything that
  # must run on the TV has to be escaped (\$f, \$(...)).
  W=16 tvsh <<TVCMDS
mkdir -p /var/lib/tvweb/assets/fonts
wget -q -O /var/lib/tvweb/tvweb.js http://$MYIP:$PORT/tvweb.js && echo "tvweb.js \$(wc -c < /var/lib/tvweb/tvweb.js) bytes"
wget -q -O /var/lib/tvweb/assets/ui.html http://$MYIP:$PORT/assets/ui.html && echo "ui.html \$(wc -c < /var/lib/tvweb/assets/ui.html) bytes"
wget -q -O /var/lib/tvweb/tvwebctl http://$MYIP:$PORT/tvwebctl
for f in Outfit.ttf Manrope.ttf OFL-Outfit.txt OFL-Manrope.txt; do
  wget -q -O /var/lib/tvweb/assets/fonts/\$f http://$MYIP:$PORT/assets/fonts/\$f
done
echo "fonts: \$(ls /var/lib/tvweb/assets/fonts | wc -l) files"
$([ -f "$DIR/config.json" ] && echo "wget -q -O /var/lib/tvweb/config.json http://$MYIP:$PORT/config.json")
chmod 600 /var/lib/tvweb/config.json 2>/dev/null
$([ -n "$PERSIST" ] && echo "mkdir -p /var/lib/webosbrew/init.d && wget -q -O /var/lib/webosbrew/init.d/50-tvweb http://$MYIP:$PORT/50-tvweb.sh && chmod +x /var/lib/webosbrew/init.d/50-tvweb && echo 'boot hook installed'")
chmod +x /var/lib/tvweb/tvwebctl
/var/lib/tvweb/tvwebctl restart
sleep 4
/var/lib/tvweb/tvwebctl status
tail -6 /var/lib/tvweb/tvweb.log
TVCMDS
  stop_http
  trap - EXIT
}

# ---------------------------------------------------------------- go
if use_ssh; then
  deploy_ssh
else
  if [ -z "$FORCE_TELNET" ]; then
    echo "note: ssh to root@$TV did not work, falling back to telnet." >&2
    echo "      Enabling SSH in the Homebrew Channel is recommended - see README." >&2
  fi
  deploy_telnet
fi

echo
echo "verifying ..."
curl -s --max-time 8 "http://$TV:8080/api/caps" || echo "(no response yet - give it a moment)"
echo
echo "open  http://$TV:8080/"
