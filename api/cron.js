// 每日自動同步（由 vercel.json 的 crons 觸發）
// 依「最久沒更新」的順序同步，一次跑不完的會在下次（或打開網頁時）接著跑。
const store = require("./_store.js");
const { syncMembers } = require("./_sync.js");
const { monthRangeFor } = require("./broker.js");

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const ua = String(req.headers["user-agent"] || "");
  const authorized = secret ? req.headers.authorization === `Bearer ${secret}` : ua.startsWith("vercel-cron");
  if (!authorized) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!store.configured()) return res.status(503).json({ ok: false, error: "資料庫未連接" });

  try {
    const range = monthRangeFor(); const month = range.month;
    const members = await store.allMembers();
    const stats = await store.monthStats(month);
    const monthStart = range.startMs;
    const ids = Object.entries(members)
      .filter(([, m]) => /^\d{4,20}$/.test(String(m.uid || "").trim()) && (m.inGroup || (m.leftAt && Date.parse(m.leftAt) >= monthStart)))
      .sort(([a], [b]) => String(stats[a]?.updatedAt || "").localeCompare(String(stats[b]?.updatedAt || "")))
      .map(([id]) => id);
    const budget = Number(process.env.CRON_BUDGET_MS || 50000);
    const r = await syncMembers(ids, { budgetMs: budget });
    const left = r.results.filter((x) => x.status === "timeout").length;
    const sync = await store.getConfig("sync");
    const now = new Date().toISOString();
    await store.bulk([{ t: "config", key: "sync", data: { ...sync, cronAt: now, cronDone: ids.length - left, cronTotal: ids.length, ...(left === 0 ? { bingxAsOf: now } : {}) } }]);
    return res.json({ ok: true, month, total: ids.length, done: ids.length - left, remaining: left });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
