# 食光宝盒 · 云函数清单

> Phase 0 + Phase 1 第一批交付。

## 环境

- 环境 ID：`foodie-vault-cloud-d7c230e4c1807`
- 客户端初始化位置：`miniprogram/app.ts` 的 `onLaunch`
- 客户端调用工具：`miniprogram/utils/cloud.ts`
- 用户状态：`miniprogram/utils/auth.ts`

## 已上线的云函数

### `login`
登录云函数。根据 `wx context` 自动拿到 `openid`，在 `users` 集合里**创建/更新**用户档案（昵称、头像、性别、偏好默认值）。

客户端调用：

```ts
import { loginWithProfile } from '../../utils/auth'

await loginWithProfile({ avatarUrl: cloudFileID, nickname: '小满' })
```

返回：

```json
{
  "code": 0,
  "data": {
    "openid": "oXxx...",
    "isNew": true,
    "user": {
      "_id": "...",
      "nickname": "小满",
      "avatarUrl": "cloud://...",
      "gender": "",
      "tastePreference": "any",
      "dietaryRestrictions": [],
      "difficultyLevel": "any",
      "reminderDays": 2,
      "themeGender": ""
    }
  }
}
```

### `sync`
通用同步云函数。支持 4 个 action：

| action | 用途 | 调用方 |
|--------|------|--------|
| `firstUpload` | 首次本地→云端一次性迁移 | `utils/migration.ts` |
| `pull` | 按 `updatedAt` 增量拉取 | `utils/sync.ts` |
| `upsert` | 单条 upsert（写操作通用入口，Phase 1.5 用） | `utils/sync-queue.ts`（即将实现） |
| `delete` | 单条删除 | `utils/sync-queue.ts`（即将实现） |
| `updatePrefs` | 把用户偏好合并到 users 文档 | profile 偏好保存 |

### `tutorials`
教程接入云函数（庖丁解牛后台）。**读**类动作直接查云数据库并换临时 URL；**治理写**类动作代理到庖丁解牛控制面内部 API（带 `x-actor-id=openid`）。

| action | 用途 | 依赖控制面 |
|--------|------|-----------|
| `listPublic` | 已发布公开教程列表 | 否（查云DB） |
| `listMine` | 我上传的教程 | 否 |
| `detail` | 教程详情（含步骤/食材/配图） | 否 |
| `getDraft` | 我的教程待挑帧候选帧 | 否 |
| `submit` | 提交自有 B站链接为用户教程 | 是 |
| `submitFrameSelection` | 提交用户挑帧结果 | 是 |
| `review` | 自审 / 申请分享公开 | 是 |
| `requestUpdate` | 发起教程更新 | 是 |

客户端调用工具：`miniprogram/utils/tutorials.ts`。

> ⚠️ **必须配环境变量**（否则治理写动作报「控制面未配置」）：在云开发控制台 → 云函数 → `tutorials` → 配置 → 环境变量：
> - `PAODING_API_BASE`：庖丁解牛控制面（云托管服务）公网地址
> - `INGEST_API_TOKEN`：与控制面一致的内部令牌

---

## 部署步骤

### 第一次部署

1. 在微信开发者工具中打开本项目，确认 `project.config.json` 中的 AppID 是要调试的 AppID。
2. 点击工具栏 **云开发**。若提示未开通，使用该 AppID 的管理员微信扫码开通，并创建或选择环境 `foodie-vault-cloud-d7c230e4c1807`。环境 ID 必须与 `miniprogram/app.ts`、`miniprogram/utils/cloud.ts` 中的配置一致。
3. 在云开发控制台的 **设置 → 环境设置** 确认该环境已关联当前小程序；非管理员调试时，还需在小程序后台的 **成员管理** 中添加为开发成员。
4. 终端进入 `cloudfunctions/`，执行：
   ```bash
   cd cloudfunctions
   npm install
   cd ..
   ```
5. 在 IDE 项目树里右键 `cloudfunctions/login` → **上传并部署：云端安装依赖（不上传 node_modules）**。
6. 同样上传 `cloudfunctions/sync`。
7. 同样上传 `cloudfunctions/tutorials`，然后在云开发控制台 → 云函数 → `tutorials` → **配置 → 环境变量** 添加 `PAODING_API_BASE` 和 `INGEST_API_TOKEN`（见上文 tutorials 小节）。
8. 在云开发控制台 → **云函数** 列表里能看到三个函数都处于 **部署成功** 状态。

### ✅ 部署快速 checklist（按顺序）

1. [ ] 云开发已开通，环境 ID = `foodie-vault-cloud-d7c230e4c1807`（与 `utils/cloud.ts` 一致）
2. [ ] `cd cloudfunctions && npm install`
3. [ ] 右键上传并部署 `login`
4. [ ] 右键上传并部署 `sync`
5. [ ] 右键上传并部署 `tutorials`，并配 `PAODING_API_BASE` / `INGEST_API_TOKEN` 环境变量
6. [ ] 建好下列集合并设权限（见「云数据库：建集合」）
7. [ ] 重新编译小程序，登录不再报 `FUNCTION_NOT_FOUND`

> 报 `FUNCTION_NOT_FOUND / -501000`＝对应云函数还没「上传并部署」。哪一个函数报就部署哪一个。

### 云数据库：建集合 + 权限

打开云开发控制台 → **数据库** → 逐个「新建集合」（不要勾"导入"），并按下表在每个集合的 **权限设置 → 安全规则（快捷模式）** 里选对应权限。

微信云开发权限快捷模式速记：
- **仅创建者可读写**：每个用户只能读写自己（按 `_openid`）创建的文档。用户私有数据用它。
- **所有用户不可读写**（下拉里描述「敏感信息，如仅管理员可读写的场景」）：客户端**完全不能**直连读写；只有云函数 / 云托管（管理端身份）能读写。后台数据用它——小程序通过 `tutorials` / `sync` 云函数间接访问，云函数是管理端、权限照样够。

#### A. 用户私有数据 → 仅创建者可读写
| 集合 | 用途 |
|---|---|
| `users` | 用户档案（login 写） |
| `ingredient_batches` | 食材批次 |
| `ingredient_masters` | 食材主数据 |
| `ingredient_transactions` | 出入库流水（sync 用的真实集合名） |
| `cooking_sessions` | 做饭会话 |
| `cooking_attempts` | 尝试记录 |
| `signature_dishes` | 拿手菜 |
| `pantry_product_profiles` | 商品档案 |
| `checklists` | 采购清单 |

#### B. 庖丁解牛后台数据 → 仅管理端可读写
（小程序只经 `tutorials` 云函数读已发布内容，从不直连，故全部锁死为仅管理端）

| 集合 | 用途 |
|---|---|
| `tutorials` | 教程主档（生命周期/归属/可见性） |
| `tutorial_revisions` | 教程版本 |
| `tutorial_processing_tasks` | 处理/导出任务队列（PROCESS/EXPORT） |
| `tutorial_review_requests` | 分享/公开申请 |
| `tutorial_audit_events` | 审计事件 |
| `tutorial_frame_drafts` | 挑帧草稿（候选帧 + 选择） |
| `ingest_jobs` | 处理包入库任务 |
| `source_records` | 来源溯源（B站等） |
| `media_assets` | 媒体资产（按 sha256 去重，含候选帧） |
| `recipes` | 菜谱主档（已发布） |
| `recipe_versions` | 菜谱版本快照 |
| `recipe_ingredients` | 版本食材 |
| `recipe_steps` | 版本步骤 |
| `food_dictionary` | 食材词典（种子 + 审核） |
| `dish_dictionary` | 菜品词典 |
| `dictionary_review_queue` | 词典待审队列 |

> 小程序「已发布教程」通过 `tutorials` 云函数（`listPublic`/`detail`）读取；即使 B 组是「仅管理端可读写」，云函数依然能读到并换临时 URL 返回给小程序。若将来想让小程序**直连**读某个集合（不经云函数），再把该集合改成「所有用户可读」。

**索引设置**：暂时不用建，等业务量起来再加。前 2 个月免费额度足够，乱建索引会拖慢写入。

---

## 端到端测试步骤

### 1. 登录流程

1. 编译并预览小程序（用管理员微信号）。
2. 应该看到 **登录页**（手绘锅物场景 + 蜡笔授权卡）。
3. 点击 **选头像** → 弹出微信选头像面板 → 任选一张。
4. 输入昵称 → 勾选 **我同意协议** → 点击 **进入小厨房**。
5. 等待 1–2 秒后跳到首页。

验证：
- [ ] `users` 集合出现 1 条记录，`nickname` / `avatarUrl` 都对得上。
- [ ] 控制台没有红色报错。
- [ ] `wx.getStorageSync('_openid_cache')` 有值。
- [ ] `wx.getStorageSync('_user_cache')` 有完整用户档案。

### 2. 真实用户档案显示

1. 进入 **我的** 页。
2. 头像区显示你选的微信头像（不是蜡笔画像）。
3. 昵称显示你输入的名字。
4. 头像区下方显示 `id · oXxx...`（openid 前 12 位 + 省略）。

验证：
- [ ] 头像清晰可见（说明 `wx.cloud.getTempFileURL` 跑通了）。
- [ ] 没有 "未登录" 红色标签。

### 3. 退出登录

1. 点击头像区 → 弹出 action sheet。
2. 选择 **退出登录**。
3. 二次确认 → 回到登录页。

验证：
- [ ] `_openid_cache` 和 `_user_cache` 被清空。
- [ ] 头像回到蜡笔画像（fallback）。

### 4. 多用户隔离

1. 在 **小程序后台 → 成员管理 → 体验成员** 加几个同事的微信号。
2. 用同事微信扫码预览。
3. 同事的 `users` 集合应该是另一条记录，openid 不同。

验证：
- [ ] 两个用户互不可见（云端 `_openid` 已隔离）。
- [ ] 各自的偏好/食材数据独立。

---

## 还没接的事（第二批要做的）

- [ ] `utils/repository/` —— 抽象仓储接口 + cloud 实现
- [ ] `utils/sync-queue.ts` —— 写操作重试队列
- [ ] `utils/storage.ts` 改造为本地写 + 异步上云的双层
- [ ] profile 偏好保存走 `sync.updatePrefs`
- [ ] 头像/昵称修改流程（重新打开 login 页 + 覆盖现有 users 文档）

---

## 已知限制 / 排雷

| 现象 | 原因 | 解决 |
|------|------|------|
| 头像一直是空白 | `cloud://` 路径没换临时 URL | profile.loadData 已自动调 `wx.cloud.getTempFileURL` |
| 点击"选头像"没反应 | 基础库 < 2.18 | 当前 `libVersion: 2.32.3` 没问题 |
| 登录页提交后无反应 | `wx.cloud.uploadFile` 失败 | 控制台看是否有 `cloud://` 权限错误；确认云开发控制台 → 设置 → 存储 已开通 |
| 提示“云开发服务未开通或当前小程序无权限” | 微信返回 `-601034` | 用当前 AppID 的管理员在开发者工具中开通云开发，并确认环境 ID 与代码一致 |
| 报 `missing openid` | 云函数测试时用错了入口 | 必须走小程序调用（IDE 上"云端测试"按钮是模拟 openid='mock'，不能直接验） |
| 报 `FUNCTION_NOT_FOUND` / `-501000`「FunctionName parameter could not be found」 | 对应云函数没上传部署 | 在资源管理器右键该函数 → **上传并部署**；`login`/`sync`/`tutorials` 各部署一次 |
| tutorials 报「控制面未配置」 | `tutorials` 云函数缺环境变量 | 云开发控制台 → 云函数 → tutorials → 配置 → 加 `PAODING_API_BASE` / `INGEST_API_TOKEN` |
