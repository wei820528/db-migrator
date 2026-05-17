// License banner + modal (offline + online modes) + feature gate UI.
(function () {
  const DBM = (window.DBM = window.DBM || {});

  async function refreshBanner() {
    let s;
    try { s = await fetch('/api/license').then((x) => x.json()); } catch { return; }
    DBM.state.licenseState = s;
    const banner = DBM.$('#license-banner');
    if (!banner) return;
    banner.className = s.status || '';
    const modeTag = `<span style="opacity:.7;font-size:11px;">[${s.mode}]</span>`;

    const portalLink = (s.mode === 'online' && s.serverUrl)
      ? ` · <a href="${s.serverUrl}/admin/portal.html" target="_blank">我的帳號 ↗</a>`
      : '';
    if (s.status === 'licensed') {
      banner.hidden = false;
      const who = s.user?.email || s.info?.customer || '';
      banner.innerHTML = `✅ ${DBM.escapeHtml(who)} — 方案 <b>${DBM.escapeHtml(s.user?.plan || '')}</b>，剩 ${s.daysLeft ?? '∞'} 天${portalLink} ${modeTag}`;
    } else if (s.status === 'trial') {
      banner.hidden = false;
      const who = s.user?.email || '';
      banner.innerHTML = `⏳ 試用中 ${DBM.escapeHtml(who)} — 剩 <b>${s.daysLeft}</b> 天 · <a href="#" id="banner-license-link">管理</a>${portalLink} ${modeTag}`;
    } else if (s.status === 'kicked') {
      banner.hidden = false;
      banner.innerHTML = `🚫 您的帳號在另一台電腦使用，本機已被踢出 · <a href="#" id="banner-license-link">重新登入</a> ${modeTag}`;
    } else if (s.status === 'offline') {
      banner.hidden = false;
      banner.innerHTML = `⚠ 無法連到 license server (${DBM.escapeHtml(s.lastError || '')}) ${modeTag}`;
    } else if (s.status === 'disabled') {
      banner.hidden = true;
    } else {
      banner.hidden = false;
      banner.innerHTML = `⛔ ${DBM.escapeHtml(s.lastError || s.error || 'License required')} · <a href="#" id="banner-license-link">登入 / 輸入 license</a> · <a href="../COMMERCIAL.md" target="_blank">購買</a> ${modeTag}`;
    }
    const link = DBM.$('#banner-license-link');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); openModal(); });

    applyFeatureGates();
  }

  function applyFeatureGates() {
    const f = DBM.state.licenseState?.features || {};
    const bulkAllowed = f.bulk_export !== false;
    const max = f.multi_db_count_max;
    const dbList = DBM.$('#db-list');
    if (dbList) {
      const checked = dbList.querySelectorAll('input:checked').length;
      dbList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        if (max != null && !cb.checked && checked >= max) cb.disabled = true;
        else if (!bulkAllowed && !cb.checked && checked >= 1) cb.disabled = true;
        else cb.disabled = false;
      });
    }
    const projTab = DBM.$('button[data-mode="project"]');
    if (projTab && f.project_backup === false) {
      projTab.disabled = true;
      projTab.title = '試用版不支援專案備份，請升級方案';
      if (!projTab.textContent.includes('🔒')) projTab.textContent = '🔒 ' + projTab.textContent;
    } else if (projTab) {
      projTab.disabled = false;
      projTab.title = '';
      projTab.textContent = projTab.textContent.replace(/^🔒 /, '');
    }
  }

  async function openModal() {
    DBM.$('#license-modal').hidden = false;
    let s; try { s = await fetch('/api/license').then((x) => x.json()); } catch { s = {}; }
    DBM.$('#lm-mode-tag').textContent = s.mode || '';
    const info = s.user
      ? `${s.user.email} — 方案 ${s.user.plan} — 狀態 ${s.status}（剩 ${s.daysLeft ?? '∞'} 天）`
      : `狀態：${s.status || 'unknown'}`;
    DBM.$('#lm-info').innerHTML =
      `<div>${DBM.escapeHtml(info)}</div>`
      + (s.features ? `<small style="color:#6b7280">features: ${DBM.escapeHtml(JSON.stringify(s.features))}</small>` : '')
      + (s.lastError || s.error ? `<div style="color:#dc2626; margin-top:6px;">${DBM.escapeHtml(s.lastError || s.error)}</div>` : '');
    DBM.$('#lm-online').hidden  = s.mode !== 'online';
    DBM.$('#lm-offline').hidden = s.mode !== 'offline';
  }

  function onlineMsg(text, color = '#dc2626') {
    const el = DBM.$('#lm-on-msg');
    el.style.color = color;
    el.textContent = text;
  }

  DBM.license = { refreshBanner, applyFeatureGates, openModal };

  DBM.license.init = function () {
    DBM.$('#btn-license')?.addEventListener('click', openModal);
    DBM.$('#lm-close')?.addEventListener('click', () => { DBM.$('#license-modal').hidden = true; });
    DBM.$('#license-modal .lm-backdrop')?.addEventListener('click', () => { DBM.$('#license-modal').hidden = true; });
    DBM.$('#lm-file')?.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      DBM.$('#lm-input').value = await f.text();
    });

    // Offline mode buttons
    DBM.$('#lm-save')?.addEventListener('click', async () => {
      const text = DBM.$('#lm-input').value.trim();
      if (!text) return alert('請貼上 license');
      const r = await fetch('/api/license/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license: text }),
      }).then((x) => x.json());
      if (r.error) return alert('套用失敗：' + r.error);
      alert('已套用！');
      DBM.$('#license-modal').hidden = true;
      refreshBanner();
    });
    DBM.$('#lm-remove')?.addEventListener('click', async () => {
      if (!confirm('確定移除 license？將回到試用 / 過期狀態')) return;
      await fetch('/api/license/key', { method: 'DELETE' });
      refreshBanner();
    });

    // Online mode buttons
    DBM.$('#lm-on-login')?.addEventListener('click', async () => {
      const email = DBM.$('#lm-on-email').value.trim();
      const password = DBM.$('#lm-on-pass').value;
      if (!email || !password) return onlineMsg('請填 email 和 password');
      onlineMsg('登入中...', '#6b7280');
      const r = await fetch('/api/license/online/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }).then((x) => x.json());
      if (r.error) return onlineMsg('登入失敗：' + r.error);
      onlineMsg('登入成功', '#059669');
      setTimeout(() => { DBM.$('#license-modal').hidden = true; refreshBanner(); }, 600);
    });
    DBM.$('#lm-on-register')?.addEventListener('click', async () => {
      const email = DBM.$('#lm-on-email').value.trim();
      const password = DBM.$('#lm-on-pass').value;
      if (!email || !password) return onlineMsg('請填 email 和 password (≥ 8 chars)');
      onlineMsg('註冊中...', '#6b7280');
      const r = await fetch('/api/license/online/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }).then((x) => x.json());
      if (r.error) return onlineMsg('註冊失敗：' + r.error);
      onlineMsg('已註冊試用 7 天，請按「登入」', '#059669');
    });
    DBM.$('#lm-on-logout')?.addEventListener('click', async () => {
      await fetch('/api/license/online/logout', { method: 'POST' });
      onlineMsg('已登出', '#6b7280');
      refreshBanner();
    });

    // Re-apply feature gates when DB list changes
    document.addEventListener('change', (e) => {
      if (e.target.classList?.contains('db-check')) applyFeatureGates();
    });

    refreshBanner();
    setInterval(refreshBanner, 35 * 1000);
  };
})();
