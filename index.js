const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3001;

const DATA_DIR = process.env.SERVER_DATA_PATH || path.join(__dirname, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new sqlite3.Database(path.join(DATA_DIR, "songs.db"));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT,
    duration REAL DEFAULT 0, filename TEXT NOT NULL,
    uploaded_by TEXT DEFAULT 'Unknown', play_count INTEGER DEFAULT 0,
    uploaded_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS user_stats (
    username TEXT NOT NULL, song_id TEXT NOT NULL,
    play_count INTEGER DEFAULT 0, total_seconds REAL DEFAULT 0,
    PRIMARY KEY (username, song_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS likes (
    username TEXT NOT NULL, song_id TEXT NOT NULL,
    liked_at TEXT NOT NULL, PRIMARY KEY (username, song_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, recipient TEXT NOT NULL, sender TEXT NOT NULL,
    type TEXT NOT NULL, message TEXT NOT NULL, song_id TEXT,
    read INTEGER DEFAULT 0, created_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS heartbeats (
    username TEXT PRIMARY KEY, last_seen TEXT NOT NULL, avatar_color TEXT DEFAULT '#7c5cfc'
  )`);
  // Migrations
  db.run(`ALTER TABLE songs ADD COLUMN uploaded_by TEXT DEFAULT 'Unknown'`, () => {});
  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    song_id TEXT NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.run(`ALTER TABLE songs ADD COLUMN play_count INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE songs ADD COLUMN duration REAL DEFAULT 0`, () => {});
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    [".mp4",".mp3",".wav",".ogg",".m4a"].includes(path.extname(file.originalname).toLowerCase())
      ? cb(null, true) : cb(new Error("Invalid file type"));
  },
  limits: { fileSize: 500 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json());

const events = [];
function logEvent(msg) {
  events.unshift({ msg, time: new Date().toISOString() });
  if (events.length > 50) events.pop();
}
function addNotification(recipient, sender, type, message, songId) {
  if (recipient === sender) return;
  db.run(`INSERT INTO notifications (id,recipient,sender,type,message,song_id,read,created_at)
    VALUES (?,?,?,?,?,?,0,?)`,
    [uuidv4(), recipient, sender, type, message, songId || null, new Date().toISOString()]
  );
}

// ── Songs ─────────────────────────────────────────────────────────────────────
app.get("/songs", (req, res) => {
  db.all("SELECT * FROM songs ORDER BY uploaded_at DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get("/leaderboard", (req, res) => {
  db.all("SELECT * FROM songs ORDER BY play_count DESC LIMIT 20", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get("/events", (req, res) => res.json(events));

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const id = path.basename(req.file.filename, path.extname(req.file.filename));
  const title = req.body.title || path.basename(req.file.originalname, path.extname(req.file.originalname));
  const artist = req.body.artist || "Unknown Artist";
  const duration = parseFloat(req.body.duration) || 0;
  const uploaded_by = req.body.uploaded_by || "Unknown";
  db.run(
    "INSERT INTO songs (id,title,artist,duration,filename,uploaded_by,play_count,uploaded_at) VALUES (?,?,?,?,?,?,0,?)",
    [id, title, artist, duration, req.file.filename, uploaded_by, new Date().toISOString()],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      logEvent(`${uploaded_by} added "${title}"`);
      res.json({ id, title, artist, duration, filename: req.file.filename, uploaded_by });
    }
  );
});

app.post("/songs/:id/play", (req, res) => {
  const { username, seconds } = req.body;
  const songId = req.params.id;
  db.run("UPDATE songs SET play_count = play_count + 1 WHERE id = ?", [songId]);
  if (username) {
    db.run(`INSERT INTO user_stats (username,song_id,play_count,total_seconds) VALUES (?,?,1,?)
      ON CONFLICT(username,song_id) DO UPDATE SET play_count=play_count+1, total_seconds=total_seconds+?`,
      [username, songId, seconds||0, seconds||0]);
  }
  res.json({ success: true });
});

app.patch("/songs/:id", (req, res) => {
  const { title, artist } = req.body;
  db.run("UPDATE songs SET title=COALESCE(?,title), artist=COALESCE(?,artist) WHERE id=?",
    [title||null, artist||null, req.params.id],
    (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); }
  );
});

app.get("/stream/:id", (req, res) => {
  db.get("SELECT * FROM songs WHERE id=?", [req.params.id], (err, song) => {
    if (err || !song) return res.status(404).json({ error: "Song not found" });
    const filePath = path.join(UPLOADS_DIR, song.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes", "Content-Length": end-start+1, "Content-Type": "video/mp4",
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Length": fileSize, "Content-Type": "video/mp4" });
      fs.createReadStream(filePath).pipe(res);
    }
  });
});

app.delete("/songs/:id", (req, res) => {
  db.get("SELECT * FROM songs WHERE id=?", [req.params.id], (err, song) => {
    if (err || !song) return res.status(404).json({ error: "Song not found" });
    const fp = path.join(UPLOADS_DIR, song.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    db.run("DELETE FROM songs WHERE id=?", [req.params.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      logEvent(`"${song.title}" was removed`);
      res.json({ success: true });
    });
  });
});

// ── Likes ─────────────────────────────────────────────────────────────────────
app.post("/songs/:id/like", (req, res) => {
  const { username } = req.body;
  const songId = req.params.id;
  db.get("SELECT * FROM likes WHERE username=? AND song_id=?", [username, songId], (err, row) => {
    if (row) {
      db.run("DELETE FROM likes WHERE username=? AND song_id=?", [username, songId]);
      return res.json({ liked: false });
    }
    db.run("INSERT INTO likes (username,song_id,liked_at) VALUES (?,?,?)",
      [username, songId, new Date().toISOString()]);
    db.get("SELECT uploaded_by FROM songs WHERE id=?", [songId], (err, song) => {
      if (song) {
        addNotification(song.uploaded_by, username, "like",
          `${username} liked your song!`, songId);
      }
    });
    res.json({ liked: true });
  });
});

app.get("/songs/:id/likes", (req, res) => {
  db.all("SELECT username FROM likes WHERE song_id=?", [req.params.id], (err, rows) => {
    res.json(rows || []);
  });
});

app.get("/likes/:username", (req, res) => {
  db.all("SELECT song_id FROM likes WHERE username=?", [req.params.username], (err, rows) => {
    res.json((rows || []).map(r => r.song_id));
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get("/stats/:username", (req, res) => {
  const username = req.params.username;
  db.all(`SELECT us.song_id, us.play_count, us.total_seconds, s.title, s.artist, s.uploaded_by
    FROM user_stats us JOIN songs s ON s.id=us.song_id
    WHERE us.username=? ORDER BY us.play_count DESC`,
    [username], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const totalSeconds = rows.reduce((a, r) => a + (r.total_seconds||0), 0);
      res.json({ songs: rows, totalSeconds });
    }
  );
});

// User uploads
app.get("/uploads/:username", (req, res) => {
  db.all("SELECT * FROM songs WHERE uploaded_by=? ORDER BY uploaded_at DESC",
    [req.params.username], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Wrapped
app.get("/wrapped/:username", (req, res) => {
  const username = req.params.username;
  const year = new Date().getFullYear();
  const start = `${year}-01-01T00:00:00.000Z`;
  db.all(`SELECT us.song_id, us.play_count, us.total_seconds, s.title, s.artist, s.uploaded_by
    FROM user_stats us JOIN songs s ON s.id=us.song_id
    WHERE us.username=? ORDER BY us.play_count DESC LIMIT 5`, [username], (err, topSongs) => {
    db.get(`SELECT SUM(us.total_seconds) as total FROM user_stats us WHERE us.username=?`,
      [username], (err2, totRow) => {
      db.get(`SELECT COUNT(*) as cnt FROM songs WHERE uploaded_by=? AND uploaded_at>=?`,
        [username, start], (err3, uploadRow) => {
        db.get(`SELECT COUNT(*) as cnt FROM likes WHERE username=?`,
          [username], (err4, likeRow) => {
          res.json({
            topSongs: topSongs || [],
            totalSeconds: totRow?.total || 0,
            uploads: uploadRow?.cnt || 0,
            likes: likeRow?.cnt || 0,
            year,
          });
        });
      });
    });
  });
});

// ── Notifications ─────────────────────────────────────────────────────────────
app.get("/notifications/:username", (req, res) => {
  db.all("SELECT * FROM notifications WHERE recipient=? ORDER BY created_at DESC LIMIT 30",
    [req.params.username], (err, rows) => res.json(rows || []));
});

app.post("/notifications/:username/read", (req, res) => {
  db.run("UPDATE notifications SET read=1 WHERE recipient=?", [req.params.username],
    () => res.json({ success: true }));
});

// ── Heartbeat / Online ────────────────────────────────────────────────────────
app.post("/heartbeat", (req, res) => {
  const { username, avatarColor } = req.body;
  if (!username) return res.status(400).json({ error: "No username" });
  db.run(`INSERT INTO heartbeats (username,last_seen,avatar_color) VALUES (?,?,?)
    ON CONFLICT(username) DO UPDATE SET last_seen=?, avatar_color=?`,
    [username, new Date().toISOString(), avatarColor||'#7c5cfc',
     new Date().toISOString(), avatarColor||'#7c5cfc']);
  res.json({ success: true });
});

app.get("/online", (req, res) => {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 min
  db.all("SELECT username, avatar_color, last_seen FROM heartbeats WHERE last_seen > ?",
    [cutoff], (err, rows) => res.json(rows || []));
});

// ── Avatar color ──────────────────────────────────────────────────────────────
app.post("/avatar", (req, res) => {
  const { username, avatarColor } = req.body;
  db.run(`INSERT INTO heartbeats (username,last_seen,avatar_color) VALUES (?,?,?)
    ON CONFLICT(username) DO UPDATE SET avatar_color=?`,
    [username, new Date().toISOString(), avatarColor, avatarColor]);
  res.json({ success: true });
});


// GET comments for a song
app.get("/songs/:id/comments", (req, res) => {
  db.all("SELECT * FROM comments WHERE song_id=? ORDER BY created_at ASC",
    [req.params.id], (err, rows) => res.json(rows || []));
});

// POST a comment
app.post("/songs/:id/comments", (req, res) => {
  const { username, text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "Empty comment" });
  const id = uuidv4();
  db.run("INSERT INTO comments (id,song_id,username,text,created_at) VALUES (?,?,?,?,?)",
    [id, req.params.id, username, text.trim(), new Date().toISOString()],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      logEvent(`${username} commented on a song`);
      res.json({ id, song_id: req.params.id, username, text: text.trim(), created_at: new Date().toISOString() });
    }
  );
});

// DELETE a comment
app.delete("/comments/:id", (req, res) => {
  db.run("DELETE FROM comments WHERE id=? AND username=?",
    [req.params.id, req.body.username],
    (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); }
  );
});

app.listen(PORT, () => console.log(`Soundwave server running at http://localhost:${PORT}`));
