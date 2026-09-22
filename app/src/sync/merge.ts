// 同步合并规则：纯函数，可测试。
// - deck / card：以服务器版本号 rev 做乐观并发控制。本地 dirty 且 rev 落后 → 冲突。
//   卡片冲突不静默覆盖：服务器版本成为正本，本地版本另存为“冲突副本”卡片。
// - state / log：按 updatedAt 后写胜出（LWW）；日志按 id 去重，重复提交不会重复更新。
import type { Card, CardState, Deck, Folder, ReviewLog } from '../lib/types'
import { uid } from '../lib/id'

export type Kind = 'folder' | 'deck' | 'card' | 'state' | 'log' | 'image'

export interface Versioned { rev: number; dirty: 0 | 1 }

export type Decision = 'replace' | 'skip' | 'conflict'

/** 拉取到 deck/card 记录时如何处理 */
export function decideIncoming(local: Versioned | undefined, incomingRev: number): Decision {
  if (!local) return 'replace'
  if (!local.dirty) return incomingRev > local.rev ? 'replace' : 'skip'
  // 本地有未推送修改
  if (incomingRev === local.rev) return 'skip' // 自己刚推送的回声
  return 'conflict'
}

export function cardContentEquals(a: Card, b: Card): boolean {
  return (
    a.front === b.front && a.back === b.back && a.type === b.type && a.deckId === b.deckId &&
    a.favorite === b.favorite && a.suspended === b.suspended && a.deleted === b.deleted &&
    JSON.stringify(a.tags) === JSON.stringify(b.tags) && JSON.stringify(a.source) === JSON.stringify(b.source)
  )
}

/** 把本地被冲突覆盖的卡片另存为新卡片（同牌组、标记“冲突副本”标签） */
export function makeConflictCopy(local: Card, now: number, deviceLabel = '本设备'): Card {
  const tag = '冲突副本'
  return {
    ...local,
    id: uid(),
    tags: local.tags.includes(tag) ? [...local.tags] : [...local.tags, tag],
    source: { ...local.source, note: [local.source.note, `（${deviceLabel}的冲突副本，原卡 ${local.id.slice(0, 8)}）`].filter(Boolean).join('\n') },
    createdAt: now, updatedAt: now, rev: 0, dirty: 1, deleted: 0,
  }
}

/** 解决卡片冲突：服务器版本成正本；本地内容若不同，则生成冲突副本 */
export function resolveCardConflict(local: Card, server: Card, now: number): { canonical: Card; copy: Card | null } {
  const canonical: Card = { ...server, dirty: 0 }
  if (cardContentEquals(local, server) || local.deleted) return { canonical, copy: null }
  if (server.deleted) {
    // 服务器已删除而本地又改过：保留本地内容为新卡，不让修改丢失
    return { canonical, copy: makeConflictCopy(local, now) }
  }
  return { canonical, copy: makeConflictCopy(local, now) }
}

/** 牌组冲突：服务器胜出，并提示被覆盖的名称或文件夹变更。 */
export function resolveDeckConflict(local: Deck, server: Deck): { canonical: Deck; notice: string | null } {
  const canonical: Deck = { ...server, dirty: 0 }
  const notice = server.deleted ? null
    : local.name !== server.name ? `牌组“${local.name}”在其他设备被改名为“${server.name}”，已采用后者。`
      : (local.folderId ?? null) !== (server.folderId ?? null)
        ? `牌组“${local.name}”在其他设备被移至另一文件夹，已采用那边的位置。`
        : null
  return { canonical, notice }
}

export function resolveFolderConflict(local: Folder, server: Folder): { canonical: Folder; notice: string | null } {
  const canonical: Folder = { ...server, dirty: 0 }
  const notice = local.name !== server.name && !server.deleted
    ? `文件夹“${local.name}”在其他设备被改名为“${server.name}”，已采用后者。`
    : null
  return { canonical, notice }
}

/** LWW：incoming 更新（严格更晚）才替换 */
export function lwwReplace(local: { updatedAt: number } | undefined, incoming: { updatedAt: number }): boolean {
  if (!local) return true
  return incoming.updatedAt > local.updatedAt
}

/** 把一批评分日志按 id 去重后归并到本地（重复提交只保留一份） */
export function mergeLogs(local: Map<string, ReviewLog>, incoming: ReviewLog[]): Map<string, ReviewLog> {
  const out = new Map(local)
  for (const l of incoming) {
    const cur = out.get(l.id)
    if (!cur || l.updatedAt > cur.updatedAt) out.set(l.id, { ...l, dirty: 0 })
  }
  return out
}

/** 状态归并：同一张卡以最后一次变更为准 */
export function mergeState(local: CardState | undefined, incoming: CardState): CardState {
  if (!local) return { ...incoming, dirty: 0 }
  return incoming.updatedAt > local.updatedAt ? { ...incoming, dirty: 0 } : local
}
