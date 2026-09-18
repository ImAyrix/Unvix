document.addEventListener('DOMContentLoaded', () => {
  
  // --- UI Routing (Tab Switching) ---
  const navItems = document.querySelectorAll('.nav-item');
  const viewSections = document.querySelectorAll('.view-section');

  function activateNav(item) {
    navItems.forEach(nav => nav.classList.remove('active'));
    viewSections.forEach(sec => sec.classList.remove('active'));

    item.classList.add('active');
    const targetId = item.getAttribute('data-target');
    document.getElementById(targetId).classList.add('active');

    if (targetId === 'view-manage') renderTargets();
  }

  navItems.forEach(item => {
    item.addEventListener('click', () => activateNav(item));
    // the nav items are divs, so keyboard users need this explicitly
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateNav(item); }
    });
  });

  // --- One transient confirmation instead of modal alerts ---
  // A modal alert for "saved" interrupts the flow (and steals focus); the toast
  // reports the same thing without blocking. Errors keep using alert(), which
  // is the right weight for something the user must read.
  const toastEl = document.createElement('div');
  toastEl.className = 'toast';
  toastEl.innerHTML = '<span class="toast-dot"></span><span class="toast-msg"></span>';
  document.body.appendChild(toastEl);
  let toastTimer = null;
  function showToast(message) {
    toastEl.querySelector('.toast-msg').textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  // The running build, so the sidebar is never a mystery during development.
  const versionEl = document.getElementById('appVersion');
  if (versionEl) {
    try { versionEl.textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) { /* no manifest access */ }
  }

  // --- Cache cooldown ---
  // Stored in minutes (the schema is unchanged), edited in whichever unit reads
  // best: 60 minutes is "1 h", 1440 is "1 d", 90 stays "90 min".
  const cooldownInput = document.getElementById('cacheCooldown');
  const cooldownUnit = document.getElementById('cacheCooldownUnit');

  function setCooldownField(minutes) {
    const m = Math.max(1, parseInt(minutes, 10) || 60);
    const unit = [1440, 60, 1].find(u => m % u === 0 && m / u >= 1) || 1;
    cooldownInput.value = Math.round(m / unit);
    cooldownUnit.value = String(unit);
  }

  // --- Load Settings on Boot ---
  chrome.storage.local.get(['settings'], (data) => {
    const settings = data.settings || { cacheCooldown: 60 };
    setCooldownField(settings.cacheCooldown);
  });

  // --- Utility: Download JSON ---
  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- Global Import/Export Settings ---
  document.getElementById('exportGlobalBtn').addEventListener('click', () => {
    chrome.storage.local.get(['targets', 'discovered', 'settings', 'cache', 'apiBases'], (data) => {
      downloadJSON({ type: 'unvix_global', data }, `unvix_full_backup_${Date.now()}.json`);
    });
  });

  document.getElementById('importGlobalBtn').addEventListener('click', () => {
    document.getElementById('globalImportFile').click();
  });

  document.getElementById('globalImportFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target.result);
        if (json.type === 'unvix_global' && json.data) {
          // Tolerate backups from before exclude rules existed, and anything
          // hand-edited: the field is normalised, never trusted.
          (json.data.targets || []).forEach(t => {
            t.excludes = Array.isArray(t.excludes) ? t.excludes.map(String) : [];
          });
          chrome.storage.local.set(json.data, () => {
            showToast('All data restored');
            // the whole state was replaced, so re-read it from scratch
            setTimeout(() => location.reload(), 800);
          });
        } else {
          alert("Invalid backup file format.");
        }
      } catch (err) { alert("Failed to parse JSON file."); }
    };
    reader.readAsText(file);
  });

  // --- Workspace Import ---
  document.getElementById('importWorkspaceBtn').addEventListener('click', () => {
    document.getElementById('workspaceImportFile').click();
  });

  document.getElementById('workspaceImportFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target.result);
        if (json.type === 'unvix_workspace' && json.target) {
          json.target.excludes = Array.isArray(json.target.excludes) ? json.target.excludes.map(String) : [];
          chrome.storage.local.get(['targets', 'discovered'], (data) => {
            const targets = data.targets || [];
            const discovered = data.discovered || {};
            
            const newId = 'tgt_' + Date.now();
            json.target.id = newId;
            targets.push(json.target);
            discovered[newId] = json.discovered || [];
            
            chrome.storage.local.set({ targets, discovered }, () => {
              showToast(`Workspace "${json.target.name}" imported`);
              renderTargets();
            });
          });
        } else {
          alert("Invalid workspace file format.");
        }
      } catch (err) { alert("Failed to parse JSON file."); }
      e.target.value = ''; 
    };
    reader.readAsText(file);
  });

  // --- Save Settings ---
  document.getElementById('saveSettingsBtn').addEventListener('click', () => {
    const value = parseInt(cooldownInput.value, 10);
    const multiplier = parseInt(cooldownUnit.value, 10) || 1;
    if (!Number.isFinite(value) || value < 1) {
      alert('The cache cooldown must be at least 1 minute.');
      cooldownInput.focus();
      return;
    }
    let minutes = Math.round(value * multiplier);
    const capped = minutes > 10080;          // 7 days
    if (capped) minutes = 10080;

    chrome.storage.local.set({ settings: { cacheCooldown: minutes } }, () => {
      setCooldownField(minutes);
      const status = document.getElementById('settingsSaved');
      if (status) {
        status.textContent = capped ? 'Capped at 7 d' : 'Saved';
        status.classList.add('show');
        setTimeout(() => status.classList.remove('show'), 1800);
      }
    });
  });

  // --- Starter extraction rules ---
  // Loaded from ui/regex-pack.js (generated from regex-pack.txt). Every rule is
  // verified at build time to compile and to never match the empty string, which
  // would otherwise spin extractEndpoints() forever.
  function insertStarterRules() {
    const pack = window.UNVIX_REGEX_PACK || [];
    if (!pack.length) { alert('regex-pack.js did not load.'); return; }
    return pack;
  }

  const packBtn = document.getElementById('insertPackBtn');
  if (packBtn) packBtn.addEventListener('click', () => {
    const ta = document.getElementById('targetRegex');
    const pack = insertStarterRules();
    if (!ta) return;
    // append, don't clobber anything the user already typed
    const existing = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
    const merged = [...new Set([...existing, ...pack])];
    ta.value = merged.join('\n');
  });

  // Keep the caption in sync with the generated pack instead of hardcoding the
  // rule count in the HTML (it went stale the moment the pack changed).
  const packCaption = document.getElementById('packCaption');
  if (packCaption) {
    const n = (window.UNVIX_REGEX_PACK || []).length;
    packCaption.textContent = n
      ? `${n} rules: literal paths, API bases, controller/action, GraphQL, WebSockets, server pages`
      : 'regex-pack.js did not load';
  }

  // --- Exclude rules (out of scope) ---
  //
  // A workspace can name patterns whose endpoints are not interesting: internal
  // APIs, health checks, source maps. Anything matching one is dropped before it
  // is stored, so it never reaches the popup, the count or the badge.
  //
  // A pattern that will not compile is kept in the box (never silently dropped)
  // and reported right next to it: the scanner skips it, so the user has to see
  // that it is not doing anything.
  const EXCLUDE_HINT_NONE = 'Nothing excluded — every match is stored.';

  function compileExcludes(lines) {
    const valid = [], invalid = [];
    for (const raw of lines) {
      const pattern = raw.trim();
      if (!pattern) continue;
      try { new RegExp(pattern, 'i'); valid.push(pattern); }
      catch (e) { invalid.push(pattern); }
    }
    return { valid, invalid };
  }

  function splitLines(value) {
    return (value || '').split('\n').map(line => line.trim()).filter(Boolean);
  }

  function describeExcludes(lines, lastIgnored, pendingRemoval) {
    const { valid, invalid } = compileExcludes(lines);
    if (!valid.length && !invalid.length) return EXCLUDE_HINT_NONE;
    const parts = [`${valid.length} rule${valid.length === 1 ? '' : 's'}`];
    if (invalid.length) {
      parts.push(`${invalid.length} will not compile: ${invalid.map(p => `“${p}”`).join(', ')}`);
    } else if (pendingRemoval) {
      // Said before the save, not after: this is the number about to be deleted.
      parts.push(`would remove ${pendingRemoval} stored finding${pendingRemoval === 1 ? '' : 's'}`);
    } else if (lastIgnored) {
      parts.push(`${lastIgnored} ignored so far`);
    }
    return parts.join(' · ');
  }

  function setExcludeStatus(statusEl, lines, lastIgnored, pendingRemoval) {
    if (!statusEl) return;
    const { invalid } = compileExcludes(lines);
    statusEl.textContent = describeExcludes(lines, lastIgnored, pendingRemoval);
    statusEl.classList.toggle('bad', invalid.length > 0);
    statusEl.classList.toggle('warn', !invalid.length && pendingRemoval > 0);
  }

  // How many ALREADY STORED findings a set of rules covers. Used twice: while
  // typing (so the number is never a surprise) and again on save (so the number
  // acted on is the one just confirmed).
  function matchersFor(lines) {
    return compileExcludes(lines).valid.map(p => new RegExp(p, 'i'));
  }

  function countStoredMatches(targetId, lines, done) {
    const matchers = matchersFor(lines);
    if (!matchers.length) { done(0); return; }
    chrome.storage.local.get(['discovered'], (data) => {
      const rows = (data.discovered || {})[targetId] || [];
      done(rows.filter(row => matchers.some(re => re.test(row[0] || ''))).length);
    });
  }

  // Live feedback while typing, on both the create form and every workspace.
  const createExcludesEl = document.getElementById('targetExcludes');
  if (createExcludesEl) {
    const applyDefaults = () => {
      const pack = window.UNVIX_EXCLUDE_PACK || [];
      if (!pack.length) return false;
      // append, never clobber what is already in the box
      const merged = [...new Set([...splitLines(createExcludesEl.value), ...pack])];
      createExcludesEl.value = merged.join('\n');
      setExcludeStatus(document.getElementById('createExcludeStatus'), merged);
      return true;
    };
    // The box starts empty on purpose. A workspace is a deliberate act, and a
    // form that arrives pre-filled with twelve patterns the user did not write
    // is a form they have to read before they can trust it; the button is one
    // click and says exactly what it adds.
    setExcludeStatus(document.getElementById('createExcludeStatus'), splitLines(createExcludesEl.value));
    createExcludesEl.addEventListener('input', () => {
      setExcludeStatus(document.getElementById('createExcludeStatus'), splitLines(createExcludesEl.value));
    });
    const packBtn = document.getElementById('insertExcludePackBtn');
    if (packBtn) packBtn.addEventListener('click', applyDefaults);
  }

  // --- Create New Target ---
  document.getElementById('saveBtn').addEventListener('click', () => {
    const name = document.getElementById('targetName').value.trim();
    const scopes = document.getElementById('targetScopes').value.split('\n').map(s => s.trim()).filter(Boolean);
    const regexes = document.getElementById('targetRegex').value.split('\n').map(r => r.trim()).filter(Boolean);
    const excludeEl = document.getElementById('targetExcludes');
    const excludes = excludeEl ? splitLines(excludeEl.value) : [];

    if (!name || scopes.length === 0 || regexes.length === 0) {
      alert('Please fill out all fields.');
      return;
    }

    const newTarget = {
      id: 'tgt_' + Date.now(),
      name,
      scopes,
      regexes,
      excludes
    };

    chrome.storage.local.get(['targets'], (data) => {
      const targets = data.targets || [];
      targets.push(newTarget);
      chrome.storage.local.set({ targets }, () => {
        document.getElementById('targetName').value = '';
        document.getElementById('targetScopes').value = '';
        document.getElementById('targetRegex').value = '';
        if (excludeEl) excludeEl.value = '';
        setExcludeStatus(document.getElementById('createExcludeStatus'), []);
        chrome.storage.local.get(['excludeHits'], (d) => {
          const hits = d.excludeHits || {};
          hits[newTarget.id] = 0;
          chrome.storage.local.set({ excludeHits: hits });
        });
        const bad = compileExcludes(excludes).invalid;
        showToast(bad.length
          ? `Workspace "${newTarget.name}" deployed — ${bad.length} exclude rule(s) will not compile`
          : `Workspace "${newTarget.name}" deployed`);
      });
    });
  });

  // --- Render Targets (HTML Generation) ---
  function renderTargets() {
    const list = document.getElementById('targetList');
    list.innerHTML = '';

    chrome.storage.local.get(['targets', 'discovered', 'excludeHits'], (data) => {
      const targets = data.targets || [];
      const discovered = data.discovered || {};
      const excludeHits = data.excludeHits || {};

      if (targets.length === 0) {
        list.innerHTML = `<p style="color: var(--text-muted); font-size: 14px;">No active workspaces. Create one first.</p>`;
        return;
      }

      targets.forEach((target, index) => {
        const endpoints = discovered[target.id] || [];
        const newCount = endpoints.filter(e => e[2] === 1).length;
        const excludes = Array.isArray(target.excludes) ? target.excludes : [];
        const ignoredLast = (excludeHits && excludeHits[target.id]) || 0;
        const card = document.createElement('div');
        card.className = 'target-card';
        card.id = `card-${target.id}`;
        
        // Build the Scope dropdown dynamically
        const scopeOptions = target.scopes.map(s => `<option value="${s}">${s}</option>`).join('');

        card.innerHTML = `
          <div class="target-header">
            <div class="target-info" style="cursor:pointer;" data-toggle-details="${target.id}">
              <h3>${escapeHtml(target.name)} <span style="color:var(--text-dim)">▾</span></h3>
              <p>${plural(target.scopes.length, 'scope')} · ${plural(target.regexes.length, 'rule')} · ${plural(endpoints.length, 'endpoint')}${excludes.length ? ` · ${plural(excludes.length, 'exclude rule')}` : ''}${newCount ? ` <span class="pill pill-new">${newCount} new</span>` : ''}</p>
            </div>
            <div style="display:flex; gap: 10px;">
              <button class="btn btn-secondary btn-sm export-ws-btn" data-id="${target.id}">Export</button>
              <button class="btn btn-secondary btn-sm toggle-details-btn" data-toggle-details="${target.id}">Manage</button>
              <button class="btn btn-danger btn-sm delete-btn" data-index="${index}">Delete</button>
            </div>
          </div>
          
          <div class="target-details" id="details-${target.id}" style="display: none;">
            <div class="target-tabs">
              <button class="target-tab active" data-target="${target.id}" data-tab="endpoints">Endpoints (${endpoints.length})${newCount ? ` · ${newCount} new` : ''}</button>
              <button class="target-tab" data-target="${target.id}" data-tab="config">Configuration</button>
            </div>
            
            <div class="target-tab-content active" id="content-endpoints-${target.id}">
              <div class="endpoint-toolbar">
                <input type="text" class="search-ep-input" data-target="${target.id}" placeholder="Search endpoints or sources…" autocomplete="off">
                <select class="scope-filter-select" data-target="${target.id}">
                  <option value="ALL">All sources</option>
                  ${scopeOptions}
                </select>
                <label class="toggle" id="newtoggle-${target.id}">
                  <input type="checkbox" class="newonly-ep-input" data-target="${target.id}"> NEW only
                </label>
                <button class="btn btn-secondary btn-sm copy-eps-btn" data-id="${target.id}">Copy</button>
                <span class="toolbar-count" id="count-${target.id}"></span>
              </div>
              <div id="endpoint-rows-${target.id}"></div>
            </div>

            <div class="target-tab-content" id="content-config-${target.id}">
              <div class="form-group">
                <label>Workspace Name</label>
                <input type="text" id="editName-${target.id}" value="${target.name}">
              </div>
              <div class="form-group">
                <label>Scopes (One per line)</label>
                <textarea id="editScopes-${target.id}">${target.scopes.join('\n')}</textarea>
              </div>
              <div class="form-group">
                <label>Regex Extraction Rules (One per line)</label>
                <textarea id="editRegexes-${target.id}">${target.regexes.join('\n')}</textarea>
                <div style="margin-top: 8px;">
                  <button class="btn btn-secondary btn-sm insert-pack-edit-btn" data-target="${target.id}">Insert Starter Rules</button>
                </div>
              </div>
              <div class="form-group">
                <label>Exclude Rules <span class="label-note">out of scope · one per line</span></label>
                <textarea id="editExcludes-${target.id}" class="exclude-input" data-target="${target.id}"
                          placeholder="One pattern per line, e.g. ^/api/internal/">${escapeHtml(excludes.join('\n'))}</textarea>
                <p class="hint">
                  An endpoint matching any of these is ignored on every later scan. Matching is case-insensitive
                  and runs against the whole path; a pattern that does not compile is reported below and skipped.
                  Saving tells you how many stored findings the rules now cover, and removes them only if you agree.
                </p>
                <div class="hint-row">
                  <button type="button" class="btn btn-secondary btn-sm insert-exclude-pack-btn" data-id="${target.id}">Insert Default Rules</button>
                  <span class="hint rule-status" id="excludeStatus-${target.id}"></span>
                </div>
              </div>

              <button class="btn btn-sm save-target-edit-btn" data-id="${target.id}" data-index="${index}">Save Configuration</button>
            </div>
          </div>
        `;
        list.appendChild(card);
        previewIgnored[target.id] = ignoredLast;
        setExcludeStatus(document.getElementById(`excludeStatus-${target.id}`), excludes, ignoredLast);
        renderEndpointsForTarget(target.id, endpoints);
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Rows repeat the same bundle URL prefix hundreds of times, so show only the
  // meaningful tail (…/assets/main.abc123.js); the full URL stays in the tooltip
  // and the link itself.
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


  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  // Clipboard with no extra manifest permission: the async API needs a gesture
  // (we always have one) and falls back to execCommand when it is unavailable.
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

  // --- Render Individual Endpoints & Apply Filters ---
  function renderEndpointsForTarget(targetId, endpoints, searchText = "", scopeFilter = "ALL", onlyNew = false) {
    const rowContainer = document.getElementById(`endpoint-rows-${targetId}`);
    if (!rowContainer) return;
    rowContainer.innerHTML = '';

    // Map to preserve original array index for deletion/editing
    let filtered = endpoints.map((epData, originalIndex) => ({ epData, originalIndex }));

    // Apply the NEW-only filter (tuple index 2 is the isNew flag)
    if (onlyNew) filtered = filtered.filter(item => item.epData[2] === 1);

    // Apply Text Search
    if (searchText) {
      const lowerSearch = searchText.toLowerCase();
      filtered = filtered.filter(item =>
        (item.epData[0] && item.epData[0].toLowerCase().includes(lowerSearch)) ||
        (item.epData[3] && item.epData[3].toLowerCase().includes(lowerSearch))
      );
    }

    // Apply Scope Filter on Source URL
    if (scopeFilter !== "ALL") {
      filtered = filtered.filter(item => {
        const sourceUrl = item.epData[3] || "";
        if (scopeFilter.includes('*')) {
          const regexStr = scopeFilter.replace(/\./g, '\\.').replace(/\*/g, '.*');
          return new RegExp(regexStr).test(sourceUrl);
        }
        return sourceUrl.includes(scopeFilter);
      });
    }

    const countEl = document.getElementById(`count-${targetId}`);
    if (countEl) countEl.textContent = `${filtered.length} / ${endpoints.length}`;

    if (filtered.length === 0) {
      rowContainer.innerHTML = `<p class="empty-msg">${endpoints.length
        ? 'No endpoints match these filters.'
        : 'Nothing captured yet — open the site with this workspace active.'}</p>`;
      return;
    }

    // Sort Newest First
    const sortedEndpoints = filtered.sort((a, b) => (b.epData[1] || 0) - (a.epData[1] || 0));

    sortedEndpoints.forEach((item) => {
      const epData = item.epData;
      const epIndex = item.originalIndex;
      const path = epData[0];
      const isNew = epData[2] === 1;
      const sourceUrl = epData[3] || '';

      const row = document.createElement('div');
      row.className = 'endpoint-row' + (isNew ? ' is-new' : '');
      row.id = `row-${targetId}-${epIndex}`;

      // The source line names the file: host first, then the tail of the path.
      // Only http(s) sources become a link; an inline block (and anything else
      // with no URL) is shown as the label it is rather than as "unknown".
      const source = describeSource(sourceUrl);
      const displaySource = source.href
        ? `↳ <a href="${escapeHtml(source.href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(source.href)}">${escapeHtml(source.text)}</a>`
        : `↳ ${escapeHtml(source.text)}`;

      row.innerHTML = `
        <div class="endpoint-main">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <span class="endpoint-path" id="text-${targetId}-${epIndex}">${escapeHtml(path)}</span>
            ${isNew ? '<span class="pill-new-quiet">NEW</span>' : ''}
          </div>
          <span class="endpoint-source">${displaySource}</span>
        </div>
        <div class="endpoint-actions">
          <button class="btn btn-secondary btn-sm edit-ep-btn" data-target-id="${targetId}" data-ep-index="${epIndex}">Edit</button>
          <button class="btn btn-danger btn-sm delete-ep-btn" data-target-id="${targetId}" data-ep-index="${epIndex}">Delete</button>
        </div>
      `;
      rowContainer.appendChild(row);
    });
  }

  // --- Re-read all three filters for one workspace and redraw its list ---
  function refreshTargetList(targetId) {
    const s = document.querySelector(`.search-ep-input[data-target="${targetId}"]`);
    const f = document.querySelector(`.scope-filter-select[data-target="${targetId}"]`);
    const n = document.querySelector(`.newonly-ep-input[data-target="${targetId}"]`);
    chrome.storage.local.get(['discovered'], (data) => {
      renderEndpointsForTarget(targetId, data.discovered[targetId] || [],
        s ? s.value : '', f ? f.value : 'ALL', n ? n.checked : false);
    });
  }

  // --- Update one card's counts in place ---
  // Deleting or editing a single endpoint used to call renderTargets(), which
  // rebuilt every card: the panel snapped shut, the filters reset and the
  // scroll position was lost. These two helpers refresh only what changed.
  function refreshTargetHeader(targetId) {
    chrome.storage.local.get(['targets', 'discovered'], (data) => {
      const target = (data.targets || []).find(t => t.id === targetId);
      const card = document.getElementById(`card-${targetId}`);
      if (!target || !card) return;

      const eps = (data.discovered || {})[targetId] || [];
      const newCount = eps.filter(e => e[2] === 1).length;

      const p = card.querySelector('.target-info p');
      if (p) {
        p.innerHTML = `${plural(target.scopes.length, 'scope')} · ${plural(target.regexes.length, 'rule')} · ${plural(eps.length, 'endpoint')}${newCount ? ` <span class="pill pill-new">${newCount} new</span>` : ''}`;
      }
      const tab = card.querySelector('.target-tab[data-tab="endpoints"]');
      if (tab) tab.textContent = `Endpoints (${eps.length})${newCount ? ` · ${newCount} new` : ''}`;
    });
  }

  function refreshTargetAfterEdit(targetId) {
    refreshTargetList(targetId);
    refreshTargetHeader(targetId);
  }

  // Per-workspace "ignored so far" numbers, so the live preview can put them
  // back when a rule is deleted again.
  const previewIgnored = {};
  let previewTimer = null;

  // --- Real-time Filter Listeners ---
  document.getElementById('targetList').addEventListener('input', (e) => {
    if (e.target.classList.contains('search-ep-input')) {
      refreshTargetList(e.target.getAttribute('data-target'));
    }
    if (e.target.classList.contains('exclude-input')) {
      const targetId = e.target.getAttribute('data-target');
      const statusEl = document.getElementById(`excludeStatus-${targetId}`);
      const lines = splitLines(e.target.value);
      setExcludeStatus(statusEl, lines);
      // Debounced: the box is a regex editor, and every keystroke is not a
      // reason to walk the stored findings.
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        countStoredMatches(targetId, lines, (n) => {
          const lastIgnored = (previewIgnored[targetId] || 0);
          setExcludeStatus(statusEl, splitLines(e.target.value), lastIgnored, n);
        });
      }, 250);
    }
  });

  document.getElementById('targetList').addEventListener('change', (e) => {
    const id = e.target.getAttribute('data-target');
    if (e.target.classList.contains('scope-filter-select')) refreshTargetList(id);
    if (e.target.classList.contains('newonly-ep-input')) {
      const lbl = document.getElementById(`newtoggle-${id}`);
      if (lbl) lbl.classList.toggle('on', e.target.checked);
      refreshTargetList(id);
    }
  });


  // --- GLOBAL EVENT DELEGATOR (Fixes UI State & Event Overlaps) ---
  document.getElementById('targetList').addEventListener('click', (e) => {
    const tgt = e.target;

    // 1. Expand/Collapse Manage Panel
    const toggleBtn = tgt.closest('[data-toggle-details]');
    if (toggleBtn) {
      const targetId = toggleBtn.getAttribute('data-toggle-details');
      const detailsPanel = document.getElementById(`details-${targetId}`);
      if(detailsPanel) detailsPanel.style.display = detailsPanel.style.display === 'none' ? 'block' : 'none';
      return;
    }

    // 2. Tab Navigation
    if (tgt.classList.contains('target-tab')) {
      const targetId = tgt.getAttribute('data-target');
      const tabName = tgt.getAttribute('data-tab');
      
      document.querySelectorAll(`#details-${targetId} .target-tab`).forEach(t => t.classList.remove('active'));
      document.querySelectorAll(`#details-${targetId} .target-tab-content`).forEach(c => c.classList.remove('active'));
      
      tgt.classList.add('active');
      document.getElementById(`content-${tabName}-${targetId}`).classList.add('active');
      return;
    }

    // 3. Edit Endpoint inline
    if (tgt.classList.contains('edit-ep-btn')) {
      const tId = tgt.getAttribute('data-target-id');
      const epIdx = parseInt(tgt.getAttribute('data-ep-index'));
      const textElement = document.getElementById(`text-${tId}-${epIdx}`);
      const currentPath = textElement.innerText;

      textElement.innerHTML = `<input type="text" class="inline-edit-input" id="input-${tId}-${epIdx}">`;
      const inlineInput = document.getElementById(`input-${tId}-${epIdx}`);
      inlineInput.value = currentPath;
      // the row uses the extra width for the editor (see .is-editing in theme.css)
      const rowEl = tgt.closest('.endpoint-row');
      if (rowEl) rowEl.classList.add('is-editing');
      inlineInput.focus();
      inlineInput.select();
      // Enter saves through the same handler, Escape redraws the row (discarding
      // the edit) — the editor is otherwise a mouse-only dead end.
      inlineInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); tgt.click(); }
        if (e.key === 'Escape') { e.preventDefault(); refreshTargetList(tId); }
      });

      tgt.classList.remove('edit-ep-btn', 'btn-secondary');
      tgt.classList.add('save-ep-inline-btn');
      tgt.innerText = "Save";
      // same accent as every other primary action, instead of a stray green
      tgt.style.backgroundColor = "var(--accent)";
      tgt.style.color = "var(--accent-ink)";
      tgt.style.borderColor = "var(--accent)";
      return;
    }

    // 4. Save Edited Endpoint
    if (tgt.classList.contains('save-ep-inline-btn')) {
      const tId = tgt.getAttribute('data-target-id');
      const epIdx = parseInt(tgt.getAttribute('data-ep-index'));
      const inputVal = document.getElementById(`input-${tId}-${epIdx}`).value.trim();

      if (!inputVal) {
        alert("Endpoint path cannot be empty.");
        return;
      }

      chrome.storage.local.get(['discovered'], (data) => {
        let discovered = data.discovered || {};
        if (discovered[tId] && discovered[tId][epIdx]) {
          discovered[tId][epIdx][0] = inputVal;
          chrome.storage.local.set({ discovered }, () => refreshTargetAfterEdit(tId));
        }
      });
      return;
    }

    // 5. Delete Endpoint
    if (tgt.classList.contains('delete-ep-btn')) {
      const tId = tgt.getAttribute('data-target-id');
      const epIdx = parseInt(tgt.getAttribute('data-ep-index'));
      chrome.storage.local.get(['discovered'], (data) => {
        let discovered = data.discovered || {};
        if (discovered[tId]) {
          discovered[tId].splice(epIdx, 1);
          chrome.storage.local.set({ discovered }, () => refreshTargetAfterEdit(tId));
        }
      });
      return;
    }

    // 6. Delete Target Workspace
    if (tgt.classList.contains('delete-btn')) {
      const index = parseInt(tgt.getAttribute('data-index'));
      if (confirm("Are you sure you want to delete this workspace and all of its collected findings?")) {
        chrome.storage.local.get(['targets', 'discovered'], (data) => {
          let targets = data.targets || [];
          const targetId = targets[index].id;
          
          targets.splice(index, 1);
          let discovered = data.discovered || {};
          delete discovered[targetId];

          chrome.storage.local.set({ targets, discovered }, () => renderTargets());
        });
      }
      return;
    }

    // 7. Insert the starter rule pack into this workspace's rules
    if (tgt.classList.contains('insert-pack-edit-btn')) {
      const targetId = tgt.getAttribute('data-target');
      const ta = document.getElementById(`editRegexes-${targetId}`);
      const pack = window.UNVIX_REGEX_PACK || [];
      if (!pack.length) { alert('regex-pack.js did not load.'); return; }
      const existing = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
      ta.value = [...new Set([...existing, ...pack])].join('\n');
      return;
    }

    // 8. Copy the currently filtered endpoint list
    if (tgt.classList.contains('copy-eps-btn')) {
      const tId = tgt.getAttribute('data-id');
      const s = document.querySelector(`.search-ep-input[data-target="${tId}"]`);
      const f = document.querySelector(`.scope-filter-select[data-target="${tId}"]`);
      const n = document.querySelector(`.newonly-ep-input[data-target="${tId}"]`);
      chrome.storage.local.get(['discovered'], (data) => {
        const all = data.discovered[tId] || [];
        const onlyNew = n ? n.checked : false;
        const q = (s ? s.value : '').trim().toLowerCase();
        const scope = f ? f.value : 'ALL';
        const list = all
          .filter(ep => !onlyNew || ep[2] === 1)
          .filter(ep => !q || (ep[0] || '').toLowerCase().includes(q) || (ep[3] || '').toLowerCase().includes(q))
          .filter(ep => {
            if (scope === 'ALL') return true;
            const src = ep[3] || '';
            if (scope.includes('*')) return new RegExp(scope.replace(/\./g, '\\.').replace(/\*/g, '.*')).test(src);
            return src.includes(scope);
          })
          .map(ep => ep[0]);
        copyText(list.join('\n')).then(ok => {
          const label = tgt.innerText;
          tgt.innerText = ok ? `Copied ${list.length}` : 'Copy failed';
          setTimeout(() => { tgt.innerText = label; }, 1500);
        });
      });
      return;
    }

    // 9. Save Target Config Changes
    if (tgt.classList.contains('save-target-edit-btn')) {
      const targetId = tgt.getAttribute('data-id');
      const idx = parseInt(tgt.getAttribute('data-index'));
      
      const updatedName = document.getElementById(`editName-${targetId}`).value.trim();
      const updatedScopes = document.getElementById(`editScopes-${targetId}`).value.split('\n').map(s => s.trim()).filter(Boolean);
      const updatedRegexes = document.getElementById(`editRegexes-${targetId}`).value.split('\n').map(r => r.trim()).filter(Boolean);
      const excludeBox = document.getElementById(`editExcludes-${targetId}`);
      const updatedExcludes = excludeBox ? splitLines(excludeBox.value) : [];

      if (!updatedName || updatedScopes.length === 0 || updatedRegexes.length === 0) {
        alert("Fields cannot be empty.");
        return;
      }

      chrome.storage.local.get(['targets', 'discovered', 'excludeHits'], (data) => {
        const localTargets = data.targets || [];
        const discovered = data.discovered || {};
        const hits = data.excludeHits || {};
        if (!localTargets[idx]) { alert('That workspace is gone — reopen the dashboard.'); return; }

        // Out of scope: count what the rules now cover BEFORE saving, and delete
        // only on an explicit yes. The rules are what the user asked to save, so
        // the question is about the findings already stored — and cancelling
        // leaves everything untouched, including the rules.
        const matchers = matchersFor(updatedExcludes);
        const rows = discovered[targetId] || [];
        const covered = (row) => matchers.some(re => re.test(row[0] || ''));
        const matched = matchers.length ? rows.filter(covered).length : 0;

        const persist = (removing) => {
          const rulesChanged = JSON.stringify(localTargets[idx].excludes || []) !== JSON.stringify(updatedExcludes);
          localTargets[idx].name = updatedName;
          localTargets[idx].scopes = updatedScopes;
          localTargets[idx].regexes = updatedRegexes;
          localTargets[idx].excludes = updatedExcludes;
          if (rulesChanged) hits[targetId] = 0;   // the old count belonged to the old rules
          if (removing) discovered[targetId] = rows.filter(row => !covered(row));

          chrome.storage.local.set({ targets: localTargets, discovered, excludeHits: hits }, () => {
            const bad = compileExcludes(updatedExcludes).invalid;
            const removed = removing ? ` — removed ${matched} finding${matched === 1 ? '' : 's'}` : '';
            showToast(bad.length
              ? `Workspace updated — ${bad.length} exclude rule(s) will not compile`
              : `Workspace updated${removed}`);
            renderTargets();
          });
        };

        if (matched) {
          const plural = matched === 1 ? 'finding' : 'findings';
          if (confirm(`${matched} stored ${plural} match these exclude rules.\n\n` +
                      `Delete ${matched === 1 ? 'it' : 'them'}?\n\n` +
                      `OK   — save the rules and delete ${matched} ${plural}\n` +
                      `Cancel — change nothing`)) {
            persist(true);
          }
          return;
        }
        persist(false);
      });
      return;
    }

    // 10. Insert the default exclude rules into a workspace
    if (tgt.classList.contains('insert-exclude-pack-btn')) {
      const targetId = tgt.getAttribute('data-id');
      const box = document.getElementById(`editExcludes-${targetId}`);
      const pack = window.UNVIX_EXCLUDE_PACK || [];
      if (!box || !pack.length) { showToast('exclude-pack.js did not load'); return; }
      const merged = [...new Set([...splitLines(box.value), ...pack])];
      box.value = merged.join('\n');
      const statusEl = document.getElementById(`excludeStatus-${targetId}`);
      setExcludeStatus(statusEl, merged);
      countStoredMatches(targetId, merged, (n) => setExcludeStatus(statusEl, merged, previewIgnored[targetId] || 0, n));
      return;
    }

    // 11. Export Single Workspace
    if (tgt.classList.contains('export-ws-btn')) {
      const targetId = tgt.getAttribute('data-id');
      chrome.storage.local.get(['targets', 'discovered'], (data) => {
        const target = data.targets.find(t => t.id === targetId);
        const discovered = data.discovered[targetId] || [];
        const payload = { type: 'unvix_workspace', target, discovered };
        downloadJSON(payload, `${target.name.replace(/\s+/g, '_')}_workspace.json`);
      });
      return;
    }

  });

  // --- Purge All Discovered Data ---
  document.getElementById('clearDataBtn').addEventListener('click', () => {
    if(confirm("Are you sure? This will delete all discovered endpoints globally (Workspaces will be kept).")) {
      chrome.storage.local.set({ discovered: {}, cache: {} }, () => {
        showToast('All findings purged');
        renderTargets();
      });
    }
  });

});
