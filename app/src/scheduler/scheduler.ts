// 调度模块：纯函数，不依赖界面与数据库。
// 采用 FSRS（Free Spaced Repetition Scheduler，ts-fsrs 实现）。
// 理由：FSRS 用“稳定性 / 难度 / 可提取性”三个量描述遗忘曲线，
// 每张卡的间隔由自身历史决定而非固定日期表；四档评分直接对应“忘记/困难/记得/轻松”；
// repeat() 能在评分前给出四种结果的预计下次时间；实现成熟，可离线纯计算。
import {
  createEmptyCard, fsrs, Rating as FRating, State as FState,
  type Card as FCard, type FSRSParameters,
} from 'ts-fsrs'
import type { Card, CardState, Rating, ReviewLog, Settings } from '../lib/types'
import { uid } from '../lib/id'

export type SchedulerOptions = Partial<FSRSParameters>

const DEFAULT_OPTIONS: SchedulerOptions = {
  request_retention: 0.9,
  maximum_interval: 365,
  enable_fuzz: true,
  enable_short_term: true,
  learning_steps: ['1m', '10m'],
  relearning_steps: ['10m'],
}

export function makeScheduler(opts: SchedulerOptions = {}) {
  return fsrs({ ...DEFAULT_OPTIONS, ...opts })
}

export type Snapshot = Omit<CardState, 'cardId' | 'updatedAt' | 'dirty'>

export function newState(cardId: string, now: number): CardState {
  const c = createEmptyCard(new Date(now))
  return { ...fromFsrs(c), cardId, updatedAt: now, dirty: 1 }
}

export function toFsrs(s: Snapshot): FCard {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsed_days,
    scheduled_days: s.scheduled_days,
    learning_steps: s.learning_steps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state as FState,
    last_review: s.last_review == null ? undefined : new Date(s.last_review),
  }
}

export function fromFsrs(c: FCard): Snapshot {
  return {
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as 0 | 1 | 2 | 3,
    last_review: c.last_review ? c.last_review.getTime() : null,
  }
}

export function snapshot(s: CardState): Snapshot {
  const { cardId: _c, updatedAt: _u, dirty: _d, ...rest } = s
  return rest
}

export const RATING_LABELS: Record<Rating, string> = { 1: '忘记', 2: '困难', 3: '记得', 4: '轻松' }
export const STATE_LABELS: Record<0 | 1 | 2 | 3, string> = { 0: '新卡', 1: '学习中', 2: '复习中', 3: '重学中' }

/** 评分前预览：四种评分对应的下次复习时间 */
export function previewIntervals(
  s: CardState, now: number, sched = makeScheduler(),
): Record<Rating, { due: number; label: string }> {
  const rec = sched.repeat(toFsrs(s), new Date(now))
  const out = {} as Record<Rating, { due: number; label: string }>
  for (const r of [1, 2, 3, 4] as Rating[]) {
    const due = rec[r as FRating.Again].card.due.getTime()
    out[r] = { due, label: humanInterval(due - now) }
  }
  return out
}

/** 应用一次评分，返回新状态与日志（日志中保存评分前后的完整快照，用于撤销与同步） */
export function applyRating(
  s: CardState, rating: Rating, now: number, deviceId: string,
  mode: ReviewLog['mode'] = 'review', sched = makeScheduler(),
): { state: CardState; log: ReviewLog } {
  const before = snapshot(s)
  const res = sched.next(toFsrs(s), new Date(now), rating as FRating.Again)
  const after = fromFsrs(res.card)
  const state: CardState = { ...after, cardId: s.cardId, updatedAt: now, dirty: 1 }
  const log: ReviewLog = {
    id: uid(), cardId: s.cardId, rating, mode, reviewedAt: now,
    before, after, deviceId, undone: 0, updatedAt: now, dirty: 1,
  }
  return { state, log }
}

/** 撤销：恢复日志中的“评分前”快照 */
export function undoRating(s: CardState, log: ReviewLog, now: number): CardState {
  return { ...log.before, cardId: s.cardId, updatedAt: now, dirty: 1 }
}

// ---------- 日期工具（本地时区） ----------
export function localDayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function endOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function isDueBy(s: CardState, cutoff: number): boolean {
  return s.state !== 0 && s.due <= cutoff
}

export function humanInterval(ms: number): string {
  if (ms < 0) ms = 0
  const min = ms / 60000
  if (min < 1) return '<1分钟'
  if (min < 60) return `${Math.round(min)}分钟`
  const h = min / 60
  if (h < 24) return `${Math.round(h)}小时`
  const d = h / 24
  if (d < 30) return `${Math.round(d)}天`
  const mo = d / 30
  if (mo < 12) return `${mo.toFixed(1).replace(/\.0$/, '')}个月`
  return `${(d / 365).toFixed(1).replace(/\.0$/, '')}年`
}

export function humanDue(due: number, now: number): string {
  if (due <= now) return '已到期'
  return humanInterval(due - now) + '后'
}

// ---------- 今日队列 ----------
export interface DailyCounts {
  newIntroduced: number   // 今天首次学习的新卡数
  reviewsDone: number     // 今天完成的复习次数（非新卡）
}

/** 从评分日志统计今天的学习量（本地日期） */
export function countToday(logs: ReviewLog[], now: number): DailyCounts {
  const key = localDayKey(now)
  let newIntroduced = 0, reviewsDone = 0
  for (const l of logs) {
    if (l.undone || l.mode !== 'review') continue
    if (localDayKey(l.reviewedAt) !== key) continue
    if (l.before.state === 0) newIntroduced++
    else reviewsDone++
  }
  return { newIntroduced, reviewsDone }
}

export interface QueueInput {
  cards: Card[]
  states: Map<string, CardState>
  logs: ReviewLog[]          // 用于统计今日量
  settings: Pick<Settings, 'dailyNew' | 'dailyReview'>
  now: number
  deckId?: string | null
}

export interface QueueResult {
  queue: string[]          // 本次会话的卡片 id（到期卡在前，新卡在后）
  dueTotal: number         // 全部到期（不含暂停）
  newTotal: number         // 全部可学新卡
  dueSelected: number
  newSelected: number
  dueBeyondLimit: number   // 超出今日目标仍到期的数量
  newBeyondLimit: number
  counts: DailyCounts
}

/** 构建今日复习队列：到期卡（受每日复习目标限制）+ 新卡（受每日新卡上限限制） */
export function buildQueue(input: QueueInput): QueueResult {
  const { cards, states, logs, settings, now } = input
  const cutoff = endOfLocalDay(now)
  const counts = countToday(logs, now)
  const eligible = cards.filter(
    (c) => !c.deleted && !c.suspended && (!input.deckId || c.deckId === input.deckId),
  )
  const due: Array<{ id: string; due: number }> = []
  const fresh: Array<{ id: string; createdAt: number }> = []
  for (const c of eligible) {
    const s = states.get(c.id)
    if (!s || s.state === 0) fresh.push({ id: c.id, createdAt: c.createdAt })
    else if (isDueBy(s, cutoff)) due.push({ id: c.id, due: s.due })
  }
  due.sort((a, b) => a.due - b.due)
  fresh.sort((a, b) => a.createdAt - b.createdAt)
  const reviewRoom = Math.max(0, settings.dailyReview - counts.reviewsDone)
  const newRoom = Math.max(0, settings.dailyNew - counts.newIntroduced)
  const dueSel = due.slice(0, reviewRoom)
  const newSel = fresh.slice(0, newRoom)
  return {
    queue: [...dueSel.map((d) => d.id), ...newSel.map((n) => n.id)],
    dueTotal: due.length,
    newTotal: fresh.length,
    dueSelected: dueSel.length,
    newSelected: newSel.length,
    dueBeyondLimit: due.length - dueSel.length,
    newBeyondLimit: fresh.length - newSel.length,
    counts,
  }
}
