// 备份与恢复：完整导出牌组、卡片、格式/公式源码、标签、图片（base64）和复习记录。
import { db } from '../lib/db'
import { getSettings, updateSettings } from '../lib/repo'
import type { Card, CardState, Deck, ReviewLog } from '../lib/types'

export interface BackupFile {
  format: 'physics-cards-backup'
  version: 1
  exportedAt: number
  settings: { dailyNew: number; dailyReview: number }
  decks: Deck[]
  cards: Card[]
  states: CardState[]
  logs: ReviewLog[]
  images: Array<{ id: string; mime: string; size: number; createdAt: number; data: string }>
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < buf.length; i += chunk) s += String.fromCharCode(...buf.subarray(i, i + chunk))
  return btoa(s)
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

export async function exportBackup(): Promise<BackupFile> {
  const s = await getSettings()
  const images = await db.images.toArray()
  return {
    format: 'physics-cards-backup', version: 1, exportedAt: Date.now(),
    settings: { dailyNew: s.dailyNew, dailyReview: s.dailyReview },
    decks: await db.decks.toArray(),
    cards: await db.cards.toArray(),
    states: await db.states.toArray(),
    logs: await db.logs.toArray(),
    images: await Promise.all(images.filter((i) => i.blob).map(async (i) => ({
      id: i.id, mime: i.mime, size: i.size, createdAt: i.createdAt, data: await blobToBase64(i.blob!),
    }))),
  }
}

export function validateBackup(x: unknown): BackupFile {
  const b = x as Partial<BackupFile>
  if (!b || b.format !== 'physics-cards-backup' || b.version !== 1) throw new Error('不是有效的备份文件')
  for (const k of ['decks', 'cards', 'states', 'logs', 'images'] as const) {
    if (!Array.isArray(b[k])) throw new Error(`备份缺少 ${k}`)
  }
  return b as BackupFile
}

export type ImportMode = 'replace' | 'merge'

/**
 * replace：清空本地全部数据后导入；merge：按 id 合并，较新的记录胜出。
 * 导入的记录标记为 dirty，以便推送到同步服务器（服务器已有不同版本时按冲突规则处理，不会丢失）。
 */
export async function importBackup(b: BackupFile, mode: ImportMode): Promise<{ decks: number; cards: number; logs: number; images: number }> {
  const counts = { decks: 0, cards: 0, logs: 0, images: 0 }
  await db.transaction('rw', [db.decks, db.cards, db.states, db.logs, db.images, db.sessions, db.drafts], async () => {
    if (mode === 'replace') {
      await Promise.all([db.decks.clear(), db.cards.clear(), db.states.clear(), db.logs.clear(), db.images.clear(), db.sessions.clear(), db.drafts.clear()])
    }
    const newer = <T extends { updatedAt: number }>(local: T | undefined, inc: T) => !local || inc.updatedAt > local.updatedAt
    for (const d of b.decks) {
      if (mode === 'merge' && !newer(await db.decks.get(d.id), d)) continue
      await db.decks.put({ ...d, dirty: 1 }); counts.decks++
    }
    for (const c of b.cards) {
      if (mode === 'merge' && !newer(await db.cards.get(c.id), c)) continue
      await db.cards.put({ ...c, dirty: 1 }); counts.cards++
    }
    for (const s of b.states) {
      if (mode === 'merge' && !newer(await db.states.get(s.cardId), s)) continue
      await db.states.put({ ...s, dirty: 1 })
    }
    for (const l of b.logs) {
      if (mode === 'merge' && !newer(await db.logs.get(l.id), l)) continue
      await db.logs.put({ ...l, dirty: 1 }); counts.logs++
    }
    for (const im of b.images) {
      if (mode === 'merge' && (await db.images.get(im.id))?.blob) continue
      await db.images.put({ id: im.id, mime: im.mime, size: im.size, createdAt: im.createdAt, blob: base64ToBlob(im.data, im.mime), dirty: 1 })
      counts.images++
    }
  })
  await updateSettings({ dailyNew: b.settings?.dailyNew ?? 15, dailyReview: b.settings?.dailyReview ?? 200 })
  return counts
}

export function backupFileName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `physics-cards-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`
}
