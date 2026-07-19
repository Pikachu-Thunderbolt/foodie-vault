// pages/add-ingredient/index.ts
import { addIngredient, inferTrackingMode } from '../../utils/storage'
import { INGREDIENT_CATEGORIES, COMMON_INGREDIENTS } from '../../data/mock-data'
import { getDefaultExpiryDays } from '../../utils/notify'

const CATEGORY_MARKS = ['冷', '冻', '常', '味']
const CATEGORY_TONES = ['sky', 'blue', 'honey', 'coral']
const categoryOptions = INGREDIENT_CATEGORIES.map((category, index) => ({
  ...category,
  mark: CATEGORY_MARKS[index] || '·',
  tone: CATEGORY_TONES[index] || 'paper',
}))

function trackingHint(name: string): string {
  const mode = inferTrackingMode(name)
  if (mode === 'estimated') return '将按余量状态管理；使用几次同款后可学习每餐份量'
  if (mode === 'presence') return '常备调料：做菜可记录用量，不必每次精确扣减'
  return '将按数量精确管理，并优先消耗最早到期批次'
}

Component({
  data: {
    activeTab: 'manual', // manual | photo | scan
    categories: categoryOptions,
    commonIngredients: COMMON_INGREDIENTS.slice(0, 10),

    // 表单数据
    form: {
      name: '',
      brand: '',
      variant: '',
      packageSize: '',
      category: '冷藏',
      purchaseDate: '',
      quantity: 1,
      unit: '个',
      storageLocation: '冰箱冷藏层',
      notes: '',
    },

    // 拍照识别结果
    photoScanResult: null as any,
    photoScanPreview: '',

    // 扫码结果
    scanResult: null as any,

    // 日期选择器
    today: '',
    expiryEndDate: '',

    // 保质期天数
    expiryDays: 3,
    autoExpiryDays: 3,

    // 自定义分类
    showCustomCategory: false,
    customCategory: '',
    unitOptions: ['个', '斤', 'kg', 'g', '把', '袋', '盒', '瓶', '包', '根'],
    selectedUnitIndex: 0,
    trackingHint: '',
    isEstimated: false,
  },

  lifetimes: {
    attached() {
      const now = new Date()
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

      // 计算默认过期日期
      const expiry = new Date(now)
      expiry.setDate(expiry.getDate() + 3)
      const expiryEndDate = `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, '0')}-${String(expiry.getDate()).padStart(2, '0')}`

      this.setData({ today, expiryEndDate })
    },
  },

  methods: {
    // 切换录入方式
    switchTab(e: any) {
      const { tab } = e.currentTarget.dataset
      if (tab === 'photo') {
        wx.setStorageSync('pendingScanMode', 'packaging')
        wx.switchTab({ url: '/pages/scan-import/index' })
        return
      }
      if (tab === 'scan') {
        wx.setStorageSync('pendingScanMode', 'receipt')
        wx.switchTab({ url: '/pages/scan-import/index' })
        return
      }
      this.setData({ activeTab: tab })
    },

    // 表单变更
    onNameInput(e: any) {
      const name = e.detail.value
      this.setData({ 'form.name': name, trackingHint: name ? trackingHint(name) : '', isEstimated: inferTrackingMode(name) === 'estimated' })
    },

    onBrandInput(e: any) {
      this.setData({ 'form.brand': e.detail.value })
    },

    onVariantInput(e: any) {
      this.setData({ 'form.variant': e.detail.value })
    },

    onPackageSizeInput(e: any) {
      this.setData({ 'form.packageSize': e.detail.value })
    },

    onNameBlur() {
      // 输入后自动匹配默认保质期
      const name = this.data.form.name
      if (name) {
        const days = getDefaultExpiryDays(name)
        this.setData({ autoExpiryDays: days, expiryDays: days })
        this.updateExpiryDate()
      }
    },

    onQuantityInput(e: any) {
      this.setData({ 'form.quantity': parseInt(e.detail.value) || 1 })
    },

    onNotesInput(e: any) {
      this.setData({ 'form.notes': e.detail.value })
    },

    onStorageInput(e: any) {
      this.setData({ 'form.storageLocation': e.detail.value })
    },

    // 快速选择食材名
    selectIngredient(e: any) {
      const { name } = e.currentTarget.dataset
      const days = getDefaultExpiryDays(name)
      this.setData({
        'form.name': name,
        trackingHint: trackingHint(name),
        isEstimated: inferTrackingMode(name) === 'estimated',
        autoExpiryDays: days,
        expiryDays: days,
      })
      this.updateExpiryDate()
    },

    // 选择分类
    selectCategory(e: any) {
      const { category } = e.currentTarget.dataset
      const storageByCategory: Record<string, string> = {
        冷藏: '冰箱冷藏层',
        冷冻: '冰箱冷冻层',
        常温: '厨房储物柜',
        调料: '调料架',
      }
      this.setData({
        'form.category': category,
        'form.storageLocation': storageByCategory[category] || this.data.form.storageLocation,
        showCustomCategory: false,
      })
    },

    // 开启自定义分类
    openCustomCategory() {
      this.setData({ showCustomCategory: true })
    },

    onCustomCategoryInput(e: any) {
      this.setData({ customCategory: e.detail.value })
    },

    confirmCustomCategory() {
      const custom = this.data.customCategory.trim()
      if (custom) {
        this.setData({ 'form.category': custom, showCustomCategory: false, customCategory: '' })
      }
    },

    // 选择单位
    selectUnit(e: any) {
      const { unit } = e.currentTarget.dataset
      const selectedUnitIndex = this.data.unitOptions.indexOf(unit)
      this.setData({ 'form.unit': unit, selectedUnitIndex: Math.max(0, selectedUnitIndex) })
    },

    onUnitChange(e: WechatMiniprogram.PickerChange) {
      const selectedUnitIndex = Number(e.detail.value)
      const unit = this.data.unitOptions[selectedUnitIndex]
      if (!unit) return
      this.setData({ 'form.unit': unit, selectedUnitIndex })
    },

    // 选择采购日期
    onPurchaseDateChange(e: any) {
      this.setData({ 'form.purchaseDate': e.detail.value }, () => this.updateExpiryDate())
    },

    // 保质期天数变更
    onExpiryDaysInput(e: any) {
      const days = parseInt(e.detail.value) || 1
      this.setData({ expiryDays: days })
      this.updateExpiryDate()
    },

    updateExpiryDate() {
      const days = this.data.expiryDays
      const purchaseDate = this.data.form.purchaseDate || this.data.today
      const d = new Date(purchaseDate)
      d.setDate(d.getDate() + days)
      const expiry = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      this.setData({ expiryEndDate: expiry })
    },

    // 拍照识别（模拟）
    takePhoto() {
      wx.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['camera'],
        success: (res) => {
          const tempFilePath = res.tempFilePaths[0]
          this.setData({ photoScanPreview: tempFilePath })

          // 模拟OCR识别结果
          wx.showLoading({ title: '识别中...' })
          setTimeout(() => {
            wx.hideLoading()
            const mockResult = {
              items: [
                { name: '番茄', quantity: 3, unit: '个', price: '¥8.5' },
                { name: '鸡蛋', quantity: 1, unit: '盒', price: '¥12.8' },
                { name: '青菜', quantity: 2, unit: '把', price: '¥6.0' },
              ],
              total: '¥27.3',
              date: this.data.today,
            }
            this.setData({ photoScanResult: mockResult })
            wx.showToast({ title: '识别完成', icon: 'success' })
          }, 1500)
        },
      })
    },

    // 确认拍照识别结果
    confirmScanItem(e: any) {
      const { index } = e.currentTarget.dataset
      const item = this.data.photoScanResult.items[index]
      const days = getDefaultExpiryDays(item.name)
      this.setData({
        'form.name': item.name,
        trackingHint: trackingHint(item.name),
        isEstimated: inferTrackingMode(item.name) === 'estimated',
        'form.quantity': item.quantity,
        'form.unit': item.unit,
        autoExpiryDays: days,
        expiryDays: days,
        activeTab: 'manual',
      })
      this.updateExpiryDate()
    },

    // 扫码录入
    scanBarcode() {
      wx.scanCode({
        success: (res) => {
          // 模拟扫码结果
          const mockBarcodeResult = {
            code: res.result,
            name: '牛奶',
            category: '冷藏',
            quantity: 1,
            unit: '瓶',
            expiryDays: 7,
          }
          this.setData({ scanResult: mockBarcodeResult })
        },
        fail: () => {
          wx.showToast({ title: '扫码取消', icon: 'none' })
        },
      })
    },

    confirmScanResult() {
      const r = this.data.scanResult
      if (r) {
        this.setData({
        'form.name': r.name,
          trackingHint: trackingHint(r.name),
          isEstimated: inferTrackingMode(r.name) === 'estimated',
          'form.category': r.category,
          'form.quantity': r.quantity,
          'form.unit': r.unit,
          autoExpiryDays: r.expiryDays,
          expiryDays: r.expiryDays,
          scanResult: null,
          activeTab: 'manual',
        })
        this.updateExpiryDate()
      }
    },

    // 提交表单
    submitForm() {
      const { form } = this.data

      if (!form.name.trim()) {
        wx.showToast({ title: '请输入食材名称', icon: 'none' })
        return
      }

      const expiryDate = this.data.expiryEndDate

      addIngredient({
        name: form.name.trim(),
        brand: form.brand.trim(),
        variant: form.variant.trim(),
        packageSize: form.packageSize.trim(),
        category: form.category,
        purchaseDate: form.purchaseDate || this.data.today,
        expiryDate: expiryDate,
        quantity: form.quantity,
        unit: form.unit,
        storageLocation: form.storageLocation.trim(),
        notes: form.notes.trim(),
      })

      wx.showToast({ title: '食材添加成功', icon: 'success' })

      setTimeout(() => {
        wx.navigateBack()
      }, 1200)
    },
  },
})
