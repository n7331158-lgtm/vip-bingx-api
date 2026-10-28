// 資料儲存：Upstash Redis（REST API，不需安裝套件）
// Vercel 加入 Upstash 整合後會自動提供 KV_REST_API_URL / KV_REST_API_TOKEN（或 UPSTASH_REDIS_REST_*）
// 檔名以底線開頭，Vercel 不會把它當成對外 API。
const crypto = require("crypto");

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const CONFIG_KEYS = new Set(["settings", "sync"]);

function configured() { return !!(REDIS_URL && REDIS_TOKEN); }

async function pipe(cmds) {
  if (!cmds.length) return [];
  if (!configured()) throw new Error("尚未連接資料庫（請在 Vercel 加入 Upstash Redis）");
  const out = [];
  for (let i = 0; i < cmds.length; i += 400) {
    const r = await fetch(REDIS_URL.replace(/\/$/, "") + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(cmds.slice(i, i + 400)),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(j)) throw new Error("資料庫回應錯誤：" + (j?.error || r.status));
    for (const x of j) { if (x.error) throw new Error("資料庫錯誤：" + x.error); out.push(x.result); }
  }
  return out;
}
const cmd = async (c) => (await pipe([c]))[0];
const parse = (v) => { if (v == null) return null; try { return JSON.parse(v); } catch { return null; } };
function flatToObj(arr) { const o = {}; if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) { const v = parse(arr[i + 1]); if (v) o[arr[i]] = v; } return o; }

async function allMembers() { return flatToObj(await cmd(["HGETALL", "members"])); }
async function getMembers(ids) {
  if (!ids.length) return {};
  const vals = await cmd(["HMGET", "members", ...ids]);
  const o = {}; ids.forEach((id, i) => { const v = parse(vals[i]); if (v) o[id] = v; }); return o;
}
async function monthStats(month, ids) {
  if (!MONTH_RE.test(month)) throw new Error("月份格式錯誤");
  if (!ids) return flatToObj(await cmd(["HGETALL", "stats:" + month]));
  if (!ids.length) return {};
  const vals = await cmd(["HMGET", "stats:" + month, ...ids]);
  const o = {}; ids.forEach((id, i) => { const v = parse(vals[i]); if (v) o[id] = v; }); return o;
}
async function memberHistory(memberId, months) {
  const ms = months.filter((m) => MONTH_RE.test(m)).slice(0, 24);
  const vals = await pipe(ms.map((m) => ["HGET", "stats:" + m, memberId]));
  return ms.map((m, i) => parse(vals[i])).filter(Boolean);
}
async function getConfig(key) { return parse(await cmd(["GET", "config:" + key])) || {}; }
async function imports(limit = 60) { return (await cmd(["LRANGE", "imports", "0", String(limit - 1)])).map(parse).filter(Boolean); }
async function statKeys() {
  const keys = []; let cursor = "0";
  do { const [c, ks] = await cmd(["SCAN", cursor, "MATCH", "stats:*", "COUNT", "200"]); cursor = String(c); keys.push(...ks); } while (cursor !== "0");
  return keys;
}

// writes: [{t:"member",id,data} | {t:"stat",month,id,data} | {t:"config",key,data} | {t:"import",data} | {t:"delMember",id}]
async function bulk(writes) {
  const cmds = []; let needScan = false;
  for (const w of writes) {
    if (w.t === "member") { if (!ID_RE.test(w.id)) throw new Error("會員 ID 格式錯誤"); cmds.push(["HSET", "members", w.id, JSON.stringify({ ...w.data, id: undefined })]); }
    else if (w.t === "stat") { if (!ID_RE.test(w.id) || !MONTH_RE.test(w.month)) throw new Error("數據格式錯誤"); cmds.push(["HSET", "stats:" + w.month, w.id, JSON.stringify(w.data)]); }
    else if (w.t === "config") { if (!CONFIG_KEYS.has(w.key)) throw new Error("設定名稱錯誤"); cmds.push(["SET", "config:" + w.key, JSON.stringify(w.data)]); }
    else if (w.t === "import") { cmds.push(["LPUSH", "imports", JSON.stringify(w.data)], ["LTRIM", "imports", "0", "199"]); }
    else if (w.t === "delMember") { if (!ID_RE.test(w.id)) throw new Error("會員 ID 格式錯誤"); cmds.push(["HDEL", "members", w.id]); needScan = true; }
    else throw new Error("未知的寫入類型");
  }
  if (needScan) {
    const keys = await statKeys();
    for (const w of writes) if (w.t === "delMember") for (const k of keys) cmds.push(["HDEL", k, w.id]);
  }
  await pipe(cmds);
  return cmds.length;
}

async function backup() {
  const keys = await statKeys();
  const vals = await pipe(keys.map((k) => ["HGETALL", k]));
  const stats = [];
  keys.forEach((k, i) => { const o = flatToObj(vals[i]); for (const [id, d] of Object.entries(o)) stats.push({ id: `${id}__${k.slice(6)}`, ...d }); });
  const members = Object.entries(await allMembers()).map(([id, d]) => ({ ...d, id }));
  return { exportedAt: new Date().toISOString(), settings: await getConfig("settings"), sync: await getConfig("sync"), members, stats, imports: await imports(200) };
}

function authOk(req) {
  const need = process.env.ADMIN_TOKEN || "";
  const got = String(req.headers?.["x-admin-token"] || "");
  if (!need || got.length !== need.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(need));
}

module.exports = { configured, pipe, allMembers, getMembers, monthStats, memberHistory, getConfig, imports, bulk, backup, authOk, ID_RE, MONTH_RE };
