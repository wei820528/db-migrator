// Scheduled backups panel.
(function () {
  const DBM = (window.DBM = window.DBM || {});

  async function loadSchedules() {
    try {
      const r = await fetch('/api/schedule').then((x) => x.json());
      render(r.schedules || []);
      loadFiles();
    } catch (e) { console.warn('[schedule] load failed:', e); }
  }

  function render(list) {
    const tb = DBM.$('#schedule-list tbody');
    if (!tb) return;
    if (list.length === 0) {
      tb.innerHTML = '<tr><td colspan="7" style="text-align:center; color:#9ca3af; padding:20px;">尚無排程，按「+ 新增排程」開始</td></tr>';
      return;
    }
    tb.innerHTML = list.map((s) => {
      const lastTxt = s.lastRunAt ? new Date(s.lastRunAt).toLocaleString('zh-TW') + (s.lastStatus === 'error' ? ' ❌' : ' ✓') : '—';
      const nextTxt = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString('zh-TW') : '—';
      return `<tr>
        <td>${DBM.escapeHtml(s.name)}</td>
        <td>${DBM.escapeHtml(s.type)}</td>
        <td><code>${DBM.escapeHtml(s.expression)}</code></td>
        <td>${s.active ? '<span style="color:#059669;">啟用</span>' : '<span style="color:#9ca3af;">停用</span>'}</td>
        <td>${lastTxt}${s.lastError ? `<br><small style="color:#dc2626;">${DBM.escapeHtml(s.lastError)}</small>` : ''}</td>
        <td>${nextTxt}</td>
        <td>
          <button class="sched-btn" data-act="run" data-id="${s.id}" style="background:#10b981; padding:4px 10px; font-size:12px;">立即執行</button>
          <button class="sched-btn" data-act="edit" data-id="${s.id}" style="background:#e5e7eb; color:#374151; padding:4px 10px; font-size:12px;">編輯</button>
        </td>
      </tr>`;
    }).join('');
  }

  async function loadFiles() {
    try {
      const r = await fetch('/api/schedule/_files/list').then((x) => x.json());
      const tb = DBM.$('#schedule-files tbody');
      if (!tb) return;
      if (!r.files?.length) {
        tb.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#9ca3af; padding:14px;">尚無備份檔案</td></tr>';
        return;
      }
      tb.innerHTML = r.files.map((f) => `<tr>
        <td><code>${DBM.escapeHtml(f.name)}</code></td>
        <td>${(f.size / 1024).toFixed(1)} KB</td>
        <td>${new Date(f.mtime).toLocaleString('zh-TW')}</td>
        <td><a href="/api/schedule/_files/download?name=${encodeURIComponent(f.name)}" style="color:#3b82f6;">下載</a></td>
      </tr>`).join('');
    } catch {}
  }

  function openModal(id) {
    DBM.$('#schedule-modal').hidden = false;
    DBM.$('#sm-msg').textContent = '';
    if (!id) {
      DBM.$('#sm-title').textContent = '新增排程';
      DBM.$('#sm-id').value = '';
      DBM.$('#sm-name').value = '';
      DBM.$('#sm-expr').value = 'daily at 02:00';
      DBM.$('#sm-active').checked = true;
      DBM.$('#sm-delete').hidden = true;
    } else {
      fetch(`/api/schedule/${id}`).then((r) => r.json()).then((s) => {
        DBM.$('#sm-title').textContent = '編輯排程';
        DBM.$('#sm-id').value = s.id;
        DBM.$('#sm-name').value = s.name;
        DBM.$('#sm-expr').value = s.expression;
        DBM.$('#sm-active').checked = s.active;
        DBM.$('#sm-delete').hidden = false;
      });
    }
  }

  async function save() {
    const id = DBM.$('#sm-id').value;
    const body = {
      name: DBM.$('#sm-name').value.trim(),
      expression: DBM.$('#sm-expr').value.trim(),
      active: DBM.$('#sm-active').checked,
    };
    if (!id) {
      if (!DBM.state.type || !DBM.state.connection) return (DBM.$('#sm-msg').textContent = '請先完成 2 / 2.5 步驟');
      if (DBM.state.selectedDbs.length === 0) return (DBM.$('#sm-msg').textContent = '請先在 2.5 勾資料庫');
      body.type = DBM.state.type;
      body.connection = DBM.state.connection;
      body.databases = DBM.state.selectedDbs;
    }
    try {
      const url = id ? `/api/schedule/${id}` : '/api/schedule';
      const method = id ? 'PATCH' : 'POST';
      const r = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((x) => x.json());
      if (r.error) return (DBM.$('#sm-msg').textContent = '失敗：' + r.error);
      DBM.$('#schedule-modal').hidden = true;
      loadSchedules();
    } catch (e) { DBM.$('#sm-msg').textContent = e.message; }
  }

  DBM.schedule = { loadSchedules, openModal };

  DBM.schedule.init = function () {
    DBM.$('#btn-new-schedule')?.addEventListener('click', () => {
      if (!DBM.state.connection) return alert('請先在「2. 連線設定」測試成功');
      if (DBM.state.selectedDbs.length === 0) return alert('請先在「2.5」勾要備份的 DB');
      openModal(null);
    });
    DBM.$('#btn-refresh-schedules')?.addEventListener('click', loadSchedules);
    document.addEventListener('click', async (e) => {
      const b = e.target.closest('.sched-btn');
      if (!b) return;
      const id = b.dataset.id;
      if (b.dataset.act === 'edit') openModal(id);
      if (b.dataset.act === 'run') {
        if (!confirm('立即執行此排程？')) return;
        const r = await fetch(`/api/schedule/${id}/run-now`, { method: 'POST' }).then((x) => x.json());
        if (r.error) alert('失敗：' + r.error);
        else { alert('已啟動，jobId=' + r.jobId.slice(0, 8)); loadSchedules(); }
      }
    });
    DBM.$('#sm-close')?.addEventListener('click', () => { DBM.$('#schedule-modal').hidden = true; });
    DBM.$('#sm-backdrop')?.addEventListener('click', () => { DBM.$('#schedule-modal').hidden = true; });
    DBM.$('#sm-save')?.addEventListener('click', save);
    DBM.$('#sm-delete')?.addEventListener('click', async () => {
      const id = DBM.$('#sm-id').value;
      if (!id) return;
      if (!confirm('刪除此排程？')) return;
      await fetch(`/api/schedule/${id}`, { method: 'DELETE' });
      DBM.$('#schedule-modal').hidden = true;
      loadSchedules();
    });
  };
})();
