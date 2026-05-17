// Step 1 cards + Step 2 connection form + connection test.
(function () {
  const DBM = (window.DBM = window.DBM || {});

  function readConn() {
    if (DBM.state.type === 'sqlite') {
      return { path: DBM.$('#sqlite-form').path.value.trim() };
    }
    const f = DBM.$('#conn-form');
    const portStr = f.port.value.trim();
    const conn = {
      host: f.host.value.trim(),
      port: portStr ? Number(portStr) : 0,
      user: f.user.value.trim(),
      password: f.password.value,
    };
    if (DBM.state.type === 'mssql') {
      conn.authMode = document.querySelector('input[name="authMode"]:checked')?.value || 'sql';
    }
    if (DBM.state.type === 'supabase') conn.ssl = true;
    return conn;
  }

  function applyValuesToForm(c) {
    if (DBM.state.type === 'sqlite') {
      DBM.$('#sqlite-form').path.value = c.path || '';
      return;
    }
    const f = DBM.$('#conn-form');
    f.host.value = c.host || '';
    f.port.value = c.port ?? '';
    f.database && (f.database.value = c.database || '');
    f.user.value = c.user || '';
    f.password.value = c.password || '';
    if (DBM.state.type === 'mssql') {
      const am = c.authMode || 'sql';
      const radio = document.querySelector(`input[name="authMode"][value="${am}"]`);
      if (radio) radio.checked = true;
      updateAuthHint();
    }
  }

  function updateAuthHint() {
    const mode = document.querySelector('input[name="authMode"]:checked')?.value || 'sql';
    const hint = DBM.$('#auth-hint');
    if (!hint) return;
    if (mode === 'windows') {
      hint.innerHTML =
        '<b>.NET 版</b>：忽略下面的 user/password，會用啟動 dotnet 的 Windows 帳號（IntegratedSecurity）<br>' +
        '<b>Node 版</b>：用 NTLM。User 欄位填 <code>DOMAIN\\帳號</code> 或 <code>MACHINE\\帳號</code>';
    } else {
      hint.textContent = '使用 SQL Server 自己的 login（如 sa）。需要安裝時有勾「Mixed Mode」。';
    }
  }

  function selectCard(c) {
    if (c.classList.contains('disabled')) return;
    DBM.$$('.card').forEach((x) => x.classList.remove('selected'));
    c.classList.add('selected');
    DBM.state.type = c.dataset.type;
    DBM.$('#picked-type').textContent = DBM.state.type;
    DBM.$('#step-conn').classList.add('active');
    DBM.$('#step-export').classList.add('active');

    const isSqlite = DBM.state.type === 'sqlite';
    const isMssql = DBM.state.type === 'mssql';
    DBM.$('#conn-form').hidden = isSqlite;
    DBM.$('#sqlite-form').hidden = !isSqlite;
    DBM.$('#mssql-auth').hidden = !isMssql;

    const hint = DBM.$('#host-hint');
    const text = DBM.HOST_HINTS[DBM.state.type];
    if (hint) { if (text) { hint.textContent = text; hint.hidden = false; } else hint.hidden = true; }
    DBM.$('#host-label').textContent = isMssql ? 'Server' : 'Host';

    const presets = DBM.presets.presetsFor(DBM.state.type);
    const fill = presets[0] || DBM.TYPE_DEFAULTS[DBM.state.type] || {};
    applyValuesToForm(fill);
    DBM.presets.render();
    updateAuthHint();
  }

  async function testConnection() {
    const conn = readConn();
    DBM.state.connection = conn;
    DBM.state.databases = [];
    DBM.state.selectedDbs = [];
    DBM.state.tables = [];
    DBM.$('#step-databases').classList.remove('active');
    DBM.databases?.renderTables();

    const status = DBM.$('#conn-status');
    status.textContent = '測試中...'; status.className = '';
    try {
      const r = await fetch('/api/connection/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: DBM.state.type, ...conn }),
      }).then((x) => x.json());
      if (r.ok) {
        status.textContent = `成功，${r.version}`;
        status.className = 'ok';
        DBM.presets.save(DBM.state.type, conn);
        if (DBM.state.type === 'sqlite') {
          DBM.state.selectedDbs = [conn.path];
          await DBM.databases.loadTablesFor(conn.path);
        } else {
          DBM.state.databases = r.databases || [];
          DBM.databases.renderList();
          DBM.$('#step-databases').classList.add('active');
        }
      } else {
        status.textContent = `失敗：${DBM.describeServerError(r)}`;
        status.className = 'err';
      }
    } catch (e) {
      status.textContent = `失敗：${e.message}`;
      status.className = 'err';
    }
  }

  DBM.connection = { readConn, applyValuesToForm, updateAuthHint, selectCard, testConnection };

  DBM.connection.init = function () {
    DBM.$$('.card').forEach((c) => c.addEventListener('click', () => selectCard(c)));
    document.addEventListener('change', (e) => {
      if (e.target.name === 'authMode') updateAuthHint();
    });
    DBM.$('#btn-test').addEventListener('click', testConnection);
  };
})();
