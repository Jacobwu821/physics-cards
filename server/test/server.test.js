import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../src/index.js'

const TOKEN = 'test-token'
let server, base, tmp

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sync-'))
  const app = createApp({ dataDir: tmp, token: TOKEN })
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res) })
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => { server.close() })

const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const post = (p, body) => fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(body) }).then((r) => r.json())
const get = (p) => fetch(base + p, { headers: H }).then((r) => r.json())

const card = (id, front, extra = {}) => ({
  id, deckId: 'd1', type: 'formula', front, back: 'b', tags: [], source: {}, favorite: 0, suspended: 0, sample: 0,
  createdAt: 1, updatedAt: 1, rev: 0, dirty: 1, deleted: 0, ...extra,
})

test('未授权请求被拒绝', async () => {
  const r = await fetch(base + '/api/ping')
  assert.equal(r.status, 401)
  const r2 = await fetch(base + '/api/ping', { headers: { Authorization: 'Bearer wrong' } })
  assert.equal(r2.status, 401)
})

test('ping', async () => {
  const r = await get('/api/ping')
  assert.equal(r.ok, true)
  assert.ok(r.serverId)
})

test('推送新卡片得到 rev=1，拉取可见', async () => {
  const r = await post('/api/push', { deviceId: 'A', cards: [{ ...card('c1', 'v1'), baseRev: 0 }] })
  assert.deepEqual(r.cards, [{ id: 'c1', status: 'ok', rev: 1 }])
  const p = await get('/api/pull?since=0')
  assert.equal(p.cards.length, 1)
  assert.equal(p.cards[0].front, 'v1')
  assert.equal(p.cards[0].rev, 1)
  assert.ok(p.seq >= 1)
})

test('基于旧版本的推送产生冲突并返回服务器版本，不覆盖', async () => {
  const ok = await post('/api/push', { deviceId: 'A', cards: [{ ...card('c1', 'v2', { updatedAt: 2 }), baseRev: 1 }] })
  assert.equal(ok.cards[0].status, 'ok')
  assert.equal(ok.cards[0].rev, 2)
  const conflict = await post('/api/push', { deviceId: 'B', cards: [{ ...card('c1', 'v2-from-B', { updatedAt: 3 }), baseRev: 1 }] })
  assert.equal(conflict.cards[0].status, 'conflict')
  assert.equal(conflict.cards[0].server.front, 'v2')
  assert.equal(conflict.cards[0].server.rev, 2)
  const p = await get('/api/pull?since=0')
  assert.equal(p.cards.find((c) => c.id === 'c1').front, 'v2')
})

test('评分日志按 id 去重；状态按 updatedAt 后写胜出', async () => {
  const log = { id: 'l1', cardId: 'c1', rating: 3, mode: 'review', reviewedAt: 10, before: {}, after: {}, deviceId: 'A', undone: 0, updatedAt: 10, dirty: 1 }
  const r1 = await post('/api/push', { deviceId: 'A', logs: [log], states: [{ cardId: 'c1', due: 100, state: 2, updatedAt: 10, dirty: 1 }] })
  assert.equal(r1.logs[0].status, 'ok')
  assert.equal(r1.states[0].status, 'ok')
  const r2 = await post('/api/push', { deviceId: 'A', logs: [log], states: [{ cardId: 'c1', due: 100, state: 2, updatedAt: 10, dirty: 1 }] })
  assert.equal(r2.logs[0].status, 'stale')
  assert.equal(r2.states[0].status, 'stale')
  const older = await post('/api/push', { deviceId: 'B', states: [{ cardId: 'c1', due: 50, state: 1, updatedAt: 5, dirty: 1 }] })
  assert.equal(older.states[0].status, 'stale')
  assert.equal(older.states[0].server.due, 100)
  const newer = await post('/api/push', { deviceId: 'B', states: [{ cardId: 'c1', due: 200, state: 2, updatedAt: 20, dirty: 1 }] })
  assert.equal(newer.states[0].status, 'ok')
  const p = await get('/api/pull?since=0')
  assert.equal(p.logs.length, 1)
  assert.equal(p.states.find((s) => s.cardId === 'c1').due, 200)
})

test('增量拉取只返回新记录', async () => {
  const p0 = await get('/api/pull?since=0')
  const p1 = await get(`/api/pull?since=${p0.seq}`)
  assert.equal(p1.cards.length + p1.logs.length + p1.states.length, 0)
  await post('/api/push', { deviceId: 'A', decks: [{ id: 'd1', name: '量子光学', sample: 0, createdAt: 1, updatedAt: 1, deleted: 0, baseRev: 0 }] })
  const p2 = await get(`/api/pull?since=${p0.seq}`)
  assert.equal(p2.decks.length, 1)
  assert.equal(p2.decks[0].name, '量子光学')
})

test('图片：先报告 need，上传后 ok，可下载', async () => {
  const meta = { id: 'img1', mime: 'image/png', size: 3 }
  const r1 = await post('/api/push', { deviceId: 'A', images: [meta] })
  assert.equal(r1.images[0].status, 'need')
  const up = await fetch(base + '/api/images/img1', { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'image/png' }, body: new Uint8Array([1, 2, 3]) })
  assert.equal(up.status, 200)
  const r2 = await post('/api/push', { deviceId: 'A', images: [meta] })
  assert.equal(r2.images[0].status, 'ok')
  const dl = await fetch(base + '/api/images/img1', { headers: { Authorization: `Bearer ${TOKEN}` } })
  assert.equal(dl.headers.get('content-type'), 'image/png')
  assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), new Uint8Array([1, 2, 3]))
  const p = await get('/api/pull?since=0')
  assert.ok(p.images.find((i) => i.id === 'img1'))
})
