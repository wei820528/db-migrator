// Connection presets stored in browser localStorage.
(function () {
  const DBM = (window.DBM = window.DBM || {});
  const KEY = 'dbmigrator.connections.v1';

  function loadAll() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
  }
  function saveAll(map) {
    try { localStorage.setItem(KEY, JSON.stringify(map)); } catch {}
  }
  function presetsFor(type) { return loadAll()[type] || []; }

  function keyOf(type, c) {
    if (type === 'sqlite') return c.path || '';
    return `${c.host}|${c.user}|${c.authMode || 'sql'}`;
  }
  function labelOf(type, c) {
    if (type === 'sqlite') return c.path || '(unnamed)';
    const auth = c.authMode === 'windows' ? '🪟' : '';
    return `${c.user}@${c.host} ${auth}`.trim();
  }

  function save(type, conn) {
    const all = loadAll();
    const list = all[type] || [];
    const k = keyOf(type, conn);
    const idx = list.findIndex((p) => keyOf(type, p) === k);
    const entry = { ...conn, _label: labelOf(type, conn), _saved: Date.now() };
    if (idx >= 0) list[idx] = entry;
    else list.unshift(entry);
    all[type] = list.slice(0, 10);   // keep most recent 10
    saveAll(all);
    render();
  }

  function remove(idx) {
    const all = loadAll();
    const list = all[DBM.state.type] || [];
    list.splice(idx, 1);
    all[DBM.state.type] = list;
    saveAll(all);
    render();
  }

  function render() {
    const sel = DBM.$('#preset-select');
    const row = DBM.$('#presets-row');
    if (!sel || !row) return;
    const list = presetsFor(DBM.state.type);
    sel.innerHTML = '<option value="">— 選擇 —</option>' +
      list.map((p, i) => `<option value="${i}">${DBM.escapeHtml(p._label)}</option>`).join('');
    row.hidden = list.length === 0;
  }

  DBM.presets = { save, remove, render, presetsFor };

  DBM.presets.init = function () {
    document.addEventListener('change', (e) => {
      if (e.target.id === 'preset-select') {
        const idx = Number(e.target.value);
        if (Number.isFinite(idx)) {
          const p = presetsFor(DBM.state.type)[idx];
          if (p) DBM.connection?.applyValuesToForm(p);
        }
      }
    });
    document.addEventListener('click', (e) => {
      if (e.target.id === 'btn-delete-preset') {
        const idx = Number(DBM.$('#preset-select').value);
        if (Number.isFinite(idx) && confirm('刪除這筆儲存的連線？')) remove(idx);
      }
    });
  };
})();
