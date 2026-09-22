import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/db'
import {
  createDeck, createFolder, deckStats, deleteDeck, deleteFolder, moveDeckToFolder,
  renameDeck, renameFolder, type DeleteDeckMode,
} from '../lib/repo'
import { Dialog, PromptDialog, useToast } from '../components/ui'
import type { Deck, Folder } from '../lib/types'

const UNFILED = 'unfiled'

export default function Decks() {
  const [params] = useSearchParams()
  const selected = params.get('folder')
  const folders = useLiveQuery(() => db.folders.filter((f) => !f.deleted).toArray().then((a) => a.sort((x, y) => x.createdAt - y.createdAt)))
  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray().then((a) => a.sort((x, y) => x.createdAt - y.createdAt)))
  const stats = useLiveQuery(() => deckStats())
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [creatingDeck, setCreatingDeck] = useState(false)
  const [renamingFolder, setRenamingFolder] = useState<Folder | null>(null)
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null)
  const [renamingDeck, setRenamingDeck] = useState<Deck | null>(null)
  const [deletingDeck, setDeletingDeck] = useState<Deck | null>(null)
  const [movingDeck, setMovingDeck] = useState<Deck | null>(null)
  const toast = useToast()

  const currentFolder = folders?.find((f) => f.id === selected)
  const inFolder = selected === UNFILED || !!currentFolder
  const folderName = selected === UNFILED ? '未分类' : currentFolder?.name
  const unfiled = (d: Deck) => !d.folderId || !folders?.some((f) => f.id === d.folderId)
  const visibleDecks = decks?.filter((d) => selected === UNFILED ? unfiled(d) : d.folderId === selected)
  const unfiledCount = decks?.filter(unfiled).length ?? 0

  return (
    <div className="stack">
      <div className="row between">
        <h1>{inFolder ? <><Link to="/decks">文件夹</Link> / {folderName}</> : '文件夹'}</h1>
        {inFolder
          ? <button className="btn primary" onClick={() => setCreatingDeck(true)}>新建牌组</button>
          : <button className="btn primary" onClick={() => setCreatingFolder(true)}>新建文件夹</button>}
      </div>

      {!inFolder && (
        <div className="list">
          {folders?.map((folder) => {
            const count = decks?.filter((d) => d.folderId === folder.id).length ?? 0
            return (
              <div key={folder.id} className="list-item">
                <div className="row between">
                  <div><Link to={`/decks?folder=${folder.id}`} style={{ fontWeight: 600 }}>{folder.name}</Link>
                    <div className="muted small">{count} 个牌组</div></div>
                  <div className="row">
                    <Link className="btn sm" to={`/decks?folder=${folder.id}`}>打开</Link>
                    <button className="btn sm ghost" onClick={() => setRenamingFolder(folder)}>重命名</button>
                    <button className="btn sm ghost" style={{ color: 'var(--danger)' }} onClick={() => setDeletingFolder(folder)}>删除</button>
                  </div>
                </div>
              </div>
            )
          })}
          <div className="list-item">
            <div className="row between">
              <div><Link to={`/decks?folder=${UNFILED}`} style={{ fontWeight: 600 }}>未分类</Link>
                <div className="muted small">{unfiledCount} 个牌组{unfiledCount ? ' · 原有牌组保留在这里' : ''}</div></div>
              <Link className="btn sm" to={`/decks?folder=${UNFILED}`}>打开</Link>
            </div>
          </div>
        </div>
      )}

      {inFolder && (
        <>
          {visibleDecks?.length === 0 && <div className="muted">这个文件夹还没有牌组。</div>}
          <div className="list">
            {visibleDecks?.map((d) => {
              const s = stats?.get(d.id) ?? { total: 0, due: 0, fresh: 0, suspended: 0 }
              return (
                <div key={d.id} className="list-item">
                  <div className="row between">
                    <div>
                      <div style={{ fontWeight: 600 }}>{d.name} {d.sample ? <span className="badge">示例数据</span> : null}</div>
                      <div className="muted small">{s.total} 张卡片 · 到期 {s.due} · 新卡 {s.fresh}{s.suspended ? ` · 暂停 ${s.suspended}` : ''}</div>
                    </div>
                    <div className="row">
                      <Link className="btn sm" to={`/library?deck=${d.id}`}>卡片</Link>
                      <Link className="btn sm" to={`/edit/new?deck=${d.id}`}>新卡</Link>
                      <Link className="btn sm primary" to={`/review?fresh=1&deck=${d.id}`}
                        aria-disabled={s.due + s.fresh === 0} onClick={(e) => { if (s.due + s.fresh === 0) e.preventDefault() }}>复习</Link>
                      <button className="btn sm ghost" onClick={() => setMovingDeck(d)}>移动</button>
                      <button className="btn sm ghost" onClick={() => setRenamingDeck(d)}>重命名</button>
                      <button className="btn sm ghost" style={{ color: 'var(--danger)' }} onClick={() => setDeletingDeck(d)}>删除</button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {creatingFolder && <PromptDialog title="新建文件夹" label="名称" onClose={() => setCreatingFolder(false)}
        onSubmit={async (name) => { await createFolder(name); toast('已创建文件夹') }} />}
      {creatingDeck && <PromptDialog title="新建牌组" label="名称" onClose={() => setCreatingDeck(false)}
        onSubmit={async (name) => { await createDeck(name, 0, selected === UNFILED ? null : selected); toast('已创建牌组') }} />}
      {renamingFolder && <PromptDialog title="重命名文件夹" label="名称" initial={renamingFolder.name} onClose={() => setRenamingFolder(null)}
        onSubmit={async (name) => { await renameFolder(renamingFolder.id, name); toast('已重命名') }} />}
      {deletingFolder && <Dialog title={`删除文件夹「${deletingFolder.name}」`} onClose={() => setDeletingFolder(null)}>
        <p>文件夹中的牌组会移到“未分类”；卡片和复习进度不会删除。</p>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn" onClick={() => setDeletingFolder(null)}>取消</button>
          <button className="btn danger" onClick={async () => { await deleteFolder(deletingFolder.id); setDeletingFolder(null); toast('已删除文件夹') }}>删除文件夹</button>
        </div>
      </Dialog>}
      {movingDeck && folders && <MoveDeckDialog deck={movingDeck} folders={folders} onClose={() => setMovingDeck(null)}
        onMove={async (folderId) => { await moveDeckToFolder(movingDeck.id, folderId); toast('已移动牌组') }} />}
      {renamingDeck && <PromptDialog title="重命名牌组" label="名称" initial={renamingDeck.name} onClose={() => setRenamingDeck(null)}
        onSubmit={async (name) => { await renameDeck(renamingDeck.id, name); toast('已重命名') }} />}
      {deletingDeck && decks && <DeleteDeckDialog deck={deletingDeck} others={decks.filter((d) => d.id !== deletingDeck.id)}
        count={stats?.get(deletingDeck.id)?.total ?? 0} onClose={() => setDeletingDeck(null)}
        onConfirm={async (mode) => { await deleteDeck(deletingDeck.id, mode); toast('已删除牌组') }} />}
    </div>
  )
}

function MoveDeckDialog({ deck, folders, onClose, onMove }: {
  deck: Deck; folders: Folder[]; onClose: () => void; onMove: (folderId: string | null) => void
}) {
  const [target, setTarget] = useState(deck.folderId ?? UNFILED)
  return (
    <Dialog title={`移动牌组「${deck.name}」`} onClose={onClose}>
      <div className="field"><label>目标文件夹</label>
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value={UNFILED}>未分类</option>
          {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={target === (deck.folderId ?? UNFILED)}
          onClick={() => { onMove(target === UNFILED ? null : target); onClose() }}>移动</button>
      </div>
    </Dialog>
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
