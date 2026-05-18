// Plugin marketplace UI module.
// Preview → install flow + installed list + trusted publishers list.
(function () {
  const DBM = (window.DBM = window.DBM || {});

  let lastPreview = null;
  let currentUrl = '';

  function $(sel) { return document.querySelector(sel); }
  function setMsg(text, color = '#dc2626') {
    const el = $('#mp-msg');
    el.style.color = color;
    el.textContent = text;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(path, opts = {}) {
    const r = await fetch('/api/marketplace' + path, {
      headers: { 'Content-Type': 'application/json' }, ...opts,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  async function preview() {
    const url = $('#mp-url').value.trim();
    if (!url) { setMsg('請填 GitHub URL'); return; }
    setMsg('下載中…', '#6b7280');
    $('#mp-preview-pane').hidden = true;
    try {
      const r = await api('/preview', { method: 'POST', body: JSON.stringify({ url }) });
      lastPreview = r;
      currentUrl = url;
      renderPreview(r);
      setMsg('');
    } catch (e) { setMsg(e.message); }
  }

  function renderPreview(r) {
    $('#mp-preview-pane').hidden = false;
    $('#mp-name').textContent = r.manifest.name;
    $('#mp-version').textContent = 'v' + r.manifest.version;
    $('#mp-desc').textContent = r.manifest.description || '';

    const badge = $('#mp-sig-badge');
    if (r.signature.signed && r.signature.trusted) {
      badge.textContent = `✓ 已簽章 (${r.signature.publisher})`;
      badge.style.background = '#d1fae5';
      badge.style.color = '#065f46';
    } else if (r.signature.signed && !r.signature.trusted) {
      badge.textContent = '⚠ 簽章未受信任';
      badge.style.background = '#fef3c7';
      badge.style.color = '#92400e';
    } else {
      badge.textContent = '⚠ 未簽章';
      badge.style.background = '#fee2e2';
      badge.style.color = '#991b1b';
    }

    const tb = $('#mp-files tbody');
    tb.innerHTML = r.files.map((f) => `
      <tr>
        <td><code>${escapeHtml(f.runtime)}</code></td>
        <td><code>${escapeHtml(f.path)}</code></td>
        <td>${f.bytes} B</td>
        <td><small title="${escapeHtml(f.hash)}">${escapeHtml(f.hash.slice(0, 16))}…${f.hashOk ? '' : ' <span style="color:#dc2626">(mismatch)</span>'}</small></td>
      </tr>
    `).join('');

    // v2 Theme D Phase 1：列出 requested permissions + 預設 checkbox 全勾，但使用者可以取消
    renderPermissions(r.permissions);

    const needsConfirm = !r.signature.signed || !r.signature.trusted;
    $('#mp-unsigned-confirm').hidden = !needsConfirm;
    $('#mp-allow-unsigned').checked = false;
    $('#mp-install').disabled = needsConfirm;     // re-enabled when checkbox flipped
  }

  function renderPermissions(p) {
    const wrap = $('#mp-permissions');
    if (!wrap) return;
    if (!p || !p.details || p.details.length === 0) {
      wrap.innerHTML = '<small class="muted">(no permissions section in manifest)</small>';
      return;
    }
    const riskColor = (r) => ({ 1: '#065f46', 2: '#92400e', 3: '#991b1b' }[r] || '#374151');
    const riskBg    = (r) => ({ 1: '#d1fae5', 2: '#fef3c7', 3: '#fee2e2' }[r] || '#f3f4f6');
    const banner = p.legacy
      ? '<div style="background:#fee2e2; padding:8px; border-radius:4px; margin-bottom:8px; font-size:13px; color:#991b1b;">⚠ 這個 plugin 沒宣告 permissions，會以 <code>unrestricted</code>（完整 Node 存取）安裝 — 老 plugin 才會這樣。建議只裝可信來源。</div>'
      : '';
    wrap.innerHTML = banner + '<table style="width:100%; font-size:13px;"><thead><tr>'
      + '<th style="width:24px;"></th><th>權限</th><th>說明</th><th>風險</th>'
      + '</tr></thead><tbody>'
      + p.details.map((d) => `
        <tr>
          <td><input type="checkbox" class="mp-perm" value="${escapeHtml(d.id)}" checked /></td>
          <td><code>${escapeHtml(d.id)}</code><br><small>${escapeHtml(d.label)}</small></td>
          <td><small>${escapeHtml(d.description)}</small></td>
          <td><span style="background:${riskBg(d.risk)}; color:${riskColor(d.risk)}; padding:2px 8px; border-radius:4px; font-size:12px;">risk ${d.risk}/3</span></td>
        </tr>
      `).join('') + '</tbody></table>';
  }

  async function install() {
    if (!lastPreview) return;
    const needsConfirm = !lastPreview.signature.signed || !lastPreview.signature.trusted;
    const allowUnsigned = $('#mp-allow-unsigned').checked;
    if (needsConfirm && !allowUnsigned) { setMsg('請勾選確認框'); return; }

    // v2 Theme D：採集勾選的 permissions
    const grantedPermissions = [...document.querySelectorAll('.mp-perm:checked')].map((c) => c.value);

    setMsg('安裝中…', '#6b7280');
    try {
      const r = await api('/install', {
        method: 'POST',
        body: JSON.stringify({ url: currentUrl, allowUnsigned, grantedPermissions }),
      });
      const grantedNote = r.permissions
        ? ` · ${r.permissions.granted.length}/${r.permissions.requested.length} permissions granted`
        : '';
      setMsg(`✓ 已安裝 ${r.installed} v${r.version}（${r.fileCount} 檔${grantedNote}）`, '#065f46');
      $('#mp-preview-pane').hidden = true;
      $('#mp-url').value = '';
      lastPreview = null;
      loadInstalled();
    } catch (e) { setMsg(e.message); }
  }

  async function loadInstalled() {
    try {
      const r = await api('/installed');
      const tb = $('#mp-installed tbody');
      if (r.plugins.length === 0) {
        tb.innerHTML = '<tr><td colspan="5" style="color:#9ca3af; text-align:center;">尚無外掛</td></tr>';
        return;
      }
      tb.innerHTML = r.plugins.map((p) => {
        // v2 Theme D Phase 1: 顯示授予的權限數 + legacy 警告
        const permSummary = !p.permissions
          ? '<small class="muted">(legacy install)</small>'
          : p.permissions.legacy
            ? '<small style="color:#dc2626;">⚠ unrestricted</small>'
            : `<small>${p.permissions.granted.length}/${p.permissions.requested.length} granted</small>`;
        return `<tr>
          <td><b>${escapeHtml(p.name)}</b></td>
          <td>${escapeHtml(p.version)}</td>
          <td>${p.signed ? '✓' : '⚠ 未簽'}</td>
          <td>${permSummary}</td>
          <td>${escapeHtml(p.description || '—')}</td>
          <td><button class="row-action danger" data-uninstall="${escapeHtml(p.name)}">移除</button></td>
        </tr>`;
      }).join('');
    } catch (e) { console.error('loadInstalled', e); }
  }

  async function loadTrusted() {
    try {
      const r = await api('/trusted');
      const tb = $('#mp-trusted tbody');
      if (r.publishers.length === 0) {
        tb.innerHTML = '<tr><td colspan="3" style="color:#9ca3af; text-align:center;">尚未信任任何 publisher</td></tr>';
        return;
      }
      tb.innerHTML = r.publishers.map((p) => `
        <tr>
          <td><code>${escapeHtml(p.id)}</code></td>
          <td><small>${escapeHtml(p.fingerprint || '?')}</small></td>
          <td>${p.id === 'project-default' ? '<small style="color:#9ca3af">內建</small>'
              : `<button class="row-action danger" data-untrust="${escapeHtml(p.id)}">移除</button>`}</td>
        </tr>
      `).join('');
    } catch (e) { console.error('loadTrusted', e); }
  }

  function bindOnceWhenVisible() {
    $('#mp-preview').addEventListener('click', preview);
    $('#mp-install').addEventListener('click', install);
    $('#mp-allow-unsigned').addEventListener('change', (e) => {
      $('#mp-install').disabled = !e.target.checked;
    });
    $('#mp-installed').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-uninstall]');
      if (!b) return;
      if (!confirm(`移除外掛 "${b.dataset.uninstall}"？`)) return;
      try { await api('/installed/' + encodeURIComponent(b.dataset.uninstall), { method: 'DELETE' }); loadInstalled(); }
      catch (err) { alert(err.message); }
    });
    $('#mp-trusted').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-untrust]');
      if (!b) return;
      if (!confirm(`移除信任 publisher "${b.dataset.untrust}"？已裝的 plugin 仍然會跑，但之後再裝同 publisher 的就會變未信任。`)) return;
      try { await api('/trusted/' + encodeURIComponent(b.dataset.untrust), { method: 'DELETE' }); loadTrusted(); }
      catch (err) { alert(err.message); }
    });
  }

  DBM.marketplace = {
    init() {
      bindOnceWhenVisible();
      // Lazy-load lists when the tab is first shown
      const tabBtn = document.querySelector('button[data-mode="marketplace"]');
      if (tabBtn) tabBtn.addEventListener('click', () => { loadInstalled(); loadTrusted(); });
    },
  };
})();
