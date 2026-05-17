// Bootstrap — wire up all modules in order.
// Each module attaches to window.DBM and exposes an .init() method.
// Load order in index.html: utils → state → presets → license → modules-status →
//                            plugin-ui → connection → databases → tabs → export/import/project/schedule → app.js

window.addEventListener('DOMContentLoaded', () => {
  const D = window.DBM;
  if (!D) { console.error('DBM namespace not loaded — check script order in index.html'); return; }

  // Foundation
  D.modulesStatus.init();   // probe /api/modules → disable unavailable cards/tabs
  D.presets.init();         // localStorage preset dropdown wiring
  D.license.init();         // license banner + modal + feature gates (also starts heartbeat poll)

  // Step 1-2: pick DB type + connection form
  D.connection.init();
  D.databases.init();

  // Step 3: mode-switch tabs (export / import / project / schedule)
  D.tabs.init();

  // Feature panels
  D.exportPanel.init();
  D.importPanel.init();
  D.projectPanel.init();
  D.schedule.init();
  D.marketplace.init();

  // Plugin-contributed UI loaded last so plugin cards/tabs are added on top
  D.pluginUi.init();
});
