// Inject top nav + scroll progress into all docs.
// Just add <script src="docs-nav.js"></script> at end of body (or anywhere).

(function () {
  const NAV_LINKS = [
    { href: '方案首頁.html', label: '首頁' },
    { href: '架構展示.html', label: '架構' },
    { href: '區塊參考.html', label: '區塊' },
    { href: '技術文件.html', label: '技術' },
    { href: '程式碼與區塊對應文件.html', label: '對應' },
    { href: '操作文件.html', label: '操作' },
    { href: '使用手冊.html', label: '使用' },
    { href: '進度文件.html', label: '進度' },
    { href: '重構計畫.html', label: '重構' },
    { href: '優化擴充建議的計畫.html', label: '優化' },
    { href: '擴充點.html', label: '擴充點' },
    { href: 'HANDOVER.html', label: '交接' },
  ];

  function build() {
    // 1. Scroll progress bar
    const sp = document.createElement('div');
    sp.className = 'scroll-progress';
    document.body.insertBefore(sp, document.body.firstChild);

    // 2. Top nav
    const here = decodeURIComponent(location.pathname.split('/').pop() || '');
    const nav = document.createElement('div');
    nav.className = 'top-nav';
    nav.innerHTML = `
      <a class="brand" href="方案首頁.html" style="text-decoration:none;">
        <span class="logo-mini">DB</span> DB Migrator
      </a>
      <div class="nav-links">
        ${NAV_LINKS.map((l) => {
          const active = decodeURIComponent(l.href) === here ? ' class="active"' : '';
          return `<a href="${l.href}"${active}>${l.label}</a>`;
        }).join('')}
      </div>
      <div class="meta">v0.2.0</div>
    `;
    document.body.insertBefore(nav, sp.nextSibling);

    // 3. Scroll handler
    window.addEventListener('scroll', () => {
      const h = document.documentElement;
      const pct = (h.scrollTop / (h.scrollHeight - h.clientHeight) * 100) || 0;
      sp.style.width = pct + '%';
    }, { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
