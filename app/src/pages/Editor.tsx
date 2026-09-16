import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/db'
import {
  createCard, deleteDraft, loadDraft, saveDraft, saveImage, shrinkImage, updateCard, normalizeTags,
} from '../lib/repo'
import { TEMPLATES, TEMPLATE_MAP } from '../lib/templates'
import { findFormulaErrors, hasUnbalancedDollars } from '../lib/markdown'
import Markdown from '../components/Markdown'
import { fmtTime, useToast } from '../components/ui'
import { SyncBadge } from '../sync/SyncContext'
import type { CardSource, CardTypeId } from '../lib/types'

type SaveState = { kind: 'idle' } | { kind: 'draft'; at: number } | { kind: 'saving' } | { kind: 'saved'; at: number } | { kind: 'error'; msg: string }

export default function Editor() {
  const { id } = useParams()
  const cardId = id && id !== 'new' ? id : null
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const decks = useLiveQuery(() => db.decks.filter((d) => !d.deleted).toArray())
  const allTags = useLiveQuery(async () => {
    const set = new Set<string>()
    for (const c of await db.cards.filter((c) => !c.deleted).toArray()) for (const t of c.tags) set.add(t)
    return [...set].sort()
  }, [], [] as string[])

  const [loaded, setLoaded] = useState(false)
  const [deckId, setDeckId] = useState(params.get('deck') || '')
  const [type, setType] = useState<CardTypeId>('concept')
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [source, setSource] = useState<CardSource>({})
  const [showSource, setShowSource] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  const [draftRestored, setDraftRestored] = useState(false)
  const [baseline, setBaseline] = useState('')   // 用于判断是否有改动
  const draftKey = cardId ? `card:${cardId}` : 'new'

  // 载入卡片或草稿
  useEffect(() => {
    let alive = true
    ;(async () => {
      const card = cardId ? await db.cards.get(cardId) : undefined
      const draft = await loadDraft(draftKey)
      if (!alive) return
      if (card) {
        setDeckId(card.deckId); setType(card.type); setFront(card.front); setBack(card.back)
        setTags(card.tags); setSource(card.source); setShowSource(Object.keys(card.source).length > 0)
        setBaseline(JSON.stringify([card.deckId, card.type, card.front, card.back, card.tags, card.source]))
      }
      if (draft && (!card || draft.updatedAt > card.updatedAt)) {
        setDeckId(draft.deckId || params.get('deck') || ''); setType(draft.type); setFront(draft.front); setBack(draft.back)
        setTags(draft.tags); setSource(draft.source); setShowSource(Object.keys(draft.source).length > 0)
        setDraftRestored(true)
        setSaveState({ kind: 'draft', at: draft.updatedAt })
      }
      setLoaded(true)
    })()
    return () => { alive = false }
  }, [cardId, draftKey])

  // 默认牌组
  useEffect(() => {
    if (loaded && !deckId && decks && decks.length) setDeckId(decks[0].id)
  }, [loaded, decks, deckId])

  // 自动保存草稿（去抖）
  const current = JSON.stringify([deckId, type, front, back, tags, source])
  const dirty = loaded && current !== baseline && (front.trim() || back.trim())
  useEffect(() => {
    if (!loaded || !dirty) return
    const t = window.setTimeout(async () => {
      await saveDraft({ key: draftKey, cardId, deckId, type, front, back, tags, source })
      setSaveState({ kind: 'draft', at: Date.now() })
    }, 600)
    return () => window.clearTimeout(t)
  }, [current, loaded, dirty, draftKey, cardId])

  const commitTag = () => {
    const parts = tagInput.split(/[,，\n]/)
    const next = normalizeTags([...tags, ...parts])
    setTags(next); setTagInput('')
  }

  const save = useCallback(async (andNew = false) => {
    if (!deckId) { toast('请先选择牌组'); return }
    if (!front.trim() && !back.trim()) { toast('正面或背面至少填写一项'); return }
    setSaveState({ kind: 'saving' })
    try {
      const finalTags = normalizeTags([...tags, ...tagInput.split(/[,，\n]/)])
      if (cardId) await updateCard(cardId, { deckId, type, front, back, tags: finalTags, source })
      else await createCard({ deckId, type, front, back, tags: finalTags, source })
      await deleteDraft(draftKey)
      setSaveState({ kind: 'saved', at: Date.now() })
      setBaseline(JSON.stringify([deckId, type, front, back, finalTags, source]))
      toast('已保存')
      if (andNew) {
        setFront(''); setBack(''); setSource({}); setTagInput(''); setDraftRestored(false)
        setBaseline(JSON.stringify([deckId, type, '', '', tags, {}]))
      } else {
        if (cardId) navigate(-1)
        else navigate(`/library?deck=${deckId}`)
      }
    } catch (e) {
      setSaveState({ kind: 'error', msg: e instanceof Error ? e.message : String(e) })
    }
  }, [deckId, type, front, back, tags, tagInput, source, cardId, draftKey, navigate, toast])

  // Ctrl/Cmd+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  if (!loaded) return null
  const tpl = TEMPLATE_MAP[type]

  return (
    <div className="stack">
      <div className="row between">
        <h1>{cardId ? '编辑卡片' : '新建卡片'}</h1>
        <div className="row">
          <SaveStatus s={saveState} />
          <SyncBadge />
        </div>
      </div>

      {draftRestored && (
        <div className="notice info row between">
          <span>已恢复未保存的草稿。</span>
          <button className="btn sm" onClick={async () => {
            await deleteDraft(draftKey); setDraftRestored(false)
            const card = cardId ? await db.cards.get(cardId) : undefined
            if (card) { setDeckId(card.deckId); setType(card.type); setFront(card.front); setBack(card.back); setTags(card.tags); setSource(card.source) }
            else { setFront(''); setBack(''); setTags([]); setSource({}) }
            setSaveState({ kind: 'idle' })
          }}>放弃草稿</button>
        </div>
      )}

      <div className="row">
        <div className="field grow">
          <label>牌组</label>
          <select className="select" value={deckId} onChange={(e) => setDeckId(e.target.value)}>
            {!decks?.length && <option value="">（请先创建牌组）</option>}
            {decks?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="field grow">
          <label>卡片类型</label>
          <select className="select" value={type} onChange={(e) => setType(e.target.value as CardTypeId)}>
            {TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      </div>

      <div className="editor-grid">
        <SideEditor label="正面" value={front} onChange={setFront} hint={tpl.frontHint} />
        <SideEditor label="背面" value={back} onChange={setBack} hint={tpl.backHint} />
      </div>

      <div className="panel stack">
        <div className="field">
          <label>标签（回车或逗号分隔；与牌组、类型相互独立）</label>
          <div className="row">
            {tags.map((t) => (
              <span key={t} className="chip on" onClick={() => setTags(tags.filter((x) => x !== t))}>#{t} ×</span>
            ))}
            <input className="input" style={{ flex: 1, minWidth: 140 }} list="tag-suggest" value={tagInput}
              placeholder="添加标签" onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitTag() } }}
              onBlur={commitTag} />
            <datalist id="tag-suggest">{allTags.map((t) => <option key={t} value={t} />)}</datalist>
          </div>
        </div>

        <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setShowSource(!showSource)}>
          {showSource ? '收起来源信息' : '添加来源信息（可选）'}
        </button>
        {showSource && (
          <div className="stack">
            <div className="row">
              <div className="field grow"><label>书名 / 论文标题</label>
                <input className="input" value={source.title ?? ''} onChange={(e) => setSource({ ...source, title: e.target.value })} /></div>
              <div className="field grow"><label>页码 / 章节</label>
                <input className="input" value={source.location ?? ''} onChange={(e) => setSource({ ...source, location: e.target.value })} /></div>
            </div>
            <div className="field"><label>链接 / DOI</label>
              <input className="input" value={source.link ?? ''} onChange={(e) => setSource({ ...source, link: e.target.value })} placeholder="https://… 或 10.1103/…" /></div>
            <div className="field"><label>补充笔记</label>
              <textarea className="textarea" style={{ minHeight: 70, fontFamily: 'var(--font)' }} value={source.note ?? ''} onChange={(e) => setSource({ ...source, note: e.target.value })} /></div>
          </div>
        )}
      </div>

      <div className="editor-actions">
        <button className="btn" onClick={() => navigate(-1)}>返回</button>
        <div className="grow" />
        {!cardId && <button className="btn" onClick={() => save(true)}>保存并再建一张</button>}
        <button className="btn primary" onClick={() => save(false)} disabled={saveState.kind === 'saving'}>保存</button>
      </div>
      <p className="muted small">提示：长推导建议拆成多张卡片，每张只考查一个关键问题。桌面端可用 Ctrl/⌘+S 保存。</p>
    </div>
  )
}

function SaveStatus({ s }: { s: SaveState }) {
  switch (s.kind) {
    case 'idle': return <span className="save-status">未修改</span>
    case 'draft': return <span className="save-status">草稿已自动保存 {fmtTime(s.at)}</span>
    case 'saving': return <span className="save-status">保存中…</span>
    case 'saved': return <span className="save-status" style={{ color: 'var(--ok)' }}>已保存 {fmtTime(s.at)}</span>
    case 'error': return <span className="save-status" style={{ color: 'var(--danger)' }}>保存失败：{s.msg}</span>
  }
}

function SideEditor({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint: string }) {
  const ta = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const toast = useToast()
  const errors = useMemo(() => findFormulaErrors(value), [value])
  const unbalanced = useMemo(() => hasUnbalancedDollars(value), [value])

  /** 在光标处插入/包裹文本 */
  const wrap = (before: string, after: string, placeholder = '') => {
    const el = ta.current
    if (!el) { onChange(value + before + placeholder + after); return }
    // 文本框未聚焦（例如刚点完“图片”按钮选文件）时插到末尾，而不是开头
    const focused = document.activeElement === el
    const s = focused ? el.selectionStart : value.length
    const e = focused ? el.selectionEnd : value.length
    const sel = value.slice(s, e) || placeholder
    const next = value.slice(0, s) + before + sel + after + value.slice(e)
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      const start = s + before.length
      el.setSelectionRange(start, start + sel.length)
    })
  }
  const linePrefix = (prefix: string) => {
    const el = ta.current
    const s = el ? el.selectionStart : value.length
    const lineStart = value.lastIndexOf('\n', s - 1) + 1
    const next = value.slice(0, lineStart) + prefix + value.slice(lineStart)
    onChange(next)
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(s + prefix.length, s + prefix.length) })
  }
  const insertImage = async (f: File | undefined) => {
    if (!f) return
    try {
      const blob = await shrinkImage(f)
      const rec = await saveImage(blob)
      wrap('', '', `\n![图片](img://${rec.id})\n`)
    } catch (e) {
      toast('图片插入失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  return (
    <div className="panel stack">
      <div className="row between">
        <h2 style={{ margin: 0 }}>{label}</h2>
        <span className="muted small">{value.length} 字</span>
      </div>
      <div className="toolbar">
        <button className="btn" title="加粗" onClick={() => wrap('**', '**', '加粗')}><b>B</b></button>
        <button className="btn" title="斜体" onClick={() => wrap('*', '*', '斜体')}><i>I</i></button>
        <button className="btn" title="下划线" onClick={() => wrap('<u>', '</u>', '下划线')}><u>U</u></button>
        <button className="btn" title="无序列表" onClick={() => linePrefix('- ')}>• 列表</button>
        <button className="btn" title="有序列表" onClick={() => linePrefix('1. ')}>1. 列表</button>
        <button className="btn" title="行内公式" onClick={() => wrap('$', '$', '\\hbar\\omega')}>$x$</button>
        <button className="btn" title="独立公式" onClick={() => wrap('\n$$\n', '\n$$\n', 'H = \\hbar\\omega a^\\dagger a')}>$$…$$</button>
        <button className="btn" title="插入图片" onClick={() => fileRef.current?.click()}>图片</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void insertImage(e.target.files?.[0]); e.target.value = '' }} />
      </div>
      <textarea ref={ta} className="textarea" value={value} placeholder={hint} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      {unbalanced && <div className="formula-errors">公式分隔符 $ 似乎未成对，请检查。</div>}
      {errors.length > 0 && (
        <div className="formula-errors">
          {errors.map((er, i) => <div key={i}>公式错误：<code>{er.formula.length > 40 ? er.formula.slice(0, 40) + '…' : er.formula}</code> — {er.message}</div>)}
        </div>
      )}
      <div className="field">
        <label>预览</label>
        <Markdown className="md-preview" source={value} emptyText={hint} />
      </div>
    </div>
  )
}
