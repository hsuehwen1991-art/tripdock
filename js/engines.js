import { db, doc, getDoc, setDoc, collection, query, where, orderBy, limit, getDocs, serverTimestamp } from './firebase.js';

export const MEAL_PERIOD_LABELS = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  afternoon_tea: '下午茶',
  snack: '點心',
  late_night: '宵夜'
};

export const TRANSPORT_MODE_LABELS = {
  flight: '航班',
  transit: '大眾運輸',
  car: '汽車接駁'
};

export const TICKETING_OPTIONS = ['車票', '儲值交通卡', '信用卡'];

export const CURRENCIES = [
  { code: 'TWD', label: 'TWD 新臺幣' },
  { code: 'JPY', label: 'JPY 日圓' },
  { code: 'KRW', label: 'KRW 韓元' },
  { code: 'THB', label: 'THB 泰銖' },
  { code: 'USD', label: 'USD 美元' },
  { code: 'EUR', label: 'EUR 歐元' },
  { code: 'GBP', label: 'GBP 英鎊' },
  { code: 'SGD', label: 'SGD 新幣' },
  { code: 'HKD', label: 'HKD 港幣' },
  { code: 'IDR', label: 'IDR 印尼盾' }
];

/**
 * 一鍵均分尾數進位計算引擎 (PRD v3.2 §4.5)
 * 可整除 -> 每人 T/N；不可整除 -> 基準值 B = floor(T/N)，代墊人(若在名單內)負擔 B，非代墊人一律負擔 B+1
 */
export function calculateEqualSplits(twdAmount, participantIds, payerId) {
  const T = Math.round(Number(twdAmount) || 0);
  const ids = [...new Set(participantIds || [])];
  const N = ids.length;
  if (T <= 0 || N === 0) {
    return { splits: [], splitTotalTwd: 0, roundingSurplusTwd: 0 };
  }

  const divisible = T % N === 0;
  const base = Math.floor(T / N);

  const splits = ids.map((uid) => {
    if (divisible) {
      return { userId: uid, twdShare: T / N, isRoundedUp: false };
    }
    const isPayer = uid === payerId;
    return {
      userId: uid,
      twdShare: isPayer ? base : base + 1,
      isRoundedUp: !isPayer
    };
  });

  const splitTotalTwd = splits.reduce((sum, s) => sum + s.twdShare, 0);
  return {
    splits,
    splitTotalTwd,
    roundingSurplusTwd: splitTotalTwd - T
  };
}

/**
 * 嚴格零和結算與最少轉帳次數 (Greedy) 演算法 (PRD v3.2 §4.5)
 * 個人自付 (splits 僅含 payerId) 不產生任何非代墊人債權移轉，自動不影響收付。
 */
export function calculateSettlement(expenses, memberIds) {
  const netMap = {};
  (memberIds || []).forEach((uid) => { netMap[uid] = 0; });

  const personalSpendMap = {};
  (memberIds || []).forEach((uid) => { personalSpendMap[uid] = 0; });

  let totalExpenseTwd = 0;

  (expenses || []).forEach((exp) => {
    const twdAmt = Number(exp.twdAmount) || 0;
    totalExpenseTwd += twdAmt;

    const payerId = exp.payerId;
    if (!(payerId in netMap)) netMap[payerId] = 0;
    if (!(payerId in personalSpendMap)) personalSpendMap[payerId] = 0;

    (exp.splits || []).forEach((s) => {
      const share = Number(s.twdShare) || 0;
      if (!(s.userId in netMap)) netMap[s.userId] = 0;
      if (!(s.userId in personalSpendMap)) personalSpendMap[s.userId] = 0;

      personalSpendMap[s.userId] += share;

      if (s.userId !== payerId && share > 0) {
        netMap[s.userId] -= share;
        netMap[payerId] += share;
      }
    });
  });

  // Greedy 配對產出最少轉帳次數清單
  const creditors = [];
  const debtors = [];
  Object.entries(netMap).forEach(([userId, balance]) => {
    if (balance > 0) creditors.push({ userId, amount: balance });
    else if (balance < 0) debtors.push({ userId, amount: -balance });
  });

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    if (pay > 0) {
      transfers.push({
        fromUserId: debtors[i].userId,
        toUserId: creditors[j].userId,
        amountTwd: pay
      });
    }
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount === 0) i++;
    if (creditors[j].amount === 0) j++;
  }

  return {
    totalExpenseTwd,
    netMap,
    personalSpendMap,
    transfers
  };
}

/**
 * 計算特定行程與特定登入者的個人款項清單與總額
 */
export function getLinkedPersonalExpenses(expenses, itineraryId, currentUid) {
  const matched = [];
  let total = 0;
  (expenses || []).forEach((exp) => {
    if (exp.linkedItineraryId !== itineraryId) return;
    const mySplit = (exp.splits || []).find((s) => s.userId === currentUid);
    if (mySplit && mySplit.twdShare > 0) {
      matched.push({
        id: exp.id,
        title: exp.title,
        twdShare: mySplit.twdShare,
        isPersonalExpense: Boolean(exp.isPersonalExpense)
      });
      total += mySplit.twdShare;
    }
  });
  return { items: matched, total };
}

/**
 * 直式個人並行時間軸重疊分群演算法 (PRD v3.2 §5.2)
 * 住宿(accommodation)不參與白日重疊判定，獨立呈現於頁首卡片。
 */
export function buildDailyTimelineSlots(itineraries, dateKey, currentUid) {
  const dayEvents = (itineraries || [])
    .filter((it) => it.type !== 'accommodation' && it.dateKey === dateKey)
    .map((it) => ({
      ...it,
      _startMs: new Date(it.startTime).getTime() || 0,
      _endMs: new Date(it.endTime).getTime() || (new Date(it.startTime).getTime() || 0) + 3600000,
      _isMine: Array.isArray(it.participantIds) && it.participantIds.includes(currentUid)
    }))
    .sort((a, b) => {
      if (a._startMs !== b._startMs) return a._startMs - b._startMs;
      if (a._isMine !== b._isMine) return a._isMine ? -1 : 1;
      return a._endMs - b._endMs;
    });

  const slots = [];
  dayEvents.forEach((evt) => {
    // 尋找是否與最後一個群組時間重疊 (A.start < B.end && B.start < A.end)
    let targetSlot = null;
    for (let idx = slots.length - 1; idx >= 0; idx--) {
      const slot = slots[idx];
      if (evt._startMs < slot.maxEndMs && slot.minStartMs < evt._endMs) {
        targetSlot = slot;
        break;
      }
    }

    if (!targetSlot) {
      slots.push({
        minStartMs: evt._startMs,
        maxEndMs: evt._endMs,
        startLabel: formatTimeHHMM(evt.startTime),
        primaryEvents: evt._isMine ? [evt] : [],
        parallelOtherEvents: evt._isMine ? [] : [evt]
      });
    } else {
      targetSlot.minStartMs = Math.min(targetSlot.minStartMs, evt._startMs);
      targetSlot.maxEndMs = Math.max(targetSlot.maxEndMs, evt._endMs);
      if (evt._isMine) targetSlot.primaryEvents.push(evt);
      else targetSlot.parallelOtherEvents.push(evt);
    }
  });

  return slots;
}

/**
 * 依旅行目標時區取得「今天」的 YYYY-MM-DD
 */
export function getTodayInTimezone(timezone = 'Asia/Taipei') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year').value;
    const m = parts.find((p) => p.type === 'month').value;
    const d = parts.find((p) => p.type === 'day').value;
    return `${y}-${m}-${d}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * 依日期自動選出首頁應顯示的當晚住宿 (PRD v3.2 §4.4 A)
 */
export function getTonightAccommodation(itineraries, trip) {
  const stays = (itineraries || [])
    .filter((it) => it.type === 'accommodation' && it.stayDate)
    .sort((a, b) => a.stayDate.localeCompare(b.stayDate));
  if (stays.length === 0) return null;

  const today = getTodayInTimezone(trip?.timezone || 'Asia/Taipei');
  const exact = stays.find((s) => s.stayDate === today);
  if (exact) return exact;

  if (trip?.status === 'settled' || today < trip.startDate) {
    return stays[0];
  }
  return stays[stays.length - 1];
}

/**
 * 產生旅行起迄之間的所有日期陣列 (YYYY-MM-DD)
 */
export function getTripDateRange(startDate, endDate) {
  const dates = [];
  if (!startDate || !endDate) return dates;
  const cur = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  let guard = 0;
  while (cur <= end && guard < 60) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard++;
  }
  return dates;
}

export function formatTimeHHMM(isoStr) {
  if (!isoStr) return '--:--';
  const match = String(isoStr).match(/T(\d{2}:\d{2})/);
  return match ? match[1] : String(isoStr).slice(11, 16);
}

export function formatDuration(startIso, endIso) {
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  if (!s || !e || e <= s) return '';
  const mins = Math.round((e - s) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h} 小時 ${m} 分`;
  if (h > 0) return `${h} 小時`;
  return `${m} 分`;
}

export function formatShortDateWithWeekday(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd} ${days[d.getDay()]}`;
}

export function getWeekdayIndex(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.getDay(); // 0=日, 1=一 ... 6=六
}

export function buildGoogleMapsUrl(locationOrUrl) {
  if (!locationOrUrl) return '';
  const val = String(locationOrUrl).trim();
  if (/^https?:\/\//i.test(val)) return val;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(val)}`;
}

/**
 * 匯率查詢服務：Firestore 日級快取 -> 免費 CORS API -> 最近營業日降級
 */
export async function fetchExchangeRate(baseCurrency, rateDate) {
  if (!baseCurrency || baseCurrency === 'TWD') {
    return { rate: 1, source: 'base', isFallback: false };
  }
  const cacheKey = `${rateDate}_${baseCurrency}_TWD`;

  // 1. 先查 Firestore 快取
  try {
    const snap = await getDoc(doc(db, 'fx_rates', cacheKey));
    if (snap.exists()) {
      const data = snap.data();
      return { rate: Number(data.rate), source: data.source || 'cache', isFallback: false };
    }
  } catch (e) {
    console.warn('FX cache read failed:', e);
  }

  // 2. 呼叫免金鑰 CORS 匯率 API
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(baseCurrency)}`);
    if (res.ok) {
      const json = await res.json();
      const rate = json?.rates?.TWD;
      if (rate && rate > 0) {
        try {
          await setDoc(doc(db, 'fx_rates', cacheKey), {
            rateDate,
            baseCurrency,
            targetCurrency: 'TWD',
            rate: Number(rate),
            source: 'open.er-api.com',
            fetchedAt: serverTimestamp()
          });
        } catch {}
        return { rate: Number(rate), source: 'open.er-api.com', isFallback: false };
      }
    }
  } catch (e) {
    console.warn('FX live fetch failed:', e);
  }

  // 3. 異常備援：取該幣別最近一筆快取匯率
  try {
    const q = query(
      collection(db, 'fx_rates'),
      where('baseCurrency', '==', baseCurrency),
      where('targetCurrency', '==', 'TWD'),
      orderBy('rateDate', 'desc'),
      limit(1)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      const data = snap.docs[0].data();
      return { rate: Number(data.rate), source: data.rateDate, isFallback: true };
    }
  } catch {}

  return null;
}

/**
 * 封存前自動下載完整分帳明細 UTF-8 BOM CSV
 */
export function exportExpensesCsv(trip, expenses) {
  const dir = trip.memberDirectory || {};
  const nameOf = (uid) => (dir[uid] && dir[uid].displayName) || uid;

  const headers = [
    '消費日期', '項目名稱', '記帳類型', '代墊人', '輸入模式',
    '原始幣別', '原始金額', '鎖定匯率', '實付臺幣', '分攤模式',
    '分攤表列總額', '尾差補貼', '分攤明細', '備註'
  ];

  const rows = (expenses || []).map((e) => {
    const splitDesc = (e.splits || [])
      .map((s) => `${nameOf(s.userId)}:${s.twdShare}${s.isRoundedUp ? '(+1)' : ''}`)
      .join(' / ');
    return [
      e.expenseDate || '',
      e.title || '',
      e.isPersonalExpense ? '個人自付' : '團體代墊',
      nameOf(e.payerId),
      e.twdInputMode === 'direct_twd' ? '刷卡實付臺幣' : '外幣自動換算',
      e.currency || '',
      e.originalAmount ?? '',
      e.exchangeRate ?? '',
      e.twdAmount ?? 0,
      e.splitMode === 'equal' ? '一鍵均分' : '自訂金額',
      e.splitTotalTwd ?? 0,
      e.roundingSurplusTwd ?? 0,
      splitDesc,
      e.note || ''
    ];
  });

  const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csvContent = '\uFEFF' + [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${trip.name || 'TripDock'}_分帳明細備份.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
