// MyFlix API on Cloudflare D1 (drop-in replacement, same endpoints as before)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const readBody = async req => {
  try { return await req.json(); } catch { return {}; }
};

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const db = env.DB;

    try {
      switch (url.pathname) {
        // ── Profiles ─────────────────────────────────────────
        case "/profiles/list": {
          const { results } = await db
            .prepare("SELECT name FROM profiles ORDER BY created_at, name")
            .all();
          return json({ ok: true, profiles: results });
        }

        case "/profiles/save": {
          const body = await readBody(req);
          const names = [...new Set(
            (Array.isArray(body.profiles) ? body.profiles : [])
              .map(p => String((p && p.name) || "").trim())
              .filter(Boolean)
          )];
          if (!names.length) return json({ ok: false, error: "no profiles" }, 400);

          const now = Date.now();
          const placeholders = names.map(() => "?").join(",");
          const stmts = [
            db.prepare(`DELETE FROM profiles WHERE name NOT IN (${placeholders})`).bind(...names),
            ...names.map(n =>
              db.prepare("INSERT OR IGNORE INTO profiles (name, created_at) VALUES (?, ?)").bind(n, now)
            ),
          ];
          await db.batch(stmts);
          return json({ ok: true });
        }

        case "/profiles/delete": {
          const { name } = await readBody(req);
          const n = String(name || "").trim();
          if (!n) return json({ ok: false, error: "name required" }, 400);
          await db.batch([
            db.prepare("DELETE FROM profiles WHERE name = ?").bind(n),
            db.prepare("DELETE FROM progress WHERE user_id = ?").bind(n),
          ]);
          return json({ ok: true });
        }

        // ── Progress ─────────────────────────────────────────
        case "/progress/save": {
          const b = await readBody(req);
          const userId = String(b.userId || "").trim();
          const id = String(b.id || "").trim();
          if (!userId || !id) return json({ ok: false, error: "userId and id required" }, 400);

          await db
            .prepare(
              `INSERT INTO progress
                 (user_id, media_type, id, season, episode, position, duration, progress, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (user_id, media_type, id, season, episode) DO UPDATE SET
                 position = excluded.position,
                 duration     = excluded.duration,
                 progress     = excluded.progress,
                 timestamp    = excluded.timestamp`
            )
            .bind(
              userId,
              String(b.mediaType || "movie"),
              id,
              Number(b.season) || 0,
              Number(b.episode) || 0,
              Number(b.currentTime) || 0,
              Number(b.duration) || 0,
              Number(b.progress) || 0,
              Number(b.timestamp) || Date.now()
            )
            .run();
          return json({ ok: true });
        }

        case "/progress/list": {
          const userId = String(url.searchParams.get("userId") || "").trim();
          if (!userId) return json({ ok: false, error: "userId required" }, 400);
          const { results } = await db
            .prepare(
              `SELECT id, media_type AS mediaType, season, episode,
                      position AS currentTime, duration, progress, timestamp
                 FROM progress WHERE user_id = ? ORDER BY timestamp DESC`
            )
            .bind(userId)
            .all();
          return json({ ok: true, entries: results });
        }

        default:
          return json({ ok: false, error: "not found" }, 404);
      }
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  },
};
