# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-06

Initial public release under the **Marginote** name.

### Features
- Markdown editor with auto-save (400ms debounce)
- Notebook → folder → note hierarchy with tags, favorites, recycle bin
- Todo list with system-level reminders (lead time, repeat count, interval)
- 10+ themes (light / dark / eye-care / morandi / high-contrast)
- AI optimization with multi-provider support (DeepSeek / Kimi / OpenAI / Ollama / custom proxy)
- Image paste/drag with base64 inline or `_assets/` directory
- Full-text search across title, content, tags, and notebooks
- One-click zip export / import (notes + images + todos + config)
- Periodic auto-backup to download directory
- File System Access API for local folder sync
- Reading mode (focus full-screen)
- Split-pane editor (markdown + preview)
- Document outline panel
- Mobile-responsive layout
- Accessibility: focus-visible scoped to interactive controls only — text inputs use caret as focus indicator

### Notes
- Extension does **not** override the new tab page. Open via toolbar icon. To restore the override, add `"chrome_url_overrides": { "newtab": "index.html" }` to `manifest.json`.
- All data stored locally via `chrome.storage.local`. No telemetry, no remote scripts.
