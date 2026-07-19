// pages/scan-import/index.ts — 扫描入库四步流程

import { addIngredient } from '../../utils/storage'
import { FoodVisual, getFoodVisual } from '../../utils/food-image'
import {
  mockRecognizePackaging,
  mockRecognizeReceipt,
  RecognizedItem,
  ReceiptResult,
} from './mock-scanner'

type ScanStep = 'viewfinder' | 'scanning' | 'results' | 'confirm'
type ScanMode = 'packaging' | 'receipt'

let landingTimer: ReturnType<typeof setTimeout> | undefined

interface Zone {
  id: 'fridge' | 'freezer' | 'pantry'
  label: string
  category: string
  storageLocation: string
  items: number[]
  hitX: number
  hitY: number
  hitW: number
  hitH: number
}

interface DisplayItem extends RecognizedItem {
  expiryShort: string
  visualKey: 'tomato' | 'milk' | 'leaf' | 'egg' | 'root' | 'bottle' | 'protein' | 'other'
  foodVisual: FoodVisual
}

function getFoodVisualKey(name: string): DisplayItem['visualKey'] {
  if (/番茄|西红柿|青椒/.test(name)) return 'tomato'
  if (/牛奶|酸奶|豆浆/.test(name)) return 'milk'
  if (/生菜|西兰花|白菜|菜/.test(name)) return 'leaf'
  if (/鸡蛋|鸭蛋/.test(name)) return 'egg'
  if (/土豆|洋葱|萝卜|牛油果/.test(name)) return 'root'
  if (/酱油|醋|油|饮料/.test(name)) return 'bottle'
  if (/肉|鱼|虾/.test(name)) return 'protein'
  return 'other'
}

function createZones(): Zone[] {
  return [
    {
      id: 'fridge',
      label: '冷藏',
      category: '冷藏',
      storageLocation: '冰箱冷藏层',
      items: [],
      hitX: 0,
      hitY: 0,
      hitW: 0,
      hitH: 0,
    },
    {
      id: 'freezer',
      label: '冷冻',
      category: '冷冻',
      storageLocation: '冰箱冷冻层',
      items: [],
      hitX: 0,
      hitY: 0,
      hitW: 0,
      hitH: 0,
    },
    {
      id: 'pantry',
      label: '常温',
      category: '常温',
      storageLocation: '厨房储物柜',
      items: [],
      hitX: 0,
      hitY: 0,
      hitW: 0,
      hitH: 0,
    },
  ]
}

Component({
  data: {
    step: 'viewfinder' as ScanStep,
    mode: 'packaging' as ScanMode,

    photoPath: '',
    showPhotoPreview: false,
    processing: false,
    saving: false,
    showLandingAnimation: false,
    focusPulse: false,
    captureAnimating: false,
    shutterFrame: 0,

    scanStatusText: '正在分析画面…',
    scanStatusIndex: 0,

    recognizedItems: [] as DisplayItem[],
    receiptInfo: null as { store: string; date: string; total: string } | null,

    draggingIndex: -1,
    dragStartX: 0,
    dragStartY: 0,
    dragMoved: false,
    suppressTap: false,
    dragCurrentX: 0,
    dragCurrentY: 0,
    dragOffsetX: 50,
    dragOffsetY: 50,
    highlightedZone: -1,
    ghostVisualKey: 'other' as DisplayItem['visualKey'],
    ghostFoodVisual: { type: 'emoji', value: '' } as FoodVisual,
    flyingItemIndex: -1,
    selectedStickerIndex: -1,

    placedItems: [] as number[],
    zones: [] as Zone[],

    savedCount: 0,
    showEmptyResult: false,
  },

  lifetimes: {
    attached() {
      const pages = getCurrentPages()
      const currentPage = pages[pages.length - 1] as unknown as { options?: { mode?: string } }
      const mode: ScanMode = currentPage.options?.mode === 'receipt' ? 'receipt' : 'packaging'
      this.setData({ mode })
      // 首屏完成后再预热，避免多个大图抢占取景页的首次绘制。
      setTimeout(() => {
        [
          '/resource/generated/scan-packaging-counter.png',
          '/resource/generated/scan-receipt-counter.png',
          ...Array.from({ length: 6 }, (_, index) => `/resource/generated/packaging-shutter-effect-${index + 1}.png`),
        ].forEach((src) => wx.getImageInfo({ src, fail: () => undefined }))
      }, 120)
    },
    detached() {
      if (landingTimer) clearTimeout(landingTimer)
    },
  },

  pageLifetimes: {
    show() {
      const pendingMode = wx.getStorageSync('pendingScanMode')
      if (pendingMode === 'packaging' || pendingMode === 'receipt') {
        this.setData({ mode: pendingMode as ScanMode })
        wx.removeStorageSync('pendingScanMode')
      }
    },
  },

  methods: {
    // ===== 1. 取景 =====
    capturePhoto() {
      if (this.data.processing || this.data.captureAnimating) return
      this.setData({ focusPulse: true, captureAnimating: true, shutterFrame: 0 })
      // 取景框背景保持不动；快门闭合时逐渐加速，打开时逐渐减速。
      const shutterFrames = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]
      const shutterFrameTimes = [0, 70, 125, 165, 190, 202, 214, 239, 279, 334, 404]
      shutterFrames.forEach((frame, index) => {
        setTimeout(() => this.setData({ shutterFrame: frame }), shutterFrameTimes[index])
      })
      // 第 1 帧展开后回到未覆盖的取景框背景，再唤起系统相机。
      setTimeout(() => this.setData({ shutterFrame: 0 }), 430)
      setTimeout(() => {
        this.setData({ focusPulse: false })
        wx.chooseImage({
          count: 1,
          sizeType: ['compressed'],
          sourceType: ['camera'],
          success: (res) => {
            this.setData({
              photoPath: res.tempFilePaths[0],
              showPhotoPreview: true,
              captureAnimating: false,
            })
          },
          fail: (error) => {
            const message = String(error.errMsg || '')
            this.setData({ captureAnimating: false })
            if (!message.includes('cancel')) {
              wx.showToast({ title: '需要相机权限才能拍照', icon: 'none' })
            }
          },
        })
      }, 470)
    },

    chooseFromAlbum() {
      if (this.data.processing || this.data.captureAnimating) return
      wx.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['album'],
        success: (res) => this.setData({ photoPath: res.tempFilePaths[0], showPhotoPreview: true }),
      })
    },

    retakePhoto() {
      if (landingTimer) clearTimeout(landingTimer)
      this.setData({
        step: 'viewfinder',
        photoPath: '',
        showPhotoPreview: false,
        processing: false,
        focusPulse: false,
        captureAnimating: false,
        showLandingAnimation: false,
      })
    },

    switchMode(e: WechatMiniprogram.TouchEvent) {
      const mode = e.currentTarget.dataset.mode as ScanMode
      if (mode === this.data.mode || (mode !== 'packaging' && mode !== 'receipt')) return
      this.setData({ mode })
    },

    // ===== 2. 扫描 =====
    startScanning() {
      if (this.data.processing || !this.data.photoPath) return

      this.setData({
        step: 'scanning',
        processing: true,
        scanStatusText: '正在分析画面…',
        scanStatusIndex: 0,
      })

      const statusTexts = ['正在分析画面…', '正在辨认食材…', '正在整理保质期…']
      let statusIndex = 0
      const statusTimer = setInterval(() => {
        statusIndex += 1
        if (statusIndex < statusTexts.length) {
          this.setData({
            scanStatusText: statusTexts[statusIndex],
            scanStatusIndex: statusIndex,
          })
        } else {
          clearInterval(statusTimer)
        }
      }, 620)

      const recognition: Promise<RecognizedItem[] | ReceiptResult> = this.data.mode === 'receipt'
        ? mockRecognizeReceipt(this.data.photoPath)
        : mockRecognizePackaging(this.data.photoPath)

      recognition
        .then((result) => {
          clearInterval(statusTimer)

          let items: RecognizedItem[] = []
          let receiptInfo: { store: string; date: string; total: string } | null = null

          if (this.data.mode === 'receipt') {
            const receiptResult = result as ReceiptResult
            items = receiptResult.items
            receiptInfo = {
              store: receiptResult.store,
              date: receiptResult.date,
              total: receiptResult.total,
            }
          } else {
            items = result as RecognizedItem[]
          }

          const recognizedItems: DisplayItem[] = items.map((item) => ({
            ...item,
            expiryShort: item.expiryDate.slice(5),
            visualKey: getFoodVisualKey(item.name),
            foodVisual: getFoodVisual(item.name, item.imageLabel),
            isPlaced: false,
          }))
          this.setData({
            step: 'results',
            processing: false,
            scanStatusText: '识别完成',
            scanStatusIndex: 2,
            recognizedItems,
            receiptInfo,
            showEmptyResult: recognizedItems.length === 0,
            zones: createZones(),
            placedItems: [],
            savedCount: 0,
            selectedStickerIndex: -1,
            showLandingAnimation: true,
          })

          // 先让桌面暖光聚焦，再分批让贴纸落桌；动画结束前不开放操作。
          if (landingTimer) clearTimeout(landingTimer)
          landingTimer = setTimeout(() => {
            if (this.data.step !== 'results') return
            this.setData({ showLandingAnimation: false })
          }, 1700)
        })
        .catch(() => {
          clearInterval(statusTimer)
          this.setData({ step: 'viewfinder', processing: false })
          wx.showToast({ title: '识别失败，请重新拍摄', icon: 'none' })
        })
    },

    // ===== 3. 识别结果与拖拽 =====
    calculateZoneHitboxes() {
      const query = this.createSelectorQuery()
      query.selectAll('.storage-drop-target').boundingClientRect()
      query.exec((result) => {
        const rects = result?.[0] as WechatMiniprogram.BoundingClientRectResult[] | undefined
        if (!rects || rects.length === 0) return

        const zones = this.data.zones.map((zone, index) => {
          const rect = rects[index]
          if (!rect) return zone
          return {
            ...zone,
            hitX: rect.left,
            hitY: rect.top,
            hitW: rect.width,
            hitH: rect.height,
          }
        })
        this.setData({ zones })
      })
    },

    onResultsScroll() {
      if (this.data.draggingIndex >= 0) return
      this.calculateZoneHitboxes()
    },

    onDragStart(e: WechatMiniprogram.TouchEvent) {
      const index = Number(e.currentTarget.dataset.index)
      if (Number.isNaN(index) || this.data.placedItems.includes(index)) return
      if (this.data.draggingIndex >= 0 || !e.touches[0]) return

      this.calculateZoneHitboxes()

      const touch = e.touches[0]
      this.setData({
        draggingIndex: index,
        dragStartX: touch.clientX,
        dragStartY: touch.clientY,
        dragMoved: false,
        suppressTap: false,
        dragCurrentX: touch.clientX,
        dragCurrentY: touch.clientY,
        dragOffsetX: 110,
        dragOffsetY: 110,
        highlightedZone: -1,
        ghostVisualKey: this.data.recognizedItems[index].visualKey,
        ghostFoodVisual: this.data.recognizedItems[index].foodVisual,
      })
    },

    onTabletopDragStart(e: WechatMiniprogram.TouchEvent) {
      if (this.data.showLandingAnimation) return
      const index = Number(e.currentTarget.dataset.index)
      if (Number.isNaN(index) || this.data.placedItems.includes(index) || !e.touches[0]) return

      const touch = e.touches[0]
      this.setData({
        selectedStickerIndex: index,
        draggingIndex: index,
        dragStartX: touch.clientX,
        dragStartY: touch.clientY,
        dragMoved: false,
        suppressTap: true,
        dragCurrentX: touch.clientX,
        dragCurrentY: touch.clientY,
        dragOffsetX: 110,
        dragOffsetY: 110,
        highlightedZone: -1,
        ghostVisualKey: this.data.recognizedItems[index].visualKey,
        ghostFoodVisual: this.data.recognizedItems[index].foodVisual,
      }, () => this.calculateZoneHitboxes())
    },

    onPageTouchMove(e: WechatMiniprogram.TouchEvent) {
      if (this.data.draggingIndex < 0 || !e.touches[0]) return
      const touch = e.touches[0]
      const moved = this.data.dragMoved
        || Math.abs(touch.clientX - this.data.dragStartX) > 8
        || Math.abs(touch.clientY - this.data.dragStartY) > 8

      let hit = -1
      if (moved) {
        hit = this.findHitZone(touch.clientX, touch.clientY)
      }

      this.setData({
        dragMoved: moved,
        dragCurrentX: touch.clientX,
        dragCurrentY: touch.clientY,
        highlightedZone: hit,
      })
    },

    onPageTouchEnd() {
      if (this.data.draggingIndex < 0) return
      const itemIndex = this.data.draggingIndex

      if (!this.data.dragMoved) {
        this.setData({ draggingIndex: -1, selectedStickerIndex: -1, highlightedZone: -1, suppressTap: false })
        return
      }

      this.setData({ suppressTap: true, highlightedZone: -1 })
      this.endDragWithIndex(itemIndex)
      setTimeout(() => this.setData({ suppressTap: false }), 120)
    },

    findHitZone(x: number, y: number): number {
      for (let index = 0; index < this.data.zones.length; index += 1) {
        const zone = this.data.zones[index]
        if (
          x >= zone.hitX
          && x <= zone.hitX + zone.hitW
          && y >= zone.hitY
          && y <= zone.hitY + zone.hitH
        ) {
          return index
        }
      }
      return -1
    },

    endDragWithIndex(itemIndex: number) {
      const zoneIndex = this.findHitZone(this.data.dragCurrentX, this.data.dragCurrentY)
      if (zoneIndex < 0) {
        this.setData({ draggingIndex: -1, dragMoved: false, selectedStickerIndex: -1 })
        return
      }

      const zone = this.data.zones[zoneIndex]
      const zoneCenterX = zone.hitX + zone.hitW / 2
      const zoneCenterY = zone.hitY + zone.hitH / 2
      this.placeItem(itemIndex, zoneIndex)
      this.setData({
        draggingIndex: -1,
        dragMoved: false,
        flyingItemIndex: itemIndex,
        dragCurrentX: zoneCenterX,
        dragCurrentY: zoneCenterY,
        selectedStickerIndex: -1,
      })

      setTimeout(() => this.setData({ flyingItemIndex: -1 }), 420)
    },

    placeItem(itemIndex: number, zoneIndex: number) {
      if (this.data.placedItems.includes(itemIndex)) return
      const placedItems = [...this.data.placedItems, itemIndex]
      const zones = this.data.zones.map((zone, index) => (
        index === zoneIndex ? { ...zone, items: [...zone.items, itemIndex] } : zone
      ))
      const recognizedItems = this.data.recognizedItems.map((item, index) => (
        index === itemIndex ? { ...item, isPlaced: true } : item
      ))
      this.setData({ placedItems, zones, recognizedItems })
    },

    onFoodTap(e: WechatMiniprogram.TouchEvent) {
      if (this.data.suppressTap) return
      const index = Number(e.currentTarget.dataset.index)
      if (Number.isNaN(index) || this.data.placedItems.includes(index)) return

      this.setData({ selectedStickerIndex: this.data.selectedStickerIndex === index ? -1 : index })
      wx.vibrateShort({ type: 'light' })
    },

    onTabletopStickerTap(e: WechatMiniprogram.TouchEvent) {
      if (this.data.showLandingAnimation) return
      const index = Number(e.currentTarget.dataset.index)
      if (Number.isNaN(index) || !this.data.recognizedItems[index]) return
      this.setData({ selectedStickerIndex: this.data.selectedStickerIndex === index ? -1 : index })
    },

    clearSelectedSticker() {
      this.setData({ selectedStickerIndex: -1 })
    },

    stopPropagation() {},

    undoPlacement(e: WechatMiniprogram.TouchEvent) {
      const itemIndex = Number(e.currentTarget.dataset.index)
      const zoneIndex = Number(e.currentTarget.dataset.zoneIndex)
      if (Number.isNaN(itemIndex) || Number.isNaN(zoneIndex)) return

      const placedItems = this.data.placedItems.filter((index) => index !== itemIndex)
      const zones = this.data.zones.map((zone, index) => (
        index === zoneIndex
          ? { ...zone, items: zone.items.filter((placedIndex) => placedIndex !== itemIndex) }
          : zone
      ))
      const recognizedItems = this.data.recognizedItems.map((item, index) => (
        index === itemIndex ? { ...item, isPlaced: false } : item
      ))

      this.setData({ placedItems, zones, recognizedItems })
    },

    batchImportAll() {
      const unplaced = this.data.recognizedItems
        .map((_, index) => index)
        .filter((index) => !this.data.placedItems.includes(index))
      if (unplaced.length === 0) return

      const placedItems = [...this.data.placedItems]
      const zones = this.data.zones.map((zone) => ({ ...zone, items: [...zone.items] }))
      const recognizedItems = this.data.recognizedItems.map((item) => ({ ...item }))

      unplaced.forEach((itemIndex) => {
        const item = recognizedItems[itemIndex]
        let zoneIndex = 1
        if (item.category === '冷藏') zoneIndex = 0
        if (item.category === '常温' || item.category === '调料') zoneIndex = 2
        zones[zoneIndex].items.push(itemIndex)
        placedItems.push(itemIndex)
        item.isPlaced = true
      })

      this.setData({ placedItems, zones, recognizedItems })
      wx.vibrateShort({ type: 'medium' })
      wx.showToast({ title: `已整理 ${unplaced.length} 件食材`, icon: 'none' })
    },

    // ===== 4. 确认入库 =====
    confirmImport() {
      if (this.data.showLandingAnimation || this.data.placedItems.length === 0) {
        return
      }
      if (this.data.saving) return

      this.setData({ saving: true })
      this.data.placedItems.forEach((itemIndex) => {
        const item = this.data.recognizedItems[itemIndex]
        const zone = this.data.zones.find((candidate) => candidate.items.includes(itemIndex))
        if (!zone) return

        addIngredient({
          name: item.name,
          category: zone.category,
          purchaseDate: item.purchaseDate,
          expiryDate: item.expiryDate,
          quantity: item.quantity,
          unit: item.unit,
          storageLocation: zone.storageLocation,
          notes: '',
        })
      })

      const savedCount = this.data.placedItems.length
      this.setData({ step: 'confirm', saving: false, savedCount })
      wx.vibrateShort({ type: 'light', fail: () => undefined })
    },

    cancelImport() {
      this.goAddMore()
    },

    goAddMore() {
      if (landingTimer) clearTimeout(landingTimer)
      this.setData({
        step: 'viewfinder',
        photoPath: '',
        showPhotoPreview: false,
        recognizedItems: [],
        receiptInfo: null,
        placedItems: [],
        zones: [],
        savedCount: 0,
        showEmptyResult: false,
        processing: false,
        saving: false,
        showLandingAnimation: false,
        selectedStickerIndex: -1,
      })
    },

    goManual() {
      wx.navigateTo({ url: '/pages/add-ingredient/index' })
    },

    goBack() {
      wx.switchTab({ url: '/pages/index/index' })
    },
  },
})
