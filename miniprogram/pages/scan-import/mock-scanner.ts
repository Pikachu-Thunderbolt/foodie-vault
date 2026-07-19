// 模拟图像识别 — 魔术厨房手账扫描体验

export interface RecognizedItem {
  id: string
  name: string
  category: string
  purchaseDate: string
  expiryDate: string
  quantity: number
  unit: string
  storageLocation: string
  imageLabel: string
  confidence: number
  isPlaced?: boolean
  posX?: number
  posY?: number
  posRot?: number
  posZ?: number
}

export interface ReceiptResult {
  store: string
  date: string
  total: string
  items: RecognizedItem[]
}

type RecognizedSeed = Omit<RecognizedItem, 'id'>

function todayStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function daysFromNow(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const PACKAGING_ITEMS: RecognizedSeed[] = [
  {
    name: '牛奶',
    category: '冷藏',
    purchaseDate: todayStr(),
    expiryDate: daysFromNow(7),
    quantity: 1,
    unit: '瓶',
    storageLocation: '冰箱冷藏层',
    imageLabel: '🥛',
    confidence: 0.92,
  },
  {
    name: '鸡蛋',
    category: '冷藏',
    purchaseDate: todayStr(),
    expiryDate: daysFromNow(25),
    quantity: 1,
    unit: '盒',
    storageLocation: '冰箱冷藏层',
    imageLabel: '🥚',
    confidence: 0.88,
  },
  {
    name: '西兰花',
    category: '冷藏',
    purchaseDate: todayStr(),
    expiryDate: daysFromNow(3),
    quantity: 1,
    unit: '颗',
    storageLocation: '冰箱冷藏层',
    imageLabel: '🥦',
    confidence: 0.85,
  },
]

// 单件包装识别 — 随机返回一个模拟结果
export function mockRecognizePackaging(_imagePath: string): Promise<RecognizedItem[]> {
  return new Promise((resolve) => {
    const delay = 1500 + Math.random() * 800
    setTimeout(() => {
      const idx = Math.floor(Math.random() * PACKAGING_ITEMS.length)
      const item = { ...PACKAGING_ITEMS[idx], id: 'scan_' + Date.now().toString(36) }
      resolve([item])
    }, delay)
  })
}

// 小票批量识别
export function mockRecognizeReceipt(_imagePath: string): Promise<ReceiptResult> {
  return new Promise((resolve) => {
    const delay = 1800 + Math.random() * 600
    setTimeout(() => {
      const items = BIG_RECEIPT_ITEMS.map((item, i) => ({
        ...item,
        id: 'rec_' + Date.now().toString(36) + '_' + i,
      }))
      resolve({
        store: '山姆会员商店',
        date: todayStr(),
        total: '¥486.20',
        items,
      })
    }, delay)
  })
}

// 大采购场景 — 22 件商品
const BIG_RECEIPT_ITEMS: RecognizedSeed[] = [
  { name: '番茄', category: '常温', purchaseDate: todayStr(), expiryDate: daysFromNow(4), quantity: 4, unit: '个', storageLocation: '厨房台面', imageLabel: '🍅', confidence: 0.95 },
  { name: '鸡蛋', category: '冷藏', purchaseDate: todayStr(), expiryDate: daysFromNow(25), quantity: 2, unit: '盒', storageLocation: '冰箱冷藏层', imageLabel: '🥚', confidence: 0.91 },
  { name: '西兰花', category: '冷藏', purchaseDate: todayStr(), expiryDate: daysFromNow(3), quantity: 1, unit: '颗', storageLocation: '冰箱冷藏层', imageLabel: '🥦', confidence: 0.88 },
  { name: '鸡胸肉', category: '冷冻', purchaseDate: todayStr(), expiryDate: daysFromNow(90), quantity: 2, unit: '块', storageLocation: '冰箱冷冻层', imageLabel: '🍗', confidence: 0.93 },
  { name: '牛奶', category: '冷藏', purchaseDate: todayStr(), expiryDate: daysFromNow(7), quantity: 2, unit: '瓶', storageLocation: '冰箱冷藏层', imageLabel: '🥛', confidence: 0.94 },
  { name: '吐司面包', category: '常温', purchaseDate: todayStr(), expiryDate: daysFromNow(5), quantity: 1, unit: '袋', storageLocation: '厨房台面', imageLabel: '🍞', confidence: 0.89 },
  { name: '三文鱼', category: '冷冻', purchaseDate: todayStr(), expiryDate: daysFromNow(60), quantity: 1, unit: '块', storageLocation: '冰箱冷冻层', imageLabel: '🐟', confidence: 0.86 },
  { name: '生菜', category: '冷藏', purchaseDate: todayStr(), expiryDate: daysFromNow(2), quantity: 2, unit: '颗', storageLocation: '冰箱冷藏层', imageLabel: '🥬', confidence: 0.90 },
  { name: '黄油', category: '冷藏', purchaseDate: todayStr(), expiryDate: daysFromNow(30), quantity: 1, unit: '块', storageLocation: '冰箱冷藏层', imageLabel: '🧈', confidence: 0.92 },
  { name: '土豆', category: '常温', purchaseDate: todayStr(), expiryDate: daysFromNow(14), quantity: 5, unit: '个', storageLocation: '厨房储物柜', imageLabel: '🥔', confidence: 0.97 },
  { name: '洋葱', category: '常温', purchaseDate: todayStr(), expiryDate: daysFromNow(10), quantity: 3, unit: '个', storageLocation: '厨房储物柜', imageLabel: '🧅', confidence: 0.94 },
  { name: '酸奶', category: '冷藏', purchaseDate: todayStr(), expiryDate: daysFromNow(12), quantity: 4, unit: '杯', storageLocation: '冰箱冷藏层', imageLabel: '🥤', confidence: 0.88 },
  { name: '牛油果', category: '常温', purchaseDate: todayStr(), expiryDate: daysFromNow(3), quantity: 2, unit: '个', storageLocation: '厨房台面', imageLabel: '🥑', confidence: 0.85 },
  { name: '虾仁', category: '冷冻', purchaseDate: todayStr(), expiryDate: daysFromNow(45), quantity: 1, unit: '袋', storageLocation: '冰箱冷冻层', imageLabel: '🦐', confidence: 0.91 },
  { name: '豆腐', category: '冷藏', purchaseDate: todayStr(), expiryDate: daysFromNow(3), quantity: 2, unit: '盒', storageLocation: '冰箱冷藏层', imageLabel: '🫘', confidence: 0.87 },
  { name: '青椒', category: '常温', purchaseDate: todayStr(), expiryDate: daysFromNow(5), quantity: 3, unit: '个', storageLocation: '厨房台面', imageLabel: '🫑', confidence: 0.93 },
  { name: '猪肉馅', category: '冷冻', purchaseDate: todayStr(), expiryDate: daysFromNow(60), quantity: 1, unit: '盒', storageLocation: '冰箱冷冻层', imageLabel: '🥩', confidence: 0.90 },
  { name: '芝士片', category: '冷藏', purchaseDate: todayStr(), expiryDate: daysFromNow(20), quantity: 1, unit: '包', storageLocation: '冰箱冷藏层', imageLabel: '🧀', confidence: 0.89 },
  { name: '胡萝卜', category: '常温', purchaseDate: todayStr(), expiryDate: daysFromNow(10), quantity: 4, unit: '根', storageLocation: '厨房储物柜', imageLabel: '🥕', confidence: 0.96 },
  { name: '酱油', category: '调料', purchaseDate: todayStr(), expiryDate: daysFromNow(365), quantity: 1, unit: '瓶', storageLocation: '调料架', imageLabel: '🍶', confidence: 0.92 },
  { name: '大米', category: '常温', purchaseDate: todayStr(), expiryDate: daysFromNow(180), quantity: 1, unit: '袋', storageLocation: '厨房储物柜', imageLabel: '🍚', confidence: 0.98 },
  { name: '冰淇淋', category: '冷冻', purchaseDate: todayStr(), expiryDate: daysFromNow(90), quantity: 2, unit: '盒', storageLocation: '冰箱冷冻层', imageLabel: '🍦', confidence: 0.84 },
]
