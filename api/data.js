// 管理台資料 API：所有請求都要帶 x-admin-token（= Vercel 環境變數 ADMIN_TOKEN）
const store = require("./_store.js");
const { syncMembers } = require("./_sync.js");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.ADMIN_TOKEN) return res.status(503).json({ ok: false, error: "尚未設定 ADMIN_TOKEN 環境變數" });
  if (!store.authOk(req)) return res.status(401).json({ ok: false, error: "管理密鑰不正確" });
  if (!store.configured()) return res.status(503).json({ ok: false, error: "尚未連接資料庫，請在 Vercel 的 Storage 加入 Upstash Redis 後重新部署" });

  const op = String(req.query.op || "");
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    if (op === "load") {
      const month = String(req.query.month || "");
      const [members, stats, settings, sync, imports] = await Promise.all([
        store.allMembers(), store.monthStats(month), store.getConfig("settings"), store.getConfig("sync"), store.imports(60),
      ]);
      return res.json({ ok: true, members, stats, settings, sync, imports });
    }
    if (op === "stats") return res.json({ ok: true, stats: await store.monthStats(String(req.query.month || "")) });
    if (req.method !== "POST" && op !== "backup") return res.status(405).json({ ok: false, error: "請使用 POST" });
    if (op === "hist") {
      if (!store.ID_RE.test(String(body.memberId || ""))) return res.status(400).json({ ok: false, error: "會員 ID 格式錯誤" });
      return res.json({ ok: true, list: await store.memberHistory(body.memberId, Array.isArray(body.months) ? body.months : []) });
    }
    if (op === "bulk") {
      const writes = Array.isArray(body.writes) ? body.writes : [];
      if (writes.length > 2000) return res.status(400).json({ ok: false, error: "單次寫入過多" });
      return res.json({ ok: true, count: await store.bulk(writes) });
    }
    if (op === "sync") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x) => store.ID_RE.test(String(x))).slice(0, 15);
      if (!ids.length) return res.status(400).json({ ok: false, error: "請提供會員 ID" });
      return res.json({ ok: true, ...(await syncMembers(ids, { budgetMs: 40000 })) });
    }
    if (op === "backup") return res.json({ ok: true, ...(await store.backup()) });
    return res.status(400).json({ ok: false, error: "未知的操作" });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "伺服器錯誤" });
  }
};
