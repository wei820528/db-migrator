// Export panel — scope radio, table picker, run.
(function () {
  const DBM = (window.DBM = window.DBM || {});

  async function runExport() {
    if (DBM.state.selectedDbs.length === 0) return alert('請先勾選至少一個資料庫');
    const scope = document.querySelector('input[name="exp-scope"]:checked').value;
    const tables = scope === 'select'
      ? DBM.$$('#exp-tables input:checked').map((x) => x.value)
      : [];
    const options = {
      tables,
      noData: DBM.$('#exp-no-data').checked,
      noSchema: DBM.$('#exp-no-schema').checked,
    };
    DBM.$('#exp-log').textContent = '';
    DBM.$('#exp-result').innerHTML = '';

    const r = await fetch('/api/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: DBM.state.type,
        connection: DBM.state.connection,
        databases: DBM.state.selectedDbs,
        options,
      }),
    }).then((x) => x.json());
    if (r.error) { DBM.$('#exp-log').textContent = r.error; return; }

    await DBM.pollJob(r.jobId, '#exp-log', '#exp-result', (job) => {
      if (job.result?.downloadUrl)
        return `<a href="${job.result.downloadUrl}">下載檔案</a>`;
    });
  }

  DBM.exportPanel = { runExport };

  DBM.exportPanel.init = function () {
    DBM.$('#btn-export').addEventListener('click', runExport);
    DBM.$$('input[name="exp-scope"]').forEach((r) => {
      r.addEventListener('change', () => {
        DBM.$('#exp-tables').hidden = document.querySelector('input[name="exp-scope"]:checked').value !== 'select';
      });
    });
  };
})();
