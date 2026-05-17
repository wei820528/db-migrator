// Shared mutable state — all modules read/write here.
(function () {
  const DBM = (window.DBM = window.DBM || {});

  DBM.state = {
    type: null,
    connection: null,                 // host/port/user/password (no database)
    databases: [],                    // all DBs returned by server
    selectedDbs: [],                  // user-selected for export
    tables: [],                       // tables of the (single) selected DB
    uploadId: null,                   // for import flow
    restoreUploadId: null,            // for project restore flow
    restoreManifest: null,
    modules: { routes: {}, adapters: {} },  // populated from /api/modules
    licenseState: {},                 // populated from /api/license
  };

  // Constants used across modules
  DBM.HOST_HINTS = {
    mysql: '範例：127.0.0.1、db.example.com、AWS RDS endpoint',
    postgres: '範例：127.0.0.1、db.example.com',
    mssql: '可填 HOST、HOST\\INSTANCE、HOST,PORT 或 HOST\\INSTANCE,PORT。例：DESKTOP-PNPEK4O\\SQLEXPRESS',
    supabase: 'Supabase Dashboard → Project Settings → Database → Host。格式：db.<project-ref>.supabase.co',
  };

  DBM.TYPE_DEFAULTS = {
    mysql:    { host: '127.0.0.1', port: '3306', database: '', user: 'root',     password: '', authMode: 'sql' },
    postgres: { host: '127.0.0.1', port: '5432', database: '', user: 'postgres', password: '', authMode: 'sql' },
    mssql:    { host: 'DESKTOP-PNPEK4O\\SQLEXPRESS', port: '', database: '', user: 'sa', password: '', authMode: 'sql' },
    sqlite:   { path: 'C:\\data\\app.db' },
    supabase: { host: 'db.<project-ref>.supabase.co', port: '5432', database: '', user: 'postgres', password: '', authMode: 'sql' },
  };
})();
