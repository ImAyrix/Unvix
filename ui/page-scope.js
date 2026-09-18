// ui/page-scope.js — Unvix
//
// Scope matching and "current page first" ordering for the popup.
//
// background.js keeps its own copy of matchesScope(): it is the checker that
// decides which workspaces receive a page's findings, so the popup must use the
// same rule or the list would show a workspace as "current page" that in fact
// never captures anything. The scanner loads both semantics and they must
// the two implementations agree, so they cannot drift apart silently.
//
// UMD shim: the popup loads this with <script src>, Node loads it with require().
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UNVIX_PAGE_SCOPE = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // Scopes get typed the way a program's scope table writes them, and those are
  // full URLs: `https://example.com`, `https://*.example.com/*`, `*://host/*`.
  // A plain substring test against the page URL can never match those — the page
  // URL carries its own scheme and path — so the workspace silently never
  // matched, never received that page's findings, and never moved to the top of
  // the popup. Strip the leading scheme (and a bare `//`) and match what is left.
  // A path in the scope still restricts the match, because it is kept.
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

  // A scope containing '*' is a wildcard over the whole URL ('\.' escaped, '*'
  // -> '.*'); any other scope is a plain substring match. Identical to
  // background.js matchesScope().
  // Matching is case-insensitive: hosts are, so a scope typed `Example.com`
  // must still match `https://sub.example.com` (it previously never did).
  // How a scope matches a URL (identical to the scanner's copy in
  // background.js — the popup must not call a workspace "current page" when the
  // scanner would refuse to feed it):
  //
  //   - the query string and the fragment never take part, so
  //     `https://randomsite.com/?url=example.com` is not example.com
  //   - a scope with a path is matched against host+path, one without a path
  //     against the host alone
  //   - a dotted scope matches on label boundaries: `example.com` covers
  //     `app.example.com`, not `example.com.evil.com`. A bare word keeps the
  //     loose substring match.
  //   - a port is respected, never normalised away
  function urlForScope(url) {
    const raw = String(url == null ? '' : url).trim();
    try {
      const u = new URL(raw);
      const host = (u.host || u.hostname || '').toLowerCase();
      return { host, hostPath: (host + (u.pathname || '/')).toLowerCase() };
    } catch (e) {
      const s = raw.split('#')[0].split('?')[0];
      return { host: '', hostPath: s.toLowerCase() };
    }
  }

  function hostScopeMatch(host, scopeHost) {
    const hostname = host.includes(':') ? host.slice(0, host.lastIndexOf(':')) : host;
    if (!/\./.test(scopeHost)) return host.includes(scopeHost);
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
        try { return new RegExp(regexStr, 'i').test(subject); } catch (e) { return false; }
      }
      if (hasPath) return subject.includes(s.toLowerCase());
      return hostScopeMatch(target.host, s.toLowerCase());
    });
  }


  // Workspaces whose scope covers pageUrl come first, each group keeping its
  // original relative order; everything else follows, also in original order.
  // With no pageUrl the list is returned unchanged.
  function orderByPageScope(targets, pageUrl) {
    const list = Array.isArray(targets) ? targets.slice() : [];
    if (!pageUrl) return list;
    const inScope = [], rest = [];
    list.forEach(t => (matchesScope(pageUrl, t && t.scopes) ? inScope : rest).push(t));
    return inScope.concat(rest);
  }

  return { matchesScope, orderByPageScope, normalizeScope, urlForScope };
});
