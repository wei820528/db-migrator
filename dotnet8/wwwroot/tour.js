// Lightweight onboarding tour — no deps.

const TOUR_KEY = 'dbmigrator.tourSeen.v1';

const STEPS = [
  {
    title: '👋 歡迎使用 DB Migrator',
    body:
      '這個工具讓你透過瀏覽器匯出 / 匯入資料庫，支援 <b>MySQL、PostgreSQL、SQL Server、SQLite</b>。<br><br>' +
      '不用裝任何 DB CLI 工具，填入連線資訊就能用。<br><br>' +
      '跟著走一遍，大概 1 分鐘。',
    target: null,
  },
  {
    title: '1. 選擇資料庫類型',
    body:
      '點任一張卡片開始。每種 DB 連線方式略有不同：<br>' +
      '• <b>MySQL / PostgreSQL / SQL Server</b>：填 host + port + 帳密<br>' +
      '• <b>SQLite</b>：填本機檔案路徑',
    target: '.cards',
  },
  {
    title: '2. 填連線資訊',
    body:
      '選了卡片之後這個區塊會出現。<br><br>' +
      'Host 欄位可以填任何位址：本機 (<code>127.0.0.1</code>)、區網 IP、雲端服務 endpoint（AWS RDS、GCP Cloud SQL 等）。',
    target: '#step-conn',
    requireType: true,
  },
  {
    title: '3. 測試連線',
    body:
      '按「連線測試」確認連得上。<br><br>看到「成功，server x.x.x」就 OK，下方會自動列出 DB 裡的資料表。',
    target: '#btn-test',
    requireType: true,
  },
  {
    title: '4. 切換匯出 / 匯入',
    body: '預設是「匯出」分頁。要做匯入時切到右邊。',
    target: '.mode-switch',
    requireType: true,
  },
  {
    title: '5. 匯出範圍',
    body:
      '<b>全部匯出</b>：整個 DB 一個 SQL 檔<br>' +
      '<b>選擇資料表</b>：勾你要的 table<br><br>' +
      '另外可以勾「只匯出結構」或「只匯出資料」。',
    target: '#step-export',
    requireType: true,
  },
  {
    title: '6. 開始匯出',
    body:
      '按下後背景跑 dump，下方 log 顯示進度。<br><br>完成後出現「下載 SQL 檔」連結，點下去存到本機。',
    target: '#btn-export',
    requireType: true,
  },
  {
    title: '7. 匯入流程',
    body:
      '切到「匯入」分頁，選一個 .sql 檔，按「檢查內容」。<br><br>' +
      '系統會比對 SQL 檔裡的 table 跟目標 DB 現有的 table，顯示對照：<br>' +
      '• <span style="color:#059669">綠色「不存在」</span>：會新建<br>' +
      '• <span style="color:#b45309">黃色「已存在」</span>：會被覆寫',
    target: '.mode-switch button[data-mode="import"]',
    requireType: true,
  },
  {
    title: '✅ 完成！',
    body:
      '可以隨時點右上角的 <b>?</b> 叫出這個指引。<br><br>' +
      '⚠️ 實際操作前，建議先用測試 DB 試一次，確認流程跟你預期的一樣。',
    target: null,
  },
];

let currentIndex = 0;
let overlay, tooltip, highlighted;

function ensureDom() {
  if (overlay) return;

  overlay = document.createElement('div');
  overlay.className = 'tour-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) endTour();
  });
  document.body.appendChild(overlay);

  tooltip = document.createElement('div');
  tooltip.className = 'tour-tooltip';
  tooltip.innerHTML = `
    <div class="tour-step-num"></div>
    <h3 class="tour-title"></h3>
    <div class="tour-body"></div>
    <div class="tour-nav">
      <button class="tour-skip" type="button">略過</button>
      <div class="tour-nav-right">
        <button class="tour-prev" type="button">上一步</button>
        <button class="tour-next" type="button">下一步</button>
      </div>
    </div>
  `;
  document.body.appendChild(tooltip);

  tooltip.querySelector('.tour-skip').addEventListener('click', endTour);
  tooltip.querySelector('.tour-prev').addEventListener('click', () => goTo(currentIndex - 1));
  tooltip.querySelector('.tour-next').addEventListener('click', () => {
    if (currentIndex === STEPS.length - 1) endTour();
    else goTo(currentIndex + 1);
  });

  window.addEventListener('resize', () => positionTooltip());
  window.addEventListener('scroll', () => positionTooltip(), true);
}

function clearHighlight() {
  if (highlighted) {
    highlighted.classList.remove('tour-highlight');
    highlighted = null;
  }
}

function goTo(i) {
  if (i < 0 || i >= STEPS.length) return;
  currentIndex = i;
  const step = STEPS[i];

  // If a step requires a DB type to be picked but user hasn't, fall back to centered tooltip.
  let target = null;
  if (step.target) {
    const el = document.querySelector(step.target);
    if (el && el.offsetParent !== null) target = el;
  }
  if (step.requireType && !document.querySelector('.card.selected')) target = null;

  clearHighlight();
  if (target) {
    target.classList.add('tour-highlight');
    highlighted = target;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  tooltip.querySelector('.tour-step-num').textContent = `第 ${i + 1} 步 / 共 ${STEPS.length} 步`;
  tooltip.querySelector('.tour-title').textContent = step.title;
  tooltip.querySelector('.tour-body').innerHTML =
    step.body + (step.requireType && !target && document.querySelector('.card.selected') === null
      ? '<br><br><i style="color:#9ca3af">（先點上面任一張卡片，這個區塊就會出現）</i>'
      : '');
  tooltip.querySelector('.tour-prev').disabled = i === 0;
  tooltip.querySelector('.tour-next').textContent = i === STEPS.length - 1 ? '完成' : '下一步';

  positionTooltip();
}

function positionTooltip() {
  if (!tooltip) return;
  const target = highlighted;
  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (!target) {
    tooltip.style.top = (vh / 2 - th / 2) + 'px';
    tooltip.style.left = (vw / 2 - tw / 2) + 'px';
    return;
  }

  const r = target.getBoundingClientRect();
  // Try below first, then above, then right.
  let top = r.bottom + 12;
  let left = r.left + r.width / 2 - tw / 2;
  if (top + th > vh - 12) top = r.top - th - 12;
  if (top < 12) top = 12;
  if (left < 12) left = 12;
  if (left + tw > vw - 12) left = vw - tw - 12;
  tooltip.style.top = top + 'px';
  tooltip.style.left = left + 'px';
}

function startTour() {
  ensureDom();
  overlay.classList.add('active');
  tooltip.classList.add('active');
  goTo(0);
}

function endTour() {
  if (overlay) overlay.classList.remove('active');
  if (tooltip) tooltip.classList.remove('active');
  clearHighlight();
  try { localStorage.setItem(TOUR_KEY, '1'); } catch {}
}

window.addEventListener('DOMContentLoaded', () => {
  // Help button
  const help = document.getElementById('btn-help');
  if (help) help.addEventListener('click', startTour);

  // Auto-show on first visit
  let seen = false;
  try { seen = localStorage.getItem(TOUR_KEY) === '1'; } catch {}
  if (!seen) setTimeout(startTour, 400);
});

// Keep track when user clicks a card so tour can re-position if running.
document.addEventListener('click', (e) => {
  if (e.target.closest('.card') && tooltip?.classList.contains('active')) {
    setTimeout(() => goTo(currentIndex), 100);
  }
});
