// Fetch /api/plugins/ui and inject contributed cards / tabs / scripts.
(function () {
  const DBM = (window.DBM = window.DBM || {});

  async function loadPluginUi() {
    let ui;
    try { ui = await fetch('/api/plugins/ui').then((x) => x.json()); }
    catch (e) { console.warn('[plugin-ui] failed:', e); return; }

    // Inject cards
    const cardsContainer = document.querySelector('.cards');
    if (cardsContainer && ui.cards) {
      for (const c of ui.cards) {
        if (cardsContainer.querySelector(`.card[data-type="${c.type}"]`)) continue;
        const btn = document.createElement('button');
        btn.className = 'card';
        btn.dataset.type = c.type;
        if (c.port) btn.dataset.port = c.port;
        btn.innerHTML = `<div class="card-title">${DBM.escapeHtml(c.title)}</div>
                         <div class="card-sub">${DBM.escapeHtml(c.sub || '')}</div>`;
        // Wire similar to built-in cards (delegate to connection module if present)
        btn.addEventListener('click', () => {
          if (btn.classList.contains('disabled')) return;
          document.querySelectorAll('.card').forEach((x) => x.classList.remove('selected'));
          btn.classList.add('selected');
          DBM.state.type = c.type;
          DBM.$('#picked-type').textContent = DBM.state.type;
          DBM.$('#step-conn').classList.add('active');
          DBM.$('#step-export').classList.add('active');
          DBM.$('#conn-form').hidden = false;
          DBM.$('#sqlite-form').hidden = true;
          DBM.$('#mssql-auth').hidden = true;
          if (c.port) DBM.$('#conn-form').port.value = c.port;
          DBM.$('#host-label').textContent = 'Host';
          DBM.$('#host-hint').hidden = true;
        });
        cardsContainer.appendChild(btn);
      }
    }

    // Inject tabs
    const modeSwitch = document.querySelector('#step-conn .mode-switch');
    const main = document.querySelector('main');
    if (modeSwitch && ui.tabs) {
      for (const t of ui.tabs) {
        if (document.querySelector(`button[data-mode="${t.id}"]`)) continue;
        const btn = document.createElement('button');
        btn.dataset.mode = t.id;
        btn.textContent = t.label;
        btn.type = 'button';
        modeSwitch.appendChild(btn);

        const section = document.createElement('section');
        section.id = `step-${t.id}`;
        section.className = 'step mode-panel';
        section.hidden = true;
        section.innerHTML = t.html || '';
        main.appendChild(section);

        btn.addEventListener('click', () => {
          document.querySelectorAll('.mode-switch button[data-mode]').forEach((x) => x.classList.remove('active'));
          btn.classList.add('active');
          document.querySelectorAll('.mode-panel').forEach((s) => { if (s !== section) s.hidden = true; });
          section.hidden = false;
        });

        for (const src of t.scripts || []) DBM.loadScriptOnce(src);
      }
    }

    for (const src of ui.scripts || []) DBM.loadScriptOnce(src);
  }

  DBM.pluginUi = { loadPluginUi };
  DBM.pluginUi.init = loadPluginUi;
})();
