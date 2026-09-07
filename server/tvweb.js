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
var url = require('url');
var net = require('net');
var child_process = require('child_process');
var execFile = child_process.execFile;

// ---------------------------------------------------------------- config
var CONFIG = {
  port: 8080,
  host: '0.0.0.0',      // '127.0.0.1' to keep it TV-local only

  // Anyone who can reach this port can use the controls below.
  allowControl: true,   // volume, screen off/on, input switching, toast

  // Power off / reboot are OFF by default on purpose: this server has no
  // authentication, and you do not want a stray request killing the TV
  // mid-film. Flip to true only if you understand that.
  allowPower: true,

  // Optional shared secret. If non-empty, every /api/ request must carry
  // ?k=<token>. Keeps casual LAN devices out.
  token: '',

  // Home Assistant & MQTT Integration
  mqtt: {
    enabled: true,
    host: '192.168.1.125',
    port: 1883,
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

function loadConfig() {
  var paths = ['/var/lib/tvweb/config.json', './config.json'];
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
        console.log('loaded configuration from ' + paths[i]);
        break;
      }
    } catch (e) {
      console.error('warning: error reading config from ' + paths[i] + ':', e.message);
    }
  }
}
loadConfig();

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
  var eol = (eolRaw && EOL_MAP[eolRaw.trim()]) ? EOL_MAP[eolRaw.trim()] : 'Normal';
  if (!raw) return { life: 'unknown', wear: 'unknown', health: '>90% (Healthy)', eol: eol };

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
  var wearStr = wearList.length ? wearList.join(' / ') : '0-10%';
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

/* luna-send wrapper via execFile directly, avoiding /bin/sh and shell child leaks.
 * -w 2000 tells luna-send itself to time out after 2 seconds.
 * timeout: 3500 ensures Node kills the child process if it ever stalls.
 */
function luna(uri, payload, cb) {
  var args = ['-n', '1', '-w', '2000', '-f', 'luna://' + uri, JSON.stringify(payload || {})];
  execFile('/usr/bin/luna-send', args, { timeout: 3500 }, function (err, stdout) {
    var parsed = null;
    if (!err && stdout) {
      try { parsed = JSON.parse(stdout); } catch (e) {}
    }
    if (cb) cb(parsed, String(stdout || ''));
  });
}

function detectDeviceInfo(cb) {
  luna('com.webos.service.tv.systemproperty/getSystemInfo',
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

// ---------------------------------------------------------------- stats
var prevNet = null;
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
    temp: num(rd('/proc/lg/pm/temperature'), null),
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

  // Refresh input names if cache expired
  refreshInputNames();

  // Chained Luna queries: sound -> foregroundApp -> picture settings
  luna('com.webos.audio/getSoundOut', {}, function (sound) {
    if (sound) {
      out.volume = sound.volume;
      out.muted = !!sound.muted;
      out.audio_output = sound.scenario || 'internal';
    }
    luna('com.webos.applicationManager/getForegroundAppInfo', {}, function (app) {
      if (app && app.appId) {
        var shortApp = String(app.appId).replace('com.webos.app.', '');
        out.app = shortApp;
        out.app_name = inputNameMap[shortApp] || shortApp;
        out.display_title = (inputNameMap[shortApp] && inputNameMap[shortApp] !== shortApp) ?
          (inputNameMap[shortApp] + ' (' + shortApp.toUpperCase() + ')') : shortApp;
      }
      luna('com.webos.service.settings/getSystemSettings',
        { category: 'picture', keys: ['backlight', 'pictureMode', 'energySaving'] },
        function (pic) {
          if (pic && pic.settings) {
            var rawDr = (pic.dimension && pic.dimension.dynamicRange) ? pic.dimension.dynamicRange : 'sdr';
            out.picture = {
              dynamicRange: formatDynamicRange(rawDr),
              mode: formatPicMode(pic.settings.pictureMode),
              mode_raw: pic.settings.pictureMode || 'standard',
              backlight: num(pic.settings.backlight, 50),
              energySaving: pic.settings.energySaving || 'off'
            };
          }
          flushStats(out);
        }
      );
    });
  });
}

// ---------------------------------------------------------------- controls
var INPUTS = { hdmi1: 1, hdmi2: 1, hdmi3: 1, hdmi4: 1, livetv: 1 };

function doControl(action, value, cb) {
  if (!CONFIG.allowControl) return cb({ ok: false, error: 'controls disabled in config' });

  switch (action) {
    case 'volume':
      return luna('com.webos.audio/media/setVolume',
                  { volume: Math.max(0, Math.min(100, num(value, 10))) },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'volumeStep':
      return luna('com.webos.audio/media/offsetVolume',
                  { offset: num(value, 1) },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'mute':
      return luna('com.webos.audio/media/setMuted',
                  { muted: value === 'true' || value === true },
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

    case 'toast':
      return luna('com.webos.notification/createToast',
                  { sourceId: 'tvweb', message: String(value || 'hello').slice(0, 120) },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'powerOff':
      if (!CONFIG.allowPower) return cb({ ok: false, error: 'power actions disabled (set allowPower)' });
      return luna('com.webos.service.tvpower/power/powerOff', { reason: 'tvweb' },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    case 'reboot':
      if (!CONFIG.allowPower) return cb({ ok: false, error: 'power actions disabled (set allowPower)' });
      return luna('com.webos.service.tvpower/power/reboot', { reason: 'tvweb' },
                  function (r) { cb({ ok: !!(r && r.returnValue) }); });

    default:
      return cb({ ok: false, error: 'unknown action' });
  }
}

// ---------------------------------------------------------------- page
/* Served to a phone/laptop browser, so modern JS is fine in HERE. */
var PAGE = [
'<!doctype html><html><head><meta charset="utf-8">',
'<meta name="viewport" content="width=device-width,initial-scale=1">',
'<title>LG TV</title><style>',
':root{--bg:#0f1115;--card:#171a21;--fg:#e6e9ef;--dim:#8b93a7;--ok:#41d18b;--warn:#e8b84b;--crit:#f2665e;--acc:#5aa9e6}',
'*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);',
'font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px;max-width:760px;margin:0 auto}',
'h1{font-size:17px;margin:0 0 4px;font-weight:600}',
'.sub{color:var(--dim);font-size:13px;margin-bottom:16px}',
'.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}',
'.card{background:var(--card);border-radius:12px;padding:14px}',
'.lbl{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.06em}',
'.val{font-size:26px;font-weight:600;margin:4px 0;font-variant-numeric:tabular-nums}',
'.bar{height:7px;background:#252a35;border-radius:4px;overflow:hidden;margin-top:8px}',
'.fill{height:100%;border-radius:4px;transition:width .4s}',
'.meta{color:var(--dim);font-size:12px;margin-top:6px}',
'.cores{display:flex;gap:6px;margin-top:8px}.core{flex:1;text-align:center;background:#252a35;border-radius:6px;padding:3px;font-size:11px}',
'button{background:#252a35;color:var(--fg);border:0;border-radius:9px;padding:11px 8px;font-size:14px;cursor:pointer;font-weight:500}',
'button:active{background:var(--acc)}',
'.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(78px,1fr));gap:8px;margin-top:10px}',
'.danger{background:#3a1f24}.off{opacity:.45}',
'#err{background:#3a1f24;color:var(--crit);padding:10px;border-radius:9px;margin-bottom:12px;display:none}',
'</style></head><body>',
'<h1><span id="devname">LG TV</span> &middot; <span id="app">-</span></h1>',
'<div class="sub" id="sub">connecting...</div>',
'<div id="err"></div>',
'<div class="grid">',
'  <div class="card"><div class="lbl">Temperature</div><div class="val"><span id="temp">-</span>&deg;C</div>',
'    <div class="bar"><div class="fill" id="tempbar"></div></div><div class="meta" id="tempmeta"></div></div>',
'  <div class="card"><div class="lbl">CPU &middot; Power</div><div class="val"><span id="cpu">-</span>%</div>',
'    <div class="bar"><div class="fill" id="cpubar"></div></div><div class="cores" id="cores"></div><div class="meta" id="cpumeta"></div></div>',
'  <div class="card"><div class="lbl">Video &middot; Picture</div><div class="val" id="hdr">-</div>',
'    <div class="meta" id="picmeta">-</div></div>',
'  <div class="card"><div class="lbl">Audio &middot; <span id="vol">-</span></div><div class="val" id="audiomode">-</div>',
'    <div class="meta" id="audiometa">-</div></div>',
'  <div class="card"><div class="lbl">Memory</div><div class="val"><span id="mem">-</span>%</div>',
'    <div class="bar"><div class="fill" id="membar"></div></div><div class="meta" id="memmeta"></div></div>',
'  <div class="card"><div class="lbl">Flash storage</div><div class="val" id="emmc">-</div><div class="meta" id="emmcmeta"></div></div>',
'  <div class="card"><div class="lbl">Network</div><div class="val" id="rssi">-</div><div class="meta" id="netmeta"></div></div>',
'  <div class="card"><div class="lbl">Swap (zram)</div><div class="val"><span id="swap">-</span>%</div>',
'    <div class="bar"><div class="fill" id="swapbar"></div></div><div class="meta" id="swapmeta"></div></div>',
'</div>',
'<div class="card" style="margin-top:12px"><div class="lbl">Volume</div>',
'  <div class="row"><button onclick="c(\'volumeStep\',-5)">Vol &minus;</button>',
'  <button onclick="c(\'volumeStep\',5)">Vol +</button>',
'  <button onclick="c(\'mute\',true)">Mute</button>',
'  <button onclick="c(\'mute\',false)">Unmute</button></div>',
'  <div class="lbl" style="margin-top:14px">Screen</div>',
'  <div class="row"><button onclick="c(\'screenOff\')">Screen off</button>',
'  <button onclick="c(\'screenOn\')">Screen on</button></div>',
'  <div class="lbl" style="margin-top:14px">Input</div>',
'  <div class="row"><button id="btn_hdmi1" onclick="c(\'input\',\'hdmi1\')">HDMI 1</button>',
'  <button id="btn_hdmi2" onclick="c(\'input\',\'hdmi2\')">HDMI 2</button>',
'  <button id="btn_hdmi3" onclick="c(\'input\',\'hdmi3\')">HDMI 3</button>',
'  <button id="btn_hdmi4" onclick="c(\'input\',\'hdmi4\')">HDMI 4</button>',
'  <button id="btn_livetv" onclick="c(\'input\',\'livetv\')">Live TV</button></div>',
'  <div class="lbl" style="margin-top:14px">Power</div>',
'  <div class="row"><button class="danger" id="poff" onclick="pw(\'powerOff\')">Power off</button>',
'  <button class="danger" id="prb" onclick="pw(\'reboot\')">Reboot</button></div>',
'  <div class="meta" id="pwnote"></div>',
'</div>',
'<script>',
'const K=new URLSearchParams(location.search).get("k")||"";',
'const q=s=>document.getElementById(s);',
'const col=(v,w,c)=>v>=c?"var(--crit)":v>=w?"var(--warn)":"var(--ok)";',
'function setBar(id,pct,w,cr){const e=q(id);e.style.width=Math.max(0,Math.min(100,pct))+"%";e.style.background=col(pct,w,cr);}',
'const mb=k=>(k/1024).toFixed(0).replace(/\\B(?=(\\d{3})+(?!\\d))/g,",")+" MB";',
'async function c(a,v){try{const r=await fetch("/api/control?k="+encodeURIComponent(K),{method:"POST",',
'  headers:{"Content-Type":"application/json"},body:JSON.stringify({action:a,value:v})});',
'  const j=await r.json(); if(!j.ok) showErr(j.error||"action failed"); else q("err").style.display="none";',
'  setTimeout(tick,350);}catch(e){showErr(e.message);}}',
'function pw(a){if(confirm("Really "+a+" the TV?"))c(a);}',
'function showErr(m){const e=q("err");e.textContent=m;e.style.display="block";}',
'let tHist=[];',
'async function tick(){',
' try{const r=await fetch("/api/stats?k="+encodeURIComponent(K));',
'  if(!r.ok){showErr("HTTP "+r.status+(r.status===401?" - bad or missing token":""));return;}',
'  const d=await r.json(); q("err").style.display="none";',
'  if(d.device&&d.device.name){q("devname").textContent=d.device.name;document.title=d.device.name+(d.app?(" · "+(d.display_title||d.app)):"");}',
'  q("app").textContent=d.display_title||d.app_name||d.app||"-";',
'  const up=d.uptime,h=Math.floor(up/3600),m=Math.floor(up%3600/60);',
'  q("sub").textContent="up "+h+"h "+m+"m  ·  "+d.mhz+" MHz  ·  load "+(d.loadavg||[]).join(" ");',
'  q("temp").textContent=d.temp; setBar("tempbar",d.temp,60,75);',
'  tHist.push(d.temp); if(tHist.length>200)tHist.shift();',
'  q("tempmeta").textContent="min "+Math.min(...tHist)+"°  max "+Math.max(...tHist)+"°";',
'  q("cpu").textContent=d.load; setBar("cpubar",d.load,60,85);',
'  q("cores").innerHTML=(d.cores||[]).map((c,i)=>"<div class=core>c"+i+"<br>"+c+"%</div>").join("");',
'  q("cpumeta").textContent=d.power&&d.power.current_ma?("SoC: "+d.power.current_ma+" mA (CPU "+d.power.cpu_ma+" · Core "+d.power.core_ma+")"):"";',
'  if(d.picture){',
'    q("hdr").textContent=d.picture.dynamicRange||"SDR";',
'    q("picmeta").textContent=d.picture.mode+" · OLED Light "+d.picture.backlight+"%"+(d.signal?(" · "+d.signal):"");',
'  } else {',
'    q("hdr").textContent="-";',
'    q("picmeta").textContent=d.signal||"-";',
'  }',
'  const audioMap={mastervolume_headphone:"Optical / Headphone",tv_speaker:"TV Speaker",external_arc:"HDMI ARC",soundbar:"Soundbar"};',
'  q("audiomode").textContent=audioMap[d.audio_output]||d.audio_output||"Internal";',
'  q("audiometa").textContent="Volume "+d.volume+(d.muted?" (muted)":"");',
'  const mu=d.mem.total?100*(d.mem.total-d.mem.avail)/d.mem.total:0;',
'  q("mem").textContent=mu.toFixed(0); setBar("membar",mu,75,90);',
'  q("memmeta").textContent=mb(d.mem.total-d.mem.avail)+" used · "+mb(d.mem.avail)+" free";',
'  const su=d.swap.total?100*(d.swap.total-d.swap.free)/d.swap.total:0;',
'  q("swap").textContent=su.toFixed(0); setBar("swapbar",su,40,70);',
'  q("swapmeta").textContent=mb(d.swap.total-d.swap.free)+" of "+mb(d.swap.total)+" (zram)";',
'  q("rssi").textContent=d.wifi?d.wifi.level+" dBm":"wired";',
'  q("netmeta").textContent=d.net?("down "+(d.net.rx/1024).toFixed(0)+" KB/s · up "+(d.net.tx/1024).toFixed(0)+" KB/s"):"";',
'  q("emmc").textContent=d.emmc.health||">90%";',
'  q("emmcmeta").textContent=(d.emmc.wear||d.emmc.life)+" wear · EOL: "+d.emmc.eol;',
'  q("vol").textContent=(d.muted?"muted":d.volume);',
'  if(d.inputs){',
'    if(d.inputs.hdmi1) q("btn_hdmi1").textContent=d.inputs.hdmi1;',
'    if(d.inputs.hdmi2) q("btn_hdmi2").textContent=d.inputs.hdmi2;',
'    if(d.inputs.hdmi3) q("btn_hdmi3").textContent=d.inputs.hdmi3;',
'    if(d.inputs.hdmi4) q("btn_hdmi4").textContent=d.inputs.hdmi4;',
'  }',
' }catch(e){showErr("TV unreachable - "+e.message);}}',
'fetch("/api/caps?k="+encodeURIComponent(K)).then(r=>r.json()).then(c=>{',
'  if(!c.allowPower){q("poff").classList.add("off");q("prb").classList.add("off");',
'   q("pwnote").textContent="Power actions disabled in tvweb.js (allowPower:false).";}});',
'tick(); setInterval(tick,2000);',
'</script></body></html>'
].join('\n');

// ---------------------------------------------------------------- server
function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function authed(q) {
  return !CONFIG.token || q.k === CONFIG.token;
}

http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  var path = u.pathname;

  if (path === '/' || path === '/index.html') {
    return send(res, 200, PAGE, 'text/html; charset=utf-8');
  }

  if (path.indexOf('/api/') === 0 && !authed(u.query)) {
    return send(res, 401, JSON.stringify({ ok: false, error: 'bad or missing token' }));
  }

  if (path === '/api/caps') {
    return send(res, 200, JSON.stringify({
      ok: true, allowControl: CONFIG.allowControl, allowPower: CONFIG.allowPower
    }));
  }

  if (path === '/api/stats') {
    return collectStats(function (s) { send(res, 200, JSON.stringify(s)); });
  }

  if (path === '/api/control' && req.method === 'POST') {
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
}).listen(CONFIG.port, CONFIG.host, function () {
  console.log('tvweb listening on ' + CONFIG.host + ':' + CONFIG.port +
              '  control=' + CONFIG.allowControl + '  power=' + CONFIG.allowPower +
              '  auth=' + (CONFIG.token ? 'token' : 'none'));
});

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

  var socket = net.createConnection({ host: this.opts.host, port: this.opts.port || 1883 });
  this.client = socket;

  socket.on('connect', function() {
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
      console.log('mqtt: disconnected from ' + self.opts.host + ':' + (self.opts.port || 1883));
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

  var mqttClient = new MiniMQTT({
    host: CONFIG.mqtt.host,
    port: CONFIG.mqtt.port || 1883,
    username: CONFIG.mqtt.username || null,
    password: CONFIG.mqtt.password || null,
    clientId: devId + '_' + Math.random().toString(16).slice(2, 6),
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
          value_template: '{{ value_json.emmc.health }}',
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

  function publishTelemetry() {
    if (!mqttClient.connected) return;
    collectStats(function(s) {
      mqttClient.publish(telemetryTopic, JSON.stringify(s), false);
    });
  }

  mqttClient.on('connect', function() {
    console.log('mqtt: connected to ' + CONFIG.mqtt.host + ':' + (CONFIG.mqtt.port || 1883));
    mqttClient.publish(statusTopic, 'online', true);
    mqttClient.publish(stateScreenTopic, 'ON', true);
    publishDiscovery();
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
      doControl('reboot', null, function() {});
      return;
    }

    if (action === 'powerOff') {
      doControl('powerOff', null, function() {});
      return;
    }

    if (action === 'mute') {
      doControl('mute', val.toUpperCase() === 'ON', function() {
        setTimeout(publishTelemetry, 400);
      });
      return;
    }

    if (action === 'volume') {
      doControl('volume', num(val, 10), function() {
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

    doControl(action, val, function() {
      setTimeout(publishTelemetry, 400);
    });
  });

  mqttClient.on('error', function(err) {
    console.error('mqtt error:', err.message);
  });

  var intervalMs = CONFIG.mqtt.telemetryIntervalMs || 10000;
  setInterval(publishTelemetry, intervalMs);

  mqttClient.connect();
}

detectDeviceInfo(function() {
  setupHomeAssistant();
});
