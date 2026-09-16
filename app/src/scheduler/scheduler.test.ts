import { describe, it, expect } from 'vitest'
import {
  applyRating, buildQueue, countToday, endOfLocalDay, localDayKey, makeScheduler,
  newState, previewIntervals, undoRating, isDueBy,
} from './scheduler'
import type { Card, CardState, ReviewLog } from '../lib/types'

const sched = makeScheduler({ enable_fuzz: false })
const T0 = Date.UTC(2026, 8, 16, 2, 0, 0) // 2026-09-16 02:00 UTC
const DAY = 86400000

function mkCard(id: string, deckId = 'd1', extra: Partial<Card> = {}): Card {
  return {
    id, deckId, type: 'formula', front: id, back: '', tags: [], source: {},
    favorite: 0, suspended: 0, sample: 0, createdAt: T0, updatedAt: T0, rev: 0, dirty: 1, deleted: 0,
    ...extra,
  }
}

describe('评分与间隔', () => {
  it('新卡：忘记进入短间隔，轻松直接进入长期复习', () => {
    const s = newState('c1', T0)
    expect(s.state).toBe(0)
    const again = applyRating(s, 1, T0, 'dev', 'review', sched)
    expect(again.state.state).toBe(1) // Learning
    expect(again.state.due - T0).toBeLessThanOrEqual(10 * 60000)
    const easy = applyRating(s, 4, T0, 'dev', 'review', sched)
    expect(easy.state.state).toBe(2) // Review
    expect(easy.state.due - T0).toBeGreaterThanOrEqual(DAY)
  })

  it('预览的四种下次时间单调递增，并与实际评分一致', () => {
    const s = newState('c1', T0)
    const p = previewIntervals(s, T0, sched)
    expect(p[1].due).toBeLessThanOrEqual(p[2].due)
    expect(p[2].due).toBeLessThanOrEqual(p[3].due)
    expect(p[3].due).toBeLessThanOrEqual(p[4].due)
    for (const r of [1, 2, 3, 4] as const) {
      expect(applyRating(s, r, T0, 'dev', 'review', sched).state.due).toBe(p[r].due)
    }
  })

  it('连续记得后间隔逐步延长；忘记后重学且 lapses 增加', () => {
    let s = newState('c1', T0)
    let now = T0
    const intervals: number[] = []
    for (let i = 0; i < 5; i++) {
      const r = applyRating(s, 3, now, 'dev', 'review', sched)
      intervals.push(r.state.due - now)
      s = r.state
      now = r.state.due
    }
    for (let i = 1; i < intervals.length; i++) expect(intervals[i]).toBeGreaterThan(intervals[i - 1])
    const forgot = applyRating(s, 1, now, 'dev', 'review', sched)
    expect(forgot.state.state).toBe(3) // Relearning
    expect(forgot.state.lapses).toBe(s.lapses + 1)
    expect(forgot.state.due - now).toBeLessThan(DAY)
  })

  it('不同卡片不会被排到同一套固定日期：难度不同则间隔不同', () => {
    const a = applyRating(newState('a', T0), 3, T0, 'dev', 'review', sched).state
    const b = applyRating(newState('b', T0), 2, T0, 'dev', 'review', sched).state
    const a2 = applyRating(a, 3, a.due, 'dev', 'review', sched).state
    const b2 = applyRating(b, 3, b.due, 'dev', 'review', sched).state
    expect(a2.due - a.due).not.toBe(b2.due - b.due)
  })

  it('撤销评分恢复原状态', () => {
    const s = newState('c1', T0)
    const r = applyRating(s, 3, T0, 'dev', 'review', sched)
    const back = undoRating(r.state, r.log, T0 + 1000)
    expect(back.due).toBe(s.due)
    expect(back.state).toBe(s.state)
    expect(back.reps).toBe(s.reps)
  })

  it('逾期很久的卡片仍按实际到期处理，不重置为新卡', () => {
    const s = applyRating(newState('c1', T0), 4, T0, 'dev', 'review', sched).state
    const late = s.due + 30 * DAY
    expect(isDueBy(s, late)).toBe(true)
    const r = applyRating(s, 3, late, 'dev', 'review', sched)
    expect(r.state.state).toBe(2)
    expect(r.state.reps).toBe(s.reps + 1)
  })

  it('随机练习日志不计入今日复习量', () => {
    const s = newState('c1', T0)
    const p = applyRating(s, 3, T0, 'dev', 'practice', sched)
    expect(countToday([p.log], T0)).toEqual({ newIntroduced: 0, reviewsDone: 0 })
  })
})

describe('今日队列', () => {
  function stateAt(cardId: string, due: number, state: 0 | 1 | 2 | 3 = 2): CardState {
    return {
      cardId, due, stability: 5, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0,
      reps: 1, lapses: 0, state, last_review: T0 - DAY, updatedAt: T0, dirty: 0,
    }
  }

  it('到期卡在前、新卡在后，受每日目标限制且报告超出数量', () => {
    const cards = [mkCard('n1'), mkCard('n2'), mkCard('n3'), mkCard('r1'), mkCard('r2'), mkCard('r3'), mkCard('future')]
    const states = new Map<string, CardState>([
      ['r1', stateAt('r1', T0 - DAY)], ['r2', stateAt('r2', T0 - 2 * DAY)], ['r3', stateAt('r3', T0)],
      ['future', stateAt('future', T0 + 5 * DAY)],
    ])
    const q = buildQueue({ cards, states, logs: [], settings: { dailyNew: 2, dailyReview: 2 }, now: T0 })
    expect(q.queue).toEqual(['r2', 'r1', 'n1', 'n2'])
    expect(q.dueTotal).toBe(3)
    expect(q.newTotal).toBe(3)
    expect(q.dueBeyondLimit).toBe(1)
    expect(q.newBeyondLimit).toBe(1)
  })

  it('暂停卡不进入队列；已删除卡不进入队列；可按牌组过滤', () => {
    const cards = [mkCard('a'), mkCard('b', 'd1', { suspended: 1 }), mkCard('c', 'd2'), mkCard('d', 'd1', { deleted: 1 })]
    const q = buildQueue({ cards, states: new Map(), logs: [], settings: { dailyNew: 10, dailyReview: 10 }, now: T0, deckId: 'd1' })
    expect(q.queue).toEqual(['a'])
  })

  it('今日已学的新卡计入上限；撤销的日志不计入', () => {
    const cards = [mkCard('n1'), mkCard('n2'), mkCard('n3')]
    const base = newState('x', T0)
    const l1 = applyRating(base, 3, T0, 'dev', 'review', sched).log
    const l2: ReviewLog = { ...applyRating(base, 3, T0, 'dev', 'review', sched).log, undone: 1 }
    const q = buildQueue({ cards, states: new Map(), logs: [l1, l2], settings: { dailyNew: 2, dailyReview: 10 }, now: T0 })
    expect(q.counts.newIntroduced).toBe(1)
    expect(q.queue.length).toBe(1)
  })

  it('错过几天后所有逾期卡都保留到期状态', () => {
    const cards = [mkCard('a'), mkCard('b')]
    const states = new Map<string, CardState>([['a', stateAt('a', T0 + DAY)], ['b', stateAt('b', T0 + 3 * DAY)]])
    const later = T0 + 10 * DAY
    const q = buildQueue({ cards, states, logs: [], settings: { dailyNew: 0, dailyReview: 100 }, now: later })
    expect(q.queue).toEqual(['a', 'b'])
  })
})

describe('日期与时区', () => {
  it('本地日期键与日末时间一致', () => {
    const now = Date.now()
    const eod = endOfLocalDay(now)
    expect(localDayKey(eod)).toBe(localDayKey(now))
    expect(localDayKey(eod + 1)).not.toBe(localDayKey(now))
  })

  it('到期判断使用绝对时间戳，与时区无关', () => {
    const s = applyRating(newState('c', T0), 4, T0, 'dev', 'review', sched).state
    expect(isDueBy(s, s.due - 1)).toBe(false)
    expect(isDueBy(s, s.due)).toBe(true)
  })
})
