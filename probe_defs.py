# Probe definitions for tvmon. Split out so the shell quoting stays readable.

FAST = (
    'echo "<<<TV""MON"; '
    'echo "temp=$(cat /proc/lg/pm/temperature 2>/dev/null)"; '
    'echo "load=$(cat /proc/lg/pm/current_load 2>/dev/null)"; '
    'echo "freq=$(cat /proc/lg/pm/frequency 2>/dev/null)"; '
    'echo "cores=$(grep -m1 \'^load:\' /proc/lg/pm/status 2>/dev/null | cut -d: -f2)"; '
    'echo "cpuavs=$(cat /proc/lg/pm/cpuavs 2>/dev/null)"; '
    'echo "coreavs=$(cat /proc/lg/pm/coreavs 2>/dev/null)"; '
    'echo "stat=$(grep -m1 \'^cpu \' /proc/stat)"; '
    'echo "loadavg=$(cat /proc/loadavg)"; '
    'echo "uptime=$(cut -d. -f1 /proc/uptime)"; '
    'grep -E \'^(MemTotal|MemFree|MemAvailable|Buffers|SwapTotal|SwapFree)\' /proc/meminfo '
    '| tr -d \' \' | tr \':\' \'=\'; '
    'echo "procs=$(ps -e 2>/dev/null | wc -l)"; '
    'echo "wifi=$(grep wlan0 /proc/net/wireless 2>/dev/null | tr -s \' \')"; '
    'echo "net=$(grep -E \'wlan0|eth0\' /proc/net/dev | tr -s \' \' | tr \'\\n\' \';\')"; '
    'echo "top=$(ps -eo rss,comm 2>/dev/null | sort -rn | head -6 | tail -5 | tr \'\\n\' \'|\')"; '
)

# Luna + eMMC calls are slower, so tvmon runs these only every Nth cycle.
SLOW = (
    'echo "emmc_life=$(cat /sys/block/mmcblk0/device/life_time 2>/dev/null)"; '
    'echo "emmc_eol=$(cat /sys/block/mmcblk0/device/pre_eol_info 2>/dev/null)"; '
    'echo "power=$(luna-send -n 1 -f luna://com.webos.service.tvpower/power/getPowerState '
    '\'{}\' 2>/dev/null | tr -d \'\\n \')"; '
    'echo "app=$(luna-send -n 1 -f luna://com.webos.applicationManager/getForegroundAppInfo '
    '\'{}\' 2>/dev/null | tr -d \'\\n \')"; '
    'echo "pic=$(luna-send -n 1 -f luna://com.webos.service.settings/getSystemSettings '
    '\'{"category":"picture","keys":["backlight","pictureMode"]}\' 2>/dev/null | tr -d \'\\n \')"; '
)

END = 'echo "TV""MON>>>"\n'
