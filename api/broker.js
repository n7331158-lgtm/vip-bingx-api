const crypto = require("crypto");

const API_KEY = process.env.BINGX_API_KEY || "";
const SECRET_KEY = process.env.BINGX_SECRET_KEY || "";
const BASE_URL = "https://open-api.bingx.com";

// 交易量查詢快取（10 分鐘），跨請求共用避免重複慢查詢
const VOL_CACHE = global.__CCC_VOL_CACHE__ || new Map();
global.__CCC_VOL_CACHE__ = VOL_CACHE;

function sign(queryString) {
  return crypto.createHmac("sha256", SECRET_KEY).update(queryString).digest("hex");
}

function buildQuery(params) {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp, recvWindow: 5000 };
  const queryString = Object.keys(allParams).sort().map((k) => `${k}=${allParams[k]}`).join("&");
  return `${queryString}&signature=${sign(queryString)}`;
}

async function fetchBingX(path, params = {}) {
  if (!API_KEY || !SECRET_KEY) {
    return { code: -100, msg: "BingX API key is not configured" };
  }
  const query = buildQuery(params);
  const url = `${BASE_URL}${path}?${query}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "X-BX-APIKEY": API_KEY, "X-SOURCE-KEY": "BX-AI-SKILL", "Accept": "application/json" },
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch { json = { code: -101, msg: "BingX returned non-JSON response", raw: text.slice(0, 200) }; }
    if (!res.ok) return { code: res.status, msg: json?.msg || `HTTP ${res.status}`, detail: json };
    return json;
  } catch (e) {
    return { code: -102, msg: e.name === "AbortError" ? "BingX API timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── inviteAccountList 全量搜尋 ──
async function searchInviteAccountList(targetUid) {
  const pageSize = 100;
  let pageIndex = 1;
  let total = null;
  let pagesChecked = 0;
  let found = false;
  let matchedRecord = null;
  let sampleUids = [];
  let firstCode = null;
  let firstMsg = null;
  let lastUid = null;

  while (true) {
    const params = { pageIndex, pageSize };
    if (lastUid) params.lastUid = lastUid;

    const data = await fetchBingX("/openApi/agent/v1/account/inviteAccountList", params);
    pagesChecked++;

    if (pageIndex === 1) { firstCode = data?.code; firstMsg = data?.msg; }
    if (data?.code !== 0) {
      return { code: firstCode, msg: firstMsg, total, pagesChecked, found: false, matchedRecord: null, sampleUids, apiError: true };
    }

    const records = data?.data?.list || data?.data?.result || data?.data?.records || data?.data?.data || [];
    if (total === null) total = data?.data?.total || data?.data?.totalCount || 0;

    if (sampleUids.length < 20) {
      for (const r of records) {
        if (sampleUids.length >= 20) break;
        const u = String(r.uid || r.userId || r.memberId || "").trim();
        if (u) sampleUids.push(u);
      }
    }

    for (const r of records) {
      const rUid = String(r.uid || r.userId || r.memberId || "").trim();
      if (rUid === String(targetUid).trim()) { found = true; matchedRecord = r; break; }
    }

    if (found) break;
    if (!records.length) break;

    const hasMore = total ? (pageIndex * pageSize < total) : (records.length === pageSize);
    if (!hasMore) break;

    const lastRecord = records[records.length - 1];
    lastUid = lastRecord?.uid || lastRecord?.userId || null;
    pageIndex++;
    if (pagesChecked > 60) break; // 限制翻頁上限，避免 Vercel 10 秒逾時（60 頁 = 6000 筆名單）
  }

  return { code: firstCode, msg: firstMsg, total, pagesChecked, found, matchedRecord, sampleUids, apiError: false };
}

// ── superiorCheck ──
async function callSuperiorCheck(uid) {
  try { return await fetchBingX("/openApi/agent/v1/account/superiorCheck", { uid: String(uid).trim() }); }
  catch (e) { return { code: -1, msg: e.message }; }
}

// ── inviteRelationCheck（含交易量詳情）──
async function callInviteRelationCheck(uid) {
  try { return await fetchBingX("/openApi/agent/v1/account/inviteRelationCheck", { uid: String(uid).trim() }); }
  catch (e) { return { code: -1, msg: e.message }; }
}

function taipeiDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).reduce((a, p) => (a[p.type] = p.value, a), {});
  return { y: parts.year, m: parts.month, d: parts.day };
}

// 指定月份（YYYY-MM，台灣時間）的起訖；當月的結束時間為現在
function monthRangeFor(month) {
  const now = taipeiDateParts();
  const cur = `${now.y}-${now.m}`;
  if (!month || month === cur) return monthRangeTaipei();
  const [y, m] = month.split("-");
  const startMs = Date.parse(`${y}-${m}-01T00:00:00+08:00`);
  let ny = +y, nm = +m + 1; if (nm > 12) { nm = 1; ny++; }
  const endMs = Date.parse(`${ny}-${String(nm).padStart(2, "0")}-01T00:00:00+08:00`) - 1;
  const lastDay = taipeiDateParts(new Date(endMs)).d;
  return { month, startTime: `${y}-${m}-01`, endTime: `${y}-${m}-${lastDay}`, startMs, endMs };
}

function monthRangeTaipei() {
  const now = taipeiDateParts();
  // 台灣月初 00:00 與當下的毫秒 timestamp（台灣 = UTC+8）
  const startMs = Date.parse(`${now.y}-${now.m}-01T00:00:00+08:00`);
  const endMs = Date.now();
  return {
    month: `${now.y}-${now.m}`,
    startTime: `${now.y}-${now.m}-01`,
    endTime: `${now.y}-${now.m}-${now.d}`,
    startMs,
    endMs,
  };
}

function extractRecords(data) {
  return data?.data?.list || data?.data?.records || data?.data?.data || data?.list || [];
}

function n(v) {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
}

async function queryMonthlyTradingVolume(uid) {
  const { month, startTime, endTime, startMs, endMs } = monthRangeTaipei();
  const cleanUid = String(uid).trim();

  // 先試毫秒 timestamp 格式，失敗再退回日期字串格式
  for (const fmt of ["ms", "date"]) {
    const result = await tryFetchVolume(cleanUid, fmt === "ms"
      ? { startTime: startMs, endTime: endMs }
      : { startTime, endTime });
    if (result.ok || result.code === 0) {
      return { ...result, month, startTime, endTime, timeFormat: fmt };
    }
    // 若是明確的「無資料」(code 0 但空) 也直接回，不重試
    if (result.recordsCount === 0 && result.code === 0) {
      return { ...result, ok: true, month, startTime, endTime, timeFormat: fmt };
    }
  }
  // 兩種格式都失敗
  const last = await tryFetchVolume(cleanUid, { startTime: startMs, endTime: endMs });
  return { ...last, month, startTime, endTime };
}

async function tryFetchVolume(uid, timeParams) {
  let pageIndex = 1;
  const pageSize = 100;
  let total = null;
  let monthlyVolume = 0;
  let commissionVolume = 0;
  let recordsCount = 0;
  let firstRaw = null;
  let firstCode = null;
  let firstMsg = null;
  const tradeDaySet = new Set();
  let lastTradeMs = null;

  while (pageIndex <= 20) {
    const data = await fetchBingX("/openApi/agent/v1/reward/commissionDataList", {
      uid,
      ...timeParams,
      pageIndex,
      pageSize,
    });
    if (pageIndex === 1) { firstCode = data?.code; firstMsg = data?.msg; }
    if (data?.code !== 0) {
      return { ok:false, code:firstCode, msg:firstMsg || data?.msg, monthlyVolume:null, recordsCount, rawSample:firstRaw };
    }
    const records = extractRecords(data);
    if (!firstRaw && records[0]) firstRaw = records[0];
    total = data?.data?.total ?? total;
    recordsCount += records.length;
    for (const r of records) {
      const v = n(r.tradingVolume);
      monthlyVolume += v;
      commissionVolume += n(r.commissionVolume);
      // 若紀錄帶有時間欄位，順便算交易天數與最後交易時間（欄位不存在就留空）
      const t = r.commissionTime ?? r.tradeTime ?? r.time ?? r.date ?? r.statTime ?? null;
      if (v > 0 && t != null) {
        const ms = typeof t === "number" || /^\d{10,13}$/.test(String(t)) ? (String(t).length === 10 ? +t * 1000 : +t) : Date.parse(t);
        if (Number.isFinite(ms)) {
          const p = taipeiDateParts(new Date(ms));
          tradeDaySet.add(`${p.y}-${p.m}-${p.d}`);
          if (!lastTradeMs || ms > lastTradeMs) lastTradeMs = ms;
        }
      }
    }
    const hasMore = total ? pageIndex * pageSize < total : records.length === pageSize;
    if (!hasMore) break;
    pageIndex++;
  }

  return {
    ok:true,
    code: firstCode,
    monthlyVolume: String(Math.round(monthlyVolume * 100) / 100),
    commissionVolume: String(Math.round(commissionVolume * 100) / 100),
    recordsCount,
    sourceField: "tradingVolume",
    rawSample: firstRaw,
    tradeDays: tradeDaySet.size || null,
    lastTradeAt: lastTradeMs ? new Date(lastTradeMs).toISOString() : null,
  };
}

// ── 批次查詢（VIP 管理台用）──
// 一次查多個 UID 的指定月份交易額、資產、KYC、是否為邀請用戶。
// 受 Vercel 10 秒限制：每批最多 10 個 UID，超過時間預算的 UID 會標記為 timeout，下次再查。
const BATCH_MAX = 10;
const BATCH_BUDGET_MS = 7500;

async function volumeForRange(uid, range) {
  for (const tp of [{ startTime: range.startMs, endTime: range.endMs }, { startTime: range.startTime, endTime: range.endTime }]) {
    const r = await tryFetchVolume(uid, tp);
    if (r.ok) return r;
  }
  return { ok: false };
}

async function snapshotUid(uid, range) {
  const cleanUid = String(uid || "").trim();
  if (!/^\d{4,20}$/.test(cleanUid)) return { uid: cleanUid, status: "invalid_uid" };
  const [superiorRaw, relationRaw] = await Promise.all([callSuperiorCheck(cleanUid), callInviteRelationCheck(cleanUid)]);
  if (relationRaw?.code !== 0 && superiorRaw?.code !== 0) return { uid: cleanUid, status: "api_error", message: relationRaw?.msg || superiorRaw?.msg };
  const invited = (relationRaw?.code === 0 && relationRaw?.data?.inviteResult === true) || (superiorRaw?.code === 0 && superiorRaw?.data?.inviteResult === true);
  const rd = relationRaw?.data || {};
  const base = { uid: cleanUid, invited, kyc: rd.kycResult === true ? "已完成" : rd.kycResult === false ? "未完成" : "", balance: rd.balanceVolume ?? "", registerDateTime: rd.registerDateTime || "" };
  if (!invited) return { ...base, status: "not_invited" };
  const vol = await volumeForRange(cleanUid, range);
  if (!vol.ok) return { ...base, status: "volume_unavailable" };
  return { ...base, status: "ok", volume: vol.monthlyVolume, commission: vol.commissionVolume, tradeDays: vol.tradeDays, lastTradeAt: vol.lastTradeAt };
}

async function batchSnapshot(uids, month) {
  const range = monthRangeFor(month);
  const started = Date.now();
  const out = new Array(uids.length);
  let i = 0;
  const worker = async () => {
    while (i < uids.length) {
      const k = i++;
      if (Date.now() - started > BATCH_BUDGET_MS) { out[k] = { uid: uids[k], status: "timeout" }; continue; }
      try { out[k] = await snapshotUid(uids[k], range); }
      catch (e) { out[k] = { uid: uids[k], status: "error", message: e.message }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, uids.length) }, worker));
  return { month: range.month, checkedAt: new Date().toISOString(), rows: out };
}

function toCsv(result) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["UID", "月份", "交易額", "資產", "KYC", "是否旗下", "交易天數", "最後交易時間", "佣金", "狀態", "資料截至"];
  const lines = [head.map(q).join(",")];
  for (const r of result.rows) {
    lines.push([
      r.uid, result.month, r.status === "ok" ? r.volume : "", r.balance ?? "", r.kyc ?? "",
      r.invited === undefined ? "" : (r.invited ? "是" : "否"), r.tradeDays ?? "", r.lastTradeAt ?? "",
      r.commission ?? "", r.status, result.checkedAt,
    ].map(q).join(","));
  }
  return "\uFEFF" + lines.join("\r\n");
}

function tokenOk(req) {
  const need = process.env.ADMIN_TOKEN || "";
  return need && String(req.query.token || "") === need;
}

// ── 主驗證函式 ──
// ── 輕量驗證：只用 inviteRelationCheck + superiorCheck，不翻 200 頁名單 ──
// 用於 volume 查詢，避免 Vercel 10 秒逾時
async function verifyUidLight(uid) {
  const cleanUid = String(uid || "").trim();
  if (!/^\d{4,20}$/.test(cleanUid)) {
    return { ok: false, invited: false, code: "INVALID_UID", message: "UID 格式不正確。" };
  }
  if (!API_KEY || !SECRET_KEY) {
    return { ok: false, invited: false, code: "BINGX_CONFIG_MISSING", message: "BingX API 尚未設定。" };
  }
  const [superiorRaw, relationRaw] = await Promise.all([
    callSuperiorCheck(cleanUid),
    callInviteRelationCheck(cleanUid),
  ]);
  let invited = false;
  if (relationRaw?.code === 0 && relationRaw?.data?.inviteResult === true) invited = true;
  else if (superiorRaw?.code === 0 && superiorRaw?.data?.inviteResult === true) invited = true;
  const rd = relationRaw?.data || {};
  return {
    ok: true,
    invited,
    directInvitation: rd.directInvitation ?? superiorRaw?.data?.directInvitation ?? false,
    message: invited ? "驗證成功" : "此 UID 不是邀請用戶",
  };
}

async function verifyUid(uid) {
  const apiKeyPreview = API_KEY ? `${API_KEY.slice(0, 5)}...${API_KEY.slice(-4)}` : "未設定";
  const cleanUid = String(uid || "").trim();

  if (!/^\d{4,20}$/.test(cleanUid)) {
    return { ok: false, invited: false, code: "INVALID_UID", message: "UID 格式不正確，請輸入 BingX 數字 UID。" };
  }
  if (!API_KEY || !SECRET_KEY) {
    return { ok: false, invited: false, code: "BINGX_CONFIG_MISSING", message: "BingX API 尚未完成環境變數設定。", detail: "Missing BINGX_API_KEY or BINGX_SECRET_KEY" };
  }

  const [listResult, superiorRaw, relationRaw] = await Promise.all([
    searchInviteAccountList(cleanUid),
    callSuperiorCheck(cleanUid),
    callInviteRelationCheck(cleanUid),
  ]);

  let invited = false;
  let source = "none";
  let reason = "";

  if (listResult.found) {
    invited = true; source = "inviteAccountList"; reason = `在邀請名單第 ${listResult.pagesChecked} 頁找到 UID`;
  } else if (superiorRaw?.code === 0 && superiorRaw?.data?.inviteResult === true) {
    invited = true; source = "superiorCheck"; reason = "superiorCheck 回傳 inviteResult: true";
  } else if (relationRaw?.code === 0 && relationRaw?.data?.inviteResult === true) {
    invited = true; source = "inviteRelationCheck"; reason = "inviteRelationCheck 回傳 inviteResult: true";
  } else if (listResult.apiError && superiorRaw?.code !== 0 && relationRaw?.code !== 0) {
    return { ok: false, invited: false, message: "BingX API 查詢失敗", debug: { apiKeyPreview, listResult, superiorRaw, relationRaw } };
  } else {
    reason = "三種查法均完成，未找到此 UID";
  }

  // 整合交易數據（優先從 inviteRelationCheck 取得）
  const rd = relationRaw?.data || {};
  const ld = listResult.matchedRecord || {};

  const accountData = {
    uid: cleanUid,
    directInvitation: rd.directInvitation ?? superiorRaw?.data?.directInvitation ?? false,
    inviteCode: rd.inviteCode || ld.inviteCode || null,
    registerDateTime: rd.registerDateTime || ld.registerDateTime || null,
    balanceVolume: rd.balanceVolume || ld.balanceVolume || "0",
    deposit: rd.deposit || false,
    trade: rd.trade || false,
    kycResult: rd.kycResult || false,
    userLevel: rd.userLevel || null,
    commissionRatio: rd.commissionRatio || null,
    currentBenefit: rd.currentBenefit || null,
    benefitRatio: rd.benefitRatio || null,
    benefitExpiration: rd.benefitExpiration || null,
  };

  return {
    ok: true,
    invited,
    directInvitation: accountData.directInvitation,
    message: invited ? "驗證成功，您是本社群認證會員" : "此 UID 不是本社群的邀請用戶",
    account: accountData,
    debug: { apiKeyPreview, listResult, superiorRaw, relationRaw, finalDecision: { invited, source, reason } },
  };
}

// ── Vercel Handler ──
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, uid } = req.query;

  try {
    if (action === "batch") {
      if (!process.env.ADMIN_TOKEN) return res.status(503).json({ ok: false, error: "尚未設定 ADMIN_TOKEN 環境變數" });
      if (!tokenOk(req)) return res.status(401).json({ ok: false, error: "管理密鑰不正確" });
      const uids = String(req.query.uids || "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
      if (!uids.length) return res.status(400).json({ ok: false, error: "請提供 uids" });
      if (uids.length > BATCH_MAX) return res.status(400).json({ ok: false, error: `每批最多 ${BATCH_MAX} 個 UID` });
      const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? req.query.month : null;
      const result = await batchSnapshot(uids, month);
      if (req.query.format === "csv") {
        const name = `bingx_${result.month}_${Date.now()}.csv`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).send(toCsv(result));
      }
      return res.status(200).json({ ok: true, ...result });
    }

    // 設定 ADMIN_TOKEN 後，debug / test 需要帶 token，避免公開暴露除錯資訊
    if ((action === "debug" || action === "test") && process.env.ADMIN_TOKEN && !tokenOk(req)) {
      return res.status(401).json({ ok: false, error: "需要管理密鑰" });
    }

    if (action === "verify" && uid) {
      const result = await verifyUid(uid);
      return res.status(200).json({
        valid: !!result.invited,
        ok: !!result.ok,
        account: result.account || null,
        message: result.message,
        directInvitation: !!result.directInvitation,
        code: result.code || null,
        detail: result.detail || null,
        checkedAt: new Date().toISOString(),
        source: "BingX Agent API",
      });
    }

    if (action === "volume" && uid) {
      const cleanUid = String(uid).trim();
      // server-side cache：10 分鐘內同一 UID 直接回快取，避免重複查詢
      const cacheKey = `vol:${cleanUid}`;
      const cached = VOL_CACHE.get(cacheKey);
      if (cached && Date.now() - cached.ts < 10 * 60_000) {
        return res.status(200).json({ ...cached.data, cached: true });
      }
      // 用輕量驗證（不翻 200 頁名單，避免逾時）
      const result = await verifyUidLight(cleanUid);
      if (!result.ok || !result.invited) {
        return res.status(200).json({
          ok: false, valid: !!result.invited, uid: cleanUid,
          monthlyVolume: null, checkedAt: new Date().toISOString(),
          source: "BingX Agent API", note: "uid_not_verified", message: result.message,
        });
      }
      const volume = await queryMonthlyTradingVolume(cleanUid);
      const payload = {
        ok: !!volume.ok, valid: true, uid: cleanUid,
        month: volume.month, startTime: volume.startTime, endTime: volume.endTime,
        monthlyVolume: volume.monthlyVolume, commissionVolume: volume.commissionVolume,
        recordsCount: volume.recordsCount, checkedAt: new Date().toISOString(),
        source: "BingX commissionDataList", sourceField: volume.sourceField || "tradingVolume",
        timeFormat: volume.timeFormat || null,
        note: volume.ok ? "monthly_trading_volume" : "monthly_volume_unavailable",
        message: volume.ok ? "本月交易量同步完成" : (volume.msg || "BingX 本月交易量暫時無法同步"),
        rawSample: volume.rawSample,
      };
      if (volume.ok) VOL_CACHE.set(cacheKey, { ts: Date.now(), data: payload });
      return res.status(200).json(payload);
    }

    if (action === "debug" && uid) {
      return res.status(200).json(await verifyUid(uid));
    }

    if (action === "test") {
      return res.status(200).json(await verifyUid(uid || "18636072"));
    }

    return res.status(400).json({ ok:false, valid:false, error: "請使用 action=verify&uid=UID" });
  } catch (err) {
    return res.status(500).json({ ok:false, valid:false, error: "伺服器錯誤", detail: err.message, checkedAt: new Date().toISOString() });
  }
};
