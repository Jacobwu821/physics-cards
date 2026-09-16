import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/db'
import { createDeck, deckStats, deleteDeck, renameDeck, type DeleteDeckMode } from '../lib/repo'
import { Dialog, PromptDialog, useToast } from '../components/ui'
import type { Deck } from '../lib/types'

export default function Decks() {
  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray().then((a) => a.sort((x, y) => x.createdAt - y.createdAt)))
  const stats = useLiveQuery(() => deckStats())
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<Deck | null>(null)
  const [deleting, setDeleting] = useState<Deck | null>(null)
  const toast = useToast()

  return (
    <div className="stack">
      <div className="row between">
        <h1>牌组</h1>
        <button className="btn primary" onClick={() => setCreating(true)}>新建牌组</button>
      </div>
      {decks && decks.length === 0 && <div className="muted">还没有牌组。</div>}
      <div className="list">
        {decks?.map((d) => {
          const s = stats?.get(d.id) ?? { total: 0, due: 0, fresh: 0, suspended: 0 }
          return (
            <div key={d.id} className="list-item">
              <div className="row between">
                <div>
                  <div style={{ fontWeight: 600 }}>{d.name} {d.sample ? <span className="badge">示例数据</span> : null}</div>
                  <div className="muted small">
                    {s.total} 张卡片 · 到期 {s.due} · 新卡 {s.fresh}{s.suspended ? ` · 暂停 ${s.suspended}` : ''}
                  </div>
                </div>
                <div className="row">
                  <Link className="btn sm" to={`/library?deck=${d.id}`}>卡片</Link>
                  <Link className="btn sm" to={`/edit/new?deck=${d.id}`}>新卡</Link>
                  <Link className="btn sm primary" to={`/review?fresh=1&deck=${d.id}`}
                    aria-disabled={s.due + s.fresh === 0} onClick={(e) => { if (s.due + s.fresh === 0) e.preventDefault() }}>复习</Link>
                  <button className="btn sm ghost" onClick={() => setRenaming(d)}>重命名</button>
                  <button className="btn sm ghost" style={{ color: 'var(--danger)' }} onClick={() => setDeleting(d)}>删除</button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {creating && (
        <PromptDialog title="新建牌组" label="名称" onClose={() => setCreating(false)}
          onSubmit={async (name) => { await createDeck(name); toast('已创建牌组') }} />
      )}
      {renaming && (
        <PromptDialog title="重命名牌组" label="名称" initial={renaming.name} onClose={() => setRenaming(null)}
          onSubmit={async (name) => { await renameDeck(renaming.id, name); toast('已重命名') }} />
      )}
      {deleting && decks && (
        <DeleteDeckDialog deck={deleting} others={decks.filter((d) => d.id !== deleting.id)}
          count={stats?.get(deleting.id)?.total ?? 0} onClose={() => setDeleting(null)}
          onConfirm={async (mode) => { await deleteDeck(deleting.id, mode); toast('已删除牌组') }} />
      )}
    </div>
  )
}

function DeleteDeckDialog({ deck, others, count, onClose, onConfirm }: {
  deck: Deck; others: Deck[]; count: number; onClose: () => void; onConfirm: (mode: DeleteDeckMode) => void
}) {
  const [mode, setMode] = useState<'deleteCards' | 'moveTo'>(count > 0 && others.length > 0 ? 'moveTo' : 'deleteCards')
  const [target, setTarget] = useState(others[0]?.id ?? '')
  const [typed, setTyped] = useState('')
  const needConfirm = mode === 'deleteCards' && count > 0
  return (
    <Dialog title={`删除牌组「${deck.name}」`} onClose={onClose}>
      {count === 0 ? (
        <p>这个牌组没有卡片，可以直接删除。</p>
      ) : (
        <div className="stack">
          <p>牌组中有 <b>{count}</b> 张卡片。请选择如何处理：</p>
          {others.length > 0 && (
            <label className="row">
              <input type="radio" checked={mode === 'moveTo'} onChange={() => setMode('moveTo')} />
              <span>保留卡片，移动到：</span>
              <select className="select" style={{ width: 'auto', flex: 1 }} value={target} onChange={(e) => setTarget(e.target.value)} disabled={mode !== 'moveTo'}>
                {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
          )}
          <label className="row">
            <input type="radio" checked={mode === 'deleteCards'} onChange={() => setMode('deleteCards')} />
            <span style={{ color: 'var(--danger)' }}>同时删除这 {count} 张卡片及其复习进度</span>
          </label>
          {needConfirm && (
            <div className="field">
              <label>为避免误操作，请输入牌组名称确认：</label>
              <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={deck.name} />
            </div>
          )}
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn danger" disabled={needConfirm && typed.trim() !== deck.name}
          onClick={() => { onConfirm(mode === 'moveTo' ? { mode: 'moveTo', deckId: target } : { mode: 'deleteCards' }); onClose() }}>
          {mode === 'moveTo' && count > 0 ? '移动卡片并删除牌组' : '删除'}
        </button>
      </div>
    </Dialog>
  )
}
