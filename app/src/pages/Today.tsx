import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/db'
import { buildQueue, startOfLocalDay } from '../scheduler/scheduler'
import { SyncBadge, useSync } from '../sync/SyncContext'

export default function Today() {
  const data = useLiveQuery(async () => {
    const now = Date.now()
    const [cards, states, logs, settings, session, decks] = await Promise.all([
      db.cards.filter((c) => !c.deleted).toArray(),
      db.states.toArray(),
      db.logs.where('reviewedAt').aboveOrEqual(startOfLocalDay(now) - 86400000).toArray(),
      db.settings.get('settings'),
      db.sessions.get('review'),
      db.decks.filter((d) => !d.deleted).toArray(),
    ])
    const q = buildQueue({
      cards, states: new Map(states.map((s) => [s.cardId, s])), logs,
      settings: { dailyNew: settings?.dailyNew ?? 15, dailyReview: settings?.dailyReview ?? 200 }, now,
    })
    return { q, session, decks, cardCount: cards.length }
  })
  const { notices, clearNotices } = useSync()

  if (!data) return null
  const { q, session, decks } = data
  const canContinue = session && session.queue.length > 0
  const deckName = session?.deckId ? decks.find((d) => d.id === session.deckId)?.name : null

  return (
    <div className="stack">
      <div className="row between">
        <h1>今日</h1>
        <SyncBadge />
      </div>

      {notices.length > 0 && (
        <div className="notice warn">
          {notices.map((n, i) => <div key={i}>{n}</div>)}
          <button className="btn sm" style={{ marginTop: 6 }} onClick={clearNotices}>知道了</button>
        </div>
      )}

      {decks.length === 0 && (
        <div className="notice info">
          还没有牌组。去<Link to="/decks">文件夹</Link>页创建文件夹和牌组，或在<Link to="/settings">设置</Link>中载入示例数据看看效果。
        </div>
      )}

      <div className="panel">
        <div className="stats">
          <div className="stat"><span className="num">{q.dueTotal}</span><span className="lbl">到期待复习</span></div>
          <div className="stat"><span className="num">{q.newSelected}</span><span className="lbl">今日新卡{q.newTotal > q.newSelected ? `（共 ${q.newTotal}）` : ''}</span></div>
          <div className="stat"><span className="num">{q.counts.reviewsDone + q.counts.newIntroduced}</span><span className="lbl">今日已完成</span></div>
        </div>
        {q.dueBeyondLimit > 0 && (
          <p className="muted" style={{ marginTop: 10 }}>
            其中 {q.dueBeyondLimit} 张到期卡超出今日复习目标，本轮不出现；完成后可再次开始复习，或在设置中调整目标。
          </p>
        )}
        <div className="stack" style={{ marginTop: 14 }}>
          {canContinue && (
            <Link className="btn primary big block" to="/review">
              继续复习{deckName ? `「${deckName}」` : ''}（剩余 {session.queue.length} 张）
            </Link>
          )}
          <Link className={`btn ${canContinue ? '' : 'primary'} big block`} to="/review?fresh=1"
            aria-disabled={q.queue.length === 0} onClick={(e) => { if (q.queue.length === 0) e.preventDefault() }}>
            {canContinue ? '重新开始今日复习' : q.queue.length === 0 ? '今天没有待复习的卡片' : `开始复习（${q.queue.length} 张）`}
          </Link>
          <Link className="btn big block" to="/practice">随机抽卡</Link>
        </div>
      </div>

      {decks.length > 0 && (
        <div className="panel">
          <h2>按牌组复习</h2>
          <DeckQuickList />
        </div>
      )}
    </div>
  )
}

function DeckQuickList() {
  const rows = useLiveQuery(async () => {
    const now = Date.now()
    const [cards, states, logs, settings, decks] = await Promise.all([
      db.cards.filter((c) => !c.deleted).toArray(),
      db.states.toArray(),
      db.logs.where('reviewedAt').aboveOrEqual(startOfLocalDay(now) - 86400000).toArray(),
      db.settings.get('settings'),
      db.decks.filter((d) => !d.deleted).toArray(),
    ])
    const sm = new Map(states.map((s) => [s.cardId, s]))
    const st = { dailyNew: settings?.dailyNew ?? 15, dailyReview: settings?.dailyReview ?? 200 }
    return decks.map((d) => ({ deck: d, q: buildQueue({ cards, states: sm, logs, settings: st, now, deckId: d.id }) }))
  })
  if (!rows) return null
  return (
    <div className="list">
      {rows.map(({ deck, q }) => (
        <div key={deck.id} className="list-item row between">
          <div>
            <div>{deck.name} {deck.sample ? <span className="badge">示例</span> : null}</div>
            <div className="muted small">到期 {q.dueTotal} · 新卡 {q.newTotal}</div>
          </div>
          <Link className="btn sm" to={`/review?fresh=1&deck=${deck.id}`}
            aria-disabled={q.queue.length === 0} onClick={(e) => { if (q.queue.length === 0) e.preventDefault() }}>
            {q.queue.length === 0 ? '无待复习' : `复习 ${q.queue.length} 张`}
          </Link>
        </div>
      ))}
    </div>
  )
}
