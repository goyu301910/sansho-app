// ============================================================
// 山椒 圃場モニター - app.js
// ============================================================

// ---- 定数 -----------------------------------------------
const FIELD_COLORS = [
  '#2196F3','#FF5722','#4CAF50','#9C27B0',
  '#FF9800','#795548','#E91E63','#00BCD4',
  '#CDDC39','#3F51B5','#009688','#F44336',
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
  fields: {},           // fieldName -> DailyRow[]
  charts: [],           // Chart instances (for destroy)
  currentChartIdx: 0,   // 現在表示中のグラフ番号
  currentMetrics: [],   // 現在表示中の指標リスト
};

// ---- Storage ---------------------------------------------
function saveFields() {
  try { localStorage.setItem('sansho_fields', JSON.stringify(state.fields)); } catch (_) {}
}
function loadFields() {
  try {
    const raw = localStorage.getItem('sansho_fields');
    if (raw) state.fields = JSON.parse(raw);
  } catch (_) { state.fields = {}; }
}

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

    // 積算は日平均の累計（Pythonのrecompute_cumulativeと同等）
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
  const hasDate     = headers.includes('日付');
  const hasMetrics  = ALL_METRICS.some(m => headers.includes(m));
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
  return new Promise((resolve, reject) => {
    Papa.parse(text, {
      header: true, skipEmptyLines: true,
      complete(res) {
        const headers = res.meta.fields || [];
        const fieldName = file.name.replace(/\.csv$/i, '');
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

    // 線形補間
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
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
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
    html += `<div class="field-card">
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

  const container = document.getElementById('chartsContainer');
  container.innerHTML = '';

  for (const metric of metrics) {
    const block = document.createElement('div');
    block.className = 'chart-block';
    block.innerHTML = `<canvas></canvas>`;
    container.appendChild(block);

    const canvas = block.querySelector('canvas');
    const datasets = Object.entries(fieldMap).map(([name, rows]) => {
      const color = fieldColor(name);
      return {
        label: name,
        data: rows.map(r => ({ x: r.日付, y: r[metric] })),
        borderColor: color,
        backgroundColor: color + '22',
        borderWidth: 2,
        pointRadius: 2,
        tension: 0.15,
        fill: false,
      };
    });

    const chart = new Chart(canvas.getContext('2d'), {
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
            ticks: { maxTicksLimit: 8, font: { size: 12 } },
          },
          y: { ticks: { font: { size: 12 } } },
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 14, font: { size: 13 } } },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y ?? '-'}` } },
        },
      },
    });
    state.charts.push(chart);
  }

  // 最初のグラフを表示
  updateChartView();

  // ナビゲーターを更新
  const dotsEl = document.getElementById('chartNavDots');
  dotsEl.innerHTML = metrics.map((_, i) =>
    `<div class="chart-dot${i === 0 ? ' active' : ''}" data-idx="${i}"></div>`
  ).join('');
  dotsEl.querySelectorAll('.chart-dot').forEach(dot => {
    dot.addEventListener('click', () => navigateChart(parseInt(dot.dataset.idx) - state.currentChartIdx));
  });

  document.getElementById('chartNav').style.display = 'flex';

  // スワイプ対応
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

  // グラフをリサイズ（非表示→表示切替後に必要）
  state.charts[idx]?.resize();
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

  // 期間フィルタ
  let fieldMap = {};
  for (const name of fieldNames) {
    const rows = filterPeriod(state.fields[name] || [], startDate, endDate);
    if (rows.length > 0) fieldMap[name] = rows;
  }
  if (Object.keys(fieldMap).length === 0) {
    alert('指定期間にデータがありません');
    return;
  }

  // 日付整合
  fieldMap = alignMode === 'interpolate'
    ? alignInterpolate(fieldMap)
    : alignCommon(fieldMap);

  if (Object.keys(fieldMap).every(k => fieldMap[k].length === 0)) {
    alert('日付整合後に比較可能なデータがありません');
    return;
  }

  // 累積再計算
  fieldMap = recomputeCumulative(fieldMap);

  // 描画
  renderCharts(fieldMap, metrics);
  renderPreview(fieldMap, metrics, () => downloadCSV(fieldMap, metrics));

  // 設定パネルを折りたたみ、サマリー表示
  document.getElementById('settingsPanel').style.display = 'none';
  const summary = document.getElementById('settingsSummary');
  summary.style.display = 'flex';
  const periodText = (startDate && endDate) ? `${startDate} 〜 ${endDate}` : '全期間';
  document.getElementById('settingsSummaryText').textContent =
    `${periodText} | ${fieldNames.length}圃場 | ${metrics.length}指標`;

  // チャートナビへスクロール
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

  saveFields(); renderAll();

  let html = '';
  if (ok.length) html += `<div class="status-msg status-ok">✓ ${ok.join('、')} を読み込みました</div>`;
  ng.forEach(m => { html += `<div class="status-msg status-err">✗ ${esc(m)}</div>`; });
  status.innerHTML = html;
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
  renderFieldCheckboxes();
  renderMetricCheckboxes();
}

// ---- Weather --------------------------------------------
async function fetchWeather() {
  const lat = parseFloat(document.getElementById('lat').value);
  const lon = parseFloat(document.getElementById('lon').value);
  const disp = document.getElementById('weatherDisplay');
  if (isNaN(lat) || isNaN(lon)) {
    disp.innerHTML = '<div class="error-card">緯度・経度を正しく入力してください</div>'; return;
  }
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
  const barWidth = tMax > tMin ? (t, ref) =>
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

// ---- Auto Fetch (GitHub Pages data/ folder) -------------
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

    let loaded = 0;
    for (const field of manifest.fields || []) {
      try {
        const csvRes = await fetch(`./data/${field.file}`, { cache: 'no-cache' });
        if (!csvRes.ok) continue;
        // Shift-JIS対応：ArrayBufferで受け取りデコード
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

    saveFields();
    renderAll();

    statusEl.className = 'auto-status ok';
    statusEl.textContent = `✓ ${loaded}件取得済み（最終更新: ${updated}）`;
  } catch (e) {
    statusEl.className = 'auto-status err';
    statusEl.textContent = `✗ ${e.message}`;
  }
}

// テキストから直接パース（autoFetch用）
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

// ---- Init -----------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  loadFields();
  initTabs();
  renderAll();

  // 起動時に自動取得データの状態を確認
  fetch('./data/manifest.json', { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : null)
    .then(manifest => {
      if (!manifest) return;
      const statusEl = document.getElementById('autoFetchStatus');
      const updated = manifest.updated
        ? new Date(manifest.updated).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
        : '-';
      statusEl.className = 'auto-status ok';
      statusEl.textContent = `データあり（最終更新: ${updated}）`;
    })
    .catch(() => {});

  document.getElementById('autoFetchBtn').addEventListener('click', loadAutoData);

  const csvInput = document.getElementById('csvInput');
  csvInput.addEventListener('change', e => { handleFiles(e.target.files); csvInput.value = ''; });

  document.getElementById('analyzeBtn').addEventListener('click', () => {
    if (Object.keys(state.fields).length === 0) { alert('まずCSVファイルを読み込んでください'); return; }
    runAnalysis();
  });

  document.getElementById('checkAllMetrics').addEventListener('click', () =>
    document.querySelectorAll('#metricCheckboxes input').forEach(c => c.checked = true));
  document.getElementById('uncheckAllMetrics').addEventListener('click', () =>
    document.querySelectorAll('#metricCheckboxes input').forEach(c => c.checked = false));

  document.getElementById('fetchWeatherBtn').addEventListener('click', fetchWeather);

  document.getElementById('prevChartBtn').addEventListener('click', () => navigateChart(-1));
  document.getElementById('nextChartBtn').addEventListener('click', () => navigateChart(1));

  document.getElementById('changeSettingsBtn').addEventListener('click', () => {
    document.getElementById('settingsPanel').style.display = 'block';
    document.getElementById('settingsSummary').style.display = 'none';
    document.getElementById('chartNav').style.display = 'none';
    document.getElementById('chartsContainer').innerHTML = '';
    document.getElementById('previewSection').innerHTML = '';
    state.charts.forEach(c => c.destroy());
    state.charts = [];
    state.currentMetrics = [];
    document.getElementById('settingsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
