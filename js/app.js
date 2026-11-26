import {
  isConfigured, auth, db, cfg, getMessagingInstance,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  sendPasswordResetEmail, updatePassword, reauthenticateWithCredential,
  EmailAuthProvider, onAuthStateChanged,
  doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, onSnapshot, writeBatch, serverTimestamp,
  getToken
} from './firebase.js';
import {
  MEAL_PERIOD_LABELS, TRANSPORT_MODE_LABELS, TICKETING_OPTIONS, CURRENCIES,
  calculateEqualSplits, calculateSettlement, getLinkedPersonalExpenses,
  buildDailyTimelineSlots, getTodayInTimezone, getTonightAccommodation,
  getTripDateRange, formatTimeHHMM, formatDuration, formatShortDateWithWeekday,
  getWeekdayIndex, buildGoogleMapsUrl, fetchExchangeRate, exportExpensesCsv
} from './engines.js';

/* ============================= 全域狀態 ============================= */
const state = {
  authReady: false,
  user: null,
  profile: null, // { email, displayName, role, fcmTokens }
  allUsers: [],  // 僅管理員載入
  trips: [],
  activeTripId: null,
  activeTab: 'timeline', // timeline | expenses | settlement | admin
  selectedDate: null,
  itineraries: [],
  expenses: [],
  transfers: [],
  checkIns: {},
  expandedMobileSlots: new Set(),
  expandedDesktopSlots: new Set(),
  deferredInstallPrompt: null,
  userGuideMd: '',
  toast: null,
  modal: null, // { type, data }
  animatePage: false,
  animateTab: false,
  lastModalType: null
};

let unsubTrips = null;
let unsubTripDetail = [];

/* ============================= 工具函式 ============================= */
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function showToast(message, tone = 'dark') {
  state.toast = { message, tone };
  renderToast();
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    state.toast = null;
    renderToast();
  }, 3200);
}

function renderToast() {
  let el = document.getElementById('td-toast');
  if (!state.toast) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'td-toast';
    document.body.appendChild(el);
  }
  const bg = state.toast.tone === 'error' ? 'bg-rose-600' : state.toast.tone === 'success' ? 'bg-teal-700' : 'bg-slate-900';
  el.className = `fixed bottom-5 left-1/2 -translate-x-1/2 z-[100] px-4 py-2.5 rounded-full text-sm text-white shadow-lg ${bg}`;
  el.textContent = state.toast.message;
}

function closeModal() {
  if (!state.modal) return;
  const backdrop = document.getElementById('modal-backdrop');
  const panel = document.getElementById('modal-panel');
  if (backdrop && panel) {
    backdrop.classList.remove('td-modal-backdrop-enter');
    backdrop.classList.add('td-modal-backdrop-exit');
    panel.classList.remove('td-modal-panel-enter', 'td-modal-panel-flip');
    panel.classList.add('td-modal-panel-exit');
    clearTimeout(closeModal._timer);
    closeModal._timer = setTimeout(() => {
      state.modal = null;
      state.lastModalType = null;
      render();
    }, 165);
    return;
  }
  state.modal = null;
  state.lastModalType = null;
  render();
}

function isAdmin() {
  return state.profile?.role === 'admin';
}

function activeTrip() {
  return state.trips.find((t) => t.id === state.activeTripId) || null;
}

function memberName(trip, uid) {
  return trip?.memberDirectory?.[uid]?.displayName || '成員';
}

function memberNamesList(trip, uids) {
  return (uids || []).map((id) => memberName(trip, id)).join('、');
}

function detectEnvironment() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isInAppBrowser = /Line\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(ua);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const permission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  return { isIOS, isAndroid, isInAppBrowser, isStandalone, permission };
}

async function callGasBridge(action, payload) {
  if (!cfg.gasBridgeUrl) {
    return { ok: false, error: '尚未設定 GAS 跳板網址' };
  }
  try {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(cfg.gasBridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, idToken, payload })
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/* ============================= PWA 與 Service Worker ============================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./firebase-messaging-sw.js').catch(() => {});
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.deferredInstallPrompt = e;
});

/* ============================= Firestore 監聽管理 ============================= */
function clearTripDetailListeners() {
  unsubTripDetail.forEach((fn) => { try { fn(); } catch {} });
  unsubTripDetail = [];
  state.itineraries = [];
  state.expenses = [];
  state.transfers = [];
  state.checkIns = {};
}

function subscribeTrips() {
  if (unsubTrips) { try { unsubTrips(); } catch {} }
  const q = isAdmin()
    ? query(collection(db, 'trips'), orderBy('startDate', 'desc'))
    : query(collection(db, 'trips'), where('activeMemberIds', 'array-contains', state.user.uid));

  unsubTrips = onSnapshot(q, (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));
    state.trips = list;

    // 檢查 URL hash 自動定位旅行
    const hashMatch = window.location.hash.match(/trip=([^&]+)/);
    if (!state.activeTripId && hashMatch && list.some((t) => t.id === hashMatch[1])) {
      selectTrip(hashMatch[1]);
      return;
    }
    if (state.activeTripId && !list.some((t) => t.id === state.activeTripId)) {
      state.activeTripId = null;
      clearTripDetailListeners();
    }
    render();
  }, (err) => {
    console.error(err);
    showToast('讀取旅行資料失敗，請檢查 Firestore 規則', 'error');
  });
}

async function loadAllUsersIfAdmin() {
  if (!isAdmin()) return;
  try {
    const snap = await getDocs(collection(db, 'users'));
    state.allUsers = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
    render();
  } catch (e) {
    console.warn('Load users failed:', e);
  }
}

function selectTrip(tripId) {
  clearTripDetailListeners();
  state.activeTripId = tripId;
  state.activeTab = 'timeline';
  state.animatePage = true;
  state.expandedMobileSlots.clear();
  state.expandedDesktopSlots.clear();

  const trip = activeTrip();
  if (trip) {
    const dates = getTripDateRange(trip.startDate, trip.endDate);
    const today = getTodayInTimezone(trip.timezone);
    state.selectedDate = dates.includes(today) ? today : (dates[0] || trip.startDate);
    window.location.hash = `trip=${tripId}`;
  }

  unsubTripDetail.push(
    onSnapshot(collection(db, 'trips', tripId, 'itineraries'), (snap) => {
      state.itineraries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }),
    onSnapshot(collection(db, 'trips', tripId, 'expenses'), (snap) => {
      state.expenses = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => String(b.expenseDate || '').localeCompare(String(a.expenseDate || '')));
      render();
    }),
    onSnapshot(collection(db, 'trips', tripId, 'settlementTransfers'), (snap) => {
      state.transfers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }),
    onSnapshot(collection(db, 'trips', tripId, 'safeHomeCheckIns'), (snap) => {
      const map = {};
      snap.docs.forEach((d) => { map[d.id] = d.data(); });
      state.checkIns = map;
      render();
    })
  );
  render();
}

/* ============================= 內建說明書載入 ============================= */
async function loadUserGuide() {
  if (state.userGuideMd) return state.userGuideMd;
  try {
    const res = await fetch('./docs/USER_GUIDE.md');
    if (res.ok) {
      state.userGuideMd = await res.text();
    }
  } catch {
    state.userGuideMd = '# 使用說明書載入失敗\n請確認網路連線或重新整理頁面。';
  }
  return state.userGuideMd;
}

async function openHelpModal(sectionNum = null) {
  await loadUserGuide();
  state.modal = { type: 'help', data: { sectionNum } };
  render();
  if (sectionNum) {
    setTimeout(() => {
      const container = document.getElementById('help-md-body');
      if (!container) return;
      const headings = container.querySelectorAll('h2');
      for (const h of headings) {
        if (h.textContent.trim().startsWith(`${sectionNum}.`)) {
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        }
      }
    }, 60);
  }
}

/* ============================= 推播訂閱與加入主畫面 ============================= */
async function handleSubscribePush() {
  const env = detectEnvironment();
  if (env.isInAppBrowser || (env.isIOS && !env.isStandalone) || env.permission === 'denied') {
    state.modal = { type: 'pwa', data: { tab: env.isAndroid ? 'android' : 'ios' } };
    render();
    return;
  }

  if (typeof Notification === 'undefined') {
    showToast('目前瀏覽器不支援推播通知', 'error');
    return;
  }

  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      state.modal = { type: 'pwa', data: { tab: env.isAndroid ? 'android' : 'ios' } };
      render();
      return;
    }

    if (!cfg.vapidKey) {
      showToast('已取得通知權限，待填入 VAPID Key 即可接收推播', 'success');
      return;
    }

    const messaging = await getMessagingInstance();
    if (!messaging) {
      showToast('目前環境不支援 FCM 推播', 'error');
      return;
    }

    const swReg = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, {
      vapidKey: cfg.vapidKey,
      serviceWorkerRegistration: swReg
    });

    if (token) {
      const key = 'tok_' + token.slice(-16).replace(/[^a-zA-Z0-9]/g, '');
      const platform = env.isIOS ? 'ios_pwa' : env.isAndroid ? 'android' : 'desktop';
      const nextTokens = { ...(state.profile?.fcmTokens || {}) };
      nextTokens[key] = { token, platform, updatedAt: new Date().toISOString() };
      await updateDoc(doc(db, 'users', state.user.uid), {
        fcmTokens: nextTokens,
        updatedAt: serverTimestamp()
      });
      state.profile.fcmTokens = nextTokens;
      showToast('推播通知訂閱成功', 'success');
      render();
    }
  } catch (err) {
    console.error(err);
    showToast('推播訂閱失敗，請檢查 VAPID Key 或瀏覽器設定', 'error');
  }
}

/* ============================= 主渲染入口 ============================= */
function render() {
  const root = document.getElementById('app');
  if (!isConfigured) {
    root.innerHTML = renderConfigGuide();
    lucide.createIcons();
    return;
  }
  if (!state.authReady) {
    root.innerHTML = `<div class="min-h-screen flex items-center justify-center text-sm text-slate-500">驗證登入狀態中...</div>`;
    return;
  }
  if (!state.user) {
    root.innerHTML = renderAuthView();
    bindAuthEvents();
    lucide.createIcons();
    return;
  }

  const pageAnimCls = state.animatePage ? 'td-view-enter' : '';
  root.innerHTML = `
    <div class="min-h-screen flex flex-col">
      ${renderHeader()}
      <main class="flex-1 max-w-5xl w-full mx-auto px-4 py-5 pb-20 ${pageAnimCls}">
        ${state.activeTripId ? renderTripDetail() : renderTripList()}
      </main>
    </div>
    ${renderModal()}
  `;

  state.animatePage = false;
  state.animateTab = false;
  state.lastModalType = state.modal ? state.modal.type : null;

  bindGlobalEvents();
  lucide.createIcons();
}

/* ============================= 尚未設定 config.js 畫面 ============================= */
function renderConfigGuide() {
  return `
    <div class="min-h-screen flex items-center justify-center p-4 bg-slate-50">
      <div class="max-w-lg w-full bg-white rounded-2xl shadow-sm border border-slate-200 p-6 space-y-4">
        <div class="flex items-center gap-3">
          <img src="./icons/icon-192.png" class="w-11 h-11 rounded-xl" alt="TripDock" />
          <div>
            <h1 class="text-lg font-bold text-slate-900">TripDock 尚未連線 Firebase</h1>
            <p class="text-xs text-slate-500">請先完成最後一步設定即可啟動</p>
          </div>
        </div>
        <ol class="list-decimal list-inside text-sm text-slate-700 space-y-2 leading-relaxed">
          <li>開啟 GitHub 專案中的 <code class="bg-slate-100 px-1.5 py-0.5 rounded">js/config.js</code>。</li>
          <li>將 Firebase Console 的 6 組設定值填入 <code class="bg-slate-100 px-1.5 py-0.5 rounded">firebase</code> 區塊並儲存 Commit。</li>
          <li>等待約 30 秒後重新整理本頁即可開始登入使用。</li>
        </ol>
      </div>
    </div>
  `;
}

/* ============================= 登入 / 註冊畫面 ============================= */
let authMode = 'login'; // login | register | reset
function renderAuthView() {
  return `
    <div class="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-teal-50 via-slate-50 to-indigo-50">
      <div class="max-w-sm w-full bg-white rounded-3xl shadow-sm border border-slate-200/80 p-7 space-y-6">
        <div class="text-center space-y-2">
          <img src="./icons/icon-192.png" class="w-14 h-14 rounded-2xl mx-auto shadow-sm" alt="TripDock" />
          <h1 class="text-xl font-bold text-slate-900">旅行資訊綜合管理系統</h1>
          <p class="text-xs text-slate-500 tracking-wide">TripDock</p>
        </div>

        <div class="grid grid-cols-2 bg-slate-100 p-1 rounded-xl text-sm">
          <button data-auth-mode="login" class="py-1.5 rounded-lg font-medium ${authMode === 'login' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'}">登入</button>
          <button data-auth-mode="register" class="py-1.5 rounded-lg font-medium ${authMode === 'register' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'}">註冊帳號</button>
        </div>

        <form id="auth-form" class="space-y-3.5">
          ${authMode === 'register' ? `
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">顯示名稱</label>
              <input name="displayName" required class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
            </div>
          ` : ''}
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Email</label>
            <input name="email" type="email" required class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
          </div>
          ${authMode !== 'reset' ? `
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">密碼</label>
              <input name="password" type="password" required minlength="6" placeholder="至少 6 位字元" class="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
            </div>
          ` : ''}
          <button type="submit" class="w-full py-2.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold transition">
            ${authMode === 'login' ? '登入' : authMode === 'register' ? '建立帳號' : '寄送重設密碼信'}
          </button>
        </form>

        <div class="flex items-center justify-between text-xs text-slate-500">
          ${authMode === 'reset'
            ? `<button data-auth-mode="login" class="text-teal-700 font-medium">返回登入</button>`
            : `<button data-auth-mode="reset" class="hover:text-slate-700">忘記密碼</button>`}
          <button id="btn-auth-pwa" class="text-teal-700 font-medium">加入主畫面教學</button>
        </div>
      </div>
    </div>
    ${renderModal()}
  `;
}

function bindAuthEvents() {
  document.querySelectorAll('[data-auth-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      authMode = btn.dataset.authMode;
      render();
    });
  });

  document.getElementById('btn-auth-pwa')?.addEventListener('click', () => {
    const env = detectEnvironment();
    state.modal = { type: 'pwa', data: { tab: env.isAndroid ? 'android' : 'ios' } };
    render();
  });

  document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const email = String(fd.get('email') || '').trim();
    const password = String(fd.get('password') || '');
    const displayName = String(fd.get('displayName') || '').trim();

    try {
      if (authMode === 'login') {
        await signInWithEmailAndPassword(auth, email, password);
      } else if (authMode === 'register') {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await setDoc(doc(db, 'users', cred.user.uid), {
          email,
          displayName: displayName || email.split('@')[0],
          role: 'member',
          fcmTokens: {},
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
        showToast('註冊成功，請等待管理員為你歸戶旅行', 'success');
      } else {
        await sendPasswordResetEmail(auth, email);
        showToast('已寄出重設密碼信件，請至信箱查收', 'success');
        authMode = 'login';
        render();
      }
    } catch (err) {
      showToast(err.message || '操作失敗，請確認帳號密碼', 'error');
    }
  });

  bindModalEvents();
}

/* ============================= 頂部導覽列 ============================= */
function renderHeader() {
  const trip = activeTrip();
  const hasPush = Object.keys(state.profile?.fcmTokens || {}).length > 0;
  return `
    <header class="sticky top-0 z-30 glass-header">
      <div class="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2.5 min-w-0">
          ${trip ? `
            <button id="btn-back-trips" class="p-1.5 -ml-1.5 rounded-xl glass-btn-subtle text-slate-600" title="返回旅行清單">
              <i data-lucide="arrow-left" class="w-4 h-4"></i>
            </button>
          ` : `<img src="./icons/icon-192.png" class="w-8 h-8 rounded-lg shrink-0" alt="TripDock" />`}
          <div class="min-w-0">
            <h1 class="font-bold text-slate-900 text-sm sm:text-base truncate">
              ${trip ? esc(trip.name) : '旅行資訊綜合管理系統'}
            </h1>
            ${trip ? `<p class="text-[11px] text-slate-500 truncate">${esc(trip.location)}｜${esc(trip.startDate)} ～ ${esc(trip.endDate)}</p>` : ''}
          </div>
        </div>

        <div class="flex items-center gap-1.5 shrink-0">
          <button id="btn-subscribe-push" class="px-2.5 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1 ${hasPush ? 'glass-btn-teal-soft' : 'glass-btn-subtle'}" title="開啟推播通知">
            <i data-lucide="bell" class="w-3.5 h-3.5"></i>
            <span class="hidden sm:inline">${hasPush ? '已訂閱推播' : '開啟推播通知'}</span>
          </button>
          <button id="btn-open-pwa" class="p-1.5 rounded-xl glass-btn-subtle text-slate-600" title="加入主畫面教學">
            <i data-lucide="smartphone" class="w-4 h-4"></i>
          </button>
          <button id="btn-global-help" class="p-1.5 rounded-xl glass-btn-subtle text-slate-600" title="使用說明">
            <i data-lucide="info" class="w-4 h-4"></i>
          </button>
          <button id="btn-open-profile" class="px-2.5 py-1.5 rounded-xl glass-btn-subtle text-xs font-medium text-slate-700 max-w-[96px] truncate">
            ${esc(state.profile?.displayName || '成員')}
          </button>
        </div>
      </div>
    </header>
  `;
}

/* ============================= 首頁：多趟旅行清單 ============================= */
function renderTripList() {
  const activeList = state.trips.filter((t) => t.status !== 'settled');
  const settledList = state.trips.filter((t) => t.status === 'settled');

  const renderCard = (t) => {
    const statusBadge =
      t.status === 'settling'
        ? `<span class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800">結帳收款中</span>`
        : t.status === 'settled'
        ? `<span class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-600">歷史足跡</span>`
        : `<span class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-teal-100 text-teal-800">進行中</span>`;

    const myTotal = t.status === 'settled' ? (t.memberTotalExpenses?.[state.user.uid] ?? 0) : null;
    const members = (t.activeMemberIds || []).map((id) => memberName(t, id)).join('、');

    const cardInner = `
      <div data-select-trip="${esc(t.id)}" class="trip-swipe-card relative z-10 cursor-pointer bg-white rounded-2xl border border-slate-200/90 hover:border-teal-400 hover:shadow-sm transition-colors p-4 space-y-2.5">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <h3 class="font-bold text-slate-900 text-base truncate">${esc(t.name)}</h3>
            <p class="text-xs text-slate-500 mt-0.5">${esc(t.location)}｜${esc(t.startDate)} ～ ${esc(t.endDate)}</p>
          </div>
          ${statusBadge}
        </div>
        <p class="text-xs text-slate-600 truncate">成員：${esc(members || '尚未歸戶')}</p>
        ${t.status === 'settled' ? `
          <div class="pt-2 border-t border-slate-100 flex items-center justify-between text-xs">
            <span class="text-slate-500">你的本次總花費 <strong class="text-slate-900">NT$${myTotal.toLocaleString()}</strong></span>
            <span class="text-slate-400">全團 NT$${Number(t.totalExpenseTwd || 0).toLocaleString()}</span>
          </div>
        ` : ''}
      </div>
    `;

    if (!isAdmin()) return cardInner;

    return `
      <div class="trip-swipe-wrap relative overflow-hidden rounded-2xl bg-rose-600" data-swipe-wrap="${esc(t.id)}">
        <button type="button" data-delete-trip="${esc(t.id)}" class="absolute inset-y-0 right-0 w-[84px] flex flex-col items-center justify-center gap-1 text-white text-xs font-semibold bg-rose-600 active:bg-rose-700">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
          <span>刪除</span>
        </button>
        ${cardInner}
      </div>
    `;
  };

  const pendingDeletions = isAdmin()
    ? state.allUsers.filter((u) => u.role !== 'admin' && u.deletionRequested === true)
    : [];

  return `
    <div class="space-y-6">
      ${pendingDeletions.length > 0 ? `
        <div class="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2.5 min-w-0">
            <i data-lucide="user-x" class="w-5 h-5 text-amber-700 shrink-0"></i>
            <div class="min-w-0">
              <p class="text-sm font-bold text-amber-900">有 ${pendingDeletions.length} 筆帳號刪除申請待審核</p>
              <p class="text-xs text-amber-700 truncate">${esc(pendingDeletions.map((u) => u.displayName || u.email).join('、'))}</p>
            </div>
          </div>
          <button id="btn-open-deletion-review" class="shrink-0 px-3.5 py-2 rounded-xl glass-btn-primary text-xs font-semibold">前往審核</button>
        </div>
      ` : ''}

      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-lg font-bold text-slate-900">我的旅行</h2>
          <p class="text-xs text-slate-500 mt-0.5">點擊進入查看個人並行時間軸與分帳</p>
        </div>
        ${isAdmin() ? `
          <button id="btn-create-trip" class="px-3.5 py-2 rounded-xl glass-btn-primary text-xs font-semibold flex items-center gap-1.5">
            <i data-lucide="plus" class="w-4 h-4"></i>建立旅行
          </button>
        ` : ''}
      </div>

      ${state.trips.length === 0 ? `
        <div class="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center space-y-2">
          <p class="text-sm font-medium text-slate-700">目前尚未加入任何旅行</p>
          <p class="text-xs text-slate-500">${isAdmin() ? '點擊右上角「建立旅行」開始規劃第一趟行程' : '請聯繫管理員將你的帳號歸戶至旅行名單'}</p>
        </div>
      ` : ''}

      ${activeList.length > 0 ? `
        <section class="space-y-3">
          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wider">進行中與結帳中</h3>
          <div class="grid gap-3 sm:grid-cols-2">${activeList.map(renderCard).join('')}</div>
        </section>
      ` : ''}

      ${settledList.length > 0 ? `
        <section class="space-y-3">
          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wider">歷史旅遊足跡</h3>
          <div class="grid gap-3 sm:grid-cols-2">${settledList.map(renderCard).join('')}</div>
        </section>
      ` : ''}
    </div>
  `;
}

/* ============================= 單趟旅行主視圖 ============================= */
function renderTripDetail() {
  const trip = activeTrip();
  if (!trip) return '';

  const today = getTodayInTimezone(trip.timezone);
  const showSafeHome = trip.status !== 'settled' && (today >= trip.endDate || Object.keys(state.checkIns).length > 0);
  const tonightStay = getTonightAccommodation(state.itineraries, trip);

  return `
    <div class="space-y-4">
      ${showSafeHome ? renderSafeHomeBanner(trip) : ''}
      ${renderAccommodationBanner(trip, tonightStay)}

      <!-- 主功能分頁列 -->
      <div class="grid ${isAdmin() ? 'grid-cols-4' : 'grid-cols-3'} gap-1 sm:gap-1.5 glass-bar p-1.5 rounded-2xl">
        ${[
          { id: 'timeline', label: '行程時間軸', icon: 'calendar-clock' },
          { id: 'expenses', label: '帳務分帳', icon: 'receipt' },
          { id: 'settlement', label: '結帳收款', icon: 'wallet' },
          ...(isAdmin() ? [{ id: 'admin', label: '管理員設定', icon: 'shield' }] : [])
        ].map((tab) => `
          <button data-tab="${tab.id}" class="min-w-0 py-2 px-1 sm:px-3 rounded-xl text-[11px] sm:text-sm font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 whitespace-nowrap transition ${
            state.activeTab === tab.id ? 'glass-btn-primary' : 'text-slate-600 hover:bg-white/60 active:scale-[0.97]'
          }">
            <i data-lucide="${tab.icon}" class="w-4 h-4 shrink-0"></i><span>${tab.label}</span>
          </button>
        `).join('')}
      </div>

      <div class="${state.animateTab ? 'td-view-enter' : ''}">
        ${state.activeTab === 'timeline' ? renderTimelineTab(trip) : ''}
        ${state.activeTab === 'expenses' ? renderExpensesTab(trip) : ''}
        ${state.activeTab === 'settlement' ? renderSettlementTab(trip) : ''}
        ${state.activeTab === 'admin' && isAdmin() ? renderAdminTab(trip) : ''}
      </div>
    </div>
  `;
}

/* ----------------------------- 到家報平安橫幅 ----------------------------- */
function renderSafeHomeBanner(trip) {
  const activeIds = trip.activeMemberIds || [];
  const checkedCount = activeIds.filter((uid) => state.checkIns[uid]?.checkedIn).length;
  const myCheckIn = state.checkIns[state.user.uid];

  return `
    <div class="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 space-y-2.5">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <div class="flex items-center gap-2">
          <i data-lucide="home" class="w-4 h-4 text-emerald-700"></i>
          <span class="text-sm font-bold text-emerald-900">到家報平安</span>
          <span class="text-xs font-medium text-emerald-700">${checkedCount} / ${activeIds.length} 人已到家</span>
        </div>
        ${myCheckIn?.checkedIn
          ? `<span class="text-xs font-semibold text-emerald-700">✓ 你已報平安</span>`
          : `<button id="btn-safe-home" class="px-3.5 py-1.5 rounded-xl glass-btn-primary text-xs font-semibold">我平安到家了</button>`}
      </div>
      <div class="flex flex-wrap gap-1.5">
        ${activeIds.map((uid) => {
          const ci = state.checkIns[uid];
          return `<span class="px-2.5 py-1 rounded-lg text-xs ${ci?.checkedIn ? 'bg-white text-emerald-800 border border-emerald-200' : 'bg-emerald-100/60 text-emerald-700/70'}">
            ${ci?.checkedIn ? '✓ ' : ''}${esc(memberName(trip, uid))}${ci?.message ? `・${esc(ci.message)}` : ''}
          </span>`;
        }).join('')}
      </div>
    </div>
  `;
}

/* ----------------------------- 極簡當晚住宿卡片 (PRD v3.2 §4.4 A) ----------------------------- */
function renderAccommodationBanner(trip, stay) {
  if (!stay) {
    if (!isAdmin()) return '';
    return `
      <div class="bg-white rounded-2xl border border-dashed border-slate-300 px-4 py-3 flex items-center justify-between">
        <span class="text-xs text-slate-500">尚未設定住宿與分房資訊</span>
        <button id="btn-add-room-shortcut" class="px-3 py-1.5 rounded-xl glass-btn-teal-soft text-xs font-semibold">＋ 新增/編輯房間</button>
      </div>
    `;
  }

  const rooms = stay.rooms || [];
  const myRoom = rooms.find((r) => (r.occupantIds || []).includes(state.user.uid));
  const roommates = myRoom
    ? (myRoom.occupantIds || []).filter((id) => id !== state.user.uid).map((id) => memberName(trip, id))
    : [];

  return `
    <div id="card-accommodation" class="bg-white rounded-2xl border border-slate-200 hover:border-teal-400 transition px-4 py-3.5 cursor-pointer flex items-start justify-between gap-3">
      <div class="min-w-0 space-y-0.5">
        <p class="font-bold text-slate-900 text-sm sm:text-base truncate">
          ${esc(stay.title)}｜${esc(myRoom?.roomNo || '未分配')}
        </p>
        <p class="text-xs text-slate-500 truncate">
          室友：${esc(roommates.length > 0 ? roommates.join('、') : (myRoom ? '單人入住' : '未分配'))}
        </p>
      </div>
      ${isAdmin() ? `
        <button id="btn-add-room-shortcut" class="shrink-0 px-3 py-1.5 rounded-xl glass-btn-teal-soft text-xs font-semibold">
          ＋ 新增/編輯房間
        </button>
      ` : ''}
    </div>
  `;
}

/* ============================= Tab 1: 直式個人並行時間軸 ============================= */
function renderTimelineTab(trip) {
  const dates = getTripDateRange(trip.startDate, trip.endDate);
  if (!state.selectedDate && dates.length > 0) state.selectedDate = dates[0];
  const slots = buildDailyTimelineSlots(state.itineraries, state.selectedDate, state.user.uid);

  return `
    <div class="space-y-4">
      <!-- 天數切換與新增行程列 -->
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
          ${dates.map((d, idx) => `
            <button data-select-date="${d}" class="px-3 py-1.5 rounded-xl text-xs font-semibold shrink-0 transition ${
              state.selectedDate === d ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
            }">
              D${idx + 1} ${formatShortDateWithWeekday(d)}
            </button>
          `).join('')}
        </div>
        <div class="flex items-center gap-1.5">
          <button data-help-section="3" class="p-2 rounded-xl bg-white border border-slate-200 text-slate-500 hover:text-teal-700" title="行程與時間軸說明">
            <i data-lucide="info" class="w-4 h-4"></i>
          </button>
          <button id="btn-new-itinerary" class="px-3.5 py-2 rounded-xl glass-btn-primary text-xs font-semibold flex items-center gap-1">
            <i data-lucide="plus" class="w-3.5 h-3.5"></i>新增行程
          </button>
        </div>
      </div>

      ${slots.length === 0 ? `
        <div class="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center space-y-2">
          <p class="text-sm text-slate-600">這一天還沒有安排行程</p>
          <p class="text-xs text-slate-400">點擊右上角「新增行程」建立餐食、交通或景點</p>
        </div>
      ` : `
        <div class="relative pl-5 sm:pl-6 space-y-5 before:content-[''] before:absolute before:left-[7px] sm:before:left-[9px] before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-200">
          ${slots.map((slot, sIdx) => renderTimelineSlot(trip, slot, sIdx)).join('')}
        </div>
      `}
    </div>
  `;
}

function getEventDisplayTitle(it) {
  if (it.type === 'dining') {
    const opts = it.mealOptions || [];
    const primary = opts.find((o) => o.isPrimary) || opts[0];
    const period = MEAL_PERIOD_LABELS[it.mealPeriod] || '餐食';
    return {
      badge: period,
      badgeCls: 'bg-amber-100 text-amber-800',
      title: primary ? primary.name : (it.title || '未命名餐食'),
      extraCount: opts.length > 1 ? opts.length - 1 : 0
    };
  }
  if (it.type === 'transport') {
    const mode = TRANSPORT_MODE_LABELS[it.transportMode] || '交通';
    const route = it.origin && it.destination ? `${it.origin} ➔ ${it.destination}` : it.title;
    return {
      badge: mode,
      badgeCls: 'bg-sky-100 text-sky-800',
      title: it.flightDetails?.flightNo ? `${it.flightDetails.flightNo} ${route}` : (it.title || route),
      extraCount: 0
    };
  }
  return {
    badge: '景點',
    badgeCls: 'bg-teal-100 text-teal-800',
    title: it.title || '未命名景點',
    extraCount: 0
  };
}

function renderTimelineSlot(trip, slot, sIdx) {
  const hasPrimary = slot.primaryEvents.length > 0;
  const others = slot.parallelOtherEvents || [];
  const hasOthers = others.length > 0;
  const mobileOpen = state.expandedMobileSlots.has(sIdx);
  const desktopOpen = state.expandedDesktopSlots.has(sIdx);
  const visibleDesktopOthers = desktopOpen ? others : others.slice(0, 2);

  const renderPrimaryCard = (it) => {
    const meta = getEventDisplayTitle(it);
    const dur = it.type === 'transport' ? formatDuration(it.startTime, it.endTime) : '';
    const linked = trip.status !== 'settled'
      ? getLinkedPersonalExpenses(state.expenses, it.id, state.user.uid)
      : { total: 0 };

    return `
      <div data-open-itinerary="${esc(it.id)}" class="cursor-pointer bg-white rounded-2xl border border-slate-200 hover:border-teal-400 shadow-2xs p-4 space-y-2 transition">
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="px-2 py-0.5 rounded-md text-[11px] font-semibold ${meta.badgeCls}">${esc(meta.badge)}</span>
            <h4 class="font-bold text-slate-900 text-sm sm:text-base">${esc(meta.title)}</h4>
            ${meta.extraCount > 0 ? `<span class="px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[11px] font-medium">+${meta.extraCount} 備案</span>` : ''}
          </div>
          <span class="text-xs font-medium text-slate-500 shrink-0">
            ${formatTimeHHMM(it.startTime)}–${formatTimeHHMM(it.endTime)}
          </span>
        </div>
        ${dur ? `<p class="text-xs text-sky-700 font-medium">${esc(dur)}</p>` : ''}
        <div class="flex items-center justify-between gap-2 text-xs text-slate-500 flex-wrap">
          <span class="truncate">${esc(memberNamesList(trip, it.participantIds))}</span>
          ${linked.total > 0 ? `<span class="font-semibold text-teal-700 shrink-0">NT$${linked.total.toLocaleString()}</span>` : ''}
        </div>
      </div>
    `;
  };

  const renderOtherCard = (it) => {
    const meta = getEventDisplayTitle(it);
    return `
      <div data-open-itinerary="${esc(it.id)}" class="cursor-pointer bg-slate-100/90 hover:bg-slate-200/70 border border-dashed border-slate-300 rounded-xl p-3 space-y-1 transition text-slate-600">
        <div class="flex items-center justify-between gap-1.5">
          <span class="text-[11px] font-semibold text-slate-500">${esc(meta.badge)}・${formatTimeHHMM(it.startTime)}</span>
          <span class="text-[11px] text-slate-400">他人行程</span>
        </div>
        <p class="text-xs font-semibold text-slate-700 truncate">${esc(meta.title)}</p>
        <p class="text-[11px] text-slate-500 truncate">${esc(memberNamesList(trip, it.participantIds))}</p>
      </div>
    `;
  };

  return `
    <div class="relative">
      <!-- 時間軸節點圓點 -->
      <span class="absolute -left-[20px] sm:-left-[22px] top-4 w-3 h-3 rounded-full ring-4 ring-slate-50 ${hasPrimary ? 'bg-teal-600' : 'bg-slate-400'}"></span>

      <div class="grid grid-cols-1 md:grid-cols-12 gap-3 items-start">
        <!-- 左欄 65% (8/12)：個人主軸 -->
        <div class="${hasOthers ? 'md:col-span-8' : 'md:col-span-12'} space-y-2.5">
          ${hasPrimary
            ? slot.primaryEvents.map(renderPrimaryCard).join('')
            : `
              <div class="bg-slate-50 border border-dashed border-slate-300 rounded-2xl px-4 py-3 text-xs text-slate-500 flex items-center justify-between">
                <span>${esc(slot.startLabel)} 自由時間</span>
                <span>同時段有其他成員行程</span>
              </div>
            `}

          <!-- 手機版 (<768px)：細長灰底折疊膠囊 -->
          ${hasOthers ? `
            <div class="md:hidden">
              <button data-toggle-mobile-slot="${sIdx}" class="w-full text-left px-3.5 py-2 rounded-xl bg-slate-100 border border-dashed border-slate-300 text-xs text-slate-600 flex items-center justify-between">
                <span class="truncate">同時段他人行程：${esc(getEventDisplayTitle(others[0]).title)}${others.length > 1 ? ` 等 ${others.length} 筆` : ''}</span>
                <i data-lucide="${mobileOpen ? 'chevron-up' : 'chevron-down'}" class="w-3.5 h-3.5 shrink-0"></i>
              </button>
              ${mobileOpen ? `<div class="mt-2 space-y-2">${others.map(renderOtherCard).join('')}</div>` : ''}
            </div>
          ` : ''}
        </div>

        <!-- 桌機版 (>=768px)：右欄 35% (4/12) 灰底並行副軌 -->
        ${hasOthers ? `
          <div class="hidden md:block md:col-span-4 space-y-2">
            ${visibleDesktopOthers.map(renderOtherCard).join('')}
            ${others.length > 2 ? `
              <button data-toggle-desktop-slot="${sIdx}" class="w-full py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs text-slate-600 font-medium">
                ${desktopOpen ? '收合其他行程' : `＋ 展開其餘 ${others.length - 2} 筆`}
              </button>
            ` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

/* ============================= Tab 2: 統一帳務與分帳 ============================= */
function renderExpensesTab(trip) {
  if (trip.status === 'settled') {
    const myTotal = trip.memberTotalExpenses?.[state.user.uid] ?? 0;
    return `
      <div class="bg-white rounded-2xl border border-slate-200 p-6 text-center space-y-4">
        <div class="w-12 h-12 rounded-2xl bg-slate-100 text-slate-600 mx-auto flex items-center justify-center">
          <i data-lucide="archive" class="w-6 h-6"></i>
        </div>
        <div class="space-y-1">
          <h3 class="font-bold text-slate-900">本次旅行帳務已結算封存</h3>
          <p class="text-xs text-slate-500">逐筆明細已清理並留存 CSV 備份，行程足跡完整保留</p>
        </div>
        <div class="grid grid-cols-2 gap-3 max-w-md mx-auto pt-2">
          <div class="bg-teal-50 rounded-xl p-3.5">
            <p class="text-xs text-teal-700">你的本次總花費</p>
            <p class="text-xl font-bold text-teal-900 mt-1">NT$${Number(myTotal).toLocaleString()}</p>
          </div>
          <div class="bg-slate-50 rounded-xl p-3.5">
            <p class="text-xs text-slate-500">全團總開銷</p>
            <p class="text-xl font-bold text-slate-900 mt-1">NT$${Number(trip.totalExpenseTwd || 0).toLocaleString()}</p>
          </div>
        </div>
        ${trip.thankYouMessage ? `<p class="text-sm text-slate-700 bg-slate-50 rounded-xl p-3.5 max-w-md mx-auto">「${esc(trip.thankYouMessage)}」</p>` : ''}
      </div>
    `;
  }

  const calc = calculateSettlement(state.expenses, trip.activeMemberIds);
  const myTotal = calc.personalSpendMap[state.user.uid] || 0;

  return `
    <div class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-white rounded-2xl border border-slate-200 p-4">
          <div class="flex items-center justify-between">
            <p class="text-xs text-slate-500">你的本次總花費</p>
            <button data-help-section="5" class="text-slate-400 hover:text-teal-700" title="分帳與計算規則說明">
              <i data-lucide="info" class="w-4 h-4"></i>
            </button>
          </div>
          <p class="text-2xl font-bold text-teal-700 mt-1">NT$${myTotal.toLocaleString()}</p>
        </div>
        <div class="bg-white rounded-2xl border border-slate-200 p-4">
          <p class="text-xs text-slate-500">全團總開銷</p>
          <p class="text-2xl font-bold text-slate-900 mt-1">NT$${calc.totalExpenseTwd.toLocaleString()}</p>
        </div>
      </div>

      <div class="flex items-center justify-between">
        <h3 class="text-sm font-bold text-slate-800">消費明細 ${state.expenses.length} 筆</h3>
        <div class="flex items-center gap-2">
          ${state.expenses.length > 0 ? `<button id="btn-export-csv" class="px-3 py-2 rounded-xl glass-btn-subtle text-xs font-medium">匯出 CSV</button>` : ''}
          ${trip.status === 'active' ? `
            <button id="btn-new-expense" class="px-3.5 py-2 rounded-xl glass-btn-primary text-xs font-semibold flex items-center gap-1">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i>新增開銷
            </button>
          ` : `<span class="text-xs text-amber-700 font-medium">結帳收款中已凍結編輯</span>`}
        </div>
      </div>

      ${state.expenses.length === 0 ? `
        <div class="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">
          尚未有任何消費紀錄
        </div>
      ` : `
        <div class="space-y-2.5">
          ${state.expenses.map((exp) => {
            const canEdit = trip.status === 'active' && (isAdmin() || exp.createdBy === state.user.uid);
            const myShare = (exp.splits || []).find((s) => s.userId === state.user.uid)?.twdShare || 0;
            const linkedIt = exp.linkedItineraryId ? state.itineraries.find((i) => i.id === exp.linkedItineraryId) : null;
            return `
              <div class="bg-white rounded-2xl border border-slate-200 p-4 space-y-2">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="px-2 py-0.5 rounded-md text-[11px] font-semibold ${exp.isPersonalExpense ? 'bg-indigo-100 text-indigo-800' : 'bg-teal-100 text-teal-800'}">
                        ${exp.isPersonalExpense ? '個人自付' : '團體代墊'}
                      </span>
                      <h4 class="font-bold text-slate-900 text-sm">${esc(exp.title)}</h4>
                    </div>
                    <p class="text-xs text-slate-500 mt-1">
                      ${esc(exp.expenseDate)}｜付款：${esc(memberName(trip, exp.payerId))}
                      ${exp.currency && exp.originalAmount ? `｜${esc(exp.currency)} ${Number(exp.originalAmount).toLocaleString()}` : ''}
                      ${linkedIt ? `｜關聯：${esc(getEventDisplayTitle(linkedIt).title)}` : ''}
                    </p>
                  </div>
                  <div class="text-right shrink-0">
                    <p class="font-bold text-slate-900 text-sm">NT$${Number(exp.twdAmount).toLocaleString()}</p>
                    ${myShare > 0 ? `<p class="text-[11px] text-teal-700 font-medium">你分攤 NT$${myShare.toLocaleString()}</p>` : ''}
                  </div>
                </div>

                <div class="flex flex-wrap gap-1.5 pt-1">
                  ${(exp.splits || []).map((s) => `
                    <span class="px-2 py-0.5 rounded-md bg-slate-100 text-[11px] text-slate-600">
                      ${esc(memberName(trip, s.userId))} NT$${s.twdShare}${s.isRoundedUp ? ' +1' : ''}
                    </span>
                  `).join('')}
                </div>

                ${canEdit ? `
                  <div class="flex justify-end gap-2 pt-1 border-t border-slate-100">
                    <button data-edit-expense="${esc(exp.id)}" class="text-xs text-slate-500 hover:text-teal-700 font-medium">編輯</button>
                    <button data-delete-expense="${esc(exp.id)}" class="text-xs text-rose-500 hover:text-rose-700 font-medium">刪除</button>
                  </div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
  `;
}

/* ============================= Tab 3: 三階段結帳與收款確認 ============================= */
function renderSettlementTab(trip) {
  const calc = calculateSettlement(state.expenses, trip.activeMemberIds);

  if (trip.status === 'settled') {
    return `
      <div class="bg-white rounded-2xl border border-slate-200 p-6 text-center space-y-2">
        <p class="text-sm font-bold text-slate-900">全團款項皆已收訖並完成封存</p>
        <p class="text-xs text-slate-500">封存總開銷：NT$${Number(trip.totalExpenseTwd || 0).toLocaleString()}</p>
        ${trip.thankYouMessage ? `<p class="text-sm text-teal-800 pt-2">「${esc(trip.thankYouMessage)}」</p>` : ''}
      </div>
    `;
  }

  if (trip.status === 'active') {
    return `
      <div class="space-y-4">
        <div class="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-bold text-slate-900">即時試算轉帳清單</h3>
              <button data-help-section="6" class="text-slate-400 hover:text-teal-700" title="結帳與封存說明">
                <i data-lucide="info" class="w-4 h-4"></i>
              </button>
            </div>
            ${isAdmin() ? `
              <button id="btn-start-settling" class="px-3.5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold">
                進入結帳階段
              </button>
            ` : ''}
          </div>

          ${calc.transfers.length === 0 ? `
            <p class="text-xs text-slate-500 py-4 text-center">目前無待轉帳款項</p>
          ` : `
            <div class="space-y-2">
              ${calc.transfers.map((tr) => `
                <div class="flex items-center justify-between p-3 rounded-xl bg-slate-50 text-sm">
                  <span class="font-medium text-slate-800">${esc(memberName(trip, tr.fromUserId))} ➔ ${esc(memberName(trip, tr.toUserId))}</span>
                  <span class="font-bold text-teal-700">NT$${tr.amountTwd.toLocaleString()}</span>
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <div class="bg-white rounded-2xl border border-slate-200 p-4 space-y-2">
          <h4 class="text-xs font-semibold text-slate-500">各成員淨額總覽</h4>
          <div class="grid sm:grid-cols-2 gap-2">
            ${(trip.activeMemberIds || []).map((uid) => {
              const bal = calc.netMap[uid] || 0;
              return `
                <div class="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-50 text-xs">
                  <span class="font-medium text-slate-700">${esc(memberName(trip, uid))}</span>
                  <span class="font-bold ${bal > 0 ? 'text-teal-700' : bal < 0 ? 'text-rose-600' : 'text-slate-500'}">
                    ${bal > 0 ? `應收 NT$${bal.toLocaleString()}` : bal < 0 ? `應付 NT$${Math.abs(bal).toLocaleString()}` : '已結清'}
                  </span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  }

  // status === 'settling'
  const totalCount = state.transfers.length;
  const confirmedCount = state.transfers.filter((t) => t.status === 'confirmed').length;
  const allConfirmed = totalCount === 0 || confirmedCount === totalCount;
  const pct = totalCount === 0 ? 100 : Math.round((confirmedCount / totalCount) * 100);

  return `
    <div class="space-y-4">
      <div class="bg-white rounded-2xl border border-amber-200 p-4 space-y-3">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-bold text-slate-900">結帳收款進度</h3>
            <span class="text-xs font-semibold text-amber-700">${confirmedCount} / ${totalCount} 筆已確認</span>
          </div>
          ${isAdmin() ? `
            <div class="flex items-center gap-2">
              <button id="btn-revert-active" class="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-medium text-slate-700">退回記帳中</button>
              <button id="btn-open-archive" ${allConfirmed ? '' : 'disabled'} class="px-3.5 py-1.5 rounded-xl text-xs font-semibold ${allConfirmed ? 'bg-teal-600 hover:bg-teal-700 text-white' : 'bg-slate-200 text-slate-400 cursor-not-allowed'}">
                封存旅行
              </button>
            </div>
          ` : ''}
        </div>
        <div class="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
          <div class="h-full bg-teal-600 transition-all" style="width:${pct}%"></div>
        </div>

        <div class="space-y-2.5 pt-1">
          ${state.transfers.length === 0 ? `<p class="text-xs text-slate-500 text-center py-4">無待轉帳款項，可直接封存</p>` : state.transfers.map((tr) => {
            const isPayee = tr.toUserId === state.user.uid;
            const confirmed = tr.status === 'confirmed';
            return `
              <div class="p-3.5 rounded-xl border ${confirmed ? 'bg-emerald-50/50 border-emerald-200' : 'bg-slate-50 border-slate-200'} flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <p class="text-sm font-bold text-slate-900">${esc(memberName(trip, tr.fromUserId))} ➔ ${esc(memberName(trip, tr.toUserId))}</p>
                  <p class="text-xs font-semibold text-teal-700 mt-0.5">NT$${Number(tr.amountTwd).toLocaleString()}</p>
                </div>
                <div class="flex items-center gap-2">
                  ${confirmed ? `
                    <span class="px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-800 text-xs font-semibold">✓ 已收款</span>
                    ${isAdmin() ? `<button data-unlock-transfer="${esc(tr.id)}" class="text-xs text-slate-500 hover:text-rose-600">退回待收款</button>` : ''}
                  ` : isPayee ? `
                    <button data-remind-transfer="${esc(tr.id)}" class="px-3 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-100 text-xs font-medium text-slate-700">提醒繳款</button>
                    <button data-confirm-transfer="${esc(tr.id)}" class="px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold">確認收款</button>
                  ` : `<span class="text-xs text-amber-700 font-medium">待收款人確認</span>`}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
}

/* ============================= Tab 4: 管理員設定（歸戶與住宿分房） ============================= */
function renderAdminTab(trip) {
  const activeSet = new Set(trip.activeMemberIds || []);
  const dates = getTripDateRange(trip.startDate, trip.endDate);
  const staysByDate = {};
  state.itineraries.filter((i) => i.type === 'accommodation').forEach((s) => { staysByDate[s.stayDate] = s; });

  return `
    <div class="space-y-5">
      <!-- 1. 旅行歸戶成員管理 -->
      <div class="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
        <h3 class="text-sm font-bold text-slate-900">旅行成員歸戶</h3>
        <div class="grid sm:grid-cols-2 gap-2">
          ${state.allUsers.map((u) => {
            const checked = activeSet.has(u.id);
            return `
              <label class="flex items-center justify-between p-2.5 rounded-xl border ${checked ? 'border-teal-300 bg-teal-50/40' : 'border-slate-200'} cursor-pointer text-xs">
                <div>
                  <p class="font-semibold text-slate-800">${esc(u.displayName)}</p>
                  <p class="text-[11px] text-slate-500">${esc(u.email)}</p>
                </div>
                <input type="checkbox" data-member-checkbox="${esc(u.id)}" ${checked ? 'checked' : ''} class="w-4 h-4 accent-teal-600" />
              </label>
            `;
          }).join('')}
        </div>
        <button id="btn-save-members" class="px-4 py-2 rounded-xl glass-btn-primary text-xs font-semibold">儲存歸戶名單</button>
      </div>

      <!-- 2. 按晚住宿與分房管理 -->
      <div class="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-bold text-slate-900">住宿按晚分房與房號</h3>
          <button id="btn-manage-rooms" class="px-3 py-1.5 rounded-xl glass-btn-primary text-xs font-semibold">＋ 新增/編輯房間</button>
        </div>
        <div class="space-y-2">
          ${dates.map((d, idx) => {
            const s = staysByDate[d];
            return `
              <div class="p-3 rounded-xl bg-slate-50 flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <p class="text-xs font-bold text-slate-800">D${idx + 1} ${formatShortDateWithWeekday(d)}｜${esc(s ? s.title : '尚未設定飯店')}</p>
                  ${s ? `<p class="text-[11px] text-slate-500 truncate mt-0.5">${(s.rooms || []).map((r) => `${r.roomNo}：${memberNamesList(trip, r.occupantIds)}`).join(' ／ ')}</p>` : ''}
                </div>
                <button data-edit-stay-date="${d}" class="shrink-0 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-100 text-xs font-medium text-slate-700">編輯</button>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <!-- 3. 刪除整趟旅行（僅管理員） -->
      <div class="bg-white rounded-2xl border border-rose-200 p-4 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <h3 class="text-sm font-bold text-rose-700">刪除整趟旅行</h3>
          <p class="text-xs text-slate-500 mt-0.5">將一併清除所有行程、分帳、結算與報平安紀錄，無法復原</p>
        </div>
        <button id="btn-delete-current-trip" class="shrink-0 px-3.5 py-2 rounded-xl glass-btn-danger text-xs font-semibold">刪除此旅行</button>
      </div>
    </div>
  `;
}

/* ============================= 彈窗系統 ============================= */
function renderModal() {
  if (!state.modal) return '';
  const { type, data } = state.modal;
  let body = '';

  if (type === 'help') body = renderHelpModalContent();
  else if (type === 'pwa') body = renderPwaModalContent(data);
  else if (type === 'profile') body = renderProfileModalContent();
  else if (type === 'createTrip') body = renderCreateTripModalContent();
  else if (type === 'accommodationView') body = renderAccommodationModalContent(data);
  else if (type === 'accommodationEdit') body = renderAccommodationEditModalContent(data);
  else if (type === 'itineraryDetail') body = renderItineraryDetailModalContent(data);
  else if (type === 'itineraryForm') body = renderItineraryFormModalContent(data);
  else if (type === 'expenseForm') body = renderExpenseFormModalContent(data);
  else if (type === 'archive') body = renderArchiveModalContent();
  else if (type === 'deletionReview') body = renderDeletionReviewModalContent();

  const isFreshOpen = !state.lastModalType;
  const isSwitchFlip = Boolean(state.lastModalType && state.lastModalType !== type);
  const panelAnimCls = isFreshOpen
    ? 'td-modal-panel-enter'
    : isSwitchFlip
    ? 'td-modal-panel-flip'
    : '';

  return `
    <div id="modal-backdrop" class="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-[2px] flex items-center justify-center p-3 sm:p-4 td-modal-stage ${isFreshOpen ? 'td-modal-backdrop-enter' : ''}">
      <div id="modal-panel" class="td-modal-panel bg-white w-full sm:max-w-xl rounded-3xl max-h-[84dvh] flex flex-col shadow-2xl overflow-hidden ${panelAnimCls}">
        ${body}
      </div>
    </div>
  `;
}

function modalHeader(title) {
  return `
    <div class="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between shrink-0">
      <h3 class="font-bold text-slate-900 text-base truncate">${esc(title)}</h3>
      <button id="btn-close-modal" class="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700">
        <i data-lucide="x" class="w-4 h-4"></i>
      </button>
    </div>
  `;
}

/* ----------------------------- Modal: [i] 內建說明書 ----------------------------- */
function renderHelpModalContent() {
  let md = state.userGuideMd || '';
  if (!isAdmin()) {
    md = md.split('## 7. 管理員專屬操作指南')[0];
  }
  const html = typeof marked !== 'undefined' ? marked.parse(md) : `<pre>${esc(md)}</pre>`;
  return `
    ${modalHeader('使用說明')}
    <div id="help-md-body" class="p-5 overflow-y-auto td-modal-scroll prose prose-sm prose-slate max-w-none">
      ${html}
    </div>
  `;
}

/* ----------------------------- Modal: 加入主畫面教學與推播 ----------------------------- */
function renderPwaModalContent(data) {
  const env = detectEnvironment();
  const tab = data?.tab || (env.isAndroid ? 'android' : 'ios');
  return `
    ${modalHeader('加入主畫面與推播設定')}
    <div class="p-5 overflow-y-auto td-modal-scroll space-y-4 text-sm">
      ${env.isInAppBrowser ? `
        <div class="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs leading-relaxed">
          偵測到你正在使用 LINE 或社群 App 內建瀏覽器，請先點擊畫面角落選單選擇<strong>以 Safari 或 Chrome 開啟</strong>，再依下方步驟加入主畫面。
        </div>
      ` : ''}

      ${env.permission === 'denied' ? `
        <div class="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 text-xs leading-relaxed">
          通知權限目前已遭封鎖。請前往手機<strong>設定 → 通知 → TripDock</strong> 重新開啟允許通知。
        </div>
      ` : ''}

      <div class="grid grid-cols-2 bg-slate-100 p-1 rounded-xl text-xs font-semibold">
        <button data-pwa-tab="ios" class="py-2 rounded-lg ${tab === 'ios' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'}">iPhone / iPad</button>
        <button data-pwa-tab="android" class="py-2 rounded-lg ${tab === 'android' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'}">Android</button>
      </div>

      ${tab === 'ios' ? `
        <ol class="space-y-3 text-xs text-slate-700 leading-relaxed">
          <li class="flex gap-2.5"><span class="w-5 h-5 rounded-full bg-teal-600 text-white shrink-0 flex items-center justify-center font-bold text-[11px]">1</span><span>確認使用 <strong>Safari</strong> 瀏覽器開啟 TripDock。</span></li>
          <li class="flex gap-2.5"><span class="w-5 h-5 rounded-full bg-teal-600 text-white shrink-0 flex items-center justify-center font-bold text-[11px]">2</span><span>點擊畫面底部工具列正中央的 <strong>分享圖示</strong>（方框加向上箭頭）。</span></li>
          <li class="flex gap-2.5"><span class="w-5 h-5 rounded-full bg-teal-600 text-white shrink-0 flex items-center justify-center font-bold text-[11px]">3</span><span>選單向下滑動並點選 <strong>加入主畫面</strong>，接著按右上角 <strong>新增</strong>。</span></li>
          <li class="flex gap-2.5"><span class="w-5 h-5 rounded-full bg-teal-600 text-white shrink-0 flex items-center justify-center font-bold text-[11px]">4</span><span>回到桌面點開剛建立的 <strong>TripDock 圖示</strong>，再點選 <strong>開啟推播通知 → 允許</strong> 即完成訂閱。</span></li>
        </ol>
      ` : `
        <ol class="space-y-3 text-xs text-slate-700 leading-relaxed">
          <li class="flex gap-2.5"><span class="w-5 h-5 rounded-full bg-teal-600 text-white shrink-0 flex items-center justify-center font-bold text-[11px]">1</span><span>使用 <strong>Chrome</strong> 瀏覽器開啟 TripDock。</span></li>
          <li class="flex gap-2.5"><span class="w-5 h-5 rounded-full bg-teal-600 text-white shrink-0 flex items-center justify-center font-bold text-[11px]">2</span><span>點擊下方一鍵安裝，或點右上角 <strong>⋮ 選單 → 加到主畫面 / 安裝應用程式</strong>。</span></li>
          <li class="flex gap-2.5"><span class="w-5 h-5 rounded-full bg-teal-600 text-white shrink-0 flex items-center justify-center font-bold text-[11px]">3</span><span>安裝開啟後點選 <strong>開啟推播通知 → 允許</strong> 即完成訂閱。</span></li>
        </ol>
        ${state.deferredInstallPrompt ? `<button id="btn-android-install" class="w-full py-2.5 rounded-xl bg-teal-600 text-white text-xs font-semibold">一鍵安裝到主畫面</button>` : ''}
      `}
    </div>
  `;
}

/* ----------------------------- Modal: 個人資料與登出 ----------------------------- */
function renderProfileModalContent() {
  const pendingCount = isAdmin()
    ? state.allUsers.filter((u) => u.role !== 'admin' && u.deletionRequested === true).length
    : 0;
  const hasDeletionReq = Boolean(state.profile?.deletionRequested);

  return `
    ${modalHeader('帳號設定')}
    <div class="p-5 overflow-y-auto td-modal-scroll space-y-5">
      <form id="form-profile-name" class="space-y-2.5">
        <label class="block text-xs font-semibold text-slate-700">顯示名稱</label>
        <div class="flex gap-2">
          <input name="displayName" required value="${esc(state.profile?.displayName || '')}" class="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm" />
          <button type="submit" class="px-4 py-2 rounded-xl glass-btn-primary text-xs font-semibold">更新</button>
        </div>
      </form>

      <form id="form-profile-pwd" class="space-y-2.5 pt-3 border-t border-slate-100">
        <label class="block text-xs font-semibold text-slate-700">修改密碼</label>
        <input name="oldPassword" type="password" required placeholder="目前密碼" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
        <input name="newPassword" type="password" required minlength="6" placeholder="新密碼，至少 6 位" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
        <button type="submit" class="px-4 py-2 rounded-xl bg-slate-800 text-white text-xs font-semibold">變更密碼</button>
      </form>

      ${isAdmin() ? `
        <div class="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
          <div>
            <p class="text-xs font-semibold text-slate-700">成員帳號刪除審核</p>
            <p class="text-[11px] text-slate-500 mt-0.5">${pendingCount > 0 ? `目前有 ${pendingCount} 筆待審核申請` : '目前沒有待審核的刪除申請'}</p>
          </div>
          <button id="btn-profile-deletion-review" class="px-3.5 py-2 rounded-xl ${pendingCount > 0 ? 'glass-btn-primary' : 'glass-btn-subtle'} text-xs font-semibold shrink-0">
            檢視審核${pendingCount > 0 ? ` ${pendingCount}` : ''}
          </button>
        </div>
      ` : `
        <div class="pt-3 border-t border-slate-100 space-y-2.5">
          ${hasDeletionReq ? `
            <div class="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-xs font-bold text-amber-900">已送出刪除帳號申請</p>
                <p class="text-[11px] text-amber-700 mt-0.5">等待管理員確認帳務並審核移除</p>
              </div>
              <button id="btn-cancel-deletion" class="shrink-0 px-3 py-1.5 rounded-xl bg-white border border-amber-300 text-amber-900 text-xs font-semibold">取消申請</button>
            </div>
          ` : `
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-xs font-semibold text-rose-700">刪除帳號</p>
                <p class="text-[11px] text-slate-500 mt-0.5">送出後將通知管理員審核移除</p>
              </div>
              <button id="btn-request-deletion" class="shrink-0 px-3.5 py-2 rounded-xl glass-btn-danger text-xs font-semibold">申請刪除帳號</button>
            </div>
          `}
        </div>
      `}

      <div class="pt-3 border-t border-slate-100 flex items-center justify-between">
        <span class="text-xs text-slate-500 truncate">${esc(state.profile?.email)}｜${isAdmin() ? '管理員' : '一般成員'}</span>
        <button id="btn-logout" class="shrink-0 px-3.5 py-2 rounded-xl bg-rose-50 text-rose-700 hover:bg-rose-100 text-xs font-semibold">登出</button>
      </div>
    </div>
  `;
}

/* ----------------------------- Modal: 管理員審核刪除帳號 ----------------------------- */
function renderDeletionReviewModalContent() {
  const pending = state.allUsers.filter((u) => u.role !== 'admin' && u.deletionRequested === true);

  return `
    ${modalHeader('帳號刪除審核')}
    <div class="p-5 overflow-y-auto td-modal-scroll space-y-4">
      ${pending.length === 0 ? `
        <div class="py-8 text-center space-y-1.5">
          <p class="text-sm font-semibold text-slate-700">目前沒有待審核的刪除申請</p>
          <p class="text-xs text-slate-400">一般成員提出申請時會透過推播通知你</p>
        </div>
      ` : pending.map((u) => {
        const settlingTrips = state.trips.filter(
          (t) => t.status === 'settling' && (t.activeMemberIds || []).includes(u.id)
        );
        const activeTrips = state.trips.filter(
          (t) => t.status === 'active' && (t.activeMemberIds || []).includes(u.id)
        );

        return `
          <div class="p-4 rounded-2xl border border-slate-200 bg-slate-50/70 space-y-3">
            <div>
              <p class="text-sm font-bold text-slate-900">${esc(u.displayName || '成員')}</p>
              <p class="text-xs text-slate-500 mt-0.5">${esc(u.email)}</p>
            </div>

            ${settlingTrips.length > 0 ? `
              <div class="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 space-y-1">
                <p class="font-bold">尚有結帳收款中的旅行，建議確認帳務結清後再移除</p>
                <p>${esc(settlingTrips.map((t) => t.name).join('、'))}</p>
              </div>
            ` : ''}

            ${activeTrips.length > 0 ? `
              <div class="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
                進行中旅行：${esc(activeTrips.map((t) => t.name).join('、'))}
              </div>
            ` : ''}

            <p class="text-[11px] text-slate-500 leading-relaxed">
              核准後會徹底刪除該登入帳號，並自各旅行歸戶名單移出，歷史足跡與封存帳務仍會保留其舊顯示名稱。
            </p>

            <div class="flex items-center justify-end gap-2 pt-1">
              <button data-review-deletion="reject" data-target-uid="${esc(u.id)}" class="px-3.5 py-2 rounded-xl glass-btn-subtle text-xs font-semibold">駁回申請</button>
              <button data-review-deletion="approve" data-target-uid="${esc(u.id)}" class="px-3.5 py-2 rounded-xl glass-btn-danger text-xs font-semibold">核准移除</button>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/* ----------------------------- Modal: 管理員建立旅行 ----------------------------- */
function renderCreateTripModalContent() {
  return `
    ${modalHeader('建立新旅行')}
    <form id="form-create-trip" class="p-5 overflow-y-auto td-modal-scroll space-y-3.5">
      <div>
        <label class="block text-xs font-medium text-slate-600 mb-1">旅行名稱</label>
        <input name="name" required class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div class="min-w-0">
          <label class="block text-xs font-medium text-slate-600 mb-1">出發日期</label>
          <input name="startDate" type="date" required class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white" />
        </div>
        <div class="min-w-0">
          <label class="block text-xs font-medium text-slate-600 mb-1">結束日期</label>
          <input name="endDate" type="date" required class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white" />
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">旅行地點</label>
          <input name="location" required class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">目標時區</label>
          <select name="timezone" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white">
            <option value="Asia/Taipei" selected>台灣・香港・新加坡 UTC+8</option>
            <option value="Asia/Tokyo">日本・韓國 UTC+9</option>
            <option value="Asia/Bangkok">泰國・越南 UTC+7</option>
            <option value="Asia/Makassar">峇里島 UTC+8</option>
            <option value="Europe/Paris">中歐 UTC+1</option>
            <option value="Europe/London">英國 UTC+0</option>
          </select>
        </div>
      </div>
      <button type="submit" class="w-full py-2.5 rounded-xl glass-btn-primary text-sm font-semibold">建立旅行</button>
    </form>
  `;
}

/* ----------------------------- Modal: 住宿各天分房檢視 ----------------------------- */
function renderAccommodationModalContent(data) {
  const trip = activeTrip();
  const stays = state.itineraries
    .filter((i) => i.type === 'accommodation' && i.stayDate)
    .sort((a, b) => a.stayDate.localeCompare(b.stayDate));
  const selectedStayDate = data?.stayDate || stays[0]?.stayDate;
  const stay = stays.find((s) => s.stayDate === selectedStayDate) || stays[0];
  const linked = stay && trip.status !== 'settled'
    ? getLinkedPersonalExpenses(state.expenses, stay.id, state.user.uid)
    : { items: [], total: 0 };

  return `
    ${modalHeader('住宿分房資訊')}
    <div class="p-5 overflow-y-auto td-modal-scroll space-y-4">
      <div class="flex gap-1.5 overflow-x-auto no-scrollbar">
        ${stays.map((s, idx) => `
          <button data-switch-stay="${esc(s.stayDate)}" class="px-3 py-1.5 rounded-xl text-xs font-semibold shrink-0 ${
            s.stayDate === stay?.stayDate ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'
          }">D${idx + 1} ${formatShortDateWithWeekday(s.stayDate)}</button>
        `).join('')}
      </div>

      ${stay ? `
        <div class="space-y-3">
          <div class="flex items-center justify-between gap-2">
            <h4 class="font-bold text-slate-900 text-base">${esc(stay.title)}</h4>
            <a href="${esc(buildGoogleMapsUrl(stay.mapsUrl || stay.title))}" target="_blank" rel="noopener" class="px-2.5 py-1 rounded-lg bg-slate-100 text-xs font-medium text-teal-700">開啟地圖</a>
          </div>
          <div class="space-y-2">
            ${(stay.rooms || []).map((r) => {
              const isMine = (r.occupantIds || []).includes(state.user.uid);
              return `
                <div class="p-3 rounded-xl border ${isMine ? 'bg-teal-50/60 border-teal-300' : 'bg-slate-50 border-slate-200'} flex items-center justify-between gap-2">
                  <span class="font-bold text-sm text-slate-900">${esc(r.roomNo)}</span>
                  <span class="text-xs text-slate-600">${esc(memberNamesList(trip, r.occupantIds))}</span>
                </div>
              `;
            }).join('')}
          </div>
          ${renderLinkedExpensesBox(trip, stay.id, stay.title, linked)}
        </div>
      ` : `<p class="text-xs text-slate-500">尚未設定住宿資料</p>`}
    </div>
  `;
}

/* ----------------------------- Modal: 管理員編輯當晚住宿與房號 ----------------------------- */
function renderAccommodationEditModalContent(data) {
  const trip = activeTrip();
  const dates = getTripDateRange(trip.startDate, trip.endDate);
  const stayDate = data?.stayDate || dates[0];
  const existing = state.itineraries.find((i) => i.type === 'accommodation' && i.stayDate === stayDate);
  const prevIdx = dates.indexOf(stayDate) - 1;
  const prevStay = prevIdx >= 0 ? state.itineraries.find((i) => i.type === 'accommodation' && i.stayDate === dates[prevIdx]) : null;
  const rooms = data?.draftRooms || (existing?.rooms?.length ? existing.rooms : [{ roomId: 'rm_1', roomNo: 'A房', occupantIds: [] }]);
  const titleVal = data?.draftTitle ?? existing?.title ?? '';
  const mapsVal = data?.draftMapsUrl ?? existing?.mapsUrl ?? '';

  return `
    ${modalHeader(`編輯住宿與房號｜${formatShortDateWithWeekday(stayDate)}`)}
    <form id="form-edit-accommodation" class="p-5 overflow-y-auto td-modal-scroll space-y-4">
      <input type="hidden" name="stayDate" value="${esc(stayDate)}" />
      <input type="hidden" name="existingId" value="${esc(existing?.id || '')}" />

      ${prevStay ? `
        <button type="button" id="btn-copy-prev-stay" class="w-full py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-semibold text-slate-700">
          複製前一晚分房：${esc(prevStay.title)}
        </button>
      ` : ''}

      <div>
        <label class="block text-xs font-medium text-slate-600 mb-1">飯店名稱</label>
        <input name="title" required value="${esc(titleVal)}" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
      </div>
      <div>
        <label class="block text-xs font-medium text-slate-600 mb-1">Google Maps 連結</label>
        <input name="mapsUrl" value="${esc(mapsVal)}" placeholder="選填" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
      </div>

      <div class="space-y-2.5">
        <div class="flex items-center justify-between">
          <label class="text-xs font-semibold text-slate-700">房間分配</label>
          <button type="button" id="btn-add-room-row" class="text-xs font-semibold text-teal-700">＋ 增加房間</button>
        </div>
        ${rooms.map((r, rIdx) => `
          <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <div class="flex items-center gap-2">
              <input data-room-no="${rIdx}" value="${esc(r.roomNo)}" placeholder="預排代號或房號" class="flex-1 px-3 py-1.5 rounded-lg border border-slate-200 text-sm bg-white" />
              ${rooms.length > 1 ? `<button type="button" data-del-room-row="${rIdx}" class="text-xs text-rose-500">移除</button>` : ''}
            </div>
            <div class="flex flex-wrap gap-2">
              ${(trip.activeMemberIds || []).map((uid) => `
                <label class="inline-flex items-center gap-1 text-xs bg-white px-2.5 py-1 rounded-lg border border-slate-200 cursor-pointer">
                  <input type="checkbox" data-room-occ="${rIdx}" value="${esc(uid)}" ${(r.occupantIds || []).includes(uid) ? 'checked' : ''} class="accent-teal-600" />
                  <span>${esc(memberName(trip, uid))}</span>
                </label>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>

      <label class="flex items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" name="applyConsecutive" class="accent-teal-600" />
        <span>同步套用至後續連住同飯店晚數</span>
      </label>

      <button type="submit" class="w-full py-2.5 rounded-xl glass-btn-primary text-sm font-semibold">儲存住宿分房</button>
    </form>
  `;
}

/* ----------------------------- Modal: 單筆行程明細（餐食 / 交通 / 景點） ----------------------------- */
function renderLinkedExpensesBox(trip, itineraryId, defaultTitle, linked) {
  return `
    <div class="pt-3 border-t border-slate-100 space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-semibold text-slate-700">你的相關款項${linked.total > 0 ? `：NT$${linked.total.toLocaleString()}` : ''}</span>
        ${trip.status === 'active' ? `
          <button data-quick-expense="${esc(itineraryId)}" data-quick-title="${esc(defaultTitle)}" class="px-2.5 py-1 rounded-xl glass-btn-teal-soft text-xs font-semibold">
            ＋ 記錄相關花費
          </button>
        ` : ''}
      </div>
      ${linked.items.length > 0 ? `
        <div class="space-y-1">
          ${linked.items.map((item) => `
            <div class="flex items-center justify-between text-xs px-3 py-1.5 rounded-lg bg-slate-50">
              <span class="text-slate-700">${esc(item.title)}</span>
              <span class="font-semibold text-slate-900">NT$${item.twdShare.toLocaleString()}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderItineraryDetailModalContent(data) {
  const trip = activeTrip();
  const it = state.itineraries.find((i) => i.id === data.itineraryId);
  if (!it) return `${modalHeader('行程已不存在')}`;

  const meta = getEventDisplayTitle(it);
  const linked = trip.status !== 'settled'
    ? getLinkedPersonalExpenses(state.expenses, it.id, state.user.uid)
    : { items: [], total: 0 };

  let specificHtml = '';

  if (it.type === 'dining') {
    const opts = it.mealOptions || [];
    specificHtml = `
      <div class="space-y-2.5">
        ${opts.map((opt) => `
          <div class="p-3.5 rounded-xl border ${opt.isPrimary ? 'border-teal-300 bg-teal-50/40' : 'border-slate-200 bg-slate-50/60'} space-y-1.5">
            <div class="flex items-start justify-between gap-2">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="text-xs font-bold ${opt.isPrimary ? 'text-teal-700' : 'text-slate-400'}">${opt.isPrimary ? '★' : '○'}</span>
                <span data-toggle-strike="${esc(opt.optionId)}" class="cursor-pointer font-bold text-sm ${opt.isStruckOut ? 'line-through text-slate-400' : 'text-slate-900'}">${esc(opt.name)}</span>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                ${opt.mapsUrl || opt.name ? `<a href="${esc(buildGoogleMapsUrl(opt.mapsUrl || opt.name))}" target="_blank" rel="noopener" class="text-xs text-teal-700 font-medium">地圖</a>` : ''}
                ${!opt.isPrimary ? `<button data-pick-meal="${esc(opt.optionId)}" class="px-2.5 py-1 rounded-lg bg-teal-600 text-white text-xs font-semibold">改吃這間</button>` : ''}
              </div>
            </div>
            <p class="text-xs text-slate-600">
              ${opt.openingHours ? `營業：${esc(opt.openingHours)}｜` : ''}${opt.reservationType === 'reservable' ? '可訂位' : '現場排隊'}
            </p>
            ${opt.reservationType === 'reservable' && (opt.reservedBy || opt.reservationTime) ? `
              <p class="text-xs text-slate-700">
                ${opt.reservedBy ? `訂位人：${esc(memberName(trip, opt.reservedBy))}` : ''}
                ${opt.reservedBy && opt.reservationTime ? '｜' : ''}
                ${opt.reservationTime ? `訂位時間：${esc(opt.reservationTime)}` : ''}
              </p>
            ` : ''}
            ${opt.note ? `<p class="text-xs text-slate-500">${esc(opt.note)}</p>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  } else if (it.type === 'transport') {
    const dur = formatDuration(it.startTime, it.endTime);
    specificHtml = `
      <div class="space-y-2 text-xs text-slate-700 bg-slate-50 rounded-xl p-4">
        ${it.origin || it.destination ? `
          <p class="text-sm font-bold text-slate-900">${esc(it.origin || '')} ➔ ${esc(it.destination || '')}</p>
        ` : ''}
        <p>時間：${formatTimeHHMM(it.startTime)} ➔ ${formatTimeHHMM(it.endTime)}${dur ? `｜${esc(dur)}` : ''}</p>
        ${it.transportMode === 'flight' && it.flightDetails ? `
          ${it.flightDetails.flightNo ? `<p>航班編號：${esc(it.flightDetails.flightNo)}</p>` : ''}
          ${it.flightDetails.departureTerminal || it.flightDetails.arrivalTerminal ? `<p>航廈：${esc(it.flightDetails.departureTerminal || '-')} ➔ ${esc(it.flightDetails.arrivalTerminal || '-')}</p>` : ''}
          ${it.flightDetails.baggageAllowance ? `<p>托運行李：${esc(it.flightDetails.baggageAllowance)}</p>` : ''}
        ` : ''}
        ${it.transportMode === 'transit' ? `
          ${it.serviceNo ? `<p>班次：${esc(it.serviceNo)}</p>` : ''}
          ${it.ticketingMethods?.length ? `<p>驗票方式：${esc(it.ticketingMethods.join('、'))}</p>` : ''}
        ` : ''}
        ${it.transportMode === 'car' && it.carDetails ? `
          ${it.carDetails.driverName ? `<p>駕駛：${esc(it.carDetails.driverName)}</p>` : ''}
          ${it.carDetails.plateNo ? `<p>車牌：${esc(it.carDetails.plateNo)}</p>` : ''}
        ` : ''}
        <div class="flex gap-3 pt-1">
          ${it.originMapsUrl ? `<a href="${esc(buildGoogleMapsUrl(it.originMapsUrl))}" target="_blank" rel="noopener" class="text-teal-700 font-medium">出發地地圖</a>` : ''}
          ${it.destinationMapsUrl ? `<a href="${esc(buildGoogleMapsUrl(it.destinationMapsUrl))}" target="_blank" rel="noopener" class="text-teal-700 font-medium">目的地地圖</a>` : ''}
        </div>
      </div>
    `;
  } else {
    specificHtml = `
      <div class="space-y-2 text-xs text-slate-700 bg-slate-50 rounded-xl p-4">
        <p>時間：${formatTimeHHMM(it.startTime)} – ${formatTimeHHMM(it.endTime)}</p>
        ${it.location ? `
          <div class="flex items-center justify-between gap-2">
            <span>地點：${esc(it.location)}</span>
            <a href="${esc(buildGoogleMapsUrl(it.location))}" target="_blank" rel="noopener" class="text-teal-700 font-medium shrink-0">開啟地圖</a>
          </div>
        ` : ''}
      </div>
    `;
  }

  return `
    ${modalHeader(`${meta.badge}｜${meta.title}`)}
    <div class="p-5 overflow-y-auto td-modal-scroll space-y-4">
      ${specificHtml}
      <p class="text-xs text-slate-600">成員：${esc(memberNamesList(trip, it.participantIds))}</p>
      ${it.description ? `<p class="text-xs text-slate-600 whitespace-pre-line bg-slate-50 rounded-xl p-3">${esc(it.description)}</p>` : ''}
      ${renderLinkedExpensesBox(trip, it.id, meta.title, linked)}
      <div class="flex justify-end gap-2 pt-2 border-t border-slate-100">
        <button data-edit-itinerary="${esc(it.id)}" class="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-xs font-semibold text-slate-700">編輯</button>
        <button data-delete-itinerary="${esc(it.id)}" class="px-3.5 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-xs font-semibold text-rose-600">刪除</button>
      </div>
    </div>
  `;
}

/* ----------------------------- Modal: 新增 / 編輯行程表單 ----------------------------- */
function renderItineraryFormModalContent(data) {
  const trip = activeTrip();
  const editing = data?.itinerary || null;
  const fType = data?.type || editing?.type || 'attraction';
  const tMode = data?.transportMode || editing?.transportMode || 'transit';
  const dateKey = data?.dateKey || editing?.dateKey || state.selectedDate || trip.startDate;
  const startVal = editing ? formatTimeHHMM(editing.startTime) : '12:00';
  const endVal = editing ? formatTimeHHMM(editing.endTime) : '13:30';
  const participants = editing?.participantIds || trip.activeMemberIds || [];
  const mealOptions = data?.draftMealOptions || editing?.mealOptions || [
    { optionId: 'opt_' + Date.now(), name: '', mapsUrl: '', openingHours: '', reservationType: 'walk_in', reservedBy: '', reservationTime: '', isPrimary: true, isStruckOut: false, note: '' }
  ];

  return `
    ${modalHeader(editing ? '編輯行程' : '新增行程')}
    <form id="form-itinerary" class="p-5 overflow-y-auto td-modal-scroll space-y-4">
      <input type="hidden" name="editingId" value="${esc(editing?.id || '')}" />

      ${!editing ? `
        <div class="grid grid-cols-3 gap-1.5 bg-slate-100 p-1 rounded-xl text-xs font-semibold">
          ${[
            { id: 'attraction', label: '景點' },
            { id: 'dining', label: '餐食' },
            { id: 'transport', label: '交通' }
          ].map((opt) => `
            <button type="button" data-form-itype="${opt.id}" class="py-1.5 rounded-lg ${fType === opt.id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'}">${opt.label}</button>
          `).join('')}
        </div>
      ` : `<input type="hidden" name="fixedType" value="${esc(fType)}" />`}

      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        <div class="col-span-2 sm:col-span-1 min-w-0">
          <label class="block text-xs font-medium text-slate-600 mb-1">日期</label>
          <input name="dateKey" type="date" required value="${esc(dateKey)}" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white" />
        </div>
        <div class="min-w-0">
          <label class="block text-xs font-medium text-slate-600 mb-1">開始時間</label>
          <input name="startHHMM" type="time" required value="${esc(startVal)}" class="w-full px-2.5 py-2 rounded-xl border border-slate-200 text-sm bg-white" />
        </div>
        <div class="min-w-0">
          <label class="block text-xs font-medium text-slate-600 mb-1">結束時間</label>
          <input name="endHHMM" type="time" required value="${esc(endVal)}" class="w-full px-2.5 py-2 rounded-xl border border-slate-200 text-sm bg-white" />
        </div>
      </div>

      ${fType === 'attraction' ? `
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">景點名稱</label>
          <input name="title" required value="${esc(editing?.title || '')}" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">地點或地圖連結</label>
          <input name="location" value="${esc(editing?.location || '')}" placeholder="輸入地名或貼上 Google Maps 連結" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
        </div>
      ` : ''}

      ${fType === 'dining' ? `
        <div>
          <label class="block text-xs font-medium text-slate-600 mb-1">餐期分類</label>
          <select name="mealPeriod" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white">
            ${Object.entries(MEAL_PERIOD_LABELS).map(([k, v]) => `<option value="${k}" ${(editing?.mealPeriod || 'lunch') === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>

        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <label class="text-xs font-semibold text-slate-700">餐廳選項與備案</label>
            <button type="button" id="btn-add-meal-opt" class="text-xs font-semibold text-teal-700">＋ 新增備案</button>
          </div>
          ${mealOptions.map((opt, idx) => `
            <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
              <div class="flex items-center justify-between">
                <label class="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                  <input type="radio" name="primaryMealIdx" value="${idx}" ${opt.isPrimary ? 'checked' : ''} class="accent-teal-600" />
                  <span>首選餐廳</span>
                </label>
                ${mealOptions.length > 1 ? `<button type="button" data-del-meal-opt="${idx}" class="text-xs text-rose-500">移除</button>` : ''}
              </div>
              <div class="flex gap-1.5">
                <input data-meal-field="mapsUrl" data-idx="${idx}" value="${esc(opt.mapsUrl || '')}" placeholder="貼上 Google Maps 分享連結" class="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white" />
                <button type="button" data-autofill-place="${idx}" class="px-2.5 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-semibold shrink-0">自動帶入</button>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <input data-meal-field="name" data-idx="${idx}" required value="${esc(opt.name || '')}" placeholder="店家名稱" class="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white" />
                <input data-meal-field="openingHours" data-idx="${idx}" value="${esc(opt.openingHours || '')}" placeholder="營業時間" class="px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white" />
              </div>
              <div class="grid grid-cols-3 gap-2">
                <select data-meal-field="reservationType" data-idx="${idx}" class="px-2 py-1.5 rounded-lg border border-slate-200 text-xs bg-white">
                  <option value="walk_in" ${opt.reservationType !== 'reservable' ? 'selected' : ''}>現場排隊</option>
                  <option value="reservable" ${opt.reservationType === 'reservable' ? 'selected' : ''}>可訂位</option>
                </select>
                ${opt.reservationType === 'reservable' ? `
                  <select data-meal-field="reservedBy" data-idx="${idx}" class="px-2 py-1.5 rounded-lg border border-slate-200 text-xs bg-white">
                    <option value="">選擇訂位人</option>
                    ${(trip.activeMemberIds || []).map((uid) => `<option value="${esc(uid)}" ${opt.reservedBy === uid ? 'selected' : ''}>${esc(memberName(trip, uid))}</option>`).join('')}
                  </select>
                  <input data-meal-field="reservationTime" data-idx="${idx}" type="time" value="${esc(opt.reservationTime || '')}" class="px-2 py-1.5 rounded-lg border border-slate-200 text-xs bg-white" />
                ` : `<div class="col-span-2"></div>`}
              </div>
              <input data-meal-field="note" data-idx="${idx}" value="${esc(opt.note || '')}" placeholder="備註" class="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white" />
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${fType === 'transport' ? `
        <div class="grid grid-cols-3 gap-1.5 bg-slate-100 p-1 rounded-xl text-xs font-semibold">
          ${Object.entries(TRANSPORT_MODE_LABELS).map(([k, v]) => `
            <button type="button" data-form-tmode="${k}" class="py-1.5 rounded-lg ${tMode === k ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'}">${v}</button>
          `).join('')}
        </div>
        <input name="title" value="${esc(editing?.title || '')}" placeholder="名稱" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
        <div class="grid grid-cols-2 gap-2">
          <input name="origin" required value="${esc(editing?.origin || '')}" placeholder="出發地" class="px-3 py-2 rounded-xl border border-slate-200 text-sm" />
          <input name="destination" required value="${esc(editing?.destination || '')}" placeholder="目的地" class="px-3 py-2 rounded-xl border border-slate-200 text-sm" />
        </div>
        <div class="grid grid-cols-2 gap-2">
          <input name="originMapsUrl" value="${esc(editing?.originMapsUrl || '')}" placeholder="出發地地圖連結" class="px-3 py-2 rounded-xl border border-slate-200 text-xs" />
          <input name="destinationMapsUrl" value="${esc(editing?.destinationMapsUrl || '')}" placeholder="目的地地圖連結" class="px-3 py-2 rounded-xl border border-slate-200 text-xs" />
        </div>

        ${tMode === 'flight' ? `
          <div class="grid grid-cols-2 gap-2">
            <input name="flightNo" value="${esc(editing?.flightDetails?.flightNo || '')}" placeholder="航班編號" class="px-3 py-2 rounded-xl border border-slate-200 text-sm" />
            <input name="baggageAllowance" value="${esc(editing?.flightDetails?.baggageAllowance || '')}" placeholder="托運行李額度" class="px-3 py-2 rounded-xl border border-slate-200 text-sm" />
            <input name="departureTerminal" value="${esc(editing?.flightDetails?.departureTerminal || '')}" placeholder="出發航廈" class="px-3 py-2 rounded-xl border border-slate-200 text-sm" />
            <input name="arrivalTerminal" value="${esc(editing?.flightDetails?.arrivalTerminal || '')}" placeholder="抵達航廈" class="px-3 py-2 rounded-xl border border-slate-200 text-sm" />
          </div>
        ` : ''}

        ${tMode === 'transit' ? `
          <input name="serviceNo" value="${esc(editing?.serviceNo || '')}" placeholder="班次" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
          <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-600">驗票方式</label>
            <div class="flex flex-wrap gap-2">
              ${TICKETING_OPTIONS.map((m) => `
                <label class="inline-flex items-center gap-1.5 text-xs bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200 cursor-pointer">
                  <input type="checkbox" name="ticketingMethods" value="${m}" ${(editing?.ticketingMethods || []).includes(m) ? 'checked' : ''} class="accent-teal-600" />
                  <span>${m}</span>
                </label>
              `).join('')}
            </div>
          </div>
        ` : ''}

        ${tMode === 'car' ? `
          <div class="grid grid-cols-2 gap-2">
            <input name="driverName" value="${esc(editing?.carDetails?.driverName || '')}" placeholder="司機或駕駛名稱" class="px-3 py-2 rounded-xl border border-slate-200 text-sm" />
            <input name="plateNo" value="${esc(editing?.carDetails?.plateNo || '')}" placeholder="車牌號碼" class="px-3 py-2 rounded-xl border border-slate-200 text-sm" />
          </div>
        ` : ''}
      ` : ''}

      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-slate-600">參與成員</label>
        <div class="flex flex-wrap gap-2">
          ${(trip.activeMemberIds || []).map((uid) => `
            <label class="inline-flex items-center gap-1.5 text-xs bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200 cursor-pointer">
              <input type="checkbox" name="participantIds" value="${esc(uid)}" ${participants.includes(uid) ? 'checked' : ''} class="accent-teal-600" />
              <span>${esc(memberName(trip, uid))}</span>
            </label>
          `).join('')}
        </div>
      </div>

      <div>
        <label class="block text-xs font-medium text-slate-600 mb-1">說明</label>
        <textarea name="description" rows="2" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm">${esc(editing?.description || '')}</textarea>
      </div>

      <button type="submit" class="w-full py-2.5 rounded-xl glass-btn-primary text-sm font-semibold">儲存行程</button>
    </form>
  `;
}

/* ----------------------------- Modal: 新增 / 編輯開銷表單 ----------------------------- */
function computeExpensePreview(d) {
  let previewSplits = [];
  let previewTotal = 0;
  let previewSurplus = 0;
  if (d.isPersonalExpense) {
    const t = Math.round(Number(d.twdAmount) || 0);
    previewSplits = [{ userId: state.user.uid, twdShare: t, isRoundedUp: false }];
    previewTotal = t;
  } else if (d.splitMode === 'equal') {
    const res = calculateEqualSplits(d.twdAmount, d.participantIds, d.payerId);
    previewSplits = res.splits;
    previewTotal = res.splitTotalTwd;
    previewSurplus = res.roundingSurplusTwd;
  } else {
    previewSplits = d.participantIds.map((uid) => ({
      userId: uid,
      twdShare: Math.round(Number(d.customShares[uid]) || 0),
      isRoundedUp: false
    }));
    previewTotal = previewSplits.reduce((s, x) => s + x.twdShare, 0);
    previewSurplus = previewTotal - Math.round(Number(d.twdAmount) || 0);
  }
  return { previewSplits, previewTotal, previewSurplus };
}

function renderExpenseSummaryBarHtml(previewTotal, previewSurplus) {
  return `
    <span class="text-slate-600">分攤表列總額：<strong>NT$${previewTotal.toLocaleString()}</strong></span>
    ${previewSurplus > 0 ? `<span class="text-teal-700 font-semibold">尾差補貼 +NT$${previewSurplus}</span>` : previewSurplus < 0 ? `<span class="text-rose-600 font-semibold">尚差 NT$${Math.abs(previewSurplus)}</span>` : `<span class="text-slate-500">已平衡</span>`}
  `;
}

function updateExpensePreviewDom(d) {
  const { previewSplits, previewTotal, previewSurplus } = computeExpensePreview(d);
  if (!d.isPersonalExpense && d.splitMode === 'equal') {
    document.querySelectorAll('[data-exp-equal-share]').forEach((span) => {
      const uid = span.dataset.expEqualShare;
      const splitObj = previewSplits.find((s) => s.userId === uid);
      span.innerHTML = `NT$${(splitObj?.twdShare || 0).toLocaleString()}${splitObj?.isRoundedUp ? ' <span class="text-teal-700">+1</span>' : ''}`;
    });
  }
  const summaryEl = document.getElementById('expense-split-summary');
  if (summaryEl) {
    summaryEl.innerHTML = renderExpenseSummaryBarHtml(previewTotal, previewSurplus);
  }
}

function renderExpenseFormModalContent(data) {
  const trip = activeTrip();
  const d = data.draft;
  const activeIds = trip.activeMemberIds || [];
  const { previewSplits, previewTotal, previewSurplus } = computeExpensePreview(d);

  return `
    ${modalHeader(data.editingId ? '編輯開銷' : '新增開銷')}
    <form id="form-expense" class="p-5 overflow-y-auto td-modal-scroll space-y-4">
      <!-- 去括號切換：團體代墊 / 個人自付 -->
      <div class="grid grid-cols-2 bg-slate-100 p-1 rounded-xl text-xs font-semibold">
        <button type="button" data-exp-personal="false" class="py-2 rounded-lg ${!d.isPersonalExpense ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'}">團體代墊</button>
        <button type="button" data-exp-personal="true" class="py-2 rounded-lg ${d.isPersonalExpense ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'}">個人自付</button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="sm:col-span-2 min-w-0">
          <label class="block text-xs font-medium text-slate-600 mb-1">開銷項目</label>
          <input data-exp-bind="title" required value="${esc(d.title)}" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
        </div>
        <div class="min-w-0">
          <label class="block text-xs font-medium text-slate-600 mb-1">消費日期</label>
          <input data-exp-bind="expenseDate" type="date" required value="${esc(d.expenseDate)}" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white" />
        </div>
      </div>

      <div>
        <label class="block text-xs font-medium text-slate-600 mb-1">關聯行程</label>
        <select data-exp-bind="linkedItineraryId" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white">
          <option value="">不關聯行程</option>
          ${state.itineraries.map((it) => {
            const label = it.type === 'accommodation'
              ? `住宿｜${it.stayDate} ${it.title}`
              : `${getEventDisplayTitle(it).badge}｜${it.dateKey || ''} ${getEventDisplayTitle(it).title}`;
            return `<option value="${esc(it.id)}" ${d.linkedItineraryId === it.id ? 'selected' : ''}>${esc(label)}</option>`;
          }).join('')}
        </select>
      </div>

      <!-- 雙模式金額輸入（無微調匯率） -->
      <div class="space-y-2.5 p-3.5 rounded-2xl bg-slate-50 border border-slate-200">
        <div class="grid grid-cols-2 bg-white p-1 rounded-xl border border-slate-200 text-xs font-semibold">
          <button type="button" data-exp-mode="auto_fx" class="py-1.5 rounded-lg ${d.twdInputMode === 'auto_fx' ? 'bg-teal-600 text-white' : 'text-slate-600'}">外幣自動換算</button>
          <button type="button" data-exp-mode="direct_twd" class="py-1.5 rounded-lg ${d.twdInputMode === 'direct_twd' ? 'bg-teal-600 text-white' : 'text-slate-600'}">刷卡實付臺幣</button>
        </div>

        ${d.twdInputMode === 'auto_fx' ? `
          <div class="grid grid-cols-2 gap-2">
            <select data-exp-bind="currency" class="px-2.5 py-2 rounded-xl border border-slate-200 text-xs bg-white">
              ${CURRENCIES.map((c) => `<option value="${c.code}" ${d.currency === c.code ? 'selected' : ''}>${c.label}</option>`).join('')}
            </select>
            <input data-exp-bind="originalAmount" type="number" inputmode="decimal" step="any" value="${esc(d.originalAmount)}" placeholder="輸入金額" class="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white" />
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-slate-600">${d.exchangeRate ? `鎖定匯率：${Number(d.exchangeRate).toFixed(4)} → NT$${Number(d.twdAmount || 0).toLocaleString()}` : '點擊換算取得當日匯率'}</span>
            <button type="button" id="btn-fetch-fx" class="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold">換算匯率</button>
          </div>
        ` : `
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">實付新臺幣金額</label>
            <input data-exp-bind="twdAmount" type="text" inputmode="numeric" pattern="[0-9]*" required value="${esc(d.twdAmount)}" placeholder="輸入新臺幣金額" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white font-bold" />
          </div>
          <div class="pt-1 space-y-1">
            <label class="block text-[11px] font-medium text-slate-400">原幣紀錄選填</label>
            <div class="grid grid-cols-2 gap-2">
              <select data-exp-bind="currency" class="px-2.5 py-2 rounded-xl border border-slate-200 text-xs bg-white">
                ${CURRENCIES.map((c) => `<option value="${c.code}" ${d.currency === c.code ? 'selected' : ''}>${c.label}</option>`).join('')}
              </select>
              <input data-exp-bind="originalAmount" type="number" inputmode="decimal" step="any" value="${esc(d.originalAmount)}" placeholder="原幣金額選填" class="px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white" />
            </div>
          </div>
        `}
      </div>

      ${!d.isPersonalExpense ? `
        <div class="space-y-3">
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">代墊成員</label>
              <select data-exp-bind="payerId" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm bg-white">
                ${activeIds.map((uid) => `<option value="${esc(uid)}" ${d.payerId === uid ? 'selected' : ''}>${esc(memberName(trip, uid))}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">分攤方式</label>
              <div class="grid grid-cols-2 bg-slate-100 p-1 rounded-xl text-xs font-semibold">
                <button type="button" data-exp-splitmode="equal" class="py-1.5 rounded-lg ${d.splitMode === 'equal' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'}">一鍵均分</button>
                <button type="button" data-exp-splitmode="custom" class="py-1.5 rounded-lg ${d.splitMode === 'custom' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'}">自訂金額</button>
              </div>
            </div>
          </div>

          <div class="space-y-2">
            <label class="block text-xs font-medium text-slate-600">分攤成員</label>
            <div class="space-y-1.5">
              ${activeIds.map((uid) => {
                const checked = d.participantIds.includes(uid);
                const splitObj = previewSplits.find((s) => s.userId === uid);
                return `
                  <div class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl border ${checked ? 'border-teal-300 bg-teal-50/40' : 'border-slate-200'}">
                    <label class="inline-flex items-center gap-2 text-xs font-medium text-slate-800 cursor-pointer">
                      <input type="checkbox" data-exp-member="${esc(uid)}" ${checked ? 'checked' : ''} class="accent-teal-600" />
                      <span>${esc(memberName(trip, uid))}</span>
                    </label>
                    ${checked ? (
                      d.splitMode === 'custom'
                        ? `<input type="text" inputmode="numeric" pattern="[0-9]*" data-exp-custom="${esc(uid)}" value="${esc(d.customShares[uid] ?? '')}" placeholder="NT$" class="w-24 px-2 py-1 rounded-lg border border-slate-200 text-xs text-right bg-white" />`
                        : `<span data-exp-equal-share="${esc(uid)}" class="text-xs font-bold text-slate-800">NT$${(splitObj?.twdShare || 0).toLocaleString()}${splitObj?.isRoundedUp ? ' <span class="text-teal-700">+1</span>' : ''}</span>`
                    ) : ''}
                  </div>
                `;
              }).join('')}
            </div>
          </div>

          <div id="expense-split-summary" class="px-3.5 py-2.5 rounded-xl bg-slate-100 text-xs flex items-center justify-between">
            ${renderExpenseSummaryBarHtml(previewTotal, previewSurplus)}
          </div>
        </div>
      ` : ''}

      <input data-exp-bind="note" value="${esc(d.note)}" placeholder="備註" class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
      <button type="submit" class="w-full py-2.5 rounded-xl glass-btn-primary text-sm font-semibold">儲存開銷</button>
    </form>
  `;
}

/* ----------------------------- Modal: 管理員封存旅行與感謝詞 ----------------------------- */
function renderArchiveModalContent() {
  const trip = activeTrip();
  const defaultMsg = `感謝大家一起完成「${trip.name}」，全團帳務已結清封存，行程足跡隨時歡迎回來回味！`;
  return `
    ${modalHeader('封存旅行並清理分帳明細')}
    <form id="form-archive-trip" class="p-5 space-y-4">
      <div class="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 leading-relaxed">
        執行封存後，系統會自動下載完整分帳明細 CSV 留底，鎖定全團與個人總花費快照，並清空逐筆明細。行程時間軸與餐食備案將完整保留。
      </div>
      <div>
        <label class="block text-xs font-medium text-slate-600 mb-1">給全團成員的結算感謝詞</label>
        <textarea name="thankYouMessage" rows="3" required class="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm">${esc(defaultMsg)}</textarea>
      </div>
      <button type="submit" class="w-full py-2.5 rounded-xl glass-btn-primary text-sm font-semibold">匯出 CSV 並確認封存</button>
    </form>
  `;
}

/* ============================= 事件綁定 ============================= */
function bindGlobalEvents() {
  document.getElementById('btn-back-trips')?.addEventListener('click', () => {
    clearTripDetailListeners();
    state.activeTripId = null;
    state.animatePage = true;
    window.location.hash = '';
    render();
  });

  document.getElementById('btn-subscribe-push')?.addEventListener('click', handleSubscribePush);
  document.getElementById('btn-open-pwa')?.addEventListener('click', () => {
    const env = detectEnvironment();
    state.modal = { type: 'pwa', data: { tab: env.isAndroid ? 'android' : 'ios' } };
    render();
  });
  document.getElementById('btn-global-help')?.addEventListener('click', () => openHelpModal(null));
  document.getElementById('btn-open-profile')?.addEventListener('click', () => {
    state.modal = { type: 'profile', data: {} };
    render();
  });

  // 首頁刪除帳號審核提醒、建立與進入旅行
  document.getElementById('btn-open-deletion-review')?.addEventListener('click', async () => {
    await loadAllUsersIfAdmin();
    state.modal = { type: 'deletionReview', data: {} };
    render();
  });
  document.getElementById('btn-create-trip')?.addEventListener('click', () => {
    state.modal = { type: 'createTrip', data: {} };
    render();
  });
  document.querySelectorAll('[data-select-trip]').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.swipeOpen === 'true') {
        el.style.transition = 'transform 0.2s ease';
        el.style.transform = 'translateX(0px)';
        el.dataset.swipeOpen = 'false';
        return;
      }
      if (el.dataset.justSwiped === 'true') {
        el.dataset.justSwiped = 'false';
        return;
      }
      selectTrip(el.dataset.selectTrip);
    });
  });

  document.querySelectorAll('[data-delete-trip]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteTrip(btn.dataset.deleteTrip);
    });
  });

  if (isAdmin()) bindTripSwipeGestures();

  // 分頁與日期切換
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.activeTab === btn.dataset.tab) return;
      state.activeTab = btn.dataset.tab;
      state.animateTab = true;
      if (state.activeTab === 'admin') loadAllUsersIfAdmin();
      render();
    });
  });
  document.querySelectorAll('[data-select-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedDate = btn.dataset.selectDate;
      state.expandedMobileSlots.clear();
      state.expandedDesktopSlots.clear();
      render();
    });
  });

  // 情境 [i] 說明跳轉
  document.querySelectorAll('[data-help-section]').forEach((btn) => {
    btn.addEventListener('click', () => openHelpModal(btn.dataset.helpSection));
  });

  // 報平安打卡
  document.getElementById('btn-safe-home')?.addEventListener('click', async () => {
    const msg = window.prompt('要順便留一句報平安的話嗎？（可留空直接按確定）', '平安到家了！');
    if (msg === null) return;
    await setDoc(doc(db, 'trips', state.activeTripId, 'safeHomeCheckIns', state.user.uid), {
      checkedIn: true,
      message: msg.trim(),
      checkedInAt: serverTimestamp()
    });
    showToast('已報平安', 'success');
  });

  // 住宿卡片與管理員 ＋新增/編輯房間
  document.getElementById('btn-add-room-shortcut')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const trip = activeTrip();
    const tonight = getTonightAccommodation(state.itineraries, trip);
    state.modal = { type: 'accommodationEdit', data: { stayDate: tonight?.stayDate || trip.startDate } };
    render();
  });
  document.getElementById('card-accommodation')?.addEventListener('click', () => {
    const trip = activeTrip();
    const tonight = getTonightAccommodation(state.itineraries, trip);
    state.modal = { type: 'accommodationView', data: { stayDate: tonight?.stayDate } };
    render();
  });

  // 時間軸折疊與開啟明細
  document.querySelectorAll('[data-toggle-mobile-slot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.toggleMobileSlot);
      if (state.expandedMobileSlots.has(idx)) state.expandedMobileSlots.delete(idx);
      else state.expandedMobileSlots.add(idx);
      render();
    });
  });
  document.querySelectorAll('[data-toggle-desktop-slot]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.toggleDesktopSlot);
      if (state.expandedDesktopSlots.has(idx)) state.expandedDesktopSlots.delete(idx);
      else state.expandedDesktopSlots.add(idx);
      render();
    });
  });
  document.querySelectorAll('[data-open-itinerary]').forEach((el) => {
    el.addEventListener('click', () => {
      state.modal = { type: 'itineraryDetail', data: { itineraryId: el.dataset.openItinerary } };
      render();
    });
  });
  document.getElementById('btn-new-itinerary')?.addEventListener('click', () => {
    state.modal = { type: 'itineraryForm', data: { type: 'attraction', dateKey: state.selectedDate } };
    render();
  });

  // 帳務按鈕
  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    exportExpensesCsv(activeTrip(), state.expenses);
  });
  document.getElementById('btn-new-expense')?.addEventListener('click', () => openExpenseForm());
  document.querySelectorAll('[data-edit-expense]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const exp = state.expenses.find((e) => e.id === btn.dataset.editExpense);
      if (exp) openExpenseForm(exp);
    });
  });
  document.querySelectorAll('[data-delete-expense]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('確定刪除這筆開銷？')) return;
      await deleteDoc(doc(db, 'trips', state.activeTripId, 'expenses', btn.dataset.deleteExpense));
      showToast('已刪除開銷');
    });
  });

  // 結帳三階段控制
  document.getElementById('btn-start-settling')?.addEventListener('click', handleStartSettling);
  document.getElementById('btn-revert-active')?.addEventListener('click', handleRevertActive);
  document.getElementById('btn-open-archive')?.addEventListener('click', () => {
    state.modal = { type: 'archive', data: {} };
    render();
  });
  document.querySelectorAll('[data-confirm-transfer]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await updateDoc(doc(db, 'trips', state.activeTripId, 'settlementTransfers', btn.dataset.confirmTransfer), {
        status: 'confirmed',
        confirmedAt: serverTimestamp()
      });
      showToast('已確認收款', 'success');
    });
  });
  document.querySelectorAll('[data-unlock-transfer]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await updateDoc(doc(db, 'trips', state.activeTripId, 'settlementTransfers', btn.dataset.unlockTransfer), {
        status: 'pending',
        confirmedAt: null
      });
      showToast('已退回待收款');
    });
  });
  document.querySelectorAll('[data-remind-transfer]').forEach((btn) => {
    btn.addEventListener('click', () => handleRemindTransfer(btn.dataset.remindTransfer));
  });

  // 管理員面板事件
  document.getElementById('btn-save-members')?.addEventListener('click', handleSaveMembers);
  document.getElementById('btn-delete-current-trip')?.addEventListener('click', () => {
    if (state.activeTripId) handleDeleteTrip(state.activeTripId);
  });
  document.getElementById('btn-manage-rooms')?.addEventListener('click', () => {
    state.modal = { type: 'accommodationEdit', data: { stayDate: activeTrip().startDate } };
    render();
  });
  document.querySelectorAll('[data-edit-stay-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.modal = { type: 'accommodationEdit', data: { stayDate: btn.dataset.editStayDate } };
      render();
    });
  });

  bindModalEvents();
}

function openExpenseForm(editingExp = null, prefill = {}) {
  const trip = activeTrip();
  const activeIds = trip.activeMemberIds || [];
  const customShares = {};
  if (editingExp?.splits) {
    editingExp.splits.forEach((s) => { customShares[s.userId] = s.twdShare; });
  }
  state.modal = {
    type: 'expenseForm',
    data: {
      editingId: editingExp?.id || null,
      draft: {
        title: editingExp?.title ?? prefill.title ?? '',
        expenseDate: editingExp?.expenseDate || getTodayInTimezone(trip.timezone),
        linkedItineraryId: editingExp?.linkedItineraryId ?? prefill.linkedItineraryId ?? '',
        isPersonalExpense: Boolean(editingExp?.isPersonalExpense),
        payerId: editingExp?.payerId || state.user.uid,
        twdInputMode: editingExp?.twdInputMode || 'auto_fx',
        currency: editingExp?.currency || 'TWD',
        originalAmount: editingExp?.originalAmount ?? '',
        exchangeRate: editingExp?.exchangeRate ?? null,
        twdAmount: editingExp?.twdAmount ?? '',
        splitMode: editingExp?.splitMode || 'equal',
        participantIds: editingExp?.splits ? editingExp.splits.map((s) => s.userId) : [...activeIds],
        customShares,
        note: editingExp?.note || ''
      }
    }
  };
  render();
}

/* ============================= 彈窗互動事件 ============================= */
function bindModalEvents() {
  if (!state.modal) return;
  document.getElementById('btn-close-modal')?.addEventListener('click', closeModal);
  document.getElementById('modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });

  const { type, data } = state.modal;

  if (type === 'pwa') {
    document.querySelectorAll('[data-pwa-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.modal.data.tab = btn.dataset.pwaTab;
        render();
      });
    });
    document.getElementById('btn-android-install')?.addEventListener('click', async () => {
      if (!state.deferredInstallPrompt) return;
      state.deferredInstallPrompt.prompt();
      await state.deferredInstallPrompt.userChoice;
      state.deferredInstallPrompt = null;
      render();
    });
  }

  if (type === 'profile') {
    document.getElementById('form-profile-name')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const displayName = String(new FormData(e.target).get('displayName') || '').trim();
      if (!displayName) return;
      await updateDoc(doc(db, 'users', state.user.uid), { displayName, updatedAt: serverTimestamp() });
      state.profile.displayName = displayName;
      showToast('已更新顯示名稱', 'success');
      render();
    });
    document.getElementById('form-profile-pwd')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const cred = EmailAuthProvider.credential(state.user.email, String(fd.get('oldPassword')));
        await reauthenticateWithCredential(auth.currentUser, cred);
        await updatePassword(auth.currentUser, String(fd.get('newPassword')));
        showToast('密碼已更新', 'success');
        e.target.reset();
      } catch {
        showToast('舊密碼驗證失敗', 'error');
      }
    });
    document.getElementById('btn-profile-deletion-review')?.addEventListener('click', async () => {
      await loadAllUsersIfAdmin();
      state.modal = { type: 'deletionReview', data: {} };
      render();
    });
    document.getElementById('btn-request-deletion')?.addEventListener('click', handleRequestAccountDeletion);
    document.getElementById('btn-cancel-deletion')?.addEventListener('click', handleCancelAccountDeletion);
    document.getElementById('btn-logout')?.addEventListener('click', async () => {
      state.modal = null;
      state.lastModalType = null;
      await signOut(auth);
    });
  }

  if (type === 'deletionReview') {
    document.querySelectorAll('[data-review-deletion]').forEach((btn) => {
      btn.addEventListener('click', () => {
        handleReviewAccountDeletion(btn.dataset.targetUid, btn.dataset.reviewDeletion);
      });
    });
  }

  if (type === 'createTrip') {
    document.getElementById('form-create-trip')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const startDate = String(fd.get('startDate'));
      const endDate = String(fd.get('endDate'));
      if (endDate < startDate) return showToast('結束日期不可早於出發日期', 'error');

      const docRef = await addDoc(collection(db, 'trips'), {
        name: String(fd.get('name')).trim(),
        startDate,
        endDate,
        location: String(fd.get('location')).trim(),
        timezone: String(fd.get('timezone')),
        status: 'active',
        totalExpenseTwd: 0,
        memberTotalExpenses: {},
        activeMemberIds: [state.user.uid],
        memberDirectory: {
          [state.user.uid]: {
            displayName: state.profile.displayName,
            isActive: true,
            joinedAt: new Date().toISOString()
          }
        },
        createdBy: state.user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      state.modal = null;
      showToast('旅行已建立', 'success');
      selectTrip(docRef.id);
    });
  }

  if (type === 'accommodationView') {
    document.querySelectorAll('[data-switch-stay]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.modal.data.stayDate = btn.dataset.switchStay;
        render();
      });
    });
  }

  if (type === 'accommodationEdit') {
    const syncRoomsFromDom = () => {
      const form = document.getElementById('form-edit-accommodation');
      const title = form.querySelector('[name="title"]').value;
      const mapsUrl = form.querySelector('[name="mapsUrl"]').value;
      const inputs = form.querySelectorAll('[data-room-no]');
      const rooms = Array.from(inputs).map((inp, idx) => {
        const occs = Array.from(form.querySelectorAll(`[data-room-occ="${idx}"]:checked`)).map((c) => c.value);
        return { roomId: `rm_${idx + 1}`, roomNo: inp.value.trim() || `房${idx + 1}`, occupantIds: occs };
      });
      state.modal.data.draftTitle = title;
      state.modal.data.draftMapsUrl = mapsUrl;
      state.modal.data.draftRooms = rooms;
      return { title, mapsUrl, rooms };
    };

    document.getElementById('btn-copy-prev-stay')?.addEventListener('click', () => {
      const trip = activeTrip();
      const dates = getTripDateRange(trip.startDate, trip.endDate);
      const prevIdx = dates.indexOf(data.stayDate) - 1;
      const prev = state.itineraries.find((i) => i.type === 'accommodation' && i.stayDate === dates[prevIdx]);
      if (prev) {
        state.modal.data.draftTitle = prev.title;
        state.modal.data.draftMapsUrl = prev.mapsUrl || '';
        state.modal.data.draftRooms = JSON.parse(JSON.stringify(prev.rooms || []));
        render();
      }
    });
    document.getElementById('btn-add-room-row')?.addEventListener('click', () => {
      const { rooms } = syncRoomsFromDom();
      rooms.push({ roomId: `rm_${Date.now()}`, roomNo: '', occupantIds: [] });
      render();
    });
    document.querySelectorAll('[data-del-room-row]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const { rooms } = syncRoomsFromDom();
        rooms.splice(Number(btn.dataset.delRoomRow), 1);
        render();
      });
    });
    document.getElementById('form-edit-accommodation')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { title, mapsUrl, rooms } = syncRoomsFromDom();
      const fd = new FormData(e.target);
      const stayDate = String(fd.get('stayDate'));
      const existingId = String(fd.get('existingId'));
      const applyConsecutive = fd.get('applyConsecutive') === 'on';

      const payload = {
        type: 'accommodation',
        stayDate,
        title: title.trim(),
        mapsUrl: mapsUrl.trim(),
        rooms,
        updatedBy: state.user.uid,
        updatedAt: serverTimestamp()
      };

      if (existingId) {
        await updateDoc(doc(db, 'trips', state.activeTripId, 'itineraries', existingId), payload);
      } else {
        await addDoc(collection(db, 'trips', state.activeTripId, 'itineraries'), {
          ...payload,
          createdBy: state.user.uid,
          createdAt: serverTimestamp()
        });
      }

      if (applyConsecutive) {
        const trip = activeTrip();
        const dates = getTripDateRange(trip.startDate, trip.endDate);
        const startIdx = dates.indexOf(stayDate);
        for (let i = startIdx + 1; i < dates.length; i++) {
          const nextStay = state.itineraries.find((s) => s.type === 'accommodation' && s.stayDate === dates[i]);
          if (nextStay && nextStay.title === title.trim()) {
            await updateDoc(doc(db, 'trips', state.activeTripId, 'itineraries', nextStay.id), {
              rooms,
              updatedBy: state.user.uid,
              updatedAt: serverTimestamp()
            });
          } else {
            break;
          }
        }
      }

      state.modal = null;
      showToast('已更新住宿與房號', 'success');
      render();
    });
  }

  if (type === 'itineraryDetail') {
    const it = state.itineraries.find((i) => i.id === data.itineraryId);
    document.querySelectorAll('[data-pick-meal]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const targetId = btn.dataset.pickMeal;
        const nextOpts = (it.mealOptions || []).map((o) => {
          if (o.optionId === targetId) return { ...o, isPrimary: true, isStruckOut: false };
          if (o.isPrimary) return { ...o, isPrimary: false, isStruckOut: true };
          return o;
        });
        await updateDoc(doc(db, 'trips', state.activeTripId, 'itineraries', it.id), {
          mealOptions: nextOpts,
          updatedBy: state.user.uid,
          updatedAt: serverTimestamp()
        });
        showToast('已切換餐廳', 'success');
      });
    });
    document.querySelectorAll('[data-toggle-strike]').forEach((el) => {
      el.addEventListener('click', async () => {
        const targetId = el.dataset.toggleStrike;
        const nextOpts = (it.mealOptions || []).map((o) =>
          o.optionId === targetId ? { ...o, isStruckOut: !o.isStruckOut } : o
        );
        await updateDoc(doc(db, 'trips', state.activeTripId, 'itineraries', it.id), {
          mealOptions: nextOpts,
          updatedBy: state.user.uid,
          updatedAt: serverTimestamp()
        });
      });
    });
    document.querySelector('[data-edit-itinerary]')?.addEventListener('click', () => {
      state.modal = {
        type: 'itineraryForm',
        data: { itinerary: it, type: it.type, transportMode: it.transportMode, draftMealOptions: it.mealOptions ? JSON.parse(JSON.stringify(it.mealOptions)) : undefined }
      };
      render();
    });
    document.querySelector('[data-delete-itinerary]')?.addEventListener('click', async () => {
      if (!window.confirm('確定刪除此行程？')) return;
      await deleteDoc(doc(db, 'trips', state.activeTripId, 'itineraries', it.id));
      state.modal = null;
      showToast('已刪除行程');
      render();
    });
  }

  // 共用：從行程/住宿明細直接點 ＋記錄相關花費
  document.querySelector('[data-quick-expense]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    openExpenseForm(null, {
      linkedItineraryId: btn.dataset.quickExpense,
      title: btn.dataset.quickTitle
    });
  });

  if (type === 'itineraryForm') {
    const syncMealsFromDom = () => {
      const form = document.getElementById('form-itinerary');
      if (!form) return [];
      const cur = state.modal.data.draftMealOptions || [
        { optionId: 'opt_' + Date.now(), name: '', mapsUrl: '', openingHours: '', reservationType: 'walk_in', reservedBy: '', reservationTime: '', isPrimary: true, isStruckOut: false, note: '' }
      ];
      const primaryIdx = Number(form.querySelector('input[name="primaryMealIdx"]:checked')?.value || 0);
      cur.forEach((opt, idx) => {
        opt.isPrimary = idx === primaryIdx;
        form.querySelectorAll(`[data-idx="${idx}"]`).forEach((el) => {
          opt[el.dataset.mealField] = el.value;
        });
      });
      state.modal.data.draftMealOptions = cur;
      return cur;
    };

    document.querySelectorAll('[data-form-itype]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.modal.data.type = btn.dataset.formItype;
        render();
      });
    });
    document.querySelectorAll('[data-form-tmode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.modal.data.transportMode = btn.dataset.formTmode;
        render();
      });
    });
    document.getElementById('btn-add-meal-opt')?.addEventListener('click', () => {
      const list = syncMealsFromDom();
      list.push({ optionId: 'opt_' + Date.now(), name: '', mapsUrl: '', openingHours: '', reservationType: 'walk_in', reservedBy: '', reservationTime: '', isPrimary: false, isStruckOut: false, note: '' });
      render();
    });
    document.querySelectorAll('[data-del-meal-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const list = syncMealsFromDom();
        list.splice(Number(btn.dataset.delMealOpt), 1);
        if (list.length > 0 && !list.some((o) => o.isPrimary)) list[0].isPrimary = true;
        render();
      });
    });
    document.querySelectorAll('[data-meal-field="reservationType"]').forEach((sel) => {
      sel.addEventListener('change', () => {
        syncMealsFromDom();
        render();
      });
    });
    document.querySelectorAll('[data-autofill-place]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.autofillPlace);
        const list = syncMealsFromDom();
        const mapsUrl = (list[idx]?.mapsUrl || '').trim();
        if (!mapsUrl) return showToast('請先貼上 Google Maps 連結', 'error');

        const form = document.getElementById('form-itinerary');
        const dateKey = form.querySelector('[name="dateKey"]').value;
        const cacheKey = btoa(unescape(encodeURIComponent(mapsUrl))).replace(/[^a-zA-Z0-9]/g, '').slice(0, 48);

        // 1. 先查 Firestore places_cache
        let placeData = null;
        try {
          const snap = await getDoc(doc(db, 'places_cache', cacheKey));
          if (snap.exists()) placeData = snap.data();
        } catch {}

        // 2. 沒快取則呼叫 GAS Places API 跳板
        if (!placeData) {
          if (!cfg.gasBridgeUrl) {
            // 無 GAS 跳板時嘗試從長網址直接解析店名
            const m = mapsUrl.match(/\/maps\/place\/([^\/@?]+)/);
            if (m && m[1]) {
              list[idx].name = decodeURIComponent(m[1].replace(/\+/g, ' '));
              showToast('已從網址帶入店名，營業時間請手動填寫');
              render();
            } else {
              showToast('尚未串接 GAS Places API 跳板，請手動填寫店名與營業時間');
            }
            return;
          }
          showToast('查詢店家資訊中...');
          const res = await callGasBridge('resolvePlace', { mapsUrl });
          if (!res.ok) return showToast(res.error || '查詢失敗', 'error');
          placeData = res;
          if (res.displayName) {
            try {
              await setDoc(doc(db, 'places_cache', cacheKey), {
                normalizedUrl: mapsUrl,
                placeId: res.placeId || '',
                displayName: res.displayName,
                weekdayDescriptions: res.weekdayDescriptions || [],
                fetchedAt: serverTimestamp()
              });
            } catch {}
          }
        }

        if (placeData.displayName) list[idx].name = placeData.displayName;
        if (Array.isArray(placeData.weekdayDescriptions) && placeData.weekdayDescriptions.length === 7) {
          // Google Places weekdayDescriptions 順序為 星期一(0)...星期日(6)
          const jsDay = getWeekdayIndex(dateKey); // 0=日, 1=一...6=六
          const googleIdx = jsDay === 0 ? 6 : jsDay - 1;
          const desc = placeData.weekdayDescriptions[googleIdx] || '';
          list[idx].openingHours = desc.replace(/^星期[一二三四五六日]:\s*/, '');
        }
        showToast(placeData.degradedReason || '已自動帶入店家與當日營業時間', 'success');
        render();
      });
    });

    document.getElementById('form-itinerary')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const fType = state.modal.data.type || String(fd.get('fixedType')) || 'attraction';
      const editingId = String(fd.get('editingId'));
      const dateKey = String(fd.get('dateKey'));
      const startTime = `${dateKey}T${fd.get('startHHMM')}:00`;
      const endTime = `${dateKey}T${fd.get('endHHMM')}:00`;
      const participantIds = fd.getAll('participantIds').map(String);
      if (participantIds.length === 0) return showToast('請至少勾選一位參與成員', 'error');

      const base = {
        type: fType,
        dateKey,
        startTime,
        endTime,
        participantIds,
        description: String(fd.get('description') || '').trim(),
        updatedBy: state.user.uid,
        updatedAt: serverTimestamp()
      };

      if (fType === 'attraction') {
        base.title = String(fd.get('title') || '').trim();
        base.location = String(fd.get('location') || '').trim();
      } else if (fType === 'dining') {
        const opts = syncMealsFromDom().map((o) => ({
          ...o,
          name: (o.name || '').trim(),
          reservedBy: o.reservationType === 'reservable' ? (o.reservedBy || null) : null,
          reservationTime: o.reservationType === 'reservable' ? (o.reservationTime || null) : null
        }));
        base.mealPeriod = String(fd.get('mealPeriod'));
        base.mealOptions = opts;
        base.title = (opts.find((o) => o.isPrimary) || opts[0])?.name || '餐食';
      } else if (fType === 'transport') {
        const tMode = state.modal.data.transportMode || 'transit';
        base.transportMode = tMode;
        base.title = String(fd.get('title') || '').trim();
        base.origin = String(fd.get('origin') || '').trim();
        base.destination = String(fd.get('destination') || '').trim();
        base.originMapsUrl = String(fd.get('originMapsUrl') || '').trim();
        base.destinationMapsUrl = String(fd.get('destinationMapsUrl') || '').trim();
        base.serviceNo = tMode === 'transit' ? String(fd.get('serviceNo') || '').trim() : null;
        base.ticketingMethods = tMode === 'transit' ? fd.getAll('ticketingMethods').map(String) : [];
        base.flightDetails = tMode === 'flight' ? {
          flightNo: String(fd.get('flightNo') || '').trim(),
          departureTerminal: String(fd.get('departureTerminal') || '').trim(),
          arrivalTerminal: String(fd.get('arrivalTerminal') || '').trim(),
          baggageAllowance: String(fd.get('baggageAllowance') || '').trim()
        } : null;
        base.carDetails = tMode === 'car' ? {
          driverName: String(fd.get('driverName') || '').trim(),
          plateNo: String(fd.get('plateNo') || '').trim()
        } : null;
      }

      if (editingId) {
        await updateDoc(doc(db, 'trips', state.activeTripId, 'itineraries', editingId), base);
      } else {
        await addDoc(collection(db, 'trips', state.activeTripId, 'itineraries'), {
          ...base,
          createdBy: state.user.uid,
          createdAt: serverTimestamp()
        });
      }
      state.selectedDate = dateKey;
      state.modal = null;
      showToast('行程已儲存', 'success');
      render();
    });
  }

  if (type === 'expenseForm') {
    const d = state.modal.data.draft;
    document.querySelectorAll('[data-exp-personal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        d.isPersonalExpense = btn.dataset.expPersonal === 'true';
        if (d.isPersonalExpense) d.payerId = state.user.uid;
        render();
      });
    });
    document.querySelectorAll('[data-exp-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        d.twdInputMode = btn.dataset.expMode;
        render();
      });
    });
    document.querySelectorAll('[data-exp-splitmode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        d.splitMode = btn.dataset.expSplitmode;
        render();
      });
    });
    document.querySelectorAll('[data-exp-bind]').forEach((el) => {
      const key = el.dataset.expBind;
      const evtName = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evtName, () => {
        if (key === 'twdAmount') {
          const digits = el.value.replace(/[^\d]/g, '');
          if (el.value !== digits) el.value = digits;
          d.twdAmount = digits;
          updateExpensePreviewDom(d);
          return;
        }
        d[key] = el.value;
        if (key === 'payerId') {
          updateExpensePreviewDom(d);
        }
      });
    });
    document.querySelectorAll('[data-exp-member]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const uid = cb.dataset.expMember;
        if (cb.checked && !d.participantIds.includes(uid)) d.participantIds.push(uid);
        else if (!cb.checked) d.participantIds = d.participantIds.filter((x) => x !== uid);
        render();
      });
    });
    document.querySelectorAll('[data-exp-custom]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const digits = inp.value.replace(/[^\d]/g, '');
        if (inp.value !== digits) inp.value = digits;
        d.customShares[inp.dataset.expCustom] = digits;
        updateExpensePreviewDom(d);
      });
    });

    document.getElementById('btn-fetch-fx')?.addEventListener('click', async () => {
      const orig = Number(d.originalAmount);
      if (!orig || orig <= 0) return showToast('請先輸入外幣金額', 'error');
      const res = await fetchExchangeRate(d.currency, d.expenseDate);
      if (!res) {
        d.twdInputMode = 'direct_twd';
        showToast('匯率 API 暫時無法連線，已切換為刷卡實付臺幣模式', 'error');
        render();
        return;
      }
      d.exchangeRate = res.rate;
      d.twdAmount = Math.round(orig * res.rate);
      showToast(res.isFallback ? `已使用最近營業日匯率 (${res.source})` : '已鎖定當日匯率', 'success');
      render();
    });

    document.getElementById('form-expense')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const twdAmount = Math.round(Number(d.twdAmount));
      if (!twdAmount || twdAmount <= 0) return showToast('請先完成金額換算或填入臺幣金額', 'error');

      let splits = [];
      let splitTotalTwd = 0;
      let roundingSurplusTwd = 0;
      let payerId = d.isPersonalExpense ? state.user.uid : d.payerId;
      let splitMode = d.isPersonalExpense ? 'custom' : d.splitMode;

      if (d.isPersonalExpense) {
        splits = [{ userId: state.user.uid, twdShare: twdAmount, isRoundedUp: false }];
        splitTotalTwd = twdAmount;
      } else if (d.splitMode === 'equal') {
        if (d.participantIds.length === 0) return showToast('請至少勾選一位分攤成員', 'error');
        const res = calculateEqualSplits(twdAmount, d.participantIds, payerId);
        splits = res.splits;
        splitTotalTwd = res.splitTotalTwd;
        roundingSurplusTwd = res.roundingSurplusTwd;
      } else {
        splits = d.participantIds.map((uid) => ({
          userId: uid,
          twdShare: Math.round(Number(d.customShares[uid]) || 0),
          isRoundedUp: false
        }));
        splitTotalTwd = splits.reduce((s, x) => s + x.twdShare, 0);
        roundingSurplusTwd = splitTotalTwd - twdAmount;
        if (splitTotalTwd < twdAmount) return showToast('自訂分攤總額不可小於實付金額', 'error');
      }

      const payload = {
        title: d.title.trim(),
        expenseDate: d.expenseDate,
        linkedItineraryId: d.linkedItineraryId || null,
        isPersonalExpense: d.isPersonalExpense,
        payerId,
        twdInputMode: d.twdInputMode,
        currency: d.currency || null,
        originalAmount: d.originalAmount ? Number(d.originalAmount) : null,
        exchangeRate: d.twdInputMode === 'auto_fx' ? Number(d.exchangeRate) : null,
        twdAmount,
        splitMode,
        splitTotalTwd,
        roundingSurplusTwd,
        splits,
        note: d.note.trim(),
        updatedAt: serverTimestamp()
      };

      if (state.modal.data.editingId) {
        await updateDoc(doc(db, 'trips', state.activeTripId, 'expenses', state.modal.data.editingId), payload);
      } else {
        await addDoc(collection(db, 'trips', state.activeTripId, 'expenses'), {
          ...payload,
          createdBy: state.user.uid,
          createdAt: serverTimestamp()
        });
      }
      state.modal = null;
      showToast('開銷已儲存', 'success');
      render();
    });
  }

  if (type === 'archive') {
    document.getElementById('form-archive-trip')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const thankYouMessage = String(new FormData(e.target).get('thankYouMessage') || '').trim();
      await handleArchiveTrip(thankYouMessage);
    });
  }
}

/* ============================= 結帳 / 封存 / 歸戶商業邏輯 ============================= */
async function handleStartSettling() {
  if (!window.confirm('進入結帳階段後將凍結新增與修改開銷，並產生固定轉帳清單，確定繼續？')) return;
  const trip = activeTrip();
  const calc = calculateSettlement(state.expenses, trip.activeMemberIds);

  const batch = writeBatch(db);
  // 清除舊轉帳紀錄並寫入新凍結清單
  state.transfers.forEach((tr) => {
    batch.delete(doc(db, 'trips', trip.id, 'settlementTransfers', tr.id));
  });
  calc.transfers.forEach((tr) => {
    const ref = doc(collection(db, 'trips', trip.id, 'settlementTransfers'));
    batch.set(ref, {
      ...tr,
      status: 'pending',
      confirmedAt: null,
      lastRemindedAt: null,
      createdAt: serverTimestamp()
    });
  });
  batch.update(doc(db, 'trips', trip.id), {
    status: 'settling',
    totalExpenseTwd: calc.totalExpenseTwd,
    updatedAt: serverTimestamp()
  });
  await batch.commit();
  showToast('已凍結帳目並進入結帳收款階段', 'success');
}

async function handleRevertActive() {
  if (!window.confirm('確定退回記帳中？已確認的收款進度將清除。')) return;
  const trip = activeTrip();
  const batch = writeBatch(db);
  state.transfers.forEach((tr) => {
    batch.delete(doc(db, 'trips', trip.id, 'settlementTransfers', tr.id));
  });
  batch.update(doc(db, 'trips', trip.id), {
    status: 'active',
    updatedAt: serverTimestamp()
  });
  await batch.commit();
  showToast('已退回記帳中');
}

async function handleRemindTransfer(transferId) {
  const trip = activeTrip();
  const tr = state.transfers.find((t) => t.id === transferId);
  if (!tr) return;

  // 6 小時冷卻檢查
  const lastMs = tr.lastRemindedAt?.toMillis ? tr.lastRemindedAt.toMillis() : (tr.lastRemindedAt ? new Date(tr.lastRemindedAt).getTime() : 0);
  if (lastMs && Date.now() - lastMs < 6 * 3600 * 1000) {
    return showToast('6 小時內已發送過提醒，請稍後再試', 'error');
  }

  await updateDoc(doc(db, 'trips', trip.id, 'settlementTransfers', transferId), {
    lastRemindedAt: serverTimestamp()
  });

  if (cfg.gasBridgeUrl) {
    const res = await callGasBridge('sendReminder', {
      tripId: trip.id,
      tripName: trip.name,
      toUserId: tr.fromUserId,
      payerName: memberName(trip, tr.toUserId),
      amountTwd: tr.amountTwd
    });
    showToast(res.ok ? '已發送繳款提醒推播' : '已記錄提醒時間（推播跳板未就緒）', 'success');
  } else {
    showToast('已記錄催繳提醒（設定 GAS 跳板後將同步推送通知）', 'success');
  }
}

async function handleArchiveTrip(thankYouMessage) {
  const trip = activeTrip();
  // 1. 自動下載完整 CSV 備份
  exportExpensesCsv(trip, state.expenses);

  // 2. 計算最終總開銷與各成員個人花費快照
  const calc = calculateSettlement(state.expenses, trip.activeMemberIds);

  // 3. 寫入封存快照並批次刪除 expenses 明細
  const batch = writeBatch(db);
  batch.update(doc(db, 'trips', trip.id), {
    status: 'settled',
    totalExpenseTwd: calc.totalExpenseTwd,
    memberTotalExpenses: calc.personalSpendMap,
    settledExpenseCount: state.expenses.length,
    settledAt: serverTimestamp(),
    settledBy: state.user.uid,
    thankYouMessage,
    updatedAt: serverTimestamp()
  });
  state.expenses.forEach((exp) => {
    batch.delete(doc(db, 'trips', trip.id, 'expenses', exp.id));
  });
  await batch.commit();

  // 4. 群發感謝詞推播（若已設定 GAS 跳板）
  if (cfg.gasBridgeUrl) {
    await callGasBridge('sendThankYou', {
      tripId: trip.id,
      tripName: trip.name,
      memberIds: trip.activeMemberIds || [],
      thankYouMessage
    });
  }

  state.modal = null;
  showToast('已匯出 CSV 並完成旅行封存', 'success');
  render();
}

async function handleSaveMembers() {
  const trip = activeTrip();
  const checkedIds = Array.from(document.querySelectorAll('[data-member-checkbox]:checked')).map((c) => c.dataset.memberCheckbox);
  const nextDir = { ...(trip.memberDirectory || {}) };

  Object.keys(nextDir).forEach((uid) => {
    nextDir[uid] = { ...nextDir[uid], isActive: checkedIds.includes(uid) };
  });
  checkedIds.forEach((uid) => {
    const u = state.allUsers.find((x) => x.id === uid);
    if (u) {
      nextDir[uid] = {
        displayName: u.displayName,
        isActive: true,
        joinedAt: nextDir[uid]?.joinedAt || new Date().toISOString()
      };
    }
  });

  await updateDoc(doc(db, 'trips', trip.id), {
    activeMemberIds: checkedIds,
    memberDirectory: nextDir,
    updatedAt: serverTimestamp()
  });
  showToast('已更新歸戶成員名單', 'success');
}

function bindTripSwipeGestures() {
  const MAX_SWIPE = 84;
  const closeAllSwipes = (exceptEl = null) => {
    document.querySelectorAll('.trip-swipe-card').forEach((card) => {
      if (card !== exceptEl && card.dataset.swipeOpen === 'true') {
        card.style.transition = 'transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)';
        card.style.transform = 'translateX(0px)';
        card.dataset.swipeOpen = 'false';
      }
    });
  };

  document.querySelectorAll('.trip-swipe-card').forEach((card) => {
    let startX = 0;
    let startY = 0;
    let baseOffset = 0;
    let currentX = 0;
    let isHorizontal = null;

    card.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      baseOffset = card.dataset.swipeOpen === 'true' ? -MAX_SWIPE : 0;
      currentX = baseOffset;
      isHorizontal = null;
      card.style.transition = 'none';
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;

      if (isHorizontal === null) {
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
          isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.15;
          if (isHorizontal) closeAllSwipes(card);
        } else {
          return;
        }
      }
      if (!isHorizontal) return;

      const next = Math.max(-MAX_SWIPE, Math.min(0, baseOffset + dx));
      currentX = next;
      card.style.transform = `translateX(${next}px)`;
    }, { passive: true });

    card.addEventListener('touchend', () => {
      if (!isHorizontal) return;
      card.style.transition = 'transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)';
      if (currentX <= -MAX_SWIPE / 2) {
        card.style.transform = `translateX(-${MAX_SWIPE}px)`;
        card.dataset.swipeOpen = 'true';
      } else {
        card.style.transform = 'translateX(0px)';
        card.dataset.swipeOpen = 'false';
      }
      card.dataset.justSwiped = 'true';
      setTimeout(() => { card.dataset.justSwiped = 'false'; }, 250);
    }, { passive: true });
  });
}

async function handleDeleteTrip(tripId) {
  if (!isAdmin()) return;
  const trip = state.trips.find((t) => t.id === tripId);
  if (!trip) return;

  const ok = window.confirm(
    `確定永久刪除「${trip.name}」？\n此操作會一併清除所有行程、分帳、結算與報平安紀錄，且無法復原。`
  );
  if (!ok) return;

  try {
    showToast('正在刪除旅行與關聯資料...');
    const subNames = ['itineraries', 'expenses', 'settlementTransfers', 'safeHomeCheckIns'];
    const refsToDelete = [];

    for (const sub of subNames) {
      const snap = await getDocs(collection(db, 'trips', tripId, sub));
      snap.docs.forEach((d) => refsToDelete.push(d.ref));
    }

    // 分批刪除子集合文件（單批上限 450 筆以符合 Firestore 500 限制）
    for (let i = 0; i < refsToDelete.length; i += 450) {
      const batch = writeBatch(db);
      refsToDelete.slice(i, i + 450).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }

    await deleteDoc(doc(db, 'trips', tripId));

    if (state.activeTripId === tripId) {
      clearTripDetailListeners();
      state.activeTripId = null;
      state.animatePage = true;
      window.location.hash = '';
    }
    showToast(`已刪除「${trip.name}」`, 'success');
    render();
  } catch (err) {
    console.error(err);
    showToast('刪除失敗，請確認管理員權限或網路連線', 'error');
  }
}

async function handleRequestAccountDeletion() {
  if (isAdmin()) return;
  const ok = window.confirm('確定送出刪除帳號申請？送出後會通知管理員審核並移除你的登入帳號。');
  if (!ok) return;

  try {
    await updateDoc(doc(db, 'users', state.user.uid), {
      deletionRequested: true,
      deletionRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    state.profile.deletionRequested = true;

    if (cfg.gasBridgeUrl) {
      const res = await callGasBridge('requestAccountDeletion', {
        displayName: state.profile.displayName || state.user.email,
        email: state.user.email
      });
      showToast(res.ok ? '已送出申請並推播通知管理員' : '已送出申請，待管理員審核', 'success');
    } else {
      showToast('已送出刪除帳號申請，待管理員審核', 'success');
    }
    render();
  } catch (err) {
    console.error(err);
    showToast('申請送出失敗，請稍後再試', 'error');
  }
}

async function handleCancelAccountDeletion() {
  try {
    await updateDoc(doc(db, 'users', state.user.uid), {
      deletionRequested: false,
      deletionRequestedAt: null,
      updatedAt: serverTimestamp()
    });
    state.profile.deletionRequested = false;
    showToast('已取消刪除帳號申請');
    render();
  } catch (err) {
    console.error(err);
    showToast('取消失敗，請稍後再試', 'error');
  }
}

async function handleReviewAccountDeletion(targetUid, decision) {
  if (!isAdmin() || !targetUid) return;
  const targetUser = state.allUsers.find((u) => u.id === targetUid);
  const label = targetUser ? `${targetUser.displayName} (${targetUser.email})` : targetUid;

  if (decision === 'approve') {
    const ok = window.confirm(
      `確定核准並永久移除帳號「${label}」？\n對方將無法再登入，歷史旅行將保留其舊名稱以維持足跡完整。`
    );
    if (!ok) return;
  }

  if (!cfg.gasBridgeUrl) {
    showToast('需先部署 GAS 跳板才能執行帳號審核移除', 'error');
    return;
  }

  try {
    showToast(decision === 'approve' ? '正在移除帳號並更新歸戶名單...' : '正在駁回申請...');
    const res = await callGasBridge('reviewAccountDeletion', {
      targetUid,
      decision
    });
    if (!res.ok) {
      showToast(res.error || '審核操作失敗', 'error');
      return;
    }
    await loadAllUsersIfAdmin();
    showToast(decision === 'approve' ? '已永久移除該帳號' : '已駁回刪除申請並通知成員', 'success');
    render();
  } catch (err) {
    console.error(err);
    showToast('審核操作發生錯誤', 'error');
  }
}

/* ============================= 啟動認證監聽 ============================= */
if (isConfigured) {
  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    state.authReady = true;
    clearTripDetailListeners();
    state.activeTripId = null;

    if (!user) {
      state.profile = null;
      state.trips = [];
      if (unsubTrips) { try { unsubTrips(); } catch {} }
      render();
      return;
    }

    const userRef = doc(db, 'users', user.uid);
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      state.profile = snap.data();
    } else {
      state.profile = {
        email: user.email,
        displayName: user.email.split('@')[0],
        role: 'member',
        fcmTokens: {}
      };
      await setDoc(userRef, { ...state.profile, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    }

    subscribeTrips();
    if (isAdmin()) loadAllUsersIfAdmin();
    render();
  });
} else {
  render();
}
