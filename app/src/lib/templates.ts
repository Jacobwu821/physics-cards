import type { CardTypeId } from './types'

export interface CardTemplate {
  id: CardTypeId
  name: string
  frontHint: string
  backHint: string
}

export const TEMPLATES: CardTemplate[] = [
  { id: 'concept', name: '名词概念卡', frontHint: '这个概念是什么？', backHint: '定义、物理直觉、例子' },
  { id: 'formula', name: '公式卡', frontHint: '某个关系如何表达？', backHint: '公式、符号含义、单位、适用条件' },
  { id: 'magnitude', name: '数量级卡', frontHint: '某个量大约有多大？', backHint: '数值范围、单位、条件、估算方法' },
  { id: 'method', name: '方法卡', frontHint: '遇到这类问题如何处理？', backHint: '适用场景、关键步骤、检查方法' },
  { id: 'paper', name: '论文创新点卡', frontHint: '这篇论文解决了什么问题？', backHint: '既有局限、核心创新、证据、限制' },
  { id: 'logic', name: '物理逻辑卡', frontHint: '为什么会出现这个结果？', backHint: '前提、关键推理、结论' },
  { id: 'condition', name: '条件与边界卡', frontHint: '这个结论什么时候成立？', backHint: '假设、近似条件、失效情形' },
  { id: 'compare', name: '对比辨析卡', frontHint: '这两个概念有什么区别？', backHint: '共同点、差异、判断依据' },
  { id: 'figure', name: '图像理解卡', frontHint: '这张图说明什么？', backHint: '坐标、趋势、物理机制' },
  { id: 'pitfall', name: '易错与反例卡', frontHint: '这个说法或推导错在哪里？', backHint: '错因、正确解释、反例' },
]

export const TEMPLATE_MAP: Record<CardTypeId, CardTemplate> = Object.fromEntries(
  TEMPLATES.map((t) => [t.id, t]),
) as Record<CardTypeId, CardTemplate>

export function templateName(id: string): string {
  return TEMPLATE_MAP[id as CardTypeId]?.name ?? id
}
