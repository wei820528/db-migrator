// Cross-DB preview UI — 打 /api/cross-db/preview-live，render 出 per-table 預覽卡片。
(function () {
  const DBM = (window.DBM = window.DBM || {});

  function $(s) { return document.querySelector(s); }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function setMsg(text, color = '#dc2626') {
    const el = $('#cdb-msg');
    if (!el) return;
    el.style.color = color;
    el.textContent = text;
  }

  async function runPreview() {
    const target = $('#cdb-target').value;
    if (!target) { setMsg('請選 target dialect'); return; }
    if (!DBM.state.type) { setMsg('請先在上方選資料庫類型 + 測連線'); return; }
    if (!DBM.state.connection) { setMsg('請先測連線（步驟 2）'); return; }
    if (DBM.state.type === target) { setMsg('source 與 target 相同 — 用一般匯出 / 匯入即可'); return; }

    // 步驟 2.5 只勾一個 DB 時用該名字；否則沿用 connection.database
    const sourceConn = { ...DBM.state.connection };
    if (DBM.state.selectedDbs && DBM.state.selectedDbs.length === 1) {
      sourceConn.database = DBM.state.selectedDbs[0];
    }
    if (!sourceConn.database && DBM.state.type !== 'sqlite') {
      setMsg('請在 2.5 勾一個資料庫'); return;
    }

    setMsg('預覽中…', '#6b7280');
    $('#cdb-summary').hidden = true;
    $('#cdb-tables').innerHTML = '';

    try {
      const r = await fetch('/api/cross-db/preview-live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceType: DBM.state.type,
          sourceConn,
          targetType: target,
        }),
      });
      const data = await r.json();
      if (!r.ok) { setMsg(data.error || `HTTP ${r.status}`); return; }
      render(data);
      setMsg('');
    } catch (e) { setMsg(e.message); }
  }

  function render(data) {
    const sum = $('#cdb-summary');
    sum.hidden = false;
    sum.innerHTML = `
      <b>${escapeHtml(data.source)}</b> → <b>${escapeHtml(data.target)}</b>
      &nbsp;·&nbsp; ${data.tableCount} 張表
      &nbsp;·&nbsp; <span style="color:${data.warningCount > 0 ? '#dc2626' : '#065f46'}">
        ${data.warningCount} 個 warning${data.warningCount > 0 ? '（請看下方紅字）' : ''}
      </span>
    `;

    const tb = $('#cdb-tables');
    if (data.tables.length === 0) {
      tb.innerHTML = '<p style="color:#9ca3af; text-align:center; padding:20px;">沒有表可預覽</p>';
      return;
    }

    tb.innerHTML = data.tables.map((t) => `
      <div style="border:1px solid #e5e7eb; border-radius:8px; padding:14px; margin-bottom:14px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3 style="margin:0;">${escapeHtml(t.table)}</h3>
          <div style="font-size:12px; color:#6b7280;">
            ${t.columns.length} columns
            ${t.warnings.length || perColumnWarnCount(t) > 0
              ? `&nbsp;·&nbsp;<span style="color:#dc2626;">${t.warnings.length + perColumnWarnCount(t)} warning(s)</span>`
              : ''}
          </div>
        </div>
        <table class="diff-table" style="margin-top:10px; font-size:13px;">
          <thead><tr>
            <th>欄位</th>
            <th>Source type</th>
            <th>→ Target type</th>
            <th>Attrs</th>
            <th>Warnings</th>
          </tr></thead>
          <tbody>
            ${t.columns.map((c) => `
              <tr>
                <td><code>${escapeHtml(c.name)}</code></td>
                <td><code>${escapeHtml(c.sourceType)}</code></td>
                <td><code>${escapeHtml(c.targetType)}</code></td>
                <td><small>${[
                  c.primaryKey ? 'PK' : '',
                  c.autoIncrement ? 'AI' : '',
                  c.nullable === false ? 'NOT NULL' : '',
                ].filter(Boolean).join(' ') || '—'}</small></td>
                <td>${c.warnings.length === 0 ? '' :
                  c.warnings.map((w) => `<small style="color:#dc2626;">${escapeHtml(w)}</small>`).join('<br>')}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${t.warnings.length === 0 ? '' :
          `<div style="margin-top:8px; font-size:12px; color:#dc2626;">
            ${t.warnings.map((w) => `• ${escapeHtml(w)}`).join('<br>')}
          </div>`}
        <details style="margin-top:10px;">
          <summary style="cursor:pointer; font-size:12px; color:#6b7280;">查看預測的 CREATE TABLE</summary>
          <pre style="background:#0f172a; color:#e5e7eb; padding:10px; border-radius:6px; font-size:12px; overflow:auto;">${escapeHtml(t.createTable)};

${t.indexes.join('\n')}</pre>
        </details>
      </div>
    `).join('');
  }

  function perColumnWarnCount(t) {
    return t.columns.reduce((n, c) => n + c.warnings.length, 0);
  }

  DBM.crossdb = {
    init() {
      const btn = $('#cdb-preview');
      if (btn) btn.addEventListener('click', runPreview);
    },
  };
})();
