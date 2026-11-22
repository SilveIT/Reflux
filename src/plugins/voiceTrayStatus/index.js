/**
 * Voice capture status on Fluxer's tray icon: mic on, speaking, muted, deafened.
 * A red unread dot is composited into whichever glyph is showing.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const {app, BrowserWindow, Tray, nativeImage} = electron;

const log = require('../../core/log.js');
const {definePlugin, OptionType} = require('../../core/pluginApi');

const CHANNEL = 'tray-runtime-state-update';   // Fluxer's own renderer → main voice bridge
const BADGE_CHANNELS = ['set-unread-badge', 'set-badge-count'];   // unread/mention counts
const ICON_DIR = path.join(__dirname, 'assets');
const DEBOUNCE = 200;

let icons = null;             // glyph key → nativeImage | null
let dotted = new Map();       // glyph with the unread dot painted in
let appTray = null;           // Fluxer's Tray instance, captured through its own calls
let lastAppImage = null;      // glyph Fluxer last asked the tray to show
let payload = {};             // latest voice fields reported by Fluxer
let unread = 0;
let speaking = undefined;     // renderer tier: true | false | unknown
let state = 'idle';
let timer = null;
let applying = false;         // set while this plugin writes the tray itself
let askedRepaint = false;
let nudging = false;          // badge emits this plugin makes itself
let captured = 0;             // times Fluxer's own setImage was seen
let patched = false;

const origSetImage = Tray.prototype.setImage;
const origSetToolTip = Tray.prototype.setToolTip;

function loadIcons() {
  if (icons) return icons;
  icons = {};
  for (const key of ['connected', 'speaking', 'muted', 'deafened']) {
    const img = nativeImage.createFromPath(path.join(ICON_DIR, `${key}.png`));
    icons[key] = img.isEmpty() ? null : img;
  }
  return icons;
}


// Paint the dot into a copy of the shown glyph, as Fluxer overlays its badge.
function withUnread(key, base) {
  if (!base || base.isEmpty()) return null;
  const cached = dotted.get(key);
  if (cached) return cached;
  const bmp = base.bitmap;
  const data = Buffer.from(bmp.data);
  const s = Math.min(bmp.width, bmp.height);
  const cx = s * 0.805, cy = s * 0.805, r = s * 0.164;   // bottom-right, 42/128 of the canvas
  for (let y = Math.max(0, Math.floor(cy - r - 1)); y <= Math.min(bmp.height - 1, Math.ceil(cy + r + 1)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r - 1)); x <= Math.min(bmp.width - 1, Math.ceil(cx + r + 1)); x++) {
      const cov = Math.min(1, Math.max(0, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5));
      if (cov <= 0) continue;
      const i = (y * bmp.width + x) * 4;
      data[i] += (0x47 - data[i]) * cov;          // B
      data[i + 1] += (0x47 - data[i + 1]) * cov;  // G
      data[i + 2] += (0xf0 - data[i + 2]) * cov;  // R — #f04747
      data[i + 3] = 255;                             // opaque dot
    }
  }
  const img = nativeImage.createFromBitmap({width: bmp.width, height: bmp.height, data});
  dotted.set(key, img);
  return img;
}

// Payloads cross a process boundary, so validate before use.
function readPayload(data) {
  if (!data || typeof data !== 'object') return false;
  for (const key of ['voiceConnected', 'selfMute', 'selfDeaf']) {
    if (typeof data[key] === 'boolean') payload[key] = data[key];
  }
  if (typeof data.voiceSpeaking === 'boolean') speaking = data.voiceSpeaking;
  return true;
}

// Deafened first: Fluxer couples it with selfMute, so checking muted hid the deafened glyph.
function resolveState() {
  if (!payload.voiceConnected) return 'idle';
  if (payload.selfDeaf) return 'deafened';
  if (payload.selfMute) return 'muted';
  return speaking === true ? 'speaking' : 'connected';
}

function tooltipText() {
  const label = {
    idle: 'not in voice',
    connected: 'in voice, mic on',
    speaking: 'in voice, speaking',
    muted: 'in voice, mic off',
    deafened: 'in voice, deafened',
  };
  return `Fluxer — ${label[state]}${unread > 0 ? ` · ${unread} unread` : ''}`;
}

// Only Fluxer's own tray is ever touched; with its tray preference off we stay out of the way.
function tray() {
  return appTray && !appTray.isDestroyed() ? appTray : null;
}

// Our writes bypass the capture hook so Fluxer's glyph is not mistaken for ours.
function writeImage(target, image) {
  applying = true;
  try { target.setImage(image); } finally { applying = false; }
}

/**
 * Fluxer hands its glyph to the Tray constructor and repaints only when its asset key
 * `${tone}:${unread !== 0}` moves, so a count must cross zero: emit the far side, then the real
 * value. Its handler validates the sender frame, hence the live window's mainFrame; both emits go
 * out synchronously so our own count listener only ever sees the final number.
 */
function askFluxerToRepaint() {
  const before = captured;
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    let frame = null;
    try { frame = w.webContents.mainFrame; } catch {}
    if (!frame || frame.detached || frame.parent) continue;   // needs a live top-level document
    const nudge = unread > 0 ? 0 : 1;   // the crossing that moves Fluxer's key
    for (const count of [nudge, unread]) emitBadge(frame, count);
    return captured > before;
  }
  return false;
}

// The nudging guard stops these counts re-entering onCount below, which would ping-pong forever.
function emitBadge(frame, count) {
  nudging = true;
  try { electron.ipcMain.emit('set-unread-badge', {senderFrame: frame}, count); }
  catch (err) { log.line('voiceTrayStatus', `repaint nudge failed: ${err.message}`); }
  finally { nudging = false; }
}

// Record Fluxer's idle glyph before the first status paint, so leaving voice can hand it back.
function primeAppGlyph() {
  if (lastAppImage) return true;
  askFluxerToRepaint();
  if (!lastAppImage) requestNativeThemeNudge();   // builds redrawing on a light/dark change instead
  return !!lastAppImage;
}

// One nudge for builds that repaint on theme change rather than badge count.
function requestNativeThemeNudge() {
  if (askedRepaint) return false;
  askedRepaint = true;
  const before = captured;
  try { electron.nativeTheme.emit('updated'); } catch {}
  return captured > before;
}

// Voice over: give back Fluxer's own glyph so its tray-icon preference survives. Choosing a file
// here once ignored that preference, which is how a monochrome setup came up coloured at launch.
function restoreIdleGlyph() {
  if (askFluxerToRepaint() || requestNativeThemeNudge()) return null;   // Fluxer repainted it
  if (lastAppImage) return lastAppImage;                            // fall back to what we captured
  log.line('voiceTrayStatus', 'idle: no glyph available');
  return null;
}

let lastPainted = '';
function logIfChanged(text) {
  if (text === lastPainted) return;
  lastPainted = text;
  log.line('voiceTrayStatus', text);
}

function applyState() {
  const t = tray();
  if (!t || t.isDestroyed()) return;
  const art = state === 'idle' ? null : (loadIcons()[state] || null);
  if (art) primeAppGlyph();
  const showDot = Boolean(plugin.settingsStore?.get('unreadDot') ?? true);
  const icon = !art ? null : (showDot && unread > 0 ? withUnread(state, art) : art);
  try {
    if (icon) {
      logIfChanged(`paint ${state}${showDot && unread > 0 ? '+unread' : ''}`);
      writeImage(t, icon);
    } else {
      const own = restoreIdleGlyph();
      if (own) writeImage(t, own);
    }
    t.setToolTip(tooltipText());
  } catch (err) { log.line('voiceTrayStatus', `tray update failed: ${err.message}`); }
}

function schedule() {
  state = resolveState();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; applyState(); }, DEBOUNCE);
}

// Fluxer constructs its tray and sets a tooltip right away, which is how these hooks find the instance.
// Writes with applying=false are Fluxer's own, so they also record its base glyph.
function patchTray() {
  if (patched) return;
  patched = true;
  Tray.prototype.setImage = function (image) {
    appTray = this;
    if (!applying && image) { lastAppImage = image; captured++; }
    return origSetImage.call(this, image);
  };
  Tray.prototype.setToolTip = function (text) {
    appTray = this;
    return origSetToolTip.call(this, text);
  };
}

function unpatchTray() {
  if (!patched) return;
  patched = false;
  Tray.prototype.setImage = origSetImage;
  Tray.prototype.setToolTip = origSetToolTip;
}

function onState(event, data) {
  if (!readPayload(data)) return;
  schedule();
}

// Unread counts arrive on Fluxer's own channels; anything non-numeric means nothing unread.
function onCount(event, data) {
  if (nudging) return;                    // this plugin's own nudge, not a count Fluxer reported
  const n = Number.isFinite(data) ? Math.max(0, Math.floor(data)) : 0;
  if (n === unread) return;
  unread = n;
  schedule();
}

const plugin = definePlugin({
  name: 'voiceTrayStatus',
  displayName: 'Voice Tray Status',
  description: 'Shows voice capture status on the tray icon (mic on, speaking, muted, deafened) and paints a red unread dot when Fluxer reports unread messages.',
  icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 512 512" fill="currentColor"><path d="M303.32,65.58C317.44,77.62,326.81,93.48,329,112c.58,9.28,.45,18.6,.43,27.89c.01,2.04,.01,4.07,.01,6.1c.02,6.37,.02,12.74,.01,19.11c-.02,6.52,0,13.05,.03,19.57c.02,5.65,.02,11.29,.02,16.94c0,3.35,0,6.7,.01,10.06c.1,24.21-1.84,45.98-19.24,64.25c-15.14,15.13-33.06,21.28-54.08,21.52c-20.75-.13-38.64-5.69-53.54-20.59c-19.03-20.43-20.12-42.17-20.08-68.74c-.01-2.04-.01-4.07-.01-6.1c-.02-6.37-.02-12.74-.01-19.11c.02-6.52,0-13.05-.03-19.57c-.02-5.65-.02-11.29-.02-16.94c0-3.35,0-6.7-.01-10.06c-.1-24.21,1.84-45.98,19.24-64.25c26.11-26.1,72.33-30.01,101.59-6.5Z"/><path d="M149,269c.21,.57,.21,.57,1.29,3.48c11.16,29.78,29.21,53.62,58.4,67.4c27.81,12.51,58.04,13.87,86.75,3.31c28.4-11.12,49.91-31.83,62.09-59.65c1.99-4.79,3.8-9.63,5.47-14.54c7.93,1.31,15.65,3.09,23.41,5.15c1.14,.3,2.28,.6,3.45,.91c2.38,.64,4.75,1.27,7.13,1.91c3.66,.97,7.32,1.93,10.97,2.89c2.32,.62,4.64,1.23,6.95,1.85c1.1,.29,2.2,.57,3.33,.87c1.01,.27,2.01,.54,3.05,.83c.89,.23,1.77,.47,2.69,.71c.67,.29,1.33,.58,2.02,.88c1.11,3.32,.94,3.91-.15,7.07c-.28,.81-.56,1.61-.84,2.44c-.31,.86-.63,1.73-.95,2.62c-.32,.89-.64,1.78-.97,2.7c-16.04,43.85-48.68,80.68-91.13,100.58c-13.24,5.98-26.97,10.86-41.25,13.66c-.88,.18-1.77,.35-2.68,.53c-.67,.13-1.34,.27-2.03,.4c0,.65-.01,1.3-.01,1.98c-.04,6.83-.11,13.66-.2,20.49c-.03,2.54-.05,5.08-.06,7.63c-.02,3.67-.07,7.34-.12,11.01c0,1.13,0,2.25,0,3.41c-.16,8.56-1.87,15.91-6.3,23.29c-7.45,7.05-15.28,10.73-25.62,10.51c-6.78-.81-13.94-3.3-18.69-8.32c-7.21-9.31-8.3-16.95-8.41-28.5c-.01-.59-.01-.59-.06-3.6c-.06-3.78-.11-7.56-.15-11.34c-.04-2.57-.08-5.14-.12-7.71c-.1-6.28-.18-12.57-.26-18.85c-.58-.13-1.17-.27-1.77-.41c-2.71-.62-5.41-1.25-8.12-1.88c-.92-.21-1.84-.42-2.78-.64c-15.32-3.6-29.53-9.59-43.33-17.07c-1.07-.58-2.14-1.15-3.24-1.75c-38.2-21.45-66.9-58.35-79.92-99.96c-.67-2.42-1.27-4.84-1.84-7.29c6.98-2.41,14.02-4.44,21.15-6.36c1.13-.3,2.27-.61,3.44-.92c2.38-.65,4.76-1.29,7.14-1.93c3.66-.98,7.31-1.97,10.96-2.96c2.32-.62,4.64-1.25,6.96-1.87c1.09-.3,2.19-.6,3.31-.9c1.01-.27,2.03-.54,3.07-.82c.89-.24,1.78-.48,2.7-.73C146,269,146,269,149,269Z"/></svg>',
  rendererSrc: path.join(__dirname, 'renderer-side.js'),   // injected at dom-ready
  settings: {
    unreadDot: {
      label: 'Unread dot',
      description: 'Paints a red dot into the shown glyph while Fluxer reports unread messages.',
      type: OptionType.BOOLEAN,
      default: true,
    },
  },

  start() {
    patchTray();
    electron.ipcMain.on(CHANNEL, onState);
    for (const c of BADGE_CHANNELS) electron.ipcMain.on(c, onCount);
    log.line('voiceTrayStatus', `started; icons ${Object.keys(loadIcons()).length} loaded; renderer ${fs.existsSync(path.join(__dirname, 'renderer-side.js')) ? 'found' : 'MISSING'}`);
    // Nothing at boot: Fluxer draws its own icon until voice connects.
    app.whenReady().then(applyState);
  },

  stop() {
    log.line('voiceTrayStatus', 'stopped');
    electron.ipcMain.removeListener(CHANNEL, onState);
    for (const c of BADGE_CHANNELS) electron.ipcMain.removeListener(c, onCount);
    unpatchTray();
    if (timer) clearTimeout(timer);
    timer = null;
    const t = tray();
    if (t && lastAppImage) writeImage(t, lastAppImage);   // hand Fluxer's glyph back
    appTray = null;
    payload = {};
    nudging = false;
    unread = 0;
    dotted = new Map();   // painted copies are per-session
    askedRepaint = false;
    captured = 0;
    lastPainted = '';
    state = 'idle';
  },
});

module.exports = plugin;
