// Probe /api/modules on load — disable unavailable cards / tabs.
(function () {
  const DBM = (window.DBM = window.DBM || {});

  async function loadStatus() {
    let r;
    try { r = await fetch('/api/modules').then((x) => x.json()); }
    catch (e) { console.warn('[module-status] failed:', e); return; }

    DBM.state.modules = r;

    Object.entries(r.adapters || {}).forEach(([type, st]) => {
      const card = document.querySelector(`.card[data-type="${type}"]`);
      if (!card || st.ok) return;
      card.classList.add('disabled');
      card.setAttribute('disabled', '');
      card.title = `不可用：${st.error || 'unknown'}`;
      const sub = card.querySelector('.card-sub');
      if (sub) sub.textContent = `❌ ${st.error?.slice(0, 40) || '不可用'}`;
    });

    const tabRouteMap = { export: 'export', import: 'import', project: 'project', schedule: 'schedule' };
    Object.entries(tabRouteMap).forEach(([mode, route]) => {
      const st = (r.routes || {})[route];
      if (!st || st.ok) return;
      const btn = document.querySelector(`button[data-mode="${mode}"]`);
      if (btn) {
        btn.disabled = true;
        btn.title = `模組不可用：${st.error || 'unknown'}`;
        if (!btn.textContent.includes('⚠')) btn.textContent += ' ⚠';
      }
    });
  }

  DBM.modulesStatus = { loadStatus };
  DBM.modulesStatus.init = loadStatus;
})();
