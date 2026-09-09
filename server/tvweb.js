/*
 * tvweb.js - on-TV monitor + control web server for a rooted LG webOS TV.
 * Verified on OLED65B8SLC / webOS 4.4.3.
 *
 * IMPORTANT: the TV ships node v0.12.2 (2015). This file must stay ES5 -
 * no arrow functions, no const/let, no template literals, no async/await,
 * no Object.assign. The browser-side code further down is NOT restricted,
 * because it runs in your phone/laptop browser, not on the TV.
 *
 * Run:  node tvweb.js
 */

var http = require('http');
var fs = require('fs');
var THERMAL_PRESENT = fs.existsSync('/proc/lg/pm/temperature');
var EMMC_WEAR_PRESENT = fs.existsSync('/sys/block/mmcblk0/device/life_time');
var url = require('url');
var net = require('net');
var tls = require('tls');
var child_process = require('child_process');
var path = require('path');
var execFile = child_process.execFile;

// ---------------------------------------------------------------- config
var CONFIG = {
  // The dashboard. Turn this off if you drive everything from Home Assistant:
  // it is an unauthenticated control endpoint unless `token` is set, and an
  // MQTT-only install has no reason to expose one.  { "web": { "enabled": false } }
  web: { enabled: true },

  port: 8080,           // dashboard port
  host: '0.0.0.0',      // '127.0.0.1' to keep it TV-local only

  // Anyone who can reach this port can use the controls below.
  allowControl: true,   // volume, screen off/on, input switching, toast

  // Power off / reboot ship DISABLED, because there is no authentication
  // unless `token` is set and a fresh install should not expose "turn the TV
  // off" to the whole network. Enable in your own config.json:
  //     { "allowPower": true }
  allowPower: false,

  // Optional shared secret. If non-empty, every /api/ request must carry
  // ?k=<token>. Keeps casual LAN devices out.
  token: '',

  // Home Assistant & MQTT Integration
  mqtt: {
    // Off until a broker is configured. Shipping an address here would point
    // every install at whatever happens to be at that IP on the user's LAN.
    enabled: false,
    host: '',
    // null means "pick by transport": 1883 plain, 8883 with tls. A literal
    // 1883 here would survive the config merge and silently defeat that.
    port: null,
    // Encrypt the broker connection. Without this the username and password
    // cross the network in cleartext. Port defaults to 8883 when enabled.
    tls: false,
    tlsRejectUnauthorized: true,
    username: '',
    password: '',
    topicPrefix: 'lgtv',
    discoveryPrefix: 'homeassistant',
    telemetryIntervalMs: 10000
  },

  device: {
    id: 'lg_tv',
    name: '',
    model: '',
    manufacturer: 'LG'
  }
};

/* Scanned before loadConfig so --config can point at an alternative file:
   handy for a second TV, or for testing without touching the live config. */
function argvConfigPath() {
  var a = process.argv.slice(2);
  for (var i = 0; i < a.length; i++) {
    if (a[i] === '--config' && a[i + 1]) return a[i + 1];
  }
  return null;
}

function loadConfig() {
  var override = argvConfigPath();
  var paths = override ? [override] : ['/var/lib/tvweb/config.json', './config.json'];
  for (var i = 0; i < paths.length; i++) {
    try {
      if (fs.existsSync(paths[i])) {
        var raw = fs.readFileSync(paths[i], 'utf8');
        var userConf = JSON.parse(raw);
        for (var k in userConf) {
          if (typeof userConf[k] === 'object' && userConf[k] !== null && !Array.isArray(userConf[k])) {
            CONFIG[k] = CONFIG[k] || {};
            for (var sk in userConf[k]) {
              CONFIG[k][sk] = userConf[k][sk];
            }
          } else {
            CONFIG[k] = userConf[k];
          }
        }
        /*
         * The file holds broker credentials in plaintext. Default webOS perms
         * leave it world-readable (0644), and TV apps run as wam/nobody - so
         * tighten it to owner-only. Note this is mitigation, not a fix: while
         * the homebrew root telnet on port 23 is open, nothing on this TV is
         * secret. Use a dedicated, ACL-restricted broker user.
         */
        try {
          var mode = fs.statSync(paths[i]).mode & 0777;
          if (mode !== 0600) {
            fs.chmodSync(paths[i], 0600);
            console.log('tightened permissions on ' + paths[i] + ' to 0600');
          }
        } catch (e) {
          console.error('warning: could not chmod ' + paths[i] + ': ' + e.message);
        }
        console.log('loaded configuration from ' + paths[i]);
        break;
      }
    } catch (e) {
      console.error('warning: error reading config from ' + paths[i] + ':', e.message);
    }
  }
}
loadConfig();

/*
 * Command-line overrides, applied after the config file so they always win.
 * Mainly so a second instance can be run alongside the live one for preview
 * without stealing its port or double-publishing MQTT discovery:
 *   node tvweb.js --port 8081 --no-mqtt
 */
(function applyArgv() {
  var a = process.argv.slice(2);
  for (var i = 0; i < a.length; i++) {
    if (a[i] === '--port' && a[i + 1]) CONFIG.port = parseInt(a[++i], 10) || CONFIG.port;
    else if (a[i] === '--host' && a[i + 1]) CONFIG.host = a[++i];
    else if (a[i] === '--config') i++;   // consumed before loadConfig
    else if (a[i] === '--no-mqtt') { CONFIG.mqtt = CONFIG.mqtt || {}; CONFIG.mqtt.enabled = false; }
    else if (a[i] === '--no-control') CONFIG.allowControl = false;
  }
})();

// ---------------------------------------------------------------- helpers
function rd(path) {
  try { return fs.readFileSync(path, 'utf8').trim(); }
  catch (e) { return null; }
}

function num(v, dflt) {
  var n = parseInt(v, 10);
  return isNaN(n) ? dflt : n;
}

function meminfo() {
  var out = {}, raw = rd('/proc/meminfo');
  if (!raw) return out;
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^(\w+):\s+(\d+)/);
    if (m) out[m[1]] = parseInt(m[2], 10);
  }
  return out;
}

var EOL_MAP = { '01': 'Normal', '02': 'Warning', '03': 'Urgent' };

/* eMMC DEVICE_LIFE_TIME_EST: 0x01 = 0-10% of rated write cycles used (>90% health remaining). */
function emmcInfo() {
  var raw = rd('/sys/block/mmcblk0/device/life_time');
  var eolRaw = rd('/sys/block/mmcblk0/device/pre_eol_info');
  /*
   * Both nodes are absent on webOS 3.x. Reporting a healthy drive because the
   * wear counter could not be read is the same mistake as rendering 0 C for a
   * missing thermal sensor: it states as fact something never measured.
   */
  var eol = (eolRaw && EOL_MAP[eolRaw.trim()]) || 'unknown';   // 0x00 is "not defined", not Normal
  if (!raw) return { life: 'unknown', wear: 'unknown', health: 'unknown', eol: eol };

  var parts = raw.split(/\s+/), wearList = [], minHealth = 100;
  for (var i = 0; i < parts.length; i++) {
    var n = parseInt(parts[i], 16);
    if (!n) continue;
    if (n >= 11) {
      wearList.push('>100%');
      minHealth = 0;
    } else {
      wearList.push(((n - 1) * 10) + '-' + (n * 10) + '%');
      var rem = 100 - (n * 10);
      if (rem < minHealth) minHealth = rem;
    }
  }
  /*
   * The controller reports a band per region, and on a healthy drive they are
   * all the same - "0-10% / 0-10%" is one fact stated twice, and it wrapped to
   * two lines in the dashboard's cell. Collapse them when they agree; a drive
   * whose regions have diverged still shows every band, which is the case
   * where the detail earns its space.
   */
  var uniqWear = [];
  for (var u = 0; u < wearList.length; u++) {
    if (uniqWear.indexOf(wearList[u]) === -1) uniqWear.push(wearList[u]);
  }
  var wearStr = uniqWear.length ? uniqWear.join(' / ') : '0-10%';
  // The wear band inverted. Kept for anyone templating on it; nothing in this
  // project presents it, because next to `wear` it is the same fact twice.
  var healthStr = (minHealth >= 90) ? '>90% (Healthy)' : (minHealth + '% remaining');
  return {
    life: wearStr,    // backwards-compatible with old HA discovery template
    wear: wearStr,
    health: healthStr,
    eol: eol
  };
}

function wifi() {
  var raw = rd('/proc/net/wireless');
  if (!raw) return null;
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('wlan0') !== -1) {
      var f = lines[i].replace(/\s+/g, ' ').trim().split(' ');
      return { link: parseFloat(f[2]), level: parseFloat(f[3]) };
    }
  }
  return null;
}

function netBytes() {
  var raw = rd('/proc/net/dev');
  if (!raw) return null;
  var lines = raw.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('wlan0') !== -1) {
      var f = lines[i].replace(/\s+/g, ' ').trim().split(' ');
      return { rx: parseInt(f[1], 10), tx: parseInt(f[9], 10), t: Date.now() };
    }
  }
  return null;
}

function getVideoSignal() {
  for (var p = 0; p < 4; p++) {
    var raw = rd('/proc/lg/hdmi20/port' + p + '/status');
    if (raw && raw.indexOf('connected: on') !== -1) {
      var wMatch = raw.match(/horizontal-active:\s*(\d+)/);
      var hMatch = raw.match(/vertical-active:\s*(\d+)/);
      var hzMatch = raw.match(/pixel-clock-V:\s*(\d+)\s*Hz/);
      if (wMatch && hMatch) {
        var hz = hzMatch ? (' @ ' + hzMatch[1] + 'Hz') : '';
        return wMatch[1] + 'x' + hMatch[1] + hz;
      }
      return 'Connected';
    }
  }
  return null;
}

var PIC_MODE_MAP = {
  dolbyHdrVivid: 'Dolby Vision Vivid',
  dolbyHdrCinemaBright: 'Dolby Vision Cinema Bright',
  dolbyHdrCinema: 'Dolby Vision Cinema',
  dolbyHdrCinemaHome: 'Dolby Vision Cinema Home',
  dolbyHdrStandard: 'Dolby Vision Standard',
  dolbyHdrGame: 'Dolby Vision Game',
  hdrCinema: 'HDR Cinema',
  hdrCinemaHome: 'HDR Cinema Home',
  hdrStandard: 'HDR Standard',
  hdrGame: 'HDR Game',
  cinema: 'Cinema',
  expert1: 'ISF Expert (Bright)',
  expert2: 'ISF Expert (Dark)',
  game: 'Game',
  standard: 'Standard',
  eco: 'Eco',
  sports: 'Sports',
  technicolorHdr: 'Technicolor HDR'
};

/*
 * Which picture modes the set will accept right now.
 *
 * They depend on the dynamic range of what is playing: under Dolby Vision the
 * only settable modes are the dolbyHdr* ones, and setting an SDR mode is
 * refused with "There is No matched extended item: pictureMode". A fixed list
 * therefore offers buttons that cannot work - which is what the dashboard used
 * to do, showing SDR modes against Dolby Vision content.
 *
 * getSystemSettingValues marks the currently selectable ones visible:true, and
 * that set changes with the source, so it is read rather than assumed.
 */
var lastPicModes = [];

function pictureModes(cb) {
  lunaCached('com.webos.service.settings/getSystemSettingValues',
    { category: 'picture', key: 'pictureMode' }, 10000, function (res) {
      var arr = (res && res.values && res.values.arrayExt) || [];
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].visible === true && arr[i].active !== false) {
          out.push({ value: arr[i].value, label: formatPicMode(arr[i].value) });
        }
      }
      if (out.length) lastPicModes = out;
      cb(out);
    });
}

function formatPicMode(mode) {
  if (!mode) return 'Standard';
  return PIC_MODE_MAP[mode] || mode;
}

function formatDynamicRange(dr) {
  if (!dr || dr === 'sdr') return 'SDR';
  if (dr === 'dolbyHdr') return 'Dolby Vision';
  if (dr === 'hdr') return 'HDR';
  if (dr === 'technicolorHdr') return 'Technicolor HDR';
  return String(dr).toUpperCase();
}

var inputNameMap = {};
var lastInputScan = 0;

function refreshInputNames(cb) {
  if (Date.now() - lastInputScan < 60000 && Object.keys(inputNameMap).length > 0) {
    if (cb) cb(inputNameMap);
    return;
  }
  luna('com.webos.service.eim/getAllInputStatus', {}, function (res) {
    if (res && res.devices && res.devices.length) {
      for (var i = 0; i < res.devices.length; i++) {
        var d = res.devices[i];
        if (d.appId && d.label) {
          var shortId = String(d.appId).replace('com.webos.app.', '');
          inputNameMap[shortId] = d.label;
        }
      }
      lastInputScan = Date.now();
    }
    if (cb) cb(inputNameMap);
  });
}

var TOAST_SOURCE = 'com.webos.app.home';

/* luna-send wrapper via execFile directly, avoiding /bin/sh and shell child leaks.
 * -w 2000 tells luna-send itself to time out after 2 seconds.
 * timeout: 3500 ensures Node kills the child process if it ever stalls.
 * appId, where given, becomes -a: a few services check the caller's registered
 * bus identity rather than anything in the payload, and reject everyone else
 * with "Unknown Source".
 */
function luna(uri, payload, cb, appId) {
  var args = appId ? ['-a', appId] : [];
  args = args.concat(['-n', '1', '-w', '2000', '-f', 'luna://' + uri, JSON.stringify(payload || {})]);
  execFile('/usr/bin/luna-send', args, { timeout: 3500 }, function (err, stdout) {
    var parsed = null;
    if (!err && stdout) {
      try { parsed = JSON.parse(stdout); } catch (e) {}
    }
    if (cb) cb(parsed, String(stdout || ''));
  });
}

/*
 * Cache for luna reads whose answers do not change between dashboard ticks.
 * Every luna() call is a fork+exec, and collectStats made ten of them per
 * collection at a 2s tick - roughly five forks a second with the dashboard
 * open. Node 0.12's spawn path can deadlock under that (see the watchdog note
 * in tvwebctl), so set-and-forget settings are now read once per TTL.
 *
 * Any successful control clears the lot, so a setting the user just changed is
 * never served from cache.
 */
var lunaCache = {};

function lunaCached(uri, payload, ttlMs, cb) {
  var key = uri + '|' + JSON.stringify(payload || {});
  var hit = lunaCache[key];
  if (hit && (Date.now() - hit.t < ttlMs)) return cb(hit.v, hit.raw);
  luna(uri, payload, function (parsed, raw) {
    // Only a real answer is worth pinning; a failed read should be retried.
    if (parsed) lunaCache[key] = { t: Date.now(), v: parsed, raw: raw };
    cb(parsed, raw);
  });
}

function clearLunaCache() { lunaCache = {}; }

function detectDeviceInfo(cb) {
  luna('com.webos.service.tv.systemproperty/getSystemProperties',
    { keys: ['modelName', 'firmwareVersion', 'boardType'] },
    function (res) {
      if (res && res.modelName) {
        if (!CONFIG.device.model || CONFIG.device.model === 'OLED65B8SLC' || CONFIG.device.model === 'webOS TV') {
          CONFIG.device.model = res.modelName;
        }
        if (!CONFIG.device.name || CONFIG.device.name === 'LG webOS TV' || CONFIG.device.name === 'LG OLED B8 TV') {
          CONFIG.device.name = 'LG ' + res.modelName;
        }
        if (res.firmwareVersion) {
          CONFIG.device.sw_version = res.firmwareVersion;
        }
        console.log('device detected: ' + (CONFIG.device.name || 'LG TV') + ' (model: ' + CONFIG.device.model + ') fw: ' + (res.firmwareVersion || '?'));
      }
      if (!CONFIG.device.name) CONFIG.device.name = 'LG webOS TV';
      if (!CONFIG.device.model) CONFIG.device.model = 'webOS TV';
      if (cb) cb();
    }
  );
}

var SOUND_OUTPUT_MAP = {
  tv_speaker: 'TV Speaker',
  external_arc: 'HDMI ARC',
  optical: 'Optical',
  headphone: 'Headphone / AUX',
  bt_soundbar: 'Bluetooth',
  lineout: 'Line Out',
  soundbar: 'LG Sound Sync'
};

function formatSoundOutput(so) {
  if (!so) return 'TV Speaker';
  return SOUND_OUTPUT_MAP[so] || so;
}

var installedApps = [];
var lastAppsScan = 0;

function refreshInstalledApps(cb) {
  var now = Date.now();
  if (installedApps.length > 0 && (now - lastAppsScan < 300000)) {
    if (cb) cb(installedApps);
    return;
  }
  luna('com.webos.applicationManager/listApps', {}, function (res) {
    if (res && Array.isArray(res.apps)) {
      var list = [];
      for (var i = 0; i < res.apps.length; i++) {
        var a = res.apps[i];
        if (a && a.id && a.visible !== false && a.id.indexOf('com.webos.app.container') !== 0) {
          list.push({
            id: a.id,
            title: a.title || a.id
          });
        }
      }
      list.sort(function (x, y) { return String(x.title || '').localeCompare(String(y.title || '')); });
      installedApps = list;
      lastAppsScan = Date.now();
    }
    if (cb) cb(installedApps);
  });
}

var ADBLOCK_HOSTS_FILE = '/var/lib/tvweb/adblock_hosts';
var ADBLOCK_FLAG_FILE = '/var/lib/tvweb/adblock_enabled';
var ADBLOCK_DOMAINS = [
  'ad.lgsmartad.com',
  'ibis.lgappstv.com',
  'ibs.lgappstv.com',
  'lgsmartad.com',
  'rdx.lgtvcommon.com',
  'aic.lgtvcommon.com',
  'aic-ngfts.lge.com',
  'ngfts.lge.com',
  'lgtvsdp.com',
  'us.lgtvsdp.com',
  'gb.lgtvsdp.com',
  'eu.lgtvsdp.com',
  'smartclip.com',
  'smartclip-services.com',
  'yumenetworks.com'
];

function isAdBlockActive() {
  try {
    var mounts = fs.readFileSync('/proc/mounts', 'utf8');
    return mounts.indexOf(' /etc/hosts ') !== -1;
  } catch (e) {
    return false;
  }
}

function setAdBlock(enable, cb) {
  var active = isAdBlockActive();
  if (enable && !active) {
    var lines = [
      '127.0.0.1\tlocalhost.localdomain\tlocalhost',
      '::1\tlocalhost ip6-localhost ip6-loopback',
      'fe00::0\tip6-localnet',
      'ff00::0\tip6-mcastprefix',
      'ff02::1\tip6-allnodes',
      'ff02::2\tip6-allrouters',
      '',
      '# LG Ad & Telemetry Blackhole (lg-webos-mqtt)'
    ];
    for (var i = 0; i < ADBLOCK_DOMAINS.length; i++) {
      lines.push('0.0.0.0\t' + ADBLOCK_DOMAINS[i]);
    }
    lines.push('');
    try {
      fs.writeFileSync(ADBLOCK_HOSTS_FILE, lines.join('\n'), 'utf8');
      fs.writeFileSync(ADBLOCK_FLAG_FILE, '1', 'utf8');
    } catch (e) {
      if (cb) cb({ ok: false, error: 'could not write adblock hosts: ' + e.message });
      return;
    }
    execFile('/bin/mount', ['--bind', ADBLOCK_HOSTS_FILE, '/etc/hosts'], { timeout: 3000 }, function (err) {
      cachedPrivacy = null;
      lastStats = null;
      if (cb) cb({ ok: !err, enabled: isAdBlockActive() });
    });
  } else if (!enable && active) {
    try {
      if (fs.existsSync(ADBLOCK_FLAG_FILE)) fs.unlinkSync(ADBLOCK_FLAG_FILE);
    } catch (e) {}
    execFile('/bin/umount', ['/etc/hosts'], { timeout: 3000 }, function (err) {
      cachedPrivacy = null;
      lastStats = null;
      if (cb) cb({ ok: !err, enabled: isAdBlockActive() });
    });
  } else {
    if (cb) cb({ ok: true, enabled: active });
  }
}

var RCU_KEY_CODES = {
  play: 207,
  pause: 201,
  playPause: 164,
  playpause: 164,
  stop: 128,
  fastForward: 208,
  fastforward: 208,
  rewind: 168
};

function sendMediaKey(cmd, cb) {
  var code = RCU_KEY_CODES[cmd];
  if (!code) {
    if (cb) cb(false);
    return;
  }
  var fd = null;
  try {
    fd = fs.openSync('/dev/input/event1', 'w');
  } catch (e) {
    if (cb) cb(false);
    return;
  }
  function makeEv(type, c, val) {
    var b = new Buffer(16);
    b.fill(0);
    b.writeUInt16LE(type, 8);
    b.writeUInt16LE(c, 10);
    b.writeInt32LE(val, 12);
    return b;
  }
  try {
    fs.writeSync(fd, makeEv(1, code, 1), 0, 16, null);
    fs.writeSync(fd, makeEv(0, 0, 0), 0, 16, null);
    setTimeout(function () {
      try {
        fs.writeSync(fd, makeEv(1, code, 0), 0, 16, null);
        fs.writeSync(fd, makeEv(0, 0, 0), 0, 16, null);
        fs.closeSync(fd);
        if (cb) cb(true);
      } catch (e2) {
        if (cb) cb(false);
      }
    }, 50);
  } catch (e) {
    try { fs.closeSync(fd); } catch (e3) {}
    if (cb) cb(false);
  }
}

// ---------------------------------------------------------------- stats
var cachedOled = null;
var lastOledCheck = 0;

/*
 * Not every webOS set is an OLED - LCD/QNED/NanoCell models run the same
 * firmware but have no panel-hours counter, no Off-RS compensation and no
 * Pixel Refresher. Detect once and omit the whole block rather than reporting
 * a confident 0 hours, which reads as a real measurement.
 *
 * The model name decides it: every LG OLED is named "OLED...". panelUsageTime
 * is not proof - some LCD firmware answers it anyway (seen on a 2016
 * 55UH6030), which is what used to turn those sets into false OLEDs - so it
 * only gets a say when the model name is unreadable. A "panel" in config.json
 * overrides the lot.
 */
var isOled = null;   // null = not yet determined

function detectOled(cb) {
  if (isOled !== null) return cb(isOled);

  var forced = CONFIG.panel || (CONFIG.device && CONFIG.device.panel);
  if (forced) {
    isOled = /oled/i.test(forced);
    console.log('panel: ' + (isOled ? 'OLED' : 'not OLED') + ' (from config)');
    return cb(isOled);
  }
  if (fs.existsSync('/var/luna/preferences/paneltype_oled')) {
    isOled = true;
    console.log('panel: OLED (paneltype_oled present)');
    return cb(true);
  }
  luna('com.webos.service.tv.systemproperty/getSystemProperties',
    { keys: ['panelUsageTime', 'modelName'] },
    function (res) {
      var model = (res && res.modelName) || (CONFIG.device && CONFIG.device.model) || '';
      if (model) {
        isOled = /oled/i.test(model);
        console.log('panel: ' + (isOled ? 'OLED' : 'not OLED - panel features disabled') +
                    ' (model ' + model + ')');
      } else {
        isOled = !!(res && res.panelUsageTime);
        console.log('panel: no model name; falling back to panelUsageTime -> ' +
                    (isOled ? 'OLED' : 'not OLED - panel features disabled'));
      }
      cb(isOled);
    });
}

function refreshOledStats(picSettings, cb) {
  var now = Date.now();
  if (cachedOled && (now - lastOledCheck < 30000)) {
    if (picSettings) {
      if (picSettings.screenShift) cachedOled.screen_shift = picSettings.screenShift;
      if (picSettings.logoLuminanceAdjust) cachedOled.logo_dimming = picSettings.logoLuminanceAdjust;
    }
    return cb(cachedOled);
  }

  /*
   * Both of these are counters in PANEL HOURS, not the 10-minute units that
   * panelUsageTime uses - confirmed by autoOffRsTime tracking panelUsageTime/6
   * almost exactly on a live set.
   */
  var autoPnwashRaw = rd('/mnt/lg/cmn_data/pnwash/autoPnwashTime');
  var lastRefresher = autoPnwashRaw ? parseInt(autoPnwashRaw, 10) : 0;

  /*
   * Short Off-RS compensation interval. The file reads 24 on this set, which
   * is NOT 24 hours: it is expressed in the same 10-minute units as
   * panelUsageTime and lastCompensationTimestamp, the counters it gets
   * compared against. 24 * 10min = 4h, which is LG's documented cumulative
   * viewing cycle.
   *
   * Note the directory is not internally consistent - autoOffRsTime alongside
   * it IS in whole panel hours - so do not "simplify" this by assuming one
   * unit throughout.
   */
  var compIntervalRaw = rd('/mnt/lg/cmn_data/pnwash/autoOffRsIntervalHomeMode');
  var compIntervalUnits = parseInt(compIntervalRaw, 10);
  if (!compIntervalUnits || compIntervalUnits <= 0) compIntervalUnits = 24;
  var compInterval = Math.round((compIntervalUnits * 10 / 60) * 10) / 10;
  // Guard against a value in an unexpected unit producing a nonsense countdown.
  if (compInterval < 0.5 || compInterval > 24) compInterval = 4;

  /* Deep Pixel Refresher ("Panel Wash") cadence. Not exposed anywhere on the
     set, so it stays an assumption - named rather than buried in an expression. */
  var REFRESHER_INTERVAL_HOURS = 2000;

  luna('com.webos.service.tv.systemproperty/getSystemProperties',
    { keys: ['panelUsageTime', 'lastCompensationTimestamp'] },
    function (sysRes) {
      var usageUnits = (sysRes && sysRes.panelUsageTime) ? parseInt(sysRes.panelUsageTime, 10) : null;
      var lastCompUnits = (sysRes && sysRes.lastCompensationTimestamp) ? parseInt(sysRes.lastCompensationTimestamp, 10) : null;

      luna('com.webos.service.tv.display/getClearPanelNoiseStatus', {}, function (dispRes) {
        var rawStatus = (dispRes && dispRes.status) ? dispRes.status : 'schedule';
        var statusStr = 'Idle';
        if (rawStatus === 'cancel_schedule') statusStr = 'Scheduled';
        else if (rawStatus === 'processing') statusStr = 'Running';

        var panelHours = (usageUnits !== null) ? Math.floor(usageUnits / 6) : 0;
        var panelHoursExact = (usageUnits !== null) ? Math.round((usageUnits * 10 / 60) * 10) / 10 : 0;

        var lastCompHours = (lastCompUnits !== null) ? Math.round((lastCompUnits * 10 / 60) * 10) / 10 : 0;
        var hoursSinceComp = (usageUnits !== null && lastCompUnits !== null) ?
          Math.round(((usageUnits - lastCompUnits) * 10 / 60) * 10) / 10 : 0;
        var hoursUntilComp = Math.max(0, Math.round((compInterval - hoursSinceComp) * 10) / 10);

        var hoursSinceRefresher = (panelHours && lastRefresher) ? Math.max(0, panelHours - lastRefresher) : 0;
        var hoursUntilRefresher = Math.max(0, REFRESHER_INTERVAL_HOURS - hoursSinceRefresher);

        cachedOled = {
          panel_hours: panelHours,
          panel_hours_exact: panelHoursExact,
          last_compensation_hours: lastCompHours,
          hours_since_comp: hoursSinceComp,
          hours_until_comp: hoursUntilComp,
          comp_interval_hours: compInterval,
          comp_interval_units: compIntervalUnits,
          refresher_interval_hours: REFRESHER_INTERVAL_HOURS,
          last_refresher_hours: lastRefresher,
          hours_since_refresher: hoursSinceRefresher,
          hours_until_refresher: hoursUntilRefresher,
          refresher_status: statusStr,
          refresher_status_raw: rawStatus,
          screen_shift: (picSettings && picSettings.screenShift) ? picSettings.screenShift : 'off',
          logo_dimming: (picSettings && picSettings.logoLuminanceAdjust) ? picSettings.logoLuminanceAdjust : 'off'
        };
        lastOledCheck = Date.now();
        cb(cachedOled);
      });
    }
  );
}

var prevNet = null;
/* Short server-side history of SoC temperature. The dashboard's trace would
   otherwise start empty on every load and take minutes to say anything. */
var TEMP_HISTORY_MAX = 120;
var tempHistory = [];
function pushTemp(t) {
  if (typeof t !== 'number' || isNaN(t) || t <= 0) return;   // 0 = sensor not ready
  tempHistory.push(t);
  if (tempHistory.length > TEMP_HISTORY_MAX) tempHistory.shift();
}
var lastStats = null;
var lastStatsTime = 0;
var isCollecting = false;
var statsWaiters = [];

function collectStats(cb) {
  var now = Date.now();
  // Return cached result if fresh (< 1.5 seconds old)
  if (lastStats && (now - lastStatsTime < 1500)) {
    return cb(lastStats);
  }

  // Queue callback and serialize execution
  statsWaiters.push(cb);
  if (isCollecting) return;
  isCollecting = true;

  var safetyTimeout = setTimeout(function () {
    if (isCollecting) {
      console.log('warning: stats collection safety timeout reached');
      flushStats(lastStats || { ok: false, error: 'timeout' });
    }
  }, 4500);

  function flushStats(result) {
    clearTimeout(safetyTimeout);
    lastStats = result;
    lastStatsTime = Date.now();
    isCollecting = false;
    var waiters = statsWaiters.slice(0);
    statsWaiters = [];
    for (var w = 0; w < waiters.length; w++) {
      try { waiters[w](result); } catch (e) {}
    }
  }

  var mi = meminfo();
  var status = rd('/proc/lg/pm/status') || '';
  var coreMatch = status.match(/load:\s*([\d\s]+)/);
  var cpuAvsMatch = status.match(/cpuavs_current\(mA\):\s*(\d+)/);
  var coreAvsMatch = status.match(/coreavs_current\(mA\):\s*(\d+)/);
  var cpuMa = cpuAvsMatch ? parseInt(cpuAvsMatch[1], 10) : null;
  var coreMa = coreAvsMatch ? parseInt(coreAvsMatch[1], 10) : null;
  var totalMa = (cpuMa !== null && coreMa !== null) ? (cpuMa + coreMa) : null;

  var n = netBytes();
  var rate = null;
  if (n && prevNet && n.t > prevNet.t && n.rx >= prevNet.rx) {
    var dt = (n.t - prevNet.t) / 1000;
    rate = { rx: Math.round((n.rx - prevNet.rx) / dt), tx: Math.round((n.tx - prevNet.tx) / dt) };
  }
  if (n) prevNet = n;

  var out = {
    ok: true,
    time: Date.now(),
    device: {
      id: CONFIG.device.id || 'lg_tv',
      name: CONFIG.device.name || 'LG webOS TV',
      model: CONFIG.device.model || 'webOS TV'
    },
    /*
     * The thermal sensor is not populated immediately after boot: for roughly
     * the first 80 seconds /proc/lg/pm/temperature reads a literal 0, which is
     * not a measurement. Reporting it would put a false 0C spike into Home
     * Assistant's history on every reboot, so treat 0 as "not ready yet".
     */
    temp: (function () {
      var t = num(rd('/proc/lg/pm/temperature'), null);
      // Anything <= 0 is the sensor not being ready, not a reading. Matches the
      // guard in pushTemp, so the reported value and the history agree.
      return (t !== null && t > 0) ? t : null;
    })(),
    temps: null,   // filled in below from the ring buffer
    load: num(rd('/proc/lg/pm/current_load'), null),
    mhz: Math.round(num(rd('/proc/lg/pm/frequency'), 0) / 1000),
    cores: coreMatch ? coreMatch[1].trim().split(/\s+/).map(Number) : [],
    mem: { total: mi.MemTotal || 0, avail: mi.MemAvailable || 0 },
    swap: { total: mi.SwapTotal || 0, free: mi.SwapFree || 0 },
    uptime: Math.floor(parseFloat(rd('/proc/uptime') || '0')),
    loadavg: (rd('/proc/loadavg') || '').split(' ').slice(0, 3),
    wifi: wifi(),
    net: rate,
    emmc: emmcInfo(),
    signal: getVideoSignal(),
    power: {
      cpu_ma: cpuMa,
      core_ma: coreMa,
      current_ma: totalMa
    },
    inputs: inputNameMap
  };

  pushTemp(out.temp);   // pushTemp already ignores non-numbers
  out.temps = tempHistory.slice();

  // Refresh input names if cache expired
  refreshInputNames();

  // Chained Luna queries: power -> sound -> soundSettings -> foregroundApp -> picture settings -> apps
  luna('com.webos.service.tvpower/power/getPowerState', {}, function (pw) {
    out.powerState = mapPowerState(pw && pw.state);
  lunaCached('com.webos.service.settings/getSystemSettings',
       { category: 'time', keys: ['sleepTimer'] }, 30000, function (tm) {
    out.sleepTimer = (tm && tm.settings && tm.settings.sleepTimer) || 'off';
  lunaCached('com.webos.service.settings/getSystemSettings',
       { category: 'option', keys: ['standByLight', 'logoLight', 'powerOnLight'] }, 60000, function (op) {
    var os = (op && op.settings) || {};
    out.lights = {
      standby: os.standByLight === 'on',
      logo: os.logoLight === 'on',
      powerOn: os.powerOnLight === 'on',
      hasLogo: hasLogoLight === true
    };
    out.gpuMhz = gpuClockMhz();
  lunaCached('com.palm.connectionmanager/getStatus', {}, 60000, function (cm) {
    // Network name, so the Wi-Fi figures say which network they refer to.
    var w = cm && cm.wifi;
    out.ssid = (w && w.ssid) ? w.ssid : null;
  lunaCached('com.webos.service.tv.display/getDimmingStatus', {}, 15000, function (dim) {
    // ABL / logo dimming activity. OLED only in practice.
    out.dimming = (dim && dim.status) || null;
  lunaCached('com.webos.service.tv.display/getLightSensorData', {}, 30000, function (ls) {
    /*
     * Ambient light sensor. Not every set has one: a model without it still
     * answers, reporting 65535 (0xFFFF) for every channel. Treat that as
     * absent rather than publishing a nonsense lux figure.
     */
    var lux = null, sd = (ls && ls.sensorData) || [];
    for (var li = 0; li < sd.length; li++) {
      if (sd[li].property === 'visibleLuminance' || sd[li].property === 'luminance') {
        if (sd[li].value !== 65535 && sd[li].value !== null) lux = sd[li].value;
      }
    }
    out.lightSensor = (lux === null) ? null : { lux: lux };
    if (out.lightSensor) hasLightSensor = true;
    out.backlight = (ls && typeof ls.backlightValue === 'number') ? ls.backlightValue : null;
  appStorage(function (st) {
    out.appStorage = st;
  lunaCached('com.webos.audio/getSoundOut', {}, 10000, function (sound) {
    if (sound) {
      out.volume = sound.volume;
      out.muted = !!sound.muted;
      out.audio_output = sound.scenario || 'internal';
    }
    lunaCached('com.webos.service.settings/getSystemSettings',
      { category: 'sound', keys: ['soundOutput', 'soundMode'] }, 15000,
      function (snd) {
        var rawSnd = (snd && snd.settings && snd.settings.soundOutput) ? snd.settings.soundOutput : (sound && sound.scenario ? sound.scenario : 'tv_speaker');
        out.sound = {
          output: formatSoundOutput(rawSnd),
          output_raw: rawSnd,
          mode: (snd && snd.settings && snd.settings.soundMode) || 'standard'
        };
        lunaCached('com.webos.applicationManager/getForegroundAppInfo', {}, 4000, function (app) {
          if (app && app.appId) {
            var shortApp = String(app.appId).replace('com.webos.app.', '');
            out.app = shortApp;
            out.app_name = inputNameMap[shortApp] || shortApp;
            out.display_title = (inputNameMap[shortApp] && inputNameMap[shortApp] !== shortApp) ?
              (inputNameMap[shortApp] + ' (' + shortApp.toUpperCase() + ')') : shortApp;
          }
          lunaCached('com.webos.service.settings/getSystemSettings',
            { category: 'picture', keys: ['backlight', 'pictureMode', 'energySaving', 'screenShift', 'logoLuminanceAdjust'] },
            10000, function (pic) {
              if (pic && pic.settings) {
                var rawDr = (pic.dimension && pic.dimension.dynamicRange) ? pic.dimension.dynamicRange : 'sdr';
                out.picture = {
                  dynamicRange: formatDynamicRange(rawDr),
                  mode: formatPicMode(pic.settings.pictureMode),
                  mode_raw: pic.settings.pictureMode || 'standard',
                  backlight: num(pic.settings.backlight, 50),
                  energySaving: pic.settings.energySaving || 'off',
                  screenShift: pic.settings.screenShift || 'off',
                  logoLuminanceAdjust: pic.settings.logoLuminanceAdjust || 'off',
                  modes: []
                };
              }
              pictureModes(function (modes) {
              if (out.picture) out.picture.modes = modes;
              refreshInstalledApps(function (apps) {
                out.apps = apps || [];
                out.privacy = {
                  adblock: {
                    enabled: isAdBlockActive(),
                    count: ADBLOCK_DOMAINS.length
                  }
                };
                detectOled(function (oledPanel) {
                  /* webOS 3.x exposes no thermal sensor at all: the file simply
                     does not exist, /sys/class/thermal is empty and there is no
                     hwmon. That is different from the ~80s post-boot window where
                     the file exists but reads 0, so report it as a capability and
                     let the UI say "none" rather than imply a pending reading. */
                  out.capabilities = { oled: oledPanel, thermal: THERMAL_PRESENT,
                                       emmcWear: EMMC_WEAR_PRESENT };
                  if (!oledPanel) {
                    out.oled = null;
                    return flushStats(out);
                  }
                  refreshOledStats((pic && pic.settings) ? pic.settings : null, function (oled) {
                    out.oled = oled;
                    flushStats(out);
                  });
                });
              });
              });
            }
          );
        });
      }
    );
  });
  });   // close appStorage
  });   // close connectionmanager
  });   // close light sensor
  });   // close dimming
  });   // close option settings
  });   // close time settings
  });   // close getPowerState
}

// ---------------------------------------------------------------- processes
/*
 * Read-only process list, loaded on demand rather than folded into the
 * telemetry payload - it answers "what is using the memory" when someone
 * looks, and there is no reason to publish it to MQTT every ten seconds.
 *
 * Deliberately no kill action. Closing a stuck app is what closeByAppId is
 * for, which lets the app manager tear down cleanly; most of these respawn
 * anyway, and surface-manager is the compositor.
 */
/*
 * A readable name for a process, from its argv.
 *
 * comm is not enough: the kernel caps it at 15 characters, so every LG app
 * arrived as "com.webos.app.i" whatever it really was.
 *
 * WebAppMgr needs more than a basename. It is webOS's Chromium, and Chromium
 * runs one process per role from a single binary - so a TV with four web apps
 * warm shows five identical rows called WebAppMgr, which reads as something
 * gone wrong rather than as the browser doing its job. The role is in --type,
 * absent for the browser process itself, and a renderer that loads an app's
 * V8 snapshot names the app in the path.
 */
function procName(comm, args) {
  var bin = String(args).split(/\s+/)[0].replace(/^.*\//, '');

  if (bin === 'WebAppMgr') {
    var app = args.match(/\/usr\/palm\/applications\/([^\/\s]+)/);
    if (app) return 'WebAppMgr (' + app[1].replace(/^com\.webos\.app\./, '') + ')';
    var type = args.match(/--type=(\w+)/);
    return 'WebAppMgr (' + (type ? type[1] : 'browser') + ')';
  }

  /*
   * Neither field is reliable on its own. comm is the name the process chose,
   * but the kernel caps it at 15 characters. argv[0] is complete but is
   * sometimes not a name at all - the broadcast service runs
   * /mnt/lg/lgapp/RELEASE and calls itself tvservice.
   *
   * So: comm unless it is exactly at the cap, which is what a clipped name
   * looks like, and then argv[0] to recover the rest of it.
   */
  return (comm && comm.length < 15) ? comm : (bin || comm);
}

function collectProcesses(cb) {
  execFile('/bin/ps', ['-eo', 'rss,comm,args'], { timeout: 4000, maxBuffer: 1024 * 1024 }, function (err, stdout) {
    if (err) return cb({ ok: false, error: 'could not read process list' });
    var lines = String(stdout || '').split('\n'), rows = [], total = 0, count = 0;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s*(\d+)\s+(\S+)\s+(\S.*?)\s*$/);
      if (!m) continue;
      var rss = parseInt(m[1], 10);
      count++;
      total += rss;
      rows.push({ name: procName(m[2], m[3]), mb: Math.round(rss / 1024 * 10) / 10 });
    }
    rows.sort(function (a, b) { return b.mb - a.mb; });
    cb({
      ok: true,
      count: count,
      totalMb: Math.round(total / 1024),
      top: rows.slice(0, 10)
    });
  });
}

// ---------------------------------------------------------------- hdmi / misc
/*
 * GPU clock. /proc/lg/sys/status carries the PLL outputs in Hz.
 */
function gpuClockMhz() {
  var raw = rd('/proc/lg/sys/status');
  if (!raw) return null;
  var m = raw.match(/gpu pll out\s*:\s*(\d+)/i);
  return m ? Math.round(parseInt(m[1], 10) / 1000000) : null;
}

/*
 * App storage. Separate partition from cmn_data, and the one that actually
 * fills up and makes installs fail.
 */
function appStorage(cb) {
  execFile('/bin/df', ['-k', '/mnt/lg/appstore'], { timeout: 4000 }, function (err, stdout) {
    if (err) return cb(null);
    var lines = String(stdout || '').trim().split('\n');
    var f = (lines[lines.length - 1] || '').split(/\s+/);
    if (f.length < 4) return cb(null);
    var total = parseInt(f[1], 10), used = parseInt(f[2], 10), avail = parseInt(f[3], 10);
    if (!total) return cb(null);
    cb({ totalMb: Math.round(total / 1024), usedMb: Math.round(used / 1024),
         freeMb: Math.round(avail / 1024), pct: Math.round(used / total * 100) });
  });
}

/*
 * HDMI PHY state, straight off the receiver. Loaded on demand rather than in
 * telemetry: four ports of timing detail is a lot to publish every ten seconds
 * and it only matters when someone is looking at it.
 *
 * The PHY nodes are port0..port3 while the TV numbers its inputs HDMI 1..4,
 * and the obvious port+1 mapping is wrong: on a set whose only live input is
 * HDMI 2 (eim reports activate/chosen true, a CEC device present, everything
 * else empty) the port carrying signal is port2, not port1. There is no
 * hotplug or EDID field to pin the rest of the mapping down, so this does not
 * guess. Ports are reported as-is, and the input the TV says is active is
 * matched to the one port carrying signal when exactly one of each exists.
 */
function hdmiPorts() {
  var ports = [];
  for (var i = 0; i < 4; i++) {
    var raw = rd('/proc/lg/hdmi20/port' + i + '/status');
    if (!raw) continue;
    function f(re) { var m = raw.match(re); return m ? m[1].trim() : null; }
    var hact = parseInt(f(/horizontal-active:\s*(\d+)/) || '0', 10);
    var vact = parseInt(f(/vertical-active:\s*(\d+)/) || '0', 10);
    /*
     * Refresh rate comes from pixel-clock-V, not the field labelled
     * refresh-rate: that reports 793 "(0.01Hz)" on a 4K60 source. pixel-clock-V
     * reads 60 and checks out against the timings.
     */
    var rate = parseInt(f(/pixel-clock-V:\s*(\d+)/) || '0', 10);
    var pclk = parseInt(f(/pixel-clock:\s*(\d+)/) || '0', 10);
    ports.push({
      port: i,
      connected: /connected:\s*on/i.test(raw),
      resolution: (hact && vact) ? (hact + 'x' + vact) : null,
      refreshHz: rate || null,
      pixelClockMhz: pclk ? Math.round(pclk / 1000 * 10) / 10 : null,
      colorDepth: f(/deep-color-mode:\s*(\S+ \S+)/),
      interlaced: /interlaced:\s*yes/i.test(raw)
    });
  }
  return ports;
}

/*
 * Inputs as the TV describes them, with the live PHY figures attached to the
 * active one. The labels are the TV's own, so a renamed input reads "Apple TV"
 * rather than a port number this code guessed at.
 */
function hdmiInputs(cb) {
  luna('com.webos.service.eim/getAllInputStatus', {}, function (res) {
    var devs = (res && res.devices) || [];
    var ports = hdmiPorts();
    var signalling = [];
    for (var p = 0; p < ports.length; p++) if (ports[p].connected) signalling.push(ports[p]);

    var inputs = [];
    var activeIdx = -1;
    for (var d = 0; d < devs.length; d++) {
      if (!devs[d].id || String(devs[d].id).indexOf('HDMI') !== 0) continue;
      if (devs[d].activate) activeIdx = inputs.length;
      inputs.push({
        id: devs[d].id,
        port: devs[d].port,
        label: devs[d].label || devs[d].id,
        appId: devs[d].appId,
        active: !!devs[d].activate,
        // lastUniqueId 255 means nothing has ever identified itself over CEC
        deviceSeen: devs[d].lastUniqueId !== undefined && devs[d].lastUniqueId !== 255,
        signal: null
      });
    }
    // Only claim a pairing when it is unambiguous.
    if (activeIdx !== -1 && signalling.length === 1) {
      inputs[activeIdx].signal = signalling[0];
    }
    cb({ ok: true, inputs: inputs, ports: ports, pairedUnambiguously: (activeIdx !== -1 && signalling.length === 1) });
  });
}

// ---------------------------------------------------------------- privacy
/*
 * Read-only view of LG's data collection, plus the two changes the platform
 * itself offers an API for.
 *
 * The consent flags live in /var/luna/preferences/eula. There is no Luna
 * setter for them - the Settings UI writes that file directly - so this
 * REPORTS them and does not attempt to change them. Turning them off is done
 * in the TV's own menus (General > About This TV > User Agreements).
 *
 * The two actions here are genuine Luna calls, not file edits: rotating the
 * advertising identifier and clearing ad cookies.
 *
 * Labels are deliberately plain. "ACR" and "LMT" mean nothing to most people,
 * so the UI is given a description for every row rather than an acronym.
 */

// Only flags whose meaning is actually known are described. Anything else is
// surfaced under its raw name rather than given an invented explanation.
var CONSENT_LABELS = {
  acrAllowed:              ['Screen content recognition', 'Lets LG identify what is on your screen to profile your viewing'],
  acrGdprAllowed:          ['Screen recognition (GDPR consent)', 'The EU consent record for screen content recognition'],
  acrAdAllowed:            ['Ads based on what you watch', 'Uses recognised screen content to target advertising'],
  customAdAllowed:         ['Personalised advertising', 'Tailors the ads shown on your TV to you'],
  customadsAllowed:        ['Personalised advertising (secondary flag)', 'A second personalised-advertising consent record'],
  cookiesAllowed:          ['Advertising cookies', 'Stores cookies used for ad tracking'],
  thirdPartySharingAllowed:['Sharing your data with other companies', 'Passes your usage data to third parties'],
  additionalDataAllowed:   ['Additional usage data', 'Extra analytics beyond what the TV needs to work'],
  remoteDiagAllowed:       ['Remote diagnostics upload', 'Lets LG collect and upload diagnostic reports from your TV'],
  voiceAllowed:            ['Voice recordings', 'Allows voice data to be collected and processed'],
  voice2Allowed:           ['Voice recordings (secondary flag)', 'A second voice-data consent record']
};

// Daemons worth naming, with what they actually do.
var PRIVACY_DAEMONS = {
  acr2:       ['Content recognition service', 'Identifies what is on screen'],
  admanager:  ['Advertising service', 'Fetches and displays ads on the TV'],
  uploadd:    ['Diagnostics uploader', 'Sends diagnostic data to LG'],
  rdxd:       ['Diagnostics collector', 'Gathers crash and diagnostic reports']
};

/*
 * Power state. tvpower reports the panel separately from the system: a set can
 * be "Active" with the screen lit, or "ScreenOff" with the system running and
 * the panel blanked - which is exactly what the Screen Off control does. The
 * dashboard previously showed neither, so blanking the panel changed nothing
 * on screen and the source kept reading as though something were displayed.
 */
var POWER_STATES = {
  'active':        ['On', true,  true],
  'screenoff':     ['Screen off', true,  false],
  'activestandby': ['Standby', false, false],
  'suspend':       ['Standby', false, false],
  'poweroff':      ['Off', false, false],
  'prepared':      ['Starting up', true, false]
};

function mapPowerState(raw) {
  var key = String(raw || '').toLowerCase().replace(/[\s_-]/g, '');
  var m = POWER_STATES[key];
  if (m) return { raw: raw, label: m[0], systemOn: m[1], screenOn: m[2] };
  // Unknown state: report it verbatim rather than guessing at a friendly name.
  return { raw: raw || null, label: raw || 'Unknown', systemOn: true, screenOn: true };
}

var cachedPrivacy = null, lastPrivacyCheck = 0;

function readConsentFlags() {
  var raw = rd('/var/luna/preferences/eula');
  if (!raw) return null;
  var out = { known: [], other: [] };
  var re = /"([a-zA-Z0-9_]+Allowed)"\s*:\s*(true|false)/g, m;
  while ((m = re.exec(raw)) !== null) {
    var key = m[1], on = m[2] === 'true';
    if (CONSENT_LABELS[key]) {
      out.known.push({ key: key, label: CONSENT_LABELS[key][0], detail: CONSENT_LABELS[key][1], enabled: on });
    } else {
      out.other.push({ key: key, enabled: on });
    }
  }
  return out;
}

function runningDaemons(cb) {
  execFile('/bin/ps', ['-eo', 'args'], { timeout: 4000 }, function (err, stdout) {
    var txt = String(stdout || ''), list = [];
    for (var name in PRIVACY_DAEMONS) {
      if (!PRIVACY_DAEMONS.hasOwnProperty(name)) continue;
      list.push({
        name: name,
        label: PRIVACY_DAEMONS[name][0],
        detail: PRIVACY_DAEMONS[name][1],
        running: txt.indexOf('/usr/sbin/' + name) !== -1
      });
    }
    cb(list);
  });
}

function collectPrivacy(cb) {
  var now = Date.now();
  if (cachedPrivacy && (now - lastPrivacyCheck < 20000)) return cb(cachedPrivacy);

  var out = { ok: true, consent: readConsentFlags() };

  luna('com.webos.service.acr/getACRSolutionStatus', {}, function (acr) {
    // `false` here means the recognition engine is not running at all.
    out.acr = {
      label: 'Screen content recognition',
      detail: 'LG calls this ACR. It samples what is on screen to work out what you are watching.',
      active: !!(acr && acr.ACRSolutionStatus)
    };
    luna('com.webos.service.acr/getVideoCaptureStatus', {}, function (cap) {
      out.acr.capturing = !!(cap && cap.status && cap.status !== 'stopped');
      out.acr.captureState = (cap && cap.status) ? cap.status : 'unknown';
      luna('com.webos.service.admanager/getAdid', {}, function (ad) {
        var id = (ad && ad.IFA) ? String(ad.IFA) : null;
        out.advertisingId = {
          label: 'Advertising identifier',
          detail: 'A unique ID your TV hands to advertisers. Resetting it breaks the link to your past activity.',
          /*
           * The value is deliberately NOT returned, not even truncated. It is
           * an identifier for this household, and the dashboard is the sort of
           * thing that ends up in screenshots. Whether a reset worked is
           * reported by the reset action itself, which compares before and
           * after on the TV without either value leaving it.
           */
          present: !!id,
          limitTracking: !!(ad && String(ad.LMT).toLowerCase() === 'on'),
          limitTrackingLabel: 'Limit ad tracking',
          limitTrackingDetail: 'When on, apps are asked not to use this ID to profile you.'
        };
        runningDaemons(function (daemons) {
          out.daemons = daemons;
          out.adblock = {
            enabled: isAdBlockActive(),
            count: ADBLOCK_DOMAINS.length
          };
          cachedPrivacy = out;
          lastPrivacyCheck = Date.now();
          cb(out);
        });
      });
    });
  });
}

// ---------------------------------------------------------------- controls
var INPUTS = { hdmi1: 1, hdmi2: 1, hdmi3: 1, hdmi4: 1, livetv: 1 };

// Verified against the settings service: 15 is rejected, 10 and 90 are not.
// Set from collectStats: sets without the hardware report 65535 and get null.
var hasLightSensor = false;

/*
 * Front-panel lights. The "option" settings category carries standByLight,
 * logoLight and powerOnLight on every set, whether or not the hardware is
 * fitted - tv.model.logoLight is the capability flag, and reads false on a
 * B8, which has only a standby LED. Ask the model, not the setting.
 */
var hasLogoLight = null;   // null = not yet determined

function detectLogoLight(cb) {
  if (hasLogoLight !== null) return cb(hasLogoLight);
  luna('com.webos.service.config/getConfigs',
    { configNames: ['tv.model.logoLight'] },
    function (res) {
      var v = res && res.configs && res.configs['tv.model.logoLight'];
      // Absent means the model does not declare it; treat that as no hardware.
      hasLogoLight = (v === true);
      console.log('front lights: standby LED' + (hasLogoLight ? ' + logo light' : ' only (no logo light on this model)'));
      cb(hasLogoLight);
    });
}

var SLEEP_TIMER_VALUES = ['off', '10', '30', '60', '90', '120'];

function doControl(action, value, cb) {
  if (!CONFIG.allowControl) return cb({ ok: false, error: 'controls disabled in config' });

  var origCb = cb;
  cb = function (r) {
    if (r && r.ok) { lastStats = null; clearLunaCache(); }
    origCb(r);
  };

  switch (action) {
    case 'volume':
      return luna('com.webos.audio/setVolume',
                  { volume: Math.max(0, Math.min(100, num(value, 10))) },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'volumeStep':
      var step = num(value, 1);
      if (step === 1) {
        return luna('com.webos.audio/volumeUp', {}, function (r) { cb({ ok: !!(r && r.returnValue) }); });
      }
      if (step === -1) {
        return luna('com.webos.audio/volumeDown', {}, function (r) { cb({ ok: !!(r && r.returnValue) }); });
      }
      return luna('com.webos.audio/getVolume', {}, function (cur) {
        var curVol = (cur && typeof cur.volume === 'number') ? cur.volume : 10;
        var target = Math.max(0, Math.min(100, curVol + step));
        luna('com.webos.audio/setVolume', { volume: target }, function (r) {
          cb({ ok: !!(r && r.returnValue) });
        });
      });

    case 'mute':
      var shouldMute = (value === 'true' || value === true || value === 'ON' || value === '1' || value === 1);
      return luna('com.webos.audio/setMuted',
                  { muted: shouldMute },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'screenOff':   // OLED: blank the panel, keep audio playing
      return luna('com.webos.service.tvpower/power/turnOffScreen', {},
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'screenOn':
      return luna('com.webos.service.tvpower/power/turnOnScreen', {},
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'input':
      if (!INPUTS[value]) return cb({ ok: false, error: 'unknown input' });
      return luna('com.webos.applicationManager/launch',
                  { id: 'com.webos.app.' + value },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'launch_app':
    case 'launchApp':
      var appId = String(value || '').trim();
      if (!appId) return cb({ ok: false, error: 'missing app id' });
      return luna('com.webos.applicationManager/launch', { id: appId }, function (r) {
        cb({ ok: !!(r && r.returnValue) });
      });

    case 'close_app':
    case 'closeApp':
      var appIdToClose = String(value || '').trim();
      if (!appIdToClose) return cb({ ok: false, error: 'missing app id' });
      return luna('com.webos.applicationManager/closeByAppId', { id: appIdToClose }, function (r) {
        cb({ ok: !!(r && r.returnValue) });
      });

    case 'picture_mode':
    case 'pictureMode':
      var pMode = String(value || '').trim();
      if (!pMode) return cb({ ok: false, error: 'missing picture mode' });
      return luna('com.webos.service.settings/getSystemSettings', { category: 'picture', keys: ['pictureMode'] }, function (cur) {
        var pPayload = { category: 'picture', settings: { pictureMode: pMode } };
        if (cur && cur.dimension) pPayload.dimension = cur.dimension;
        luna('com.webos.service.settings/setSystemSettings', pPayload, function (r) {
          cb({ ok: !!(r && r.returnValue) });
        });
      });

    case 'sound_output':
    case 'soundOutput':
      var sOut = String(value || '').trim();
      if (!sOut) return cb({ ok: false, error: 'missing sound output' });
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'sound', settings: { soundOutput: sOut } },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'playback':
    case 'media':
      return sendMediaKey(value, function (ok) {
        cb({ ok: ok });
      });

    case 'adblock':
    case 'setAdBlock':
    case 'toggleAdBlock':
      var enableBlock;
      if (action === 'toggleAdBlock' || value === 'toggle') {
        enableBlock = !isAdBlockActive();
      } else {
        enableBlock = (value === true || value === 'ON' || value === 'true' || value === 1);
      }
      return setAdBlock(enableBlock, function (res) {
        cb(res);
      });

    /*
     * Rotate the advertising identifier. A real Luna call, not a file edit -
     * this is the same reset the TV's own menus perform.
     */
    case 'resetAdId':
      // Read before and after so the UI can say whether it actually changed,
      // without either identifier being sent anywhere.
      return luna('com.webos.service.admanager/getAdid', {}, function (before) {
        var was = (before && before.IFA) ? String(before.IFA) : null;
        luna('com.webos.service.admanager/resetIFA', {}, function (r) {
          luna('com.webos.service.admanager/getAdid', {}, function (after) {
            var now = (after && after.IFA) ? String(after.IFA) : null;
            cachedPrivacy = null;
            cb({
              ok: !!(r && r.returnValue !== false),
              changed: !!(was && now && was !== now)
            });
          });
        });
      });

    case 'clearAdCookies':
      return luna('com.webos.service.admanager/inactivateCookies', {}, function (r) {
        cachedPrivacy = null;
        cb({ ok: !!(r && r.returnValue !== false) });
      });

    /*
     * Sleep timer. Accepted values are off, 10, 30, 60, 90, 120 - 15 is
     * rejected by the settings service despite being an obvious guess.
     */
    case 'sleepTimer':
      var st = String(value == null ? 'off' : value).trim();
      if (SLEEP_TIMER_VALUES.indexOf(st) === -1) {
        return cb({ ok: false, error: 'sleep timer must be one of ' + SLEEP_TIMER_VALUES.join(', ') });
      }
      return luna('com.webos.service.settings/setSystemSettings',
                  { category: 'time', settings: { sleepTimer: st } },
                  function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });

    // Front panel LEDs. Both live in the "option" category.
    case 'standbyLight':
    case 'logoLight':
      var lightKey = (action === 'standbyLight') ? 'standByLight' : 'logoLight';
      var lightOn = (value === true || value === 'on' || value === 'ON' || value === 'true');
      var lightPayload = { category: 'option', settings: {} };
      lightPayload.settings[lightKey] = lightOn ? 'on' : 'off';
      return luna('com.webos.service.settings/setSystemSettings', lightPayload,
                  function (r) { lastStats = null; cb({ ok: !!(r && r.returnValue) }); });

    case 'screensaver':
      /*
       * turnOnScreenSaver does not draw anything itself. tvpower asks whatever
       * has registered a screen saver request to show one - see its
       * registerScreenSaverRequest / responseScreenSaverRequest pair - and
       * returns true whether or not anything answers. An HDMI input or Live TV
       * registers nothing, because the screen saver exists to protect the panel
       * from a static image, not to interrupt video. So on those sources the
       * call reports success and nothing happens; say so instead.
       */
      return luna('com.webos.applicationManager/getForegroundAppInfo', {}, function (fg) {
        var fgId = (fg && fg.appId) ? String(fg.appId).replace('com.webos.app.', '') : '';
        if (/^hdmi[1-4]$/.test(fgId) || fgId === 'livetv') {
          return cb({ ok: false, error: 'the screen saver is only available from an app, not from ' + fgId });
        }
        luna('com.webos.service.tvpower/power/turnOnScreenSaver', {},
             function (r) { cb({ ok: !!(r && r.returnValue) }); });
      });

    case 'toast':
      /* Both the payload's sourceId and luna-send's -a have to name an app the
         bus already knows; "tvweb" is rejected as an Unknown Source. */
      return luna('com.webos.notification/createToast',
                  { sourceId: TOAST_SOURCE, message: String(value || 'hello').slice(0, 120) },
                  function (r) { cb({ ok: !!(r && r.returnValue), error: r && r.errorText }); },
                  TOAST_SOURCE);

    case 'powerOff':
      if (!CONFIG.allowPower) return cb({ ok: false, error: 'power actions disabled (set allowPower)' });
      return luna('com.webos.service.tvpower/power/powerOff', { reason: 'remoteKey' },
                  function (r) {
                    if (r && r.returnValue) return cb({ ok: true });
                    luna('com.webos.service.tvpower/power/powerOff', { reason: 'localKey' }, function (r2) {
                      cb({ ok: !!(r2 && r2.returnValue), error: (r2 && r2.errorText) || (r && r.errorText) });
                    });
                  });

    /*
     * Reboot deliberately does NOT go through tvpower.
     *
     * On webOS 4.4.3, luna://com.webos.service.tvpower/power/reboot accepts
     * the request and reports success, but the kernel never restarts: the set
     * drops off the network for about a minute and comes back with its uptime
     * still climbing. Measured on an OLED65B8SLC - 12810s before the call,
     * 12871s after. It behaves like a standby transition, not a reboot, so the
     * button was reporting success while doing something else entirely.
     *
     * /sbin/reboot performs a real orderly restart (verified: uptime reset to
     * 60s, services and the webosbrew boot hook all came back cleanly).
     *
     * Reply first - this process is about to go down with the system.
     */
    case 'reboot':
      if (!CONFIG.allowPower) return cb({ ok: false, error: 'power actions disabled (set allowPower)' });
      cb({ ok: true, note: 'rebooting' });
      return setTimeout(function () {
        execFile('/bin/sh', ['-c', 'sync; /sbin/reboot'], function () {});
      }, 400);

    case 'refresherSchedule':
      return luna('com.webos.service.tv.display/requestClearPanelNoise', { mode: 'schedule' },
                  function (r) {
                    lastOledCheck = 0;
                    lastStats = null;
                    cb({ ok: !!(r && r.returnValue) });
                  });

    case 'refresherCancel':
      return luna('com.webos.service.tv.display/requestClearPanelNoise', { mode: 'cancel_schedule' },
                  function (r) {
                    lastOledCheck = 0;
                    lastStats = null;
                    cb({ ok: !!(r && r.returnValue) });
                  });

    default:
      return cb({ ok: false, error: 'unknown action' });
  }
}

// ---------------------------------------------------------------- page
/* Served to a phone/laptop browser, so modern JS is fine in HERE. */
var PAGE = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<title>LG OLED TV · Monitor & Control</title>',
  '<style>',
  ':root {',
  '  --bg: #090b10;',
  '  --surface: #121620;',
  '  --surface-hover: #181d2a;',
  '  --surface-active: #1e2434;',
  '  --border: rgba(255, 255, 255, 0.08);',
  '  --border-focus: rgba(56, 189, 248, 0.4);',
  '  --fg: #f1f5f9;',
  '  --dim: #94a3b8;',
  '  --muted: #64748b;',
  '  --accent: #38bdf8;',
  '  --accent-glow: rgba(56, 189, 248, 0.2);',
  '  --emerald: #10b981;',
  '  --emerald-glow: rgba(16, 185, 129, 0.2);',
  '  --amber: #f59e0b;',
  '  --amber-glow: rgba(245, 158, 11, 0.2);',
  '  --rose: #f43f5e;',
  '  --rose-glow: rgba(244, 63, 94, 0.2);',
  '  --purple: #a855f7;',
  '}',
  '',
  '* { box-sizing: border-box; margin: 0; padding: 0; }',
  'body {',
  '  background: var(--bg);',
  '  color: var(--fg);',
  '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, Helvetica, Arial, sans-serif;',
  '  line-height: 1.5;',
  '  padding: 20px 20px 40px;',
  '  max-width: 1320px;',
  '  margin: 0 auto;',
  '  -webkit-font-smoothing: antialiased;',
  '}',
  '',
  '/* 2-Column Dashboard Layout */',
  '.dashboard-layout {',
  '  display: grid;',
  '  grid-template-columns: minmax(0, 1.18fr) minmax(360px, 0.82fr);',
  '  gap: 20px;',
  '  align-items: start;',
  '}',
  '@media (max-width: 992px) {',
  '  .dashboard-layout {',
  '    grid-template-columns: 1fr;',
  '    gap: 16px;',
  '  }',
  '}',
  '.col-data {',
  '  display: flex;',
  '  flex-direction: column;',
  '  gap: 14px;',
  '  min-width: 0;',
  '}',
  '.col-controls {',
  '  display: flex;',
  '  flex-direction: column;',
  '  gap: 10px;',
  '  min-width: 0;',
  '  position: sticky;',
  '  top: 20px;',
  '}',
  '@media (max-width: 992px) {',
  '  .col-controls {',
  '    position: static;',
  '  }',
  '}',
  '',
  '/* Header */',
  'header {',
  '  display: flex;',
  '  align-items: center;',
  '  justify-content: space-between;',
  '  flex-wrap: wrap;',
  '  gap: 12px;',
  '  padding-bottom: 18px;',
  '  border-bottom: 1px solid var(--border);',
  '  margin-bottom: 20px;',
  '}',
  '.brand {',
  '  display: flex;',
  '  align-items: center;',
  '  gap: 12px;',
  '}',
  '.tv-icon {',
  '  width: 42px;',
  '  height: 42px;',
  '  border-radius: 12px;',
  '  background: linear-gradient(135deg, #1e293b, #0f172a);',
  '  border: 1px solid var(--border);',
  '  display: flex;',
  '  align-items: center;',
  '  justify-content: center;',
  '  color: var(--accent);',
  '  box-shadow: 0 4px 12px rgba(0,0,0,0.3);',
  '}',
  '.brand h1 {',
  '  font-size: 18px;',
  '  font-weight: 700;',
  '  letter-spacing: -0.02em;',
  '  display: flex;',
  '  align-items: center;',
  '  gap: 8px;',
  '}',
  '.brand .status-pill {',
  '  display: inline-flex;',
  '  align-items: center;',
  '  gap: 6px;',
  '  font-size: 12px;',
  '  font-weight: 500;',
  '  color: var(--emerald);',
  '  background: rgba(16, 185, 129, 0.12);',
  '  border: 1px solid rgba(16, 185, 129, 0.25);',
  '  padding: 2px 8px;',
  '  border-radius: 20px;',
  '}',
  '.pulse-dot {',
  '  width: 6px;',
  '  height: 6px;',
  '  border-radius: 50%;',
  '  background: var(--emerald);',
  '  box-shadow: 0 0 8px var(--emerald);',
  '}',
  '.header-meta {',
  '  font-size: 13px;',
  '  color: var(--dim);',
  '  display: flex;',
  '  align-items: center;',
  '  gap: 14px;',
  '}',
  '',
  '/* Grid & Cards */',
  '.grid {',
  '  display: grid;',
  '  grid-template-columns: repeat(2, minmax(0, 1fr));',
  '  gap: 14px;',
  '}',
  '@media (max-width: 580px) {',
  '  .grid {',
  '    grid-template-columns: 1fr;',
  '  }',
  '}',
  '.card {',
  '  background: var(--surface);',
  '  border: 1px solid var(--border);',
  '  border-radius: 16px;',
  '  padding: 16px;',
  '  position: relative;',
  '  overflow: hidden;',
  '  box-shadow: 0 4px 20px rgba(0,0,0,0.2);',
  '  transition: border-color 0.2s, transform 0.2s;',
  '}',
  '.card:hover {',
  '  border-color: rgba(255,255,255,0.14);',
  '}',
  '.card.featured {',
  '  grid-column: 1 / -1;',
  '  background: linear-gradient(135deg, rgba(30, 41, 59, 0.4), var(--surface));',
  '  border: 1px solid rgba(56, 189, 248, 0.2);',
  '}',
  '',
  '.card-hdr {',
  '  display: flex;',
  '  align-items: center;',
  '  justify-content: space-between;',
  '  margin-bottom: 10px;',
  '}',
  '.card-lbl {',
  '  font-size: 12px;',
  '  font-weight: 600;',
  '  text-transform: uppercase;',
  '  letter-spacing: 0.06em;',
  '  color: var(--dim);',
  '  display: flex;',
  '  align-items: center;',
  '  gap: 6px;',
  '}',
  '.badge {',
  '  font-size: 11px;',
  '  font-weight: 600;',
  '  padding: 2px 7px;',
  '  border-radius: 6px;',
  '  text-transform: uppercase;',
  '  letter-spacing: 0.04em;',
  '}',
  '.badge-hdr { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }',
  '.badge-dv { background: linear-gradient(135deg, #7c3aed, #c026d3); color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.4); }',
  '.badge-sdr { background: rgba(148, 163, 184, 0.15); color: var(--dim); border: 1px solid rgba(148, 163, 184, 0.2); }',
  '.badge-oled { background: linear-gradient(135deg, #0284c7, #2563eb); color: #fff; }',
  '',
  '.val {',
  '  font-size: 28px;',
  '  font-weight: 700;',
  '  letter-spacing: -0.02em;',
  '  color: var(--fg);',
  '  font-variant-numeric: tabular-nums;',
  '  display: flex;',
  '  align-items: baseline;',
  '  gap: 4px;',
  '}',
  '.val-unit {',
  '  font-size: 14px;',
  '  font-weight: 500;',
  '  color: var(--dim);',
  '}',
  '',
  '/* Progress bar */',
  '.progress-bar {',
  '  height: 6px;',
  '  background: rgba(255, 255, 255, 0.07);',
  '  border-radius: 4px;',
  '  overflow: hidden;',
  '  margin-top: 10px;',
  '}',
  '.progress-fill {',
  '  height: 100%;',
  '  border-radius: 4px;',
  '  background: var(--accent);',
  '  transition: width 0.4s ease, background 0.4s ease;',
  '}',
  '',
  '.meta-text {',
  '  font-size: 12px;',
  '  color: var(--dim);',
  '  margin-top: 8px;',
  '  line-height: 1.4;',
  '}',
  '',
  '/* OLED special layout */',
  '.oled-grid {',
  '  display: grid;',
  '  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));',
  '  gap: 14px;',
  '  margin-top: 12px;',
  '  padding-top: 12px;',
  '  border-top: 1px solid rgba(255, 255, 255, 0.06);',
  '}',
  '.oled-stat {',
  '  display: flex;',
  '  flex-direction: column;',
  '  gap: 4px;',
  '}',
  '.oled-stat-lbl {',
  '  font-size: 11px;',
  '  color: var(--dim);',
  '  text-transform: uppercase;',
  '  letter-spacing: 0.05em;',
  '}',
  '.oled-stat-val {',
  '  font-size: 15px;',
  '  font-weight: 600;',
  '  color: var(--fg);',
  '}',
  '.oled-stat-meta {',
  '  font-size: 12px;',
  '  color: var(--muted);',
  '}',
  '',
  '/* Cores mini bars */',
  '.cores-row {',
  '  display: flex;',
  '  gap: 6px;',
  '  margin-top: 10px;',
  '}',
  '.core-pill {',
  '  flex: 1;',
  '  background: rgba(255, 255, 255, 0.05);',
  '  border-radius: 8px;',
  '  padding: 6px 4px;',
  '  text-align: center;',
  '  font-size: 11px;',
  '  color: var(--dim);',
  '}',
  '.core-pct {',
  '  font-weight: 600;',
  '  color: var(--fg);',
  '  font-size: 12px;',
  '}',
  '',
  '/* Section Controls */',
  '.section-title {',
  '  font-size: 13px;',
  '  font-weight: 600;',
  '  text-transform: uppercase;',
  '  letter-spacing: 0.06em;',
  '  color: var(--dim);',
  '  margin: 0 0 2px;',
  '  display: flex;',
  '  align-items: center;',
  '  gap: 8px;',
  '}',
  '.control-card {',
  '  background: var(--surface);',
  '  border: 1px solid var(--border);',
  '  border-radius: 16px;',
  '  padding: 16px 18px;',
  '  box-shadow: 0 4px 20px rgba(0,0,0,0.2);',
  '}',
  '.control-group {',
  '  margin-bottom: 16px;',
  '}',
  '.control-group:last-child {',
  '  margin-bottom: 0;',
  '}',
  '.control-lbl {',
  '  font-size: 12px;',
  '  font-weight: 600;',
  '  color: var(--dim);',
  '  text-transform: uppercase;',
  '  letter-spacing: 0.05em;',
  '  margin-bottom: 8px;',
  '}',
  '',
  '.btn-grid {',
  '  display: grid;',
  '  grid-template-columns: repeat(auto-fit, minmax(68px, 1fr));',
  '  gap: 8px;',
  '}',
  'button {',
  '  background: var(--surface-hover);',
  '  color: var(--fg);',
  '  border: 1px solid var(--border);',
  '  border-radius: 10px;',
  '  padding: 11px 12px;',
  '  font-size: 13px;',
  '  font-weight: 600;',
  '  cursor: pointer;',
  '  display: inline-flex;',
  '  align-items: center;',
  '  justify-content: center;',
  '  gap: 6px;',
  '  transition: all 0.15s ease;',
  '  user-select: none;',
  '}',
  'button:hover {',
  '  background: var(--surface-active);',
  '  border-color: rgba(255,255,255,0.18);',
  '  color: #fff;',
  '}',
  'button:active {',
  '  transform: scale(0.97);',
  '}',
  'button.active {',
  '  background: var(--accent);',
  '  color: #000;',
  '  border-color: var(--accent);',
  '  box-shadow: 0 0 12px var(--accent-glow);',
  '}',
  'button.danger {',
  '  background: rgba(244, 63, 94, 0.12);',
  '  color: #fb7185;',
  '  border-color: rgba(244, 63, 94, 0.25);',
  '}',
  'button.danger:hover {',
  '  background: rgba(244, 63, 94, 0.22);',
  '  border-color: rgba(244, 63, 94, 0.4);',
  '}',
  'button.primary {',
  '  background: rgba(56, 189, 248, 0.12);',
  '  color: var(--accent);',
  '  border-color: rgba(56, 189, 248, 0.3);',
  '}',
  'button.primary:hover {',
  '  background: rgba(56, 189, 248, 0.22);',
  '}',
  '',
  '.toast-row {',
  '  display: flex;',
  '  gap: 8px;',
  '}',
  'input[type="text"] {',
  '  flex: 1;',
  '  background: var(--surface-hover);',
  '  border: 1px solid var(--border);',
  '  color: var(--fg);',
  '  border-radius: 10px;',
  '  padding: 10px 14px;',
  '  font-size: 13px;',
  '  outline: none;',
  '  transition: border-color 0.2s;',
  '}',
  'input[type="text"]:focus {',
  '  border-color: var(--accent);',
  '  box-shadow: 0 0 0 2px var(--accent-glow);',
  '}',
  '',
  '/* Alert notice */',
  '#err {',
  '  background: rgba(244, 63, 94, 0.15);',
  '  border: 1px solid rgba(244, 63, 94, 0.3);',
  '  color: #fda4af;',
  '  padding: 12px 14px;',
  '  border-radius: 12px;',
  '  margin-bottom: 16px;',
  '  font-size: 13px;',
  '  display: none;',
  '}',
  '#toast-notice {',
  '  position: fixed;',
  '  bottom: 24px;',
  '  right: 24px;',
  '  background: #1e293b;',
  '  border: 1px solid var(--accent);',
  '  color: var(--fg);',
  '  padding: 10px 16px;',
  '  border-radius: 10px;',
  '  box-shadow: 0 8px 24px rgba(0,0,0,0.5);',
  '  font-size: 13px;',
  '  font-weight: 500;',
  '  display: none;',
  '  z-index: 100;',
  '}',
  '</style>',
  '</head>',
  '<body>',
  '',
  '<div id="toast-notice"></div>',
  '<div id="err"></div>',
  '',
  '<header>',
  '  <div class="brand">',
  '    <div class="tv-icon">',
  '      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg>',
  '    </div>',
  '    <div>',
  '      <h1><span id="devname">LG OLED TV</span> <span class="status-pill"><span class="pulse-dot"></span> Online</span></h1>',
  '      <div style="font-size: 13px; color: var(--dim); margin-top: 2px;" id="sub">Connecting...</div>',
  '    </div>',
  '  </div>',
  '  <div class="header-meta">',
  '    <div id="head-app" style="font-weight: 600; color: var(--accent);">-</div>',
  '  </div>',
  '</header>',
  '',
  '<main class="dashboard-layout">',
  '<!-- Left Column: Telemetry & Status -->',
  '<section class="col-data">',
  '<!-- Featured OLED Health Card -->',
  '<div class="card featured" style="margin-bottom: 0;">',
  '  <div class="card-hdr">',
  '    <div class="card-lbl">',
  '      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polygon points="12 6 12 12 16 14"></polygon></svg>',
  '      OLED Panel Health & Lifespan',
  '    </div>',
  '    <span class="badge badge-oled">OLED Panel</span>',
  '  </div>',
  '  <div style="display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 10px;">',
  '    <div class="val"><span id="panelhours">-</span> <span class="val-unit">total operating hours</span></div>',
  '    <div style="font-size: 12px; color: var(--dim);">Cumulative Panel Usage</div>',
  '  </div>',
  '  <div class="oled-grid">',
  '    <div class="oled-stat">',
  '      <div class="oled-stat-lbl">Short Cycle (Off-RS)</div>',
  '      <div class="oled-stat-val" id="oled-short">-</div>',
  '      <div class="oled-stat-meta" id="oled-short-meta">Runs on standby (4h interval)</div>',
  '      <div style="margin-top: 8px;">',
  '        <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--dim); margin-bottom: 4px;">',
  '          <span>4h Cycle Progress</span>',
  '          <span id="oled-cycle-pct" style="font-weight: 600; color: var(--fg);">-</span>',
  '        </div>',
  '        <div class="progress-bar" style="margin-top: 0; height: 5px;"><div class="progress-fill" id="oledbar" style="width: 0%;"></div></div>',
  '      </div>',
  '    </div>',
  '    <div class="oled-stat">',
  '      <div class="oled-stat-lbl">Pixel Refresher (1-Hour JB)</div>',
  '      <div class="oled-stat-val" id="oled-refresher">-</div>',
  '      <div class="oled-stat-meta" id="oled-refresher-meta">Deep cycle (2,000h interval)</div>',
  '    </div>',
  '    <div class="oled-stat">',
  '      <div class="oled-stat-lbl">Burn-In Protection</div>',
  '      <div class="oled-stat-val" id="oled-protect">-</div>',
  '      <div class="oled-stat-meta" id="oled-schedule">Status: Idle</div>',
  '    </div>',
  '  </div>',
  '</div>',
  '',
  '<!-- Telemetry Grid -->',
  '<div class="grid">',
  '  <!-- Video & Picture -->',
  '  <div class="card">',
  '    <div class="card-hdr">',
  '      <div class="card-lbl">',
  '        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>',
  '        Display & Picture',
  '      </div>',
  '      <span class="badge badge-hdr" id="hdr-badge">HDR</span>',
  '    </div>',
  '    <div class="val" id="picmode">-</div>',
  '    <div class="progress-bar"><div class="progress-fill" id="backlightbar"></div></div>',
  '    <div class="meta-text" id="picmeta">-</div>',
  '  </div>',
  '',
  '  <!-- Audio -->',
  '  <div class="card">',
  '    <div class="card-hdr">',
  '      <div class="card-lbl">',
  '        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>',
  '        Audio Output',
  '      </div>',
  '      <span class="badge" style="background: rgba(255,255,255,0.08);" id="volbadge">Vol -</span>',
  '    </div>',
  '    <div class="val" id="audiomode">-</div>',
  '    <div class="progress-bar"><div class="progress-fill" id="volbar"></div></div>',
  '    <div class="meta-text" id="audiometa">-</div>',
  '  </div>',
  '',
  '  <!-- SoC Temp -->',
  '  <div class="card">',
  '    <div class="card-hdr">',
  '      <div class="card-lbl">',
  '        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"></path></svg>',
  '        SoC Temperature',
  '      </div>',
  '    </div>',
  '    <div class="val"><span id="temp">-</span> <span class="val-unit" id="tempunit">&deg;C</span></div>',
  '    <div class="progress-bar"><div class="progress-fill" id="tempbar"></div></div>',
  '    <div class="meta-text" id="tempmeta">-</div>',
  '  </div>',
  '',
  '  <!-- CPU & Power -->',
  '  <div class="card">',
  '    <div class="card-hdr">',
  '      <div class="card-lbl">',
  '        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg>',
  '        CPU & Power',
  '      </div>',
  '      <span class="badge" style="background: rgba(255,255,255,0.08);" id="mhzbadge">- MHz</span>',
  '    </div>',
  '    <div class="val"><span id="cpu">-</span> <span class="val-unit">% load</span></div>',
  '    <div class="cores-row" id="cores"></div>',
  '    <div class="meta-text" id="cpumeta">-</div>',
  '  </div>',
  '',
  '  <!-- Memory -->',
  '  <div class="card">',
  '    <div class="card-hdr">',
  '      <div class="card-lbl">',
  '        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 19v-3M10 19v-3M14 19v-3M18 19v-3M6 5v3M10 5v3M14 5v3M18 5v3M2 8h20v8H2z"></path></svg>',
  '        RAM & Swap',
  '      </div>',
  '    </div>',
  '    <div class="val"><span id="mem">-</span> <span class="val-unit">% used</span></div>',
  '    <div class="progress-bar"><div class="progress-fill" id="membar"></div></div>',
  '    <div class="meta-text" id="memmeta">-</div>',
  '    <div class="progress-bar" style="margin-top: 6px;"><div class="progress-fill" id="swapbar" style="background: var(--purple);"></div></div>',
  '    <div class="meta-text" id="swapmeta">-</div>',
  '  </div>',
  '',
  '  <!-- Flash & Network -->',
  '  <div class="card">',
  '    <div class="card-hdr">',
  '      <div class="card-lbl">',
  '        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"></circle><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"></path></svg>',
  '        Storage & Network',
  '      </div>',
  '    </div>',
  '    <div class="val" id="emmc">-</div>',
  '    <div class="meta-text" id="emmcmeta">-</div>',
  '    <div class="meta-text" id="netmeta" style="margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 6px;">-</div>',
  '  </div>',
  '</div>',
  '</section>',
  '',
  '<!-- Right Column: Interactive Controls -->',
  '<section class="col-controls">',
  '<div class="section-title">',
  '  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
  '  Interactive Controls',
  '</div>',
  '',
  '<div class="control-card">',
  '  <!-- Inputs -->',
  '  <div class="control-group">',
  '    <div class="control-lbl">Input Source</div>',
  '    <div class="btn-grid">',
  '      <button id="btn_hdmi1" onclick="c(\'input\',\'hdmi1\')">HDMI 1</button>',
  '      <button id="btn_hdmi2" onclick="c(\'input\',\'hdmi2\')">HDMI 2</button>',
  '      <button id="btn_hdmi3" onclick="c(\'input\',\'hdmi3\')">HDMI 3</button>',
  '      <button id="btn_hdmi4" onclick="c(\'input\',\'hdmi4\')">HDMI 4</button>',
  '      <button id="btn_livetv" onclick="c(\'input\',\'livetv\')">Live TV</button>',
  '    </div>',
  '  </div>',
  '',
  '  <!-- Audio Controls -->',
  '  <div class="control-group">',
  '    <div class="control-lbl">Volume & Sound</div>',
  '    <div class="btn-grid">',
  '      <button onclick="c(\'volumeStep\',-5)">Vol &minus;5</button>',
  '      <button onclick="c(\'volumeStep\',-1)">Vol &minus;1</button>',
  '      <button onclick="c(\'volumeStep\',1)">Vol +1</button>',
  '      <button onclick="c(\'volumeStep\',5)">Vol +5</button>',
  '      <button id="btn_mute" onclick="toggleMute()">Mute</button>',
  '    </div>',
  '  </div>',
  '',
  '  <!-- Screen & OLED Refresher -->',
  '  <div class="control-group">',
  '    <div class="control-lbl">OLED Panel & Refresher</div>',
  '    <div class="btn-grid">',
  '      <button onclick="c(\'screenOff\')" title="Turn off display panel while audio continues playing">',
  '        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>',
  '        Screen Off',
  '      </button>',
  '      <button onclick="c(\'screenOn\')" title="Wake up display panel">',
  '        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
  '        Screen On',
  '      </button>',
  '      <button id="btn_sched" class="primary" onclick="c(\'refresherSchedule\')">',
  '        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 14"></polyline></svg>',
  '        Schedule Refresher',
  '      </button>',
  '      <button id="btn_cancel_sched" onclick="c(\'refresherCancel\')">Cancel Schedule</button>',
  '    </div>',
  '  </div>',
  '',
  '  <!-- On-Screen Notification Toast -->',
  '  <div class="control-group">',
  '    <div class="control-lbl">Send On-Screen Notification</div>',
  '    <div class="toast-row">',
  '      <input type="text" id="toast-input" placeholder="Message to display on TV screen..." onkeydown="if(event.key===\'Enter\')sendToast()">',
  '      <button class="primary" onclick="sendToast()">Send Toast</button>',
  '    </div>',
  '  </div>',
  '',
  '  <!-- Power Management -->',
  '  <div class="control-group" style="margin-bottom: 0; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.06);">',
  '    <div class="control-lbl">System Power</div>',
  '    <div class="btn-grid">',
  '      <button class="danger" id="poff" onclick="pw(\'powerOff\')">',
  '        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>',
  '        Power Off',
  '      </button>',
  '      <button class="danger" id="prb" onclick="pw(\'reboot\')">',
  '        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><polyline points="23 20 23 14 17 14"></polyline><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path></svg>',
  '        Restart TV',
  '      </button>',
  '    </div>',
  '    <div class="meta-text" id="pwnote" style="margin-top: 8px;"></div>',
  '  </div>',
  '</div>',
  '</section>',
  '</main>',
  '',
  '<script>',
  'const K = new URLSearchParams(location.search).get("k") || "";',
  'const q = s => document.getElementById(s);',
  'let currentMuted = false;',
  '',
  'function showToast(msg) {',
  '  const t = q("toast-notice");',
  '  t.textContent = msg;',
  '  t.style.display = "block";',
  '  setTimeout(() => { t.style.display = "none"; }, 2500);',
  '}',
  '',
  'function showErr(msg) {',
  '  const e = q("err");',
  '  e.textContent = msg;',
  '  e.style.display = "block";',
  '}',
  '',
  'async function c(action, value) {',
  '  try {',
  '    const res = await fetch("/api/control?k=" + encodeURIComponent(K), {',
  '      method: "POST",',
  '      headers: { "Content-Type": "application/json" },',
  '      body: JSON.stringify({ action: action, value: value })',
  '    });',
  '    const j = await res.json();',
  '    if (!j.ok) {',
  '      showErr(j.error || "Action failed");',
  '    } else {',
  '      q("err").style.display = "none";',
  '      showToast("Command sent: " + action);',
  '    }',
  '    setTimeout(tick, 300);',
  '  } catch (err) {',
  '    showErr(err.message);',
  '  }',
  '}',
  '',
  'function pw(action) {',
  '  if (confirm("Are you sure you want to " + action + " the TV?")) {',
  '    c(action);',
  '  }',
  '}',
  '',
  'function toggleMute() {',
  '  c("mute", !currentMuted);',
  '}',
  '',
  'function sendToast() {',
  '  const input = q("toast-input");',
  '  const msg = input.value.trim();',
  '  if (msg) {',
  '    c("toast", msg);',
  '    input.value = "";',
  '  }',
  '}',
  '',
  'function setProgress(id, pct, color) {',
  '  const el = q(id);',
  '  if (!el) return;',
  '  el.style.width = Math.max(0, Math.min(100, pct)) + "%";',
  '  if (color) el.style.background = color;',
  '}',
  '',
  'const formatMb = kb => (kb / 1024).toFixed(0).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",") + " MB";',
  '',
  'let tempHistory = [];',
  '',
  'async function tick() {',
  '  try {',
  '    const res = await fetch("/api/stats?k=" + encodeURIComponent(K));',
  '    if (!res.ok) {',
  '      showErr("HTTP " + res.status + (res.status === 401 ? " - Invalid or missing authentication token" : ""));',
  '      return;',
  '    }',
  '    const d = await res.json();',
  '    q("err").style.display = "none";',
  '',
  '    // Header & device info',
  '    if (d.device && d.device.name) {',
  '      q("devname").textContent = d.device.name;',
  '      document.title = d.device.name + (d.app ? " · " + (d.display_title || d.app) : "");',
  '    }',
  '    const upSec = d.uptime || 0;',
  '    const upH = Math.floor(upSec / 3600);',
  '    const upM = Math.floor((upSec % 3600) / 60);',
  '    q("sub").textContent = "Uptime: " + upH + "h " + upM + "m · SoC: " + d.mhz + " MHz · Load: " + (d.loadavg || []).join(" ");',
  '    q("head-app").textContent = d.display_title || d.app_name || d.app || "Live TV";',
  '',
  '    // OLED Card',
  '    if (d.oled) {',
  '      q("panelhours").textContent = (d.oled.panel_hours || 0).toLocaleString();',
  '',
  '      // Short cycle progress (0 to 4 hrs)',
  '      const shortPct = Math.min(100, Math.round((d.oled.hours_since_comp / 4) * 100));',
  '      setProgress("oledbar", shortPct, shortPct >= 95 ? "var(--amber)" : "var(--accent)");',
  '      const cyclePct = q("oled-cycle-pct");',
  '      if (cyclePct) cyclePct.textContent = shortPct + "%";',
  '',
  '      q("oled-short").textContent = d.oled.hours_since_comp + "h ago";',
  '      q("oled-short-meta").textContent = "Due in ~" + d.oled.hours_until_comp + "h on standby";',
  '',
  '      q("oled-refresher").textContent = d.oled.hours_since_refresher + "h ago";',
  '      q("oled-refresher-meta").textContent = "~" + d.oled.hours_until_refresher + "h until next 2,000h cycle";',
  '',
  '      q("oled-protect").textContent = "Orbit: " + String(d.oled.screen_shift).toUpperCase() + " · Logo: " + String(d.oled.logo_dimming).toUpperCase();',
  '      q("oled-schedule").textContent = "Schedule: " + d.oled.refresher_status;',
  '',
  '      if (d.oled.refresher_status === "Scheduled") {',
  '        q("btn_sched").style.display = "none";',
  '        q("btn_cancel_sched").style.display = "inline-flex";',
  '        q("btn_cancel_sched").className = "danger";',
  '      } else {',
  '        q("btn_sched").style.display = "inline-flex";',
  '        q("btn_cancel_sched").style.display = "none";',
  '      }',
  '    }',
  '',
  '    // Video & Picture',
  '    if (d.picture) {',
  '      q("picmode").textContent = d.picture.mode || "Standard";',
  '      const hdrBadge = q("hdr-badge");',
  '      hdrBadge.textContent = d.picture.dynamicRange || "SDR";',
  '      if (d.picture.dynamicRange === "Dolby Vision") {',
  '        hdrBadge.className = "badge badge-dv";',
  '      } else if (d.picture.dynamicRange === "HDR") {',
  '        hdrBadge.className = "badge badge-hdr";',
  '      } else {',
  '        hdrBadge.className = "badge badge-sdr";',
  '      }',
  '      setProgress("backlightbar", d.picture.backlight || 50);',
  '      q("picmeta").textContent = "OLED Light " + d.picture.backlight + "%" + (d.signal ? " · " + d.signal : "");',
  '    }',
  '',
  '    // Audio',
  '    currentMuted = !!d.muted;',
  '    const audioMap = {',
  '      mastervolume_headphone: "Optical / Headphone",',
  '      tv_speaker: "TV Speaker",',
  '      external_arc: "HDMI ARC",',
  '      soundbar: "Soundbar"',
  '    };',
  '    q("audiomode").textContent = audioMap[d.audio_output] || d.audio_output || "Internal";',
  '    q("volbadge").textContent = d.muted ? "MUTED" : "Vol " + d.volume;',
  '    q("volbadge").style.color = d.muted ? "var(--rose)" : "var(--fg)";',
  '    setProgress("volbar", d.muted ? 0 : d.volume, d.muted ? "var(--rose)" : "var(--accent)");',
  '    q("audiometa").textContent = d.muted ? "Muted (press Unmute to restore)" : "Volume level: " + d.volume + "%";',
  '    q("btn_mute").textContent = d.muted ? "Unmute" : "Mute";',
  '',
  '    // Never push a null temp into the ring: Math.min/max coerce it to 0,',
  '    // which renders a plausible 0 C on a set that has no sensor at all.',
  '    const noThermal = !!(d.capabilities && d.capabilities.thermal === false);',
  '    const hasTemp = !(d.temp === null || d.temp === undefined);',
  '    const tu = q("tempunit"); if (tu) tu.hidden = !hasTemp;',
  '    if (hasTemp) {',
  '      const temp = Number(d.temp);',
  '      q("temp").textContent = temp;',
  '      tempHistory.push(temp);',
  '      if (tempHistory.length > 100) tempHistory.shift();',
  '      const minT = Math.min(...tempHistory);',
  '      const maxT = Math.max(...tempHistory);',
  '      const tempCol = temp >= 75 ? "var(--rose)" : temp >= 65 ? "var(--amber)" : "var(--emerald)";',
  '      setProgress("tempbar", temp, tempCol);',
  '      q("tempmeta").textContent = "Range: " + minT + "°C – " + maxT + "°C (Healthy < 75°C)";',
  '    } else {',
  '      q("temp").textContent = "n/a";',
  '      setProgress("tempbar", 0, "var(--muted)");',
  '      q("tempmeta").textContent = noThermal ? "No thermal sensor on this platform" : "Sensor warming up";',
  '    }',
  '',
  '    // CPU & Power',
  '    const cpuLoad = d.load || 0;',
  '    q("cpu").textContent = cpuLoad;',
  '    q("mhzbadge").textContent = (d.mhz || 1008) + " MHz";',
  '    const cpuCol = cpuLoad >= 85 ? "var(--rose)" : cpuLoad >= 60 ? "var(--amber)" : "var(--accent)";',
  '    if (d.cores && d.cores.length) {',
  '      q("cores").innerHTML = d.cores.map((c, i) =>',
  '        \'<div class="core-pill">C\' + i + \'<div class="core-pct">\' + c + \'%</div></div>\'',
  '      ).join("");',
  '    }',
  '    q("cpumeta").textContent = d.power && d.power.current_ma ?',
  '      "SoC Draw: " + d.power.current_ma + " mA (CPU: " + d.power.cpu_ma + " mA · Core: " + d.power.core_ma + " mA)" : "";',
  '',
  '    // Memory & Swap',
  '    const memTotal = (d.mem && d.mem.total) || 0;',
  '    const memAvail = (d.mem && d.mem.avail) || 0;',
  '    const memUsed = memTotal - memAvail;',
  '    const memPct = memTotal ? Math.round((memUsed / memTotal) * 100) : 0;',
  '    q("mem").textContent = memPct;',
  '    setProgress("membar", memPct, memPct >= 90 ? "var(--rose)" : memPct >= 75 ? "var(--amber)" : "var(--accent)");',
  '    q("memmeta").textContent = "RAM: " + formatMb(memUsed) + " of " + formatMb(memTotal);',
  '',
  '    const swapTotal = (d.swap && d.swap.total) || 0;',
  '    const swapFree = (d.swap && d.swap.free) || 0;',
  '    const swapUsed = swapTotal - swapFree;',
  '    const swapPct = swapTotal ? Math.round((swapUsed / swapTotal) * 100) : 0;',
  '    setProgress("swapbar", swapPct, "var(--purple)");',
  '    q("swapmeta").textContent = "zram Swap: " + formatMb(swapUsed) + " of " + formatMb(swapTotal) + " (" + swapPct + "%)";',
  '',
  '    // Storage & Network',
  '    q("emmc").textContent = (d.emmc && d.emmc.health) || "unknown";',
  '    q("emmcmeta").textContent = "Wear: " + ((d.emmc && d.emmc.wear) || "unknown") + " · EOL Status: " + ((d.emmc && d.emmc.eol) || "unknown");',
  '    const wifiText = d.wifi ? "Wi-Fi: " + d.wifi.level + " dBm (Signal " + d.wifi.link + "%)" : "Ethernet Wired";',
  '    const netText = d.net ? " · ↓ " + (d.net.rx / 1024).toFixed(1) + " KB/s · ↑ " + (d.net.tx / 1024).toFixed(1) + " KB/s" : "";',
  '    q("netmeta").textContent = wifiText + netText;',
  '',
  '    // Inputs highlight',
  '    const activeApp = d.app || "";',
  '    ["hdmi1", "hdmi2", "hdmi3", "hdmi4", "livetv"].forEach(id => {',
  '      const btn = q("btn_" + id);',
  '      if (btn) {',
  '        if (d.inputs && d.inputs[id]) btn.textContent = d.inputs[id];',
  '        if (activeApp === id) btn.classList.add("active");',
  '        else btn.classList.remove("active");',
  '      }',
  '    });',
  '',
  '  } catch (err) {',
  '    showErr("TV unreachable - " + err.message);',
  '  }',
  '}',
  '',
  'fetch("/api/caps?k=" + encodeURIComponent(K)).then(r => r.json()).then(c => {',
  '  if (!c.allowPower) {',
  '    q("poff").style.opacity = "0.4";',
  '    q("poff").disabled = true;',
  '    q("prb").style.opacity = "0.4";',
  '    q("prb").disabled = true;',
  '    q("pwnote").textContent = "Power controls disabled (allowPower: false in tvweb config).";',
  '  }',
  '});',
  '',
  'tick();',
  'setInterval(tick, 2000);',
  '</script>',
  '</body>',
  '</html>'
].join('\n');

// ------------------------------------------------------- external assets
/*
 * The UI is authored as a real HTML file (assets/ui.html) rather than a JS
 * string array, so it can be edited and diffed like a web page. The embedded
 * PAGE above stays as a fallback: if the asset is missing the server still
 * serves a working dashboard instead of a blank screen.
 */
var WEB_ENABLED = !(CONFIG.web && CONFIG.web.enabled === false);

var ASSET_DIRS = [
  path.join(__dirname, 'assets'),
  '/var/lib/tvweb/assets'
];

function assetPath(rel) {
  // Reject traversal before touching the filesystem.
  if (rel.indexOf('\0') !== -1) return null;
  var clean = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '');
  if (clean.indexOf('..') !== -1) return null;
  for (var i = 0; i < ASSET_DIRS.length; i++) {
    var full = path.join(ASSET_DIRS[i], clean);
    if (full.indexOf(ASSET_DIRS[i]) !== 0) continue;   // outside the root
    try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full; }
    catch (e) {}
  }
  return null;
}

var UI_HTML = null;
(function loadUI() {
  if (!WEB_ENABLED) return;   // nothing will serve it
  var f = assetPath('ui.html');
  if (!f) { console.log('assets: ui.html not found, using embedded page'); return; }
  try {
    UI_HTML = fs.readFileSync(f, 'utf8');
    console.log('assets: serving ui.html from ' + f);
  } catch (e) {
    console.error('assets: could not read ui.html: ' + e.message);
  }
})();

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript',
  '.png': 'image/png', '.svg': 'image/svg+xml'
};

// ---------------------------------------------------------------- server
function send(res, code, body, type) {
  /*
   * No Access-Control-Allow-Origin. The telemetry includes what is currently
   * playing, the model, panel hours and usage, and a wildcard here let any
   * site the user happened to visit read all of it from their browser. The
   * dashboard is same-origin, so it needs no CORS grant.
   */
  res.writeHead(code, {
    'Content-Type': type || 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

function authed(q) {
  return !CONFIG.token || q.k === CONFIG.token;
}

var server = http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  var pathname = u.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    return send(res, 200, UI_HTML || PAGE, 'text/html; charset=utf-8');
  }

  if (pathname.indexOf('/assets/') === 0) {
    var file = assetPath(pathname.slice('/assets/'.length));
    if (!file) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
    return fs.readFile(file, function (e, buf) {
      if (e) return send(res, 500, JSON.stringify({ ok: false, error: 'read failed' }));
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(buf);
    });
  }

  if (pathname.indexOf('/api/') === 0 && !authed(u.query)) {
    return send(res, 401, JSON.stringify({ ok: false, error: 'bad or missing token' }));
  }

  if (pathname === '/api/caps') {
    return send(res, 200, JSON.stringify({
      ok: true, allowControl: CONFIG.allowControl, allowPower: CONFIG.allowPower
    }));
  }

  if (pathname === '/api/hdmi') {
    return hdmiInputs(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/processes') {
    return collectProcesses(function (r) { send(res, 200, JSON.stringify(r)); });
  }

  if (pathname === '/api/privacy') {
    return collectPrivacy(function (pv) { send(res, 200, JSON.stringify(pv)); });
  }

  if (pathname === '/api/stats') {
    return collectStats(function (s) { send(res, 200, JSON.stringify(s)); });
  }

  if (pathname === '/api/control' && req.method === 'POST') {
    /*
     * CSRF guard. Responses carry Access-Control-Allow-Origin:*, and a POST
     * with a "simple" content type (text/plain, form-urlencoded) is sent by a
     * browser WITHOUT a CORS preflight - so any web page the user visits could
     * otherwise drive this TV. Requiring application/json forces a preflight,
     * which this server never approves, and rejecting cross-site Origins
     * closes the gap for anything that does slip through.
     */
    var ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (ctype.indexOf('application/json') !== 0) {
      return send(res, 415, JSON.stringify({
        ok: false, error: 'Content-Type must be application/json'
      }));
    }
    var origin = req.headers.origin;
    if (origin) {
      var hostHdr = String(req.headers.host || '');
      var oHost = String(origin).replace(/^https?:\/\//, '');
      if (oHost !== hostHdr) {
        return send(res, 403, JSON.stringify({ ok: false, error: 'cross-origin request refused' }));
      }
    }
    var body = '';
    req.on('data', function (d) {
      body += d;
      if (body.length > 4096) req.destroy();   // do not buffer junk
    });
    req.on('end', function () {
      var j = {};
      try { j = JSON.parse(body); } catch (e) {}
      doControl(j.action, j.value, function (r) { send(res, 200, JSON.stringify(r)); });
    });
    return;
  }

  send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
});

var webEnabled = WEB_ENABLED;
var mqttEnabled = !!(CONFIG.mqtt && CONFIG.mqtt.enabled && CONFIG.mqtt.host);

/*
 * Refuse to sit there looking healthy while doing nothing. With both the
 * dashboard and the MQTT bridge switched off there is no reason for the
 * process to exist, and a silent no-op is harder to diagnose than an exit.
 */
if (!webEnabled && !mqttEnabled) {
  console.error('nothing to do: web.enabled is false and mqtt is not configured.');
  console.error('enable one of them in config.json.');
  process.exit(1);
}

(function checkBootAdBlock() {
  try {
    if (fs.existsSync(ADBLOCK_FLAG_FILE) && !isAdBlockActive() && fs.existsSync(ADBLOCK_HOSTS_FILE)) {
      execFile('/bin/mount', ['--bind', ADBLOCK_HOSTS_FILE, '/etc/hosts'], { timeout: 3000 }, function (err) {
        if (!err) console.log('adblock: restored /etc/hosts bind-mount from previous boot');
      });
    }
  } catch (e) {}
})();

if (webEnabled) {
  server.listen(CONFIG.port, CONFIG.host, function () {
    console.log('tvweb listening on ' + CONFIG.host + ':' + CONFIG.port +
                '  control=' + CONFIG.allowControl + '  power=' + CONFIG.allowPower +
                '  auth=' + (CONFIG.token ? 'token' : 'none'));
    detectOled(function () {});   // resolve and log panel type up front
  detectLogoLight(function () {});
  });
} else {
  console.log('web dashboard disabled (web.enabled=false) - mqtt bridge only');
  detectOled(function () {});
}

// ---------------------------------------------------------------- MiniMQTT Client (ES5)
function encodeVarLength(len) {
  var bytes = [];
  do {
    var digit = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) digit = digit | 0x80;
    bytes.push(digit);
  } while (len > 0);
  return (typeof Buffer.from === 'function') ? Buffer.from(bytes) : new Buffer(bytes);
}

function toBuffer(data, enc) {
  return (typeof Buffer.from === 'function') ? Buffer.from(data, enc) : new Buffer(data, enc);
}

function MiniMQTT(opts) {
  this.opts = opts || {};
  this.client = null;
  this.connected = false;
  this.packetId = 1;
  this.buffer = toBuffer([]);
  this.pingTimer = null;
  this.retryTimer = null;
  this.subscriptions = [];
  this.listeners = {};
}

MiniMQTT.prototype.on = function(event, fn) {
  this.listeners[event] = this.listeners[event] || [];
  this.listeners[event].push(fn);
};

MiniMQTT.prototype.emit = function(event, a, b) {
  var list = this.listeners[event] || [];
  for (var i = 0; i < list.length; i++) list[i](a, b);
};

MiniMQTT.prototype.connect = function() {
  var self = this;
  if (this.client) return;
  clearTimeout(this.retryTimer);

  /*
   * Plain TCP by default, since that is what a typical home broker listens on.
   * With mqtt.tls set, connect over TLS instead - otherwise the username and
   * password cross the LAN in cleartext inside every CONNECT packet, and a
   * reconnect loop resends them every few seconds.
   */
  var socket;
  if (this.opts.tls) {
    socket = tls.connect({
      host: this.opts.host,
      port: this.opts.port || 8883,
      servername: this.opts.host,
      // Self-signed broker certs are common on home networks. Turning this
      // off keeps the traffic encrypted but stops authenticating the broker,
      // so only do it on a network you trust.
      rejectUnauthorized: this.opts.tlsRejectUnauthorized !== false
    });
  } else {
    socket = net.createConnection({ host: this.opts.host, port: this.opts.port || 1883 });
  }
  this.client = socket;

  socket.on(self.opts.tls ? 'secureConnect' : 'connect', function() {
    var protoName = toBuffer([0, 4, 77, 81, 84, 84]); // 'MQTT'
    var protoLevel = toBuffer([4]); // 3.1.1
    var flags = 0x02; // CleanSession
    if (self.opts.will) {
      flags |= 0x04; // Will flag
      if (self.opts.will.retain) flags |= 0x20;
    }
    if (self.opts.username) flags |= 0x80;
    if (self.opts.password) flags |= 0x40;

    var flagBuf = toBuffer([flags]);
    var keepAlive = toBuffer([0, 60]); // 60s
    var varHeader = Buffer.concat([protoName, protoLevel, flagBuf, keepAlive]);

    var payloads = [];
    var cid = self.opts.clientId || ('lgtv_' + Math.random().toString(16).slice(2, 8));
    var cidBuf = toBuffer(cid, 'utf8');
    var cidLen = toBuffer([cidBuf.length >> 8, cidBuf.length & 0xff]);
    payloads.push(cidLen, cidBuf);

    if (self.opts.will) {
      var wtBuf = toBuffer(self.opts.will.topic, 'utf8');
      payloads.push(toBuffer([wtBuf.length >> 8, wtBuf.length & 0xff]), wtBuf);
      var wmBuf = toBuffer(self.opts.will.payload || '', 'utf8');
      payloads.push(toBuffer([wmBuf.length >> 8, wmBuf.length & 0xff]), wmBuf);
    }

    if (self.opts.username) {
      var uBuf = toBuffer(self.opts.username, 'utf8');
      payloads.push(toBuffer([uBuf.length >> 8, uBuf.length & 0xff]), uBuf);
    }
    if (self.opts.password) {
      var pBuf = toBuffer(self.opts.password, 'utf8');
      payloads.push(toBuffer([pBuf.length >> 8, pBuf.length & 0xff]), pBuf);
    }

    var payload = Buffer.concat(payloads);
    var remLen = encodeVarLength(varHeader.length + payload.length);
    var packet = Buffer.concat([toBuffer([0x10]), remLen, varHeader, payload]);
    socket.write(packet);
  });

  socket.on('data', function(chunk) {
    self.buffer = Buffer.concat([self.buffer, chunk]);
    self._parse();
  });

  socket.on('close', function() {
    var wasConnected = self.connected;
    self.connected = false;
    self.client = null;
    clearInterval(self.pingTimer);
    if (wasConnected) {
      console.log('mqtt: disconnected from ' + self.opts.host + ':' + (self.opts.port || (self.opts.tls ? 8883 : 1883)));
      self.emit('close');
    }
    self.retryTimer = setTimeout(function() { self.connect(); }, 5000);
  });

  socket.on('error', function(err) {
    self.emit('error', err);
    if (self.client) {
      self.client.destroy();
    }
  });
};

MiniMQTT.prototype._parse = function() {
  while (this.buffer.length >= 2) {
    var packetType = this.buffer[0] >> 4;
    var flags = this.buffer[0] & 0x0f;
    var multiplier = 1, remLen = 0, idx = 1, digit;
    do {
      if (idx >= this.buffer.length) return; // wait for more data
      digit = this.buffer[idx++];
      remLen += (digit & 127) * multiplier;
      multiplier *= 128;
    } while ((digit & 128) !== 0);

    var totalLen = idx + remLen;
    if (this.buffer.length < totalLen) return; // wait for full packet

    var packetBody = this.buffer.slice(idx, totalLen);
    this.buffer = this.buffer.slice(totalLen);

    if (packetType === 2) { // CONNACK
      var returnCode = packetBody[1];
      if (returnCode === 0) {
        this.connected = true;
        var self = this;
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(function() {
          if (self.client && self.connected) {
            self.client.write(toBuffer([0xc0, 0x00])); // PINGREQ
          }
        }, 30000);
        // Resubscribe to all saved subscriptions
        for (var i = 0; i < this.subscriptions.length; i++) {
          this._sendSubscribe(this.subscriptions[i]);
        }
        this.emit('connect');
      } else {
        this.emit('error', new Error('CONNACK rejected with code ' + returnCode));
      }
    } else if (packetType === 3) { // PUBLISH
      var qos = (flags >> 1) & 0x03;
      var tLen = (packetBody[0] << 8) | packetBody[1];
      var topic = packetBody.slice(2, 2 + tLen).toString('utf8');
      var pOffset = 2 + tLen;
      if (qos > 0) pOffset += 2; // skip packet identifier
      var payload = packetBody.slice(pOffset).toString('utf8');
      this.emit('message', topic, payload);
    }
  }
};

MiniMQTT.prototype._sendSubscribe = function(topic) {
  if (!this.client || !this.connected) return;
  var pid = this.packetId++;
  if (this.packetId > 65535) this.packetId = 1;
  var pidBuf = toBuffer([pid >> 8, pid & 0xff]);
  var tBuf = toBuffer(topic, 'utf8');
  var tLen = toBuffer([tBuf.length >> 8, tBuf.length & 0xff]);
  var qosBuf = toBuffer([0]);
  var payload = Buffer.concat([pidBuf, tLen, tBuf, qosBuf]);
  var remLen = encodeVarLength(payload.length);
  var packet = Buffer.concat([toBuffer([0x82]), remLen, payload]);
  this.client.write(packet);
};

MiniMQTT.prototype.subscribe = function(topic) {
  if (this.subscriptions.indexOf(topic) === -1) {
    this.subscriptions.push(topic);
  }
  this._sendSubscribe(topic);
};

MiniMQTT.prototype.publish = function(topic, message, retain) {
  if (!this.client || !this.connected) return;
  var firstByte = 0x30 | (retain ? 0x01 : 0x00);
  var tBuf = toBuffer(topic, 'utf8');
  var tLen = toBuffer([tBuf.length >> 8, tBuf.length & 0xff]);
  var mBuf = toBuffer(typeof message === 'string' ? message : JSON.stringify(message), 'utf8');
  var remLen = encodeVarLength(tLen.length + tBuf.length + mBuf.length);
  var packet = Buffer.concat([toBuffer([firstByte]), remLen, tLen, tBuf, mBuf]);
  this.client.write(packet);
};

MiniMQTT.prototype.disconnect = function() {
  if (this.client && this.connected) {
    try {
      this.client.write(toBuffer([0xe0, 0x00])); // DISCONNECT
    } catch (e) {}
    this.connected = false;
    try {
      this.client.end();
    } catch (e) {}
  }
};

// ---------------------------------------------------------------- Home Assistant Integration
function setupHomeAssistant() {
  if (!CONFIG.mqtt || !CONFIG.mqtt.enabled || !CONFIG.mqtt.host) {
    console.log('mqtt: disabled (no host configured)');
    return;
  }

  var pfx = CONFIG.mqtt.topicPrefix || 'lgtv';
  var discPfx = CONFIG.mqtt.discoveryPrefix || 'homeassistant';
  var devId = (CONFIG.device && CONFIG.device.id) || 'lg_b8_tv';
  var statusTopic = pfx + '/status';
  var telemetryTopic = pfx + '/telemetry';
  var stateScreenTopic = pfx + '/state/screen';
  var cmdScreenTopic = pfx + '/command/screen';
  var cmdMuteTopic = pfx + '/command/mute';
  var cmdVolTopic = pfx + '/command/volume';
  var cmdInputTopic = pfx + '/command/input';
  var cmdToastTopic = pfx + '/command/toast';

  var devInfo = {
    identifiers: [devId],
    name: (CONFIG.device && CONFIG.device.name) || 'LG webOS TV',
    model: (CONFIG.device && CONFIG.device.model) || 'webOS TV',
    manufacturer: (CONFIG.device && CONFIG.device.manufacturer) || 'LG',
    sw_version: (CONFIG.device && CONFIG.device.sw_version) || 'webOS (tvweb)'
  };

  var useTls = !!CONFIG.mqtt.tls;
  var mqttClient = new MiniMQTT({
    host: CONFIG.mqtt.host,
    port: CONFIG.mqtt.port || (useTls ? 8883 : 1883),
    tls: useTls,
    tlsRejectUnauthorized: CONFIG.mqtt.tlsRejectUnauthorized !== false,
    username: CONFIG.mqtt.username || null,
    password: CONFIG.mqtt.password || null,
    clientId: (CONFIG.mqtt.clientId || (devId + '_tvweb')),
    will: {
      topic: statusTopic,
      payload: 'offline',
      retain: true
    }
  });

  function publishDiscovery() {
    var entities = [
      {
        type: 'sensor', id: 'soc_temperature',
        payload: {
          name: 'SoC Temperature',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.temp }}',
          unit_of_measurement: '°C',
          device_class: 'temperature',
          state_class: 'measurement'
        }
      },
      {
        type: 'sensor', id: 'cpu_load',
        payload: {
          name: 'CPU Usage',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.load }}',
          unit_of_measurement: '%',
          state_class: 'measurement',
          icon: 'mdi:cpu-64-bit'
        }
      },
      {
        type: 'sensor', id: 'memory_usage',
        payload: {
          name: 'Memory Usage',
          state_topic: telemetryTopic,
          value_template: '{{ ((value_json.mem.total - value_json.mem.avail) / value_json.mem.total * 100) | round(1) if value_json.mem.total > 0 else 0 }}',
          unit_of_measurement: '%',
          icon: 'mdi:memory'
        }
      },
      {
        type: 'sensor', id: 'swap_usage',
        payload: {
          name: 'Swap Usage',
          state_topic: telemetryTopic,
          value_template: '{{ ((value_json.swap.total - value_json.swap.free) / value_json.swap.total * 100) | round(1) if value_json.swap.total > 0 else 0 }}',
          unit_of_measurement: '%',
          icon: 'mdi:server'
        }
      },
      {
        type: 'sensor', id: 'wifi_signal',
        payload: {
          name: 'Wi-Fi Signal',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.wifi.level if value_json.wifi else 0 }}',
          unit_of_measurement: 'dBm',
          device_class: 'signal_strength',
          state_class: 'measurement'
        }
      },
      {
        type: 'sensor', id: 'download_rate',
        payload: {
          name: 'Download Rate',
          state_topic: telemetryTopic,
          value_template: '{{ (value_json.net.rx / 1024) | round(1) if value_json.net else 0 }}',
          unit_of_measurement: 'kB/s',
          icon: 'mdi:download-network'
        }
      },
      {
        type: 'sensor', id: 'upload_rate',
        payload: {
          name: 'Upload Rate',
          state_topic: telemetryTopic,
          value_template: '{{ (value_json.net.tx / 1024) | round(1) if value_json.net else 0 }}',
          unit_of_measurement: 'kB/s',
          icon: 'mdi:upload-network'
        }
      },
      {
        type: 'sensor', id: 'flash_health',
        payload: {
          name: 'Flash Storage Health',
          state_topic: telemetryTopic,
          /* pre_eol_info, not the inverted wear band: emmc.health is derived
             from the same register as emmc.wear, so the two sensors were
             reporting one number twice. The name still fits - Normal, Warning
             and Urgent are exactly a health status. */
          value_template: '{{ value_json.emmc.eol }}',
          icon: 'mdi:harddisk'
        }
      },
      {
        type: 'sensor', id: 'flash_wear',
        payload: {
          name: 'Flash Wear Level',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.emmc.wear }}',
          icon: 'mdi:wrench-clock'
        }
      },
      {
        type: 'sensor', id: 'active_app',
        payload: {
          name: 'Active App',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.display_title or value_json.app_name or value_json.app }}',
          icon: 'mdi:television-play'
        }
      },
      {
        type: 'sensor', id: 'dynamic_range',
        payload: {
          name: 'Dynamic Range',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.picture.dynamicRange if value_json.picture else "SDR" }}',
          icon: 'mdi:video-vintage'
        }
      },
      {
        type: 'sensor', id: 'picture_mode',
        payload: {
          name: 'Picture Mode',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.picture.mode if value_json.picture else "Unknown" }}',
          icon: 'mdi:palette'
        }
      },
      {
        type: 'sensor', id: 'oled_light',
        payload: {
          name: 'OLED Light',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.picture.backlight if value_json.picture else 0 }}',
          unit_of_measurement: '%',
          icon: 'mdi:brightness-6'
        }
      },
      {
        type: 'sensor', id: 'video_signal',
        payload: {
          name: 'Video Signal',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.signal or "Internal / Standby" }}',
          icon: 'mdi:video-input-hdmi'
        }
      },
      {
        type: 'sensor', id: 'audio_output',
        payload: {
          name: 'Audio Output',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.audio_output or "internal" }}',
          icon: 'mdi:speaker'
        }
      },
      {
        type: 'sensor', id: 'soc_current',
        payload: {
          name: 'SoC Current',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.power.current_ma if value_json.power else 0 }}',
          unit_of_measurement: 'mA',
          device_class: 'current',
          state_class: 'measurement',
          icon: 'mdi:current-ac'
        }
      },
      {
        type: 'sensor', id: 'uptime',
        payload: {
          name: 'Uptime',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.uptime }}',
          unit_of_measurement: 's',
          device_class: 'duration',
          icon: 'mdi:clock-outline'
        }
      },
      {
        type: 'switch', id: 'display_panel',
        payload: {
          name: 'OLED Display Panel',
          command_topic: cmdScreenTopic,
          state_topic: stateScreenTopic,
          payload_on: 'ON',
          payload_off: 'OFF',
          icon: 'mdi:television-ambient-light'
        }
      },
      {
        type: 'switch', id: 'mute',
        payload: {
          name: 'Mute',
          command_topic: cmdMuteTopic,
          state_topic: telemetryTopic,
          value_template: '{{ \'ON\' if value_json.muted else \'OFF\' }}',
          payload_on: 'ON',
          payload_off: 'OFF',
          icon: 'mdi:volume-mute'
        }
      },
      {
        type: 'number', id: 'volume',
        payload: {
          name: 'Volume',
          command_topic: cmdVolTopic,
          state_topic: telemetryTopic,
          value_template: '{{ value_json.volume }}',
          min: 0,
          max: 100,
          step: 1,
          icon: 'mdi:volume-high'
        }
      },
      {
        type: 'select', id: 'input_source',
        payload: {
          name: 'Input Source',
          command_topic: cmdInputTopic,
          state_topic: telemetryTopic,
          value_template: '{{ value_json.app }}',
          options: ['hdmi1', 'hdmi2', 'hdmi3', 'hdmi4', 'livetv'],
          icon: 'mdi:video-input-hdmi'
        }
      },
      {
        type: 'text', id: 'screen_notification',
        payload: {
          name: 'Screen Notification',
          command_topic: cmdToastTopic,
          icon: 'mdi:message-text-outline',
          mode: 'text'
        }
      },
      {
        type: 'sensor', id: 'oled_panel_hours',
        payload: {
          name: 'OLED Panel Hours',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.panel_hours if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'total_increasing',
          icon: 'mdi:timer-outline'
        }
      },
      {
        type: 'sensor', id: 'oled_hours_since_compensation',
        payload: {
          name: 'OLED Hours Since Short Cycle',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.hours_since_comp if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'measurement',
          icon: 'mdi:progress-clock'
        }
      },
      {
        type: 'sensor', id: 'oled_hours_until_compensation',
        payload: {
          name: 'OLED Hours Until Short Cycle',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.hours_until_comp if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'measurement',
          icon: 'mdi:timer-sand'
        }
      },
      {
        type: 'sensor', id: 'oled_hours_since_refresher',
        payload: {
          name: 'OLED Hours Since Pixel Refresher',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.hours_since_refresher if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'measurement',
          icon: 'mdi:history'
        }
      },
      {
        type: 'sensor', id: 'oled_hours_until_refresher',
        payload: {
          name: 'OLED Hours Until Pixel Refresher',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.hours_until_refresher if value_json.oled else 0 }}',
          unit_of_measurement: 'h',
          state_class: 'measurement',
          icon: 'mdi:update'
        }
      },
      {
        type: 'sensor', id: 'oled_refresher_status',
        payload: {
          name: 'Pixel Refresher Status',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.refresher_status if value_json.oled else "Unknown" }}',
          icon: 'mdi:television-shimmer'
        }
      },
      {
        type: 'sensor', id: 'oled_screen_shift',
        payload: {
          name: 'OLED Screen Shift',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.screen_shift if value_json.oled else "Unknown" }}',
          icon: 'mdi:arrow-all'
        }
      },
      {
        type: 'sensor', id: 'oled_logo_dimming',
        payload: {
          name: 'OLED Logo Dimming',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.oled.logo_dimming if value_json.oled else "Unknown" }}',
          icon: 'mdi:television-guide'
        }
      },
      {
        type: 'switch', id: 'pixel_refresher_schedule',
        payload: {
          name: 'Schedule Pixel Refresher',
          command_topic: pfx + '/command/refresher',
          state_topic: telemetryTopic,
          value_template: '{{ \'ON\' if value_json.oled and value_json.oled.refresher_status == \'Scheduled\' else \'OFF\' }}',
          payload_on: 'schedule',
          payload_off: 'cancel',
          icon: 'mdi:television-shimmer'
        }
      },
      {
        type: 'select', id: 'picture_mode',
        payload: {
          name: 'Picture Mode',
          command_topic: pfx + '/command/picture_mode',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.picture.mode_raw if value_json.picture else "standard" }}',
          /* The settable modes depend on the dynamic range of what is playing,
             so this is whatever the TV last said it would accept. Discovery is
             republished when that set changes - see publishTelemetry. */
          options: lastPicModes.length
            ? lastPicModes.map(function (m) { return m.value; })
            : ['expert1', 'expert2', 'cinema', 'game', 'standard', 'eco', 'sports'],
          icon: 'mdi:image-filter-black-white'
        }
      },
      {
        type: 'select', id: 'sound_output',
        payload: {
          name: 'Sound Output',
          command_topic: pfx + '/command/sound_output',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.sound.output_raw if value_json.sound else "tv_speaker" }}',
          options: ['tv_speaker', 'external_arc', 'optical', 'headphone', 'bt_soundbar'],
          icon: 'mdi:speaker'
        }
      },
      {
        type: 'select', id: 'app',
        payload: {
          name: 'Launch App',
          command_topic: pfx + '/command/launch_app',
          state_topic: telemetryTopic,
          value_template: '{{ value_json.app }}',
          options: (function () {
            var opts = ['livetv', 'youtube.leanback.v4', 'netflix', 'amazon', 'spotify-beehive', 'com.apple.appletv'];
            if (installedApps && installedApps.length) {
              var merged = {};
              for (var o = 0; o < opts.length; o++) merged[opts[o]] = 1;
              for (var a = 0; a < installedApps.length; a++) merged[installedApps[a].id] = 1;
              return Object.keys(merged);
            }
            return opts;
          })(),
          icon: 'mdi:apps'
        }
      },
      {
        /*
         * Sleep timer. 15 is not an accepted value even though it looks like
         * one - the settings service rejects it. Valid: off, 10, 30, 60, 90, 120.
         */
        type: 'sensor', id: 'gpu_clock',
        payload: {
          name: 'GPU Clock', state_topic: telemetryTopic,
          value_template: '{{ value_json.gpuMhz }}',
          unit_of_measurement: 'MHz', state_class: 'measurement', icon: 'mdi:expansion-card'
        }
      },
      {
        type: 'sensor', id: 'panel_dimming',
        payload: {
          name: 'Panel Dimming', state_topic: telemetryTopic,
          value_template: '{{ value_json.dimming }}', icon: 'mdi:brightness-auto'
        }
      },
      {
        type: 'sensor', id: 'app_storage_free',
        payload: {
          name: 'App Storage Free', state_topic: telemetryTopic,
          value_template: '{{ (value_json.appStorage.freeMb / 1024) | round(1) if value_json.appStorage else none }}',
          unit_of_measurement: 'GB', state_class: 'measurement', icon: 'mdi:harddisk'
        }
      },
      {
        type: 'sensor', id: 'ambient_light',
        payload: {
          name: 'Ambient Light', state_topic: telemetryTopic,
          value_template: '{{ value_json.lightSensor.lux if value_json.lightSensor else none }}',
          device_class: 'illuminance', state_class: 'measurement', icon: 'mdi:brightness-5'
        }
      },
      {
        type: 'select', id: 'sleep_timer',
        payload: {
          name: 'Sleep Timer',
          command_topic: pfx + '/command/sleepTimer',
          state_topic: telemetryTopic,
          options: ['Off', '10 min', '30 min', '60 min', '90 min', '120 min'],
          command_template: '{{ {"Off":"off","10 min":"10","30 min":"30","60 min":"60","90 min":"90","120 min":"120"}[value] }}',
          value_template: '{{ {"off":"Off","10":"10 min","30":"30 min","60":"60 min","90":"90 min","120":"120 min"}.get(value_json.sleepTimer, "Off") }}',
          icon: 'mdi:timer-outline'
        }
      },
      {
        type: 'switch', id: 'standby_light',
        payload: {
          name: 'Standby LED',
          command_topic: pfx + '/command/standbyLight',
          state_topic: telemetryTopic,
          value_template: '{{ "ON" if value_json.lights and value_json.lights.standby else "OFF" }}',
          payload_on: 'on',
          payload_off: 'off',
          state_on: 'ON',
          state_off: 'OFF',
          icon: 'mdi:led-on'
        }
      },
      {
        type: 'switch', id: 'logo_light',
        payload: {
          name: 'Logo Light',
          command_topic: pfx + '/command/logoLight',
          state_topic: telemetryTopic,
          value_template: '{{ "ON" if value_json.lights and value_json.lights.logo else "OFF" }}',
          payload_on: 'on',
          payload_off: 'off',
          state_on: 'ON',
          state_off: 'OFF',
          icon: 'mdi:television-ambient-light'
        }
      },
      {
        type: 'button', id: 'screensaver',
        payload: {
          name: 'Start Screensaver',
          command_topic: pfx + '/command/screensaver',
          payload_press: 'press',
          icon: 'mdi:television-shimmer'
        }
      },
      {
        type: 'switch', id: 'ad_blocker',
        payload: {
          name: 'Ad & Telemetry Blocker',
          command_topic: pfx + '/command/adblock',
          state_topic: telemetryTopic,
          value_template: '{{ "ON" if value_json.privacy and value_json.privacy.adblock and value_json.privacy.adblock.enabled else "OFF" }}',
          payload_on: 'ON',
          payload_off: 'OFF',
          icon: 'mdi:shield-check'
        }
      },
      {
        type: 'button', id: 'play',
        payload: {
          name: 'Play',
          command_topic: pfx + '/command/playback',
          payload_press: 'play',
          icon: 'mdi:play'
        }
      },
      {
        type: 'button', id: 'pause',
        payload: {
          name: 'Pause',
          command_topic: pfx + '/command/playback',
          payload_press: 'pause',
          icon: 'mdi:pause'
        }
      },
      {
        type: 'button', id: 'play_pause',
        payload: {
          name: 'Play / Pause',
          command_topic: pfx + '/command/playback',
          payload_press: 'playPause',
          icon: 'mdi:play-pause'
        }
      },
      {
        type: 'button', id: 'stop',
        payload: {
          name: 'Stop',
          command_topic: pfx + '/command/playback',
          payload_press: 'stop',
          icon: 'mdi:stop'
        }
      }
    ];

    if (CONFIG.allowPower) {
      entities.push({
        type: 'button', id: 'restart',
        payload: {
          name: 'Restart TV',
          command_topic: pfx + '/command/reboot',
          device_class: 'restart',
          icon: 'mdi:restart'
        }
      });
      entities.push({
        type: 'button', id: 'power_off',
        payload: {
          name: 'Power Off TV',
          command_topic: pfx + '/command/powerOff',
          icon: 'mdi:power'
        }
      });
    }

    /*
     * Panel-lifecycle entities only exist on OLED. On an LCD/QNED set the
     * counters simply are not there, and publishing them would give Home
     * Assistant a permanently "unknown" sensor - or worse, a confident 0 that
     * looks like a real reading. Retained discovery configs are cleared so
     * they disappear from HA rather than lingering as orphans.
     */
    var OLED_ONLY = {
      oled_panel_hours: 1, oled_hours_since_compensation: 1,
      oled_hours_until_compensation: 1, oled_hours_since_refresher: 1,
      oled_hours_until_refresher: 1, oled_refresher_status: 1,
      oled_screen_shift: 1, oled_logo_dimming: 1,
      pixel_refresher_schedule: 1
    };
    /*
     * Withhold the ambient light entity on sets without the sensor. They still
     * answer getLightSensorData, reporting 65535, so the entity would sit at
     * "unknown" forever instead of simply not existing.
     */
    if (hasLogoLight === false) {
      var keptLogo = [];
      for (var g = 0; g < entities.length; g++) {
        if (entities[g].id === 'logo_light') {
          mqttClient.publish(discPfx + '/switch/' + devId + '/logo_light/config', '', true);
        } else { keptLogo.push(entities[g]); }
      }
      entities = keptLogo;
    }

    /*
     * Same reasoning on platforms with no thermal sensor at all (webOS 3.x):
     * publishing the entity would leave a temperature in Home Assistant that
     * is permanently unknown, which reads as a broken sensor rather than an
     * absent one.
     */
    if (!THERMAL_PRESENT) {
      var keptTemp = [];
      for (var t = 0; t < entities.length; t++) {
        if (entities[t].id === 'soc_temperature') {
          mqttClient.publish(discPfx + '/sensor/' + devId + '/soc_temperature/config', '', true);
        } else { keptTemp.push(entities[t]); }
      }
      entities = keptTemp;
    }

    /*
     * Same again for the eMMC wear counters, absent on webOS 3.x. An entity
     * reading "unknown" for the life of the install is indistinguishable from
     * a sensor that has broken.
     */
    if (!EMMC_WEAR_PRESENT) {
      var keptFlash = [];
      for (var f = 0; f < entities.length; f++) {
        if (entities[f].id === 'flash_health' || entities[f].id === 'flash_wear') {
          mqttClient.publish(discPfx + '/sensor/' + devId + '/' + entities[f].id + '/config', '', true);
        } else { keptFlash.push(entities[f]); }
      }
      entities = keptFlash;
    }

    if (!hasLightSensor) {
      var keptAmb = [];
      for (var a = 0; a < entities.length; a++) {
        if (entities[a].id === 'ambient_light') {
          mqttClient.publish(discPfx + '/sensor/' + devId + '/ambient_light/config', '', true);
        } else { keptAmb.push(entities[a]); }
      }
      entities = keptAmb;
    }

    if (isOled === false) {
      var kept = [];
      for (var d = 0; d < entities.length; d++) {
        if (OLED_ONLY[entities[d].id]) {
          var dead = discPfx + '/' + entities[d].type + '/' + devId + '/' + entities[d].id + '/config';
          mqttClient.publish(dead, '', true);   // retained empty = remove
        } else {
          kept.push(entities[d]);
        }
      }
      console.log('mqtt: not an OLED panel, withheld ' +
                  (entities.length - kept.length) + ' panel entities');
      entities = kept;
    }

    for (var i = 0; i < entities.length; i++) {
      var item = entities[i];
      var conf = item.payload;
      conf.unique_id = devId + '_' + item.id;
      conf.device = devInfo;
      conf.availability_topic = statusTopic;
      conf.payload_available = 'online';
      conf.payload_not_available = 'offline';

      var discTopic = discPfx + '/' + item.type + '/' + devId + '/' + item.id + '/config';
      mqttClient.publish(discTopic, JSON.stringify(conf), true);
    }

    if (devId !== 'lg_b8_tv') {
      for (var k = 0; k < entities.length; k++) {
        var oldDisc = discPfx + '/' + entities[k].type + '/lg_b8_tv/' + entities[k].id + '/config';
        mqttClient.publish(oldDisc, '', true);
      }
    }
    console.log('mqtt: published ' + entities.length + ' Home Assistant discovery entities');
  }

  var lastPicSig = '';

  function publishTelemetry() {
    if (!mqttClient.connected) return;
    mqttClient.publish(statusTopic, 'online', true);
    collectStats(function(s) {
      mqttClient.publish(telemetryTopic, JSON.stringify(s), false);
      /*
       * Reconcile the panel switch against what the TV actually reports.
       * It used to be published only when the command arrived over MQTT, so
       * blanking the panel from the dashboard, the remote, or the TV's own
       * menus left Home Assistant asserting the opposite indefinitely.
       * Driving it from powerState makes it self-correcting whatever the
       * change came from.
       */
      if (s.powerState && typeof s.powerState.screenOn === 'boolean') {
        mqttClient.publish(stateScreenTopic, s.powerState.screenOn ? 'ON' : 'OFF', true);
      }
      /*
       * The picture modes a set will accept change with the source's dynamic
       * range, and a select whose options cannot be applied is worse than no
       * select - Home Assistant would offer SDR modes against Dolby Vision
       * content and every one of them would be refused. The options live in
       * the discovery payload, so a changed set means republishing it.
       */
      var sig = ((s.picture && s.picture.modes) || []).map(function (m) {
        return m.value;
      }).join(',');
      if (sig && sig !== lastPicSig) {
        lastPicSig = sig;
        console.log('mqtt: picture modes changed (' + sig + ') - republishing discovery');
        publishDiscovery();
      }
    });
  }

  mqttClient.on('connect', function() {
    console.log('mqtt: connected to ' + CONFIG.mqtt.host + ':' + mqttClient.opts.port +
                (useTls ? ' (tls)' : ' (plaintext)'));
    mqttClient.publish(statusTopic, 'online', true);
    // Deliberately not asserting a screen state here: publishTelemetry below
    // sets it from what the TV reports. Publishing a retained 'ON' on every
    // reconnect meant a restart silently flipped Home Assistant back to on.
    // Resolve the panel type first: publishDiscovery filters on it, and on a
    // first connect it would otherwise still be undetermined.
    detectOled(function () { detectLogoLight(function () { publishDiscovery(); }); });
    mqttClient.subscribe(pfx + '/command/#');
    publishTelemetry();
  });

  mqttClient.on('message', function(topic, payload) {
    var prefix = pfx + '/command/';
    if (topic.indexOf(prefix) !== 0) return;
    var action = topic.substring(prefix.length);
    var val = payload ? payload.trim() : '';
    console.log('mqtt: command received: ' + action + ' -> ' + val);

    if (action === 'screen') {
      var turnOff = (val.toUpperCase() === 'OFF');
      doControl(turnOff ? 'screenOff' : 'screenOn', null, function(r) {
        if (r && r.ok) {
          mqttClient.publish(stateScreenTopic, turnOff ? 'OFF' : 'ON', true);
        }
      });
      return;
    }

    if (action === 'reboot') {
      doControl('reboot', null, function (r) {
        console.log('mqtt: reboot executed, result: ' + JSON.stringify(r));
      });
      return;
    }

    if (action === 'powerOff') {
      doControl('powerOff', null, function (r) {
        console.log('mqtt: powerOff executed, result: ' + JSON.stringify(r));
      });
      return;
    }

    if (action === 'mute') {
      doControl('mute', val.toUpperCase() === 'ON', function (r) {
        console.log('mqtt: mute set to ' + val + ', result: ' + JSON.stringify(r));
        setTimeout(publishTelemetry, 400);
      });
      return;
    }

    if (action === 'volume') {
      doControl('volume', num(val, 10), function (r) {
        console.log('mqtt: volume set to ' + val + ', result: ' + JSON.stringify(r));
        setTimeout(publishTelemetry, 400);
      });
      return;
    }

    if (action === 'input') {
      doControl('input', val.toLowerCase().replace(/\s+/g, ''), function() {
        setTimeout(publishTelemetry, 400);
      });
      return;
    }

    if (action === 'toast') {
      doControl('toast', val, function() {});
      return;
    }

    if (action === 'refresher') {
      var sch = (val.toLowerCase() === 'schedule' || val.toLowerCase() === 'on');
      doControl(sch ? 'refresherSchedule' : 'refresherCancel', null, function() {
        setTimeout(publishTelemetry, 400);
      });
      return;
    }

    doControl(action, val, function() {
      setTimeout(publishTelemetry, 400);
    });
  });

  mqttClient.on('error', function(err) {
    console.error('mqtt error:', err.message);
  });

  process.on('SIGTERM', function() {
    if (mqttClient) mqttClient.disconnect();
    process.exit(0);
  });
  process.on('SIGINT', function() {
    if (mqttClient) mqttClient.disconnect();
    process.exit(0);
  });

  var intervalMs = CONFIG.mqtt.telemetryIntervalMs || 10000;
  setInterval(publishTelemetry, intervalMs);

  mqttClient.connect();
}

/*
 * Liveness marker for the watchdog in tvwebctl.
 *
 * A wedged server keeps its port open and its process alive, so "is it
 * listening" proves nothing: on 2026-09-09 the loop froze inside libuv's
 * spawn path - a forked child deadlocked on a futex before reaching exec, so
 * the parent blocked forever reading the 4-byte exec-error pipe - and the
 * dashboard, MQTT and everything else stopped while the process looked fine.
 * A timer that stops firing is the signal that catches it. /var/run is tmpfs,
 * so this costs no flash writes.
 */
var BEAT_FILE = '/var/run/tvweb.beat';

/* Seconds, not milliseconds: the watchdog is busybox ash, whose arithmetic is
   32-bit, and a 13-digit millisecond stamp overflows it into nonsense. */
function heartbeat() {
  fs.writeFile(BEAT_FILE, String(Math.floor(Date.now() / 1000)), function () {});
}

heartbeat();
setInterval(heartbeat, 20000);

detectDeviceInfo(function() {
  setupHomeAssistant();
});
