# Unvix — Firefox Edition

This directory contains the complete, ready-to-load Firefox Manifest V3 (MV3) version of the Unvix extension.

## How to Install and Test in Firefox

### Method 1: Load Temporary Add-on (Recommended for Development)

1. Open Firefox.
2. In the URL bar, go to:
   ```text
   about:debugging#/runtime/this-firefox
   ```
   *(Or navigate to `about:debugging` and select **This Firefox** from the left-hand navigation).*
3. Under the **Temporary Extensions** section, click **Load Temporary Add-on...**.
4. In the file dialog, navigate into this `firefox` folder and select `manifest.json`.
5. Unvix will load immediately:
   - The toolbar icon will appear in Firefox's extension bar.
   - Click the icon to view the popup dashboard.
   - Click **Dashboard** to manage workspaces, configure extraction rules, and set exclusion filters.

> **Tip:** If you modify files in this directory during development, click the **Reload** button under the extension entry in `about:debugging` to apply changes.

---

### Method 2: Package into a `.zip` / `.xpi`

To distribute or sign the add-on via Mozilla Add-ons (AMO):
1. Select all files and folders **inside** the `firefox/` directory (not the `firefox` folder itself).
2. Create a zip archive (e.g. `unvix-firefox.zip` or `unvix-firefox.xpi`).
3. Upload to [Mozilla Add-ons Developer Hub](https://addons.mozilla.org/developers/) for signing.

---

## Firefox-Specific Features and Manifest Changes

| Feature | Chrome (Root) | Firefox (`firefox/`) |
| :--- | :--- | :--- |
| **Manifest Version** | MV3 (`manifest_version: 3`) | MV3 (`manifest_version: 3`) |
| **Add-on Identity** | None (assigned by Web Store) | `browser_specific_settings.gecko.id: "unvix@unvix.local"` |
| **Minimum Firefox Version** | N/A | Firefox 109.0+ (`strict_min_version: "109.0"`) |
| **Background Mechanism** | Service worker (`background.service_worker`) | Event background page (`background.scripts`) |
| **Options Page** | `options_page: "ui/options.html"` | `options_ui: { "page": "ui/options.html", "open_in_tab": true }` |
| **Permissions** | `storage`, `activeTab`, `scripting`, `notifications` | `storage`, `activeTab`, `scripting`, `notifications`, `clipboardWrite` |
| **API Namespace** | `chrome.*` | Cross-browser `browser.*` and `chrome.*` compatibility |

---

## Directory Structure

```text
firefox/
├── manifest.json       # Firefox MV3 manifest with gecko ID & background scripts
├── background.js       # Background event script (chunk resolution, fetch, scan queue)
├── content.js          # Script harvesting & DOM/performance observer
├── icons/              # 16/32/48/128 PNGs + SVG icon
├── ui/
│   ├── popup.html      # Findings popup
│   ├── popup.js        # Popup controller (scoped workspaces, NEW filtering)
│   ├── options.html    # Full dashboard (workspaces, rules, import/export)
│   ├── options.js      # Dashboard controller
│   ├── page-scope.js   # Scope matching logic
│   ├── regex-pack.js   # Extraction rules pack
│   ├── exclude-pack.js # Exclusion filter rules pack
│   └── theme.css       # Dark theme styles
└── README.md           # This guide
```
