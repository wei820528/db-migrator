// Shared DOM / util helpers. Loaded first.
(function () {
  const DBM = (window.DBM = window.DBM || {});

  DBM.$ = (sel, root = document) => root.querySelector(sel);
  DBM.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  DBM.escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  DBM.loadScriptOnce = (src) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return;
    const s = document.createElement('script');
    s.src = src;
    s.dataset.src = src;
    document.body.appendChild(s);
  };

  DBM.debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  // Poll a background job until done/error; updates log + result selectors.
  DBM.pollJob = async function (id, logSel, resultSel, onDone) {
    while (true) {
      const job = await fetch(`/api/jobs/${id}`).then((x) => x.json());
      const logEl = DBM.$(logSel);
      const resultEl = DBM.$(resultSel);
      if (logEl) logEl.textContent = (job.progress || []).map((p) => p.line).join('\n');
      if (job.status === 'done') {
        if (resultEl) resultEl.innerHTML = onDone(job) || '完成';
        return;
      }
      if (job.status === 'error') {
        if (resultEl) resultEl.innerHTML = `<span style="color:#dc2626">錯誤：${DBM.escapeHtml(job.error)}</span>`;
        return;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  };

  // Extract best error message from JSON or ASP.NET ProblemDetails response.
  DBM.describeServerError = (r) => {
    if (!r) return 'No response';
    if (r.error) return r.error;
    if (r.errors) {
      const flat = Object.entries(r.errors).map(([k, v]) => `${k}: ${(v || []).join(', ')}`).join('; ');
      return flat || r.title || 'Validation error';
    }
    return r.title || JSON.stringify(r);
  };
})();
