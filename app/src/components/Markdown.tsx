import { useEffect, useMemo, useRef } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { imageUrl } from '../lib/repo'

interface Props {
  source: string
  className?: string
  emptyText?: string
}

/** 渲染 Markdown + LaTeX，并把 img://id 替换为本地图片 */
export default function Markdown({ source, className = '', emptyText }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => renderMarkdown(source), [source])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    let cancelled = false
    const imgs = root.querySelectorAll<HTMLImageElement>('img[data-img-id]')
    imgs.forEach(async (img) => {
      const id = img.dataset.imgId!
      const url = await imageUrl(id)
      if (cancelled) return
      if (url) img.src = url
      else img.alt = img.alt || '（图片未找到：可能尚未同步到本设备）'
    })
    return () => { cancelled = true }
  }, [html])

  if (!source.trim() && emptyText) {
    return <div className={`md-preview empty ${className}`}>{emptyText}</div>
  }
  return <div ref={ref} className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
}
