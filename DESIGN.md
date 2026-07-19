# Design

## Theme

### Scene

一个刚下班的年轻人站在厨房里，打开冰箱门，暖黄的灯光照亮脸上的困惑——"今晚吃什么？"这不是冰冷的工具界面，这是一本会说话的厨房手账，画在一本用了很久的图画本上。

### Physical metaphor

整个产品是一本老式儿童连环画大小的厨房手账。每一页都是蜡笔和彩铅画的，线条不直，色块不匀，有些地方颜色叠了两层，有些地方能看到排线痕迹。翻页时有"哗啦"的停顿感，像真的在翻一本纸质书。

### Color Strategy: Committed + Warm Hand-drawn

主色是一个饱和但不过分鲜艳的暖色——像蜡笔盒里那支用得最多的颜色。整体策略是 **committed**：主色占据 30-40% 的表面，辅助色用蜡笔盒里的其他颜色（蓝绿、姜黄、砖红），所有颜色都带手绘肌理，没有纯平色块。

四个阶梯：committed —— 一个饱和色承担 30-60% 的表面，因为手绘肌理本身就是识别系统，颜色不需要铺满。

## Color Palette

### Brand Colors (OKLCH)

| Token | Value | Usage |
|-------|-------|-------|
| `--color-ink` | `oklch(0.15 0.02 60)` | 主体文字——不是纯黑，是偏暖的深褐，像炭笔 |
| `--color-paper` | `oklch(0.96 0.015 85)` | 纸张底色——暖白带极微黄调，模拟图画本纸张 |
| `--color-coral` | `oklch(0.62 0.18 35)` | 主品牌色——蜡笔暖珊瑚/番茄红 |
| `--color-coral-light` | `oklch(0.80 0.08 35)` | 珊瑚浅色——大面积铺底 |
| `--color-leaf` | `oklch(0.50 0.15 145)` | 蜡笔叶绿——新鲜/完成状态 |
| `--color-honey` | `oklch(0.72 0.13 85)` | 蜡笔姜黄——临期/提醒状态 |
| `--color-brick` | `oklch(0.48 0.16 30)` | 蜡笔砖红——过期/危险状态 |
| `--color-sky` | `oklch(0.65 0.08 240)` | 蜡笔淡蓝——辅助信息/冷静元素 |
| `--color-cream` | `oklch(0.85 0.04 80)` | 奶黄——卡片/面板底色 |

### Semantic Color Assignments

- **新鲜/成功**: `--color-leaf`（叶绿，不是荧光绿）
- **临期/提醒**: `--color-honey`（姜黄，不是亮黄）
- **过期/危险**: `--color-brick`（砖红，不是警报红）
- **主按钮/品牌**: `--color-coral`
- **背景**: `--color-paper`
- **卡片**: `--color-cream`

### Contrast Checks

- `--color-ink` on `--color-paper`: ~12:1 ✓
- `--color-ink` on `--color-cream`: ~10:1 ✓
- White text on `--color-coral`: ~5.5:1 ✓ (bold/large text)
- `--color-ink` on `--color-coral-light`: ~7:1 ✓

## Typography

### Strategy

One humanist family at multiple weights. No geometric precision——字体本身也要有"手写感"的温度。中文用系统默认 PingFang SC（它是人文主义的，笔画有书写痕迹），搭配圆体变体或中等字重，避免极细/极粗。

### Font Stack

```
--font-display: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif
--font-body: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif
--font-marker: "PingFang SC", "STKaiti", "KaiTi", serif  /* 标注/手写感的场景 */
```

### Scale (rpx for WeChat Mini Program)

| Token | Size | Weight | Usage |
|-------|------|--------|-------|
| `--text-xs` | 20rpx | 400 | 辅助标注 |
| `--text-sm` | 24rpx | 400 | 次要信息、标签 |
| `--text-base` | 28rpx | 400 | 正文 |
| `--text-md` | 32rpx | 500 | 列表标题 |
| `--text-lg` | 36rpx | 600 | 页面标题 |
| `--text-xl` | 44rpx | 700 | 场景标题 |
| `--text-display` | 56rpx | 700 | 大数字/强调 |

## Texture System

### Core Principle

手绘肌理不是装饰层——它是视觉语言的基础。每个色块都有不均匀的边缘、可见的排线纹理、轻微的叠色痕迹。用CSS模拟蜡笔/彩铅质感：

### Simulation Techniques

1. **粗糙边框**: 2-3px的虚线边框 + `border-radius` 不均匀（用多个 box-shadow 叠加模拟不规则的圆角）
2. **蜡笔排线纹理**: 用 repeating-linear-gradient 模拟彩铅排线，叠加在背景色上
3. **叠色痕迹**: 部分元素叠加半透明偏移阴影，模拟"颜色涂出边框"的效果
4. **纸张肌理**: 背景用 CSS noise（SVG filter）模拟图画纸的纤维颗粒感
5. **不规则形状**: 卡片和按钮的 `border-radius` 用非对称值（左上圆角比右下大2-3rpx）

### Texture Tokens

```
--texture-hatch: repeating-linear-gradient(45deg, transparent, transparent 1px, rgba(0,0,0,0.03) 1px, rgba(0,0,0,0.03) 2px)
--texture-crosshatch: before/after 伪元素叠加两层不同角度的排线
--texture-rough-edge: box-shadow 多层小偏移模拟蜡笔的不均匀边缘
--texture-paper: SVG feTurbulence noise filter 叠加在背景上
```

## Layout

### Page Architecture

每个页面遵循"场景插画 + 核心内容 + 操作区"的三段式：

1. **顶部场景区** (200-300rpx): 手绘场景插画——食材页是打开的冰箱、菜谱页是摊开的食谱书、个人页是贴满便签的厨房墙
2. **中部内容区**: 列表/卡片/表单，保留手绘纹理但信息清晰
3. **底部操作区**: 固定按钮或Tab Bar，触感明确

### Spacing Scale

基于 8rpx 基准（微信小程序的 8pt grid）：
- `--space-xs`: 8rpx
- `--space-sm`: 16rpx
- `--space-md`: 24rpx
- `--space-lg`: 32rpx
- `--space-xl`: 48rpx
- `--space-2xl`: 64rpx

### Z-Index Scale (semantic)

```
backdrop: 1
content: 10
sticky-header: 100
fab-button: 200
modal-backdrop: 500
modal: 600
toast: 700
```

## Motion

### Stop-Frame Animation

定格动画的核心：不是平滑过渡，而是"跳帧"的停顿感。

- **页面切换**: 3-4个关键帧，每帧停80-120ms，像翻书的瞬间
- **列表出现**: 卡片逐个"啪"地出现，间隔60ms，不渐变
- **状态变化**: 标签颜色切换时闪一下（像蜡笔换色）
- **按钮反馈**: 按下缩小到95%，弹回时过冲到102%再回到100%

### Timing Tokens

```
--ease-stutter: steps(3, end)           /* 定格跳帧 */
--ease-flick: cubic-bezier(0.3, 0, 1, 1) /* 快速翻页 */
--ease-settle: cubic-bezier(0.2, 0, 0, 1) /* 弹入稳定 */
--duration-flick: 120ms                  /* 翻帧 */
--duration-settle: 300ms                 /* 稳定 */
--duration-stagger: 60ms                 /* 逐项延迟 */
```

### Reduced Motion

```
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; }
}
```

## Components

### Card (手绘卡片)

卡片不是圆角矩形 + 阴影。它是一个"撕下来的便签纸"——边框不是完整的，有一个角微微翘起，边缘有不规则的锯齿感（用 box-shadow 堆叠模拟）。

### Button (蜡笔按钮)

主按钮像用蜡笔涂满的色块——边缘粗糙、颜色不均匀。次要按钮像用铅笔画的外框，中间留白。按下时按钮微微压扁，像真的在纸上按压。

### Tag/Label (标注标签)

食材状态标签是手写的涂鸦标记——新鲜是绿色蜡笔圈，临期是黄色蜡笔下划线，过期是红色蜡笔叉叉。

### Input (手写输入区)

输入框是横线纸的风格——淡蓝色横线、左边有红色竖线（像老式信纸），文字打在上面有"写在本子上"的感觉。

### Empty State (空场景)

不是居中的图标+文字。空状态是一幅完整的场景画——空冰箱里面只有一盏小灯亮着，旁边写着"还没放东西进去呢"，像绘本里的一页。

### Navigation Bar (手绘导航)

顶部导航背景是撕边的纸条，标题用马克笔风格的大字。

---

## 当前实现（2026-07，本文档的功能与交互基准）

本节描述仓库中已落地的界面；若与下方较早的概念说明冲突，以本节和源代码为准。

### 信息架构与导航

- 全局采用 **5 栏自定义底部导航**：`食材 / 菜谱 / 扫描 / 清单 / 我的`。
- 导航是固定的米色纸卡，带撕纸上缘、深褐手绘线稿图标、珊瑚红选中态和短横指示器。
- 顶部采用自定义导航栏。食材页顶部仅显示标题「食材」，不再提供重复的右侧添加加号；新增入口由页面 FAB 统一承担。
- 页面的可滚动内容必须为底部 Tab Bar 留出安全区，避免最后一行食材或操作按钮被遮挡。

### 食材页（`pages/index`）

页面结构由上到下为：主题场景图、横线纸搜索框、四项库存概览、最近添加横向卡片、分类筛选和食材清单。

- **主题场景图**：根据用户主题选择现有 `resource/theme-background/` 图片，使用 `widthFix` 满宽显示；不得替换主题图片或裁切人物主体。
- **库存概览**：固定为 `全部 / 常温 / 冷藏 / 冷冻` 四项，可直接切换食材筛选。
- **食材行**：包含食材图、名称、状态标签、储存位置、到期提示和纸张风数量调节器。新鲜、临期、过期必须同时使用文字与颜色表达状态。
- **空状态**：使用水彩空冰箱插画，并提供「添加食材」行动入口。
- **FAB（唯一新增入口）**：暖珊瑚不规则贴纸，配纸胶带翘角、手绘加号与「添一笔食材」文案；固定在 Tab Bar 之上并避开安全区。

#### 食材页 FAB 动效

| 场景 | 表现 | 时长 |
|---|---|---|
| 按下 | 向下压 3rpx，阴影缩短 | 150ms |
| 打开添加页 | 贴纸轻微掀角、上提、回落；加号旋转 45° | 180ms |
| 列表滚动 | 收为右下角圆形 `+`，滚动停止 260ms 后恢复胶囊 | 220ms + 260ms 停顿 |
| 新增食材返回 | 按钮改为叶绿「已记下」和勾选，出现一枚星屑后复原 | 1.2s |

动效只使用 `transform`、`opacity` 和阴影变化，不改变文档流；同一时刻 FAB 只出现一种状态。

### 扫描入库（`pages/scan-import`）

保留四步流程：`取景框 → 扫描中 → 识别结果 → 确认`。

- **识别结果**：食材以纸质卡片网格呈现，可拖入「冷藏 / 冷冻 / 常温」储藏卡，也可从卡片中撤回。
- **储藏卡**：代码渲染状态图标、标签、数量和拖拽高亮；背景以低透明度裁切水彩插画，分别呈现常温木箱、冷藏层、冷冻抽屉。
- **确认页**：使用水彩收纳箱成功插画，搭配真实的已入库清单、继续添加和完成操作。
- **取景框**：未拍照时，单件包装使用暖色厨房台面插画，小票模式使用夹着无文字小票的桌面插画；拍照完成后才以真实照片替换背景。不得使用深灰色占位或大面积黑色阴影。
- **扫描反馈**：点击取景框会触发彩铅对焦圈与食材贴纸吸向中心；扫描中使用珊瑚色虚线铅笔扫描线、淡黄高亮笔触，识别末段显示「已识别」手账印章。
- 识别、数量、状态、操作按钮等可读信息必须保持为 WXML 文本，不能烘焙进图片。

### 已生成位图素材

| 资源 | 用途 | 使用位置 |
|---|---|---|
| `resource/generated/empty-fridge-watercolor.png` | 空冰箱水彩场景 | 食材页空状态 |
| `resource/generated/storage-zones-watercolor.png` | 常温 / 冷藏 / 冷冻三联背景 | 扫描识别结果的储藏卡 |
| `resource/generated/import-success-watercolor.png` | 收纳箱与食材成功插画 | 扫描确认页 |
| `resource/generated/scan-packaging-counter.png` | 单件包装的厨房台面取景背景 | 扫描取景框 |
| `resource/generated/scan-receipt-counter.png` | 小票模式的夹纸取景背景 | 扫描取景框 |

这些素材不含 UI 文字、按钮、logo 或状态栏。图标、标签、按钮、数量控制、导航和交互反馈均由代码实现。

### 动效与可用性约束

- 微交互统一控制在 **150–300ms**；成功反馈可延长到 **1.2s**，但不阻塞点击。
- 触控目标最小保持约 88rpx（44px），固定控件不得贴近系统手势区。
- 使用 `hover-class` 或明确按下态；不依赖悬停作为唯一反馈。
- `prefers-reduced-motion` 下应降低非必要的 transition 与 animation。

---

## Scan-Import Feature（早期概念说明；实现细节以上方“当前实现”为准）

新增页面 `pages/scan-import/index`，替代原有的拍照/扫码标签页（add-ingredient 的 photo/scan tab 改为导航入口）。核心理念：**拍照优先，图像识别可视化，把食品从照片"提取"出来像贴纸一样散落在桌上，拖入储藏空间完成入库**。

### Flow (4 步状态机)

```
取景框 (viewfinder) → 扫描中 (scanning) → 识别结果 (results) → 确认 (confirm)
```

| 步骤 | 用户看到什么 | 用户做什么 |
|------|-------------|-----------|
| **viewfinder** | 手绘速写本取景框（4 角珊瑚色标记 + 模式切换：单件包装 / 购物小票） | 拍照或切换模式 |
| **scanning** | 照片去色 + 蜡笔扫描线从上到下划过 + 状态文字 | 等待（模拟 1.5-2s） |
| **results** | 食品贴纸散落在"厨房桌面"，每个带名称和保质期气泡；下方 3 个储藏空间卡 | 拖拽食品到对应储藏空间，或点击撤回 |
| **confirm** | 成功插画 + 已入库清单 + 继续添加/完成按钮 | 继续或退出 |

### Scattered Sticker Layout（贴纸散落桌面）

这是核心视觉灵感：识别出的食品像真贴纸撒在厨房台面上，互相重叠、角度不同。用户像在真实厨房里一样，从最上层的食品开始，一个一个"拿起"放进冰箱/冷冻/常温。

**实现要点**：
- 容器 `.scatter-table`：`position: relative; height: 520rpx; overflow: visible`
- 卡片 `.food-card`：`position: absolute; left/top` 由数据决定 + `transform: rotate(...)`
- 位置数据由 `posX/posY/posRot/posZ` 字段附加到每个 `RecognizedItem` 上
- 用质数相乘取模生成伪随机散落（避免规律性）：
  ```ts
  posX = (i * 137 + 59 + i * i * 29 + 13) % 360
  posY = (i * 199 + 73 + i * i * 37 + 31) % 400
  posRot = (i * 73 + 19 + i * i * 11) % 25 - 12  // -12° ~ +12°
  ```
- 卡片尺寸 190rpx 宽 + 圆形图标 72rpx + 散落在 360×400rpx 区域内 → 大量重叠

**已放置状态**：用 `item.isPlaced: boolean` 字段标记，`display: none` 完全从桌面消失（不是透明），露出被它遮挡的其他食品。

### Storage Zones（储藏空间）

3 个固定卡片，每个对应一个分类：
- ❄️ 冰箱冷藏 → `冷藏`
- 🧊 冰箱冷冻 → `冷冻`
- 🏠 常温储物 → `常温`

**视觉样式**：纸暗背景 `--color-paper-dark` + 3rpx 实线边框 + 大图标 + 标签 + 已入库存放区。
**已入库 mini 图标**：`flex-wrap: wrap; max-height: 80rpx; overflow-y: auto`，多件食品自动换行不撑破。
**拖拽悬停高亮** `.highlighted`：`scale(1.06)` + 珊瑚边框 + 多层 box-shadow 外发光 + 图标 `drop-shadow` + 标签变珊瑚色 + 字重 700。

### Drag-and-Drop 拖拽交互

**核心约束**：WeChat 中 `bindtouchmove` 绑在子元素时，手指移出该元素后事件会断开。**必须**用页面级 `catchtouchmove` + `catchtouchend` 持续跟踪手指位置。

**完整事件链**：
```
bindtouchstart on .food-card → onDragStart
  ↓ 设置 draggingIndex, dragOffsetX/Y, ghostEmoji
catchtouchmove on .page → onPageTouchMove
  ↓ 实时碰撞检测 → highlightedZone
catchtouchend on .page → onPageTouchEnd → _endDragWithIndex
  ↓ 命中空间 → 飞入动画 + addIngredient + placedItems/zones/recognizedItems 同步更新
  ↓ 未命中 → 重置 draggingIndex（弹回）
```

**防误触 tap**：`onDragStart` 设置 `_dragStarted = true`，`onFoodTap` 检测到此标志后清零并返回。

**Ghost 元素**：`position: fixed; left/top` 跟随手指 + `transform: scale(1.1) rotate(3deg)` + 珊瑚色 `drop-shadow`。松手命中后 400ms `ease-out-quint` 飞到 zone 中心并缩小淡出。

### Animation Choreography（编排）

| 时刻 | 动画 | 时长 |
|------|------|------|
| 扫描线 | 从上到下移动 + 轻微扩散光晕 | 1.8s |
| 扫描完成 | 白色闪光 | 400ms |
| 食品弹出 | `cutout-pop`：缩放 0.25→1.06→0.94→1 + 旋转 -10°→+3°→0° | 450ms |
| 储藏空间出现 | slide-up 逐项 | 300ms |
| 拖拽悬停 | zone 放大 + 边框 + 外发光 + 图标放大 | 150ms |
| 飞行命中 | ghost 飞向 zone 中心 + 缩放至 0.18 + 旋转 + 淡出 | 400ms |
| 接收脉冲 | `zone-receive`：scale 1.06→1.12→0.97→1 + 边框/背景色闪烁 | 450ms |

所有动画使用已有的 cubic-bezier 缓动（`--ease-out-quart/quint`），无 bounce/elastic。

---

## WeChat Mini Program 兼容性约束（踩坑记录）

基于实际开发中遇到的 WXSS/WXML 解析器限制，记录给未来的迭代：

### WXSS 禁止

- **标签选择器** `page {}`：在 Component() 定义的页面中不能使用标签名选择器，必须只使用 class
- **通配选择器** `> *`：WXSS 编译器报错，需改为显式类名（如 `anim-stagger-1`, `anim-stagger-2`）
- **`inset` 简写** `inset: 0`：展开为 `top/right/bottom/left: 0`
- **`:focus-within`** 伪类：Skyline 渲染器不支持
- **`display: flex` + `flex-shrink: 0` 约束 flex 链**：在 Skyline 中不可靠

### WXML 表达式限制

- **数组方法** `arr.indexOf()` 不支持：会静默失败返回 undefined，导致 `wx:if` 或三元表达式异常
- **数组下标变量访问** `{{arr[variable].prop}}`：需要先验证该表达式在 WXML 中可解析
- **复杂内联 style 表达式**：容易报错，优先用 CSS 类控制样式

### 解决方案模式

- **位置数据**：直接附加到对象上（`item.posX`），不要用单独的数组 `itemPositions[index]`
- **状态标记**：用 `item.isPlaced: boolean` 字段，不用 `placedItems.indexOf(index)` 推断
- **拖拽事件**：页面级 `catchtouchmove` + `catchtouchend`，不要只绑在子元素上
- **高度策略**：固定高度容器（如 `height: 520rpx`）比依赖 flex 链更可靠
- **覆盖全局 page**：用 `.page` 类选择器覆盖全局 `page` 元素的样式

---

## Components

### 食品提取元素（Food Cutout）

带圆形图标 + 名称 + 保质期的便签卡。在 scan-import 中作为绝对定位的贴纸使用。

### 储藏空间卡（Storage Zone）

纸暗背景卡片，带图标、标签、已入库存放区。响应拖拽悬停高亮 + 接收脉冲动画。

### 拖拽 Ghost（Drag Ghost）

`position: fixed` 跟随手指的图标副本。命中空间后飞入并缩小消失。
