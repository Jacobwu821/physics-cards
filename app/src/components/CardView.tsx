import type { MouseEvent } from 'react'
import Markdown from './Markdown'
import type { Card } from '../lib/types'
import { templateName } from '../lib/templates'

interface Props {
  card: Card
  showAnswer: boolean
  onReveal: () => void
}

/** 复习/练习通用的卡片视图：只在用户点击卡片或按钮后显示背面 */
export default function CardView({ card, showAnswer, onReveal }: Props) {
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (showAnswer) return
    const t = e.target as HTMLElement
    // 点击公式、图片、链接、按钮时不翻面；选中文字时也不翻面
    if (t.closest('a, img, button, .katex, .katex-display')) return
    const sel = window.getSelection()
    if (sel && sel.toString().length > 0) return
    onReveal()
  }
  const src = card.source
  const hasSource = src.title || src.location || src.link || src.note
  return (
    <div className={`card-face ${showAnswer ? 'answered' : ''}`} onClick={onClick} role="button" tabIndex={0}
      aria-label={showAnswer ? '卡片' : '点击显示答案'}>
      <div className="side-label">正面 · {templateName(card.type)}</div>
      <Markdown source={card.front} />
      {showAnswer && (
        <>
          <div className="divider" />
          <div className="side-label">背面</div>
          <Markdown source={card.back} />
          {hasSource && (
            <div className="source-box">
              {src.title && <div>来源：{src.title}{src.location ? `，${src.location}` : ''}</div>}
              {!src.title && src.location && <div>位置：{src.location}</div>}
              {src.link && <div>链接：<a href={/^https?:\/\//.test(src.link) ? src.link : `https://doi.org/${src.link.replace(/^doi:/i, '')}`} target="_blank" rel="noopener noreferrer">{src.link}</a></div>}
              {src.note && <div>笔记：{src.note}</div>}
            </div>
          )}
        </>
      )}
      {!showAnswer && <div className="muted small" style={{ marginTop: 16 }}>点击卡片或下方按钮显示答案</div>}
    </div>
  )
}
