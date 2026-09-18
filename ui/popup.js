// ui/popup.js — Unvix
//
// Storage contract is untouched: `discovered[targetId]` is still an array of
// [path, timestamp, isNew, sourceUrl] tuples, and 'acknowledge' only flips the
// isNew flag (index 2).
//
//   - NEW only is checked on open (the checkbox carries `checked` in the HTML;
//     the toggle's `.on` class is synced from it here so the two cannot drift)
//   - the workspace whose scope covers the page the popup is open over is shown
//     first and marked "current page" (ui/page-scope.js)
//   - the list re-renders when the service worker stores new findings, keeping
//     the query, the filter and the scroll position
document.addEventListener('DOMContentLoaded', () => {

  const PAGE_SCOPE = (typeof self !== 'undefined' && self.UNVIX_PAGE_SCOPE) || null;
  let state = { discovered: {}, targets: [], pageUrl: '', pageUrlKnown: false };

  // Open Settings Dashboard
  document.getElementById('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // The running build, in the header: after editing extension files Chrome keeps
  // the old copy until the extension is reloaded, and "my change does not work"
  // is usually a stale copy. A visible version settles that in one glance.
  try {
    const versionEl = document.getElementById('brandVersion');
    if (versionEl) versionEl.textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (e) { /* no manifest access (offline harness) */ }
  const openDash = document.getElementById('openDashboard');
  if (openDash) openDash.addEventListener('click', () => chrome.runtime.openOptionsPage());

  // Force a re-harvest of the active tab's scripts.
  const rescanBtn = document.getElementById('rescanPage');
  if (rescanBtn) rescanBtn.addEventListener('click', () => {
    rescanBtn.classList.add('busy');
    rescanBtn.title = 'Scanning…';
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        rescanBtn.classList.remove('busy');
        rescanBtn.title = 'No active tab';
        return;
      }
      chrome.tabs.sendMessage(tab.id, { action: 'RESCAN' }, (resp) => {
        // Reading lastError keeps the "no content script on this page" case quiet.
        const err = chrome.runtime.lastError;
        rescanBtn.classList.remove('busy');
        if (err || !resp || !resp.ok) {
          rescanBtn.title = 'No content script on this page — reload it first';
          return;
        }
        rescanBtn.title = `Rescanned ${resp.sent} script URL(s)`;
        // give the service worker a moment to store results, then refresh
        setTimeout(loadFindings, 1200);
      });
    });
  });

  // Mark all as read (keeps the tuple shape: flag lives at index 2)
  document.getElementById('clearBadge').addEventListener('click', () => {
    chrome.storage.local.get(['discovered'], (data) => {
      let discovered = data.discovered || {};
      let stateChanged = false;

      for (let target in discovered) {
        discovered[target].forEach(ep => {
          if (ep[2] === 1) { ep[2] = 0; stateChanged = true; }
        });
      }

      if (stateChanged) chrome.storage.local.set({ discovered }, loadFindings);
      chrome.action.setBadgeText({ text: '' });
    });
  });

  const searchEl = document.getElementById('epSearch');
  const onlyNewEl = document.getElementById('onlyNew');
  const onlyNewToggle = document.getElementById('onlyNewToggle');
  if (searchEl) searchEl.addEventListener('input', render);
  if (onlyNewEl) onlyNewEl.addEventListener('change', () => {
    onlyNewToggle.classList.toggle('on', onlyNewEl.checked);
    render();
  });
  // The default lives in the markup; mirror it into the toggle's styling.
  if (onlyNewToggle && onlyNewEl) onlyNewToggle.classList.toggle('on', onlyNewEl.checked);

  // "/" focuses the filter — the popup is keyboard-only anyway once it is open,
  // and reaching for the mouse to filter a list is the slow part.
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';
    if (e.key === '/' && !typing && searchEl) {
      e.preventDefault();
      searchEl.focus();
      return;
    }
    if (e.key === 'Escape' && searchEl && searchEl.value) {
      searchEl.value = '';
      render();
    }
  });

  function counts() {
    let total = 0, fresh = 0;
    Object.values(state.discovered).forEach(list => {
      (list || []).forEach(ep => { total++; if (ep[2] === 1) fresh++; });
    });
    return { total, fresh };
  }

  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return ''; }
  }

  // One message for the whole list. Used when there is nothing to show for a
  // reason that is about the list as a whole (no findings, nothing new, a search
  // that matches nothing) — never once per workspace.
  function showListNote(text, hint, actionLabel, onAction) {
    const list = document.getElementById('findingsList');
    const note = document.createElement('div');
    note.className = 'list-note';
    note.appendChild(document.createTextNode(text));
    if (hint) {
      const h = document.createElement('span');
      h.className = 'hint';
      h.textContent = hint;
      note.appendChild(h);
    }
    if (actionLabel) {
      const btn = document.createElement('button');
      btn.className = 'link-btn';
      btn.textContent = actionLabel;
      btn.addEventListener('click', onAction);
      note.appendChild(btn);
    }
    list.appendChild(note);
  }

  function render() {
    const list = document.getElementById('findingsList');
    const q = (searchEl && searchEl.value || '').trim().toLowerCase();
    const onlyNew = !!(onlyNewEl && onlyNewEl.checked);
    // Clearing innerHTML resets the scroll position, so remember it and put it
    // back: filtering or a mid-open scan must not throw the reader to the top.
    const scrollTop = list.scrollTop;
    list.innerHTML = '';

    const { total, fresh } = counts();

    // ---- the status line: the one place a "new" number is written ----
    const statusHost = document.getElementById('statusHost');
    if (statusHost) {
      const host = hostOf(state.pageUrl);
      statusHost.textContent = host || (state.pageUrlKnown ? 'no page context' : '…');
      statusHost.title = state.pageUrl || '';
    }
    const statTotal = document.getElementById('statTotal');
    if (statTotal) statTotal.textContent = plural(total, 'endpoint');
    const statNew = document.getElementById('statNew');
    if (statNew) {
      statNew.textContent = fresh + ' new';
      statNew.style.display = fresh ? '' : 'none';
    }

    // Filters are meaningless with nothing stored yet — hide the bar entirely.
    const toolbar = document.getElementById('popupToolbar');
    if (toolbar) toolbar.style.display = total ? '' : 'none';

    // Nothing to acknowledge: do not offer a button that cannot do anything.
    const ackBtn = document.getElementById('clearBadge');
    if (ackBtn) ackBtn.style.display = fresh ? '' : 'none';

    // Nothing to say at all: no workspace exists yet.
    if (!state.targets.length) {
      list.innerHTML = `
        <div class="empty-state">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="9" y1="3" x2="9" y2="21"></line>
          </svg>
          <p>No workspaces yet.</p>
          <p class="hint">Create one in the Dashboard, give it the scopes of the site<br>you are testing, then browse it — scripts are scanned automatically.</p>
        </div>`;
      return;
    }

    // The workspace covering the page the popup is open over goes first, so the
    // findings you opened the popup for are never below three other groups.
    const ordered = PAGE_SCOPE
      ? PAGE_SCOPE.orderByPageScope(state.targets, state.pageUrl)
      : state.targets;

    // If the page's URL could not be read, the order below is the stored one and
    // the reader deserves to know that instead of wondering why the workspace
    // they are testing is not on top.
    if (state.pageUrlKnown && !state.pageUrl) {
      const note = document.createElement('div');
      note.className = 'scope-note';
      note.textContent = "This page's URL is not visible to the extension, so workspaces are in stored order.";
      list.appendChild(note);
    }

    // ---- decide what belongs on the list, then say it once ----
    const groups = ordered.map(target => {
      const eps = state.discovered[target.id] || [];
      const filtered = eps
        .filter(ep => !onlyNew || ep[2] === 1)
        .filter(ep => !q ||
          (ep[0] || '').toLowerCase().includes(q) ||
          (ep[3] || '').toLowerCase().includes(q))
        .sort((a, b) => (b[1] || 0) - (a[1] || 0));
      return { target, eps, filtered };
    });

    const matches = groups.filter(g => g.filtered.length);
    const noMatch = groups.filter(g => !g.filtered.length);

    // Nothing stored anywhere yet: one message, not one per workspace.
    if (!total) {
      showListNote('Nothing captured yet for this page.',
        'Browse the site — every script the page loads is scanned automatically. If the page was already open before the extension loaded, press Rescan.');
      list.scrollTop = scrollTop;
      return;
    }

    // A search that matches nothing anywhere: one message and a way out.
    if (q && !matches.length) {
      showListNote(`No endpoint matches “${searchEl.value.trim()}”.`,
        'The filter looks at the path and the source file name.',
        'Clear the filter', () => { searchEl.value = ''; render(); });
      list.scrollTop = scrollTop;
      return;
    }

    // Reading everything that is not new, which is the default view and a page
    // with nothing on it either way: one sentence rather than a heading per
    // workspace saying the same thing.
    if (!matches.length && onlyNew && !q) {
      showListNote('Nothing new on this page.',
        `${plural(total, 'endpoint')} ${total === 1 ? 'is' : 'are'} stored from earlier scans — switch off NEW only to read ${total === 1 ? 'it' : 'them'}.`);
      list.scrollTop = scrollTop;
      return;
    }

    // ---- the list ----
    // A workspace is never hidden: the one you are on, one with no findings yet,
    // and one whose rows are all filtered out all keep their heading. A search
    // is the exception — then the workspaces with no match are one summary line
    // at the bottom rather than eight identical headings.
    const renderGroup = ({ target, eps, filtered }) => {
      const inScope = !!(PAGE_SCOPE && PAGE_SCOPE.matchesScope(state.pageUrl, target.scopes));
      const groupDiv = document.createElement('div');
      groupDiv.className = 'target-group' + (inScope ? ' is-here' : '');

      // A workspace that has captured nothing at all gets its name and one line:
      // "0 stored" above "Nothing captured yet" is the same fact twice, and the
      // heading still has to be there so the order stays readable.
      const hasFacts = filtered.length > 0 || eps.length > 0;
      const h3 = document.createElement('h3');
      h3.innerHTML = `<span class="grp-name">${escapeHtml(target.name)}</span>
        ${hasFacts ? `<span class="grp-meta">
          ${inScope ? '<span class="grp-here">current page</span>' : ''}
          <span class="grp-count">${filtered.length ? plural(filtered.length, 'endpoint') : plural(eps.length, 'stored')}</span>
        </span>` : ''}`;
      groupDiv.appendChild(h3);

      if (!filtered.length) {
        const note = document.createElement('div');
        note.className = 'group-empty';
        note.textContent = !eps.length ? 'Nothing captured yet' : 'Nothing new';
        groupDiv.appendChild(note);
        return groupDiv;
      }

      filtered.forEach(ep => {
        const epPath = ep[0] || '';
        const epSource = ep[3] || '';
        const isNew = ep[2] === 1;

        const row = document.createElement('div');
        // With NEW only on, every row is new: the marker would be on all of them
        // and would mean nothing. The header count already says how many.
        row.className = 'endpoint-item' + (isNew && !onlyNew ? ' is-new' : '');

        const body = document.createElement('div');
        body.className = 'ep-body';
        const pathEl = document.createElement('div');
        pathEl.className = 'ep-path';
        pathEl.textContent = epPath;          // textContent: never inject a path as HTML
        pathEl.title = epPath;
        body.appendChild(pathEl);

        const source = describeSource(epSource);
        const src = document.createElement('span');
        src.className = 'ep-src';
        src.textContent = source.text;
        src.title = source.href || source.text;
        body.appendChild(src);
        row.appendChild(body);

        if (isNew && !onlyNew) {
          const dot = document.createElement('span');
          dot.className = 'ep-dot';
          dot.title = 'New since your last acknowledge';
          row.appendChild(dot);
        }

        const copy = document.createElement('button');
        copy.className = 'ep-copy';
        copy.textContent = 'copy';
        copy.title = 'Copy endpoint';
        copy.addEventListener('click', () => {
          copyText(epPath).then(ok => {
            copy.textContent = ok ? 'copied' : 'failed';
            copy.classList.add('done');
            setTimeout(() => { copy.textContent = 'copy'; copy.classList.remove('done'); }, 1200);
          });
        });
        row.appendChild(copy);

        groupDiv.appendChild(row);
      });

      return groupDiv;
    };

    if (q) {
      // Searching: the workspaces with matches, in scope order, and one line for
      // the rest instead of a heading each.
      matches.forEach(group => list.appendChild(renderGroup(group)));
      if (noMatch.length) {
        const summary = document.createElement('div');
        summary.className = 'list-note';
        summary.textContent = `${plural(noMatch.length, 'workspace')} with no match: ${noMatch.map(g => g.target.name).join(', ')}.`;
        list.appendChild(summary);
      }
    } else {
      // Not searching: every workspace keeps its heading, in the scope-aware
      // order, whether it has new findings, no findings at all, or nothing that
      // survives the filter. A workspace that vanishes reads as a broken order.
      groups.forEach(group => list.appendChild(renderGroup(group)));
    }

    list.scrollTop = scrollTop;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Where a finding came from, in one line:
  //   - an http(s) file   -> "host · …/tail/of/the/path.js" (full URL in the title)
  //   - an inline script  -> its label, since there is no file to link to
  //   - nothing recorded  -> said plainly, instead of a shrug nobody can act on
  function describeSource(source) {
    const raw = String(source || '').trim();
    if (!raw) return { text: 'source not recorded', href: '' };
    if (/^https?:/i.test(raw)) {
      try {
        const u = new URL(raw);
        const parts = u.pathname.split('/').filter(Boolean);
        const tail = parts.slice(-2).join('/') || u.host;
        return { text: `${u.host} · ${parts.length > 2 ? '…/' : ''}${tail}`, href: raw };
      } catch (e) { return { text: raw, href: raw }; }
    }
    return { text: raw, href: '' };   // inline script, or anything not linkable
  }


  // Clipboard without adding a manifest permission: the async API needs a
  // gesture (we always have one) and falls back to execCommand when the popup
  // is not focused, which is when the async API tends to reject.
  function copyText(text) {
    return new Promise((resolve) => {
      const fallback = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          return ok;
        } catch (e) { return false; }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => resolve(true), () => resolve(fallback()));
      } else resolve(fallback());
    });
  }

  function loadFindings() {
    chrome.storage.local.get(['discovered', 'targets'], (data) => {
      state.discovered = data.discovered || {};
      state.targets = data.targets || [];
      render();
    });
  }

  // The page the popup is open over. No extra permission is needed: opening the
  // popup grants activeTab for the tab underneath it.
  //
  // `currentWindow` is documented to resolve to the window the popup is attached
  // to, but a popup has been known to report no window at all and get an empty
  // list back — which silently dropped the page priority. Widen one step at a
  // time rather than giving up: the active tab of the current window, then of
  // the last focused one, then any active tab.
  const TAB_QUERIES = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { active: true }
  ];

  function loadPageUrl(retry = true) {
    const attempt = (i) => {
      if (i >= TAB_QUERIES.length) {
        state.pageUrl = '';
        state.pageUrlKnown = true;
        render();
        // A tab that has just been created or is mid-navigation reports no URL
        // for a moment. One retry avoids telling the reader their page is
        // invisible when it is about to become visible.
        if (retry) setTimeout(() => loadPageUrl(false), 700);
        return;
      }
      try {
        chrome.tabs.query(TAB_QUERIES[i], (tabs) => {
          if (chrome.runtime.lastError) { attempt(i + 1); return; }   // read it, keeps Chrome quiet
          const list = tabs || [];
          const tab = list.find(t => t.active && t.url) || list.find(t => t.url);
          if (!tab) { attempt(i + 1); return; }
          state.pageUrl = tab.url;
          state.pageUrlKnown = true;
          render();
        });
      } catch (e) { attempt(i + 1); }
    };
    attempt(0);
  }

  // A scan can finish while the popup is open (the Rescan button, or a page
  // that keeps loading chunks). Re-render instead of waiting to be reopened.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.discovered || changes.targets)) loadFindings();
    });
  } catch (e) { /* older stub / no storage events: the popup still works */ }

  loadFindings();
  loadPageUrl();
});
