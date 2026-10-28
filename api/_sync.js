// 從 BingX 同步會員本月數據並寫入資料庫（網頁與每日排程共用）
const { snapshotUid, monthRangeFor } = require("./broker.js");
const store = require("./_store.js");

const num = (v) => { if (v == null || v === "") return null; const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const pushTL = (m, text, at) => [...(m.timeline || []), { at, type: "sync", text }].slice(-200);

function apply(mem, prev, row, month, at) {
  const m = { ...mem }; const notes = [];
  let stat = null;
  if (row.status === "ok" || row.status === "not_invited") {
    if (typeof row.invited === "boolean" && m.downline !== row.invited) { m.downline = row.invited; notes.push(row.invited ? "確認為邀請用戶" : "不是邀請用戶"); }
    if (row.kyc && m.kyc !== row.kyc) { m.kyc = row.kyc; notes.push("KYC " + row.kyc); }
    if (row.registerDateTime && !m.registerAt) { const t = Number(row.registerDateTime); if (Number.isFinite(t)) m.registerAt = new Date(t).toISOString(); }
  }
  if (row.status === "ok") {
    const vol = num(row.volume);
    const p = prev || {};
    const history = [...(p.history || [])];
    if (p.volume !== vol) history.push({ at, volume: vol, source: "api" });
    stat = {
      memberId: mem.id, month, volume: vol, tradeDays: row.tradeDays ?? null,
      lastTradeAt: row.lastTradeAt || p.lastTradeAt || null, asset: num(row.balance), commission: num(row.commission),
      updatedAt: at, source: "api", history: history.slice(-60),
    };
  }
  if (notes.length) m.timeline = pushTL(m, "BingX 同步：" + notes.join("；"), at);
  m.lastSyncAt = at; m.lastSyncStatus = row.status;
  return { member: m, stat };
}

async function syncMembers(ids, { budgetMs = 20000, concurrency = 3 } = {}) {
  const range = monthRangeFor(); const month = range.month;
  const members = await store.getMembers(ids);
  const stats = await store.monthStats(month, ids);
  const list = ids.filter((id) => members[id] && /^\d{4,20}$/.test(String(members[id].uid || "").trim()));
  const started = Date.now(); const results = []; const writes = []; const outMembers = {}; const outStats = {};
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const id = list[i++];
      if (Date.now() - started > budgetMs) { results.push({ id, status: "timeout" }); continue; }
      const mem = { ...members[id], id };
      let row;
      try { row = await snapshotUid(String(mem.uid).trim(), range); } catch (e) { row = { status: "error", message: e.message }; }
      const at = new Date().toISOString();
      const { member, stat } = apply(mem, stats[id], row, month, at);
      writes.push({ t: "member", id, data: member }); outMembers[id] = member;
      if (stat) { writes.push({ t: "stat", month, id, data: stat }); outStats[id] = stat; }
      results.push({ id, status: row.status });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  await store.bulk(writes);
  return { month, results, members: outMembers, stats: outStats };
}

module.exports = { syncMembers };
