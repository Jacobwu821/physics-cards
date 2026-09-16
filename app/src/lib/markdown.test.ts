import { describe, it, expect } from 'vitest'
import { findFormulaErrors, hasUnbalancedDollars, normalizeMath, renderMarkdown } from './markdown'

const rendered = (html: string) => /class="katex/.test(html)
const hasError = (html: string) => /katex-error/.test(html)

describe('公式渲染（用户看到的是排版后的公式而不是源码）', () => {
  const ok: Array<[string, string]> = [
    ['行内基本', '能量 $E=\\hbar\\omega$。'],
    ['分隔符内有空格', '能量 $ E = \\hbar\\omega $ 。'],
    ['下标与星号不被 Markdown 吃掉', '$a_1 b_2 c_* d_*$'],
    ['中文紧贴公式', '其中$\\Omega$为拉比频率，$g\\ll\\kappa$时'],
    ['独立公式单行', '$$\\langle n|m\\rangle = \\delta_{nm}$$'],
    ['独立公式多行 aligned', '$$\n\\begin{aligned}\nH &= \\hbar\\omega a^\\dagger a \\\\\n&+ \\hbar g\\sigma_x\n\\end{aligned}\n$$'],
    ['矩阵', '$$\\sigma_z=\\begin{pmatrix}1&0\\\\0&-1\\end{pmatrix}$$'],
    ['cases', '$$f(x)=\\begin{cases}1 & x>0\\\\0 & x\\le 0\\end{cases}$$'],
    ['狄拉克符号', '$\\bra{\\psi}\\ket{\\phi}$ 与 $\\braket{\\psi|\\phi}$'],
    ['boxed 与分数', '$$\\boxed{F_P=\\frac{3}{4\\pi^2}\\left(\\frac{\\lambda}{n}\\right)^3\\frac{Q}{V}}$$'],
    ['text 含中文', '$\\text{质量}\\ m = 1\\,\\mathrm{kg}$'],
    ['列表项中的公式', '- 条件：$g\\ll\\omega_a$\n- 结论：$$\\Delta E = 2\\hbar g$$'],
    ['加粗中的公式', '**关键：$\\kappa < g$**'],
    ['LaTeX 风格括号分隔符', '\\(x^2+y^2\\) 与 \\[\\int_0^\\infty e^{-x}\\,dx = 1\\]'],
    ['向量与帽子', '$\\vec{E}\\cdot\\hat{n}$，$\\boldsymbol{\\sigma}$'],
    ['行首独立公式后接文字与行内公式', '$$E=mc^2$$ 是质能方程，其中 $c$ 为光速'],
    ['列表项内的独立公式', '- Purcell 因子 $$\\boxed{F_P=1}$$'],
    ['算符与单位', '$\\operatorname{Tr}\\rho = 1$，$\\nu_\\mathrm{FSR}=c/2L$'],
  ]
  for (const [name, src] of ok) {
    it(`渲染成功：${name}`, () => {
      const html = renderMarkdown(src)
      expect(rendered(html), html).toBe(true)
      expect(hasError(html), html).toBe(false)
      expect(findFormulaErrors(src)).toEqual([])
    })
  }

  it('矩阵行距 \\\\[2pt] 不会被当成分隔符', () => {
    const src = '$$\\begin{pmatrix}1\\\\[2pt]0\\end{pmatrix}$$'
    expect(normalizeMath(src)).toBe(src)
    expect(hasError(renderMarkdown(src))).toBe(false)
  })

  it('价格式的美元符号不被当成公式', () => {
    const html = renderMarkdown('价格 $5 和 $6')
    expect(rendered(html)).toBe(false)
    expect(html).toContain('$5')
  })

  it('错误公式给出具体原因且仍渲染其余内容', () => {
    const src = '正确 $a^2$，错误 $\\frac{a}{$ 与 $\\foo$'
    const errs = findFormulaErrors(src)
    expect(errs.length).toBe(2)
    expect(errs[0].message).toMatch(/expected '}'/)
    expect(errs[1].message).toMatch(/Undefined control sequence/)
    const html = renderMarkdown(src)
    expect(rendered(html)).toBe(true)
  })

  it('未闭合分隔符提示', () => {
    expect(hasUnbalancedDollars('$a$ $b')).toBe(true)
    expect(hasUnbalancedDollars('$$a$$ $b$')).toBe(false)
    expect(hasUnbalancedDollars('\\$5')).toBe(false)
  })

  it('渲染输出的 KaTeX 类名与加载的 KaTeX CSS 属于同一版本（防止插件自带旧版 katex）', async () => {
    const fs = await import('node:fs')
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    const css = fs.readFileSync(req.resolve('katex/dist/katex.min.css'), 'utf8')
    const html = renderMarkdown('$$\\boxed{\\frac{a_1}{b}} \\quad \\sqrt{x}$$ 与 $\\hat H\\ket{n}$')
    const classes = new Set<string>()
    for (const m of html.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) if (c) classes.add(c)
    // 这些结构类名决定排版（不换行、盒子边框、堆叠），CSS 与 JS 必须使用同一套命名
    for (const [oldName, newName] of [['base', 'katex-base'], ['stretchy', 'katex-stretchy'], ['strut', 'katex-strut']]) {
      const cssNew = css.includes('.' + newName)
      const used = classes.has(newName) ? newName : classes.has(oldName) ? oldName : null
      expect(used, `输出中没有 ${oldName}/${newName}`).not.toBeNull()
      expect(used, `输出用 ${used}，但 CSS 定义的是 ${cssNew ? newName : oldName}`).toBe(cssNew ? newName : oldName)
    }
    expect(html).not.toContain('katex-error')
  })

  it('加粗、斜体、下划线、列表与图片占位', () => {
    const html = renderMarkdown('**粗** *斜* <u>下</u>\n\n- 一\n- 二\n\n![图](img://abc)')
    expect(html).toContain('<strong>粗</strong>')
    expect(html).toContain('<em>斜</em>')
    expect(html).toContain('<u>下</u>')
    expect(html).toContain('<li>一</li>')
    expect(html).toContain('data-img-id="abc"')
  })
})
