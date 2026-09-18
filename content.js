// content.js — Unvix v1.0.0
//
// Reports every JavaScript file the page loads to the service worker, as
// completely as the browser will let us see it. The message contract is
// unchanged (`SCAN_SCRIPTS` with `{scripts}`); `inline` is an additive field.
//
// Why this is more than "querySelectorAll('script[src]')":
//
//   * Chrome keeps only the last 250 resource-timing entries. Without the
//     DevTools console open, a bundle that loaded early is evicted before the
//     first sweep can see it and is never scanned — which is exactly why a page
//     appears to yield more endpoints with DevTools open (DevTools raises that
//     limit). The buffer is raised here, at document_start, before the page's
//     own scripts run, and the PerformanceObserver replays (`buffered: true`)
//     entries that predate it.
//   * Bundlers inject entry and route chunks long after the DOM is ready, so a
//     single sweep at DOMContentLoaded misses them. A MutationObserver watches
//     for added <script>/<link> tags instead of guessing a timeout.
//   * ESM apps preload modules with <link rel="modulepreload"> and resolve them
//     through an import map, and neither is a <script src>.
//   * Inline <script> text is handed to the worker as-is (no fetch): plenty of
//     SPAs keep their API base and endpoint literals there, and there is no URL
//     for the scanner to fetch.

const sentScripts = new Set();
const sentInline = new Set();

// Early entries are dropped once the buffer fills (default: 250), which
// silently loses bundles on asset-heavy pages. Raise it before anything loads,
// and cap how many URLs one sweep may report.
const RT_BUFFER = 5000;
const SWEEP_LIMIT = 400;
const INLINE_LIMIT = 40;
const INLINE_MIN_CHARS = 40;
const INLINE_MAX_CHARS = 200000;

try { performance.setResourceTimingBufferSize(RT_BUFFER); } catch (e) { /* not fatal */ }

function sendScriptsToBackground(scriptUrls, inline) {
  const validUrls = (scriptUrls || []).filter(url =>
    url && url.startsWith('http') && !sentScripts.has(url)
  ).slice(0, SWEEP_LIMIT);

  const inlineChunks = (inline || []).filter(i => i && !sentInline.has(i.key)).slice(0, INLINE_LIMIT);

  if (validUrls.length === 0 && inlineChunks.length === 0) return;

  validUrls.forEach(url => sentScripts.add(url));
  inlineChunks.forEach(i => sentInline.add(i.key));

  try {
    chrome.runtime.sendMessage({
      action: 'SCAN_SCRIPTS',
      scripts: validUrls,
      inline: inlineChunks.map(i => ({ url: i.url, code: i.code }))
    });
  } catch (e) {
    // Extension context invalidated (reload/update) — ignore.
  }
}

// A cheap, stable identity for an inline block, so the same source is not sent
// on every sweep.
function fingerprint(text) {
  let h = 2166136261;
  const n = Math.min(text.length, 4096);
  for (let i = 0; i < n; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + ':' + text.length;
}

function isScriptUrl(name) {
  return /\.m?js(\?|#|$)/i.test(name) || /\.jsx(\?|#|$)/i.test(name);
}

// 1. Script tags, module preloads / prefetches, and anything an import map
//    points at.
function domScripts() {
  const urls = [];
  for (const el of document.querySelectorAll('script[src]')) {
    if (el.src) urls.push(el.src);
  }
  for (const el of document.querySelectorAll('link[href]')) {
    const rel = (el.getAttribute('rel') || '').toLowerCase();
    const as = (el.getAttribute('as') || '').toLowerCase();
    const href = el.href || '';
    if (rel.includes('modulepreload') || rel.includes('prefetch') || as === 'script' || isScriptUrl(href)) {
      urls.push(href);
    }
  }
  for (const el of document.querySelectorAll('script[type="importmap"]')) {
    try {
      const map = JSON.parse(el.textContent || '{}');
      const walk = (obj) => {
        for (const k in (obj || {})) {
          const v = obj[k];
          if (typeof v === 'string') {
            try { urls.push(new URL(v, location.href).href); } catch (e) { /* ignore */ }
          } else if (v && typeof v === 'object') walk(v);
        }
      };
      walk(map.imports);
      walk(map.scopes);
    } catch (e) { /* malformed import map */ }
  }
  return urls;
}

// 2. Everything the browser fetched that looks like JavaScript. `script` and
//    `link` initiators are trusted even when the URL does not end in .js
//    (bundlers serve chunk URLs with query strings and hashes).
function performanceScripts() {
  const out = [];
  for (const entry of performance.getEntriesByType('resource')) {
    const type = entry.initiatorType;
    if (type === 'script' || type === 'link' || type === 'other' || isScriptUrl(entry.name)) {
      if (type !== 'xmlhttprequest' && type !== 'fetch') out.push(entry.name);
    }
  }
  return out;
}

// 3. Inline scripts, which have no URL to fetch. `<script type=application/json>`
//    blocks (JSON-LD, config blobs) are not JavaScript and are skipped.
function inlineScripts() {
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll('script:not([src])')) {
    const type = (el.getAttribute('type') || '').toLowerCase().trim();
    if (type && !/^(text\/javascript|application\/javascript|module|text\/ecmascript)$/.test(type)) continue;
    const code = el.textContent || '';
    if (code.length < INLINE_MIN_CHARS || code.length > INLINE_MAX_CHARS) continue;
    const key = fingerprint(code);
    if (sentInline.has(key)) continue;
    i++;
    out.push({ key, url: `inline script #${i} (${location.host})`, code });
  }
  return out;
}

function sweep() {
  try {
    sendScriptsToBackground(
      [...domScripts(), ...performanceScripts()],
      inlineScripts()
    );
  } catch (e) { /* never break the page */ }
}

// 4. Live traffic: chunks fetched after this script started. `buffered: true`
//    also replays entries recorded before the observer existed.
try {
  const observer = new PerformanceObserver((list) => {
    const urls = list.getEntries()
      .filter(e => e.initiatorType === 'script' || e.initiatorType === 'link' || e.initiatorType === 'other' || isScriptUrl(e.name))
      .map(e => e.name);
    if (urls.length) sendScriptsToBackground(urls);
  });
  observer.observe({ entryTypes: ['resource'], buffered: true });
} catch (e) { /* PerformanceObserver unavailable */ }

// 5. Scripts and preload links injected after the fact (every SPA chunk).
let debounce = null;
function scheduleSweep() {
  if (debounce) return;
  debounce = setTimeout(() => { debounce = null; sweep(); }, 250);
}
try {
  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType === 1) { scheduleSweep(); return; }
      }
    }
  }).observe(document, { childList: true, subtree: true });
} catch (e) { /* observe() unavailable */ }

// 6. SPA navigations, tab focus, and the moments a page finishes settling.
window.addEventListener('popstate', sweep);
window.addEventListener('hashchange', sweep);
window.addEventListener('load', sweep);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sweep();
});

// 7. Popup-triggered rescan.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.action === 'RESCAN') {
    sweep();
    sendResponse({ ok: true, sent: sentScripts.size });
  }
});

// First sweep as soon as the DOM is parsed, then a few follow-ups for the
// bundlers that inject their entry script late. (The MutationObserver covers
// most of this; these are the cheap belt-and-braces.)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', sweep);
} else {
  sweep();
}
setTimeout(sweep, 1500);
setTimeout(sweep, 4000);
