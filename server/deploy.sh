#!/bin/bash
# Push tvweb.js to the TV and (re)start it.
#
# There is no SSH/scp on this TV, so this serves the file over HTTP from this
# machine for a few seconds and has the TV wget it. Nothing is left listening.
#
# Usage: ./deploy.sh [tv-ip] [--persist]
#   --persist  also install the boot hook so it survives a reboot

set -e
TV="${1:-192.168.1.134}"
[ "$1" = "--persist" ] && TV=192.168.1.134
PERSIST=""
for a in "$@"; do [ "$a" = "--persist" ] && PERSIST=1; done

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8771
MYIP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null \
       || hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$MYIP" ] && { echo "could not determine this machine's LAN IP"; exit 1; }

HTTP_PID=""
stop_http() {
  if [ -n "$HTTP_PID" ]; then
    kill "$HTTP_PID" 2>/dev/null || true
    wait "$HTTP_PID" 2>/dev/null || true
    HTTP_PID=""
  fi
  local leftover
  leftover=$(lsof -ti :"$PORT" 2>/dev/null || true)
  if [ -n "$leftover" ]; then
    kill -9 $leftover 2>/dev/null || true
  fi
}
trap stop_http EXIT INT TERM

start_http() {
  stop_http
  python3 -m http.server "$PORT" --directory "$DIR" --bind 0.0.0.0 >/dev/null 2>&1 &
  HTTP_PID=$!
  sleep 1
}

tvsh() {  # run stdin on the TV over the homebrew root telnet
  { printf '\n'; sleep 1; cat; printf '\nexit\n'; sleep "${W:-6}"; } \
    | nc -w $(( ${W:-6} + 5 )) "$TV" 23 2>/dev/null | LC_ALL=C tr -d '\r'
}

echo "serving $DIR on $MYIP:$PORT ..."
start_http

echo "deploying to $TV ..."
W=14 tvsh <<TVCMDS
mkdir -p /var/lib/tvweb
wget -q -O /var/lib/tvweb/tvweb.js http://$MYIP:$PORT/tvweb.js && echo "fetched tvweb.js (\$(wc -c < /var/lib/tvweb/tvweb.js) bytes)"
mkdir -p /var/lib/tvweb/assets/fonts
wget -q -O /var/lib/tvweb/assets/ui.html http://$MYIP:$PORT/assets/ui.html && echo "ui.html $(wc -c < /var/lib/tvweb/assets/ui.html) bytes"
for f in clash_display_extralight clash_display_light satoshi_light satoshi_regular satoshi_medium; do
  wget -q -O /var/lib/tvweb/assets/fonts/$f.otf http://$MYIP:$PORT/assets/fonts/$f.otf
done
echo "fonts: $(ls /var/lib/tvweb/assets/fonts | wc -l) files"
$([ -f "$DIR/config.json" ] && echo "wget -q -O /var/lib/tvweb/config.json http://$MYIP:$PORT/config.json && echo 'fetched config.json'")
pkill -9 -f tvweb.js 2>/dev/null || true
sleep 1
setsid /usr/bin/node /var/lib/tvweb/tvweb.js > /var/lib/tvweb/tvweb.log 2>&1 &
sleep 2
cat /var/lib/tvweb/tvweb.log
$([ -n "$PERSIST" ] && cat <<EOF
echo "installing boot hook ..."
mkdir -p /var/lib/webosbrew/init.d
wget -q -O /var/lib/webosbrew/init.d/50-tvweb http://$MYIP:$PORT/50-tvweb.sh && echo "fetched 50-tvweb"
chmod +x /var/lib/webosbrew/init.d/50-tvweb
ln -sf /var/lib/webosbrew/init.d/50-tvweb /var/lib/webosbrew/init.d/50-tvweb.sh
ls -la /var/lib/webosbrew/init.d/
echo "testing run-parts detection:"
run-parts --test /var/lib/webosbrew/init.d
EOF
)
TVCMDS

stop_http
echo "transfer server stopped"

echo
echo "verifying HTTP response from http://$TV:8080/api/caps ..."
curl -s -m 5 "http://$TV:8080/api/caps" && echo "" || echo "warning: could not reach http://$TV:8080/"

echo
echo "open  http://$TV:8080/"
