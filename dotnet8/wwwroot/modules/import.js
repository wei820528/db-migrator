// Import panel — upload, inspect diff, run with optional table filter.
(function () {
  const DBM = (window.DBM = window.DBM || {});

  async function inspect() {
    const f = DBM.$('#imp-file').files[0];
    if (!f) return alert('請先選檔案');
    if (DBM.state.selectedDbs.length !== 1) return alert('匯入請只選一個目標資料庫');
    const targetDb = DBM.state.selectedDbs[0];
    const conn = DBM.state.type === 'sqlite' ? { path: targetDb } : { ...DBM.state.connection, database: targetDb };

    const fd = new FormData();
    fd.append('file', f);
    fd.append('meta', JSON.stringify({ type: DBM.state.type, connection: conn }));
    const r = await fetch('/api/import/inspect', { method: 'POST', body: fd }).then((x) => x.json());
    if (r.error) { DBM.$('#imp-log').textContent = r.error; return; }
    DBM.state.uploadId = r.uploadId;
    DBM.$('#imp-diff').hidden = false;
    DBM.$('#imp-diff-body').innerHTML = r.diff
      .map((d) => `
        <tr>
          <td><input type="checkbox" data-table="${DBM.escapeHtml(d.name)}" checked /></td>
          <td>${DBM.escapeHtml(d.name)}</td>
          <td class="${d.existsInTarget ? 'exists-yes' : 'exists-no'}">
            ${d.existsInTarget ? '已存在（將覆寫）' : '不存在（新建）'}
          </td>
        </tr>`)
      .join('');
  }

  async function runImport() {
    DBM.$('#imp-log').textContent = '';
    DBM.$('#imp-result').innerHTML = '';
    const targetDb = DBM.state.selectedDbs[0];
    const conn = DBM.state.type === 'sqlite' ? { path: targetDb } : { ...DBM.state.connection, database: targetDb };

    const allCb = DBM.$$('#imp-diff-body input[type="checkbox"]');
    const checkedTables = allCb.filter((c) => c.checked).map((c) => c.dataset.table);
    const tables = (allCb.length > 0 && checkedTables.length < allCb.length) ? checkedTables : undefined;

    const r = await fetch('/api/import/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: DBM.state.type, connection: conn, uploadId: DBM.state.uploadId, tables }),
    }).then((x) => x.json());
    if (r.error) { DBM.$('#imp-log').textContent = r.error; return; }

    await DBM.pollJob(r.jobId, '#imp-log', '#imp-result', () => '匯入完成');
  }

  DBM.importPanel = { inspect, runImport };

  DBM.importPanel.init = function () {
    DBM.$('#btn-inspect').addEventListener('click', inspect);
    DBM.$('#btn-import').addEventListener('click', runImport);
  };
})();
