// 同步后端抽象：
// - 'server'：自托管 Node 服务（server/），逻辑在服务端。
// - 'github'：用 GitHub 私有仓库里的 sync/data.json 当数据库，"服务端逻辑"在本地执行，
//   写回时用 Contents API 的 sha 做比较并交换（sha 不匹配返回 409），冲突则重新读取再合并，避免互相覆盖。
import type { Card, CardState, Deck, Folder, ReviewLog, Settings } from '../lib/types'

export type PushItem<T> = T & { baseRev: number }
export interface PushBody {
  deviceId: string
  folders: PushItem<Folder>[]
  decks: PushItem<Deck>[]
  cards: PushItem<Card>[]
  states: CardState[]
  logs: ReviewLog[]
  images: Array<{ id: string; mime: string; size: number }>
}
export interface PushResp {
  folders: Array<{ id: string; status: 'ok' | 'conflict'; rev: number; server?: Folder }>
  decks: Array<{ id: string; status: 'ok' | 'conflict'; rev: number; server?: Deck }>
  cards: Array<{ id: string; status: 'ok' | 'conflict'; rev: number; server?: Card }>
  states: Array<{ id: string; status: 'ok' | 'stale'; server?: CardState }>
  logs: Array<{ id: string; status: 'ok' | 'stale'; server?: ReviewLog }>
  images: Array<{ id: string; status: 'ok' | 'need' }>
}
export interface PullResp {
  seq: number
  more: boolean
  folders: Folder[]
  decks: Deck[]
  cards: Card[]
  states: CardState[]
  logs: ReviewLog[]
  images: Array<{ id: string; mime: string; size: number }>
}

export class SyncError extends Error {}

export interface SyncBackend {
  name: string
  ping(): Promise<{ serverId: string }>
  push(body: PushBody): Promise<PushResp>
  pull(since: number): Promise<PullResp>
  putImage(id: string, mime: string, blob: Blob): Promise<void>
  getImage(id: string): Promise<Blob | null>
}

// ---------------- 纯逻辑：与 server/src/index.js 一致的记录存储 ----------------
export interface StoreRecord { kind: string; id: string; rev: number; seq: number; updatedAt: number; data: Record<string, unknown> }
export interface Store { seq: number; records: Record<string, StoreRecord> }

export const emptyStore = (): Store => ({ seq: 0, records: {} })
const key = (kind: string, id: string) => `${kind}:${id}`

function put(store: Store, kind: string, id: string, rev: number, updatedAt: number, data: Record<string, unknown>) {
  store.seq += 1
  store.records[key(kind, id)] = { kind, id, rev, seq: store.seq, updatedAt, data }
  return rev
}
const parse = <T>(r: StoreRecord): T => ({ ...(r.data as object), rev: r.rev }) as T

/** 在本地对 store 应用一次推送（会修改传入的 store），返回结果与是否有改动 */
export function applyPush(store: Store, body: PushBody): { resp: PushResp; changed: boolean } {
  const resp: PushResp = { folders: [], decks: [], cards: [], states: [], logs: [], images: [] }
  let changed = false
  const versioned = <T extends { id: string; updatedAt: number }>(kind: 'folder' | 'deck' | 'card', items: PushItem<T>[], out: Array<{ id: string; status: 'ok' | 'conflict'; rev: number; server?: T }>) => {
    for (const item of items || []) {
      const { baseRev = 0, dirty: _d, rev: _r, ...data } = item as PushItem<T> & { dirty?: unknown; rev?: unknown }
      const row = store.records[key(kind, item.id)]
      if (!row) { out.push({ id: item.id, status: 'ok', rev: put(store, kind, item.id, 1, item.updatedAt || 0, data) }); changed = true }
      else if (row.rev === baseRev) { out.push({ id: item.id, status: 'ok', rev: put(store, kind, item.id, row.rev + 1, item.updatedAt || 0, data) }); changed = true }
      else out.push({ id: item.id, status: 'conflict', rev: row.rev, server: parse<T>(row) })
    }
  }
  versioned('folder', body.folders || [], resp.folders)
  versioned('deck', body.decks || [], resp.decks)
  versioned('card', body.cards || [], resp.cards)
  const lww = <T extends { updatedAt: number }>(kind: 'state' | 'log', items: T[], idOf: (t: T) => string, out: Array<{ id: string; status: 'ok' | 'stale'; server?: T }>) => {
    for (const item of items || []) {
      const { dirty: _d, ...data } = item as T & { dirty?: unknown }
      const id = idOf(item)
      const row = store.records[key(kind, id)]
      if (!row || (item.updatedAt || 0) > row.updatedAt) { put(store, kind, id, (row?.rev || 0) + 1, item.updatedAt || 0, data); out.push({ id, status: 'ok' }); changed = true }
      else out.push({ id, status: 'stale', server: parse<T>(row) })
    }
  }
  lww('state', body.states || [], (s) => s.cardId, resp.states)
  lww('log', body.logs || [], (l) => l.id, resp.logs)
  for (const im of body.images || []) {
    resp.images.push({ id: im.id, status: store.records[key('image', im.id)] ? 'ok' : 'need' })
  }
  return { resp, changed }
}

export function addImageRecord(store: Store, id: string, mime: string, size: number): boolean {
  if (store.records[key('image', id)]) return false
  put(store, 'image', id, 1, Date.now(), { id, mime, size })
  return true
}

export function pullFrom(store: Store, since: number, limit = 1000): PullResp {
  const rows = Object.values(store.records).filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq).slice(0, limit)
  const out: PullResp = { seq: rows.length ? rows[rows.length - 1].seq : since, more: rows.length === limit, folders: [], decks: [], cards: [], states: [], logs: [], images: [] }
  for (const r of rows) {
    if (r.kind === 'folder') out.folders.push(parse<Folder>(r))
    else if (r.kind === 'deck') out.decks.push(parse<Deck>(r))
    else if (r.kind === 'card') out.cards.push(parse<Card>(r))
    else if (r.kind === 'state') out.states.push(parse<CardState>(r))
    else if (r.kind === 'log') out.logs.push(parse<ReviewLog>(r))
    else if (r.kind === 'image') out.images.push({ id: r.data.id as string, mime: r.data.mime as string, size: r.data.size as number })
  }
  return out
}

// ---------------- 后端 1：自托管服务器 ----------------
export class ServerBackend implements SyncBackend {
  name = '自托管服务器'
  constructor(private url: string, private token: string) { this.url = url.trim().replace(/\/+$/, '') }
  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response
    try {
      res = await fetch(this.url + path, { ...init, headers: { Authorization: `Bearer ${this.token}`, ...(init.headers || {}) } })
    } catch (e) {
      throw new SyncError('无法连接同步服务器：' + (e instanceof Error ? e.message : String(e)))
    }
    if (res.status === 401) throw new SyncError('同步令牌不正确')
    if (!res.ok) throw new SyncError(`服务器返回 ${res.status}`)
    return res.json() as Promise<T>
  }
  ping() { return this.api<{ serverId: string }>('/api/ping') }
  push(body: PushBody) { return this.api<PushResp>('/api/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
  pull(since: number) { return this.api<PullResp>(`/api/pull?since=${since}`) }
  async putImage(id: string, mime: string, blob: Blob) {
    const res = await fetch(`${this.url}/api/images/${id}`, { method: 'PUT', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': mime }, body: blob })
    if (!res.ok) throw new SyncError(`图片上传失败（${res.status}）`)
  }
  async getImage(id: string) {
    const res = await fetch(`${this.url}/api/images/${id}`, { headers: { Authorization: `Bearer ${this.token}` } })
    if (!res.ok) return null
    return res.blob()
  }
}

// ---------------- 后端 2：GitHub 私有仓库 ----------------
const DATA_PATH = 'sync/data.json'
const IMG_DIR = 'sync/images'

function utf8ToB64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
async function blobToB64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export class GitHubBackend implements SyncBackend {
  name = 'GitHub 仓库'
  private owner: string
  private repo: string
  constructor(private token: string, repo: string, private branch = 'main', private apiBase = 'https://api.github.com', private fetchImpl: typeof fetch = fetch.bind(globalThis)) {
    const m = repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').split('/')
    this.owner = m[0] || ''
    this.repo = m[1] || ''
    this.branch = branch.trim() || 'main'
  }
  private async req(path: string, init: RequestInit = {}, accept = 'application/vnd.github+json'): Promise<Response> {
    let res: Response
    try {
      res = await this.fetchImpl(this.apiBase + path, {
        ...init,
        headers: { Authorization: `Bearer ${this.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', ...(init.headers || {}) },
      })
    } catch (e) {
      throw new SyncError('无法连接 GitHub：' + (e instanceof Error ? e.message : String(e)))
    }
    if (res.status === 401) throw new SyncError('GitHub 令牌无效或已过期')
    if (res.status === 403) throw new SyncError('GitHub 拒绝访问：令牌缺少该仓库的 Contents 读写权限，或触发了速率限制')
    return res
  }
  private contentsPath(p: string) { return `/repos/${this.owner}/${this.repo}/contents/${p}` }

  /** 读取文件：返回 sha 与内容字节；不存在返回 null */
  private async readFile(p: string): Promise<{ sha: string; bytes: Uint8Array } | null> {
    const res = await this.req(this.contentsPath(p) + `?ref=${encodeURIComponent(this.branch)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new SyncError(`GitHub 读取失败（${res.status}）`)
    const j = await res.json() as { sha: string; content?: string; encoding?: string }
    if (j.content && j.encoding === 'base64') return { sha: j.sha, bytes: b64ToBytes(j.content) }
    // 大于 1MB 的文件 JSON 响应不含内容，用 raw 再取一次
    const raw = await this.req(this.contentsPath(p) + `?ref=${encodeURIComponent(this.branch)}`, {}, 'application/vnd.github.raw+json')
    if (!raw.ok) throw new SyncError(`GitHub 读取失败（${raw.status}）`)
    return { sha: j.sha, bytes: new Uint8Array(await raw.arrayBuffer()) }
  }
  /** 写文件：sha 不匹配（他人已改）返回 false */
  private async writeFile(p: string, contentB64: string, sha: string | undefined, message: string): Promise<boolean> {
    const res = await this.req(this.contentsPath(p), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: contentB64, branch: this.branch, ...(sha ? { sha } : {}) }),
    })
    if (res.status === 409 || res.status === 422) return false
    if (!res.ok) throw new SyncError(`GitHub 写入失败（${res.status}）`)
    return true
  }
  private async loadStore(): Promise<{ store: Store; sha?: string }> {
    const f = await this.readFile(DATA_PATH)
    if (!f) return { store: emptyStore() }
    try {
      return { store: JSON.parse(new TextDecoder().decode(f.bytes)) as Store, sha: f.sha }
    } catch {
      throw new SyncError('仓库中的 sync/data.json 不是有效的同步数据')
    }
  }
  private async saveStore(store: Store, sha: string | undefined, message: string): Promise<boolean> {
    return this.writeFile(DATA_PATH, utf8ToB64(JSON.stringify(store)), sha, message)
  }
  /** 读取-修改-写回，sha 冲突时重试 */
  private async transact(message: string, mutate: (store: Store) => boolean): Promise<Store> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const { store, sha } = await this.loadStore()
      const changed = mutate(store)
      if (!changed) return store
      if (await this.saveStore(store, sha, message)) return store
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
    }
    throw new SyncError('GitHub 仓库正被其他设备频繁写入，请稍后再试')
  }

  async ping() {
    if (!this.owner || !this.repo) throw new SyncError('仓库格式应为 owner/repo')
    const res = await this.req(`/repos/${this.owner}/${this.repo}`)
    if (res.status === 404) throw new SyncError('找不到仓库（检查 owner/repo，或令牌是否包含该仓库）')
    if (!res.ok) throw new SyncError(`GitHub 返回 ${res.status}`)
    const j = await res.json() as { id: number; permissions?: { push?: boolean }; private?: boolean }
    if (j.permissions && j.permissions.push === false) throw new SyncError('令牌对该仓库没有写权限')
    return { serverId: `github-${j.id}` }
  }
  async push(body: PushBody): Promise<PushResp> {
    let resp: PushResp | null = null
    await this.transact(`sync: push from ${body.deviceId.slice(0, 8)}`, (store) => {
      const r = applyPush(store, body)
      resp = r.resp
      return r.changed
    })
    return resp!
  }
  async pull(since: number): Promise<PullResp> {
    const { store } = await this.loadStore()
    return pullFrom(store, since)
  }
  async putImage(id: string, mime: string, blob: Blob) {
    const existing = await this.readFile(`${IMG_DIR}/${id}`)
    if (!existing) {
      const ok = await this.writeFile(`${IMG_DIR}/${id}`, await blobToB64(blob), undefined, `sync: image ${id.slice(0, 8)}`)
      if (!ok) {
        // 可能刚被另一台设备写入；确认存在即可
        if (!(await this.readFile(`${IMG_DIR}/${id}`))) throw new SyncError('图片上传失败')
      }
    }
    await this.transact(`sync: register image ${id.slice(0, 8)}`, (store) => addImageRecord(store, id, mime, blob.size))
  }
  async getImage(id: string): Promise<Blob | null> {
    const f = await this.readFile(`${IMG_DIR}/${id}`)
    if (!f) return null
    const { store } = await this.loadStore()
    const mime = (store.records[key('image', id)]?.data.mime as string) || 'application/octet-stream'
    return new Blob([f.bytes as BlobPart], { type: mime })
  }
}

export function makeBackend(s: Pick<Settings, 'syncBackend' | 'syncUrl' | 'syncToken' | 'ghToken' | 'ghRepo' | 'ghBranch'>): SyncBackend | null {
  if (s.syncBackend === 'github') {
    if (!s.ghToken || !s.ghRepo) return null
    return new GitHubBackend(s.ghToken, s.ghRepo, s.ghBranch || 'main')
  }
  if (!s.syncUrl || !s.syncToken) return null
  return new ServerBackend(s.syncUrl, s.syncToken)
}

export function isSyncConfigured(s: Pick<Settings, 'syncBackend' | 'syncUrl' | 'syncToken' | 'ghToken' | 'ghRepo'>): boolean {
  return s.syncBackend === 'github' ? !!(s.ghToken && s.ghRepo) : !!(s.syncUrl && s.syncToken)
}
