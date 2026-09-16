// Markdown + LaTeX 渲染：markdown-it 负责段落/列表/加粗等，
// @vscode/markdown-it-katex 负责 $...$ 与 $$...$$，KaTeX 渲染；DOMPurify 清洗输出。
import MarkdownIt from 'markdown-it'
import * as katexPluginMod from '@vscode/markdown-it-katex'
import katex from 'katex'
import DOMPurify from 'dompurify'

// 该包是 CommonJS（exports.default），不同打包器的互操作结果不同，这里做兼容解析
const katexPlugin = (() => {
  const m = katexPluginMod as unknown as { default?: unknown }
  const d = m.default as { default?: unknown } | undefined
  const fn = (d && typeof d === 'object' && typeof d.default === 'function') ? d.default
    : typeof d === 'function' ? d
    : (m as unknown as (...a: unknown[]) => unknown)
  return fn as (md: InstanceType<typeof MarkdownIt>, opts?: Record<string, unknown>) => void
})()

const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const md = new MarkdownIt({ html: true, linkify: true, breaks: true })
// 必须把应用自己的 katex 实例传给插件：插件自带的嵌套 katex 版本与页面加载的 katex CSS 版本不同，
// 类名不一致会导致 \boxed 边框塌陷、行内公式在错误位置断行等排版问题。
md.use(katexPlugin, { throwOnError: false, katex })

// 图片：img://<id> 由界面层异步换成本地 blob URL
const defaultImage = md.renderer.rules.image!
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const tok = tokens[idx]
  const src = String(tok.attrGet('src') ?? '')
  if (src.startsWith('img://')) {
    tok.attrSet('data-img-id', src.slice('img://'.length))
    tok.attrSet('src', TRANSPARENT)
  }
  tok.attrSet('loading', 'lazy')
  return defaultImage(tokens, idx, options, env, self)
}

// 链接：新窗口打开，避免在复习页误跳转
const defaultLinkOpen = md.renderer.rules.link_open || ((t, i, o, _e, s) => s.renderToken(t, i, o))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener noreferrer')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

/**
 * 公式分隔符容错：把 LaTeX 风格的 \( ... \) 与 \[ ... \] 转成 $...$ / $$...$$，
 * 这样从讲义或 Obsidian 以外的来源粘贴的内容也能渲染。\\[2pt]（矩阵行距）不受影响。
 */
export function normalizeMath(src: string): string {
  if (!src) return ''
  return src
    .replace(/(^|[^\\])\\\[([\s\S]+?)\\\]/g, (_m, p: string, f: string) => `${p}$$${f}$$`)
    .replace(/(^|[^\\])\\\(([\s\S]+?)\\\)/g, (_m, p: string, f: string) => `${p}$${f.trim()}$`)
    // 行首 "$$…$$" 后面还有文字时，块级规则会把整行当成公式；把后续文字拆到下一段
    .replace(/^(\$\$[^\n$]*?\$\$)[ \t]*([^\n]*\S[^\n]*)$/gm, (_m, block: string, rest: string) => `${block}\n\n${rest.trim()}`)
}

export function renderMarkdown(src: string): string {
  const html = md.render(normalizeMath(src || ''))
  if (typeof window === 'undefined') return html
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_ATTR: ['target', 'data-img-id', 'loading'],
  })
}

export interface FormulaError {
  formula: string
  display: boolean
  message: string
}

/** 逐个检查公式，返回具体错误信息（不影响渲染，用于编辑器提示） */
export function findFormulaErrors(src: string): FormulaError[] {
  const errors: FormulaError[] = []
  const check = (formula: string, display: boolean) => {
    try {
      katex.renderToString(formula, { throwOnError: true, displayMode: display })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push({ formula, display, message: msg.replace(/^KaTeX parse error:\s*/, '') })
    }
  }
  let rest = src || ''
  // 独立公式
  rest = rest.replace(/\$\$([\s\S]+?)\$\$/g, (_m, f: string) => {
    check(f.trim(), true)
    return ' '
  })
  // 行内公式（不跨行，排除 \$ 转义）
  rest.replace(/(^|[^\\$])\$([^$\n]+?)\$(?!\d)/g, (_m, _p: string, f: string) => {
    if (f.trim()) check(f.trim(), false)
    return ' '
  })
  return errors
}

/** 是否为未闭合的公式分隔符（提示用户） */
export function hasUnbalancedDollars(src: string): boolean {
  const s = (src || '').replace(/\\\$/g, '')
  const dd = (s.match(/\$\$/g) || []).length
  if (dd % 2 !== 0) return true
  const single = (s.replace(/\$\$/g, '').match(/\$/g) || []).length
  return single % 2 !== 0
}
