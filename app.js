/**
 * KAKEIBO Dashboard - メインロジック
 * 家計簿ダッシュボードアプリケーションの業務ロジック
 */

// ========================================
// ユーティリティ関数
// ========================================

/**
 * 数値をカンマ区切りの文字列にフォーマット
 * @param {number} n - フォーマットする数値
 * @returns {string} カンマ区切りの文字列
 */
const F = n => `${Number(n).toLocaleString()}`;

/**
 * 数値を円記号付きでフォーマット
 * @param {number} n - フォーマットする数値
 * @returns {string} "¥1,000" 形式の文字列
 */
const FY = n => `¥${F(n)}`;

/**
 * HTMLエスケープ（XSS対策）
 * @param {string} str - エスケープする文字列
 * @returns {string} エスケープ済み文字列
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * トースト通知を表示
 * @param {string} msg - 表示するメッセージ
 * @param {number} duration - 表示時間（ミリ秒、デフォルト: 2500）
 */
function toast(msg, duration = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

// ========================================
// Firebase 初期化
// ========================================

let useFirestore = false;
let firestore = null;
let firebaseAuth = null;
let currentUser = null;

function initFirebase() {
  if (typeof FIREBASE_CONFIG !== 'undefined' && FIREBASE_CONFIG.apiKey) {
    firebase.initializeApp(FIREBASE_CONFIG);
    firestore = firebase.firestore();
    firebaseAuth = firebase.auth();
    firestore.enablePersistence({ synchronizeTabs: true }).catch(err => {
      console.warn('Firestore persistence:', err.code);
    });
    useFirestore = true;
    return true;
  }
  return false;
}

function fsPath(col) {
  return `users/${currentUser.uid}/${col}`;
}

function monthToDocId(m) { return m.replace(/\//g, '-'); }

// ========================================
// データベース操作（IndexedDB / Firestore デュアルモード）
// ========================================

const DB_NAME = 'kakeibo';
const DB_VER = 2;
let db = null;

/**
 * IndexedDBを開いて初期化
 * @returns {Promise<IDBDatabase>} データベースインスタンス
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    // データベースのバージョンアップ時の処理
    req.onupgradeneeded = e => {
      const d = e.target.result;

      // 月次データストア
      if (!d.objectStoreNames.contains('months')) {
        d.createObjectStore('months', { keyPath: 'month' });
      }

      // 取引明細ストア
      if (!d.objectStoreNames.contains('transactions')) {
        const s = d.createObjectStore('transactions', {
          keyPath: 'id',
          autoIncrement: true
        });
        s.createIndex('month', 'month');
        s.createIndex('monthCat', 'monthCat');
      }

      // 設定ストア
      if (!d.objectStoreNames.contains('config')) {
        d.createObjectStore('config', { keyPath: 'key' });
      }
    };

    req.onsuccess = e => {
      db = e.target.result;
      resolve(db);
    };
    req.onerror = e => reject(e);
  });
}

/**
 * データを保存（Firestore / IndexedDB デュアルモード）
 */
async function dbPut(store, data) {
  if (useFirestore && currentUser) {
    const col = fsPath(store);
    let docId;
    if (store === 'months') docId = monthToDocId(data.month);
    else if (store === 'config') docId = data.key;
    else {
      await firestore.collection(col).add(data);
      return;
    }
    await firestore.collection(col).doc(docId).set(data);
    return;
  }
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(data);
    tx.oncomplete = () => res();
    tx.onerror = e => rej(e);
  });
}

/**
 * ストアの全データを取得
 */
async function dbGetAll(store) {
  if (useFirestore && currentUser) {
    const snap = await firestore.collection(fsPath(store)).get();
    return snap.docs.map(d => d.data());
  }
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = e => rej(e);
  });
}

/**
 * キーを指定してデータを取得
 */
async function dbGet(store, key) {
  if (useFirestore && currentUser) {
    let docId = key;
    if (store === 'months') docId = monthToDocId(key);
    const doc = await firestore.collection(fsPath(store)).doc(docId).get();
    return doc.exists ? doc.data() : undefined;
  }
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => res(req.result);
    req.onerror = e => rej(e);
  });
}

/**
 * インデックスを使用してデータを取得
 */
async function dbGetByIndex(store, idx, val) {
  if (useFirestore && currentUser) {
    const snap = await firestore.collection(fsPath(store)).where(idx, '==', val).get();
    return snap.docs.map(d => d.data());
  }
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).index(idx).getAll(val);
    req.onsuccess = () => res(req.result);
    req.onerror = e => rej(e);
  });
}

/**
 * ストアの全データを削除
 */
async function dbClear(store) {
  if (useFirestore && currentUser) {
    const snap = await firestore.collection(fsPath(store)).get();
    const BS = 450;
    for (let i = 0; i < snap.docs.length; i += BS) {
      const batch = firestore.batch();
      snap.docs.slice(i, i + BS).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    return;
  }
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => res();
    tx.onerror = e => rej(e);
  });
}

/**
 * キーを指定してデータを削除
 */
async function dbDelete(store, key) {
  if (useFirestore && currentUser) {
    let docId = key;
    if (store === 'months') docId = monthToDocId(key);
    await firestore.collection(fsPath(store)).doc(docId).delete();
    return;
  }
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = e => rej(e);
  });
}

/**
 * 指定月の全取引データを削除
 */
async function dbDeleteByMonth(month) {
  if (useFirestore && currentUser) {
    const snap = await firestore.collection(fsPath('transactions')).where('month', '==', month).get();
    const BS = 450;
    for (let i = 0; i < snap.docs.length; i += BS) {
      const batch = firestore.batch();
      snap.docs.slice(i, i + BS).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction('transactions', 'readwrite');
    const idx = tx.objectStore('transactions').index('month');
    const req = idx.openCursor(IDBKeyRange.only(month));
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e);
  });
}

/**
 * Firestore バッチ書き込みヘルパー（500件制限対応）
 */
async function fsBatchWrite(colPath, items) {
  const BS = 450;
  for (let i = 0; i < items.length; i += BS) {
    const batch = firestore.batch();
    items.slice(i, i + BS).forEach(item => {
      batch.set(firestore.collection(colPath).doc(), item);
    });
    await batch.commit();
  }
}

// ========================================
// 設定管理
// ========================================

/** 予算設定 {費目: 金額} */
let BUDGETS = {};

/** 固定費カテゴリのSet */
let FIXED_CATS = new Set(["住宅", "保険", "通信費", "教養・教育"]);

/** 現在のテーマ（"dark" | "light"） */
let currentTheme = 'dark';

/** 現在のフォントスケール */
let currentFontScale = 1.15;

/** フォントサイズ選択肢 */
const FONT_SIZES = [
  { key: 'small', label: '小', scale: 1.0 },
  { key: 'medium', label: '中', scale: 1.15 },
  { key: 'large', label: '大', scale: 1.3 }
];

/**
 * 設定をIndexedDBから読み込み
 */
async function loadConfig() {
  const b = await dbGet('config', 'budgets');
  if (b) BUDGETS = b.value;

  const f = await dbGet('config', 'fixed');
  if (f) FIXED_CATS = new Set(f.value);

  // テーマ設定読み込み
  const t = await dbGet('config', 'theme');
  if (t) {
    currentTheme = t.value;
    if (currentTheme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }

  // フォントサイズ読み込み
  const fs = await dbGet('config', 'fontSize');
  if (fs) {
    currentFontScale = fs.value;
    document.documentElement.style.setProperty('--font-scale', fs.value);
  }
}

/**
 * 設定をIndexedDBに保存
 */
async function saveConfig() {
  await dbPut('config', { key: 'budgets', value: BUDGETS });
  await dbPut('config', { key: 'fixed', value: [...FIXED_CATS] });
}

/**
 * テーマを設定（dark / light）
 * @param {string} theme - "dark" or "light"
 */
async function setTheme(theme) {
  currentTheme = theme;
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  await dbPut('config', { key: 'theme', value: theme });
}

/**
 * フォントスケールを設定
 * @param {number} scale - スケール値（0.85, 1.0, 1.15）
 */
async function setFontScale(scale) {
  currentFontScale = scale;
  document.documentElement.style.setProperty('--font-scale', scale);
  await dbPut('config', { key: 'fontSize', value: scale });
}

// ========================================
// 状態管理
// ========================================

/** ソート済みの月キー配列 ["2024/01", "2024/02", ...] */
let allMonths = [];

/** 現在選択中の月 */
let selectedMonth = '';

/** 現在選択中の年（トレンド表示用） */
let selectedYear = null;

/** 期間指定モード（true: 対象月連動12ヶ月, false: 年単位1〜12月） */
let periodMode = false;

/**
 * 月次サマリーデータ
 * @type {Object.<string, {income: number, expenses: Object, points: number, incomeDetail: Object, sankeyFlows: Array, nodeColumn: Object}>}
 */
let monthSummaries = {};

/**
 * 全月のデータをIndexedDBから読み込み
 */
async function loadAllMonths() {
  const data = await dbGetAll('months');
  monthSummaries = {};
  data.forEach(d => monthSummaries[d.month] = d);
  allMonths = Object.keys(monthSummaries).sort();

  // 選択月が未設定または存在しない場合は最新月を選択
  if (allMonths.length && (!selectedMonth || !allMonths.includes(selectedMonth))) {
    selectedMonth = allMonths[allMonths.length - 1];
  }

  // 選択年が未設定の場合は最新年を選択
  if (allMonths.length && !selectedYear) {
    selectedYear = allMonths[allMonths.length - 1].split('/')[0];
  }

  updateDBInfo();
}

/**
 * 現在の月データを取得（デフォルト値付き）
 * @returns {Object} 月次データ
 */
function cd() {
  return monthSummaries[selectedMonth] || {
    income: 0,
    expenses: {},
    points: 0,
    incomeDetail: {},
    sankeyFlows: [],
    nodeColumn: {}
  };
}

/**
 * データベース情報表示を更新
 */
function updateDBInfo() {
  document.getElementById('dbInfo').textContent = `データ: ${allMonths.length}ヶ月分`;
}

// ========================================
// サイドバー折りたたみ
// ========================================

/**
 * サイドバーの折りたたみ/展開を切り替え
 */
function toggleSidebar() {
  document.querySelector('.app').classList.toggle('sb-collapsed');
}

/**
 * モバイルメニューの開閉を切り替え
 */
function toggleMobileMenu() {
  document.querySelector('.sb').classList.toggle('mob-open');
  document.getElementById('sbOverlay').classList.toggle('show');
}

/**
 * モバイルメニューを閉じる
 */
function closeMobileMenu() {
  document.querySelector('.sb').classList.remove('mob-open');
  document.getElementById('sbOverlay').classList.remove('show');
}

// ========================================
// ナビゲーション制御
// ========================================

/**
 * ビュー切り替えイベントリスナーを設定
 */
document.querySelectorAll('.nav-i[data-view]').forEach(el => {
  el.addEventListener('click', () => {
    // アクティブ状態を更新
    document.querySelectorAll('.nav-i').forEach(n => n.classList.remove('active'));
    el.classList.add('active');

    // ビューを切り替え
    document.querySelectorAll('.vw').forEach(v => v.classList.remove('active'));
    document.getElementById('vw-' + el.dataset.view).classList.add('active');

    // タイトル更新
    const titles = {
      dashboard: 'ダッシュボード',
      sankey: 'お金の流れ',
      trend: 'トレンド分析',
      settings: '設定'
    };
    document.getElementById('viewTitle').textContent = titles[el.dataset.view];

    // モバイルメニューを閉じる
    closeMobileMenu();

    // ビュー固有の描画処理
    if (el.dataset.view === 'sankey') renderSankey();
    if (el.dataset.view === 'trend') {
      renderFV();
      renderSav();
    }
    if (el.dataset.view === 'settings') renderSettings();
  });
});

/**
 * 月ナビゲーション（カレンダーピッカー）を更新
 */
function renderMonthNav() {
  const picker = document.getElementById('monthPicker');
  if (!picker) return;
  if (selectedMonth) {
    picker.value = selectedMonth.replace('/', '-');
  }
  if (allMonths.length) {
    picker.min = allMonths[0].replace('/', '-');
    picker.max = allMonths[allMonths.length - 1].replace('/', '-');
  }
}

/**
 * カレンダーピッカーの値変更時
 * @param {string} val - "YYYY-MM" 形式
 */
function pickMonth(val) {
  if (!val) return;
  selMonth(val.replace('-', '/'));
}

/**
 * 前月/次月に移動
 * @param {number} delta - 移動量（-1:前月, 1:次月）
 */
function changeMonth(delta) {
  if (!selectedMonth) return;
  const [y, m] = selectedMonth.split('/').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  const newMonth = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (allMonths.length) {
    if (newMonth < allMonths[0] || newMonth > allMonths[allMonths.length - 1]) return;
  }
  selMonth(newMonth);
}

/**
 * 月を選択
 * @param {string} m - 月キー（例: "2024/01"）
 */
function selMonth(m) {
  selectedMonth = m;
  renderAll();
}

// ========================================
// KPI カード描画
// ========================================

/**
 * KPIカードを描画
 */
function renderKPI() {
  const d = cd();
  const te = Object.values(d.expenses || {}).reduce((a, b) => a + b, 0); // 総支出
  const bal = d.income - te; // 残高
  const sr = d.income > 0 ? Math.round(bal / d.income * 100) : 0; // 貯蓄率
  const ft = Object.entries(d.expenses || {})
    .filter(([k]) => FIXED_CATS.has(k))
    .reduce((s, [, v]) => s + v, 0); // 固定費合計

  document.getElementById('kpiRow').innerHTML = `
    <div class="kpi"><div class="kpi-ic">💵</div><div class="kpi-lb">収入</div><div class="kpi-vl" style="color:var(--gn)">${F(d.income)}</div><div class="kpi-sub">ポイント除く</div></div>
    <div class="kpi"><div class="kpi-ic">🛒</div><div class="kpi-lb">支出</div><div class="kpi-vl" style="color:var(--rd)">${F(te)}</div><div class="kpi-sub">固定${F(ft)} / 変動${F(te - ft)}</div></div>
    <div class="kpi"><div class="kpi-ic">💰</div><div class="kpi-lb">残高</div><div class="kpi-vl" style="color:${bal >= 0 ? 'var(--bl)' : 'var(--rd)'}">${bal < 0 ? '−' : ''}${F(Math.abs(bal))}</div></div>
    <div class="kpi"><div class="kpi-ic">🎯</div><div class="kpi-lb">貯蓄率</div><div class="kpi-vl" style="color:var(--pp)">${sr}%</div></div>
    <div class="kpi"><div class="kpi-ic">🏷️</div><div class="kpi-lb">ポイント</div><div class="kpi-vl" style="color:var(--am)">${F(d.points || 0)}</div></div>`;
}

// ========================================
// 収入パネル描画
// ========================================

/**
 * 収入内訳パネルを描画
 */
function renderIncome() {
  const d = cd();
  const det = d.incomeDetail || {};
  const total = Object.values(det).reduce((a, b) => a + b, 0);

  let h = '';
  Object.entries(det).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0';
    h += `<div class="inc-rw"><span class="c" style="color:var(--t2)">${escapeHtml(k)}</span><span class="n" style="color:var(--gn)">${F(v)}</span><span class="n" style="color:var(--t3)">${pct}%</span></div><div class="inc-bar"><div class="inc-bar-f" style="width:${total > 0 ? v / total * 100 : 0}%"></div></div>`;
  });
  h += `<div class="inc-rw" style="font-weight:700;border-top:1.5px solid var(--bd);padding-top:4px;margin-top:4px"><span>合計</span><span class="n" style="color:var(--gn)">${F(total)}</span><span></span></div>`;
  document.getElementById('incPanel').innerHTML = h;
}

// ========================================
// 支出パネル描画（明細モーダル連携）
// ========================================

/**
 * 支出内訳パネルを描画
 */
function renderExpense() {
  const d = cd();
  const exp = d.expenses || {};
  const entries = Object.entries(exp).sort((a, b) => b[1] - a[1]);

  // 固定費と変動費に分類
  const fixedE = entries.filter(([k]) => FIXED_CATS.has(k));
  const varE = entries.filter(([k]) => !FIXED_CATS.has(k));

  /**
   * 費目行のHTMLを生成
   */
  const makeRows = arr => arr.map(([k, v]) => {
    const b = BUDGETS[k] || 0;
    const diff = b - v;
    return `<div class="exp-rw" onclick="showDetail('${escapeHtml(k)}')"><span class="c">${escapeHtml(k)} 🔍</span><span class="n">${b ? F(b) : '—'}</span><span class="n" style="color:var(--tx)">${F(v)}</span><span class="${diff >= 0 ? 'dp' : 'dn'}">${diff >= 0 ? '+' : ''}${F(diff)}</span></div>`;
  }).join('');

  const fT = fixedE.reduce((s, [, v]) => s + v, 0); // 固定費合計
  const vT = varE.reduce((s, [, v]) => s + v, 0); // 変動費合計

  document.getElementById('expPanel').innerHTML = `
    <div class="exp-hd"><span>費目</span><span style="text-align:right">予算</span><span style="text-align:right">実績</span><span style="text-align:right">差額</span></div>
    <div class="exp-sec-h" style="margin-top:6px"><div class="sq" style="background:var(--am)"></div>固定費</div>${makeRows(fixedE)}
    <div class="exp-rw exp-tot"><span>小計</span><span></span><span class="n" style="color:var(--am)">${F(fT)}</span><span></span></div>
    <div class="exp-sec-h" style="margin-top:8px"><div class="sq" style="background:var(--rd)"></div>変動費</div>${makeRows(varE)}
    <div class="exp-rw exp-tot"><span>小計</span><span></span><span class="n" style="color:var(--rd)">${F(vT)}</span><span></span></div>`;
}

// ========================================
// 明細モーダル
// ========================================

/**
 * カテゴリの明細モーダルを表示
 * @param {string} cat - カテゴリ名
 */
async function showDetail(cat) {
  const txns = await dbGetByIndex('transactions', 'monthCat', `${selectedMonth}|||${cat}`);
  document.getElementById('modalTitle').textContent = `${cat} — ${selectedMonth} 明細`;

  const total = txns.reduce((s, t) => s + Math.abs(t.amount), 0);

  let h = `<div class="detail-row header"><span>日付</span><span>内容</span><span style="text-align:right">金額</span><span>金融機関</span></div>`;
  txns.sort((a, b) => a.date.localeCompare(b.date)).forEach(t => {
    h += `<div class="detail-row"><span>${escapeHtml(t.date.replace(/^\d{4}\//, ''))}</span><span>${escapeHtml(t.content)}</span><span class="amt" style="color:var(--rd)">${F(Math.abs(t.amount))}</span><span class="acct">${escapeHtml(t.account)}</span></div>`;
  });
  h += `<div class="detail-total"><span>${txns.length}件</span><span style="color:var(--rd)">${FY(total)}</span></div>`;

  if (!txns.length) {
    h = '<p style="color:var(--t3);font-size:14px;padding:20px;text-align:center">明細データがありません<br><small>CSVを再取込すると表示されます</small></p>';
  }

  document.getElementById('modalBody').innerHTML = h;
  document.getElementById('modalBg').classList.add('show');
}

/**
 * 明細モーダルを閉じる
 */
function closeModal() {
  document.getElementById('modalBg').classList.remove('show');
}

/**
 * 収入カテゴリの明細モーダルを表示
 * @param {string} dk - 収入内訳キー（例: "給与（三井住友銀行）"）
 */
async function showIncomeDetail(dk) {
  const txns = await dbGetByIndex('transactions', 'monthCat', `${selectedMonth}|||income|||${dk}`);
  document.getElementById('modalTitle').textContent = `${dk} — ${selectedMonth} 明細`;

  if (!txns.length) {
    document.getElementById('modalBody').innerHTML = '<p style="color:var(--t3);font-size:14px;padding:20px;text-align:center">明細データがありません<br><small>CSVを再取込すると表示されます</small></p>';
    document.getElementById('modalBg').classList.add('show');
    return;
  }

  const total = txns.reduce((s, t) => s + t.amount, 0);
  let h = `<div class="detail-row header"><span>日付</span><span>内容</span><span style="text-align:right">金額</span><span>金融機関</span></div>`;
  txns.sort((a, b) => a.date.localeCompare(b.date)).forEach(t => {
    h += `<div class="detail-row"><span>${escapeHtml(t.date.replace(/^\d{4}\//, ''))}</span><span>${escapeHtml(t.content)}</span><span class="amt" style="color:var(--gn)">${F(t.amount)}</span><span class="acct">${escapeHtml(t.account)}</span></div>`;
  });
  h += `<div class="detail-total"><span>${txns.length}件</span><span style="color:var(--gn)">${FY(total)}</span></div>`;

  document.getElementById('modalBody').innerHTML = h;
  document.getElementById('modalBg').classList.add('show');
}

/**
 * 金融機関の明細モーダルを表示（収入＋支出）
 * @param {string} acc - 金融機関名
 */
async function showInstitutionDetail(acc) {
  const allTxns = await dbGetByIndex('transactions', 'month', selectedMonth);
  const txns = allTxns.filter(t => t.account === acc);
  document.getElementById('modalTitle').textContent = `${acc} — ${selectedMonth} 明細`;

  if (!txns.length) {
    document.getElementById('modalBody').innerHTML = '<p style="color:var(--t3);font-size:14px;padding:20px;text-align:center">明細データがありません<br><small>CSVを再取込すると表示されます</small></p>';
    document.getElementById('modalBg').classList.add('show');
    return;
  }

  const incomeTxns = txns.filter(t => t.category === 'income');
  const expenseTxns = txns.filter(t => t.category !== 'income');

  let h = `<div class="detail-row header"><span>日付</span><span>内容</span><span style="text-align:right">金額</span><span>カテゴリ</span></div>`;

  if (incomeTxns.length) {
    h += `<div style="font-size:12px;font-weight:700;padding:6px 0 2px;color:var(--gn)">収入</div>`;
    incomeTxns.sort((a, b) => a.date.localeCompare(b.date)).forEach(t => {
      h += `<div class="detail-row"><span>${escapeHtml(t.date.replace(/^\d{4}\//, ''))}</span><span>${escapeHtml(t.content)}</span><span class="amt" style="color:var(--gn)">${F(t.amount)}</span><span class="acct">${escapeHtml(t.subcategory)}</span></div>`;
    });
  }
  if (expenseTxns.length) {
    h += `<div style="font-size:12px;font-weight:700;padding:6px 0 2px;color:var(--rd)">支出</div>`;
    expenseTxns.sort((a, b) => a.date.localeCompare(b.date)).forEach(t => {
      h += `<div class="detail-row"><span>${escapeHtml(t.date.replace(/^\d{4}\//, ''))}</span><span>${escapeHtml(t.content)}</span><span class="amt" style="color:var(--rd)">${F(Math.abs(t.amount))}</span><span class="acct">${escapeHtml(t.category)}</span></div>`;
    });
  }

  const incTotal = incomeTxns.reduce((s, t) => s + t.amount, 0);
  const expTotal = expenseTxns.reduce((s, t) => s + Math.abs(t.amount), 0);
  h += `<div class="detail-total"><span>${txns.length}件</span><span><span style="color:var(--gn)">${FY(incTotal)}</span> / <span style="color:var(--rd)">${FY(expTotal)}</span></span></div>`;

  document.getElementById('modalBody').innerHTML = h;
  document.getElementById('modalBg').classList.add('show');
}

// ========================================
// 対象月選択モーダル
// ========================================

/** 一時保存：CSVファイル */
let pendingFile = null;

/** 一時保存：CSVテキスト */
let pendingFileText = null;

/**
 * 対象月選択モーダルを表示
 * @param {File} file - CSVファイル
 * @param {string} text - CSVテキスト
 * @param {string} detectedMonth - 検出された対象月（YYYY-MM形式）
 */
function showTargetMonthModal(file, text, detectedMonth) {
  pendingFile = file;
  pendingFileText = text;
  document.getElementById('importFileName').textContent = file.name;
  document.getElementById('targetMonthInput').value = detectedMonth;
  document.getElementById('targetMonthModal').classList.add('show');
}

/**
 * 対象月選択モーダルを閉じる
 */
function closeTargetMonthModal() {
  document.getElementById('targetMonthModal').classList.remove('show');
  pendingFile = null;
  pendingFileText = null;
}

/**
 * 対象月を確定してCSVをインポート
 */
async function confirmTargetMonth() {
  const inputEl = document.getElementById('targetMonthInput');
  if (!inputEl) {
    console.error('対象月入力フィールドが見つかりません');
    toast('⚠️ システムエラー：入力フィールドが見つかりません');
    return;
  }

  const targetMonth = inputEl.value;
  if (!targetMonth) {
    toast('⚠️ 対象年月を選択してください');
    return;
  }

  if (!pendingFileText || !pendingFile) {
    console.error('ファイルデータが見つかりません。pendingFileText:', pendingFileText, 'pendingFile:', pendingFile);
    toast('⚠️ ファイルデータが見つかりません');
    return;
  }

  // 月キーに変換してデータ存在チェック
  const mk = targetMonth.includes('-') ? targetMonth.replace(/-/g, '/') : targetMonth;

  if (monthSummaries[mk]) {
    const ok = confirm(`既に${mk}のデータがあります。上書きしますか？\n\n既存の明細データは削除されます。`);
    if (!ok) return;
    // 既存データを削除
    await dbDeleteByMonth(mk);
    await dbDelete('months', mk);
  }

  // モーダルを閉じる前にローカル変数に保存
  const fileText = pendingFileText;
  const fileName = pendingFile.name;

  closeTargetMonthModal();

  try {
    await parseMF(fileText, fileName, targetMonth);
  } catch (e) {
    console.error('CSV解析エラー:', e);
    toast('⚠️ CSV解析エラー: ' + (e.message || '不明なエラー'), 8000);
  }
}

// ========================================
// 12ヶ月レンジ・トレンドグラフ描画
// ========================================

/**
 * 選択月を最後として過去12ヶ月の配列を取得
 * @returns {string[]} 月キーの配列（古い順）
 */
function getMonthRange() {
  if (!selectedMonth) return [];
  const [y, m] = selectedMonth.split('/').map(Number);
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(y, m - 1 - i, 1);
    months.push(`${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

/**
 * データが存在する年の一覧を取得
 * @returns {string[]} 年の配列（ソート済み）
 */
function getAvailableYears() {
  return [...new Set(allMonths.map(m => m.split('/')[0]))].sort();
}

/**
 * トレンドグラフ・年間テーブル用の月レンジを取得
 * periodMode=true: 選択月を基準に過去12ヶ月
 * periodMode=false: 選択年の1〜12月
 * @returns {string[]} 月キーの配列
 */
function getTrendMonthRange() {
  if (periodMode) {
    return getMonthRange();
  }
  if (!selectedYear) return [];
  const months = [];
  for (let m = 1; m <= 12; m++) {
    months.push(`${selectedYear}/${String(m).padStart(2, '0')}`);
  }
  return months;
}

// ========================================
// グラフ軸ユーティリティ
// ========================================

/**
 * きりの良い軸目盛りを計算
 * @param {number} minVal - データの最小値
 * @param {number} maxVal - データの最大値
 * @param {number} targetTicks - 目標目盛り数
 * @returns {{min: number, max: number, step: number}} 軸設定
 */
function calcNiceAxis(minVal, maxVal, targetTicks = 5) {
  minVal = Math.min(minVal, 0);
  maxVal = Math.max(maxVal, 0);
  const range = maxVal - minVal || 100000;

  // きりの良い目盛り間隔を計算
  const rawStep = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let niceStep;
  if (norm <= 1) niceStep = mag;
  else if (norm <= 2) niceStep = 2 * mag;
  else if (norm <= 5) niceStep = 5 * mag;
  else niceStep = 10 * mag;

  const niceMin = Math.floor(minVal / niceStep) * niceStep;
  const niceMax = Math.ceil(maxVal / niceStep) * niceStep;

  return { min: niceMin, max: niceMax, step: niceStep };
}

/**
 * 軸ラベルをフォーマット（万単位表示）
 * @param {number} v - 値
 * @returns {string} フォーマット済み文字列
 */
function formatAxisLabel(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs === 0) return '0';
  if (abs >= 10000) {
    const man = abs / 10000;
    return sign + (man % 1 === 0 ? man.toFixed(0) : man.toFixed(1)) + '万';
  }
  return F(v);
}

// ========================================
// トレンドグラフ描画
// ========================================

/**
 * 棒グラフ＋折れ線グラフの汎用描画関数
 * マイナス値対応・きりの良い軸目盛り
 * @param {string} svgId - SVG要素のID
 * @param {Array} data - データ配列 [{label, bars:[], line:number}]
 * @param {number} W - グラフ幅
 * @param {number} H - グラフ高さ
 * @param {Object} colors - 色設定 {bars:[], line:string}
 * @param {boolean} showVals - 値を表示するか
 */
function drawBarLine(svgId, data, W, H, colors, showVals = false) {
  const svg = document.getElementById(svgId);
  if (!data.length) {
    svg.innerHTML = '';
    return;
  }

  const PL = 52, PR = 12, PT = 16, PB = 24;
  const dW = W - PL - PR, dH = H - PT - PB;

  // 全データから最小・最大値を算出
  const allBarVals = data.flatMap(d => d.bars);
  const allLineVals = data.map(d => d.line).filter(v => v !== undefined);
  const allVals = [...allBarVals, ...allLineVals];
  const rawMax = Math.max(...allVals, 0);
  const rawMin = Math.min(...allVals, 0);

  // きりの良い軸を計算
  const axis = calcNiceAxis(rawMin, rawMax);
  const range = axis.max - axis.min || 1;

  const gW = dW / Math.max(data.length, 1);
  const bW = Math.min(24, gW * 0.3);

  // 値→Y座標変換
  const valToY = v => PT + dH * (1 - (v - axis.min) / range);
  const zeroY = valToY(0);

  let html = '';

  // Y軸目盛り（きりの良い単位）
  for (let v = axis.min; v <= axis.max + axis.step * 0.01; v += axis.step) {
    const y = valToY(v);
    const isZero = Math.abs(v) < axis.step * 0.01;
    html += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="${isZero ? 'var(--t3)' : 'var(--bd)'}" stroke-width="${isZero ? '1' : '.5'}"/>`;
    html += `<text x="${PL - 4}" y="${y + 3}" text-anchor="end" fill="var(--t3)" font-size="7" font-family="Inter">${formatAxisLabel(Math.round(v))}</text>`;
  }

  let lp = ''; // 折れ線のパス
  let lineStarted = false; // 折れ線の連続性追跡

  data.forEach((d, i) => {
    const x = PL + i * gW + gW / 2;

    // 棒グラフ（マイナス対応：ゼロラインを基準に上下描画）
    d.bars.forEach((v, bi) => {
      if (v === 0) return;
      const barY = valToY(v);
      const h = Math.abs(barY - zeroY);
      const y = v >= 0 ? barY : zeroY;
      const bx = x + (bi - d.bars.length / 2) * bW + 1;
      html += `<rect x="${bx}" y="${y}" width="${bW - 2}" height="${h}" rx="2" fill="${colors.bars[bi]}" opacity="0.7"/>`;
      if (showVals && v !== 0) {
        const ty = v >= 0 ? barY - 3 : barY + h + 9;
        html += `<text x="${bx + bW / 2 - 1}" y="${ty}" text-anchor="middle" fill="${colors.bars[bi]}" font-size="6.5" font-family="Inter">${F(v)}</text>`;
      }
    });

    // 折れ線（マイナスもそのまま描画、データなし月は途切れさせる）
    if (d.line !== undefined) {
      const ly = valToY(d.line);
      lp += (!lineStarted ? 'M' : 'L') + `${x},${ly}`;
      lineStarted = true;
      html += `<circle cx="${x}" cy="${ly}" r="3" fill="${colors.line}" opacity="0.9"/>`;
      if (showVals) {
        const ty = d.line >= 0 ? ly - 6 : ly + 12;
        html += `<text x="${x}" y="${ty}" text-anchor="middle" fill="${colors.line}" font-size="7" font-weight="600" font-family="Inter">${F(d.line)}</text>`;
      }
    } else {
      lineStarted = false;
    }

    // X軸ラベル（選択月を強調）
    const isSelected = d.label === selectedMonth.replace(/^\d{4}\//, '').replace(/^0/, '') + '月';
    html += `<text x="${x}" y="${H - PB + 12}" text-anchor="middle" fill="${isSelected ? 'var(--tx)' : 'var(--t3)'}" font-size="8" font-weight="${isSelected ? '700' : '400'}">${d.label}</text>`;
  });

  // 折れ線パス
  if (lp) {
    html += `<path d="${lp}" fill="none" stroke="${colors.line}" stroke-width="1.5" opacity="0.5"/>`;
  }

  svg.innerHTML = html;
}

/**
 * トレンドグラフ用のデータを生成（選択月を基準に12ヶ月）
 * @returns {Array} グラフデータ
 */
function mkTrendData() {
  const months = getTrendMonthRange();
  return months.map(mk => {
    const hasData = !!monthSummaries[mk];
    const d = monthSummaries[mk] || { income: 0, expenses: {} };
    const e = Object.values(d.expenses || {}).reduce((a, b) => a + b, 0);
    const m = parseInt(mk.split('/')[1], 10);
    return {
      label: `${m}月`,
      bars: [d.income, e],
      line: hasData ? d.income - e : undefined
    };
  });
}

/**
 * ダッシュボードのトレンドグラフを描画（選択月を基準に12ヶ月）
 */
function renderTrend() {
  drawBarLine('trendSvg', mkTrendData(), 780, 260, {
    bars: ['var(--gn)', 'var(--rd)'],
    line: 'var(--bl)'
  });
}

/**
 * 固定費・変動費の推移グラフを描画
 */
function renderFV() {
  const months = getMonthRange();
  const data = months.map(m => {
    const d = monthSummaries[m] || { expenses: {} };
    const ft = Object.entries(d.expenses || {})
      .filter(([k]) => FIXED_CATS.has(k))
      .reduce((s, [, v]) => s + v, 0);
    const te = Object.values(d.expenses || {}).reduce((a, b) => a + b, 0);
    const mon = parseInt(m.split('/')[1], 10);
    return {
      label: `${mon}月`,
      bars: [ft, te - ft]
    };
  });

  drawBarLine('fvSvg', data, 440, 200, {
    bars: ['var(--am)', 'var(--rd)']
  });
}

/**
 * 貯蓄率のエリアグラフを描画
 */
function renderSav() {
  const svg = document.getElementById('savSvg');
  const months = getMonthRange();
  if (!months.length) {
    svg.innerHTML = '';
    return;
  }

  const W = 440, H = 200, PL = 36, PR = 12, PT = 12, PB = 24;
  const dW = W - PL - PR, dH = H - PT - PB;

  const data = months.map(m => {
    const d = monthSummaries[m] || { income: 0, expenses: {} };
    const e = Object.values(d.expenses || {}).reduce((a, b) => a + b, 0);
    const mon = parseInt(m.split('/')[1], 10);
    return {
      label: `${mon}月`,
      rate: d.income > 0 ? Math.round((d.income - e) / d.income * 100) : 0
    };
  });

  let html = '';

  // Y軸目盛り
  for (let i = 0; i <= 4; i++) {
    const y = PT + dH * (1 - i / 4);
    html += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="var(--bd)" stroke-width=".5"/>`;
    html += `<text x="${PL - 4}" y="${y + 3}" text-anchor="end" fill="var(--t3)" font-size="7">${i * 25}%</text>`;
  }

  let path = '';
  const gW = dW / Math.max(data.length, 1);

  data.forEach((d, i) => {
    const x = PL + i * gW + gW / 2;
    const y = PT + dH * (1 - Math.max(d.rate, 0) / 100);
    path += (i === 0 ? 'M' : 'L') + `${x},${y}`;
    html += `<circle cx="${x}" cy="${y}" r="3.5" fill="var(--pp)" opacity="0.9"/>`;
    html += `<text x="${x}" y="${y - 7}" text-anchor="middle" fill="var(--pp)" font-size="8" font-weight="700" font-family="Inter">${d.rate}%</text>`;
    html += `<text x="${x}" y="${H - PB + 11}" text-anchor="middle" fill="var(--t3)" font-size="8">${d.label}</text>`;
  });

  // エリアパス
  if (path) {
    const lx = PL + (data.length - 1) * gW + gW / 2;
    html += `<path d="${path} L${lx},${PT + dH} L${PL + gW / 2},${PT + dH} Z" fill="var(--pp)" opacity=".06"/>`;
    html += `<path d="${path}" fill="none" stroke="var(--pp)" stroke-width="2" opacity=".6"/>`;
  }

  // 目標25%の線
  const ty = PT + dH * (1 - 25 / 100);
  html += `<line x1="${PL}" y1="${ty}" x2="${W - PR}" y2="${ty}" stroke="var(--am)" stroke-width="1" stroke-dasharray="3,3" opacity=".4"/>`;
  html += `<text x="${W - PR}" y="${ty - 3}" text-anchor="end" fill="var(--am)" font-size="6" opacity=".6">目標25%</text>`;

  svg.innerHTML = html;
}

// ========================================
// 年間テーブル描画
// ========================================

/**
 * 年間集計テーブルを描画（選択月を基準に12ヶ月ローリング表示）
 */
function renderYearTable() {
  const t = document.getElementById('yearTable');
  const range = getTrendMonthRange();

  let ti = 0, texp = 0;
  let ir = '<td>収入</td>', er = '<td>支出</td>', br = '<td>残高</td>';
  const headers = [];

  range.forEach(mk => {
    const m = parseInt(mk.split('/')[1], 10);
    headers.push(`${m}月`);
    const d = monthSummaries[mk] || { income: 0, expenses: {} };
    const e = Object.values(d.expenses || {}).reduce((a, b) => a + b, 0);
    const hasData = !!monthSummaries[mk];
    const noDataStyle = hasData ? '' : ' style="color:var(--t3)"';

    ti += d.income;
    texp += e;
    ir += `<td${noDataStyle}>${F(d.income)}</td>`;
    er += `<td${noDataStyle}>${F(e)}</td>`;
    const bal = d.income - e;
    br += `<td${noDataStyle}${bal < 0 ? ' style="color:var(--rd)"' : ''}>${F(bal)}</td>`;
  });

  ir += `<td class="tc">${F(ti)}</td>`;
  er += `<td class="tc">${F(texp)}</td>`;
  const totalBal = ti - texp;
  br += `<td class="tc"${totalBal < 0 ? ' style="color:var(--rd)"' : ''}>${F(totalBal)}</td>`;

  t.innerHTML = `<thead><tr><th></th>${headers.map(m => `<th>${m}</th>`).join('')}<th class="tc">合計</th></tr></thead><tbody><tr class="ir">${ir}</tr><tr class="er">${er}</tr><tr class="br">${br}</tr></tbody>`;
}

// ========================================
// Sankeyダイアグラム描画
// ========================================

/**
 * お金の流れ（Sankey）ダイアグラムを描画
 */
function renderSankey() {
  const svg = document.getElementById('sankeySvg');
  const d = cd();
  const flows = d.sankeyFlows || [];
  const nc = d.nodeColumn || {};

  if (!flows.length) {
    svg.innerHTML = '<text x="50%" y="50" text-anchor="middle" fill="var(--t3)" font-size="12">データなし</text>';
    svg.setAttribute('viewBox', '0 0 500 80');
    return;
  }

  // ノードを3列に分類（0:収入源, 1:金融機関, 2:支出先）
  const columns = [[], [], []];
  const outgoing = {}, incoming = {}, nv = {}, ns = new Set();

  flows.forEach(f => {
    ns.add(f.from);
    ns.add(f.to);
    (outgoing[f.from] = outgoing[f.from] || []).push(f);
    (incoming[f.to] = incoming[f.to] || []).push(f);
  });

  // ノードの値を計算（入出力の最大値）
  ns.forEach(n => {
    nv[n] = Math.max(
      (outgoing[n] || []).reduce((s, f) => s + f.amount, 0),
      (incoming[n] || []).reduce((s, f) => s + f.amount, 0)
    );
  });

  // ノードを列に割り当て
  ns.forEach(n => {
    const c = nc[n] !== undefined ? nc[n] :
      (!incoming[n] || !incoming[n].length ? 0 :
        !outgoing[n] || !outgoing[n].length ? 2 : 1);
    columns[c].push(n);
  });

  // 各列を金額順にソート
  columns.forEach(c => c.sort((a, b) => nv[b] - nv[a]));

  const W = 960, PY = 14, NW = 10, NG = 4;
  const H = Math.max(240, columns.flat().length * 16 + PY * 2);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const PL = 185, PR = 150;
  const colX = [PL, PL + (W - PL - PR) / 2, W - PR];
  const drawH = H - PY * 2;
  const maxCV = Math.max(...columns.map(c => c.reduce((s, n) => s + nv[n], 0)), 1);
  const scale = drawH / (maxCV + columns.reduce((m, c) => Math.max(m, c.length), 0) * NG);

  // ノードの位置を計算
  const np = {};
  columns.forEach((col, ci) => {
    const ch = col.reduce((s, n) => s + nv[n] * scale, 0) + (col.length - 1) * NG;
    let y = PY + (drawH - ch) / 2;
    col.forEach(n => {
      np[n] = { x: colX[ci], y, h: Math.max(nv[n] * scale, 2) };
      y += nv[n] * scale + NG;
    });
  });

  let html = '';
  const so = {}, to2 = {};

  // フローパスを描画
  flows.forEach(f => {
    const src = np[f.from], tgt = np[f.to];
    if (!src || !tgt) return;

    const th = Math.max(f.amount * scale, 1);
    if (!so[f.from]) so[f.from] = 0;
    if (!to2[f.to]) to2[f.to] = 0;

    const sy = src.y + so[f.from];
    const ty = tgt.y + to2[f.to];
    so[f.from] += th;
    to2[f.to] += th;

    const sx = src.x + NW, tx = tgt.x, mx = (sx + tx) / 2;
    html += `<path d="M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty} L${tx},${ty + th} C${mx},${ty + th} ${mx},${sy + th} ${sx},${sy + th} Z" fill="${f.color}" opacity="0.35"/>`;
  });

  // ノードを描画（クリックで明細表示）
  columns.forEach((col, ci) => col.forEach(nm => {
    const p = np[nm];
    const enm = escapeHtml(nm);

    if (ci === 0) {
      // 左列：収入源（クリック→収入明細）
      html += `<g style="cursor:pointer" onclick="showIncomeDetail('${enm}')">`;
      html += `<rect x="${p.x - 180}" y="${p.y - 2}" width="${180 + NW}" height="${Math.max(p.h, 2) + 18}" fill="transparent"/>`;
      html += `<rect x="${p.x}" y="${p.y}" width="${NW}" height="${Math.max(p.h, 2)}" rx="2" fill="var(--bd)" opacity="0.8"/>`;
      html += `<text x="${p.x - 5}" y="${p.y + p.h / 2}" text-anchor="end" dominant-baseline="middle" fill="var(--t2)" font-size="10">${enm}</text>`;
      html += `<text x="${p.x - 5}" y="${p.y + p.h / 2 + 12}" text-anchor="end" fill="var(--t3)" font-size="8.5">${FY(nv[nm])}</text>`;
      html += `</g>`;
    } else if (ci === 2) {
      // 右列：支出先（クリック→支出明細）
      html += `<g style="cursor:pointer" onclick="showDetail('${enm}')">`;
      html += `<rect x="${p.x}" y="${p.y - 2}" width="${NW + 150}" height="${Math.max(p.h, 2) + 18}" fill="transparent"/>`;
      html += `<rect x="${p.x}" y="${p.y}" width="${NW}" height="${Math.max(p.h, 2)}" rx="2" fill="var(--bd)" opacity="0.8"/>`;
      html += `<text x="${p.x + NW + 5}" y="${p.y + p.h / 2}" text-anchor="start" dominant-baseline="middle" fill="var(--t2)" font-size="10">${enm}</text>`;
      html += `<text x="${p.x + NW + 5}" y="${p.y + p.h / 2 + 12}" text-anchor="start" fill="var(--t3)" font-size="8.5">${FY(nv[nm])}</text>`;
      html += `</g>`;
    } else {
      // 中央列：金融機関（クリック→金融機関明細）
      html += `<g style="cursor:pointer" onclick="showInstitutionDetail('${enm}')">`;
      html += `<rect x="${p.x - 45}" y="${p.y - 14}" width="${NW + 90}" height="${Math.max(p.h, 2) + 30}" fill="transparent"/>`;
      html += `<rect x="${p.x}" y="${p.y}" width="${NW}" height="${Math.max(p.h, 2)}" rx="2" fill="var(--bd)" opacity="0.8"/>`;
      html += `<text x="${p.x + NW / 2}" y="${p.y - 4}" text-anchor="middle" fill="var(--tx)" font-size="9" font-weight="600">${enm}</text>`;
      html += `<text x="${p.x + NW / 2}" y="${p.y + p.h + 10}" text-anchor="middle" fill="var(--t3)" font-size="8">${FY(nv[nm])}</text>`;
      html += `</g>`;
    }
  }));

  // 列ヘッダー
  ['収入', '保有金融機関', '大項目'].forEach((l, i) => {
    if (columns[i].length) {
      html += `<text x="${colX[i] + NW / 2}" y="8" text-anchor="middle" fill="var(--t3)" font-size="9">${l}</text>`;
    }
  });

  svg.innerHTML = html;
}

// ========================================
// トレンド表示コントロール
// ========================================

/**
 * トレンドセクションの年選択・期間指定コントロールを描画
 */
function renderTrendControls() {
  const el = document.getElementById('trendCtrl');
  if (!el) return;

  const years = getAvailableYears();
  let h = `<select class="trend-year-sel" onchange="selectYear(this.value)"${periodMode ? ' disabled' : ''}>`;
  years.forEach(y => {
    h += `<option value="${y}"${y === selectedYear ? ' selected' : ''}>${y}年</option>`;
  });
  h += `</select>`;
  h += `<button class="trend-period-btn${periodMode ? ' active' : ''}" onclick="togglePeriodMode()">${periodMode ? '📅 期間指定中' : '📅 期間指定'}</button>`;

  el.innerHTML = h;
}

/**
 * 年を選択（トレンド表示用）
 * @param {string} y - 年（例: "2025"）
 */
function selectYear(y) {
  selectedYear = y;
  renderTrendControls();
  renderTrend();
  renderYearTable();
}

/**
 * 期間指定モードの切り替え
 */
function togglePeriodMode() {
  periodMode = !periodMode;
  renderTrendControls();
  renderTrend();
  renderYearTable();
}

// ========================================
// 設定画面
// ========================================

/**
 * 設定画面を描画
 */
function renderSettings() {
  // 全カテゴリを取得
  const allCats = [...new Set(allMonths.flatMap(m => Object.keys(monthSummaries[m].expenses || {})))].sort();

  // 予算設定
  let bh = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">';
  allCats.forEach(k => {
    if (!BUDGETS[k]) BUDGETS[k] = 0;
    const ek = escapeHtml(k);
    bh += `<div style="background:var(--s2);border-radius:5px;padding:8px"><label style="font-size:9px;color:var(--t2);display:block;margin-bottom:3px">${ek}</label><input type="number" value="${BUDGETS[k]}" onchange="BUDGETS['${ek}']=parseInt(this.value)||0;saveConfig();renderAll()" style="width:100%;background:var(--s3);border:1px solid var(--bd);color:var(--tx);padding:4px 6px;border-radius:4px;font-size:11px;font-family:inherit"></div>`;
  });
  bh += '</div>';
  document.getElementById('budgetCfg').innerHTML = bh;

  // 固定費・変動費切り替え
  let ch = '<div style="display:flex;flex-wrap:wrap;gap:5px">';
  allCats.forEach(k => {
    const isF = FIXED_CATS.has(k);
    const ek2 = escapeHtml(k);
    ch += `<button style="padding:4px 10px;border-radius:14px;font-size:10px;cursor:pointer;border:1px solid ${isF ? 'var(--am)' : 'var(--bd)'};background:${isF ? 'rgba(245,158,11,.12)' : 'var(--s3)'};color:${isF ? 'var(--am)' : 'var(--t2)'};font-family:inherit" onclick="toggleFixed('${ek2}')">${ek2} ${isF ? '固' : '変'}</button>`;
  });
  ch += '</div><p style="margin-top:6px;font-size:9px;color:var(--t3)">クリックで固定費⇔変動費を切り替え</p>';
  document.getElementById('catCfg').innerHTML = ch;

  // テーマ切り替え
  const themeEl = document.getElementById('themeToggle');
  if (themeEl) {
    themeEl.innerHTML = [
      { key: 'dark', label: '🌙 ダーク' },
      { key: 'light', label: '☀️ ライト' }
    ].map(t => {
      const active = currentTheme === t.key;
      return `<button style="padding:4px 12px;border-radius:14px;font-size:10px;cursor:pointer;border:1px solid ${active ? 'var(--gn)' : 'var(--bd)'};background:${active ? 'rgba(34,197,94,.12)' : 'var(--s3)'};color:${active ? 'var(--gn)' : 'var(--t2)'};font-family:inherit" onclick="setTheme('${t.key}');renderSettings()">${t.label}</button>`;
    }).join('');
  }

  // フォントサイズ切り替え
  const fontEl = document.getElementById('fontSizeToggle');
  if (fontEl) {
    fontEl.innerHTML = FONT_SIZES.map(f => {
      const active = currentFontScale === f.scale;
      return `<button style="padding:4px 12px;border-radius:14px;font-size:10px;cursor:pointer;border:1px solid ${active ? 'var(--gn)' : 'var(--bd)'};background:${active ? 'rgba(34,197,94,.12)' : 'var(--s3)'};color:${active ? 'var(--gn)' : 'var(--t2)'};font-family:inherit" onclick="setFontScale(${f.scale});renderSettings()">${f.label}</button>`;
    }).join('');
  }
}

/**
 * カテゴリの固定費/変動費を切り替え
 * @param {string} k - カテゴリ名
 */
function toggleFixed(k) {
  if (FIXED_CATS.has(k)) {
    FIXED_CATS.delete(k);
  } else {
    FIXED_CATS.add(k);
  }
  saveConfig();
  renderSettings();
  renderAll();
}

// ========================================
// 全描画処理
// ========================================

/**
 * 全てのUIコンポーネントを再描画
 */
function renderAll() {
  renderMonthNav();
  renderKPI();
  renderIncome();
  renderExpense();
  renderTrendControls();
  renderTrend();
  renderYearTable();

  // アクティブビューに応じて追加描画
  const av = document.querySelector('.nav-i.active')?.dataset?.view;
  if (av === 'sankey') renderSankey();
  if (av === 'trend') { renderFV(); renderSav(); }
}

// ========================================
// CSV解析
// ========================================

/**
 * CSV行をパース（ダブルクォート対応）
 * @param {string} line - CSV行
 * @returns {Array<string>} パースされた列の配列
 */
function pcsv(line) {
  const r = [];
  let c = '', q = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        c += '"';
        i++;
      } else if (ch === '"') {
        q = false;
      } else {
        c += ch;
      }
    } else {
      if (ch === '"') {
        q = true;
      } else if (ch === ',') {
        r.push(c.trim());
        c = '';
      } else {
        c += ch;
      }
    }
  }
  r.push(c.trim());
  return r;
}

/**
 * 対象月を自動検出
 * 優先順位: 1. ファイル名の後ろの日付 → 2. ファイル名のYYYY-MMパターン → 3. 現在月
 * @param {string} filename - CSVファイル名
 * @returns {string} 対象月（YYYY-MM形式）
 */
function detectTargetMonth(filename) {
  try {
    if (filename) {
      // 1. ファイル名から日付範囲を抽出（例：2025-12-25_2026-01-22 → 後ろの日付を使用）
      const dateRangeMatch = filename.match(/(\d{4}[-_]\d{2}[-_]\d{2})[-_](\d{4}[-_]\d{2}[-_]\d{2})/);
      if (dateRangeMatch) {
        // 後ろの日付から年月を抽出
        const endDate = dateRangeMatch[2].replace(/_/g, '-');
        const endDateParts = endDate.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (endDateParts) {
          const year = endDateParts[1];
          const month = endDateParts[2];
          console.log('対象月検出（ファイル名の後ろの日付）:', `${year}-${month}`);
          return `${year}-${month}`;
        }
      }

      // 2. ファイル名から単一の日付を抽出（例：2026-01-22 → 2026-01）
      const singleDateMatch = filename.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
      if (singleDateMatch) {
        const year = singleDateMatch[1];
        const month = singleDateMatch[2];
        console.log('対象月検出（ファイル名の日付）:', `${year}-${month}`);
        return `${year}-${month}`;
      }

      // 3. ファイル名から年月パターンを抽出（例：mf_202601.csv → 2026-01）
      const monthMatch = filename.match(/(\d{4})[-_]?(\d{2})/);
      if (monthMatch) {
        console.log('対象月検出（ファイル名のYYYY-MMパターン）:', `${monthMatch[1]}-${monthMatch[2]}`);
        return `${monthMatch[1]}-${monthMatch[2]}`;
      }
    }
  } catch (e) {
    console.error('対象月検出エラー:', e);
  }

  // 4. 検出できない場合は現在月
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  console.log('対象月検出（デフォルト）:', defaultMonth);
  return defaultMonth;
}

/**
 * マネーフォワードCSVをパースして保存
 * @param {string} text - CSVテキスト
 * @param {string} filename - ファイル名
 * @param {string} targetMonth - 対象月（YYYY-MM形式）
 */
async function parseMF(text, filename, targetMonth) {
  console.log('parseMF開始。ファイル名:', filename, '対象月:', targetMonth, 'テキスト長:', text ? text.length : 0);

  if (!text) {
    throw new Error('CSVテキストが空です');
  }

  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  console.log('CSV行数:', lines.length);

  if (lines.length < 2) throw new Error('データが見つかりません');

  const header = pcsv(lines[0]);
  console.log('ヘッダー:', header);

  // 列インデックスを検出
  const fc = (...n) => header.findIndex(h => n.some(x => h.includes(x)));
  const iC = fc('計算対象');
  const iA = fc('金額（円）', '金額');
  const iCat = fc('大項目');
  const iSub = fc('中項目');
  const iAcc = fc('保有金融機関', '口座');
  const iX = fc('振替');
  const iCo = fc('内容');
  const iD = fc('日付');

  console.log('列インデックス - 計算対象:', iC, '金額:', iA, '大項目:', iCat, '中項目:', iSub, '金融機関:', iAcc, '振替:', iX, '内容:', iCo, '日付:', iD);

  if (iA === -1) throw new Error('金額列が見つかりません');

  // 月キーに変換（"2025-01" → "2025/01"）
  const mk = targetMonth.includes('-') ? targetMonth.replace(/-/g, '/') : targetMonth;
  console.log('月キー:', mk);

  const mm = {
    [mk]: {
      income: 0,
      points: 0,
      incomeDetail: {},
      expenses: {},
      iF: {},        // 収入フロー
      eF: {},        // 支出フロー
      nc: {}         // ノードカラム
    }
  };
  const txnBatch = [];
  const fCols = ["#22c55e", "#f59e0b", "#ec4899", "#a855f7", "#3b82f6", "#06b6d4", "#64748b", "#84cc16"];

  console.log('CSV解析ループ開始。データ行数:', lines.length - 1);
  let processedCount = 0, skippedCount = 0;

  // 各行を処理
  for (let i = 1; i < lines.length; i++) {
    try {
      const c = pcsv(lines[i]);
      if (c.length <= iA) { skippedCount++; continue; }
      if (iC !== -1 && c[iC] !== '1') { skippedCount++; continue; }  // 計算対象外
      if (iX !== -1 && c[iX] === '1') { skippedCount++; continue; }  // 振替

      const amt = parseInt(c[iA]) || 0;
      const cat = iCat !== -1 ? c[iCat] : '不明';
      const sub = iSub !== -1 ? c[iSub] : '';
      let acc = iAcc !== -1 ? c[iAcc] : '不明';
      acc = acc.replace(/\(.*?\)/g, '').replace(/（.*?）/g, '').trim();
      if (acc.length > 14) acc = acc.substring(0, 14);
      const co = iCo !== -1 ? c[iCo] : '';
      const dt = iD !== -1 ? c[iD] : '';
      const md = mm[mk];

      if (amt > 0) {
        // ポイント等は別集計
        if (/ポイント|キャッシュバック|利息|プレゼント/i.test(co)) {
          md.points += amt;
          processedCount++;
          continue;
        }

        // 収入
        md.income += amt;
        let label = 'その他収入';
        if (sub.includes('給与') || co.includes('給料')) label = '給与';
        else if (cat.includes('交通費') || sub.includes('交通費')) label = '交通費支給';

        const dk = `${label}（${acc}）`;
        md.incomeDetail[dk] = (md.incomeDetail[dk] || 0) + amt;

        // Sankey用：左列ラベルに金融機関名も含める
        const fk = `${dk}|||${acc}`;
        md.iF[fk] = (md.iF[fk] || 0) + amt;
        md.nc[dk] = 0;   // 左列："給与（三井住友銀行）"
        md.nc[acc] = 1;   // 中央列："三井住友銀行"

        // 収入取引明細を保存
        txnBatch.push({
          month: mk,
          monthCat: `${mk}|||income|||${dk}`,
          date: dt,
          content: co.substring(0, 30),
          amount: amt,
          account: acc,
          category: 'income',
          subcategory: label
        });
      } else {
        // 支出
        md.expenses[cat] = (md.expenses[cat] || 0) + Math.abs(amt);
        const fk = `${acc}|||${cat}`;
        md.eF[fk] = (md.eF[fk] || 0) + Math.abs(amt);
        md.nc[acc] = 1;
        md.nc[cat] = 2;

        // 取引明細を保存
        txnBatch.push({
          month: mk,
          monthCat: `${mk}|||${cat}`,
          date: dt,
          content: co.substring(0, 30),
          amount: amt,
          account: acc,
          category: cat,
          subcategory: sub
        });
      }
      processedCount++;
    } catch (lineError) {
      console.error(`行${i}の処理エラー:`, lineError, lines[i]);
      throw new Error(`行${i}の処理に失敗しました: ${lineError.message}`);
    }
  }

  console.log('CSV解析完了。処理件数:', processedCount, 'スキップ件数:', skippedCount);

  // IndexedDBに保存
  console.log('データベース保存開始');
  try {
    // 月データを保存
    for (const [monthKey, md] of Object.entries(mm)) {
      const sf = [];
      let ci = 0;
      console.log('月データ処理中:', monthKey);

      // 収入フローを追加
      Object.entries(md.iF).sort((a, b) => b[1] - a[1]).forEach(([key, v]) => {
        if (v < 100) return;
        const [from, to] = key.split('|||');
        sf.push({ from, to, amount: v, color: fCols[0] });
      });

      // 支出フローを追加
      Object.entries(md.eF).sort((a, b) => b[1] - a[1]).forEach(([key, v]) => {
        if (v < 500) return;
        const [from, to] = key.split('|||');
        ci++;
        sf.push({ from, to, amount: v, color: fCols[ci % fCols.length] });
      });

      await dbPut('months', {
        month: monthKey,
        income: md.income,
        points: md.points,
        incomeDetail: md.incomeDetail,
        expenses: md.expenses,
        sankeyFlows: sf,
        nodeColumn: md.nc
      });

      // 新しいカテゴリの予算を初期化
      Object.keys(md.expenses).forEach(c => {
        if (BUDGETS[c] === undefined) BUDGETS[c] = 0;
      });
    }
    console.log('月データ保存完了');

    // トランザクションの競合を避けるため少し待機
    await new Promise(resolve => setTimeout(resolve, 100));

    console.log('取引データ保存開始。件数:', txnBatch.length);

    // 取引明細を保存
    if (useFirestore && currentUser) {
      await fsBatchWrite(fsPath('transactions'), txnBatch);
      console.log('取引データ保存完了（Firestore）');
    } else {
      if (!db) throw new Error('データベースが初期化されていません');
      await new Promise((resolve, reject) => {
        try {
          const tx = db.transaction('transactions', 'readwrite');
          const store = tx.objectStore('transactions');
          for (const t of txnBatch) { store.put(t); }
          tx.oncomplete = () => { console.log('取引データ保存完了'); resolve(); };
          tx.onerror = e => { console.error('トランザクションエラー:', e); reject(e); };
        } catch (txError) { console.error('トランザクション作成エラー:', txError); reject(txError); }
      });
    }

    console.log('データベース保存完了');
  } catch (dbError) {
    console.error('データベース保存エラー:', dbError);
    throw new Error('データベース保存に失敗しました: ' + dbError.message);
  }

  await saveConfig();
  await loadAllMonths();
  selectedMonth = allMonths[allMonths.length - 1];
  toast(`✅ ${filename}を${mk}として取り込みました`);
  renderAll();
}

/**
 * CSVファイルを読み込む
 * @param {File} file - CSVファイル
 */
function handleFile(file) {
  console.log('CSV読み込み開始:', file.name);
  const r1 = new FileReader();

  r1.onload = e => {
    try {
      const text = e.target.result;
      console.log('Shift_JIS読み込み完了。文字数:', text ? text.length : 0);
      if (!text) {
        toast('⚠️ ファイルの読み込みに失敗しました');
        return;
      }
      const detectedMonth = detectTargetMonth(file.name);
      console.log('モーダル表示準備。検出月:', detectedMonth);
      showTargetMonthModal(file, text, detectedMonth);
    } catch (e1) {
      console.error('Shift_JIS読み込みエラー:', e1);
      console.log('UTF-8で再試行します...');

      // UTF-8で再試行
      const r2 = new FileReader();
      r2.onload = e2 => {
        try {
          const text = e2.target.result;
          console.log('UTF-8読み込み完了。文字数:', text ? text.length : 0);
          if (!text) {
            toast('⚠️ ファイルの読み込みに失敗しました');
            return;
          }
          const detectedMonth = detectTargetMonth(file.name);
          console.log('モーダル表示準備。検出月:', detectedMonth);
          showTargetMonthModal(file, text, detectedMonth);
        } catch (e2) {
          console.error('UTF-8読み込みエラー:', e2);
          toast('⚠️ CSVファイルの読み込みに失敗しました: ' + e2.message);
        }
      };
      r2.readAsText(file, 'UTF-8');
    }
  };

  r1.onerror = e => {
    console.error('FileReader エラー:', e);
    toast('⚠️ ファイル読み込みエラーが発生しました');
  };

  r1.readAsText(file, 'Shift_JIS');
}

// ========================================
// データエクスポート / インポート
// ========================================

/**
 * 全データをJSONファイルにエクスポート
 */
async function exportData() {
  const months = await dbGetAll('months');
  const txns = await dbGetAll('transactions');
  const config = { budgets: BUDGETS, fixed: [...FIXED_CATS] };

  const blob = new Blob([JSON.stringify({ months, transactions: txns, config }, null, 2)], {
    type: 'application/json'
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kakeibo_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();

  toast('💾 データを書き出しました');
}

/**
 * JSONファイルからデータをインポート
 * @param {File} file - JSONファイル
 */
async function importData(file) {
  const text = await file.text();
  const data = JSON.parse(text);

  if (!data || typeof data !== 'object') {
    toast('⚠️ 無効なデータ形式です');
    return;
  }

  // 月データの検証・インポート
  let monthCount = 0;
  if (Array.isArray(data.months)) {
    for (const m of data.months) {
      if (!m || typeof m !== 'object') continue;
      if (typeof m.month !== 'string' || !/^\d{4}\/\d{2}$/.test(m.month)) continue;
      if (typeof m.income !== 'number') continue;
      await dbPut('months', m);
      monthCount++;
    }
  }

  // 取引データの検証・インポート
  if (Array.isArray(data.transactions)) {
    const validTxns = data.transactions.filter(t => {
      if (!t || typeof t !== 'object') return false;
      if (typeof t.month !== 'string') return false;
      // 文字列フィールドの型チェックと長さ制限
      for (const f of ['content', 'account', 'category', 'subcategory', 'date', 'month', 'monthCat']) {
        if (t[f] !== undefined && typeof t[f] !== 'string') return false;
        if (typeof t[f] === 'string' && t[f].length > 200) t[f] = t[f].substring(0, 200);
      }
      return true;
    });

    if (validTxns.length) {
      if (useFirestore && currentUser) {
        await fsBatchWrite(fsPath('transactions'), validTxns);
      } else {
        const tx = db.transaction('transactions', 'readwrite');
        const st = tx.objectStore('transactions');
        validTxns.forEach(t => st.put(t));
        await new Promise(r => { tx.oncomplete = r });
      }
    }
  }

  // 設定データの検証・インポート
  if (data.config && typeof data.config === 'object') {
    if (data.config.budgets && typeof data.config.budgets === 'object') {
      BUDGETS = {};
      for (const [k, v] of Object.entries(data.config.budgets)) {
        if (typeof k === 'string' && k.length <= 50 && typeof v === 'number') {
          BUDGETS[k] = v;
        }
      }
    }
    if (Array.isArray(data.config.fixed)) {
      FIXED_CATS = new Set(data.config.fixed.filter(f => typeof f === 'string' && f.length <= 50));
    }
    await saveConfig();
  }

  await loadAllMonths();
  renderAll();
  toast(`📥 ${monthCount}ヶ月分を読み込みました`);
}

/**
 * 全データを削除
 */
async function clearAllData() {
  await dbClear('months');
  await dbClear('transactions');
  await dbClear('config');

  BUDGETS = {};
  FIXED_CATS = new Set(["住宅", "保険", "通信費", "教養・教育"]);
  allMonths = [];
  selectedMonth = '';
  selectedYear = null;
  periodMode = false;
  monthSummaries = {};

  // テーマ・フォントもリセット
  currentTheme = 'dark';
  document.documentElement.removeAttribute('data-theme');
  currentFontScale = 1.15;
  document.documentElement.style.setProperty('--font-scale', 1.15);

  renderAll();
  toast('🗑 全データを削除しました');
}

// ========================================
// 認証（Firebase Auth）
// ========================================

async function signInWithGoogle() {
  if (!firebaseAuth) return;
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await firebaseAuth.signInWithPopup(provider);
  } catch (e) {
    console.error('ログインエラー:', e);
    if (e.code === 'auth/popup-blocked') {
      toast('⚠️ ポップアップがブロックされました。許可してください');
    } else if (e.code !== 'auth/popup-closed-by-user') {
      toast('⚠️ ログインに失敗しました');
    }
  }
}

function signOutUser() {
  if (firebaseAuth) firebaseAuth.signOut();
}

function updateUserUI(user) {
  const el = document.getElementById('sbUser');
  if (user) {
    el.innerHTML = `<span class="sb-user-name">${escapeHtml(user.displayName || user.email)}</span><button class="sb-user-out" onclick="signOutUser()">ログアウト</button>`;
    el.classList.add('show');
  } else {
    el.innerHTML = '';
    el.classList.remove('show');
  }
}

// ========================================
// イベントリスナー
// ========================================

document.getElementById('csvBtn').addEventListener('click', () => document.getElementById('fileInput').click());
document.getElementById('fileInput').addEventListener('change', e => {
  [...e.target.files].forEach(handleFile);
  e.target.value = '';
});

document.getElementById('exportBtn').addEventListener('click', exportData);
document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importInput').click());
document.getElementById('importInput').addEventListener('change', e => {
  if (e.target.files[0]) importData(e.target.files[0]);
  e.target.value = '';
});

// ドラッグ＆ドロップ
document.body.addEventListener('dragover', e => e.preventDefault());
document.body.addEventListener('drop', e => {
  e.preventDefault();
  [...e.dataTransfer.files].filter(f => f.name.endsWith('.csv')).forEach(handleFile);
});

// ========================================
// PWA Service Worker登録
// ========================================

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}

// ========================================
// 初期化処理
// ========================================

(async () => {
  const isFirebase = initFirebase();

  if (isFirebase) {
    // Firebase モード: 認証を待機
    firebaseAuth.onAuthStateChanged(async (user) => {
      currentUser = user;
      updateUserUI(user);

      if (user) {
        document.getElementById('loginOverlay').classList.add('hidden');
        await openDB();
        await loadConfig();
        await loadAllMonths();
        renderAll();
      } else {
        document.getElementById('loginOverlay').classList.remove('hidden');
        allMonths = [];
        selectedMonth = '';
        selectedYear = null;
        monthSummaries = {};
        renderAll();
      }
    });
  } else {
    // オフラインモード: IndexedDB のみ
    document.getElementById('loginOverlay').classList.add('hidden');
    await openDB();
    await loadConfig();
    await loadAllMonths();
    renderAll();
  }
})();
