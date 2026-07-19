// pages/tutorial-frames/index.js — 用户为自有教程逐步挑代表帧
// 纯 JS（不依赖 TS 编译产物），避免新增页面时 devtools 找不到 index.js。
import { getTutorialDraft, submitFrameSelection } from '../../utils/tutorials'

Page({
  data: {
    tutorialId: '',
    recipeName: '',
    steps: [],
    selected: {}, // stepIndex → "frameType:slot"
    loading: true,
    submitting: false,
    error: '',
  },

  onLoad(query) {
    const tutorialId = (query && query.tutorialId) || ''
    this.setData({ tutorialId })
    if (!tutorialId) { this.setData({ loading: false, error: '缺少 tutorialId' }); return }
    this.load()
  },

  async load() {
    try {
      const draft = await getTutorialDraft(this.data.tutorialId)
      const selected = {}
      for (const s of draft.steps) {
        const first = s.candidates[0]
        if (first) selected[s.stepIndex] = `${first.frameType}:${first.slot}`
      }
      this.setData({ recipeName: draft.recipeName, steps: draft.steps, selected, loading: false })
    } catch (err) {
      this.setData({ loading: false, error: (err && err.message) || '加载失败' })
    }
  },

  onPick(e) {
    const { step, val } = e.currentTarget.dataset
    this.setData({ [`selected.${step}`]: val })
  },

  async onSubmit() {
    if (this.data.submitting) return
    const selections = this.data.steps.map((s) => {
      const [frameType, slot] = (this.data.selected[s.stepIndex] || '').split(':')
      return { stepIndex: s.stepIndex, frameType, slot: Number(slot) || 0 }
    }).filter((x) => x.frameType)
    if (!selections.length) { wx.showToast({ title: '请先挑选', icon: 'none' }); return }
    this.setData({ submitting: true })
    try {
      await submitFrameSelection(this.data.tutorialId, selections)
      wx.showToast({ title: '已提交，处理中', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 800)
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '提交失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },
})
