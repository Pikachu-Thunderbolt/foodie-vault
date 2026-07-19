# 庖丁解牛（原 recipe-publisher）

食光宝盒的做饭教程内容后台。目录沿用 `recipe-publisher` 以避免既有云托管构建路径失效，服务名、Dashboard 和 npm 包名已统一为“庖丁解牛”。部署到微信云开发云托管；不暴露管理员凭证给小程序。

## 它做什么

1. 接收 `INGEST_ROOT/{packageId}` 下已完成的处理包通知，或扫描带 `READY` 的目录。
2. 校验 `manifest.json`、媒体相对路径、文件大小和 SHA-256。
3. 按 SHA-256 去重上传图片到微信云存储。
4. 归档 `manifest.json` 到微信云存储，再写入 `ingest_jobs`、`source_records`、`media_assets`、`recipes`、`recipe_versions`、`recipe_ingredients`、`recipe_steps`。
5. 用 `food_dictionary` / `dish_dictionary` 标准化菜名和食材；未匹配或低置信度项自动写入 `dictionary_review_queue`。
6. 一律以 `DRAFT` / `WAITING_REVIEW` 入库，**不会自动公开发布**。
7. 统一管理 B站候选、下载前预检、处理任务、系统/用户双审核、教程版本和发布记录。

## 庖丁解牛教程后台：渠道、预检与审核

当前**仅接受 B站 BV 号或 B站视频 URL**，不接收其它平台链接，也不接收原始视频文件。用户“上传教程”在当前阶段指提交自己拥有/允许处理的 B站视频链接；原始文件上传需另行增加版权、存储和转码流程。

候选先只读取 B站元数据（标题、简介、标签、分区、时长），再运行 `preflight`。只有 `PREFLIGHT_PASSED` 才能生成下载任务；吃播、测评、探店、Vlog、过短/过长内容会拒绝，模糊内容进人工预检。**播放量永远不能作为“正常做饭教程”的放行条件。**

| 教程类型 | 首次审核 | 申请分享/公开 | 公开后的更新 |
| --- | --- | --- | --- |
| `SYSTEM` 系统教程 | 后台系统审核 | 系统审核通过且来源授权 `cleared` 后公开 | 新版本再次系统审核；旧公开版本持续可用直到替代版通过 |
| `USER` 用户教程 | 教程所有者自审，只能私有使用 | 所有者发起 `REQUEST_SHARE` / `REQUEST_PUBLIC`，进入系统审核 | 所有者发起更新 → 重新预检/处理/自审；若分享或公开，替代版必须再次系统审核 |

教程状态、处理任务、版本和所有审核决定均写入云端审计集合，后台管理员可查看并管理全部来源、全部发布与未发布内容。

详细 API 与部署边界见 [`resource/design/庖丁解牛_教程后台设计与运行规范_v1.0.md`](../../resource/design/庖丁解牛_教程后台设计与运行规范_v1.0.md)。

## 如何区分待上传、处理中、已上传与失败

云端 `ingest_jobs` 集合和 `GET /v1/packages/{packageId}` 的 `status` 是唯一权威状态；包目录内的 `publisher-receipt.json` 只是镜像回执。成功时 `manifest.json` 会归档到微信云存储并记录 `manifestCloudFileId`。

| 包目录 / 云端状态 | 含义 | 处理程序下一步 |
| --- | --- | --- |
| 有 `READY`，无 `publisher-receipt.json`，且没有云端任务 | 待上传 | 通知发布服务，或等待扫描器处理。 |
| `VALIDATING` / `UPLOADING_MEDIA` | 正在处理 | 不重复生成或修改包；轮询任务状态。 |
| `WAITING_REVIEW`，且有成功回执 | 已上传并已入库，等待内容审核 | 视为交付成功；不得修改原包。 |
| `PUBLISHED` | 已审核并公开发布 | 可记录 `recipeId`，供后续运营关联。 |
| `FAILED_VALIDATION` | 包或媒体不符合规范 | 修复后必须使用新的 `packageId` 重新输出。 |
| `FAILED_RETRYABLE` | 网络、云存储或临时服务错误 | 保持原包不变，使用同一 `packageId` 重试。 |

成功回执至少包含 `packageId`、`manifestHash`、`status`、`recipeId`、`versionId`、`completedAt`。同一 `packageId` 的已完成包再次通知会返回同一结果；若内容哈希变化，服务拒绝覆盖，避免“已上传包被悄悄改写”。

收到 `WAITING_REVIEW` 成功回执后，本地包可以安全删除：云端已保存媒体、结构化菜谱和原始 manifest。删除前不得清理；若服务重启或媒体上传失败，原始本地包仍是重试依据。成功前误删则必须以新的 `packageId` 重新交付。

## 内容发布 Dashboard

`GET /dashboard` 展示每个处理包的入库时间、状态、菜谱、对标来源平台/内容 ID/原始链接、授权状态和公开发布日期；点击处理包可查看完整溯源、manifest 云端归档标识、菜谱版本及本地目录是否仍存在。

详情页的“审核并公开发布”会执行发布门槛校验：来源授权必须为 `cleared`、菜谱主档和核心/必需食材已标准化、没有阻断质检错误。通过后写入 `publishedAt`，Dashboard 列表即可显示公开发布日期。

Dashboard 使用 `DASHBOARD_USER` / `DASHBOARD_PASSWORD` 的浏览器 Basic Auth，生产环境还应限制后台访问白名单。

词典审核使用受控接口 `POST /v1/review-queue/{queueId}/resolve`：可选择已有 `dictionaryId`（`action=map_existing`），或创建新的标准名（`action=create_new`，同时提交 `canonicalName` 和可选 `category`）。服务会把原始名称补进该主档的别名，标记队列项为 `RESOLVED`，后续 manifest 自动命中该映射。

## 处理程序的交付方式

```text
$INGEST_ROOT/{packageId}/
├── manifest.json
├── READY
└── media/
    └── {sha256}.webp
```

- `READY` 必须最后写入。
- `packageId` 必须与目录名一致。
- 图片独立交付，不使用 Base64 或 ZIP。
- 图片、食材和步骤字段要求见 `resource/design/食光宝盒_视频处理程序与云端交互参数规范_v1.0.md`。

## 运行与部署

整合后是**一个仓库、一个可部署容器**（`services/recipe-publisher/`）：Node 为主进程（Web/UI/API/publisher），启动时内嵌并守护 Python 引擎 worker + 发现调度子进程（`src/supervisor.js`）。同容器共享本地文件系统，manifest 交接无需跨服务共享云盘。

处理流水线带**人工挑帧暂停**：worker 下载→ASR→LLM→抽候选帧后登记草稿并暂停（`FRAMES_REVIEW`）；系统教程由管理员在 Dashboard `/dashboard/tutorials/{id}/frames` 挑代表帧，用户教程由用户在小程序挑；挑完生成 `EXPORT` 任务，worker 按选定帧导出→上云→登记版本→审核发布。

1. 在微信云开发创建**一个**云托管服务，构建目录选 `services/recipe-publisher`（用根 `Dockerfile`，内含 node+python+ffmpeg）。
2. 给该服务挂**一个**可写文件存储，覆盖 `INGEST_ROOT`/`PAODING_EXPORT_ROOT` 与 `PAODING_DATA_DIR`（`PAODING_DATA_DIR` 需持久，跨越挑帧暂停）。
3. 云托管密钥设置 `INGEST_API_TOKEN`（内部令牌）、`LLM_API_KEY`（大模型密钥）；`EMBED_WORKER=true`。云端大模型走 OpenAI 兼容国产模型（`LLM_PROVIDER=openai_compatible` + `LLM_MODEL` + `LLM_BASE_URL`）。
4. 创建下列云数据库集合，并限制为仅服务端可写：

   `ingest_jobs`、`source_records`、`media_assets`、`recipes`、`recipe_versions`、`recipe_ingredients`、`recipe_steps`、`food_dictionary`、`dish_dictionary`、`dictionary_review_queue`，以及教程后台集合 `tutorials`、`tutorial_revisions`、`tutorial_processing_tasks`、`tutorial_review_requests`、`tutorial_audit_events`、`tutorial_frame_drafts`。

5. 首次部署前运行 `npm run build:seeds`，再以受控服务身份运行 `npm run seed:cloud`。当前 P0 种子含 382 个高频食材、180 个常见菜品。
6. 小程序侧 `cloudfunctions/tutorials` 云函数：读已发布/自有教程与挑帧草稿走云数据库直查 + 临时 URL，治理写与用户挑帧代理到控制面内部 API（需配置 `PAODING_API_BASE` / `INGEST_API_TOKEN` 环境变量）。

内部接口（均要求内部 Bearer Token；用户身份由小程序云函数验证后以受控的 `x-actor-id` 传入）：

   - `POST /v1/packages`、`GET /v1/packages/{packageId}`、`GET /healthz`
   - `POST /v1/tutorials/bilibili`：登记系统或用户 B站教程候选。
   - `POST /v1/tutorials/{tutorialId}/preflight`：写入元数据预检结果；未通过不可下载。
   - `POST /v1/tutorials/{tutorialId}/enqueue`：仅预检通过后创建 PROCESS 任务。
   - `POST /v1/processing-tasks/claim`（body `kind`=PROCESS|EXPORT）、`/v1/processing-tasks/{taskId}/status`：worker 领取/回写任务。
   - `POST /v1/frames`：worker 上传候选帧到云存储（供挑帧显示）。
   - `POST /v1/tutorials/{tutorialId}/draft`、`GET .../draft`：登记/读取挑帧草稿。
   - `POST /v1/tutorials/{tutorialId}/frame-selection`：提交挑帧结果→生成 EXPORT 任务。
   - `POST /v1/tutorials/{tutorialId}/versions`：处理包上云后登记不可变教程版本。
   - `POST /v1/tutorials/{tutorialId}/review`：所有者自审、申请分享/公开、系统审核或拒绝。
   - `POST /v1/tutorials/{tutorialId}/updates`：发起更新，旧已发布版本不会被覆盖。

生产环境必须使用内部网关、访问白名单或短期服务令牌保护接口。不要把云开发管理员凭证、长期服务密钥或云数据库直写权限发给视频处理程序。Dashboard 内容：`/dashboard`（教程库/处理包）、`/dashboard/discover`（发现，定时+手动）、`/dashboard/tutorials/{id}`（详情/入队/系统审核/发布）、`/dashboard/tutorials/{id}/frames`（系统教程挑帧）、`/dashboard/dictionary`（词典审核）。

## 本地校验

```text
cd services/recipe-publisher
npm install
npm test

# 离线跑起整个后台（单容器：Node + 内嵌 Python worker，文件版假云，无需微信云）：
cp .env.example .env    # 填 INGEST_API_TOKEN / DASHBOARD_* / LLM_*
docker compose up --build
# Dashboard：http://127.0.0.1:8080/dashboard
```

`USE_LOCAL_CLOUD=true` 时控制面用 `src/local-cloud.js` 的文件版假云（数据落 `data/local-cloud-db.json`、媒体落 `data/local-cloud-storage/` 并经 `/__localmedia` 显示），确定性地绕开 `wx-server-sdk`；生产不设该变量则走真实云开发。不想在本地起 worker 子进程时设 `EMBED_WORKER=false`。
