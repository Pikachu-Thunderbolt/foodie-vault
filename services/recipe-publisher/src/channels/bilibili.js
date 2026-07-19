'use strict'

const BVID_REGEX = /^BV[0-9A-Za-z]+$/
const POSITIVE = ['教程', '做法', '菜谱', '配方', '步骤', '做饭', '烹饪', '家常菜', 'recipe', 'how to cook']
const NEGATIVE = ['吃播', '试吃', '测评', '开箱', '搞笑', '段子', 'vlog', '探店', '踩雷', '整活', 'reaction', '直播回放', '搬运']
const COOKING_CATEGORIES = ['美食', '美食制作', '生活']

function parseSourceId(input) {
  const trimmed = String(input || '').trim()
  if (BVID_REGEX.test(trimmed)) return trimmed
  const match = trimmed.match(/(BV[0-9A-Za-z]+)/)
  if (match) return match[1]
  throw new Error(`无法从 "${trimmed}" 解析出 B站 BV 号`)
}

function buildSourceUrl(sourceId) {
  return `https://www.bilibili.com/video/${sourceId}`
}

function evaluateCookingTutorial(sourceMeta = {}) {
  const title = String(sourceMeta.title || '').trim()
  const description = String(sourceMeta.description || sourceMeta.desc || '').trim()
  const tags = Array.isArray(sourceMeta.tags) ? sourceMeta.tags.join(' ') : String(sourceMeta.tags || '')
  const category = String(sourceMeta.category || sourceMeta.tname || '')
  const duration = Number(sourceMeta.durationSeconds || sourceMeta.duration || 0)
  const text = `${title} ${description} ${tags}`.toLowerCase()
  const reasons = []

  if (!title) return { verdict: 'METADATA_INCOMPLETE', score: 0, reasons: ['缺少视频标题'] }
  if (NEGATIVE.some(w => text.includes(w))) return { verdict: 'REJECTED', score: 0, reasons: ['命中非教程内容排除词'] }
  if (duration && (duration < 45 || duration > 3600)) return { verdict: 'REJECTED', score: 0, reasons: ['时长不在45秒至60分钟范围'] }

  let score = 0
  if (POSITIVE.some(w => text.includes(w))) { score += 55; reasons.push('标题/描述/标签含做菜教程信号') }
  if (COOKING_CATEGORIES.some(w => category.includes(w))) { score += 20; reasons.push('B站分区为美食相关') }
  if (duration >= 60 && duration <= 1800) { score += 15; reasons.push('时长适合步骤型教程') }
  if (/(食材|下锅|翻炒|切|腌|炖|蒸|烤|出锅)/.test(text)) { score += 15; reasons.push('存在烹饪动作或食材信号') }

  if (score >= 60) return { verdict: 'PASSED', score, reasons }
  return { verdict: 'MANUAL_REVIEW_REQUIRED', score, reasons: [...reasons, '元数据不足以确认是正常做饭教程'] }
}

module.exports = {
  channelType: 'bilibili',
  label: 'B站',

  parseSourceId,
  buildSourceUrl,
  evaluateCookingTutorial,

  discovery: {
    modes: [
      {
        key: 'ranking',
        label: '榜单发现',
        params: [
          { key: 'source', label: '来源', type: 'select',
            options: [
              { value: 'food_3day', label: '美食三日榜' },
              { value: 'historical', label: '历史优质（关键词搜索）' },
              { value: 'auto', label: '两者合并' },
            ] },
          { key: 'limit', label: '数量', type: 'number', defaultValue: 30 },
        ],
      },
      {
        key: 'up_subscription',
        label: 'UP主关注',
        params: [],
      },
      {
        key: 'direct',
        label: '指定素材',
        params: [
          { key: 'input', label: 'BV号/链接', type: 'textarea',
            placeholder: '每行一个BV号或B站视频链接，空格分隔' },
        ],
      },
    ],
    rankingSources: ['food_3day'],
    searchKeywords: ['菜谱', '家常菜教程', '做饭教程'],
  },
}
