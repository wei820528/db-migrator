// Mode-switch tabs (export / import / project / schedule).
(function () {
  const DBM = (window.DBM = window.DBM || {});

  function show(mode) {
    DBM.$$('.mode-switch button[data-mode]').forEach((x) => x.classList.remove('active'));
    const btn = document.querySelector(`button[data-mode="${mode}"]`);
    if (btn) btn.classList.add('active');
    const sections = ['export', 'import', 'project', 'schedule'];
    for (const m of sections) {
      const sec = DBM.$('#step-' + m);
      if (sec) sec.hidden = m !== mode;
    }
    if (mode === 'schedule') DBM.schedule?.loadSchedules();
  }

  DBM.tabs = { show };

  DBM.tabs.init = function () {
    DBM.$$('.mode-switch button[data-mode]').forEach((b) => {
      b.addEventListener('click', () => show(b.dataset.mode));
    });
  };
})();
