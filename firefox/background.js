// background.js — Unvix background event script (Firefox Edition)
//
// Passive JS/API recon: the content script reports the scripts a page loaded,
// this script fetches them, runs the workspace's regexes over their text, and
// stores `[path, timestamp, isNew, sourceUrl]` tuples per workspace.
//
// Two things are worth knowing before reading on:
//
//   * The API base ("/api/") is usually declared in exactly one bundle (the
//     entry one) while the services live in the lazy chunks, so the scan is
//     two-phase: fetch everything first, resolve the base across all of it,
//     then extract.
//   * A workspace the popup marks "current page" must be one the scanner
//     really feeds: matchesScope() here is kept identical to the copy in
//     ui/page-scope.js, and the two are checked against each other.
//
// Deliberate behaviours that are easy to get wrong:
//
//   1. matchesScope() is case-insensitive (hosts are; a scope typed
//      `Example.com` would otherwise match nothing at all) and strips a
//      leading scheme, because program scope tables write scopes as
//      `https://redacted.com`. A malformed wildcard scope is treated as
//      non-matching rather than throwing — one bad scope used to abort the
//      whole scan.
//   2. extractEndpoints() guards against a zero-length match. `while
//      (regex.exec())` with the /g flag never advances lastIndex on an empty
//      match, so a user regex that can match "" (`(?:/api)?`, `x*`, `\d*`)
//      freezes the service worker in an infinite loop.
//   3. expandConcatenations(): bundles frequently never contain the endpoint
//      path as a literal. The service class holds the prefix
//      (`this.apiUrl = "orders/"`) and each call appends the method
//      (`this.apiUrl + "ListOrders"`), so no regex can ever match
//      `/api/orders/ListOrders`. Those joined paths are synthesised and appended
//      to the text the user's regexes run against.
//   4. discoverScripts(): the content script can only report scripts the browser
//      already requested, so chunks for routes you never visited were never
//      scanned. Every chunk URL a bundle declares — webpack chunk map, Vite's
//      __vite__mapDeps, dynamic import(), importScripts(), worker URLs — is read
//      out of the JavaScript that did load and fetched directly. Inline
//      <script> text is scanned as well, since some apps declare both endpoints
//      and chunks there.
//   5. Findings are recorded against EVERY workspace whose scope matches the
//      page, not just the first one, so overlapping workspaces both fill.
//   6. The toolbar badge is derived from the stored isNew flags
//      (refreshBadge()) rather than set once inside the scan: it reads as a
//      count and is recomputed whenever `discovered` changes, so an
//      acknowledge, an import, a purge or a restarted worker cannot leave it
//      stale.

const browserAPI = (typeof browser !== 'undefined' && browser) || (typeof chrome !== 'undefined' && chrome) || {};
const actionAPI = browserAPI.action || (typeof browser !== 'undefined' && browser.action) || (typeof chrome !== 'undefined' && chrome.action) || null;

const CHUNK_FETCH_LIMIT = 300;   // max chunk URLs read out of ONE script
const EXPAND_LINE_LIMIT = 5000;  // max synthesised paths per script
const MAX_HOLD_BYTES = 64 * 1024 * 1024; // cap on text held across phases
const TOTAL_SCRIPT_LIMIT = 1500; // cap on scripts fetched for one page
const FETCH_CONCURRENCY = 6;     // parallel fetches: sequential is minutes on a big app
const FETCH_BUDGET_MS = 25000;   // stop fetching and extract what we have
const INLINE_SCRIPT_LIMIT = 40;  // inline <script> blocks accepted per message
const EXCLUDE_RULE_LIMIT = 200;  // max out-of-scope patterns honoured per workspace

// Utility: Check if a URL matches the user's defined scopes
// Matching is case-insensitive (hosts are) and kept identical to the popup's
// copy in ui/page-scope.js, because a target marked "current page" must be one
// the scanner really feeds.
//
// A scope written as a full URL (`https://example.com`, `https://*.example.com/*`)
// has its scheme stripped before matching: those are how program scope tables
// write them, and a plain substring test against the page URL could never match
// one, so the workspace silently captured nothing from the host it was made for.
function normalizeScope(scope) {
  let s = String(scope).trim();
  const schemeAt = s.indexOf('://');
  if (schemeAt > 0 && /^[a-z*][a-z0-9+.-]*$/i.test(s.slice(0, schemeAt))) {
    s = s.slice(schemeAt + 3);
  } else if (s.startsWith('//')) {
    s = s.slice(2);
  }
  return s;
}

// A scope as written for a page (a full URL, maybe with a path) reduced to the
// host part, for deciding whether a *file* belongs to a workspace. A page scope
// like `https://example.com/dashboard` still admits
// `https://example.com/static/js/main.js`: the path restricts which pages are in
// scope, not where the site keeps its scripts, and a scanner that refused to read
// the site's own bundle would find nothing at all.
function hostScopeOf(scope) {
  let s = normalizeScope(scope);
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  return s;
}

// How a scope matches a URL:
//
//   - the query string and the fragment never take part. A scope says where
//     something lives, and `https://randomsite.com/?url=example.com` is not
//     example.com. Matching the whole URL as a substring let any site hand a
//     workspace a script simply by naming the scope in a query parameter.
//   - a scope carrying a path (`example.com/dashboard`) is matched against
//     host+path; one without a path is matched against the host alone, so a path
//     cannot smuggle it in either.
//   - a dotted scope is a domain and matches on label boundaries: `example.com`
//     covers `example.com` and `app.example.com`, but not `example.com.evil.com`
//     and not `notexample.com`. A bare word (`example`) keeps the loose
//     substring match, which is how people type shorthand scopes.
//   - a port in the scope is respected; `example.com` also covers
//     `example.com:8443`, and a port is never normalised away.
function urlForScope(url) {
  const raw = String(url == null ? '' : url).trim();
  try {
    const u = new URL(raw);
    const host = (u.host || u.hostname || '').toLowerCase();
    return { host, hostPath: (host + (u.pathname || '/')).toLowerCase() };
  } catch (e) {
    // Not a URL at all (a test stub, a bare path): compare what can be compared,
    // still without the query string.
    const s = raw.split('#')[0].split('?')[0];
    return { host: '', hostPath: s.toLowerCase() };
  }
}

// A scope written without a path, against a host that may carry a port.
function hostScopeMatch(host, scopeHost) {
  const hostname = host.includes(':') ? host.slice(0, host.lastIndexOf(':')) : host;
  if (!/\./.test(scopeHost)) return host.includes(scopeHost);   // bare word shorthand
  const subject = scopeHost.includes(':') ? host : hostname;
  return subject === scopeHost || subject.endsWith('.' + scopeHost);
}

function matchesScope(url, scopes) {
  const target = urlForScope(url);
  return (scopes || []).some(scope => {
    if (!scope) return false;
    const s = normalizeScope(scope);
    if (!s) return false;
    const hasPath = s.indexOf('/') >= 0;
    const subject = hasPath ? target.hostPath : target.host;
    if (!subject) return false;
    if (s.includes('*')) {
      const regexStr = s.replace(/\./g, '\\.').replace(/\*/g, '.*');
      // A scope that is not a valid regex can never match. Unguarded, the throw
      // propagated out of the storage callback and aborted the whole scan, so a
      // single typo in one workspace silently produced no findings at all.
      try { return new RegExp(regexStr, 'i').test(subject); } catch (e) { return false; }
    }
    if (hasPath) return subject.includes(s.toLowerCase());
    return hostScopeMatch(target.host, s.toLowerCase());
  });
}


// Utility: Extract endpoints using user regex
function extractEndpoints(jsCode, regexStrings) {
  let found = new Set();
  regexStrings.forEach(regexStr => {
    try {
      const regex = new RegExp(regexStr, 'gi');
      let match;
      while ((match = regex.exec(jsCode)) !== null) {
        // A zero-length match leaves lastIndex untouched with the /g flag, so
        // the loop would never end. Force progress instead of hanging.
        if (match[0] === '') { regex.lastIndex++; continue; }
        found.add(match[0]);
      }
    } catch (e) {
      console.error("Invalid Regex:", regexStr);
    }
  });
  return Array.from(found);
}

// --- Reconstruct endpoints that only exist as concatenated fragments ---

// A literal "api/" or "/api/" in the bundle means the HTTP layer prefixes it.
// Returns "/api/" or null; null means we refuse to invent a prefix.
function detectApiBase(jsCode) {
  const m = jsCode.match(/["'`](\/?api\/)["'`]/i);
  return m ? '/' + m[1].replace(/^\//, '') : null;
}

// Join a route onto a base without doubling it. The fragment may already carry
// the base hint (`this.loginUrl = baseUrl + "api/"` then `+"login"` yields
// "api/login"), which must not become "/api//api/login".
function joinBase(base, p) {
  if (/^https?:/i.test(p)) return p;
  const b = (base || '').replace(/\/$/, '');
  const bare = b.replace(/^\//, '');          // "api"
  if (bare && (p === bare || p.startsWith(bare + '/'))) {
    return '/' + p.replace(/^\/+/, '');       // already carries the base
  }
  if (b && p.startsWith(b + '/')) return p;
  return b + (p.startsWith('/') ? p : '/' + p);
}

// Pair `this.<x>Url + "Method"` with the nearest preceding `this.<x>Url = "prefix/"`.
function expandConcatenations(jsCode, apiBase) {
  const assigned = {};   // this.<x>Url = "<prefix>"   (positionally ordered)
  const out = [];

  const baseDef = /this\.(\w*[Uu]rl)\s*=\s*(?:[A-Za-z_$][\w$.]*\s*\+\s*)?"([^"]*)"/g;
  let m;
  while ((m = baseDef.exec(jsCode)) !== null) {
    (assigned[m[1]] = assigned[m[1]] || []).push({ pos: m.index, prefix: m[2] });
  }

  const call = /this\.(\w*[Uu]rl)\s*\+\s*"([^"]+)"/g;
  while ((m = call.exec(jsCode)) !== null) {
    const list = assigned[m[1]];
    if (!list) continue;
    const before = list.filter(a => a.pos < m.index);
    if (!before.length) continue;
    const prefix = before[before.length - 1].prefix;
    if (!prefix) continue;
    const joined = prefix + m[2];
    if (joined.length > 200) continue;
    out.push(apiBase ? joinBase(apiBase, joined) : '/' + joined.replace(/^\/+/, ''));
    if (out.length >= EXPAND_LINE_LIMIT) break;
  }

  if (!out.length) return '';   // nothing to add: behaviour stays byte-identical

  return '\n/* unvix-expanded-endpoints */\n' + [...new Set(out)].join('\n')
       + '\n/* end-unvix-expanded-endpoints */\n';
}

// --- Enumerate the JavaScript the browser never requested -------------------
//
// Bundlers split an app into chunks that are fetched only when a route is
// visited, so a scan that waits for the browser sees a fraction of the app —
// and the fraction you get depends on where you happened to click. Every chunk
// URL is *declared* somewhere in the JavaScript that did load: in a webpack
// chunk map, in Vite's __vite__mapDeps array, in a dynamic import(), in a
// worker's importScripts(). Those declarations are read here and the chunks
// fetched directly, without needing DevTools open or a visit to every route.
//
// Same-origin only: a chunk list is followed to the site's own asset host, never
// off-site, and anything that is clearly not JavaScript is dropped.

// A quoted .js / .mjs / .jsx path, with an optional cache-busting query.
const SCRIPT_LITERAL_RE = /["'`]((?:[^"'`\s\\]|\\.){1,240}?\.(?:m?js|jsx))[?#][^"'`\s]{0,120}["'`]|["'`]((?:[^"'`\s\\]|\\.){1,240}?\.(?:m?js|jsx))["'`]/gi;

function discoverScripts(jsCode, scriptUrl) {
  const out = [];
  const seen = new Set();
  let origin;
  try { origin = new URL(scriptUrl).origin; } catch (e) { return out; }

  const push = (raw) => {
    if (out.length >= CHUNK_FETCH_LIMIT) return;
    const candidate = String(raw || '').trim();
    if (!candidate || candidate.startsWith('data:') || candidate.startsWith('blob:')) return;
    let u;
    try { u = new URL(candidate, scriptUrl); } catch (e) { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (u.origin !== origin) return;                      // never leave the site
    if (!/\.(m?js|jsx)$/i.test(u.pathname)) return;        // .js.map and friends
    if (seen.has(u.href)) return;
    seen.add(u.href);
    out.push(u.href);
  };

  // 1. webpack 5 / Angular CLI chunk map:
  //      r.u = e => (76===e?"common":e) + "." + {76:"a1b2c3d4",...}[e] + ".js"
  //    with the public path in r.p. The map lists several entries and the code
  //    right after it appends the ".js" suffix — one numeric entry on its own is
  //    noise, not a chunk table.
  const map = jsCode.match(/\.u\s*=\s*[\w$]+\s*=>[^;]{0,4000}?\{(\d+\s*:\s*"[0-9a-f]{6,}"[^}]*)\}/);
  if (map) {
    const named = {}, alias = {};
    for (const mm of map[0].matchAll(/(\d+)\s*:\s*"([^"]*)"/g)) named[mm[1]] = mm[2];
    for (const mm of map[0].matchAll(/(\d+)\s*===\s*[\w$]+\s*\?\s*"([^"]+)"/g)) alias[mm[1]] = mm[2];
    const keys = Object.keys(named);
    const tail = jsCode.slice(map.index + map[0].length, map.index + map[0].length + 60);
    if (keys.length >= 2 && /\.js["'`]/.test(tail)) {
      const pm = jsCode.match(/\.p\s*=\s*"([^"]*)"/);
      const base = pm ? pm[1] : './';
      for (const id of keys) push(base + (alias[id] || id) + '.' + named[id] + '.js');
    }
  }

  // 2. Vite / Rollup: __vite__mapDeps(["assets/index-4a1f.js", ...])
  for (const m of jsCode.matchAll(/__vite__mapDeps\s*\(\s*\[([^\]]{0,20000})\]/g)) {
    for (const mm of m[1].matchAll(/["'`]([^"'`]{1,240})["'`]/g)) push(mm[1]);
  }

  // 3. Everything else that names a script: import("./x.js"), importScripts(),
  //    new Worker("..."), "chunk-4a1f.js", "/static/js/main.abc.js", ...
  for (const m of jsCode.matchAll(SCRIPT_LITERAL_RE)) push(m[1] || m[2]);

  return out;
}

// --- the badge: the sign next to the toolbar icon ---------------------------
//
// Derived state, not a one-shot alert: it is recomputed from the stored isNew
// flags instead of being set once when a scan happens to find something. That
// way it cannot drift (a tab closed mid-scan, an acknowledge, a restore) and it
// still reads correctly after the browser or the background script restarts.
const BADGE_MAX = 99;

function readDiscovered() {
  return new Promise((resolve) => {
    try {
      const storage = browserAPI.storage && browserAPI.storage.local;
      if (!storage) return resolve({});
      const p = storage.get(['discovered']);
      if (p && typeof p.then === 'function') {
        p.then(data => resolve((data && data.discovered) || {})).catch(() => resolve({}));
      } else {
        storage.get(['discovered'], (data) => resolve((data && data.discovered) || {}));
      }
    } catch (e) { resolve({}); }
  });
}

// Number of unacknowledged endpoints across every workspace, shown on the icon.
async function refreshBadge() {
  if (!actionAPI || !actionAPI.setBadgeText) return 0;
  const discovered = await readDiscovered();
  let n = 0;
  for (const id in discovered) {
    for (const ep of (discovered[id] || [])) if (ep && ep[2] === 1) n++;
  }
  try {
    actionAPI.setBadgeText({ text: n === 0 ? '' : (n > BADGE_MAX ? BADGE_MAX + '+' : String(n)) });
    if (n) {
      // The gold accent from ui/theme.css (--accent), with dark ink on it: a badge
      // is a tiny area, so it needs the accent solid rather than tinted.
      actionAPI.setBadgeBackgroundColor({ color: '#e6b25c' });
      if (actionAPI.setBadgeTextColor) actionAPI.setBadgeTextColor({ color: '#201605' });
    }
  } catch (e) { /* non-fatal badge update error */ }
  return n;
}

// Anything that flips isNew (the popup's acknowledge, an import/restore, a
// purge) updates the badge without having to know the badge exists.
try {
  if (browserAPI.storage && browserAPI.storage.onChanged) {
    browserAPI.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes && changes.discovered) refreshBadge();
    });
  }
} catch (e) { /* storage events unavailable (offline test stubs) */ }

// And once whenever the script starts, so a reload/restart cannot leave a stale
// count on the icon.
try {
  const onBoot = () => refreshBadge();
  if (browserAPI.runtime) {
    browserAPI.runtime.onStartup && browserAPI.runtime.onStartup.addListener(onBoot);
    browserAPI.runtime.onInstalled && browserAPI.runtime.onInstalled.addListener(onBoot);
  }
} catch (e) { /* runtime events unavailable (offline test stubs) */ }
refreshBadge();

// --- the scan queue ---------------------------------------------------------
//
// Every scan reads one shared blob of state (cache / discovered / apiBases),
// works on it, and writes it back whole. Two scans running side by side
// therefore destroy each other's findings: whichever finishes last writes the
// snapshot it started from. That is the normal case here, not a corner case — a
// page with hundreds of chunks reports in many batches, one per sweep — so scans
// are serialised through this queue, and the batches that arrive while one is
// running are merged into the next scan instead of piling up one message each.
const scanQueue = new Map();     // pageUrl -> { scripts:Set, inline:Map }
let draining = false;

function readScanState() {
  return new Promise((resolve) => {
    try {
      const storage = browserAPI.storage && browserAPI.storage.local;
      if (!storage) return resolve({});
      const keys = ['targets', 'cache', 'discovered', 'settings', 'apiBases', 'excludeHits'];
      const p = storage.get(keys);
      if (p && typeof p.then === 'function') {
        p.then(data => resolve(data || {})).catch(() => resolve({}));
      } else {
        storage.get(keys, (data) => resolve(data || {}));
      }
    } catch (e) { resolve({}); }
  });
}

function writeScanState(obj) {
  return new Promise((resolve) => {
    try {
      const storage = browserAPI.storage && browserAPI.storage.local;
      if (!storage) return resolve();
      const p = storage.set(obj);
      if (p && typeof p.then === 'function') {
        p.then(resolve).catch(() => resolve());
      } else {
        storage.set(obj, () => resolve());
      }
    } catch (e) { resolve(); }
  });
}

async function runScan(pageUrl, scripts, inline) {
  const data = await readScanState();
  const targets = data.targets || [];
  let cache = data.cache || {};
  let discovered = data.discovered || {};
  const settings = data.settings || { cacheCooldown: 60 };
  const apiBases = data.apiBases || {};

  const CACHE_COOLDOWN_MS = settings.cacheCooldown * 60 * 1000;
  const now = Date.now();

  // OPTIMIZATION: Garbage Collect Old Cache Entries to save memory
  for (const key in cache) {
    if (now - cache[key] > CACHE_COOLDOWN_MS) {
      delete cache[key];
    }
  }

  // Which workspaces is this scan allowed to feed? A page only ever writes
  // findings to workspaces whose scope covers the page URL — anything else is
  // another target and must not receive this page's endpoints.
  const matchedTargets = targets.filter(t => matchesScope(pageUrl, t.scopes));
  if (matchedTargets.length === 0) return;

  // Initialise discovered arrays for matched targets if needed
  matchedTargets.forEach(target => {
    if (!discovered[target.id]) {
      discovered[target.id] = [];
    }
  });

  // Which workspaces is a specific *file* allowed to feed?
  //
  // A target whose page scope is `https://example.com/dashboard` still admits
  // `https://example.com/static/js/main.js`: the path scopes the page, not
  // where the site keeps its assets. But a third-party script loaded by the page
  // (`https://analytics.google.com/tag.js`, `https://cdn.vendor.com/bundle.js`)
  // belongs to no workspace scoped to example.com, so it must not be fetched
  // and must not be scanned.
  const scriptOwners = (url) => matchedTargets.filter(target =>
    (target.scopes || []).some(scope => {
      const host = hostScopeOf(scope);
      return host ? matchesScope(url, [host]) : false;
    })
  );

  // The cache key incorporates the target id: two workspaces covering the same
  // host each need to extract from the file once, but the actual HTTP fetch
  // happens only once per run.
  const cacheKey = (targetId, url) => targetId + '|' + url;
  const cachedFresh = (targetId, url) => {
    const at = cache[cacheKey(targetId, url)];
    return at && (now - at < CACHE_COOLDOWN_MS);
  };

  // ---- phase 1: fetch everything first ----
  //
  // Chunks declare more chunks (discoverScripts), so discovering endpoints
  // file-by-file would run extraction before the API base has even been seen,
  // producing broken paths. We fetch until the pool is empty, then extract.
  //
  // Inline scripts from the content script are already text: inject them directly
  // so they bypass fetch, but are scanned alongside the fetched bundles.
  const queue = Array.isArray(scripts) ? scripts.slice() : [];
  const seen = new Set(queue);
  const fetched = [];        // { url, code, inline? }
  const enqueue = (candidate) => {
    if (!candidate || seen.has(candidate) || queue.length >= TOTAL_SCRIPT_LIMIT) return;
    seen.add(candidate);
    queue.push(candidate);
  };

  for (const item of (inline || [])) {
    if (item && typeof item.code === 'string') {
      fetched.push({ url: item.url || 'inline script', code: item.code, inline: true });
      // An inline script might declare chunk URLs (e.g. webpack publicPath + chunk map):
      for (const url of discoverScripts(item.code, pageUrl)) enqueue(url);
    }
  }

  // Worker fetch pool. Sequential fetches on a modern app (100+ chunks) take
  // enough for the user to have moved on before the findings appear. The
  // queue keeps growing while it drains (each bundle declares more chunks),
  // so this is a pool over a moving index, not a fixed batch. The time
  // budget and the byte cap stop a runaway app from holding the worker
  // forever; whatever was fetched is still extracted.
  let cursor = 0;
  let active = 0;
  let held = 0;
  let skipped = 0;        // files the page loaded that no workspace is scoped to
  const deadline = Date.now() + FETCH_BUDGET_MS;

  await new Promise((resolve) => {
    const pump = () => {
      while (active < FETCH_CONCURRENCY && cursor < queue.length &&
             Date.now() <= deadline && held <= MAX_HOLD_BYTES) {
        const scriptUrl = queue[cursor++];

        // Not the target's own JavaScript: do not fetch it, do not scan it.
        const owners = scriptOwners(scriptUrl);
        if (!owners.length) { skipped++; continue; }

        // Already read for every workspace that wants it?
        if (owners.every(t => cachedFresh(t.id, scriptUrl))) continue;

        active++;
        // A hung request would hold the pool open; 10 s is generous for a
        // file the browser has fetched once already.
        let opts;
        try { opts = { signal: AbortSignal.timeout(10000) }; } catch (e) { opts = undefined; }
        fetch(scriptUrl, opts)
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.text();
          })
          .then((jsCode) => {
            fetched.push({ url: scriptUrl, code: jsCode });
            held += jsCode.length;
            // One fetch, marked read for every workspace scoped to this file.
            for (const t of owners) cache[cacheKey(t.id, scriptUrl)] = now;
            // queue the scripts this bundle declares, so chunks for routes
            // the user has not opened are scanned too.
            for (const url of discoverScripts(jsCode, scriptUrl)) enqueue(url);
          })
          .catch(() => { /* a chunk that 404s is not a failure of the scan */ })
          .then(() => { active--; pump(); });
      }
      if (active === 0) resolve();   // queue drained, budget spent, or cap hit
    };
    pump();
  });

  // ---- phase 2: resolve the API base across ALL of it ----
  // The base literal normally lives in the entry bundle only, while the
  // services that concatenate it live in the lazy chunks. Detecting it
  // per-file would emit "/orders/ListOrders" for the chunks instead of
  // "/api/orders/ListOrders".
  let apiBase = null;
  for (const t of matchedTargets) {
    if (apiBases[t.id]) { apiBase = apiBases[t.id]; break; }
  }
  for (const f of fetched) {
    const foundBase = detectApiBase(f.code);
    if (foundBase) { apiBase = foundBase; break; }
  }
  if (apiBase) {
    for (const t of matchedTargets) apiBases[t.id] = apiBase;
  }

  // ---- out of scope: the exclude rules ----
  //
  // Compiled once per scan rather than once per endpoint — a big page produces
  // thousands of endpoints and a fresh RegExp per test would be pure overhead.
  // `i` and no `g`, so a shared RegExp cannot carry a lastIndex between calls.
  // A pattern that will not compile is skipped here and flagged in the
  // dashboard; it is never fatal to a scan.
  const excludeMatchers = new Map();
  for (const t of matchedTargets) {
    const patterns = (Array.isArray(t.excludes) ? t.excludes : []).slice(0, EXCLUDE_RULE_LIMIT);
    const compiled = [];
    for (const pattern of patterns) {
      try { compiled.push(new RegExp(String(pattern).trim(), 'i')); }
      catch (e) { /* invalid regex skipped */ }
    }
    excludeMatchers.set(t.id, compiled);
  }

  const isExcluded = (targetId, endpoint) => {
    const compiled = excludeMatchers.get(targetId);
    if (!compiled || !compiled.length) return false;
    for (let i = 0; i < compiled.length; i++) {
      if (compiled[i].test(endpoint)) return true;
    }
    return false;
  };

  // Lifetime counts of endpoints dropped per workspace by an exclude rule: shown
  // on the options page so the user can tell whether their rules are doing
  // anything.
  const excludeHits = Object.assign({}, data.excludeHits || {});

  // ---- phase 3: extract and store ----
  //
  // One file is extracted for every workspace scoped to it, with synthesised
  // paths from expandConcatenations() appended so rules see both.
  let newEndpointsFound = 0;
  for (const f of fetched) {
    try {
      // Inline scripts belong to every workspace matched by the page URL (they
      // came out of that document directly). Fetched files belong only to the
      // workspaces scoped to the file's host.
      const owners = f.inline ? matchedTargets : scriptOwners(f.url);
      if (!owners.length) continue;

      const expanded = expandConcatenations(f.code, apiBase);
      const haystack = expanded ? f.code + expanded : f.code;

      for (const target of owners) {
        const endpoints = extractEndpoints(haystack, target.regexes);
        endpoints.forEach(ep => {
          // Out of scope? Drop it before it touches the findings list, the
          // NEW flags, or the badge.
          if (isExcluded(target.id, ep)) {
            excludeHits[target.id] = (excludeHits[target.id] || 0) + 1;
            return;
          }

          // Format: [path, timestamp, isNew, sourceUrl]
          // Index 2 is the isNew flag: 1 = unread/new, 0 = acknowledged.
          const exists = discovered[target.id].some(epData => epData[0] === ep);
          if (!exists) {
            discovered[target.id].push([ep, now, 1, f.url]);
            newEndpointsFound++;
          }
        });
      }
    } catch (e) {
      console.error("Failed to extract from:", f.url);
    }
  }

  // Save updated data
  await writeScanState({ cache, discovered, apiBases, excludeHits });

  // Third-party scripts are the normal case on a real page (tag managers, chat
  // widgets, CDNs), so this is a count, once per scan, and nothing else: it is
  // the answer to "why is that endpoint missing".
  if (skipped) console.debug(`Unvix: skipped ${skipped} script(s) outside the workspace scope`);

  // The sign next to the toolbar icon: how many unacknowledged endpoints are
  // waiting now (the storage listener above would also catch this, this call
  // makes it deterministic for the run that just finished).
  if (newEndpointsFound > 0) await refreshBadge();
}

async function drainScanQueue() {
  if (draining) return;
  draining = true;
  try {
    while (scanQueue.size) {
      const [pageUrl, batch] = scanQueue.entries().next().value;
      scanQueue.delete(pageUrl);
      const scripts = [...batch.scripts];
      const inline = [...batch.inline].map(([url, code]) => ({ url, code }));
      try {
        await runScan(pageUrl, scripts, inline);
      } catch (e) {
        // One bad scan must not stop the queue behind it.
        console.error('Unvix: scan failed for', pageUrl, e);
      }
    }
  } finally {
    draining = false;
  }
}

// Kept as a listener so content.js / popup.js keep sending 'SCAN_SCRIPTS'
// unchanged (the `inline` field is additive).
if (browserAPI.runtime && browserAPI.runtime.onMessage) {
  browserAPI.runtime.onMessage.addListener((request, sender) => {
    if (!request || request.action !== 'SCAN_SCRIPTS') return;
    const pageUrl = (sender && sender.tab && sender.tab.url) || (sender && sender.url) || '';
    if (!pageUrl) return;

    let batch = scanQueue.get(pageUrl);
    if (!batch) {
      batch = { scripts: new Set(), inline: new Map() };
      scanQueue.set(pageUrl, batch);
    }
    for (const url of (request.scripts || [])) batch.scripts.add(url);
    for (const item of (request.inline || [])) {
      if (item && typeof item.code === 'string') {
        batch.inline.set(item.url || 'inline script', item.code);
      }
    }
    drainScanQueue();
  });
}


