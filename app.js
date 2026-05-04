// ============================================================
// 山椒 圃場モニター - app.js
// ============================================================

// ============================================================
// 認証
// ============================================================

const authState = {
  isAdmin: true,
  userKey: null,
  userName: null,
  allowedFields: null, // null = 全圃場（管理者）
  fieldLat: null,
  fieldLon: null,
  adminFields: [],
};

const SESSION_MS = 4 * 60 * 60 * 1000; // 4時間

function setAuthSession(key) {
  sessionStorage.setItem(`sansho_auth_${key}`, 'ok');
  sessionStorage.setItem(`sansho_auth_${key}_exp`, Date.now() + SESSION_MS);
}

function isAuthValid(key) {
  if (sessionStorage.getItem(`sansho_auth_${key}`) !== 'ok') return false;
  const exp = parseInt(sessionStorage.getItem(`sansho_auth_${key}_exp`) ?? '0');
  if (Date.now() > exp) {
    sessionStorage.removeItem(`sansho_auth_${key}`);
    sessionStorage.removeItem(`sansho_auth_${key}_exp`);
    return false;
  }
  return true;
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function initAuth() {
  const params = new URLSearchParams(window.location.search);
  const userKey = params.get('u');

  let config;
  try {
    const res = await fetch('./data/config.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error();
    config = await res.json();
    configUsers = config.users ?? {};
  } catch {
    document.body.innerHTML =
      '<div style="padding:48px;text-align:center;color:#999;font-size:15px">設定ファイルを読み込めませんでした</div>';
    await new Promise(() => {});
  }

  // 管理者モード（?u= なし）
  if (!userKey) {
    const adminConfig = config.admin;
    if (adminConfig?.pinHash) {
      if (!isAuthValid('admin')) {
        await waitForPin(adminConfig);
        setAuthSession('admin');
        document.getElementById('pinOverlay').classList.remove('visible');
      }
    }
    // 座標付き圃場を取得
    try {
      const fieldsRes = await fetch('./data/fields.json', { cache: 'no-cache' });
      if (fieldsRes.ok) {
        const fieldsJson = await fieldsRes.json();
        authState.adminFields = fieldsJson.filter(f => f.lat != null && f.lon != null);
      }
    } catch (_) {}
    return;
  }

  // 農家モード
  const userConfig = config.users?.[userKey];
  if (!userConfig) {
    document.body.innerHTML =
      '<div style="padding:48px;text-align:center;color:#999;font-size:15px">このURLは無効です</div>';
    await new Promise(() => {});
  }

  authState.isAdmin = false;
  authState.userKey = userKey;
  authState.userName = userConfig.name;
  authState.allowedFields = userConfig.fields;

  // 圃場座標を取得
  try {
    const fieldsRes = await fetch('./data/fields.json', { cache: 'no-cache' });
    if (fieldsRes.ok) {
      const fieldsJson = await fieldsRes.json();
      const match = fieldsJson.find(f =>
        userConfig.fields?.includes(f.name) && f.lat != null && f.lon != null
      );
      if (match) { authState.fieldLat = match.lat; authState.fieldLon = match.lon; }
    }
  } catch (_) {}

  // セッション済みチェック
  if (isAuthValid(userKey)) {
    applyUserUI();
    return;
  }

  // PIN入力を待つ
  await waitForPin(userConfig);
  setAuthSession(userKey);
  document.getElementById('pinOverlay').classList.remove('visible');
  applyUserUI();
}

function waitForPin(userConfig) {
  return new Promise(resolve => {
    const overlay = document.getElementById('pinOverlay');
    document.getElementById('pinUserName').textContent = `${userConfig.name} さん`;
    overlay.classList.add('visible');

    let pin = '';
    const dots = document.querySelectorAll('.pin-dot');
    const errorEl = document.getElementById('pinError');

    function updateDots() {
      dots.forEach((d, i) => d.classList.toggle('filled', i < pin.length));
    }

    document.querySelectorAll('.pin-key').forEach(key => {
      key.addEventListener('click', async () => {
        const val = key.dataset.val;
        if (val === 'del') {
          pin = pin.slice(0, -1);
          errorEl.textContent = '';
        } else if (pin.length < 4) {
          pin += val;
          if (pin.length === 4) {
            updateDots();
            const hash = await sha256(pin);
            if (hash === userConfig.pinHash) {
              resolve();
            } else {
              pin = '';
              errorEl.textContent = 'PINが違います。もう一度入力してください。';
            }
            return;
          }
        }
        updateDots();
      });
    });
  });
}

function applyUserUI() {
  // ファイルタブを非表示
  document.querySelector('.tab-btn[data-tab="files"]').style.display = 'none';
  // 比較タブをアクティブに
  document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
  document.querySelector('.tab-btn[data-tab="yearly"]').classList.add('active');
  document.getElementById('tab-yearly').classList.add('active');
}

// ============================================================
// 定数
// ============================================================

// ---- 定数 -----------------------------------------------
const FIELD_COLORS = [
  '#2196F3','#FF5722','#4CAF50','#9C27B0',
  '#FF9800','#795548','#E91E63','#00BCD4',
  '#CDDC39','#3F51B5','#009688','#F44336',
];

// 年度別比較チャートの年ごとの色（古い年から順に）
const SEASON_YEAR_STYLES = [
  { color: '#9E9E9E', dash: [6, 4] },  // 3年以上前
  { color: '#FF9800', dash: [6, 4] },  // 2年前
  { color: '#1976D2', dash: [4, 2] },  // 前年
  { color: '#3a7d44', dash: [] },      // 今年（実線・緑）
];

const RAW_COLUMNS = ['年','月','日','時分','気温','地中温度','土壌水分','照度','EC'];

const ALL_METRICS = [
  'データ数',
  '平均気温','最低気温','最高気温','気温差',
  '平均地中温度','最低地中温度','最高地中温度','地中温度差',
  '平均土壌水分','平均照度','平均EC',
  '積算気温','積算地中温度','積算土壌水分','積算照度','積算温度変化量',
];

const CUMULATIVE_MAP = {
  '積算気温':     '平均気温',
  '積算地中温度': '平均地中温度',
  '積算土壌水分': '平均土壌水分',
  '積算照度':     '平均照度',
  '積算温度変化量':'気温差',
};

// ---- State -----------------------------------------------
const state = {
  fields: {},
  charts: [],
  currentChartIdx: 0,
  currentMetrics: [],
  individualScale: false,
  lastFieldMap: null,
};

const yearlyState = { chart: null };

// ---- Storage: センサーデータ ---------------------------
function saveFields() {
  try { localStorage.setItem('sansho_fields', JSON.stringify(state.fields)); } catch (_) {}
}
function loadFields() {
  try {
    const raw = localStorage.getItem('sansho_fields');
    if (raw) state.fields = JSON.parse(raw);
  } catch (_) { state.fields = {}; }
}

// ---- Storage: 物候記録 ----------------------------------
const PHENO_KEY = 'sansho_pheno';

function savePhenoRecords(records) {
  try { localStorage.setItem(PHENO_KEY, JSON.stringify(records)); } catch (_) {}
}
function loadPhenoRecords() {
  try {
    const raw = localStorage.getItem(PHENO_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}

// ---- Color -----------------------------------------------
function fieldColor(name) {
  const idx = Object.keys(state.fields).indexOf(name);
  return FIELD_COLORS[Math.max(idx, 0) % FIELD_COLORS.length];
}

// ---- CSV: Encoding ---------------------------------------
async function readFileText(file) {
  const buf = await file.arrayBuffer();
  for (const enc of ['shift-jis', 'utf-8-sig', 'utf-8']) {
    try {
      const text = new TextDecoder(enc).decode(buf);
      if (/気温|年/.test(text)) return text;
    } catch (_) {}
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(await file.arrayBuffer());
}

// ---- CSV: 生データ → 日別集計 ----------------------------
function round3(v) {
  return (v != null && isFinite(v)) ? Math.round(v * 1000) / 1000 : null;
}

function buildDailySummary(rows, fieldName) {
  const byDate = {};
  for (const row of rows) {
    const y = String(row['年'] ?? '').trim().padStart(4, '0');
    const m = String(row['月'] ?? '').trim().padStart(2, '0');
    const d = String(row['日'] ?? '').trim().padStart(2, '0');
    if (y === '0000') continue;
    const key = `${y}-${m}-${d}`;
    (byDate[key] = byDate[key] || []).push(row);
  }

  const dates = Object.keys(byDate).sort();
  const result = [];
  let cumTemp = 0, cumSoil = 0, cumMoist = 0, cumIllum = 0, cumTempChg = 0;

  for (const date of dates) {
    const dr = byDate[date];
    const nums = k => dr.map(r => parseFloat(r[k])).filter(v => !isNaN(v));
    const sum  = a => a.reduce((s, v) => s + v, 0);
    const avg  = a => a.length ? sum(a) / a.length : null;
    const min  = a => a.length ? Math.min(...a) : null;
    const max  = a => a.length ? Math.max(...a) : null;

    const T = nums('気温'), S = nums('地中温度'), M = nums('土壌水分'),
          I = nums('照度'),  E = nums('EC');

    let chg = 0;
    for (let i = 1; i < T.length; i++) chg += Math.abs(T[i] - T[i - 1]);

    cumTemp    += avg(T) ?? 0;
    cumSoil    += avg(S) ?? 0;
    cumMoist   += avg(M) ?? 0;
    cumIllum   += avg(I) ?? 0;
    cumTempChg += chg;

    result.push({
      圃場名: fieldName, 日付: date, データ数: dr.length,
      平均気温:     round3(avg(T)), 最低気温:     round3(min(T)), 最高気温:     round3(max(T)),
      平均地中温度: round3(avg(S)), 最低地中温度: round3(min(S)), 最高地中温度: round3(max(S)),
      平均土壌水分: round3(avg(M)), 平均照度:     round3(avg(I)), 平均EC:       round3(avg(E)),
      気温差:       round3((max(T) ?? 0) - (min(T) ?? 0)),
      地中温度差:   round3((max(S) ?? 0) - (min(S) ?? 0)),
      積算気温:     round3(cumTemp),   積算地中温度: round3(cumSoil),
      積算土壌水分: round3(cumMoist),  積算照度:     round3(cumIllum),
      積算温度変化量: round3(cumTempChg),
    });
  }
  return result;
}

// ---- CSV: 日別集計済み CSV 正規化 ------------------------
function normalizeDailyCSV(rows, headers, fieldName) {
  const hasDate    = headers.includes('日付');
  const hasMetrics = ALL_METRICS.some(m => headers.includes(m));
  if (!hasDate || !hasMetrics) throw new Error('日別集計済みCSVとして認識できません（「日付」列が必要）');

  return rows
    .map(r => {
      const date = r['日付'] ? String(r['日付']).trim().slice(0, 10) : null;
      if (!date) return null;
      const out = { 圃場名: fieldName, 日付: date };
      for (const m of ALL_METRICS) {
        if (headers.includes(m)) out[m] = parseFloat(r[m]) || null;
      }
      return out;
    })
    .filter(Boolean)
    .sort((a, b) => a.日付.localeCompare(b.日付));
}

// ---- CSV: ファイル → 日別集計 ----------------------------
async function parseCSVFile(file) {
  const text = await readFileText(file);
  return parseCSVText(text, file.name.replace(/\.csv$/i, ''));
}

async function parseCSVText(text, fieldName) {
  return new Promise((resolve, reject) => {
    Papa.parse(text, {
      header: true, skipEmptyLines: true,
      complete(res) {
        const headers = res.meta.fields || [];
        try {
          if (RAW_COLUMNS.every(c => headers.includes(c))) {
            resolve({ fieldName, summary: buildDailySummary(res.data, fieldName) });
          } else {
            resolve({ fieldName, summary: normalizeDailyCSV(res.data, headers, fieldName) });
          }
        } catch (e) { reject(e); }
      },
      error: e => reject(new Error(e.message)),
    });
  });
}

// ---- 期間フィルタ -----------------------------------------
function filterPeriod(rows, start, end) {
  return rows.filter(r =>
    (!start || r.日付 >= start) && (!end || r.日付 <= end)
  );
}

// ---- 日付整合 ---------------------------------------------
function alignCommon(fieldMap) {
  const sets = Object.values(fieldMap).map(rows => new Set(rows.map(r => r.日付)));
  if (sets.length === 0) return fieldMap;
  const common = sets.reduce((a, b) => new Set([...a].filter(d => b.has(d))));
  const out = {};
  for (const [name, rows] of Object.entries(fieldMap)) {
    out[name] = rows.filter(r => common.has(r.日付));
  }
  return out;
}

function alignInterpolate(fieldMap) {
  const allDates = [...new Set(
    Object.values(fieldMap).flatMap(rows => rows.map(r => r.日付))
  )].sort();

  const out = {};
  for (const [name, rows] of Object.entries(fieldMap)) {
    const byDate = Object.fromEntries(rows.map(r => [r.日付, r]));
    const metrics = ALL_METRICS.filter(m => rows.some(r => r[m] != null));
    const expanded = allDates.map(d => byDate[d] || { 圃場名: name, 日付: d });

    for (const m of metrics) {
      const vals = expanded.map(r => r[m] ?? null);
      for (let i = 0; i < vals.length; i++) {
        if (vals[i] != null) continue;
        let li = i - 1, ri = i + 1;
        while (li >= 0 && vals[li] == null) li--;
        while (ri < vals.length && vals[ri] == null) ri++;
        if (li >= 0 && ri < vals.length) {
          vals[i] = round3(vals[li] + (vals[ri] - vals[li]) * (i - li) / (ri - li));
        } else if (li >= 0) {
          vals[i] = vals[li];
        } else if (ri < vals.length) {
          vals[i] = vals[ri];
        }
      }
      expanded.forEach((r, i) => { r[m] = vals[i]; });
    }
    out[name] = expanded;
  }
  return out;
}

// ---- 累積再計算 -------------------------------------------
function recomputeCumulative(fieldMap) {
  const out = {};
  for (const [name, rows] of Object.entries(fieldMap)) {
    const sorted = [...rows].sort((a, b) => a.日付.localeCompare(b.日付));
    for (const [cumCol, srcCol] of Object.entries(CUMULATIVE_MAP)) {
      if (!sorted.some(r => r[srcCol] != null)) continue;
      let acc = 0;
      for (const r of sorted) {
        acc += r[srcCol] ?? 0;
        r[cumCol] = round3(acc);
      }
    }
    out[name] = sorted;
  }
  return out;
}

// ---- 利用可能なメトリクス取得 -----------------------------
function getAvailableMetrics() {
  const allRows = Object.values(state.fields).flat();
  return ALL_METRICS.filter(m => allRows.some(r => r[m] != null));
}

// ---- CSV ダウンロード ------------------------------------
function downloadCSV(fieldMap, metrics) {
  const cols = ['圃場名', '日付', ...metrics];
  const lines = [cols.join(',')];
  for (const rows of Object.values(fieldMap)) {
    for (const r of rows) {
      lines.push(cols.map(c => r[c] ?? '').join(','));
    }
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sansho_export_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

// ---- Render: フィールドリスト ----------------------------
function renderFieldList() {
  const container = document.getElementById('fieldList');
  const names = Object.keys(state.fields);
  if (names.length === 0) { container.innerHTML = ''; return; }

  let html = `<div class="field-list-header">
    <h3>読込済み圃場（${names.length}件）</h3>
    <button class="btn-text-danger" id="deleteAllBtn">すべて削除</button>
  </div>`;

  for (const name of names) {
    const rows = state.fields[name];
    const color = fieldColor(name);
    const first = rows[0]?.日付 ?? '-';
    const last  = rows[rows.length - 1]?.日付 ?? '-';
    html += `<div class="field-card" style="border-left-color:${color}">
      <div class="field-dot" style="background:${color}"></div>
      <div class="field-info">
        <div class="field-name">${esc(name)}</div>
        <div class="field-meta">${first} 〜 ${last}（${rows.length}日分）</div>
      </div>
      <button class="btn-delete" data-name="${esc(name)}">削除</button>
    </div>`;
  }

  container.innerHTML = html;
  container.querySelectorAll('.btn-delete').forEach(btn =>
    btn.addEventListener('click', () => {
      if (confirm(`「${btn.dataset.name}」を削除しますか？`)) {
        delete state.fields[btn.dataset.name];
        saveFields(); renderAll();
      }
    })
  );
  document.getElementById('deleteAllBtn').addEventListener('click', () => {
    if (confirm('すべての圃場データを削除しますか？')) {
      state.fields = {}; saveFields(); renderAll();
    }
  });
}

// ---- Render: フィールドチェックボックス ------------------
function renderFieldCheckboxes() {
  const el = document.getElementById('fieldCheckboxes');
  const names = Object.keys(state.fields);
  if (names.length === 0) {
    el.innerHTML = '<p class="empty-msg">まずCSVファイルを読み込んでください</p>';
    return;
  }
  el.innerHTML = names.map(name => {
    const color = fieldColor(name);
    return `<label class="cb-row">
      <input type="checkbox" value="${esc(name)}" checked>
      <span class="cb-dot" style="background:${color}"></span>
      <span class="cb-label">${esc(name)}</span>
    </label>`;
  }).join('');
}

// ---- Render: メトリクスチェックボックス ------------------
function renderMetricCheckboxes() {
  const el = document.getElementById('metricCheckboxes');
  const metrics = getAvailableMetrics();
  if (metrics.length === 0) {
    el.innerHTML = '<p class="empty-msg">まずCSVファイルを読み込んでください</p>';
    return;
  }
  const DEFAULT_ON = ['積算気温','平均気温','最高気温','最低気温'];
  el.innerHTML = `<div class="metric-grid">${
    metrics.map(m => `<label class="metric-cb-row">
      <input type="checkbox" value="${esc(m)}" ${DEFAULT_ON.includes(m) ? 'checked' : ''}>
      <span class="metric-cb-label">${esc(m)}</span>
    </label>`).join('')
  }</div>`;
}

// ---- Render: グラフ群（カルーセル） ----------------------
function renderCharts(fieldMap, metrics) {
  state.charts.forEach(c => c.destroy());
  state.charts = [];
  state.currentChartIdx = 0;
  state.currentMetrics = metrics;
  state.lastFieldMap = fieldMap;

  const container = document.getElementById('chartsContainer');
  container.innerHTML = '';

  for (const metric of metrics) {
    const block = document.createElement('div');
    block.className = 'chart-block';
    block.innerHTML = `<canvas></canvas>`;
    container.appendChild(block);

    const canvas = block.querySelector('canvas');
    const entries = Object.entries(fieldMap);

    const scales = {
      x: {
        type: 'time',
        time: { unit: 'day', displayFormats: { day: 'M/d' } },
        ticks: { maxTicksLimit: 8, font: { size: 12 } },
      },
    };

    const datasets = entries.map(([name, rows], i) => {
      const color = fieldColor(name);
      const values = rows.map(r => r[metric]).filter(v => v != null && !isNaN(v));
      const axisId = state.individualScale ? `y_${i}` : 'y';

      if (state.individualScale && values.length > 0) {
        const mn = Math.min(...values), mx = Math.max(...values);
        const pad = Math.max((mx - mn) * 0.15, 0.5);
        scales[axisId] = {
          type: 'linear',
          display: i === 0,
          position: 'left',
          min: mn - pad,
          max: mx + pad,
          ticks: { font: { size: 12 }, maxTicksLimit: 6 },
        };
      } else if (!state.individualScale && i === 0) {
        scales['y'] = { ticks: { font: { size: 12 } } };
      }

      return {
        label: name,
        data: rows.map(r => ({ x: r.日付, y: r[metric] })),
        borderColor: color,
        backgroundColor: color + '22',
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointHitRadius: 20,
        tension: 0.3,
        fill: false,
        yAxisID: axisId,
      };
    });

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 14, font: { size: 13 } } },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y ?? '-'}` } },
        },
      },
    });
    state.charts.push(chart);
  }

  updateChartView();

  const dotsEl = document.getElementById('chartNavDots');
  dotsEl.innerHTML = metrics.map((_, i) =>
    `<div class="chart-dot${i === 0 ? ' active' : ''}" data-idx="${i}"></div>`
  ).join('');
  dotsEl.querySelectorAll('.chart-dot').forEach(dot => {
    dot.addEventListener('click', () => navigateChart(parseInt(dot.dataset.idx) - state.currentChartIdx));
  });

  document.getElementById('chartNav').style.display = 'flex';

  let touchStartX = 0;
  container.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  container.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) navigateChart(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function updateChartView() {
  const idx = state.currentChartIdx;
  const metrics = state.currentMetrics;

  document.querySelectorAll('.chart-block').forEach((b, i) => b.classList.toggle('active', i === idx));
  document.getElementById('chartNavLabel').textContent = `${metrics[idx]}　(${idx + 1} / ${metrics.length})`;
  document.getElementById('prevChartBtn').disabled = idx === 0;
  document.getElementById('nextChartBtn').disabled = idx === metrics.length - 1;
  document.querySelectorAll('.chart-dot').forEach((d, i) => d.classList.toggle('active', i === idx));

  requestAnimationFrame(() => state.charts[idx]?.resize());
}

function navigateChart(delta) {
  const next = state.currentChartIdx + delta;
  if (next < 0 || next >= state.currentMetrics.length) return;
  state.currentChartIdx = next;
  updateChartView();
}

// ---- Render: プレビューテーブル -------------------------
function renderPreview(fieldMap, metrics, onDownload) {
  const section = document.getElementById('previewSection');
  const allRows = Object.values(fieldMap).flat()
    .sort((a, b) => a.圃場名.localeCompare(b.圃場名) || a.日付.localeCompare(b.日付));

  const cols = ['圃場名', '日付', ...metrics];
  const preview = allRows.slice(0, 20);

  let html = `<div class="preview-header">
    <h3>データプレビュー（上位20行）</h3>
  </div>
  <div class="table-scroll">
    <table class="data-table">
      <thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>
        ${preview.map(r => `<tr>${cols.map(c => `<td>${r[c] ?? ''}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>
  </div>
  <button class="btn-download" id="downloadCsvBtn">&#8595; CSVをダウンロード</button>`;

  section.innerHTML = html;
  document.getElementById('downloadCsvBtn').addEventListener('click', onDownload);
}

// ---- 分析実行 -------------------------------------------
function runAnalysis() {
  const fieldNames = [...document.querySelectorAll('#fieldCheckboxes input:checked')].map(c => c.value);
  const metrics    = [...document.querySelectorAll('#metricCheckboxes input:checked')].map(c => c.value);
  const startDate  = document.getElementById('startDate').value;
  const endDate    = document.getElementById('endDate').value;
  const alignMode  = document.querySelector('input[name="alignMode"]:checked').value;

  if (fieldNames.length === 0) { alert('圃場を1つ以上選択してください'); return; }
  if (metrics.length === 0)    { alert('表示項目を1つ以上選択してください'); return; }

  let fieldMap = {};
  for (const name of fieldNames) {
    const rows = filterPeriod(state.fields[name] || [], startDate, endDate);
    if (rows.length > 0) fieldMap[name] = rows;
  }
  if (Object.keys(fieldMap).length === 0) {
    alert('指定期間にデータがありません');
    return;
  }

  fieldMap = alignMode === 'interpolate'
    ? alignInterpolate(fieldMap)
    : alignCommon(fieldMap);

  if (Object.keys(fieldMap).every(k => fieldMap[k].length === 0)) {
    alert('日付整合後に比較可能なデータがありません');
    return;
  }

  fieldMap = recomputeCumulative(fieldMap);

  renderCharts(fieldMap, metrics);
  renderPreview(fieldMap, metrics, () => downloadCSV(fieldMap, metrics));

  document.getElementById('settingsPanel').style.display = 'none';
  const summary = document.getElementById('settingsSummary');
  summary.style.display = 'flex';
  const periodText = (startDate && endDate) ? `${startDate} 〜 ${endDate}` : '全期間';
  document.getElementById('settingsSummaryText').textContent =
    `${periodText} | ${fieldNames.length}圃場 | ${metrics.length}指標`;

  document.getElementById('chartNav').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- Upload Handler -------------------------------------
async function handleFiles(files) {
  if (!files?.length) return;
  const status = document.getElementById('uploadStatus');
  status.innerHTML = '<div class="status-msg">読み込み中...</div>';

  const ok = [], ng = [];
  for (const file of files) {
    try {
      const { fieldName, summary } = await parseCSVFile(file);
      state.fields[fieldName] = summary;
      ok.push(`${fieldName}（${summary.length}日分）`);
    } catch (e) {
      ng.push(`${file.name}: ${e.message}`);
    }
  }

  if (authState.isAdmin) saveFields();
  renderAll();

  let html = '';
  if (ok.length) html += `<div class="status-msg status-ok">✓ ${ok.join('、')} を読み込みました</div>`;
  ng.forEach(m => { html += `<div class="status-msg status-err">✗ ${esc(m)}</div>`; });
  status.innerHTML = html;
}

// ============================================================
// 年度比較（全圃場・期間指定）
// ============================================================

// 圃場チェックボックスと指標ラジオボタンを描画
function renderYearlySelectors() {
  const fieldNames = Object.keys(state.fields);
  const noData = '<p class="empty-msg">まずデータを読み込んでください</p>';

  // 圃場ラジオボタン（1つ選択）
  const fEl = document.getElementById('yearlyFieldSelect');
  if (!fieldNames.length) {
    fEl.innerHTML = noData;
  } else {
    fEl.innerHTML = fieldNames.map((name, i) => {
      const color = fieldColor(name);
      return `<label class="cb-row">
        <input type="radio" name="yearlyField" value="${esc(name)}" ${i === 0 ? 'checked' : ''}>
        <span class="cb-dot" style="background:${color}"></span>
        <span class="cb-label">${esc(name)}</span>
      </label>`;
    }).join('');
  }

  // 指標ラジオボタン
  const mEl = document.getElementById('yearlyMetricSelect');
  const available = getAvailableMetrics().filter(m => m !== 'データ数' && !(m in CUMULATIVE_MAP));
  if (!available.length) {
    mEl.innerHTML = noData;
    return;
  }
  const DEFAULT = '平均気温';
  mEl.innerHTML = `<div class="metric-grid">${
    available.map(m => `
      <label class="metric-cb-row">
        <input type="radio" name="yearlyMetric" value="${esc(m)}" ${m === DEFAULT ? 'checked' : ''}>
        <span class="metric-cb-label">${esc(m)}</span>
      </label>`).join('')
  }</div>`;
}

// ---- 比較グラフ用ヘルパー ------------------------------------

function buildModeRows(allRows, startDate, endDate, mode, metric, chillThres) {
  let rows = filterPeriod(allRows, startDate, endDate)
               .sort((a, b) => a.日付.localeCompare(b.日付));
  if (!rows.length) return [];
  if (mode === 'cumulative') {
    let acc = 0;
    rows = rows.map(r => {
      const srcCol = CUMULATIVE_MAP[metric] ?? metric;
      acc = round3(acc + (r[srcCol] ?? 0));
      return { ...r, [metric]: acc };
    });
  } else if (mode === 'chill') {
    let acc = 0;
    rows = rows.map(r => {
      const temp = r['平均気温'];
      if (temp != null && temp <= chillThres) acc++;
      return { ...r, '低温値': acc };
    });
  } else if (mode === 'chillhours') {
    let acc = 0;
    rows = rows.map(r => {
      const temp = r['平均気温'];
      if (temp != null && temp <= chillThres) acc = round3(acc + (chillThres - temp));
      return { ...r, '低温値': acc };
    });
  }
  return rows;
}

// 日付を基準年2000に正規化（期間開始年を0とした相対年で揃える）
// 例: 期間 2025-11〜2026-04 → 2025→2000、2026→2001 とすることで年またぎも正しく並ぶ
function toRefDate(dateStr, periodStartYear) {
  const dateYear = parseInt(dateStr.slice(0, 4));
  const refYear  = 2000 + (dateYear - periodStartYear);
  return refYear + dateStr.slice(4);
}

function shiftYearBy(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setFullYear(d.getFullYear() + delta);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// 全圃場を対象に指定期間・モードで比較グラフを表示
function runPeriodAnalysis() {
  const metric     = document.querySelector('input[name="yearlyMetric"]:checked')?.value;
  const startDate  = document.getElementById('yearlyStartDate').value;
  const endDate    = document.getElementById('yearlyEndDate').value;
  const mode       = document.querySelector('input[name="yearlyMode"]:checked')?.value || 'raw';
  const chillThres = parseFloat(document.getElementById('chillThreshold').value) || 5;

  const selectedField = document.querySelector('#yearlyFieldSelect input[name="yearlyField"]:checked')?.value;
  if (!selectedField) { alert('圃場を選択してください'); return; }
  if (!metric) { alert('指標を選択してください'); return; }

  const chartMetric = (mode === 'chill' || mode === 'chillhours') ? '低温値' : metric;
  const allRows  = state.fields[selectedField] || [];
  const color    = fieldColor(selectedField);

  // 当年・前年の期間
  const prevStart = shiftYearBy(startDate, -1);
  const prevEnd   = shiftYearBy(endDate,   -1);
  const curYear        = startDate.slice(0, 4);
  const prevYear       = prevStart.slice(0, 4);
  const curStartYear   = parseInt(curYear);
  const prevStartYear  = parseInt(prevYear);

  const curRows  = buildModeRows(allRows, startDate, endDate, mode, metric, chillThres);
  const prevRows = buildModeRows(allRows, prevStart, prevEnd, mode, metric, chillThres);

  const datasets    = [];
  const summaryData = [];

  if (curRows.length) {
    datasets.push({
      label: `${curYear}年`,
      data: curRows.map(r => ({ x: toRefDate(r.日付, curStartYear), y: r[chartMetric], actualDate: r.日付 })),
      borderColor: color,
      backgroundColor: color + '22',
      borderWidth: 2.5,
      pointRadius: 0,
      pointHoverRadius: 6,
      pointHitRadius: 20,
      tension: 0.3,
      fill: false,
    });
    const vals = curRows.map(r => r[chartMetric]).filter(v => v != null);
    const summary = !vals.length ? null
      : mode !== 'raw' ? vals[vals.length - 1]
      : round3(vals.reduce((s, v) => s + v, 0) / vals.length);
    summaryData.push({ label: `${curYear}年`, color, summary, days: curRows.length, prev: false });
  }

  if (prevRows.length) {
    datasets.push({
      label: `${prevYear}年（前年）`,
      data: prevRows.map(r => ({ x: toRefDate(r.日付, prevStartYear), y: r[chartMetric], actualDate: r.日付 })),
      borderColor: color,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [6, 3],
      pointRadius: 0,
      pointHoverRadius: 6,
      pointHitRadius: 20,
      tension: 0.3,
      fill: false,
    });
    const vals = prevRows.map(r => r[chartMetric]).filter(v => v != null);
    const summary = !vals.length ? null
      : mode !== 'raw' ? vals[vals.length - 1]
      : round3(vals.reduce((s, v) => s + v, 0) / vals.length);
    summaryData.push({ label: `${prevYear}年（前年）`, color, summary, days: prevRows.length, prev: true });
  }

  if (!datasets.length) {
    document.getElementById('yearlyChartContainer').innerHTML =
      '<div class="error-card">指定期間にデータがありません</div>';
    document.getElementById('yearlyInfo').innerHTML = '';
    return;
  }

  // チャート描画
  const container = document.getElementById('yearlyChartContainer');
  container.innerHTML = '<div class="yearly-chart-wrap"><canvas id="yearlyCanvas"></canvas></div>';
  if (yearlyState.chart) { yearlyState.chart.destroy(); yearlyState.chart = null; }

  const yLabel = mode === 'chill'      ? `低温積算日数（≤${chillThres}°C）`
               : mode === 'chillhours' ? `チル時間相当（≤${chillThres}°C）`
               : mode === 'cumulative' ? `${metric}（積算）`
               : metric;

  yearlyState.chart = new Chart(
    document.getElementById('yearlyCanvas').getContext('2d'), {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            type: 'time',
            time: { unit: 'day', displayFormats: { day: 'M/d' } },
            ticks: { maxTicksLimit: 10, font: { size: 12 } },
          },
          y: {
            ticks: { font: { size: 12 } },
            title: { display: true, text: yLabel, font: { size: 11 } },
          },
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 14, font: { size: 13 } } },
          tooltip: {
            callbacks: {
              title: items => items[0]?.raw?.actualDate ?? '',
              label: c => `${c.dataset.label}: ${c.parsed.y?.toFixed(1) ?? '-'}`,
            },
          },
        },
      },
    }
  );

  // サマリータイル
  const fmt = v => v != null ? v.toFixed(1) : '—';
  const lbl = mode !== 'raw' ? '期間累計' : '期間平均';

  // 前年比の差分計算
  const curSummary  = summaryData.find(d => !d.prev)?.summary;
  const prevSummary = summaryData.find(d =>  d.prev)?.summary;
  const diff = (curSummary != null && prevSummary != null) ? round3(curSummary - prevSummary) : null;

  let infoHtml = `<div class="yearly-summary multi">`;
  for (const { label, color: c, summary, days, prev } of summaryData) {
    const borderStyle = prev ? `border-top:3px dashed ${c}` : `border-top:3px solid ${c}`;
    infoHtml += `
      <div class="yearly-tile" style="${borderStyle}">
        <div class="yearly-tile-label">${esc(label)}</div>
        <div class="yearly-tile-val">${fmt(summary)}</div>
        <div class="yearly-tile-diff diff-same">${lbl}（${days}日）</div>
      </div>`;
  }
  if (diff != null) {
    const diffClass = diff > 0 ? 'diff-up' : diff < 0 ? 'diff-down' : 'diff-same';
    const diffSign  = diff > 0 ? '+' : '';
    infoHtml += `
      <div class="yearly-tile" style="border-top:3px solid #aaa">
        <div class="yearly-tile-label">前年比</div>
        <div class="yearly-tile-val ${diffClass}">${diffSign}${fmt(diff)}</div>
        <div class="yearly-tile-diff diff-same">${curYear}年 − ${prevYear}年</div>
      </div>`;
  }
  infoHtml += `</div>`;
  document.getElementById('yearlyInfo').innerHTML = infoHtml;
}

// ============================================================
// 物候記録
// ============================================================

function renderPhenoFieldList() {
  const datalist = document.getElementById('phenoFieldList');
  const fieldNames = Object.keys(state.fields);
  datalist.innerHTML = fieldNames.map(n => `<option value="${esc(n)}">`).join('');
}

function renderPhenoList() {
  const records = loadPhenoRecords();
  const el = document.getElementById('phenoList');
  const allEntries = [];

  for (const [field, entries] of Object.entries(records)) {
    for (const e of entries) {
      allEntries.push({ field, ...e });
    }
  }

  if (allEntries.length === 0) {
    el.innerHTML = '<p class="empty-msg" style="padding:12px 4px">まだ記録がありません</p>';
    return;
  }

  allEntries.sort((a, b) =>
    a.field.localeCompare(b.field) || b.year - a.year
  );

  let html = `<div class="field-list-header" style="margin-top:12px">
    <h3>記録一覧（${allEntries.length}件）</h3>
  </div>`;

  for (const e of allEntries) {
    const id = btoa(encodeURIComponent(`${e.field}_${e.year}`));
    html += `
      <div class="pheno-record-card" data-id="${id}" data-field="${esc(e.field)}" data-year="${e.year}">
        <div class="pheno-record-header">
          <span class="pheno-field-badge">${esc(e.field)}</span>
          <span class="pheno-year">${e.year}年度</span>
          <button class="btn-delete pheno-delete-btn" data-field="${esc(e.field)}" data-year="${e.year}">削除</button>
        </div>
        <div class="pheno-dates-grid">
          <div class="pheno-date-item">
            <span class="pheno-date-label">開花日</span>
            <span class="pheno-date-val">${formatDate(e.bloomDate)}</span>
          </div>
          <div class="pheno-date-item">
            <span class="pheno-date-label">収穫開始</span>
            <span class="pheno-date-val">${formatDate(e.harvestStart)}</span>
          </div>
          <div class="pheno-date-item">
            <span class="pheno-date-label">収穫終了</span>
            <span class="pheno-date-val">${formatDate(e.harvestEnd)}</span>
          </div>
          <div class="pheno-date-item${e.leafDrop ? ' leafdrop-alert' : ''}">
            <span class="pheno-date-label">早期落葉</span>
            <span class="pheno-date-val">${e.leafDrop ? formatDate(e.leafDrop) : '—'}</span>
          </div>
        </div>
        ${e.memo ? `<div class="pheno-memo">${esc(e.memo)}</div>` : ''}
      </div>`;
  }

  el.innerHTML = html;

  el.querySelectorAll('.pheno-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.field;
      const year  = parseInt(btn.dataset.year);
      if (!confirm(`${field} の ${year}年度の記録を削除しますか？`)) return;

      const recs = loadPhenoRecords();
      if (recs[field]) {
        recs[field] = recs[field].filter(e => e.year !== year);
        if (recs[field].length === 0) delete recs[field];
      }
      savePhenoRecords(recs);
      renderPhenoList();
    });
  });
}

function handlePhenoSave() {
  const field = document.getElementById('phenoFieldName').value.trim();
  const year  = parseInt(document.getElementById('phenoYear').value);

  if (!field) { alert('圃場名を入力してください'); return; }
  if (!year || year < 2000 || year > 2035) { alert('年度を正しく入力してください'); return; }

  const entry = {
    year,
    bloomDate:    document.getElementById('phenoBloom').value       || null,
    harvestStart: document.getElementById('phenoHarvestStart').value || null,
    harvestEnd:   document.getElementById('phenoHarvestEnd').value   || null,
    leafDrop:     document.getElementById('phenoLeafDrop').value     || null,
    memo:         document.getElementById('phenoMemo').value.trim()  || null,
    updatedAt:    new Date().toISOString(),
  };

  const recs = loadPhenoRecords();
  if (!recs[field]) recs[field] = [];

  // 同じ圃場・年度の記録は上書き
  const existing = recs[field].findIndex(e => e.year === year);
  if (existing >= 0) {
    if (!confirm(`${field} の ${year}年度の記録が既にあります。上書きしますか？`)) return;
    recs[field][existing] = entry;
  } else {
    recs[field].push(entry);
  }

  savePhenoRecords(recs);

  // フォームクリア（圃場名・年度は残す）
  ['phenoBloom','phenoHarvestStart','phenoHarvestEnd','phenoLeafDrop'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('phenoMemo').value = '';

  renderPhenoList();
  alert(`${field} ${year}年度の記録を保存しました`);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const [, m, d] = dateStr.split('-');
  return `${parseInt(m)}/${parseInt(d)}`;
}

// ---- Tab Nav --------------------------------------------
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

// ---- Helpers --------------------------------------------
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderAll() {
  renderFieldList();
  renderYearlySelectors();
  renderPhenoFieldList();
  renderPhenoList();
}

// ---- Weather --------------------------------------------
function saveLocation(lat, lon) {
  try { localStorage.setItem('sansho_location', JSON.stringify({ lat, lon })); } catch (_) {}
}
function loadLocation() {
  try {
    const raw = localStorage.getItem('sansho_location');
    if (raw) {
      const { lat, lon } = JSON.parse(raw);
      document.getElementById('lat').value = lat;
      document.getElementById('lon').value = lon;
    }
  } catch (_) {}
}

async function fetchWeather() {
  const lat = parseFloat(document.getElementById('lat').value);
  const lon = parseFloat(document.getElementById('lon').value);
  const disp = document.getElementById('weatherDisplay');
  if (isNaN(lat) || isNaN(lon)) {
    disp.innerHTML = '<div class="error-card">緯度・経度を正しく入力してください</div>'; return;
  }
  saveLocation(lat, lon);
  disp.innerHTML = '<div class="loading">取得中...</div>';
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,sunshine_duration` +
      `&current=temperature_2m,relative_humidity_2m,precipitation,weather_code` +
      `&timezone=Asia%2FTokyo&forecast_days=7`;
    const data = await fetch(url).then(r => { if (!r.ok) throw new Error(); return r.json(); });
    renderWeather(data);
  } catch {
    disp.innerHTML = '<div class="error-card">気象データの取得に失敗しました。<br>インターネット接続を確認してください。</div>';
  }
}

const WX_LABEL = code =>
  code === 0 ? '快晴' : code <= 3 ? '晴れ〜曇り' : code <= 49 ? '霧' :
  code <= 69 ? '雨' : code <= 79 ? '雪' : '雷雨';

function renderWeather(d) {
  const c  = d.current;
  const dl = d.daily;
  const shine = s => s != null ? (s / 3600).toFixed(1) + 'h' : '-';

  const tAll = dl.temperature_2m_max.concat(dl.temperature_2m_min).filter(v => v != null);
  const tMin = Math.min(...tAll), tMax = Math.max(...tAll);
  const barWidth = tMax > tMin ? t =>
    Math.round(100 * (t - tMin) / (tMax - tMin)) : () => 50;

  let html = `
  <div class="weather-hero">
    <div class="weather-hero-label">現在の気温</div>
    <div class="weather-hero-temp">${c.temperature_2m?.toFixed(1) ?? '-'}°C</div>
    <div class="weather-hero-sub">${WX_LABEL(c.weather_code ?? 0)} | 湿度 ${c.relative_humidity_2m ?? '-'}% | 降水 ${c.precipitation ?? 0}mm</div>
  </div>
  <div class="weather-grid">
    <div class="weather-tile">
      <div class="weather-tile-label">本日最高</div>
      <div class="weather-tile-val" style="color:#e53935">${dl.temperature_2m_max[0]?.toFixed(1) ?? '-'}</div>
      <div class="weather-tile-unit">°C</div>
    </div>
    <div class="weather-tile">
      <div class="weather-tile-label">本日最低</div>
      <div class="weather-tile-val" style="color:#1976d2">${dl.temperature_2m_min[0]?.toFixed(1) ?? '-'}</div>
      <div class="weather-tile-unit">°C</div>
    </div>
    <div class="weather-tile">
      <div class="weather-tile-label">降水量</div>
      <div class="weather-tile-val" style="color:#1976d2">${dl.precipitation_sum[0]?.toFixed(1) ?? '-'}</div>
      <div class="weather-tile-unit">mm</div>
    </div>
    <div class="weather-tile">
      <div class="weather-tile-label">日照時間</div>
      <div class="weather-tile-val" style="color:#FF9800">${shine(dl.sunshine_duration[0])}</div>
      <div class="weather-tile-unit">h</div>
    </div>
  </div>
  <div class="forecast-card">
    <h3>7日間予報</h3>`;

  for (let i = 0; i < 7; i++) {
    const dt   = new Date(dl.time[i]);
    const day  = i === 0 ? '今日' : i === 1 ? '明日' : `${dt.getMonth()+1}/${dt.getDate()}`;
    const tmax = dl.temperature_2m_max[i]?.toFixed(1) ?? '-';
    const tmin = dl.temperature_2m_min[i]?.toFixed(1) ?? '-';
    const rain = dl.precipitation_sum[i]?.toFixed(1) ?? '-';
    const w1 = barWidth(parseFloat(tmin) || tMin);
    const w2 = barWidth(parseFloat(tmax) || tMax);
    html += `<div class="forecast-row">
      <span class="forecast-date">${day}</span>
      <span class="forecast-min">${tmin}°</span>
      <div class="forecast-bar"><div class="forecast-bar-inner" style="margin-left:${w1}%;width:${w2-w1}%"></div></div>
      <span class="forecast-max">${tmax}°</span>
      <span class="forecast-rain">&#127783; ${rain}mm</span>
    </div>`;
  }
  html += '</div>';
  document.getElementById('weatherDisplay').innerHTML = html;
}

// ---- Soil Analysis --------------------------------------
const SOIL_CHART_PARAMS = [
  { key: '窒素',        unit: 'mg/100g' },
  { key: 'りん酸',      unit: 'mg/100g' },
  { key: '加里',        unit: 'mg/100g' },
  { key: '石灰',        unit: 'mg/100g' },
  { key: '苦土',        unit: 'mg/100g' },
  { key: '石灰/苦土比', unit: 'meq/meq' },
  { key: '苦土/加里比', unit: 'meq/meq' },
];
const SOIL_COLORS = [
  '#e53935','#1976D2','#43A047','#F57C00',
  '#8E24AA','#00897B','#3949AB','#E91E63',
];

let remoteSoilEntries = [];
let soilChart = null;
let soilSelectedField = null;
let configUsers = {}; // initAuth で設定

async function loadSoilData() {
  try {
    const res = await fetch('./data/soil_analysis.json', { cache: 'no-cache' });
    if (res.ok) remoteSoilEntries = (await res.json()).entries ?? [];
  } catch (_) {}
}

const LOCAL_SOIL_KEY = 'sansho_soil_local';
function loadLocalSoilEntries() {
  try { return JSON.parse(localStorage.getItem(LOCAL_SOIL_KEY) ?? '[]'); } catch (_) { return []; }
}
function saveLocalSoilEntries(entries) {
  try { localStorage.setItem(LOCAL_SOIL_KEY, JSON.stringify(entries)); } catch (_) {}
}

function getVisibleSoilEntries() {
  const local = authState.isAdmin ? loadLocalSoilEntries() : [];
  return [...remoteSoilEntries, ...local]
    .filter(e => authState.isAdmin || e.user === authState.userKey)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 3ゾーン正規化: 0-1=低, 1-2=基準内, 2-3=高
function soilScore(val, refMin, refMax) {
  if (val === null || refMin === null || refMax === null || refMin >= refMax) return null;
  if (val <= 0) return 0;
  if (val <= refMin) return +(val / refMin).toFixed(3);
  if (val <= refMax) return +(1 + (val - refMin) / (refMax - refMin)).toFixed(3);
  return Math.min(+(2 + (val - refMax) / refMax).toFixed(3), 3.0);
}

function renderSoilUI() {
  const visible = getVisibleSoilEntries();
  const fieldCard = document.getElementById('soilFieldCard');
  const dateCard  = document.getElementById('soilDateCard');

  if (authState.isAdmin) {
    // 圃場ボタン
    const fields = [...new Set(visible.map(e => e.field))];
    fieldCard.style.display = fields.length ? '' : 'none';
    document.getElementById('soilFieldBtns').innerHTML = fields.map(f => `
      <button class="weather-field-btn ${soilSelectedField === f ? 'active' : ''}"
              data-field="${f}">${f}</button>`).join('');
    document.getElementById('soilFieldBtns').querySelectorAll('.weather-field-btn')
      .forEach(btn => btn.addEventListener('click', () => {
        soilSelectedField = btn.dataset.field;
        renderSoilUI();
      }));

    if (soilSelectedField) {
      const fieldEntries = visible.filter(e => e.field === soilSelectedField);
      renderSoilDateList(fieldEntries);
    } else {
      dateCard.style.display = 'none';
      document.getElementById('soilChartCard').style.display = 'none';
    }
  } else {
    // 農家モード: 圃場固定
    fieldCard.style.display = 'none';
    if (!visible.length) {
      dateCard.style.display = 'none';
      document.getElementById('soilChartCard').style.display = 'none';
      return;
    }
    renderSoilDateList(visible);
  }
}

function renderSoilDateList(entries) {
  const dateCard = document.getElementById('soilDateCard');
  const dateList = document.getElementById('soilDateList');
  if (!entries.length) { dateCard.style.display = 'none'; return; }
  dateCard.style.display = '';

  dateList.innerHTML = entries.map((e, i) => `
    <label class="soil-date-row">
      <input type="checkbox" class="soil-date-cb" data-idx="${i}">
      <span class="soil-date-dot" style="background:${SOIL_COLORS[i % SOIL_COLORS.length]}"></span>
      <span class="soil-date-text">${e.date}${e.isLocal ? ' <span class="soil-local-badge">ローカル</span>' : ''}</span>
      ${e.isLocal ? `<button class="soil-date-del btn-delete" data-id="${esc(e.id)}" title="削除">✕</button>` : ''}
      <span class="soil-date-check">✓</span>
    </label>`).join('');

  function updateChart() {
    const checked = [...dateList.querySelectorAll('.soil-date-cb:checked')];
    const selectedEntries = checked.map(c => entries[parseInt(c.dataset.idx)]);
    if (selectedEntries.length) {
      renderSoilChart(selectedEntries, entries);
    } else {
      document.getElementById('soilChartCard').style.display = 'none';
      document.getElementById('soilValTable').innerHTML = '';
      if (soilChart) { soilChart.destroy(); soilChart = null; }
    }
  }

  dateList.querySelectorAll('.soil-date-cb').forEach(cb =>
    cb.addEventListener('change', updateChart)
  );

  // ローカルエントリ削除
  dateList.querySelectorAll('.soil-date-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      if (!confirm('このデータを削除しますか？')) return;
      const local = loadLocalSoilEntries().filter(x => x.id !== btn.dataset.id);
      saveLocalSoilEntries(local);
      renderSoilUI();
    });
  });

  document.getElementById('soilChartCard').style.display = 'none';
  document.getElementById('soilValTable').innerHTML = '';
  if (soilChart) { soilChart.destroy(); soilChart = null; }
}

function renderSoilChart(selected, allEntries) {
  const card = document.getElementById('soilChartCard');
  if (!selected.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  if (soilChart) { soilChart.destroy(); soilChart = null; }

  // 基準ゾーン帯（下限=1, 上限=2）
  const zoneRef = {
    label: '基準範囲',
    data: SOIL_CHART_PARAMS.map(() => 2),
    borderColor: 'rgba(76,175,80,0.45)',
    backgroundColor: 'rgba(76,175,80,0.12)',
    borderWidth: 1.5,
    borderDash: [5, 4],
    pointRadius: 0,
    order: 99,
  };
  const zoneLow = {
    label: '_low',
    data: SOIL_CHART_PARAMS.map(() => 1),
    borderColor: 'rgba(76,175,80,0.45)',
    backgroundColor: 'rgba(76,175,80,0.12)',
    borderWidth: 1.5,
    borderDash: [5, 4],
    pointRadius: 0,
    order: 98,
  };

  const datasets = selected.map(entry => {
    const colorIdx = allEntries.findIndex(e => e.id === entry.id);
    const color = SOIL_COLORS[colorIdx % SOIL_COLORS.length];
    const data = SOIL_CHART_PARAMS.map(p => {
      const v = entry.values[p.key];
      return v ? soilScore(v.val, v.refMin, v.refMax) : null;
    });
    return {
      label: entry.date,
      data,
      borderColor: color,
      backgroundColor: color + '30',
      borderWidth: 2.5,
      pointBackgroundColor: color,
      pointRadius: 5,
      pointHoverRadius: 7,
    };
  });

  soilChart = new Chart(document.getElementById('soilChart'), {
    type: 'radar',
    data: {
      labels: SOIL_CHART_PARAMS.map(p => p.key),
      datasets: [...datasets, zoneLow, zoneRef],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        r: {
          min: 0, max: 3,
          ticks: {
            stepSize: 1,
            callback: v => ({ 0: '', 1: '基準下限', 2: '基準上限', 3: '↑高' }[v] ?? ''),
            font: { size: 9 },
            backdropColor: 'transparent',
          },
          pointLabels: { font: { size: 12, weight: '700' } },
          grid: { color: ctx => ctx.index === 1 || ctx.index === 2
            ? 'rgba(76,175,80,0.5)' : 'rgba(0,0,0,0.07)' },
        },
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            filter: item => !item.text.startsWith('_') && item.text !== '基準範囲',
            boxWidth: 14, font: { size: 13 }, padding: 12,
          },
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.dataset.label.startsWith('_') || ctx.dataset.label === '基準範囲') return null;
              const entry = selected[ctx.datasetIndex];
              const p = SOIL_CHART_PARAMS[ctx.dataIndex];
              const v = entry?.values[p.key];
              if (!v || v.val === null) return `${p.key}: データなし`;
              const r = ctx.parsed.r;
              const zone = r < 1 ? '低' : r <= 2 ? '基準内' : '高';
              const ref = v.refMin !== null ? `基準 ${v.refMin}〜${v.refMax}` : '';
              return `${p.key}: ${v.val} ${p.unit}（${zone}）${ref ? '  ' + ref : ''}`;
            },
          },
        },
      },
    },
  });

  // ---- 数値テーブル ----
  const ZONE_META = {
    '低':   { cls: 'soil-zone-low',  label: '低↓' },
    '基準内': { cls: 'soil-zone-ok',   label: '基準内' },
    '高':   { cls: 'soil-zone-high', label: '高↑' },
  };

  let tableHtml = '';
  for (const entry of selected) {
    const colorIdx = allEntries.findIndex(e => e.id === entry.id);
    const color = SOIL_COLORS[colorIdx % SOIL_COLORS.length];

    tableHtml += `
      <div class="soil-val-header">
        <span class="soil-val-dot" style="background:${color}"></span>
        <span class="soil-val-date">${entry.date}</span>
        ${entry.field ? `<span class="soil-val-field">${esc(entry.field)}</span>` : ''}
      </div>
      <div class="soil-val-table-wrap">
        <table class="soil-val-table">
          <thead>
            <tr>
              <th>成分</th>
              <th>測定値</th>
              <th>基準値</th>
              <th>判定</th>
            </tr>
          </thead>
          <tbody>`;

    for (const p of SOIL_CHART_PARAMS) {
      const v = entry.values[p.key];
      if (!v) continue;
      const score = soilScore(v.val, v.refMin, v.refMax);
      const zoneName = score === null ? null : score < 1 ? '低' : score <= 2 ? '基準内' : '高';
      const zm = zoneName ? ZONE_META[zoneName] : null;
      const refText = (v.refMin !== null && v.refMax !== null)
        ? `${v.refMin}〜${v.refMax}`
        : '—';

      tableHtml += `
            <tr>
              <td class="soil-vt-name">${esc(p.key)}<span class="soil-vt-unit"> ${p.unit}</span></td>
              <td class="soil-vt-val">${v.val}</td>
              <td class="soil-vt-ref">${refText}</td>
              <td>${zm ? `<span class="soil-zone-badge ${zm.cls}">${zm.label}</span>` : '—'}</td>
            </tr>`;
    }

    tableHtml += `
          </tbody>
        </table>
      </div>`;
  }

  document.getElementById('soilValTable').innerHTML = tableHtml;
}

// ---- Soil Admin Form (管理者のみ) -----------------------
function initSoilAdminForm() {
  const section = document.getElementById('tab-soil');

  // 担当農家セレクト
  const userOpts = Object.entries(configUsers)
    .map(([k, u]) => `<option value="${esc(k)}">${esc(u.name)}</option>`)
    .join('');

  // パラメータ行
  const paramRows = SOIL_CHART_PARAMS.map((p, idx) => `
    <tr>
      <td class="soil-param-name">${esc(p.key)}<br><span class="soil-unit">${p.unit}</span></td>
      <td><input type="number" class="soil-inp soil-add-val" data-idx="${idx}" step="any" placeholder="—"></td>
      <td><input type="number" class="soil-inp soil-add-min" data-idx="${idx}" step="any" placeholder="—"></td>
      <td><input type="number" class="soil-inp soil-add-max" data-idx="${idx}" step="any" placeholder="—"></td>
    </tr>`).join('');

  section.insertAdjacentHTML('afterbegin', `
    <div class="card" id="soilAddCard">
      <span class="card-label">分析データを追加</span>
      <div class="soil-meta-row" style="margin-bottom:10px">
        <div class="soil-meta-item">
          <label class="soil-meta-label">測定日</label>
          <input type="date" id="soilAddDate">
        </div>
        <div class="soil-meta-item">
          <label class="soil-meta-label">担当農家</label>
          <select id="soilAddUser" class="soil-add-select">${userOpts}</select>
        </div>
      </div>
      <div class="soil-meta-item" style="margin-bottom:12px">
        <label class="soil-meta-label">圃場名</label>
        <input type="text" id="soilAddField" list="soilAddFieldList"
               placeholder="圃場名を入力または選択" class="soil-add-field-input">
        <datalist id="soilAddFieldList"></datalist>
      </div>
      <div class="soil-table-wrap">
        <table class="soil-table">
          <thead>
            <tr><th>成分</th><th>測定値</th><th>基準 最小</th><th>基準 最大</th></tr>
          </thead>
          <tbody>${paramRows}</tbody>
        </table>
      </div>
      <button class="btn-primary" id="soilAddBtn" style="margin-top:12px">追加</button>
    </div>`);

  function updateFieldList() {
    const userKey = document.getElementById('soilAddUser').value;
    const fields  = configUsers[userKey]?.fields ?? [];
    document.getElementById('soilAddFieldList').innerHTML =
      fields.map(f => `<option value="${esc(f)}">`).join('');
    document.getElementById('soilAddField').value = fields[0] ?? '';
  }

  document.getElementById('soilAddUser').addEventListener('change', updateFieldList);
  updateFieldList(); // 初期値

  document.getElementById('soilAddBtn').addEventListener('click', handleSoilAdd);
}

function handleSoilAdd() {
  const date  = document.getElementById('soilAddDate').value;
  const user  = document.getElementById('soilAddUser').value;
  const field = document.getElementById('soilAddField').value.trim();

  if (!date)  { alert('測定日を入力してください'); return; }
  if (!field) { alert('圃場名を入力してください'); return; }

  const values = {};
  let hasAny = false;
  SOIL_CHART_PARAMS.forEach((p, idx) => {
    const vEl = document.querySelector(`.soil-add-val[data-idx="${idx}"]`);
    const nEl = document.querySelector(`.soil-add-min[data-idx="${idx}"]`);
    const xEl = document.querySelector(`.soil-add-max[data-idx="${idx}"]`);
    const val = vEl?.value !== '' ? parseFloat(vEl.value) : null;
    const min = nEl?.value !== '' ? parseFloat(nEl.value) : null;
    const max = xEl?.value !== '' ? parseFloat(xEl.value) : null;
    if (val !== null) hasAny = true;
    values[p.key] = { val, refMin: min, refMax: max };
  });

  if (!hasAny) { alert('少なくとも1つの測定値を入力してください'); return; }

  const entry = {
    id: `local-${Date.now()}`,
    date, field, user,
    isLocal: true,
    values,
  };

  const local = loadLocalSoilEntries();
  local.push(entry);
  saveLocalSoilEntries(local);

  // 測定値のみリセット（日付・農家・圃場は保持）
  document.querySelectorAll('#soilAddCard .soil-inp').forEach(el => { el.value = ''; });

  renderSoilUI();
  alert(`${field}（${date}）の土壌データを追加しました`);
}

// ---- Auto Fetch -----------------------------------------
async function loadAutoData() {
  const statusEl = document.getElementById('autoFetchStatus');
  statusEl.className = 'auto-status loading';
  statusEl.textContent = '取得中...';

  try {
    const res = await fetch('./data/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('まだデータが用意されていません');
    const manifest = await res.json();

    const updated = manifest.updated
      ? new Date(manifest.updated).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
      : '-';

    // 管理者モードは毎回クリーンな状態から全圃場を読み込む
    if (authState.isAdmin) state.fields = {};

    let loaded = 0;
    for (const field of manifest.fields || []) {
      // ユーザーモード：許可圃場のみ読み込む
      if (!authState.isAdmin && authState.allowedFields &&
          !authState.allowedFields.includes(field.name)) continue;
      try {
        const csvRes = await fetch(`./data/${field.file}`, { cache: 'no-cache' });
        if (!csvRes.ok) continue;
        const buf = await csvRes.arrayBuffer();
        let text = '';
        for (const enc of ['shift-jis', 'utf-8-sig', 'utf-8']) {
          try {
            const decoded = new TextDecoder(enc).decode(buf);
            if (/気温|年|日付/.test(decoded)) { text = decoded; break; }
          } catch (_) {}
        }
        if (!text) text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        const { summary } = await parseCSVText(text, field.name);
        if (summary.length > 0) {
          state.fields[field.name] = summary;
          loaded++;
        }
      } catch (e) { console.warn(field.name, e); }
    }

    if (authState.isAdmin) saveFields(); // ユーザーモードでは他農家のデータを上書きしない
    renderAll();

    statusEl.className = 'auto-status ok';
    statusEl.textContent = `✓ ${loaded}件取得済み（最終更新: ${updated}）`;
  } catch (e) {
    statusEl.className = 'auto-status err';
    statusEl.textContent = `✗ ${e.message}`;
  }
}

// ---- Init -----------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  loadFields();
  initTabs();

  // 認証（ユーザーモードの場合はPIN入力を待つ）
  await initAuth();

  // セッション有効期限の定期チェック（1分ごと）
  const _authKey = authState.isAdmin ? 'admin' : authState.userKey;
  if (_authKey) {
    setInterval(() => {
      if (!isAuthValid(_authKey)) location.reload();
    }, 60_000);
  }

  // ユーザーモードの場合、許可圃場以外をstateから除去
  if (!authState.isAdmin && authState.allowedFields) {
    for (const name of Object.keys(state.fields)) {
      if (!authState.allowedFields.includes(name)) delete state.fields[name];
    }
  }

  renderAll();
  loadAutoData();

  document.getElementById('autoFetchBtn').addEventListener('click', loadAutoData);

  const csvInput = document.getElementById('csvInput');
  csvInput.addEventListener('change', e => { handleFiles(e.target.files); csvInput.value = ''; });

  // 比較タブ
  const _today2 = new Date();
  const _fmt2 = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const _sixMonthsAgo = new Date(_today2); _sixMonthsAgo.setMonth(_sixMonthsAgo.getMonth() - 6);
  document.getElementById('yearlyStartDate').value = _fmt2(_sixMonthsAgo);
  document.getElementById('yearlyEndDate').value   = _fmt2(_today2);

  document.getElementById('yearlyAnalyzeBtn').addEventListener('click', runPeriodAnalysis);

  // 低温閾値の変更を"チル時間"ラベルに反映
  document.getElementById('chillThreshold').addEventListener('input', e => {
    document.getElementById('chillHoursThresholdDisplay').textContent = e.target.value;
  });

  // 物候記録
  document.getElementById('phenoSaveBtn').addEventListener('click', handlePhenoSave);

  // 土壌分析
  await loadSoilData();
  if (authState.isAdmin) initSoilAdminForm();
  renderSoilUI();

  // 気象情報
  if (!authState.isAdmin && authState.fieldLat != null) {
    // 農家モード: 圃場座標で自動取得、入力フォームを非表示
    document.querySelector('#tab-weather .card').style.display = 'none';
    document.getElementById('lat').value = authState.fieldLat;
    document.getElementById('lon').value = authState.fieldLon;
    fetchWeather();
  } else if (authState.isAdmin && authState.adminFields.length) {
    // 管理者モード: 圃場選択ボタンを挿入
    const fieldBtnHtml = `
      <div class="card" id="weatherFieldCard">
        <span class="card-label">圃場を選択</span>
        <div class="weather-field-btns">${authState.adminFields.map(f => `
          <button class="weather-field-btn" data-lat="${f.lat}" data-lon="${f.lon}">${f.name}</button>`).join('')}
        </div>
      </div>`;
    document.getElementById('tab-weather').insertAdjacentHTML('afterbegin', fieldBtnHtml);
    document.getElementById('weatherFieldCard').addEventListener('click', e => {
      const btn = e.target.closest('.weather-field-btn');
      if (!btn) return;
      document.querySelectorAll('.weather-field-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('lat').value = btn.dataset.lat;
      document.getElementById('lon').value = btn.dataset.lon;
      fetchWeather();
    });
    loadLocation();
  } else {
    loadLocation();
  }
  document.getElementById('fetchWeatherBtn').addEventListener('click', fetchWeather);
  document.getElementById('geoBtn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      alert('このブラウザは位置情報に対応していません'); return;
    }
    const btn = document.getElementById('geoBtn');
    btn.textContent = '取得中...';
    btn.disabled = true;
    const disp = document.getElementById('weatherDisplay');
    disp.innerHTML = '<div class="loading">📍 位置情報を取得中...<br><small style="color:#888">ブラウザから許可を求めるダイアログが表示されたら「許可」を選択してください</small></div>';
    navigator.geolocation.getCurrentPosition(
      pos => {
        const lat = Math.round(pos.coords.latitude  * 10000) / 10000;
        const lon = Math.round(pos.coords.longitude * 10000) / 10000;
        document.getElementById('lat').value = lat;
        document.getElementById('lon').value = lon;
        saveLocation(lat, lon);
        btn.textContent = '🌍 現在地を使用';
        btn.disabled = false;
        fetchWeather();
      },
      err => {
        const msg = {
          1: '位置情報の許可が拒否されています。\nブラウザの設定 → サイトの設定 → 位置情報 を「許可」にしてください。',
          2: '位置情報を取得できませんでした（電波・GPS不良）。',
          3: '位置情報の取得がタイムアウトしました。再度お試しください。',
        }[err.code] ?? `エラー: ${err.message}`;
        document.getElementById('weatherDisplay').innerHTML = `<div class="error-card">${msg}</div>`;
        btn.textContent = '🌍 現在地を使用';
        btn.disabled = false;
      },
      { timeout: 15000, enableHighAccuracy: false }
    );
  });
});
