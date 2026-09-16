import { describe, it, expect } from 'vitest'
import { decideIncoming, mergeLogs, mergeState, resolveCardConflict, resolveDeckConflict } from './merge'
import type { Card, CardState, Deck, ReviewLog } from '../lib/types'
import { applyRating, makeScheduler, newState } from '../scheduler/scheduler'

const T = 1_800_000_000_000
function card(p: Partial<Card> = {}): Card {
  return {
    id: 'c1', deckId: 'd1', type: 'formula', front: 'A', back: 'B', tags: ['x'], source: {},
    favorite: 0, suspended: 0, sample: 0, createdAt: T, updatedAt: T, rev: 3, dirty: 0, deleted: 0, ...p,
  }
}

describe('拉取决策', () => {
  it('本地不存在 → 替换；本地干净且 rev 更新 → 替换；相同 → 跳过', () => {
    expect(decideIncoming(undefined, 1)).toBe('replace')
    expect(decideIncoming({ rev: 2, dirty: 0 }, 3)).toBe('replace')
    expect(decideIncoming({ rev: 3, dirty: 0 }, 3)).toBe('skip')
  })
  it('本地有未推送修改：rev 相同为回声跳过，rev 不同为冲突', () => {
    expect(decideIncoming({ rev: 3, dirty: 1 }, 3)).toBe('skip')
    expect(decideIncoming({ rev: 3, dirty: 1 }, 4)).toBe('conflict')
  })
})

describe('卡片冲突', () => {
  it('两端修改同一张卡：服务器版本成正本，本地版本另存为冲突副本，两份都不丢', () => {
    const local = card({ front: '本地改动', dirty: 1, rev: 3 })
    const server = card({ front: '远端改动', rev: 4 })
    const { canonical, copy } = resolveCardConflict(local, server, T + 1)
    expect(canonical.front).toBe('远端改动')
    expect(canonical.rev).toBe(4)
    expect(canonical.dirty).toBe(0)
    expect(copy).not.toBeNull()
    expect(copy!.id).not.toBe(local.id)
    expect(copy!.front).toBe('本地改动')
    expect(copy!.deckId).toBe('d1')
    expect(copy!.tags).toContain('冲突副本')
    expect(copy!.dirty).toBe(1)
    expect(copy!.rev).toBe(0)
  })
  it('内容相同的冲突不产生副本', () => {
    const local = card({ dirty: 1, rev: 3 })
    const server = card({ rev: 4 })
    expect(resolveCardConflict(local, server, T).copy).toBeNull()
  })
  it('远端删除、本地修改：保留本地内容为新卡', () => {
    const local = card({ front: '本地改动', dirty: 1, rev: 3 })
    const server = card({ rev: 4, deleted: 1 })
    const r = resolveCardConflict(local, server, T)
    expect(r.canonical.deleted).toBe(1)
    expect(r.copy?.front).toBe('本地改动')
    expect(r.copy?.deleted).toBe(0)
  })
})

describe('牌组冲突', () => {
  it('服务器改名胜出并给出提示', () => {
    const local: Deck = { id: 'd', name: '甲', sample: 0, createdAt: T, updatedAt: T, rev: 1, dirty: 1, deleted: 0 }
    const server: Deck = { ...local, name: '乙', rev: 2, dirty: 0 }
    const r = resolveDeckConflict(local, server)
    expect(r.canonical.name).toBe('乙')
    expect(r.notice).toContain('乙')
  })
})

describe('评分日志与状态', () => {
  const sched = makeScheduler({ enable_fuzz: false })
  it('同一日志重复提交只保留一份，状态不重复推进', () => {
    const s0 = newState('c1', T)
    const r = applyRating(s0, 3, T, 'devA', 'review', sched)
    const once = mergeLogs(new Map(), [r.log])
    const twice = mergeLogs(once, [r.log, { ...r.log }])
    expect(twice.size).toBe(1)
    // 状态：同一 updatedAt 的重复状态不改变结果
    const st1 = mergeState(undefined, r.state)
    const st2 = mergeState(st1, r.state)
    expect(st2).toEqual(st1)
    expect(st2.reps).toBe(1)
  })
  it('两台设备各评一次：以更晚的一次为准，日志两条都保留', () => {
    const s0 = newState('c1', T)
    const a = applyRating(s0, 3, T + 1000, 'devA', 'review', sched)
    const b = applyRating(s0, 1, T + 5000, 'devB', 'review', sched)
    const merged = mergeState(mergeState(undefined, a.state), b.state)
    expect(merged.updatedAt).toBe(T + 5000)
    expect(merged.state).toBe(1)
    const logs = mergeLogs(mergeLogs(new Map(), [a.log]), [b.log])
    expect(logs.size).toBe(2)
    // 反向到达顺序结果一致
    const merged2 = mergeState(mergeState(undefined, b.state), a.state)
    expect(merged2.updatedAt).toBe(merged.updatedAt)
  })
  it('撤销标记通过 updatedAt 覆盖旧日志', () => {
    const s0 = newState('c1', T)
    const r = applyRating(s0, 3, T, 'devA', 'review', sched)
    const undone: ReviewLog = { ...r.log, undone: 1, updatedAt: T + 10 }
    const m = mergeLogs(mergeLogs(new Map(), [r.log]), [undone])
    expect(m.get(r.log.id)?.undone).toBe(1)
    const stale: CardState = { ...r.state, updatedAt: T - 1 }
    expect(mergeState(r.state, stale)).toBe(r.state)
  })
})
