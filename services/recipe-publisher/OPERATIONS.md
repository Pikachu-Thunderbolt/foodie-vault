# 庖丁解牛 后台 · 部署 / SOP / 测试手册

单容器：Node 控制面（Web/UI/`/v1` API/publisher）为主进程，内嵌并守护 Python 引擎 worker + 发现调度。发布后的媒体在微信云存储、结构化菜谱在云数据库，小程序照常读取。

---

## 一、部署到已连通的云（微信云托管）

控制面用 `wx-server-sdk` 读写与小程序**同一个云开发环境**（`foodie-vault-cloud-d7c230e4c1807`）的数据库与云存储，因此部署到**微信云托管**（跑 Docker 容器）最合适。

### 1. 建服务
- 微信云开发控制台 → **云托管** → 新建服务（如 `paoding-jieniu`），选用同一云开发环境。
- 部署方式选「本地代码/CLI 上传」或「Git 仓库」，**构建目录** `services/recipe-publisher`，**Dockerfile** 用该目录下的根 `Dockerfile`（已含 node20 + python3.12 + ffmpeg + 预下载 whisper）。
- **监听端口 8080**。

### 2. 挂载文件存储（重要）
- 给服务挂一个 **NFS/文件存储**到 `/data`（覆盖 `INGEST_ROOT`、`PAODING_EXPORT_ROOT` 的父目录和 `PAODING_DATA_DIR`）。
- 为什么要持久：流水线在**抽完候选帧后暂停等人工挑帧**，中间产物（SQLite/视频/帧）在 `PAODING_DATA_DIR`，必须跨越挑帧等待与容器重启存活；否则挑完帧导出时找不到帧要重跑。
- 单容器只挂给自己，**不需要跨服务共享盘**。若套餐暂不支持文件存储，可先单副本 + 容器盘（重启会丢中间态，需对未挑帧的教程重新入队）。

### 3. 环境变量（云托管服务配置）
| 变量 | 值 | 说明 |
|---|---|---|
| `EMBED_WORKER` | `true` | 主进程内嵌 worker + 发现调度 |
| `INGEST_API_TOKEN` | 长随机串 | 控制面内部令牌；小程序 tutorials 云函数要用同一个 |
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | 自定义 | Dashboard 登录 |
| `DASHBOARD_SESSION_SECRET` | 长随机串 | 会话签名（不设则退化用密码，建议单独设） |
| `CLOUDBASE_ENV` | `foodie-vault-cloud-d7c230e4c1807` | 云开发环境 ID |
| `NODE_ENV` | `production` | 缺 token 时启动即报错，防裸奔 |
| `INGEST_ROOT` / `PAODING_EXPORT_ROOT` | `/data/recipe-ingest/outgoing` | 处理包目录（同一路径） |
| `PAODING_DATA_DIR` | `/data/paoding-work` | 引擎中间产物（挂持久盘） |
| `WATCH_INGEST_ROOT` | `true` | 扫描 READY 包兜底 |
| `LLM_PROVIDER` | `openai_compatible` | 国产模型走 OpenAI 兼容接口 |
| `LLM_MODEL` | 如 `qwen-plus` / `deepseek-chat` / `glm-4-plus` | 结构化抽取模型 |
| `LLM_BASE_URL` | 厂商兼容接口地址 | 如 dashscope 兼容模式 |
| `LLM_API_KEY` | 模型密钥 | **只放这里，别进仓库/manifest** |
| `WHISPER_MODEL` | `base` | ASR 模型（tiny/base/small/…） |
| `DISCOVERY_INTERVAL_MS` | `0` 或 `>=3600000` | 定时发现；0=关，用手动 |

> 不要设 `USE_LOCAL_CLOUD`（那是本地假云）。`PAODING_TEXT_MODEL` 留空即可——它默认哨兵 `claude-sonnet-4-5` 会被 provider 层改用 `LLM_MODEL`。

### 4. 云数据库集合与权限
按 `cloudfunctions/README.md` 建齐用户集合 + 教程后台集合（`tutorials`、`tutorial_revisions`、`tutorial_processing_tasks`、`tutorial_review_requests`、`tutorial_audit_events`、`tutorial_frame_drafts`、`ingest_jobs`、`source_records`、`media_assets`、`recipes`、`recipe_versions`、`recipe_ingredients`、`recipe_steps`、`food_dictionary`、`dish_dictionary`、`dictionary_review_queue`）。
- 教程后台集合：**仅服务端可写**（云托管以服务端身份写，绕过权限）。
- 首次种子：`npm run build:seeds` → `npm run seed:cloud`（382 食材 / 180 菜品）。

### 5. 小程序侧对接
- 部署 `cloudfunctions/tutorials`，在其**环境变量**里配：
  - `PAODING_API_BASE` = 云托管服务的访问地址（公网或内网域名）
  - `INGEST_API_TOKEN` = 与控制面一致
- 详见 `cloudfunctions/README.md` 的部署 checklist。

### 6. 部署后自检
- `GET https://<服务地址>/healthz` → `{"ok":true}`
- 浏览器开 `https://<服务地址>/dashboard` → 用 `DASHBOARD_USER/PASSWORD` 登录
- 云托管日志出现 `worker 子进程已启动`

---

## 二、二期开发清单

1. **用户上传原始视频文件**：当前仅接受 B站 BV/链接；原始文件需加版权确认、对象存储直传、转码流程。
2. **「分享给指定人」share 映射**：`listPublic` 只覆盖 `visibility=PUBLIC`；`SHARED` 的定向可见需要一张 share 关系表（tutorialId × 目标 openid）+ 小程序读路径。
3. **用户教程「提交→预检→入队」自动串联**（当前缺口）：小程序 `submit` 只登记，未抓 B站元数据做 preflight、未 enqueue。需在 `cloudfunctions/tutorials` 的 submit 后触发控制面「抓元数据+preflight」，通过后自动/管理员 enqueue。系统教程走 `discovery_push` 已具备，用户教程要补这段。
4. **小程序用户端 UI 补全**：现有 `pages/tutorial-frames`（挑帧）+ `utils/tutorials.ts`。缺「我的教程」列表页、提交 B站页、自审/申请分享公开页、已发布教程详情/播放页（`listPublic`/`detail` 数据已就绪，缺展示页）。
5. **更新流程入口**：`requestUpdate` 有 API，小程序/后台缺可视化入口。
6. **发现运营增强**：候选批量入队、审核队列看板、UP 主订阅管理页（原 `discover_cooking`/`ups` 能力接入 Dashboard）。
7. **（可选）云端 ASR provider**：现容器内 faster-whisper 吃 CPU；量大可加 ASR provider 抽象层接腾讯云/阿里云 ASR（决策当前是容器内 whisper）。
8. **B站高清/受限视频**：现下载走匿名 UA，公开视频可用；如需会员/高清可加 `SESSDATA` cookie 注入。

---

## 三、UI 操作 SOP 与入口

### Dashboard 入口地图
| 页面 | 路径 | 作用 |
|---|---|---|
| 登录 | `/dashboard/login` | Basic 会话登录 |
| 总览 | `/dashboard` | 教程库 + 处理包两张表；顶部导航：发现/教程库/处理包/词典审核 |
| 发现 | `/dashboard/discover` | 按来源（三日榜/历史/合并）或手动 BV 触发发现+预检 |
| 教程详情 | `/dashboard/tutorials/{id}` | 状态、入队、去挑帧、系统审核发布、版本与审计 |
| 挑帧 | `/dashboard/tutorials/{id}/frames` | 每步从候选帧单选代表帧并提交 |
| 处理包详情 | `/dashboard/packages/{id}` | manifest 溯源、审核并公开发布 |
| 词典审核 | `/dashboard/dictionary` | 未匹配菜名/食材建为标准名 |

### SOP-A：系统教程（管理员全程）
1. **发现**：`/dashboard/discover` 选「美食三日榜」→ 开始发现（或手动填 BV → 加入并预检）。
2. **入队**：教程库点开一条 `PREFLIGHT_PASSED` 的教程 → 详情页点 **入队处理**。（`MANUAL_REVIEW`/`REJECTED` 不予处理）
3. **等处理**：worker 自动 下载→ASR→LLM→抽候选帧，状态到 **FRAMES_REVIEW**（详情页任务进度可见）。
4. **挑帧**：详情页点 **去挑代表帧** → 每个步骤选一张最能展示动作的图 → **确认挑帧并导出**。
5. **导出上云**：worker 按选定帧打包上云，版本变 `SYSTEM_REVIEW_REQUIRED`。
6. **发布**：详情页点 **系统通过发布**（要求来源授权 `cleared`、核心食材已标准化、无阻断质检）→ `PUBLISHED / PUBLIC`。
7. 小程序 `listPublic` 即可见。

### SOP-B：用户教程（用户 + 管理员）
> 说明：用户端「提交→预检→入队」自动串联属二期（见上）。当前可用路径：
1. 用户在小程序提交自有 B站链接（`submit`）→ 生成 `USER` 私有教程。
2. （二期补齐前）管理员在后台为其抓元数据预检并入队；worker 处理到 **FRAMES_REVIEW**。
3. **用户挑帧**：小程序 `pages/tutorial-frames?tutorialId=xxx` 逐步选图 → 提交 → 导出，版本 `OWNER_REVIEW_REQUIRED`。
4. 用户自审通过（`OWNER_APPROVE`）→ 可私有使用。
5. 要公开/分享：用户发起 `REQUEST_SHARE`/`REQUEST_PUBLIC` → 进入 **系统审核** → 管理员在后台 `SYSTEM_APPROVE` → 上架。

### SOP-C：词典审核
处理中未命中的菜名/食材进 `/dashboard/dictionary`，填标准名 → **建为标准名**；原名并入该主档别名，后续自动命中。核心食材未标准化会**阻断发布**。

---

## 四、本地开发测试

### 1. 单测（最快）
```bash
cd services/recipe-publisher
npm install
npm test        # 14 项：预检、双审核、挑帧状态机、鉴权、词典等
```

### 2. 只看 UI（离线假云，不起 worker）
```bash
USE_LOCAL_CLOUD=true INGEST_API_TOKEN=t DASHBOARD_USER=a DASHBOARD_PASSWORD=p \
  node src/server.js
# 打开 http://127.0.0.1:8080/dashboard （账号 a/密码 p）
```
- 数据落 `data/local-cloud-db.json`，媒体落 `data/local-cloud-storage/` 经 `/__localmedia` 显示。
- 不设 `EMBED_WORKER` → 不 spawn Python，纯 UI/状态机调试。

### 3. HTTP 全链路 E2E（不跑真实下载）
用 curl 走 `submit → preflight → enqueue → claim(PROCESS) → POST /v1/frames → POST .../draft → 挑帧 → claim(EXPORT)`，验证控制面+挑帧闭环（参见 README 的 E2E 段，已验证通过）。

### 4. 整包联调（起 worker，需外网 + 模型密钥）
```bash
cp .env.example .env    # 填 INGEST_API_TOKEN / DASHBOARD_* / LLM_*
docker compose up --build
# http://127.0.0.1:8080/dashboard
```
- 首次 build 会联网下载 whisper 模型；worker 处理需能访问 B站与 LLM 接口。
- 想在本机不装重依赖只跑 Node：`EMBED_WORKER=false`。

## 五、云端联调测试
1. 部署后 `GET /healthz` 正常、`/dashboard` 能登录。
2. `tutorials` 云函数配好 `PAODING_API_BASE`/`INGEST_API_TOKEN`。
3. 在 Dashboard 走一遍 **SOP-A**（建议先用一个已知的做饭教程 BV）：发现→入队→挑帧→发布。
4. 小程序调 `tutorials` 的 `listPublic`/`detail`，确认能读到刚发布的教程并正确渲染步骤图/食材。
5. 观察云托管日志与 `tutorial_processing_tasks`、`tutorial_audit_events` 集合核对每步状态流转。
