const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
const API_SCAN = '/api/scan';

const table = document.getElementById('scan-table');
const status = document.getElementById('scan-progress-text');
const progressBar = document.getElementById('scan-progress-bar');
const errorMsg = document.getElementById('error-msg');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('scan-input');
const searchBtn = document.getElementById('scan-btn');
const metrics = document.getElementById('metrics-cards');
const deepLine = document.getElementById('deep-line');

let ws = null;
let wsActive = false;
let lastScanSymbol = '';
let lastPoolsRaw = [];
let currentSortKey = null;
let currentSortDir = 'desc';

// ==== NORMALIZATION ====
function normalizePool(pool) {
  return {
    pair: pool?.pair || '-',
    dex: pool?.dex || '-',
    version: pool?.version || '-',
    fee: pool?.fee || '-',
    price: pool?.priceHuman || pool?.price || '-',
    liquidity0: pool?.liquidity0 || pool?.liquidity || '-',
    liquidity1: pool?.liquidity1 || pool?.liquidityOther || '-',
    tvl: pool?.tvlHuman || pool?.tvl || '-',
    tvlTag: pool?.tvlTag || '-',
    risk: pool?.risk || '-',
    status: pool?.status || '-',
    arbitrage: pool?.arbitrage || pool?.arb || '-',
    freshness: pool?.freshness || '-',
    maxNoSlippageAmount: pool?.maxNoSlippageAmount || pool?.maxNoSlip || '-',
    pool: pool?.pool || '-',
    reserve0: pool?.reserve0 || '-',
    reserve1: pool?.reserve1 || '-'
  };
}

// ==== UI HELPERS ====
function hideExtraBlocks() {
  metrics?.classList.add('hidden');
  deepLine?.classList.add('hidden');
}
function showExtraBlocks() {
  metrics?.classList.remove('hidden');
  deepLine?.classList.remove('hidden');
}
function showError(msg) {
  errorMsg.innerText = msg;
  errorMsg.style.display = 'block';
  errorMsg.setAttribute('tabindex', '-1');
  errorMsg.focus?.();
  status.innerText = '';
  progressBar.style.background = '#fa395c';
  progressBar.style.width = '100%';
  searchBtn.classList.remove('loading');
  showExtraBlocks();
}
function hideError() {
  errorMsg.innerText = '';
  errorMsg.style.display = 'none';
}
function setProgress(cur, total) {
  if (total > 0) {
    progressBar.style.background = 'var(--accent)';
    progressBar.style.width = `${Math.min(100, (cur / total) * 100)}%`;
  }
}
function clearTable() {
  table.querySelector('tbody').innerHTML = '';
  table.classList.remove('active');
  table.parentElement.style.display = 'none';
}

// ==== SORT ====
function sortPools(pools) {
  if (!currentSortKey) return pools;
  return [...pools].sort((a, b) => {
    let x = a[currentSortKey], y = b[currentSortKey];
    const xNum = parseFloat(String(x).replace(/[^\d.\-]/g, ''));
    const yNum = parseFloat(String(y).replace(/[^\d.\-]/g, ''));
    if (!isNaN(xNum) && !isNaN(yNum) && x !== '-' && y !== '-') {
      return currentSortDir === 'asc' ? xNum - yNum : yNum - xNum;
    }
    x = (x || '').toString().toLowerCase();
    y = (y || '').toString().toLowerCase();
    if (x < y) return currentSortDir === 'asc' ? -1 : 1;
    if (x > y) return currentSortDir === 'asc' ? 1 : -1;
    return 0;
  });
}

// ==== TABLE RENDER ====
function renderTable(pools) {
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';
  if (!Array.isArray(pools) || pools.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 18;
    td.style.textAlign = 'center';
    td.innerText = 'Нет данных';
    tr.appendChild(td);
    tbody.appendChild(tr);
    table.parentElement.style.display = '';
    table.classList.add('active');
    return;
  }
  for (const pool of pools) {
    const tr = document.createElement('tr');
    const [token0 = '', token1 = ''] = (pool.pair || '').split('/');
    const pairTd = document.createElement('td');
    pairTd.innerHTML = `
      <span class="pair-main">${token0}</span>
      <span class="pair-secondary">/</span>
      <span class="pair-main">${token1}</span>
      ${pool.pair && pool.pair !== '-' ? `<button class="copy-btn" title="Скопировать пару" data-copy="${pool.pair}" aria-label="Скопировать пару ${pool.pair}">⧉</button>` : ''}
    `;
    tr.appendChild(pairTd);

    const dexTd = document.createElement('td');
    dexTd.className = 'hide-mobile';
    dexTd.textContent = pool.dex;
    tr.appendChild(dexTd);

    const verTd = document.createElement('td');
    verTd.textContent = pool.version;
    tr.appendChild(verTd);

    const feeTd = document.createElement('td');
    feeTd.className = 'hide-mobile';
    feeTd.textContent = pool.fee;
    tr.appendChild(feeTd);

    const priceTd = document.createElement('td');
    priceTd.textContent = pool.price;
    tr.appendChild(priceTd);

    const liq0Td = document.createElement('td');
    liq0Td.className = 'hide-mobile';
    liq0Td.textContent = pool.liquidity0;
    tr.appendChild(liq0Td);

    const liq1Td = document.createElement('td');
    liq1Td.className = 'hide-mobile';
    liq1Td.textContent = pool.liquidity1;
    tr.appendChild(liq1Td);

    const tvlTd = document.createElement('td');
    tvlTd.className = 'hide-mobile';
    tvlTd.textContent = pool.tvl;
    tr.appendChild(tvlTd);

    const tvlTagTd = document.createElement('td');
    tvlTagTd.className = 'hide-mobile';
    tvlTagTd.textContent = pool.tvlTag;
    tr.appendChild(tvlTagTd);

    const riskTd = document.createElement('td');
    riskTd.className = 'hide-mobile';
    riskTd.textContent = pool.risk;
    tr.appendChild(riskTd);

    const statusTd = document.createElement('td');
    statusTd.textContent = pool.status;
    tr.appendChild(statusTd);

    const arbTd = document.createElement('td');
    arbTd.textContent = pool.arbitrage;
    tr.appendChild(arbTd);

    const freshTd = document.createElement('td');
    freshTd.textContent = pool.freshness;
    tr.appendChild(freshTd);

    const maxNoSlipTd = document.createElement('td');
    maxNoSlipTd.textContent = pool.maxNoSlippageAmount;
    tr.appendChild(maxNoSlipTd);

    const poolTd = document.createElement('td');
    if (pool.pool && pool.pool !== '-') {
      poolTd.innerHTML = `
        <a class="bsc-link" href="https://bscscan.com/address/${pool.pool}" target="_blank" rel="noopener" title="Открыть в BscScan">${pool.pool.slice(0, 8)}…</a>
        <button class="copy-btn" title="Скопировать адрес" data-copy="${pool.pool}" aria-label="Скопировать адрес пула ${pool.pool}">⧉</button>
      `;
    } else {
      poolTd.textContent = '-';
    }
    tr.appendChild(poolTd);

    const r0Td = document.createElement('td');
    r0Td.textContent = pool.reserve0;
    tr.appendChild(r0Td);

    const r1Td = document.createElement('td');
    r1Td.textContent = pool.reserve1;
    tr.appendChild(r1Td);

    tbody.appendChild(tr);
  }
  table.parentElement.style.display = '';
  table.classList.add('active');
  tbody.querySelectorAll('.copy-btn').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const toCopy = btn.getAttribute('data-copy') || '';
      if (toCopy && window.navigator?.clipboard) {
        window.navigator.clipboard.writeText(toCopy).then(() => {
          btn.innerText = '✔';
          btn.setAttribute('aria-label', 'Скопировано!');
          setTimeout(() => {
            btn.innerText = '⧉';
            btn.setAttribute('aria-label', 'Скопировать');
          }, 800);
        });
      }
    };
  });
}

// ==== MAIN RENDER ====
function renderPools(poolsRaw) {
  lastPoolsRaw = poolsRaw || [];
  clearTable();
  const normPools = (Array.isArray(poolsRaw) ? poolsRaw : []).map(normalizePool);
  const sortedPools = sortPools(normPools);
  renderTable(sortedPools);
}

// ==== WS LOGIC ====
function setupWebSocket() {
  if (wsActive && ws) {
    ws.close();
    wsActive = false;
  }
  ws = new WebSocket(WS_URL.replace(/^http/, 'ws'));
  wsActive = true;

  ws.onopen = () => {
    status.innerText = 'WebSocket подключен. Ждите...';
    status.style.color = '#6ce04a';
  };

  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'progress' || data.type === 'update') {
      hideExtraBlocks();
      renderPools(data.pairs || []);
      setProgress((data.poolsCount || 0), (data.progress?.total || data.poolsCount || 1));
      if (data.progress?.running) {
        status.innerText = data.pairs?.length > 0
          ? `Идёт сканирование… (${data.pairs.length} пулов)`
          : 'Сканирование…';
        status.style.color = '#fcb900';
        progressBar.style.background = '#fcb900';
      } else {
        status.innerText = data.pairs?.length > 0
          ? `Готово (${data.pairs.length} пулов)`
          : 'Пулы не найдены';
        status.style.color = '#2de3ff';
        progressBar.style.background = '#2de3ff';
        progressBar.style.width = '100%';
        searchBtn.classList.remove('loading');
        showExtraBlocks();
      }
    } else if (data.type === 'done') {
      showExtraBlocks();
      status.innerText = 'Готово';
      status.style.color = '#2de3ff';
      progressBar.style.background = '#2de3ff';
      progressBar.style.width = '100%';
      searchBtn.classList.remove('loading');
    }
  };

  ws.onerror = (e) => {
    showError('WebSocket error: ' + (e.message || 'unknown'));
    wsActive = false;
  };

  ws.onclose = () => {
    wsActive = false;
    status.innerText = 'WebSocket отключён. Обновите страницу.';
    status.style.color = '#fa395c';
  };
}

setupWebSocket();

// ==== SEARCH FORM HANDLER ====
searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const symbol = (searchInput.value || '').trim();
  if (!symbol) {
    showError('Введите тикер, адрес или пару токенов');
    return;
  }
  if (symbol.toLowerCase() === lastScanSymbol.toLowerCase() && wsActive) return;
  lastScanSymbol = symbol;

  searchBtn.disabled = true;
  searchForm.querySelectorAll('input, button').forEach(el => el.disabled = true);
  searchBtn.classList.add('loading');

  try {
    hideError();
    progressBar.style.background = 'var(--accent)';
    progressBar.style.width = '8%';
    status.innerText = 'Запуск сканирования...';
    status.style.color = '';
    clearTable();
    showExtraBlocks();

    if (!wsActive) setupWebSocket();

    const res = await fetch(API_SCAN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol })
    });
    const data = await res.json();
    if (!data.ok) {
      showError('Ошибка запуска сканирования: ' + (data.error || ''));
      return;
    }
    status.innerText = 'Сканирую...';
    renderPools([]);
  } catch (err) {
    showError('Ошибка API: ' + (err?.message || err));
  } finally {
    searchBtn.disabled = false;
    searchForm.querySelectorAll('input, button').forEach(el => el.disabled = false);
    searchBtn.classList.remove('loading');
  }
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    searchForm.dispatchEvent(new Event('submit', { cancelable: true }));
  }
});

function setupTableSortHandlers() {
  document.querySelectorAll('#scan-table th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.onclick = () => {
      const key = th.getAttribute('data-sort');
      if (currentSortKey === key) {
        currentSortDir = currentSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        currentSortKey = key;
        currentSortDir = 'desc';
      }
      renderPools(lastPoolsRaw);
    };
  });
}
setTimeout(setupTableSortHandlers, 300);

function updateStickyHeader() {
  document.querySelectorAll('.dex-table thead').forEach(head => {
    head.style.transform = 'translateZ(0)';
  });
}
window.addEventListener('resize', () => {
  if (!lastPoolsRaw.length) return;
  renderPools(lastPoolsRaw);
  updateStickyHeader();
});
window.addEventListener('touchmove', updateStickyHeader);

if (window.matchMedia('(pointer: fine)').matches) {
  setTimeout(updateStickyHeader, 500);
}
if (errorMsg) {
  errorMsg.addEventListener('DOMSubtreeModified', () => {
    if (errorMsg.innerText) errorMsg.focus();
  });
}
function scrollToTable() {
  if (table.classList.contains('active')) {
    table.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
