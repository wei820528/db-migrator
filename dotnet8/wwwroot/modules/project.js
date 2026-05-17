// Project backup / restore (code + DB + Supabase Storage).
(function () {
  const DBM = (window.DBM = window.DBM || {});

  async function runBackup() {
    const body = {};
    if (DBM.$('#bk-code').checked) {
      body.code = {
        repoUrl: DBM.$('#bk-code-url').value.trim(),
        pat: DBM.$('#bk-code-pat').value,
        branch: DBM.$('#bk-code-branch').value.trim() || undefined,
      };
      if (!body.code.repoUrl) return alert('Code 區塊：請填 GitHub Repo URL');
    }
    if (DBM.$('#bk-db').checked) {
      if (DBM.state.selectedDbs.length !== 1) return alert('DB 區塊：請在「2.5 選擇資料庫」勾一個 DB');
      body.db = {
        type: DBM.state.type,
        connection: DBM.state.connection,
        database: DBM.state.selectedDbs[0],
        options: {},
      };
    }
    if (DBM.$('#bk-storage').checked) {
      body.storage = {
        url: DBM.$('#bk-st-url').value.trim(),
        serviceKey: DBM.$('#bk-st-key').value,
      };
      if (!body.storage.url || !body.storage.serviceKey) return alert('Storage 區塊：URL 和 service_role key 都要填');
    }
    if (!body.code && !body.db && !body.storage) return alert('至少勾一個層');

    DBM.$('#proj-log').textContent = '';
    DBM.$('#proj-result').innerHTML = '';

    const r = await fetch('/api/project/backup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r.error) { DBM.$('#proj-log').textContent = r.error; return; }

    await DBM.pollJob(r.jobId, '#proj-log', '#proj-result', (job) => {
      if (job.result?.downloadUrl) return `<a href="${job.result.downloadUrl}">下載 backup.zip</a>`;
    });
  }

  async function inspectRestore() {
    const f = DBM.$('#rs-file').files[0];
    if (!f) return alert('請先選 backup.zip');
    const fd = new FormData();
    fd.append('file', f);
    const r = await fetch('/api/project/inspect', { method: 'POST', body: fd }).then((x) => x.json());
    if (r.error) return alert(`檢視失敗：${r.error}`);
    DBM.state.restoreUploadId = r.uploadId;
    DBM.state.restoreManifest = r.manifest;
    DBM.$('#rs-manifest').hidden = false;
    DBM.$('#rs-manifest').textContent = JSON.stringify(r.manifest, null, 2);
    DBM.$('#rs-dest').hidden = false;
    DBM.$('#rs-code').checked = !!r.manifest.code;
    DBM.$('#rs-db').checked = !!r.manifest.db;
    DBM.$('#rs-storage').checked = !!r.manifest.storage;
    DBM.$$('.proj-toggle input[type="checkbox"]').forEach((cb) => cb.dispatchEvent(new Event('change')));
  }

  async function runRestore() {
    if (!DBM.state.restoreUploadId) return alert('請先「檢視內容」');
    const dest = {};
    if (DBM.$('#rs-code').checked) {
      dest.code = {
        repoUrl: DBM.$('#rs-code-url').value.trim(),
        pat: DBM.$('#rs-code-pat').value,
        branch: DBM.$('#rs-code-branch').value.trim() || undefined,
      };
      if (!dest.code.repoUrl) return alert('Code：請填目的 Repo URL');
    }
    if (DBM.$('#rs-db').checked) {
      if (DBM.state.selectedDbs.length !== 1) return alert('DB：請在「2.5」勾一個目標 DB');
      dest.db = {
        type: DBM.state.type,
        connection: DBM.state.connection,
        database: DBM.state.selectedDbs[0],
      };
    }
    if (DBM.$('#rs-storage').checked) {
      dest.storage = {
        url: DBM.$('#rs-st-url').value.trim(),
        serviceKey: DBM.$('#rs-st-key').value,
      };
      if (!dest.storage.url || !dest.storage.serviceKey) return alert('Storage：URL 和 service_role key 都要填');
    }
    if (!dest.code && !dest.db && !dest.storage) return alert('至少勾一個層');

    DBM.$('#proj-log').textContent = '';
    DBM.$('#proj-result').innerHTML = '';

    const r = await fetch('/api/project/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: DBM.state.restoreUploadId, dest }),
    }).then((x) => x.json());
    if (r.error) { DBM.$('#proj-log').textContent = r.error; return; }

    await DBM.pollJob(r.jobId, '#proj-log', '#proj-result', () => '還原完成');
  }

  DBM.projectPanel = { runBackup, inspectRestore, runRestore };

  DBM.projectPanel.init = function () {
    // Sub-tab: backup ↔ restore
    document.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-pmode]');
      if (!b) return;
      document.querySelectorAll('button[data-pmode]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      DBM.$('#proj-backup-panel').hidden = b.dataset.pmode !== 'backup';
      DBM.$('#proj-restore-panel').hidden = b.dataset.pmode !== 'restore';
    });
    // Layer toggle: show/hide each layer's fields
    document.addEventListener('change', (e) => {
      if (e.target.matches('.proj-toggle input[type="checkbox"]')) {
        const fields = e.target.closest('.proj-block').querySelector('.proj-fields');
        if (fields) fields.hidden = !e.target.checked;
      }
    });
    DBM.$('#btn-backup')?.addEventListener('click', runBackup);
    DBM.$('#btn-rs-inspect')?.addEventListener('click', inspectRestore);
    DBM.$('#btn-restore')?.addEventListener('click', runRestore);
  };
})();
