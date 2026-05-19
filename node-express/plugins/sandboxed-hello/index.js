// Sample sandboxed plugin — v2 Theme D Phase 2 + 3 demo。
//
// 跟既有的 plugins/hello 不一樣的地方：
//   - 整個檔案在 worker_thread 內跑（崩潰不會 take down main process）
//   - 跟外界唯一通道是傳入的 ctx 物件
//   - 沒有 export object — 改 export 一個 function(ctx)，由 ctx.route.mount 註冊 endpoints
//   - Phase 3：require() 受 permission gate 控制 — 沒拿 'fs:*' / 'network'
//     就不能 require('fs') / require('http')；只能用 ctx 跟 always-allowed 工具
//
// 本範例只用 'route' permission，所以 fs / network 都會被 gate 拒絕（見 /try-fs）。

module.exports = function (ctx) {
  ctx.log('sandboxed-hello loaded with permissions:', ctx.permissions.join(','));

  // GET /api/plugin/sandboxed-hello/
  ctx.route.mount('GET', '/', async (req) => {
    return {
      status: 200,
      body: {
        message: 'Hello from inside worker_thread!',
        plugin: ctx.pluginName,
        permissions: ctx.permissions,
        time: new Date().toISOString(),
        thread: ctx.threadId,    // 證明真的在 worker；不需 require('worker_threads')
      },
    };
  });

  // GET /api/plugin/sandboxed-hello/echo/:text
  ctx.route.mount('GET', '/echo/:text', async (req) => {
    return { status: 200, body: { echoed: req.params.text } };
  });

  // POST /api/plugin/sandboxed-hello/crash  — 故意 throw 證明崩潰不會 kill main process
  ctx.route.mount('POST', '/crash', async () => {
    throw new Error('intentional crash from sandboxed plugin');
  });

  // GET /api/plugin/sandboxed-hello/try-fs  — Phase 3 demo：
  // 本 plugin 沒拿 'fs:tmp' / 'fs:plugin-dir'，require('fs') 應該被 gate 攔。
  ctx.route.mount('GET', '/try-fs', async () => {
    try {
      require('fs');
      return { status: 200, body: { ok: true, note: '⚠ fs was loaded — gate bypassed?!' } };
    } catch (e) {
      return { status: 200, body: { ok: false, note: 'fs require correctly denied', error: e.message } };
    }
  });
};
