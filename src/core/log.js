/**
 * src/core/log.js
 *
 * Opt-in shared log for every Reflux process and window.  Off unless REFLUX_LOG is set;
 * then lines append to logs/reflux.log next to settings.json (same platform rules as
 * src/core/settings.js).
 *
 * API:
 *   line(where, detail)        — one timestamped entry
 *   enabled()                  — whether writing happens at all
 *   registerIpc(ipcMain)       — call once from main process to wire the relay
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Storage path
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const APPDATA = process.env.APPDATA
  || path.join(process.env.USERPROFILE || HOME, 'AppData', 'Roaming');
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');

const DATA_DIR = process.platform === 'win32'
  ? path.join(APPDATA, 'Reflux')
  : process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support', 'Reflux')
    : path.join(XDG_CONFIG_HOME, 'Reflux');

const LOG_FILE = path.join(DATA_DIR, 'logs', 'reflux.log');

// Read per call so restarting the app with the variable set turns logging on.
function enabled() {
  return process.env.REFLUX_LOG !== undefined && process.env.REFLUX_LOG !== '';
}

/**
 * @param {string} where   plugin or subsystem tag, e.g. 'voiceTrayStatus'
 * @param {any}    detail  message body; long payloads are cut, never dropped silently
 */
function line(where, detail) {
  if (!enabled()) return;
  const entry = `[${new Date().toISOString()}] ${where}${detail === undefined || detail === '' ? '' : `: ${detail}`}`.slice(0, 4200);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), {recursive: true});
    fs.appendFileSync(LOG_FILE, `${entry}\n`);
  } catch { /* logging must never break a plugin */ }
}

// Renderer windows have no readable console in production; refluxBridge.log() relays them here.
function registerIpc(ipcMain) {
  ipcMain.on('reflux:log', (_event, entry) => {
    if (entry && typeof entry === 'object') line(String(entry.where ?? 'renderer'), entry.detail);
    else line('renderer', entry);
  });
}

module.exports = {line, enabled, registerIpc, LOG_FILE};
