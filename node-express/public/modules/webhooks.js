// Webhooks UI — 列表 / 建立 / test-ping / 刪除。
(function () {
  const DBM = (window.DBM = window.DBM || {});

  function $(s) { return document.querySelector(s); }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtRelative(s) {
    if (!s) return '—';
    const d = new Date(s); if (isNaN(d)) return s;
    const sec = Math.floor((Date.now() - d) / 1000);
    if (sec < 60) return `${sec}s 前`;
    if (sec < 3600) return `${Math.floor(sec/60)}m 前`;
    if (sec < 86400) return `${Math.floor(sec/3600)}h 前`;
    return `${Math.floor(sec/86400)}d 前`;
  }
  function setMsg(text, color = '#dc2626') {
    const el = $('#wh-msg'); if (!el) return;
    el.style.color = color; el.textContent = text;
  }

  async function api(path, opts = {}) {
    const r = await fetch('/api/webhooks' + path, {
      headers: { 'Content-Type': 'application/json' }, ...opts,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  async function loadAll() {
    try {
      const r = await api('/');
      // 第一次載入時填 events 選單
      const sel = $('#wh-events');
      if (sel && sel.options.length === 0) {
        for (const ev of r.events) {
          const opt = document.createElement('option');
          opt.value = ev; opt.textContent = ev;
          if (['job.done', 'job.failed', 'schedule.run.ok', 'schedule.run.failed'].includes(ev)) opt.selected = true;
          sel.appendChild(opt);
        }
      }
      renderList(r.webhooks);
    } catch (e) { setMsg(e.message); }
  }

  function renderList(rows) {
    const tb = $('#wh-list tbody');
    if (rows.length === 0) {
      tb.innerHTML = '<tr><td colspan="6" style="color:#9ca3af; text-align:center;">尚未設定 webhook</td></tr>';
      return;
    }
    tb.innerHTML = rows.map((w) => {
      const statusBadge = !w.last_at ? '<small class="muted">未送過</small>'
        : w.last_status >= 200 && w.last_status < 300
          ? `<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:4px;font-size:12px;">✓ ${w.last_status}</span>`
          : `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-size:12px;" title="${escapeHtml(w.last_error || '')}">✗ ${w.last_status || 'err'}</span>`;
      return `<tr>
        <td><b>${escapeHtml(w.name)}</b>${w.active ? '' : ' <small class="muted">(停用)</small>'}</td>
        <td><small>${escapeHtml(w.url)}</small></td>
        <td><small>${escapeHtml((w.events || []).join(', '))}</small></td>
        <td>${statusBadge}</td>
        <td><small>${w.last_at ? fmtRelative(w.last_at) + (w.last_event ? ' · ' + escapeHtml(w.last_event) : '') : '—'}</small></td>
        <td>
          <button class="row-action" data-test="${escapeHtml(w.id)}">送 ping</button>
          <button class="row-action danger" data-delete="${escapeHtml(w.id)}">刪除</button>
        </td>
      </tr>`;
    }).join('');
  }

  function bind() {
    $('#wh-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#wh-name').value.trim();
      const url = $('#wh-url').value.trim();
      const events = [...$('#wh-events').selectedOptions].map((o) => o.value);
      if (events.length === 0) { setMsg('至少要選一個事件'); return; }
      setMsg('建立中…', '#6b7280');
      try {
        const r = await api('/', { method: 'POST', body: JSON.stringify({ name, url, events }) });
        $('#wh-new').hidden = false;
        $('#wh-new-secret').textContent = r.secret;
        $('#wh-form').reset();
        setMsg('');
        await loadAll();
      } catch (e) { setMsg(e.message); }
    });

    $('#wh-copy').addEventListener('click', () => {
      const v = $('#wh-new-secret').textContent;
      navigator.clipboard.writeText(v).then(() => {
        $('#wh-copy').textContent = '✓ 已複製';
        setTimeout(() => { $('#wh-copy').textContent = '複製'; }, 1500);
      }).catch(() => {});
    });

    $('#wh-dismiss').addEventListener('click', () => {
      $('#wh-new').hidden = true; $('#wh-new-secret').textContent = '';
    });

    $('#wh-list').addEventListener('click', async (e) => {
      const t = e.target.closest('[data-test]');
      if (t) {
        setMsg('Sending test ping…', '#6b7280');
        try {
          const r = await api('/' + encodeURIComponent(t.dataset.test) + '/test', { method: 'POST' });
          setMsg(r.ok ? `✓ ping OK (HTTP ${r.status}, tried ${r.attempt}x)` : `✗ ${r.error}`, r.ok ? '#065f46' : '#dc2626');
          await loadAll();
        } catch (err) { setMsg(err.message); }
        return;
      }
      const d = e.target.closest('[data-delete]');
      if (d) {
        if (!confirm('刪除這個 webhook？之後該 URL 不再收到通知')) return;
        try { await api('/' + encodeURIComponent(d.dataset.delete), { method: 'DELETE' }); await loadAll(); }
        catch (err) { setMsg(err.message); }
      }
    });

    // 切到此 tab 時刷新
    const btn = document.querySelector('button[data-mode="webhooks"]');
    if (btn) btn.addEventListener('click', loadAll);
  }

  DBM.webhooks = { init() { bind(); } };
})();
