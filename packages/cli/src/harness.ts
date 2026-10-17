/**
 * The `moydan dev` preview harness.
 *
 * A creator needs to see the *real* sandbox constraints locally, so the preview
 * server does two things:
 *
 *   1. serves the built artifact with the game origin's CSP headers, so a game
 *      that would be blocked in production fails here too;
 *   2. serves a harness page that embeds it in an iframe with exactly the
 *      sandbox attributes `GameHost` uses, and speaks bridge protocol v1 to it
 *      (handshake, lifecycle commands, storage requests, score capture).
 *
 * Both the page and the host shim are plain strings so the CLI stays a single
 * self-contained bundle: the harness page itself contains no inline script, so
 * it also survives a strict `script-src 'self'` policy.
 */

export interface DevConfig {
  slug: string;
  title: string;
  engine: string;
  entry: string;
  apiVersion: string;
  capabilities: string[];
  viewport: { width: number; height: number; scale: 'fit' | 'cover' | 'stretch' };
  orientation: 'portrait' | 'landscape' | 'any';
  params: Record<string, number | boolean | string>;
  /** Where the shim should load the built artifact from. */
  artifactEntry: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderHarnessHtml(config: DevConfig): string {
  // Serialised into a non-executable script block: the parser reads it as data,
  // so no inline JavaScript is needed for the page to bootstrap the shim.
  const configJson = JSON.stringify(config).replace(/</g, '\\u003c');
  const params = Object.entries(config.params)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>moydan dev — ${escapeHtml(config.title)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0b12;color:#e9e9f5;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;align-items:baseline;gap:12px;padding:10px 16px;border-bottom:1px solid #22223a}
header h1{font-size:15px;margin:0}
header span{color:#8a8ab0;font-size:12px}
main{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:16px;padding:16px;align-items:start}
.stage{display:flex;justify-content:center;min-height:70vh}
iframe{width:min(420px,100%);aspect-ratio:${config.viewport.width} / ${config.viewport.height};border:1px solid #2b2b45;border-radius:12px;background:#07070d}
.panel{background:#11111d;border:1px solid #22223a;border-radius:12px;padding:12px}
.panel h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#8a8ab0;margin:0 0 8px}
.buttons{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
button{background:#1d1d30;color:#e9e9f5;border:1px solid #34344f;border-radius:8px;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer}
button:hover{background:#26263f}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin:0 0 12px;font-size:12px}
dt{color:#8a8ab0}
dd{margin:0;font-variant-numeric:tabular-nums}
#log{max-height:38vh;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0c0c15;border:1px solid #1d1d33;border-radius:8px;padding:8px;margin:0;white-space:pre-wrap}
#log .warn{color:#ffcf6b}
#log .error{color:#ff8a8a}
#log .score{color:#8affc1}
@media (max-width:900px){main{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(config.title)}</h1>
  <span>${escapeHtml(config.slug)} · ${escapeHtml(config.engine)} · runtime API v${escapeHtml(config.apiVersion)} · preview harness</span>
</header>
<main>
  <div class="stage">
    <iframe id="game-frame" title="${escapeHtml(config.title)} (game)" src="${escapeHtml(config.artifactEntry)}"
      sandbox="allow-scripts allow-same-origin allow-pointer-lock"
      allow="autoplay; fullscreen; gamepad; vibrate" referrerpolicy="no-referrer"></iframe>
  </div>
  <section class="panel">
    <h2>Host controls</h2>
    <div class="buttons">
      <button id="btn-pause">Pause</button>
      <button id="btn-resume">Resume</button>
      <button id="btn-restart">Restart</button>
      <button id="btn-mute">Mute</button>
      <button id="btn-hide">Hide</button>
      <button id="btn-reset">Reset storage</button>
      <button id="btn-reload">Reload</button>
    </div>
    <dl>
      <dt>state</dt><dd id="state">connecting</dd>
      <dt>last score</dt><dd id="score">—</dd>
      <dt>params</dt><dd>${escapeHtml(params || 'none')}</dd>
      <dt>caps</dt><dd>${escapeHtml(config.capabilities.join(', ') || 'none')}</dd>
    </dl>
    <h2>Bridge log</h2>
    <pre id="log"></pre>
  </section>
</main>
<script type="application/json" id="moydan-dev-config">${configJson}</script>
<script type="module" src="/dev-host.js"></script>
</body>
</html>
`;
}

/**
 * Bridge host shim served at `/dev-host.js`.
 *
 * Written in plain ES5-style JavaScript on purpose: it is served as text, never
 * compiled, and must not use template literals so it can live inside a
 * TypeScript template string without escaping every `${`.
 */
export const HOST_SHIM_JS = `// moydan dev host shim: bridge protocol v1, the minimum a real host must do.
const config = JSON.parse(document.getElementById('moydan-dev-config').textContent);
const frame = document.getElementById('game-frame');
const logEl = document.getElementById('log');
const scoreEl = document.getElementById('score');
const stateEl = document.getElementById('state');
const PREFIX = 'moydan';
const PROTOCOL = 1;
const STORAGE_PREFIX = 'moydan.dev.' + config.slug + '.';
let sequence = 0;
let muted = false;
let initialised = false;

function bridgeId() {
  sequence += 1;
  const random = Math.floor(Math.random() * 0xffffff).toString(16);
  return 'dev' + sequence.toString(16) + random;
}

function send(type, payload) {
  if (!frame.contentWindow) return;
  const envelope = { protocol: PROTOCOL, id: bridgeId(), type: PREFIX + ':' + type };
  if (payload !== undefined) envelope.payload = payload;
  frame.contentWindow.postMessage(envelope, '*');
}

function setState(state) {
  stateEl.textContent = state;
}

function log(level, text) {
  const at = new Date().toISOString().slice(11, 23);
  const entry = document.createElement('div');
  if (level === 'warn' || level === 'error' || level === 'score') entry.className = level;
  entry.textContent = at + '  ' + text;
  logEl.prepend(entry);
  while (logEl.childNodes.length > 200) logEl.removeChild(logEl.lastChild);
}

function storageKey(key) {
  return STORAGE_PREFIX + key;
}

function storageGet(key) {
  const raw = window.localStorage.getItem(storageKey(key));
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function respond(requestId, ok, result, error) {
  const payload = { requestId: requestId, ok: ok };
  if (ok) payload.result = result === undefined ? null : result;
  else payload.error = String(error).slice(0, 200);
  send('res', payload);
}

function handleRequest(payload) {
  const params = payload.params || {};
  const key = typeof params.key === 'string' ? params.key : '';
  if (!key && payload.method !== 'storage.clear') {
    respond(payload.id, false, undefined, 'storage requests need a key');
    return;
  }
  try {
    if (payload.method === 'storage.get') respond(payload.id, true, storageGet(key));
    else if (payload.method === 'storage.set') {
      window.localStorage.setItem(storageKey(key), JSON.stringify(params.value === undefined ? null : params.value));
      respond(payload.id, true, null);
    } else if (payload.method === 'storage.remove') {
      window.localStorage.removeItem(storageKey(key));
      respond(payload.id, true, null);
    } else if (payload.method === 'storage.clear') {
      for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
        const name = window.localStorage.key(index);
        if (name && name.indexOf(STORAGE_PREFIX) === 0) window.localStorage.removeItem(name);
      }
      respond(payload.id, true, null);
    } else {
      respond(payload.id, false, undefined, 'unsupported method ' + payload.method);
    }
  } catch (error) {
    respond(payload.id, false, undefined, error && error.message ? error.message : error);
  }
}

function init() {
  send('init', {
    releaseId: 'dev-' + config.slug,
    gameId: 'dev-' + config.slug,
    gameTitle: config.title,
    params: config.params,
    capabilities: config.capabilities,
    apiVersion: config.apiVersion,
    locale: 'en-GB',
    viewport: config.viewport,
    orientation: config.orientation,
    muted: muted,
    sessionId: 'devsession-' + Math.floor(Math.random() * 0xffffff).toString(16),
    preview: true,
    limits: { heartbeatMs: 2000, maxMessageBytes: 8192, messagesPerSecond: 30 },
  });
  initialised = true;
  setState('initialising');
}

function handle(message) {
  const type = typeof message.type === 'string' ? message.type.slice(PREFIX.length + 1) : '';
  const payload = message.payload || {};
  if (type === 'ready') {
    if (!initialised) init();
    window.setTimeout(function () { send('start'); }, 0);
    return;
  }
  if (type === 'req') {
    handleRequest({ id: message.id, method: payload.method, params: payload.params });
    return;
  }
  if (type === 'started') {
    setState('running');
    log('info', 'started in ' + payload.msToStart + ' ms');
    return;
  }
  if (type === 'restarted') {
    setState('running');
    log('info', 'restarted (instance ' + payload.instanceCount + ')');
    return;
  }
  if (type === 'paused') {
    setState('paused');
    return;
  }
  if (type === 'resumed') {
    setState('running');
    return;
  }
  if (type === 'score') {
    scoreEl.textContent = payload.value + (payload.unit ? ' ' + payload.unit : '');
    log('score', 'score ' + payload.value + (payload.difficulty ? ' (' + payload.difficulty + ')' : ''));
    return;
  }
  if (type === 'ended') {
    setState('ended: ' + payload.reason);
    log('info', 'ended (' + payload.reason + ') score=' + (payload.score === undefined ? '-' : payload.score));
    return;
  }
  if (type === 'error') {
    log('error', 'game error' + (payload.fatal ? ' (fatal)' : '') + ': ' + payload.message);
    return;
  }
  if (type === 'log') {
    log(payload.level || 'info', payload.message || '');
    return;
  }
  if (type === 'heartbeat') return;
}

window.addEventListener('message', function (event) {
  if (!frame.contentWindow || event.source !== frame.contentWindow) return;
  const message = event.data;
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
  handle(message);
});

document.getElementById('btn-pause').addEventListener('click', function () { send('pause'); });
document.getElementById('btn-resume').addEventListener('click', function () { send('resume'); });
document.getElementById('btn-restart').addEventListener('click', function () { send('restart'); setState('restarting'); });
document.getElementById('btn-mute').addEventListener('click', function () {
  muted = !muted;
  send('mute', { muted: muted });
  this.textContent = muted ? 'Unmute' : 'Mute';
});
document.getElementById('btn-hide').addEventListener('click', function () {
  send('visibility', { visible: false });
  send('pause');
  frame.style.visibility = 'hidden';
  this.textContent = 'Show';
  setState('hidden');
});
document.getElementById('btn-reset').addEventListener('click', function () {
  send('req', { method: 'storage.clear', params: {} });
  log('info', 'storage cleared');
});
document.getElementById('btn-reload').addEventListener('click', function () {
  frame.contentWindow.location.reload();
});

// The server pushes a reload event when the watcher rebuilt the project.
const events = new EventSource('/events');
events.addEventListener('reload', function () {
  log('info', 'rebuilt — reloading');
  frame.contentWindow.location.reload();
});

frame.addEventListener('load', function () {
  if (!initialised) log('info', 'artifact loaded, waiting for mo:ready');
});
setState('connecting');
`;
