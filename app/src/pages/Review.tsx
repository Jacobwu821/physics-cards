import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/db'
import { clearSession, ensureState, getSession, getSettings, rateCard, saveSession, undoLog } from '../lib/repo'
import { buildQueue, endOfLocalDay, previewIntervals, RATING_LABELS, STATE_LABELS, startOfLocalDay } from '../scheduler/scheduler'
import CardView from '../components/CardView'
import { isTypingTarget, useToast } from '../components/ui'
import type { CardState, Rating } from '../lib/types'

interface Sess { deckId: string | null; queue: string[]; done: number; history: string[]; startedAt: number }

export default function Review() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const [sess, setSess] = useState<Sess | null>(null)
  const [empty, setEmpty] = useState(false)
  const [showAnswer, setShowAnswer] = useState(false)
  const [state, setState] = useState<CardState | null>(null)
  const [busy, setBusy] = useState(false)

  // 初始化：继续会话或新建
  useEffect(() => {
    let alive = true
    ;(async () => {
      const deckParam = params.get('deck')
      const fresh = params.get('fresh') === '1'
      const existing = await getSession()
      if (!fresh && existing && existing.queue.length > 0 && (!deckParam || existing.deckId === deckParam)) {
        if (alive) setSess({ deckId: existing.deckId, queue: existing.queue, done: existing.done, history: existing.history, startedAt: existing.startedAt })
        return
      }
      const now = Date.now()
      const [cards, states, logs, settings] = await Promise.all([
        db.cards.filter((c) => !c.deleted).toArray(), db.states.toArray(),
        db.logs.where('reviewedAt').aboveOrEqual(startOfLocalDay(now) - 86400000).toArray(), getSettings(),
      ])
      const q = buildQueue({ cards, states: new Map(states.map((s) => [s.cardId, s])), logs, settings, now, deckId: deckParam })
      if (q.queue.length === 0) { if (alive) setEmpty(true); return }
      const s: Sess = { deckId: deckParam, queue: q.queue, done: 0, history: [], startedAt: now }
      await saveSession(s)
      if (alive) setSess(s)
    })()
    return () => { alive = false }
  }, [])

  const currentId = sess?.queue[0]
  const card = useLiveQuery(async () => (currentId ? await db.cards.get(currentId) : undefined), [currentId])
  const total = sess ? sess.done + sess.queue.length : 0

  // 载入当前卡片状态（用于预览间隔）；卡片被删除或暂停则跳过
  useEffect(() => {
    if (!sess || !currentId) return
    let alive = true
    ;(async () => {
      const c = await db.cards.get(currentId)
      if (!c || c.deleted || c.suspended) {
        const next = { ...sess, queue: sess.queue.slice(1) }
        await saveSession(next)
        if (alive) setSess(next)
        return
      }
      const st = await ensureState(currentId)
      if (alive) { setState(st); setShowAnswer(false) }
    })()
    return () => { alive = false }
  }, [currentId, sess?.queue.length, sess?.done])

  const preview = state ? previewIntervals(state, Date.now()) : null

  const rate = useCallback(async (r: Rating) => {
    if (!sess || !card || !showAnswer || busy) return
    setBusy(true)
    try {
      const now = Date.now()
      const log = await rateCard(card.id, r, 'review')
      const st = await db.states.get(card.id)
      let queue = sess.queue.slice(1)
      // 学习步骤内（今天仍会到期）的卡片放回队尾再次出现
      if (st && st.due <= endOfLocalDay(now)) queue = [...queue, card.id]
      const next: Sess = { ...sess, queue, done: sess.done + 1, history: [...sess.history, log.id] }
      if (queue.length === 0) await clearSession(); else await saveSession(next)
      setSess(next)
      setShowAnswer(false)
    } finally { setBusy(false) }
  }, [sess, card, showAnswer, busy])

  const undo = useCallback(async () => {
    if (!sess || sess.history.length === 0 || busy) return
    setBusy(true)
    try {
      const lastId = sess.history[sess.history.length - 1]
      const log = await db.logs.get(lastId)
      if (!log) return
      const ok = await undoLog(lastId)
      if (!ok) { toast('无法撤销'); return }
      const queue = [log.cardId, ...sess.queue.filter((id) => id !== log.cardId)]
      const next: Sess = { ...sess, queue, done: Math.max(0, sess.done - 1), history: sess.history.slice(0, -1) }
      await saveSession(next)
      setSess(next)
      setShowAnswer(false)
      toast('已撤销上一次评分，复习计划已恢复')
    } finally { setBusy(false) }
  }, [sess, busy, toast])

  // 桌面快捷键：空格/回车翻面，1-4 评分，Z 撤销，Esc 退出；输入框中不触发
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!showAnswer) setShowAnswer(true) }
      else if (['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); void rate(Number(e.key) as Rating) }
      else if (e.key.toLowerCase() === 'z') { e.preventDefault(); void undo() }
      else if (e.key === 'Escape') navigate('/')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showAnswer, rate, undo, navigate])

  if (empty) {
    return (
      <div className="review">
        <div className="panel stack">
          <h1>今天没有待复习的卡片</h1>
          <p className="muted">到期卡与新卡都已完成，或牌组为空。可以去随机抽卡练习。</p>
          <div className="row"><Link className="btn" to="/">返回今日</Link><Link className="btn" to="/practice">随机抽卡</Link></div>
        </div>
      </div>
    )
  }
  if (!sess) return null
  if (sess.queue.length === 0) {
    return (
      <div className="review">
        <div className="panel stack">
          <h1>本轮复习完成</h1>
          <p className="muted">共完成 {sess.done} 次评分。复习计划已根据你的评分更新。</p>
          <div className="row">
            <Link className="btn primary" to="/">返回今日</Link>
            {sess.history.length > 0 && <button className="btn" onClick={undo}>撤销最后一次评分</button>}
          </div>
        </div>
      </div>
    )
  }
  if (!card) return null

  return (
    <div className="review">
      <div className="review-top">
        <button className="btn sm ghost" onClick={() => navigate('/')}>← 退出</button>
        <span className="muted small">已完成 {sess.done} / {total} · 剩余 {sess.queue.length}{state ? ` · ${STATE_LABELS[state.state]}` : ''}</span>
        <button className="btn sm ghost" disabled={sess.history.length === 0 || busy} onClick={undo}>撤销</button>
      </div>
      <div className="progress"><div style={{ width: `${total ? (sess.done / total) * 100 : 0}%` }} /></div>

      <CardView card={card} showAnswer={showAnswer} onReveal={() => setShowAnswer(true)} />

      <div className="review-actions">
        {!showAnswer ? (
          <button className="btn primary big block" onClick={() => setShowAnswer(true)}>显示答案 <span className="kbd">空格</span></button>
        ) : (
          <div className="rating-grid">
            {([1, 2, 3, 4] as Rating[]).map((r) => (
              <button key={r} className={`rating-btn r${r}`} onClick={() => rate(r)} disabled={busy}>
                <span className="t">{RATING_LABELS[r]}</span>
                <span className="iv">{preview ? preview[r].label : ''}</span>
                <span className="kbd">{r}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
