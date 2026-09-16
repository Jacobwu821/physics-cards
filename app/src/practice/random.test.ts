import { describe, it, expect } from 'vitest'
import { drawCards, filterCards } from './random'
import type { Card } from '../lib/types'

function mk(id: string, p: Partial<Card> = {}): Card {
  return {
    id, deckId: 'd1', type: 'concept', front: `front ${id}`, back: `back ${id}`, tags: [], source: {},
    favorite: 0, suspended: 0, sample: 0, createdAt: 0, updatedAt: 0, rev: 0, dirty: 0, deleted: 0, ...p,
  }
}

describe('随机抽卡', () => {
  const pool = [
    mk('a', { type: 'formula', tags: ['双能级系统'] }),
    mk('b', { type: 'concept', tags: ['近似条件'] }),
    mk('c', { deckId: 'd2', type: 'formula', tags: ['待加强'] }),
    mk('d', { suspended: 1 }),
    mk('e', { deleted: 1 }),
    mk('f', { front: '拉比频率 $\\Omega$' }),
  ]

  it('筛选：牌组、类型、标签、关键词；默认排除暂停与已删除', () => {
    expect(filterCards(pool, {}).map((c) => c.id)).toEqual(['a', 'b', 'c', 'f'])
    expect(filterCards(pool, { deckId: 'd1', types: ['formula'] }).map((c) => c.id)).toEqual(['a'])
    expect(filterCards(pool, { tags: ['待加强', '近似条件'] }).map((c) => c.id)).toEqual(['b', 'c'])
    expect(filterCards(pool, { keyword: '拉比' }).map((c) => c.id)).toEqual(['f'])
    expect(filterCards(pool, { includeSuspended: true }).map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'f'])
  })

  it('同一轮不重复，数量不足时给出差额', () => {
    const res = drawCards(filterCards(pool, {}), 3)
    expect(new Set(res.ids).size).toBe(3)
    const over = drawCards(filterCards(pool, {}), 10)
    expect(over.ids.length).toBe(4)
    expect(over.shortage).toBe(6)
    expect(new Set(over.ids).size).toBe(4)
  })

  it('抽取顺序由随机源决定', () => {
    let k = 0
    const seq = [0.1, 0.9, 0.5, 0.2, 0.7]
    const r1 = drawCards(filterCards(pool, {}), 4, () => seq[k++ % seq.length])
    k = 0
    const r2 = drawCards(filterCards(pool, {}), 4, () => seq[k++ % seq.length])
    expect(r1.ids).toEqual(r2.ids)
  })
})
