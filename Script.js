/* script.js
  Responsibilities:
  - Parse CSV (PapaParse) and Excel (SheetJS)
  - Persist dataset to localStorage (key: dashboardData)
  - Auto-update Dashboard charts, KPIs and table
  - Provide download/export and UX controls
*/

/* ---------- Utilities ---------- */
const STORAGE_KEY = 'dashboardData_v1';

// quick helpers
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const isDateString = s => {
  if (!s) return false;
  const d = Date.parse(s);
  return !Number.isNaN(d);
};

// parse uploaded file
async function parseFile(file) {
  return new Promise((resolve, reject) => {
    const name = file.name.toLowerCase();
    if (name.endsWith('.csv')) {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          resolve(results.data);
        },
        error: (err) => reject(err)
      });
    } else if (name.endsWith('.xls') || name.endsWith('.xlsx')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheet];
        const json = XLSX.utils.sheet_to_json(worksheet, { defval: null });
        resolve(json);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    } else {
      reject(new Error('Unsupported file type'));
    }
  });
}

/* ---------- Persistence ---------- */
function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}
function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch(e) { return null; }
}
function clearDataStorage() {
  localStorage.removeItem(STORAGE_KEY);
  // reload page to reflect cleared state
  location.reload();
}

/* ---------- Data helpers ---------- */
function detectColumns(rows) {
  if (!rows || rows.length === 0) return { dateCols:[], numCols:[], strCols:[] };
  const sample = rows.slice(0, Math.min(rows.length, 30));
  const keys = Object.keys(sample[0]);

  const dateCols = [], numCols = [], strCols = [];
  keys.forEach(k => {
    let dateCount=0, numCount=0, strCount=0;
    sample.forEach(r => {
      const v = r[k];
      if (v === null || v === undefined || v === '') return;
      if (isDateString(v)) dateCount++;
      else if (!isNaN(Number(v))) numCount++;
      else strCount++;
    });
    if (dateCount >= Math.max(1, sample.length*0.3)) dateCols.push(k);
    else if (numCount >= Math.max(1, sample.length*0.3)) numCols.push(k);
    else strCols.push(k);
  });

  return { dateCols, numCols, strCols, allCols: keys };
}

/* ---------- Chart management ---------- */
let lineChart = null;
let barChart = null;

function destroyCharts() {
  if (lineChart) { lineChart.destroy(); lineChart = null; }
  if (barChart) { barChart.destroy(); barChart = null; }
}

/* group by month/year */
function groupByMonth(rows, dateKey, valueKey) {
  const map = new Map();
  rows.forEach(r => {
    const d = new Date(r[dateKey]);
    if (isNaN(d)) return;
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const val = Number(r[valueKey]) || 0;
    map.set(key, (map.get(key)||0) + val);
  });
  // sort keys ascending
  const entries = Array.from(map.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
  return { labels: entries.map(e=>e[0]), values: entries.map(e=>e[1]) };
}

/* top categories */
function categoryCounts(rows, catKey) {
  const map = new Map();
  rows.forEach(r => {
    const v = r[catKey] ?? '—';
    map.set(v, (map.get(v)||0)+1);
  });
  const entries = Array.from(map.entries()).sort((a,b)=>b[1]-a[1]);
  const top = entries.slice(0,12);
  return { labels: top.map(e=>e[0]), values: top.map(e=>e[1]) };
}

/* ---------- UI renderers ---------- */
function populateSelect(selector, columns, selected=null) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.innerHTML = '';
  const optEmpty = document.createElement('option');
  optEmpty.value = '';
  optEmpty.textContent = columns.length? '— select —' : 'No columns';
  el.appendChild(optEmpty);
  columns.forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    if (selected && selected === c) o.selected = true;
    el.appendChild(o);
  });
}

/* render table (first N rows) */
function renderTable(rows, maxRows=25) {
  const head = $('#tableHead');
  const body = $('#tableBody');
  head.innerHTML = ''; body.innerHTML = '';
  if (!rows || rows.length === 0) {
    head.innerHTML = '<tr><th>No data</th></tr>';
    return;
  }
  const cols = Object.keys(rows[0]);
  // header
  const trh = document.createElement('tr');
  cols.forEach(c => {
    const th = document.createElement('th'); th.textContent = c; trh.appendChild(th);
  });
  head.appendChild(trh);
  // body
  rows.slice(0, maxRows).forEach(r => {
    const tr = document.createElement('tr');
    cols.forEach(c => {
      const td = document.createElement('td'); td.textContent = r[c] ?? ''; tr.appendChild(td);
    });
    body.appendChild(tr);
  });
}

/* generate CSV from rows */
function rowsToCsv(rows) {
  if (!rows || rows.length===0) return '';
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(',')];
  rows.forEach(r => {
    const row = cols.map(c => {
      let v = r[c];
      if (v === null || v === undefined) return '';
      if (typeof v === 'string' && (v.includes(',') || v.includes('"') || v.includes('\n'))) {
        return `"${v.replace(/"/g,'""')}"`;
      }
      return v;
    });
    lines.push(row.join(','));
  });
  return lines.join('\n');
}

/* ---------- Main update function used by Dashboard & Reports ---------- */
function updateVisuals(rows) {
  // rows: array of objects
  destroyCharts();
  if (!rows || rows.length === 0) {
    // clear KPIs & table
    $('#kpi-count') && ($('#kpi-count').textContent = '0');
    $('#kpi-sum') && ($('#kpi-sum').textContent = '—');
    $('#kpi-avg') && ($('#kpi-avg').textContent = '—');
    $('#kpi-date') && ($('#kpi-date').textContent = '—');
    renderTable([], 0);
    // Reports summary text
    const rep = $('#reportsSummary'); if (rep) rep.innerHTML = 'No data uploaded.';
    return;
  }

  const cols = detectColumns(rows);
  // auto-choose columns
  const dateCol = cols.dateCols[0] || '';
  const numCol = cols.numCols[0] || cols.allCols.find(c => typeof rows[0][c] === 'number') || '';
  const catCol = cols.strCols[0] || cols.allCols.find(c => typeof rows[0][c] === 'string') || '';

  // KPIs
  $('#kpi-count') && ($('#kpi-count').textContent = String(rows.length));
  if (numCol) {
    const sum = rows.reduce((s,r)=>s + (Number(r[numCol]) || 0), 0);
    const avg = (sum / rows.length) || 0;
    $('#kpi-sum') && ($('#kpi-sum').textContent = sum.toLocaleString());
    $('#kpi-avg') && ($('#kpi-avg').textContent = avg.toFixed(2));
  } else {
    $('#kpi-sum') && ($('#kpi-sum').textContent = 'N/A');
    $('#kpi-avg') && ($('#kpi-avg').textContent = 'N/A');
  }
  $('#kpi-date') && ($('#kpi-date').textContent = dateCol || 'No date');

  // populate selects (if present)
  populateSelect('#dateColumnSelect', cols.dateCols, dateCol);
  populateSelect('#valueColumnSelect', cols.numCols.length ? cols.numCols : cols.allCols, numCol);
  populateSelect('#categoryColumnSelect', cols.strCols.length ? cols.strCols : cols.allCols, catCol);

  // line chart - if date col exists
  const lineCtxEl = document.getElementById('lineChart');
  if (dateCol && (document.getElementById('valueColumnSelect').value || numCol)) {
    const chosenValue = document.getElementById('valueColumnSelect').value || numCol;
    const grouped = groupByMonth(rows, dateCol, chosenValue);
    const labels = grouped.labels;
    const values = grouped.values;
    lineChart = new Chart(lineCtxEl, {
      type: 'line',
      data: { labels, datasets: [{ label: chosenValue, data: values, fill: true, tension:0.3 }] },
      options: { responsive:true, plugins:{legend:{display:false}} }
    });
  } else {
    // fallback: plot first numeric column across row index
    const fallbackNum = numCol;
    const labels = rows.map((r,i)=>String(i+1)).slice(0,200);
    const values = rows.map(r=>Number(r[fallbackNum])||0).slice(0,200);
    lineChart = new Chart(lineCtxEl, {
      type:'line',
      data:{ labels, datasets:[{ label: fallbackNum || 'Values', data: values, tension:0.3 }]},
      options:{ responsive:true, plugins:{legend:{display:false}}}
    });
  }

  // bar chart - category breakdown
  const barCtxEl = document.getElementById('barChart');
  const catChosen = document.getElementById('categoryColumnSelect').value || catCol;
  if (catChosen) {
    const grouped = categoryCounts(rows, catChosen);
    barChart = new Chart(barCtxEl, {
      type:'bar',
      data:{ labels: grouped.labels, datasets:[{ label:'Count', data: grouped.values }]},
      options:{ responsive:true, plugins:{legend:{display:false}}}
    });
  } else {
    // fallback: no categories
    barChart = new Chart(barCtxEl, {
      type:'bar',
      data:{ labels:['No category'], datasets:[{ label:'Count', data:[0] }]},
      options:{ responsive:true, plugins:{legend:{display:false}}}
    });
  }

  // render table
  const rowsToShow = Number($('#rowsSelect') ? $('#rowsSelect').value : 25);
  renderTable(rows, rowsToShow);

  // reports summary
  const rep = $('#reportsSummary');
  if (rep) {
    const summaryHtml = `
      <p><strong>Rows:</strong> ${rows.length}</p>
      <p><strong>Columns:</strong> ${cols.allCols.length} (${cols.allCols.join(', ')})</p>
      <p><strong>Detected date columns:</strong> ${cols.dateCols.join(', ') || 'None'}</p>
      <p><strong>Detected numeric columns:</strong> ${cols.numCols.join(', ') || 'None'}</p>
      <p><strong>Detected string columns:</strong> ${cols.strCols.join(', ') || 'None'}</p>
    `;
    rep.innerHTML = summaryHtml;
  }
}

/* ---------- Page actions ---------- */
function initDashboardPage() {
  const rows = loadData();
  updateVisuals(rows);

  // controls
  $('#rowsSelect') && $('#rowsSelect').addEventListener('change', ()=> {
    const rowsCount = Number($('#rowsSelect').value);
    const data = loadData() || [];
    renderTable(data, rowsCount);
  });

  $('#downloadCsv') && $('#downloadCsv').addEventListener('click', ()=> {
    const data = loadData() || [];
    const csv = rowsToCsv(data);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'export.csv'; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });

  // select change -> update charts (when user picks different columns)
  ['#dateColumnSelect','#valueColumnSelect','#categoryColumnSelect'].forEach(sel=>{
    const el = document.querySelector(sel);
    if (el) el.addEventListener('change', ()=> {
      const data = loadData() || [];
      updateVisuals(data);
    });
  });

  // search filter on table (simple)
  if ($('#globalSearch')) {
    $('#globalSearch').addEventListener('input', (e)=>{
      const q = e.target.value.trim().toLowerCase();
      const all = loadData() || [];
      if (!q) { renderTable(all, Number($('#rowsSelect').value || 25)); return; }
      const filtered = all.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(q)));
      renderTable(filtered, Number($('#rowsSelect').value || 25));
    });
  }

  // clear stored data button
  $('#clearDataBtn') && $('#clearDataBtn').addEventListener('click', ()=> {
    if (!confirm('Clear stored dataset?')) return;
    clearDataStorage();
  });
}

function initReportsPage() {
  const data = loadData() || [];
  updateVisuals(data); // will update reportsSummary
  $('#exportCsvBtn') && $('#exportCsvBtn').addEventListener('click', ()=> {
    const csv = rowsToCsv(loadData() || []);
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'export.csv'; document.body.appendChild(a); a.click(); a.remove();
  });
}

function initUploadPage() {
  const fileInput = $('#fileInput');
  const uploadBtn = $('#uploadBtn');
  const previewBtn = $('#previewBtn');
  const clearBtn = $('#clearStorage');
  const status = $('#uploadStatus');
  const previewCard = $('#previewCard');
  const previewTableHead = $('#previewTable thead');
  const previewTableBody = $('#previewTable tbody');

  let parsedPreview = null;

  fileInput && fileInput.addEventListener('change', (e)=>{
    const f = e.target.files[0];
    status.textContent = f ? `Selected: ${f.name}` : 'No file selected.';
  });

  previewBtn && previewBtn.addEventListener('click', async ()=>{
    const f = fileInput.files && fileInput.files[0];
    if (!f) { alert('Select a file first'); return; }
    try {
      const rows = await parseFile(f);
      parsedPreview = rows;
      previewCard.style.display = 'block';
      // render preview (first 50)
      const cols = rows.length ? Object.keys(rows[0]) : [];
      previewTableHead.innerHTML = ''; previewTableBody.innerHTML = '';
      const tr = document.createElement('tr'); cols.forEach(c=> { const th=document.createElement('th'); th.textContent=c; tr.appendChild(th); }); previewTableHead.appendChild(tr);
      rows.slice(0,50).forEach(r => {
        const t = document.createElement('tr');
        cols.forEach(c => { const td=document.createElement('td'); td.textContent = r[c] ?? ''; t.appendChild(td); });
        previewTableBody.appendChild(t);
      });
    } catch(err) {
      alert('Failed to parse: ' + err.message);
    }
  });

  uploadBtn && uploadBtn.addEventListener('click', async ()=>{
    const f = fileInput.files && fileInput.files[0];
    if (!f) { alert('Select a file first'); return; }
    status.textContent = `Parsing ${f.name}...`;
    try {
      const rows = await parseFile(f);
      saveData(rows);
      status.textContent = `Parsed & saved ${rows.length} rows.`;
      // navigate to dashboard to view
      setTimeout(()=> location.href = 'index.html', 700);
    } catch(err) {
      status.textContent = 'Error parsing file';
      alert('Parse error: ' + err.message);
    }
  });

  clearBtn && clearBtn.addEventListener('click', ()=> {
    if (!confirm('Clear stored parsed data?')) return;
    clearDataStorage();
  });
}

/* ---------- Common UI features ---------- */
function initCommon() {
  // theme toggle (persist)
  const themeToggle = $('#themeToggle');
  const themeToggleSetting = $('#themeToggleSetting');
  const collapsedKey = 'sidebarCollapsed';

  const applyTheme = (dark) => {
    if (dark) document.documentElement.style.setProperty('--bg','#041226');
    // just toggling body class for future expansion
    document.body.classList.toggle('light', !dark);
  };

  const savedTheme = localStorage.getItem('uiTheme') || 'dark';
  applyTheme(savedTheme === 'dark');

  if (themeToggle) themeToggle.addEventListener('click', ()=> {
    const cur = localStorage.getItem('uiTheme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    localStorage.setItem('uiTheme', next);
    applyTheme(next === 'dark');
  });
  if (themeToggleSetting) {
    themeToggleSetting.checked = (localStorage.getItem('uiTheme') || 'dark') === 'dark';
    themeToggleSetting.addEventListener('change', (e)=>{
      const next = e.target.checked ? 'dark' : 'light';
      localStorage.setItem('uiTheme', next);
      applyTheme(next === 'dark');
    });
  }

  // sidebar collapse
  const collapseBtn = $('#collapseBtn');
  const sidebar = $('#sidebar');
  if (collapseBtn && sidebar) {
    const collapsed = localStorage.getItem(collapsedKey) === 'true';
    if (collapsed) sidebar.style.width = '72px';
    collapseBtn.addEventListener('click', ()=>{
      const isCollapsed = sidebar.style.width === '72px';
      sidebar.style.width = isCollapsed ? '260px' : '72px';
      localStorage.setItem(collapsedKey, !isCollapsed);
    });
  }

  // initialize page-specific logic
  const page = location.pathname.split('/').pop();
  if (page === '' || page === 'index.html') initDashboardPage();
  else if (page === 'reports.html') initReportsPage();
  else if (page === 'upload.html') initUploadPage();
  else {
    // other pages may still benefit from updateVisuals for summary
    const dt = loadData() || [];
    updateVisuals(dt);
  }
}

/* ---------- Run on load ---------- */
document.addEventListener('DOMContentLoaded', ()=> {
  try { initCommon(); } catch(e) { console.error(e); }
});