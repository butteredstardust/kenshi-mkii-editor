'use strict';

// Hidden, single-instance, health-polling launcher for the installed Kenshi
// MKII Editor. Starts the Node server detached with no console window, waits
// for /api/health, then opens the default browser.
//
// The single-instance guarantee matters more here than for an ordinary web app:
// two servers over one save directory could interleave a backup with a write.
// A PID lockfile plus an identity check on /api/health means only one install
// ever owns the loopback port, and --stop refuses to kill anything that is not
// demonstrably this installation's server.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { version: APP_VERSION } = require('../package.json');

const APP_DIR = path.resolve(__dirname, '..');
const NODE_EXE = path.join(__dirname, 'node.exe');
const SERVER_JS = path.join(APP_DIR, 'server.js');

const PORT = Number(process.env.KENSHI_MKII_PORT) || 3080;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const HEALTH_URL = `${BASE_URL}/api/health`;
const APP_ID = 'kenshi-mkii-editor';

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const APP_DATA_DIR = path.join(LOCALAPPDATA, 'KenshiMKIIEditor');
const LOCK_FILE = path.join(APP_DATA_DIR, 'kenshi-mkii-editor.lock');

const MAX_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 500;

function readPid() {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeLock(pid) {
  fs.mkdirSync(APP_DATA_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, String(pid), { mode: 0o600 });
}

function clearLock(expectedPid = null) {
  try {
    const current = readPid();
    if (expectedPid === null || current === expectedPid || current === null) fs.rmSync(LOCK_FILE, { force: true });
  } catch {
    /* a stale lock we cannot remove is not worth failing the launch over */
  }
}

function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (raw.length < 64 * 1024) raw += chunk; });
      res.on('end', () => {
        try {
          const body = JSON.parse(raw);
          const identified = body.appId === APP_ID && typeof body.appVersion === 'string';
          const owned = identified && body.appVersion === APP_VERSION;
          resolve({ reachable: true, identified, owned, ready: owned && body.ok === true, appVersion: identified ? body.appVersion : null });
        } catch {
          resolve({ reachable: true, identified: false, owned: false, ready: false });
        }
      });
    });
    req.on('error', () => resolve({ reachable: false, identified: false, owned: false, ready: false }));
    req.setTimeout(1000, () => { req.destroy(); resolve({ reachable: false, identified: false, owned: false, ready: false }); });
  });
}

function openBrowser(url = BASE_URL) {
  const child = spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' });
  child.unref();
}

function waitForHealth() {
  const deadline = Date.now() + MAX_WAIT_MS;
  return new Promise((resolve) => {
    const tick = async () => {
      const health = await healthCheck();
      if (health.reachable || Date.now() >= deadline) return resolve(health);
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
  });
}

function startServer() {
  const child = spawn(NODE_EXE, [SERVER_JS], {
    cwd: APP_DIR,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, KENSHI_MKII_PORT: String(PORT) },
  });
  child.unref();
  return child.pid;
}

function getProcessInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform !== 'win32') return null;
  try {
    const script = [
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}" -ErrorAction Stop`,
      '$p | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
    ].join('; ');
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5000 }));
  } catch {
    return null;
  }
}

function samePath(left, right) {
  return typeof left === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

/** Only a `bin\node.exe server.js` from *this* install counts as ours to stop. */
function isInstalledServerProcess(pid, info = getProcessInfo(pid)) {
  if (!info || Number(info.ProcessId) !== pid || !samePath(info.ExecutablePath, NODE_EXE)) return false;
  const args = String(info.CommandLine || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const unquote = value => value.replace(/^"|"$/g, '');
  return args.length >= 2 && samePath(unquote(args[0]), NODE_EXE) && samePath(unquote(args[1]), SERVER_JS);
}

function stopServer() {
  const pid = readPid();
  if (!pid || !pidAlive(pid)) {
    clearLock(pid);
    return 0;
  }
  if (!isInstalledServerProcess(pid)) {
    console.error('Refusing to stop a process that does not match this installation.');
    return 4;
  }
  try {
    process.kill(pid);
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 5000;
    while (pidAlive(pid) && Date.now() < deadline) Atomics.wait(waitArray, 0, 0, 100);
    if (!pidAlive(pid)) {
      clearLock(pid);
      return 0;
    }
    console.error('The installed editor server did not exit in time.');
    return 4;
  } catch {
    console.error('The installed editor server could not be stopped.');
    return 4;
  }
}

async function main() {
  if (process.argv.slice(2).includes('--stop')) return stopServer();

  const lockPid = readPid();
  const initialHealth = await healthCheck();
  if (initialHealth.reachable && !initialHealth.owned) {
    const detail = initialHealth.identified ? `a different editor version (${initialHealth.appVersion})` : 'another application';
    console.error(`Port ${PORT} is occupied by ${detail}.`);
    return 3;
  }

  const lockMatches = !!(lockPid && pidAlive(lockPid) && isInstalledServerProcess(lockPid));
  if (lockPid && !lockMatches && !initialHealth.owned) clearLock(lockPid);

  if (lockMatches || initialHealth.owned) {
    const health = initialHealth.owned ? initialHealth : await waitForHealth();
    if (!health.reachable) {
      console.error('The editor process exists but its local service is unavailable.');
      return 2;
    }
    if (!health.owned) {
      console.error(`Port ${PORT} is occupied by another application.`);
      return 3;
    }
    openBrowser();
    return 0;
  }

  const pid = startServer();
  if (!pid) {
    console.error('Failed to start the editor server.');
    return 1;
  }
  writeLock(pid);
  const health = await waitForHealth();
  if (!health.reachable) {
    clearLock(pid);
    console.error('The editor server did not become ready in time.');
    return 2;
  }
  if (!health.owned) {
    console.error(`Port ${PORT} was claimed by another application.`);
    return 3;
  }
  openBrowser();
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { APP_ID, APP_VERSION, healthCheck, isInstalledServerProcess, main, samePath, stopServer };
