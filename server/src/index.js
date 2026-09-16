// 同步服务端：Express + SQLite（node:sqlite，Node ≥ 22.13 内置，无需编译）。
// 单用户：用一个令牌鉴权。数据放在 DATA_DIR（默认 server/data）。
import express from 'express'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function createApp({ dataDir, token, staticDir }) {
  fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, 'sync.sqlite'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (
      kind TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, seq INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id)
    );
    CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?')
  const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
  let serverId = getMeta.get('serverId')?.value
  if (!serverId) { serverId = crypto.randomUUID(); setMeta.run('serverId', serverId) }
  let seq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM records').get().m

  const getRec = db.prepare('SELECT kind, id, rev, seq, updatedAt, data FROM records WHERE kind = ? AND id = ?')
  const upsert = db.prepare(`INSERT INTO records (kind, id, rev, seq, updatedAt, data) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, id) DO UPDATE SET rev = excluded.rev, seq = excluded.seq, updatedAt = excluded.updatedAt, data = excluded.data`)
  const listSince = db.prepare('SELECT kind, id, rev, seq, updatedAt, data FROM records WHERE seq > ? ORDER BY seq LIMIT ?')

  const store = (kind, id, rev, updatedAt, data) => {
    seq += 1
    upsert.run(kind, id, rev, seq, updatedAt, JSON.stringify(data))
    return rev
  }
  const parse = (row) => ({ ...JSON.parse(row.data), rev: row.rev })

  const app = express()
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })
  const auth = (req, res, next) => {
    const h = req.headers.authorization || ''
    const t = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
    if (!t || t.length !== token.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token))) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    next()
  }

  app.get('/api/ping', auth, (_req, res) => res.json({ ok: true, serverId }))

  app.post('/api/push', auth, express.json({ limit: '50mb' }), (req, res) => {
    const b = req.body || {}
    const out = { decks: [], cards: [], states: [], logs: [], images: [] }
    db.exec('BEGIN')
    try {
      for (const [kind, key] of [['deck', 'decks'], ['card', 'cards']]) {
        for (const item of b[key] || []) {
          const { baseRev = 0, dirty: _d, rev: _r, ...data } = item
          const row = getRec.get(kind, item.id)
          if (!row) {
            out[key].push({ id: item.id, status: 'ok', rev: store(kind, item.id, 1, data.updatedAt || 0, data) })
          } else if (row.rev === baseRev) {
            out[key].push({ id: item.id, status: 'ok', rev: store(kind, item.id, row.rev + 1, data.updatedAt || 0, data) })
          } else {
            out[key].push({ id: item.id, status: 'conflict', rev: row.rev, server: parse(row) })
          }
        }
      }
      for (const [kind, key, idField] of [['state', 'states', 'cardId'], ['log', 'logs', 'id']]) {
        for (const item of b[key] || []) {
          const { dirty: _d, ...data } = item
          const id = item[idField]
          const row = getRec.get(kind, id)
          if (!row || (data.updatedAt || 0) > row.updatedAt) {
            store(kind, id, (row?.rev || 0) + 1, data.updatedAt || 0, data)
            out[key].push({ id, status: 'ok' })
          } else {
            out[key].push({ id, status: 'stale', server: parse(row) })
          }
        }
      }
      for (const im of b.images || []) {
        const row = getRec.get('image', im.id)
        const file = path.join(dataDir, 'images', safeId(im.id))
        out.images.push({ id: im.id, status: row && fs.existsSync(file) ? 'ok' : 'need' })
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    res.json(out)
  })

  app.get('/api/pull', auth, (req, res) => {
    const since = Number(req.query.since || 0)
    const limit = 1000
    const rows = listSince.all(since, limit)
    const out = { seq: rows.length ? rows[rows.length - 1].seq : since, more: rows.length === limit, decks: [], cards: [], states: [], logs: [], images: [] }
    for (const r of rows) {
      const data = parse(r)
      if (r.kind === 'deck') out.decks.push(data)
      else if (r.kind === 'card') out.cards.push(data)
      else if (r.kind === 'state') out.states.push(data)
      else if (r.kind === 'log') out.logs.push(data)
      else if (r.kind === 'image') out.images.push({ id: data.id, mime: data.mime, size: data.size })
    }
    res.json(out)
  })

  app.put('/api/images/:id', auth, express.raw({ type: '*/*', limit: '30mb' }), (req, res) => {
    const id = safeId(req.params.id)
    const mime = req.headers['content-type'] || 'application/octet-stream'
    const buf = req.body
    if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'empty' })
    fs.writeFileSync(path.join(dataDir, 'images', id), buf)
    const row = getRec.get('image', id)
    if (!row) store('image', id, 1, Date.now(), { id, mime, size: buf.length })
    res.json({ ok: true })
  })

  app.get('/api/images/:id', auth, (req, res) => {
    const id = safeId(req.params.id)
    const row = getRec.get('image', id)
    const file = path.join(dataDir, 'images', id)
    if (!row || !fs.existsSync(file)) return res.status(404).json({ error: 'not found' })
    res.setHeader('Content-Type', JSON.parse(row.data).mime || 'application/octet-stream')
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.sendFile(file)
  })

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }))

  // 静态前端（app/dist）+ SPA 回退
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir))
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next()
      res.sendFile(path.join(staticDir, 'index.html'))
    })
  }

  app.use((err, _req, res, _next) => {
    console.error(err)
    res.status(500).json({ error: err.message || 'server error' })
  })

  app.locals.close = () => db.close()
  return app
}

function safeId(id) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error('bad id')
  return id
}

function lanAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`${i.address} (${name})`)
  }
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const tokenFile = path.join(dataDir, 'token.txt')
  let token = process.env.SYNC_TOKEN
  if (!token) {
    if (fs.existsSync(tokenFile)) token = fs.readFileSync(tokenFile, 'utf8').trim()
    else { token = crypto.randomBytes(18).toString('base64url'); fs.writeFileSync(tokenFile, token) }
  }
  const port = Number(process.env.PORT || 8787)
  const staticDir = process.env.STATIC_DIR || path.join(__dirname, '..', '..', 'app', 'dist')
  const app = createApp({ dataDir, token, staticDir })
  app.listen(port, '0.0.0.0', () => {
    console.log(`物理卡片同步服务已启动：http://localhost:${port}`)
    for (const a of lanAddresses()) console.log(`  局域网地址：http://${a.split(' ')[0]}:${port}   ${a}`)
    console.log(`同步令牌：${token}`)
    console.log(`数据目录：${dataDir}`)
    if (!fs.existsSync(staticDir)) console.log('提示：未找到 app/dist，先运行 npm run build 才能通过此地址打开前端。')
  })
}
