import { describe, it, expect } from 'vitest'
import { GitHubBackend, applyPush, emptyStore, pullFrom, type PushBody } from './backend'
import type { Card } from '../lib/types'

const card = (id: string, front: string, extra: Partial<Card> = {}): Card => ({
  id, deckId: 'd1', type: 'formula', front, back: 'b', tags: [], source: {}, favorite: 0, suspended: 0, sample: 0,
  createdAt: 1, updatedAt: 1, rev: 0, dirty: 1, deleted: 0, ...extra,
})
const body = (p: Partial<PushBody>): PushBody => ({ deviceId: 'devA', decks: [], cards: [], states: [], logs: [], images: [], ...p })

describe('本地执行的存储逻辑（与服务端一致）', () => {
  it('新记录 rev=1；基于最新 rev 的更新成功；基于旧 rev 的更新冲突并返回正本', () => {
    const store = emptyStore()
    const r1 = applyPush(store, body({ cards: [{ ...card('c1', 'v1'), baseRev: 0 }] }))
    expect(r1.resp.cards[0]).toEqual({ id: 'c1', status: 'ok', rev: 1 })
    const r2 = applyPush(store, body({ cards: [{ ...card('c1', 'v2', { updatedAt: 2 }), baseRev: 1 }] }))
    expect(r2.resp.cards[0].rev).toBe(2)
    const r3 = applyPush(store, body({ deviceId: 'devB', cards: [{ ...card('c1', 'v2-B', { updatedAt: 3 }), baseRev: 1 }] }))
    expect(r3.resp.cards[0].status).toBe('conflict')
    expect(r3.resp.cards[0].server?.front).toBe('v2')
    expect(r3.changed).toBe(false)
    const pull = pullFrom(store, 0)
    expect(pull.cards[0].front).toBe('v2')
    expect(pull.cards[0].rev).toBe(2)
  })
  it('日志按 id 去重、状态后写胜出；增量拉取只给新记录', () => {
    const store = emptyStore()
    const log = { id: 'l1', cardId: 'c1', rating: 3 as const, mode: 'review' as const, reviewedAt: 10, before: {} as never, after: {} as never, deviceId: 'a', undone: 0 as const, updatedAt: 10, dirty: 1 as const }
    const st = { cardId: 'c1', due: 100, stability: 1, difficulty: 1, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 1, lapses: 0, state: 2 as const, last_review: null, updatedAt: 10, dirty: 1 as const }
    const a = applyPush(store, body({ logs: [log], states: [st] }))
    expect(a.resp.logs[0].status).toBe('ok')
    const b = applyPush(store, body({ logs: [log], states: [st] }))
    expect(b.resp.logs[0].status).toBe('stale')
    expect(b.resp.states[0].status).toBe('stale')
    expect(b.changed).toBe(false)
    const seqAfter = store.seq
    applyPush(store, body({ states: [{ ...st, due: 200, updatedAt: 20 }] }))
    const inc = pullFrom(store, seqAfter)
    expect(inc.states.length).toBe(1)
    expect(inc.states[0].due).toBe(200)
    expect(inc.logs.length).toBe(0)
  })
})

/** 模拟 GitHub Contents API：sha 校验 + 409 冲突 */
function fakeGitHub() {
  const files = new Map<string, { sha: string; content: string }>()
  let n = 0
  const calls: string[] = []
  const conflictOnce = { pending: false }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = (init?.method || 'GET').toUpperCase()
    calls.push(`${method} ${url.replace('https://api.github.com', '')}`)
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.endsWith('/repos/me/data')) return json(200, { id: 42, permissions: { push: true } })
    const m = url.match(/\/repos\/me\/data\/contents\/([^?]+)/)
    if (!m) return json(404, {})
    const path = decodeURIComponent(m[1])
    if (method === 'GET') {
      const f = files.get(path)
      if (!f) return json(404, { message: 'Not Found' })
      return json(200, { sha: f.sha, content: f.content, encoding: 'base64' })
    }
    if (method === 'PUT') {
      const b = JSON.parse(String(init!.body)) as { content: string; sha?: string }
      const f = files.get(path)
      if (conflictOnce.pending) { conflictOnce.pending = false; return json(409, { message: 'conflict' }) }
      if (f && f.sha !== b.sha) return json(409, { message: 'sha mismatch' })
      if (!f && b.sha) return json(422, { message: 'sha given for new file' })
      const sha = 'sha' + (++n)
      files.set(path, { sha, content: b.content })
      return json(f ? 200 : 201, { content: { sha } })
    }
    return json(405, {})
  }
  return { fetchImpl, files, calls, conflictOnce }
}

describe('GitHub 仓库后端', () => {
  it('默认 fetch 保持浏览器全局对象作为调用接收者', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(new Response(JSON.stringify({ id: 42 }), { status: 200 }))
    } as typeof fetch
    try {
      const backend = new GitHubBackend('tok', 'me/data')
      expect((await backend.ping()).serverId).toBe('github-42')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('首次推送创建 data.json；两台设备先后推送不互相覆盖；拉取得到两者', async () => {
    const gh = fakeGitHub()
    const A = new GitHubBackend('tok', 'me/data', 'main', 'https://api.github.com', gh.fetchImpl)
    const B = new GitHubBackend('tok', 'me/data', 'main', 'https://api.github.com', gh.fetchImpl)
    expect((await A.ping()).serverId).toBe('github-42')
    const ra = await A.push(body({ cards: [{ ...card('a', 'from A'), baseRev: 0 }] }))
    expect(ra.cards[0]).toEqual({ id: 'a', status: 'ok', rev: 1 })
    const rb = await B.push(body({ deviceId: 'devB', cards: [{ ...card('b', 'from B'), baseRev: 0 }] }))
    expect(rb.cards[0].status).toBe('ok')
    const pull = await A.pull(0)
    expect(pull.cards.map((c) => c.front).sort()).toEqual(['from A', 'from B'])
    expect(gh.files.has('sync/data.json')).toBe(true)
  })

  it('写回时遇到 409（另一台设备刚写入）会重新读取并合并后重试', async () => {
    const gh = fakeGitHub()
    const A = new GitHubBackend('tok', 'me/data', 'main', 'https://api.github.com', gh.fetchImpl)
    await A.push(body({ cards: [{ ...card('a', 'A1'), baseRev: 0 }] }))
    gh.conflictOnce.pending = true
    const r = await A.push(body({ cards: [{ ...card('c', 'C1'), baseRev: 0 }] }))
    expect(r.cards[0].status).toBe('ok')
    const puts = gh.calls.filter((c) => c.startsWith('PUT') && c.includes('data.json')).length
    expect(puts).toBe(3) // 首次 + 冲突的一次 + 重试成功
    const pull = await A.pull(0)
    expect(pull.cards.map((c) => c.front).sort()).toEqual(['A1', 'C1'])
  })

  it('同一张卡两端修改：后到的一方得到冲突而不是覆盖', async () => {
    const gh = fakeGitHub()
    const A = new GitHubBackend('tok', 'me/data', 'main', 'https://api.github.com', gh.fetchImpl)
    const B = new GitHubBackend('tok', 'me/data', 'main', 'https://api.github.com', gh.fetchImpl)
    await A.push(body({ cards: [{ ...card('x', 'v1'), baseRev: 0 }] }))
    await B.pull(0)
    await A.push(body({ cards: [{ ...card('x', 'A 改', { updatedAt: 5 }), baseRev: 1 }] }))
    const rb = await B.push(body({ deviceId: 'devB', cards: [{ ...card('x', 'B 改', { updatedAt: 6 }), baseRev: 1 }] }))
    expect(rb.cards[0].status).toBe('conflict')
    expect(rb.cards[0].server?.front).toBe('A 改')
    expect(rb.cards[0].server?.rev).toBe(2)
  })

  it('图片：上传为独立文件并登记；拉取时能取回字节与类型', async () => {
    const gh = fakeGitHub()
    const A = new GitHubBackend('tok', 'me/data', 'main', 'https://api.github.com', gh.fetchImpl)
    const r1 = await A.push(body({ images: [{ id: 'img1', mime: 'image/png', size: 3 }] }))
    expect(r1.images[0].status).toBe('need')
    await A.putImage('img1', 'image/png', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
    const r2 = await A.push(body({ images: [{ id: 'img1', mime: 'image/png', size: 3 }] }))
    expect(r2.images[0].status).toBe('ok')
    const pull = await A.pull(0)
    expect(pull.images[0]).toEqual({ id: 'img1', mime: 'image/png', size: 3 })
    const blob = await A.getImage('img1')
    expect(blob?.type).toBe('image/png')
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(gh.files.has('sync/images/img1')).toBe(true)
  })

  it('中文内容经 base64 往返不损坏', async () => {
    const gh = fakeGitHub()
    const A = new GitHubBackend('tok', 'me/data', 'main', 'https://api.github.com', gh.fetchImpl)
    await A.push(body({ cards: [{ ...card('z', '拉比频率 $\\Omega$ — 近共振'), baseRev: 0 }] }))
    const pull = await A.pull(0)
    expect(pull.cards[0].front).toBe('拉比频率 $\\Omega$ — 近共振')
  })
})
