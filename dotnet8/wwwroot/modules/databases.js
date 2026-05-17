// Step 2.5 — DB checkbox list + load table list for the single selected DB.
(function () {
  const DBM = (window.DBM = window.DBM || {});

  function renderList() {
    const div = DBM.$('#db-list');
    if (!div) return;
    div.innerHTML = DBM.state.databases
      .map((name) => `<label><input type="checkbox" class="db-check" value="${DBM.escapeHtml(name)}" /> ${DBM.escapeHtml(name)}</label>`)
      .join('');
    updateCount();
  }

  function updateCount() {
    DBM.state.selectedDbs = DBM.$$('#db-list input:checked').map((c) => c.value);
    const n = DBM.state.selectedDbs.length;
    const tag = DBM.$('#db-count');
    if (tag) tag.textContent = n === 0 ? '尚未選' : `已選 ${n} 個`;

    if (n === 1) {
      loadTablesFor(DBM.state.selectedDbs[0]);
    } else {
      DBM.state.tables = [];
      renderTables();
    }
    // Multi-DB selected: hide per-table picker (force "all")
    const selectRadio = document.querySelector('input[name="exp-scope"][value="select"]');
    if (selectRadio && n > 1) {
      document.querySelector('input[name="exp-scope"][value="all"]').checked = true;
      selectRadio.disabled = true;
      const t = DBM.$('#exp-tables');
      if (t) t.hidden = true;
    } else if (selectRadio) {
      selectRadio.disabled = false;
    }
  }

  async function loadTablesFor(database) {
    const body = DBM.state.type === 'sqlite'
      ? { type: 'sqlite', path: database }
      : { type: DBM.state.type, ...DBM.state.connection, database };
    const r = await fetch('/api/connection/tables', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    DBM.state.tables = r.tables || [];
    renderTables();
  }

  function renderTables() {
    const div = DBM.$('#exp-tables');
    if (!div) return;
    div.innerHTML = DBM.state.tables
      .map((t) => `<label><input type="checkbox" value="${DBM.escapeHtml(t.name)}" /> ${DBM.escapeHtml(t.name)} <span style="color:#9ca3af">(~${t.rowEstimate ?? '?'})</span></label>`)
      .join('');
  }

  DBM.databases = { renderList, updateCount, loadTablesFor, renderTables };

  DBM.databases.init = function () {
    document.addEventListener('change', (e) => {
      if (e.target.classList?.contains('db-check')) updateCount();
    });
    DBM.$('#btn-select-all-dbs')?.addEventListener('click', () => {
      DBM.$$('#db-list input').forEach((c) => (c.checked = true));
      updateCount();
    });
    DBM.$('#btn-clear-dbs')?.addEventListener('click', () => {
      DBM.$$('#db-list input').forEach((c) => (c.checked = false));
      updateCount();
    });
  };
})();
