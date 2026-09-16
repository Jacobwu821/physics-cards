import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/db'
import { ensureState, rateCard, undoLog } from '../lib/repo'
import { drawCards, filterCards } from '../practice/random'
import { previewIntervals, RATING_LABELS } from '../scheduler/scheduler'
import { TEMPLATES } from '../lib/templates'
import CardView from '../components/CardView'
import { isTypingTarget, useToast } from '../components/ui'
import type { CardState, CardTypeId, Rating } from '../lib/types'

export default function Practice() {
  const navigate = useNavigate()
  const toast = useToast()
  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray())
  const cards = useLiveQuery(() => db.cards.filter((c) => !c.deleted).toArray())
  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const c of cards ?? []) for (const t of c.tags) set.add(t)
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
  }, [cards])

  const [deckId, setDeckId] = useState('')
  const [types, setTypes] = useState<CardTypeId[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [keyword, setKeyword] = useState('')
  const [count, setCount] = useState(10)
  const [includeSuspended, setIncludeSuspended] = useState(false)
  const [affect, setAffect] = useState(false)

  const pool = useMemo(() => filterCards(cards ?? [], { deckId: deckId || null, types, tags, keyword, includeSuspended }),
    [cards, deckId, types, tags, keyword, includeSuspended])

  // 一轮练习
  const [round, setRound] = useState<{ ids: string[]; index: number; lastLog: string | null } | null>(null)
  const [showAnswer, setShowAnswer] = useState(false)
  const [state, setState] = useState<CardState | null>(null)
  const currentId = round ? round.ids[round.index] : undefined
  const card = useLiveQuery(async () => (currentId ? await db.cards.get(currentId) : undefined), [currentId])

  useEffect(() => {
    if (!currentId || !affect) { setState(null); return }
    let alive = true
    ensureState(currentId).then((s) => { if (alive) setState(s) })
    return () => { alive = false }
  }, [currentId, affect])

  const start = () => {
    const res = drawCards(pool, count)
    if (res.ids.length === 0) { toast('没有符合条件的卡片'); return }
    if (res.shortage > 0) toast(`符合条件的卡片只有 ${res.available} 张，少于请求的 ${res.requested} 张，本轮抽取 ${res.ids.length} 张`)
    setRound({ ids: res.ids, index: 0, lastLog: null })
    setShowAnswer(false)
  }

  const next = useCallback(() => {
    if (!round) return
    setRound({ ...round, index: round.index + 1, lastLog: null })
    setShowAnswer(false)
  }, [round])

  const rate = useCallback(async (r: Rating) => {
    if (!round || !card || !showAnswer || !affect) return
    const log = await rateCard(card.id, r, 'review')
    setRound({ ...round, index: round.index + 1, lastLog: log.id })
    setShowAnswer(false)
  }, [round, card, showAnswer, affect])

  const undo = useCallback(async () => {
    if (!round || !round.lastLog) return
    await undoLog(round.lastLog)
    setRound({ ...round, index: round.index - 1, lastLog: null })
    setShowAnswer(false)
    toast('已撤销上一次评分')
  }, [round, toast])

  useEffect(() => {
    if (!round) return
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!showAnswer) setShowAnswer(true); else if (!affect) next() }
      else if (affect && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); void rate(Number(e.key) as Rating) }
      else if (e.key.toLowerCase() === 'z' && affect) { e.preventDefault(); void undo() }
      else if (e.key === 'Escape') setRound(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [round, showAnswer, affect, next, rate, undo])

  // ---------- 设置界面 ----------
  if (!round) {
    return (
      <div className="review" style={{ minHeight: 'auto' }}>
        <div className="review-top">
          <button className="btn sm ghost" onClick={() => navigate('/')}>← 返回</button>
          <h1 style={{ margin: 0 }}>随机抽卡</h1>
          <span />
        </div>
        <div className="panel stack">
          <div className="field">
            <label>范围</label>
            <select className="select" value={deckId} onChange={(e) => setDeckId(e.target.value)}>
              <option value="">全部卡片</option>
              {decks?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>卡片类型（不选 = 全部）</label>
            <div className="row">
              {TEMPLATES.map((t) => (
                <button key={t.id} className={`chip ${types.includes(t.id) ? 'on' : ''}`}
                  onClick={() => setTypes(types.includes(t.id) ? types.filter((x) => x !== t.id) : [...types, t.id])}>{t.name}</button>
              ))}
            </div>
          </div>
          {allTags.length > 0 && (
            <div className="field">
              <label>标签（不选 = 全部）</label>
              <div className="row">
                {allTags.map((t) => (
                  <button key={t} className={`chip ${tags.includes(t) ? 'on' : ''}`}
                    onClick={() => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t])}>#{t}</button>
                ))}
              </div>
            </div>
          )}
          <div className="field">
            <label>关键词（可选）</label>
            <input className="input" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          </div>
          <div className="row">
            <div className="field grow">
              <label>本轮抽取数量</label>
              <input className="input" type="number" min={1} max={500} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} />
            </div>
            <div className="field grow">
              <label>可用卡片</label>
              <div className="input" style={{ display: 'flex', alignItems: 'center' }}>{pool.length} 张</div>
            </div>
          </div>
          {count > pool.length && pool.length > 0 && (
            <div className="notice warn">符合条件的卡片只有 {pool.length} 张，少于请求的 {count} 张，本轮将只抽取 {pool.length} 张。</div>
          )}
          {pool.length === 0 && <div className="notice warn">当前筛选条件下没有卡片。</div>}
          <label className="row"><input type="checkbox" checked={includeSuspended} onChange={(e) => setIncludeSuspended(e.target.checked)} /> 包含已暂停的卡片</label>
          <label className="row"><input type="checkbox" checked={affect} onChange={(e) => setAffect(e.target.checked)} /> 本轮评分计入正式复习计划</label>
          {affect
            ? <div className="notice warn">已开启：本轮的评分将按正式复习规则更新每张卡的下次复习时间。</div>
            : <div className="muted small">默认不修改正式复习计划，只做练习。</div>}
          <button className="btn primary big block" onClick={start} disabled={pool.length === 0}>开始抽取</button>
        </div>
      </div>
    )
  }

  // ---------- 练习结束 ----------
  if (round.index >= round.ids.length) {
    return (
      <div className="review">
        <div className="panel stack">
          <h1>本轮练习完成</h1>
          <p className="muted">共练习 {round.ids.length} 张卡片。{affect ? '评分已计入复习计划。' : '未修改正式复习计划。'}</p>
          <div className="row">
            <button className="btn primary" onClick={() => setRound(null)}>再来一轮</button>
            <Link className="btn" to="/">返回今日</Link>
            {affect && round.lastLog && <button className="btn" onClick={undo}>撤销最后一次评分</button>}
          </div>
        </div>
      </div>
    )
  }
  if (!card) return null
  const preview = state ? previewIntervals(state, Date.now()) : null

  return (
    <div className="review">
      <div className="review-top">
        <button className="btn sm ghost" onClick={() => setRound(null)}>← 结束</button>
        <span className="muted small">第 {round.index + 1} / {round.ids.length} 张 · {affect ? '计入计划' : '仅练习'}</span>
        {affect ? <button className="btn sm ghost" disabled={!round.lastLog} onClick={undo}>撤销</button> : <span />}
      </div>
      <div className="progress"><div style={{ width: `${(round.index / round.ids.length) * 100}%` }} /></div>
      <CardView card={card} showAnswer={showAnswer} onReveal={() => setShowAnswer(true)} />
      <div className="review-actions">
        {!showAnswer ? (
          <button className="btn primary big block" onClick={() => setShowAnswer(true)}>显示答案 <span className="kbd">空格</span></button>
        ) : affect ? (
          <div className="rating-grid">
            {([1, 2, 3, 4] as Rating[]).map((r) => (
              <button key={r} className={`rating-btn r${r}`} onClick={() => rate(r)}>
                <span className="t">{RATING_LABELS[r]}</span>
                <span className="iv">{preview ? preview[r].label : ''}</span>
                <span className="kbd">{r}</span>
              </button>
            ))}
          </div>
        ) : (
          <button className="btn primary big block" onClick={next}>下一张 <span className="kbd">空格</span></button>
        )}
      </div>
    </div>
  )
}
