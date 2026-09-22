// 同步客户端：推送本地脏记录 → 处理冲突 → 拉取增量 → 补齐图片。后端由 backend.ts 提供。
import { db } from '../lib/db'
import { getSettings, updateSettings } from '../lib/repo'
import type { ImageRecord } from '../lib/types'
import { decideIncoming, lwwReplace, resolveCardConflict, resolveDeckConflict, resolveFolderConflict } from './merge'
import { makeBackend, SyncError, type PushBody, type SyncBackend } from './backend'

export { SyncError }

export interface SyncResult {
  pushed: number
  pulled: number
  conflicts: number
  notices: string[]
}

export async function testConnection(backend: SyncBackend): Promise<{ serverId: string }> {
  return backend.ping()
}

let running: Promise<SyncResult> | null = null

/** 执行一次完整同步；并发调用会复用进行中的那一次 */
export function syncNow(): Promise<SyncResult> {
  if (running) return running
  running = doSync().finally(() => { running = null })
  return running
}

async function doSync(): Promise<SyncResult> {
  const settings = await getSettings()
  const backend = makeBackend(settings)
  if (!backend) throw new SyncError('未配置同步')
  const { deviceId } = settings
  const result: SyncResult = { pushed: 0, pulled: 0, conflicts: 0, notices: [] }
  const now = Date.now()

  // ---- 1. 推送 ----
  const dFolders = await db.folders.where('dirty').equals(1).toArray()
  const dDecks = await db.decks.where('dirty').equals(1).toArray()
  const dCards = await db.cards.where('dirty').equals(1).toArray()
  const dStates = await db.states.where('dirty').equals(1).toArray()
  const dLogs = await db.logs.where('dirty').equals(1).toArray()
  const dImages = await db.images.where('dirty').equals(1).toArray()
  const body: PushBody = {
    deviceId,
    folders: dFolders.map((f) => ({ ...f, baseRev: f.rev })),
    decks: dDecks.map((d) => ({ ...d, baseRev: d.rev })),
    cards: dCards.map((c) => ({ ...c, baseRev: c.rev })),
    states: dStates,
    logs: dLogs,
    images: dImages.map((i) => ({ id: i.id, mime: i.mime, size: i.size })),
  }
  const total = dFolders.length + dDecks.length + dCards.length + dStates.length + dLogs.length + dImages.length
  if (total > 0) {
    const resp = await backend.push(body)
    await db.transaction('rw', [db.folders, db.decks, db.cards, db.states, db.logs, db.images], async () => {
      for (const r of resp.folders ?? []) {
        const local = await db.folders.get(r.id)
        const sent = dFolders.find((f) => f.id === r.id)!
        if (!local) continue
        if (r.status === 'ok') {
          const stillDirty = local.updatedAt !== sent.updatedAt
          await db.folders.update(r.id, { rev: r.rev, dirty: stillDirty ? 1 : 0 })
          result.pushed++
        } else if (r.server) {
          const { canonical, notice } = resolveFolderConflict(local, r.server)
          await db.folders.put(canonical)
          result.conflicts++
          if (notice) result.notices.push(notice)
        }
      }
      for (const r of resp.decks) {
        const local = await db.decks.get(r.id)
        const sent = dDecks.find((d) => d.id === r.id)!
        if (!local) continue
        if (r.status === 'ok') {
          const stillDirty = local.updatedAt !== sent.updatedAt   // 推送期间又被修改则保持 dirty
          await db.decks.update(r.id, { rev: r.rev, dirty: stillDirty ? 1 : 0 })
          result.pushed++
        } else if (r.server) {
          const { canonical, notice } = resolveDeckConflict(local, r.server)
          await db.decks.put(canonical)
          result.conflicts++
          if (notice) result.notices.push(notice)
        }
      }
      for (const r of resp.cards) {
        const local = await db.cards.get(r.id)
        const sent = dCards.find((c) => c.id === r.id)!
        if (!local) continue
        if (r.status === 'ok') {
          const stillDirty = local.updatedAt !== sent.updatedAt
          await db.cards.update(r.id, { rev: r.rev, dirty: stillDirty ? 1 : 0 })
          result.pushed++
        } else if (r.server) {
          const { canonical, copy } = resolveCardConflict(local, r.server, now)
          await db.cards.put(canonical)
          if (copy) {
            await db.cards.put(copy)
            const st = await db.states.get(local.id)
            if (st) await db.states.put({ ...st, cardId: copy.id, updatedAt: now, dirty: 1 })
            result.notices.push('一张卡片在两台设备上被同时修改，本地版本已另存为“冲突副本”。')
          }
          result.conflicts++
        }
      }
      for (const r of resp.states) {
        const local = await db.states.get(r.id)
        const sent = dStates.find((s) => s.cardId === r.id)!
        if (!local) continue
        if (r.status === 'ok') {
          if (local.updatedAt === sent.updatedAt) await db.states.update(r.id, { dirty: 0 })
          result.pushed++
        } else if (r.server && lwwReplace(local, r.server)) {
          await db.states.put({ ...r.server, dirty: 0 })
        } else {
          await db.states.update(r.id, { dirty: 0 })
        }
      }
      for (const r of resp.logs) {
        const local = await db.logs.get(r.id)
        const sent = dLogs.find((l) => l.id === r.id)!
        if (!local) continue
        if (r.status === 'ok') {
          if (local.updatedAt === sent.updatedAt) await db.logs.update(r.id, { dirty: 0 })
          result.pushed++
        } else if (r.server && lwwReplace(local, r.server)) {
          await db.logs.put({ ...r.server, dirty: 0 })
        } else {
          await db.logs.update(r.id, { dirty: 0 })
        }
      }
    })
    for (const r of resp.images) {
      const rec = await db.images.get(r.id)
      if (!rec) continue
      if (r.status === 'need' && rec.blob) await backend.putImage(r.id, rec.mime, rec.blob)
      await db.images.update(r.id, { dirty: 0 })
      result.pushed++
    }
  }

  // ---- 2. 拉取 ----
  let since = (await getSettings()).lastSeq
  for (let guard = 0; guard < 50; guard++) {
    const pull = await backend.pull(since)
    const missingImages: Array<{ id: string; mime: string; size: number }> = []
    await db.transaction('rw', [db.folders, db.decks, db.cards, db.states, db.logs, db.images], async () => {
      for (const inc of pull.folders ?? []) {
        const local = await db.folders.get(inc.id)
        const d = decideIncoming(local, inc.rev)
        if (d === 'replace') { await db.folders.put({ ...inc, dirty: 0 }); result.pulled++ }
        else if (d === 'conflict' && local) {
          const { canonical, notice } = resolveFolderConflict(local, inc)
          await db.folders.put(canonical)
          result.conflicts++
          if (notice) result.notices.push(notice)
        }
      }
      for (const inc of pull.decks) {
        const local = await db.decks.get(inc.id)
        const d = decideIncoming(local, inc.rev)
        if (d === 'replace') { await db.decks.put({ ...inc, dirty: 0 }); result.pulled++ }
        else if (d === 'conflict' && local) {
          const { canonical, notice } = resolveDeckConflict(local, inc)
          await db.decks.put(canonical)
          result.conflicts++
          if (notice) result.notices.push(notice)
        }
      }
      for (const inc of pull.cards) {
        const local = await db.cards.get(inc.id)
        const d = decideIncoming(local, inc.rev)
        if (d === 'replace') { await db.cards.put({ ...inc, dirty: 0 }); result.pulled++ }
        else if (d === 'conflict' && local) {
          const { canonical, copy } = resolveCardConflict(local, inc, now)
          await db.cards.put(canonical)
          if (copy) {
            await db.cards.put(copy)
            const st = await db.states.get(local.id)
            if (st) await db.states.put({ ...st, cardId: copy.id, updatedAt: now, dirty: 1 })
            result.notices.push('一张卡片在两台设备上被同时修改，本地版本已另存为“冲突副本”。')
          }
          result.conflicts++
        }
      }
      for (const inc of pull.states) {
        const local = await db.states.get(inc.cardId)
        if (lwwReplace(local, inc)) { await db.states.put({ ...inc, dirty: 0 }); result.pulled++ }
      }
      for (const inc of pull.logs) {
        const local = await db.logs.get(inc.id)
        if (lwwReplace(local, inc)) { await db.logs.put({ ...inc, dirty: 0 }); result.pulled++ }
      }
      for (const inc of pull.images) {
        const local = await db.images.get(inc.id)
        if (!local || !local.blob) missingImages.push(inc)
      }
    })
    for (const im of missingImages) {
      const blob = await backend.getImage(im.id)
      if (!blob) { result.notices.push(`图片 ${im.id.slice(0, 8)} 下载失败`); continue }
      const rec: ImageRecord = { id: im.id, mime: im.mime, size: im.size, blob, createdAt: Date.now(), dirty: 0 }
      await db.images.put(rec)
      result.pulled++
    }
    since = pull.seq
    await updateSettings({ lastSeq: since })
    if (!pull.more) break
  }
  await updateSettings({ lastSyncAt: Date.now() })
  return result
}
