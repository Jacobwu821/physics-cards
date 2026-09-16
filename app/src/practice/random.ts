import type { Card, CardTypeId } from '../lib/types'

export interface CardFilter {
  deckId?: string | null
  types?: CardTypeId[]
  tags?: string[]           // 任一标签匹配
  keyword?: string
  favoriteOnly?: boolean
  includeSuspended?: boolean
  suspendedOnly?: boolean
}

export function filterCards(cards: Card[], f: CardFilter): Card[] {
  const kw = (f.keyword ?? '').trim().toLowerCase()
  return cards.filter((c) => {
    if (c.deleted) return false
    if (f.deckId && c.deckId !== f.deckId) return false
    if (f.types && f.types.length && !f.types.includes(c.type)) return false
    if (f.tags && f.tags.length && !f.tags.some((t) => c.tags.includes(t))) return false
    if (f.favoriteOnly && !c.favorite) return false
    if (f.suspendedOnly && !c.suspended) return false
    if (!f.includeSuspended && !f.suspendedOnly && c.suspended) return false
    if (kw) {
      const hay = [c.front, c.back, c.source.title, c.source.location, c.source.link, c.source.note, ...c.tags]
        .filter(Boolean).join('\n').toLowerCase()
      if (!hay.includes(kw)) return false
    }
    return true
  })
}

export interface DrawResult {
  ids: string[]
  requested: number
  available: number
  shortage: number  // 请求数超过可用数时的差额
}

/** 同一轮不重复抽取（Fisher–Yates 洗牌后取前 n 张） */
export function drawCards(pool: Card[], n: number, rng: () => number = Math.random): DrawResult {
  const ids = pool.map((c) => c.id)
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
  }
  const take = Math.max(0, Math.min(n, ids.length))
  return { ids: ids.slice(0, take), requested: n, available: ids.length, shortage: Math.max(0, n - ids.length) }
}
