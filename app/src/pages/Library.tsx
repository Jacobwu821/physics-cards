import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/db'
import { deleteCard, duplicateCard, moveCards, updateCard } from '../lib/repo'
import { filterCards, type CardFilter } from '../practice/random'
import { TEMPLATES, templateName } from '../lib/templates'
import { STATE_LABELS, humanDue } from '../scheduler/scheduler'
import Markdown from '../components/Markdown'
import { ConfirmDialog, Dialog, useToast } from '../components/ui'
import type { Card, CardTypeId } from '../lib/types'

export default function Library() {
  const [params, setParams] = useSearchParams()
  const deckId = params.get('deck') || ''
  const [keyword, setKeyword] = useState(params.get('q') || '')
  const [type, setType] = useState<string>('')
  const [tags, setTags] = useState<string[]>([])
  const [fav, setFav] = useState(false)
  const [susp, setSusp] = useState<'exclude' | 'include' | 'only'>('include')
  const [moving, setMoving] = useState<Card | null>(null)
  const [deleting, setDeleting] = useState<Card | null>(null)
  const toast = useToast()

  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray())
  const cards = useLiveQuery(() => db.cards.filter((c) => !c.deleted).toArray())
  const states = useLiveQuery(() => db.states.toArray())
  const stateMap = useMemo(() => new Map((states ?? []).map((s) => [s.cardId, s])), [states])
  const deckMap = useMemo(() => new Map((decks ?? []).map((d) => [d.id, d])), [decks])
  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const c of cards ?? []) for (const t of c.tags) set.add(t)
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
  }, [cards])

  const filter: CardFilter = {
    deckId: deckId || null, types: type ? [type as CardTypeId] : undefined, tags, keyword,
    favoriteOnly: fav, includeSuspended: susp === 'include', suspendedOnly: susp === 'only',
  }
  const list = useMemo(() => filterCards(cards ?? [], filter).sort((a, b) => b.updatedAt - a.updatedAt),
    [cards, deckId, type, tags, keyword, fav, susp])
  const now = Date.now()

  return (
    <div className="stack">
      <div className="row between">
        <h1>卡片库</h1>
        <Link className="btn primary" to={`/edit/new${deckId ? `?deck=${deckId}` : ''}`}>新建卡片</Link>
      </div>

      <div className="panel filters">
        <input className="input" placeholder="搜索正面、背面、来源、标签…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        <div className="row">
          <select className="select" value={deckId} onChange={(e) => { const p = new URLSearchParams(params); if (e.target.value) p.set('deck', e.target.value); else p.delete('deck'); setParams(p) }}>
            <option value="">全部牌组</option>
            {decks?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">全部类型</option>
            {TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select className="select" value={susp} onChange={(e) => setSusp(e.target.value as typeof susp)}>
            <option value="include">包含暂停卡</option>
            <option value="exclude">排除暂停卡</option>
            <option value="only">仅暂停卡</option>
          </select>
        </div>
        <div className="row">
          <button className={`chip ${fav ? 'on' : ''}`} style={{ flex: '0 0 auto' }} onClick={() => setFav(!fav)}>★ 仅收藏</button>
          {allTags.map((t) => (
            <button key={t} className={`chip ${tags.includes(t) ? 'on' : ''}`} style={{ flex: '0 0 auto' }}
              onClick={() => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t])}>{t}</button>
          ))}
        </div>
      </div>

      <div className="muted small">{list.length} 张卡片</div>
      <div className="list">
        {list.map((c) => {
          const s = stateMap.get(c.id)
          return (
            <div key={c.id} className="list-item card-row">
              <div className="body">
                <Link to={`/edit/${c.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                  <Markdown className="snippet" source={c.front} />
                </Link>
                <div className="meta">
                  <span className="badge accent">{templateName(c.type)}</span>
                  <span className="badge">{deckMap.get(c.deckId)?.name ?? '未知牌组'}</span>
                  {c.tags.map((t) => <span key={t} className="badge">#{t}</span>)}
                  {c.favorite ? <span className="badge warn">★ 收藏</span> : null}
                  {c.suspended ? <span className="badge danger">已暂停</span> : null}
                  {c.sample ? <span className="badge">示例</span> : null}
                  <span className="muted small">
                    {s ? `${STATE_LABELS[s.state]}${s.state !== 0 ? ` · ${humanDue(s.due, now)}` : ''}` : '新卡'}
                  </span>
                </div>
                <div className="actions">
                  <Link className="btn sm" to={`/edit/${c.id}`}>编辑</Link>
                  <button className="btn sm" onClick={() => updateCard(c.id, { favorite: c.favorite ? 0 : 1 })}>{c.favorite ? '取消收藏' : '收藏'}</button>
                  <button className="btn sm" onClick={() => updateCard(c.id, { suspended: c.suspended ? 0 : 1 })}>{c.suspended ? '恢复复习' : '暂停复习'}</button>
                  <button className="btn sm" onClick={async () => { await duplicateCard(c.id); toast('已复制为新卡片') }}>复制</button>
                  <button className="btn sm" onClick={() => setMoving(c)}>移动</button>
                  <button className="btn sm" style={{ color: 'var(--danger)' }} onClick={() => setDeleting(c)}>删除</button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {moving && decks && (
        <MoveDialog card={moving} decks={decks} onClose={() => setMoving(null)}
          onMove={async (id) => { await moveCards([moving.id], id); toast('已移动') }} />
      )}
      {deleting && (
        <ConfirmDialog title="删除卡片" danger confirmText="删除" onClose={() => setDeleting(null)}
          message="确定删除这张卡片？其复习记录会一并停用。" onConfirm={async () => { await deleteCard(deleting.id); toast('已删除') }} />
      )}
    </div>
  )
}

function MoveDialog({ card, decks, onClose, onMove }: { card: Card; decks: { id: string; name: string }[]; onClose: () => void; onMove: (deckId: string) => void }) {
  const [target, setTarget] = useState(card.deckId)
  return (
    <Dialog title="移动到牌组" onClose={onClose}>
      <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
        {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={target === card.deckId} onClick={() => { onMove(target); onClose() }}>移动</button>
      </div>
    </Dialog>
  )
}
