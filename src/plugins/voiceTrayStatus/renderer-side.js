/**
 * Renderer side: reports whether *you* are speaking, so the tray can show that state.
 * Fluxer renders that answer twice (member list, voice status panel) from one module's exports, so
 * wrapping every exported function whose source mentions "speaking" taps what the GUI reads; arguments
 * carry `isLocal` / `isLocalConnection`, which marks you. Webpack/Rspack installs those exports with
 * non-writable descriptors, so a wrapper that cannot be assigned in place is delivered as a replacement
 * exports object instead. Reports ride Fluxer's own bridge (`window.electron.setTrayRuntimeState`).
 */
(function voiceTrayStatusRenderer() {
  'use strict';
  if (window.__reflux_voiceTrayStatus_loaded) return;
  window.__reflux_voiceTrayStatus_loaded = true;

  const NAME = 'voiceTrayStatus';
  // The UI has two spellings: the participant tile (`data-lk-*`) and the avatar stack (`data-speaking`).
  const SPEAKING_ATTRS = ['data-lk-speaking', 'data-speaking'];
  const SELF_ATTRS = ['data-lk-local-participant', 'data-flx-user-self'];

  let observer = null, holdTimer = null;
  let patches = null, ownRegistry = false;   // registry we create only when Reflux gave us none
  let engineSpeaking;   // undefined until one of Fluxer's own voice views answers | true | false
  let reported;         // last value handed to main, so repeats are skipped
  let hooked = false;   // at least one voice view now runs through this plugin
  const undo = [];      // {holder, key, prev} for wrappers installed in place

  const checked = new WeakMap();   // fn → true|false; the patch filter runs on every module cache read

  function truthy(el, name) {
    // React serialises data-* booleans as "true"/"false"; omitting the attribute also reads false.
    const v = el.getAttribute(name);
    return v !== null && v !== 'false';
  }

  function selfSpeakingInDom() {
    for (const attr of SPEAKING_ATTRS) {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        // Your own flag may sit on the speaking element or an ancestor (a tile wraps its chip).
        let self = false;
        for (let node = el, depth = 0; node && depth < 8 && !self; depth++, node = node.parentElement) {
          self = SELF_ATTRS.some((a) => truthy(node, a));
        }
        if (!self) continue;
        if (truthy(el, attr)) return true;   // any element carrying your state wins
      }
    }
    return false; // no voice UI mounted: not in voice, or the voice view is closed
  }

  // LiveKit rebuilds its participant tile on re-render and a fresh one reads as not speaking for a
  // moment, so "speaking" latches immediately while "not speaking" must survive HOLD_MS; when that timer
  // fires it re-reads the DOM. Fluxer's own view is authoritative and skips the hold.
  const HOLD_MS = 1200;

  function sample(ignoreHold = false) {
    const fromEngine = typeof engineSpeaking === 'boolean';
    const value = fromEngine ? engineSpeaking : selfSpeakingInDom();
    if (value === reported) {
      if (holdTimer != null) { clearTimeout(holdTimer); holdTimer = null; }   // recovered while waiting
      return;
    }
    if (!value && reported === true && !ignoreHold && !fromEngine) {
      if (holdTimer == null) holdTimer = setTimeout(() => { holdTimer = null; sample(true); }, HOLD_MS);
      return;   // keep showing speaking through tile churn
    }
    if (holdTimer != null) { clearTimeout(holdTimer); holdTimer = null; }
    reported = value;
    window.electron?.setTrayRuntimeState?.({voiceSpeaking: value});
  }

  function marksSelf(value, depth = 1) {
    if (!value || typeof value !== 'object') return false;
    if (value.isLocal === true || value.isLocalConnection === true) return true;
    if (depth > 0) {
      // Views pass the participant directly or nested under `snapshot` / `participant`.
      for (const key of ['participant', 'snapshot']) if (marksSelf(value[key], depth - 1)) return true;
    }
    return false;
  }

  function speakingFrom(result) {
    if (result && typeof result === 'object' && typeof result.speaking === 'boolean') return result.speaking;
    if (typeof result === 'boolean') return result;
    return null;   // not one of Fluxer's voice views: leave the state alone
  }

  function looksLikeVoiceView(fn) {
    if (typeof fn !== 'function' || typeof fn.toString !== 'function') return false;
    if (fn.__refluxVoiceTray) return true;   // ours already: skip, never re-wrap
    const memo = checked.get(fn);
    if (memo !== undefined) return memo;
    let answer = false;
    try {
      const src = fn.toString();
      // Components also mention "speaking"; wrapping one costs nothing since its result is not a voice
      // view. Skip sources too large to scan per cache read.
      if (src.length < 20000) answer = /speaking/i.test(src);
    } catch {}
    checked.set(fn, answer);
    return answer;
  }

  function wrapVoiceView(fn) {
    const wrapped = function (...args) {
      const result = fn.apply(this, args);
      const value = speakingFrom(result);
      if (value !== null && args.some((a) => marksSelf(a))) {
        engineSpeaking = value;   // only your own participant counts towards the tray tier
        sample();
      }
      return result;
    };
    wrapped.__refluxVoiceTray = true;
    return wrapped;
  }

  // Reports the first voice view that runs through this plugin, so "hooked" is visible after startup.
  let reportedHook = false;

  function install(holder, key, wrapped) {
    try {
      const prev = holder[key];
      holder[key] = wrapped;   // throws or is ignored on non-writable descriptors
      if (holder[key] !== wrapped) return false;
      undo.push({holder, key, prev});
      hooked = true;
      if (!reportedHook) { reportedHook = true; window.__reflux?.log?.('voiceTrayStatus', 'voice view hooked live'); }
      return true;
    } catch { return false; }
  }

  function ownValues(obj) {
    // Exports are marked `enumerable: !1`, so for-in and Object.keys would miss every voice view.
    const out = [];
    for (const key of Object.getOwnPropertyNames(obj)) {
      try { out.push([key, obj[key]]); } catch {}   // a getter may throw; skip that key
    }
    return out;
  }

  function copyOwn(obj) {
    const clone = {};
    for (const key of Object.getOwnPropertyNames(obj)) {
      let desc;
      try { desc = Object.getOwnPropertyDescriptor(obj, key); } catch {}
      if (!desc) continue;
      // Accessor exports are read once into a value; consumers only ever call them.
      try { clone[key] = desc.get === undefined ? desc.value : obj[key]; } catch {}
    }
    return clone;
  }

  function tapExports(exports) {
    if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) return undefined;
    if (exports.__refluxVoiceTrayTap) return undefined;   // the patch re-runs on every cache read
    let clone = null, installedNow = 0, blocked = 0;
    for (const [key, value] of ownValues(exports)) {
      if (!looksLikeVoiceView(value) || value.__refluxVoiceTray) continue;
      const wrapped = wrapVoiceView(value);
      if (install(exports, key, wrapped)) { installedNow++; continue; }
      blocked++;
      clone ??= copyOwn(exports);
      try { clone[key] = wrapped; } catch {}
    }
    if (blocked) {
      try { clone.__refluxVoiceTrayTap = true; } catch {}
      hooked = true;
      return clone;   // the patcher assigns a callback's return value to module.exports
    }
    if (installedNow) { try { exports.__refluxVoiceTrayTap = true; } catch {} }
    return undefined;
  }

  function hasVoiceView(exports) {
    if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) return false;
    if (exports.__refluxVoiceTrayTap) return true;
    return ownValues(exports).some(([, v]) => looksLikeVoiceView(v));
  }

  function start(patcher, api) {
    // patchLoaded applies to matching modules already loaded and keeps watching for later ones.
    patches ??= this.patches ?? (ownRegistry = true, patcher.createRegistry(NAME));
    patches.patchLoaded(hasVoiceView, tapExports);
    observer = new MutationObserver(() => sample());
    // Tiles come and go as the voice view opens, closes or re-renders: watch attributes plus node churn.
    observer.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: [...SPEAKING_ATTRS, ...SELF_ATTRS],
    });
    sample();
    // Rspack keeps its module cache in a closure, so the tap only lands when Fluxer loads voice
    // views later; until then the DOM flags below are what drives this state.
    api?.log?.(NAME, `voice view engine tap ${hooked ? 'active' : 'pending; DOM fallback driving'}`);
  }

  function stop() {
    try { observer?.disconnect(); } catch {}
    observer = null;
    if (holdTimer != null) { clearTimeout(holdTimer); holdTimer = null; }
    if (ownRegistry) patches?.dispose();
    patches = null; ownRegistry = false;
    while (undo.length) { const {holder, key, prev} = undo.pop(); try { holder[key] = prev; } catch {} }
    hooked = false;
    engineSpeaking = undefined;
    reported = undefined;
    window.__reflux_voiceTrayStatus_loaded = false; // let a re-enable run again
  }

  const api = window.__reflux;
  if (api?.pluginManager) {
    api.pluginManager.register({name: NAME, start, stop});
  } else {
    // Injected before Reflux's bootstrap finished; register once the document settles.
    document.addEventListener('DOMContentLoaded', () => {
      const late = window.__reflux;
      if (late?.pluginManager) late.pluginManager.register({name: NAME, start, stop});
      else console.warn('[Reflux] voiceTrayStatus renderer side found no plugin manager.');
    }, {once: true});
  }
})();