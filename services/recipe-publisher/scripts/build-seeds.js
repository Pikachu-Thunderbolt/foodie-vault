'use strict'

// 从项目已有素材与下列高频主档扩展项生成可审计的 P0 种子数据。
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '../../..')
const STICKER_DIR = path.join(ROOT, 'miniprogram/resource/food-icon/sticker')
const RECIPE_DIR = path.join(ROOT, 'miniprogram/resource/recipe-icon')
const OUT_DIR = path.join(__dirname, '../data')

const GROUPS = {
  蔬菜: '番茄 西红柿 黄瓜 洋葱 大葱 小葱 蒜 苦瓜 丝瓜 冬瓜 南瓜 贝贝南瓜 茄子 青椒 红椒 彩椒 小米椒 杭椒 尖椒 土豆 红薯 紫薯 山药 芋头 莲藕 白萝卜 胡萝卜 青萝卜 绿萝卜 大白菜 娃娃菜 上海青 小白菜 油麦菜 生菜 菠菜 空心菜 苋菜 茼蒿 菜心 芥蓝 羽衣甘蓝 西兰花 花菜 紫甘蓝 包菜 甘蓝 芹菜 香菜 韭菜 蒜苗 蒜苔 莴笋 莴苣 西葫芦 佛手瓜 茭白 丝瓜 豌豆 豌豆苗 豌豆尖 毛豆 四季豆 豇豆 荷兰豆 甜豆 蚕豆 豆角 黄豆芽 绿豆芽 竹笋 春笋 冬笋 杏鲍菇 香菇 平菇 金针菇 蟹味菇 海鲜菇 白玉菇 口蘑 猴头菇 木耳 银耳 黄花菜 荸荠 百合 芦笋 秋葵 芹菜根 马兰头 荠菜 雪菜 酸菜 萝卜干 榨菜 泡椒',
  肉禽蛋: '猪肉 五花肉 猪里脊 猪肉馅 梅花肉 排骨 猪蹄 猪肝 猪腰 猪心 猪肚 猪耳朵 猪大肠 牛肉 牛腩 牛排 牛里脊 牛腱子 牛百叶 牛筋 羊肉 羊排 羊蝎子 羊肚 鸡肉 鸡胸肉 鸡腿肉 鸡翅 鸡翅根 鸡爪 鸡胗 鸡心 鸡腿 鸭肉 鸭腿 鸭翅 鸭舌 鸭血 鸭蛋 鸽子蛋 鹌鹑蛋 鸡蛋 皮蛋 咸鸭蛋 培根 火腿 香肠 腊肉 肉丸 午餐肉',
  水产: '虾 虾仁 基围虾 大虾 河虾 小龙虾 蟹 螃蟹 梭子蟹 花蟹 生蚝 生蚝肉 扇贝 带子 蛤蜊 花蛤 蛏子 海虹 鲍鱼 海参 鱿鱼 鱿鱼圈 墨鱼 章鱼 带鱼 黄鱼 鲫鱼 鲈鱼 多宝鱼 草鱼 黑鱼 鳕鱼 龙利鱼 三文鱼 金枪鱼 青花鱼 鲳鱼 鲳鱼片 鳗鱼 鲶鱼 鱼片 鱼丸 虾皮 海带 紫菜 海蜇',
  蛋奶豆: '牛奶 酸奶 奶酪 芝士 马苏里拉 奶油奶酪 淡奶油 黄油 炼乳 双皮奶 豆腐 嫩豆腐 老豆腐 内酯豆腐 豆皮 豆腐皮 腐竹 豆干 香干 千张 油豆腐 豆浆 黄豆 黑豆 绿豆 红豆 白芸豆 鹰嘴豆 豆豉 豆瓣酱 黄豆酱 花生酱 芝麻酱',
  主食谷物: '大米 糙米 小米 黑米 紫米 玉米碴 高粱米 藜麦 燕麦片 小麦胚芽 荞麦 面粉 高筋面粉 低筋面粉 玉米面 糯米 粉丝 米粉 米线 河粉 宽粉 红薯粉 方便面 挂面 意面 螺蛳粉 饺子皮 馄饨皮 春卷皮 面包 吐司 馒头 花卷 年糕 汤圆 元宵 面条 米饭 炒饭 粥',
  水果坚果: '苹果 梨 香蕉 橙子 柚子 柠檬 青柠 西瓜 哈密瓜 菠萝 芒果 木瓜 桃子 李子 葡萄 草莓 蓝莓 樱桃 火龙果 牛油果 猕猴桃 百香果 荔枝 龙眼 杨梅 石榴 柿子 枣 红枣 桂圆 莲子 核桃 花生 腰果 杏仁 巴旦木 松子 芝麻 南瓜子',
  调料: '食盐 白砂糖 红糖 冰糖 黑糖 生抽 老抽 酱油 蚝油 醋 陈醋 米醋 香醋 料酒 黄酒 白酒 啤酒 味精 鸡精 胡椒粉 白胡椒 黑胡椒 花椒 藤椒 辣椒粉 孜然 五香粉 十三香 八角 桂皮 香叶 草果 丁香 小茴香 豆蔻 豆瓣酱 甜面酱 黄豆酱 番茄酱 沙拉酱 蛋黄酱 芥末 蜂蜜 椰浆 椰奶 咖喱块 咖喱粉 芝麻油 香油 菜籽油 花生油 橄榄油 黄油 猪油',
  干货腌制: '木耳 银耳 海带 紫菜 腐竹 粉条 粉丝 干香菇 干贝 虾米 虾皮 腊肠 腊肉 梅干菜 酸豇豆 泡菜 酸菜 雪菜 榨菜 咸菜 笋干 干辣椒 枸杞 红枣 桂圆 莲子 百合 花生 米酒 酒酿',
}

const ALIASES = {
  番茄: ['西红柿', '圣女果', '小番茄'], 鸡蛋: ['草鸡蛋', '土鸡蛋', '无菌鸡蛋'], 牛奶: ['鲜牛奶', '纯牛奶', '全脂牛奶', '低脂牛奶'],
  酸奶: ['原味酸奶', '希腊酸奶', '无糖酸奶'], 西兰花: ['西蓝花', '绿花椰菜'], 花菜: ['菜花', '白花菜'],
  上海青: ['青菜', '青江菜'], 大白菜: ['白菜', '黄芽白'], 土豆: ['马铃薯', '洋芋'], 黄瓜: ['青瓜'],
  洋葱: ['圆葱', '洋葱头'], 胡萝卜: ['红萝卜'], 白萝卜: ['萝卜'], 鸡肉: ['鸡腿肉', '鸡胸肉'],
  猪肉: ['猪肉片', '猪肉丝'], 虾: ['大虾', '鲜虾'], 虾仁: ['去皮虾仁', '冷冻虾仁'], 豆腐: ['嫩豆腐', '老豆腐', '内酯豆腐'],
  奶酪: ['芝士', '芝士片'], 食盐: ['盐', '食用盐'], 生抽: ['生抽酱油'], 老抽: ['老抽酱油'],
  大葱: ['葱白'], 小葱: ['香葱', '葱花'], 蒜: ['大蒜', '蒜头'], 油麦菜: ['油麦'], 玉米: ['甜玉米'],
  香菜: ['芫荽'], 香干: ['豆腐干'], 豆皮: ['豆腐皮'], 粉丝: ['细粉丝'], 粉条: ['红薯粉条'],
  紫菜: ['干紫菜'], 海带: ['海带结'], 花生: ['花生米'], 白砂糖: ['白糖'], 芝麻油: ['香油'],
}

const NAME_FIXES = { '土豆:马铃薯': '土豆', '牛奶盒': '牛奶', '牛奶-新版': '牛奶', '鸡肉-clean': '鸡肉', '牛油果-clean': '牛油果', '豆腐-clean': '豆腐', '酸奶-新版': '酸奶' }

function categoryFor(name, categoryMap) {
  return categoryMap.get(name) || '其他'
}

function cleanStem(file) {
  const stem = path.basename(file).replace(/\.[^.]+$/, '').replace(/-(clean|新版)$/, '')
  return NAME_FIXES[stem] || stem
}

function dishAliases(name) {
  const replacements = [['番茄', '西红柿'], ['土豆', '马铃薯'], ['西兰花', '西蓝花'], ['青椒', '尖椒'], ['红烧', '红焖'], ['凉拌', '凉调']]
  return Array.from(new Set(replacements.filter(([from]) => name.includes(from)).map(([from, to]) => name.replace(from, to)).filter((alias) => alias !== name)))
}

const categoryMap = new Map()
for (const [category, words] of Object.entries(GROUPS)) for (const name of words.split(/\s+/).filter(Boolean)) categoryMap.set(name, category)
const stickerNames = fs.readdirSync(STICKER_DIR).map(cleanStem)
const ingredientNames = Array.from(new Set([...categoryMap.keys(), ...stickerNames])).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
const ingredients = ingredientNames.map((canonicalName) => ({
  dictionaryId: `ing_${canonicalName}`,
  kind: 'ingredient',
  canonicalName,
  aliases: Array.from(new Set(ALIASES[canonicalName] || [])).filter((alias) => alias !== canonicalName),
  category: categoryFor(canonicalName, categoryMap),
  status: 'ACTIVE',
  seedVersion: 'p0-20260718',
}))

const recipeNames = fs.readdirSync(RECIPE_DIR).map(cleanStem).filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).slice(0, 180)
const dishes = recipeNames.map((canonicalName) => ({
  dictionaryId: `dish_${canonicalName}`,
  kind: 'dish',
  canonicalName,
  aliases: dishAliases(canonicalName),
  status: 'ACTIVE',
  seedVersion: 'p0-20260718',
}))

if (ingredients.length < 300 || ingredients.length > 500) throw new Error(`食材种子数异常：${ingredients.length}`)
if (dishes.length < 100 || dishes.length > 200) throw new Error(`菜品种子数异常：${dishes.length}`)
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'food-dictionary.seed.json'), `${JSON.stringify(ingredients, null, 2)}\n`)
fs.writeFileSync(path.join(OUT_DIR, 'dish-dictionary.seed.json'), `${JSON.stringify(dishes, null, 2)}\n`)
console.log(`generated ${ingredients.length} ingredients and ${dishes.length} dishes`)
