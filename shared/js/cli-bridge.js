// Desktop integration for marginote-cli. Requests arrive through the Rust
// loopback bridge and are executed by the same tools as the built-in AI.
(function () {
  if (typeof window === 'undefined' || !window.MarginoteCliCore) return;

  const tauri = window.__TAURI__;
  const internals = window.__TAURI_INTERNALS__;
  const invoke =
    (tauri && tauri.core && typeof tauri.core.invoke === 'function' && tauri.core.invoke) ||
    (internals && typeof internals.invoke === 'function' && internals.invoke) ||
    null;
  if (!invoke) return;

  const handler = window.MarginoteCliCore.createHandler({
    tools: ASSISTANT_TOOLS,
    runTransaction: async (label, task, metadata) => {
      if (!window.MarginoteRepository) return await task();
      const outcome = await window.MarginoteRepository.run(label, task, metadata);
      return outcome.value;
    },
    snapshot: () => ({
      version: '1.2.4',
      notebooks,
      notes,
      todos,
      workdir: (_workdirCfg && _workdirCfg.enabled) ? (_workdirCfg.name || null) : null,
      storageMode: _mainDataStorageMode,
      storageError: (_workdirCfg && _workdirCfg.lastError) ? _workdirCfg.lastError : null
    })
  });

  const IDEMPOTENCY_KEY = 'marginote.cli.idempotency.v1';

  function loadIdempotencyRecords() {
    try {
      return window.MarginoteCliCore.pruneIdempotencyRecords(JSON.parse(localStorage.getItem(IDEMPOTENCY_KEY) || '[]'));
    } catch {
      return [];
    }
  }

  function saveIdempotencyRecords(records) {
    try { localStorage.setItem(IDEMPOTENCY_KEY, JSON.stringify(records)); } catch {}
  }

  let draining = false;
  async function drainRequests() {
    if (draining) return;
    draining = true;
    try {
      const requests = (await invoke('cmd_cli_take_requests')) || [];
      for (let index = 0; index < requests.length; index++) {
        const request = requests[index];
        try {
          const requestId = request.requestId || request.id;
          const fingerprint = window.MarginoteCliCore.requestFingerprint(request.command, request.args || {});
          const cacheable = request.args?._dryRun !== true && window.MarginoteToolPolicyCore?.isWrite(request.command);
          let records = loadIdempotencyRecords();
          const cached = cacheable
            ? window.MarginoteCliCore.lookupIdempotencyRecord(records, requestId, fingerprint)
            : { kind: 'miss' };
          if (cached.kind === 'conflict') throw new Error(`请求 ID ${requestId} 已用于不同操作，请更换 --request-id`);
          const data = cached.kind === 'hit'
            ? cached.data
            : await handler(request.command, request.args || {});
          if (cacheable && cached.kind !== 'hit') {
            records = window.MarginoteCliCore.recordIdempotencyResult(records, {
              requestId,
              fingerprint,
              data: data == null ? null : data,
              completedAt: Date.now()
            });
            saveIdempotencyRecords(records);
          }
          await invoke('cmd_cli_complete', { id: request.id, ok: true, data: data == null ? null : data, error: null });
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          try {
            await invoke('cmd_cli_complete', { id: request.id, ok: false, data: null, error: message });
          } catch (completeError) {
            console.warn('cli bridge completion failed', completeError);
          }
        }
      }
    } catch (error) {
      console.warn('cli bridge drain failed', error);
    } finally {
      draining = false;
    }
  }

  async function start() {
    if (window.mn && window.mn.ready) await window.mn.ready;
    // Avoid the startup race where a CLI request arrives before the Markdown
    // workdir has been loaded and legacy WebView data has finished migrating.
    if (window.MarginoteDesktopDataReady) await window.MarginoteDesktopDataReady;
    // Event delivery wakes hidden WebViews. A low-frequency poll covers the
    // startup race before this listener has been attached.
    const eventApi = tauri && tauri.event;
    if (eventApi && typeof eventApi.listen === 'function') {
      try { await eventApi.listen('marginote-cli-pending', drainRequests); } catch (error) {}
    }
    await drainRequests();
    window.setInterval(drainRequests, 2000);
  }

  start().catch(error => console.warn('cli bridge start failed', error));
})();
