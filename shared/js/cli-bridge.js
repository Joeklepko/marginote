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
    snapshot: () => ({
      version: '1.2.4',
      notebooks,
      notes,
      todos,
      workdir: (_workdirCfg && _workdirCfg.enabled) ? (_workdirCfg.name || null) : null
    })
  });

  let draining = false;
  async function drainRequests() {
    if (draining) return;
    draining = true;
    try {
      const requests = (await invoke('cmd_cli_take_requests')) || [];
      for (const request of requests) {
        try {
          const data = await handler(request.command, request.args || {});
          await invoke('cmd_cli_complete', { id: request.id, ok: true, data: data == null ? null : data, error: null });
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          await invoke('cmd_cli_complete', { id: request.id, ok: false, data: null, error: message });
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
