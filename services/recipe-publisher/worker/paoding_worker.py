"""庖丁解牛云端 worker 的控制面入口。

保留原庖丁解牛的处理顺序 download → ASR → LLM steps → frames → export，
但把 SQLite 队列替换为 recipe-publisher 的受控 API。这里的关键安全约束是：
worker 只领取服务端已标记为 PRECHECK_PASSED 的 B站任务；不能自行下载任意 URL。
重型运行环境建议放在 CloudBase 云托管容器，而不是云函数（ffmpeg/Whisper 需要较长 CPU 时间）。
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx

BASE_URL = os.environ.get("PAODING_API_BASE", "http://127.0.0.1:8080")
TOKEN = os.environ.get("INGEST_API_TOKEN", "")
WORKER_ID = os.environ.get("PAODING_WORKER_ID", "paoding-worker-1")
# 生产默认使用镜像内置引擎 worker/engine；仅本地迁移期可用 PAODING_LEGACY_ROOT 覆盖为原项目根目录。
LEGACY_ROOT = os.environ.get("PAODING_LEGACY_ROOT", "")
EXPORT_ROOT = Path(os.environ.get("PAODING_EXPORT_ROOT", "/data/recipe-ingest/outgoing"))
# 引擎的中间产物（SQLite、视频、转写、帧）以工作目录为相对基准，必须可写。
DATA_DIR = Path(os.environ.get("PAODING_DATA_DIR", "/data/paoding-work"))


def _headers() -> dict[str, str]:
    return {"authorization": f"Bearer {TOKEN}", "x-actor-id": WORKER_ID}


def update(task_id: str, status: str, progress: str = "", error: str | None = None) -> None:
    response = httpx.post(
        f"{BASE_URL}/v1/processing-tasks/{task_id}/status", headers=_headers(),
        json={"status": status, "progress": progress, "error": error}, timeout=30,
    )
    response.raise_for_status()


def _load_engine():
    """加载处理引擎模块。

    生产默认使用镜像内置的 `worker/engine`（原庖丁解牛 src 的 vendored 副本）。
    仅当设置了有效的 `PAODING_LEGACY_ROOT` 时，才改用原项目根目录下的 `src` 包，
    方便本地迁移期直接复用未打包的模块。返回引擎子模块命名空间。
    """
    if LEGACY_ROOT:
        root = Path(LEGACY_ROOT).resolve()
        if not (root / "src" / "process.py").exists():
            raise RuntimeError(f"无效的 PAODING_LEGACY_ROOT: {root}")
        sys.path.insert(0, str(root))
        from src import add_video, download, extract_frames, extract_steps, transcribe, export  # type: ignore
        from src.schema import init_db  # type: ignore
    else:
        # `python worker/paoding_worker.py` 时 sys.path[0] 即 worker/，engine 为其子包。
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from engine import add_video, download, extract_frames, extract_steps, transcribe, export  # type: ignore
        from engine.schema import init_db  # type: ignore
    return add_video, download, transcribe, extract_steps, extract_frames, export, init_db


def _upload_frame(path: str) -> str:
    """上传一张候选帧到控制面云存储，返回 cloudFileId。"""
    import base64
    data = base64.b64encode(Path(path).read_bytes()).decode("ascii")
    resp = httpx.post(f"{BASE_URL}/v1/frames", headers=_headers(), json={"data": data, "mimeType": "image/jpeg"}, timeout=120)
    resp.raise_for_status()
    return resp.json()["data"]["cloudFileId"]


def _run_process_stage(tutorial: dict[str, Any], task_id: str) -> dict[str, Any]:
    """PROCESS：下载→ASR→LLM→抽候选帧 → 上传候选帧 + 登记草稿（暂停等人工挑帧）。

    不做 export；关键帧供审核者从候选里挑选。中间产物留在 PAODING_DATA_DIR，
    供后续 EXPORT 阶段复用（云端该目录需为持久卷）。
    """
    bvid = tutorial["bvid"]
    add_video, download, transcribe, extract_steps, extract_frames, export, init_db = _load_engine()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    old_cwd = Path.cwd()
    os.chdir(DATA_DIR)
    try:
        con = init_db()
        add_video.add_one_bvid(bvid, con, discovered_via="paoding_cloud", verbose=False)
        update(task_id, "DOWNLOADING", "下载 B站原视频")
        result = download.download_one(bvid, con)
        if not result.ok:
            raise RuntimeError(f"下载失败: {result.error}")
        update(task_id, "TRANSCRIBING", "Whisper 转写")
        result = transcribe.transcribe_one(bvid, con, model_name=os.environ.get("WHISPER_MODEL", "base"))
        if not result.ok:
            raise RuntimeError(f"转写失败: {result.error}")
        update(task_id, "EXTRACTING", "抽取食材、教程步骤与候选关键帧")
        # 从控制面获取 sourceData（含标题/简介/评论）
        source_data = None
        try:
            tutorial_resp = httpx.get(
                f"{BASE_URL}/v1/tutorials/{tutorial['tutorialId']}",
                headers=_headers(),
                timeout=10,
            )
            tutorial_detail = tutorial_resp.json().get("data", {})
            tutorial_full = tutorial_detail.get("tutorial", {})
            source_data = tutorial_full.get("sourceData") or tutorial_full.get("sourceMeta") or {}
        except Exception:
            pass

        parsed = extract_steps.extract_one(bvid, con, model=os.environ.get("PAODING_TEXT_MODEL", "claude-sonnet-4-5"), source_data=source_data)
        extract_frames.extract_frames_for(bvid, con, include_context=True)

        # 组装每步候选帧并上传。
        steps_rows = con.execute("SELECT idx, name, description FROM steps WHERE bvid=? ORDER BY idx", (bvid,)).fetchall()
        frames_rows = con.execute("SELECT step_idx, frame_type, path FROM frames WHERE bvid=? ORDER BY step_idx, frame_type", (bvid,)).fetchall()
        frames_by_step: dict[int, list[tuple[str, str]]] = {}
        for step_idx, frame_type, path in frames_rows:
            frames_by_step.setdefault(step_idx, []).append((frame_type, path))

        steps_payload = []
        for idx, name, description in steps_rows:
            candidates = []
            for slot, (frame_type, path) in enumerate(frames_by_step.get(idx, [])):
                try:
                    cloud_file_id = _upload_frame(path)
                except Exception as exc:  # noqa: BLE001 — 单帧上传失败不阻断其它候选。
                    print(f"[paoding-worker] 上传候选帧失败 step{idx} {frame_type}: {exc}", file=sys.stderr)
                    continue
                candidates.append({"frameType": frame_type, "slot": slot, "cloudFileId": cloud_file_id})
            steps_payload.append({"stepIndex": idx, "name": name, "description": description, "candidates": candidates})

        body = {"recipeName": parsed.get("recipe_name", ""), "steps": steps_payload}
        resp = httpx.post(f"{BASE_URL}/v1/tutorials/{tutorial['tutorialId']}/draft", headers=_headers(), json=body, timeout=60)
        resp.raise_for_status()
        return resp.json().get("data") or {}
    finally:
        os.chdir(old_cwd)


def _run_export_stage(tutorial: dict[str, Any], task_id: str) -> dict[str, Any]:
    """EXPORT：读挑帧结果 → 写 approval_frames → export → 上云 → 登记版本。"""
    bvid = tutorial["bvid"]
    draft_resp = httpx.get(f"{BASE_URL}/v1/tutorials/{tutorial['tutorialId']}/draft", headers=_headers(), timeout=30)
    draft_resp.raise_for_status()
    draft = (draft_resp.json().get("data") or {}).get("draft") or {}
    selection = draft.get("selection") or []
    if not selection:
        raise RuntimeError("缺少挑帧结果，无法导出")

    add_video, download, transcribe, extract_steps, extract_frames, export, init_db = _load_engine()
    old_cwd = Path.cwd()
    os.chdir(DATA_DIR)
    try:
        con = init_db()
        # 用挑选结果覆盖 approval_frames（export 从这里读代表帧）。
        con.execute("DELETE FROM approval_frames WHERE bvid=?", (bvid,))
        for sel in selection:
            step_idx = sel["stepIndex"]
            frame_type = sel["frameType"]
            slot = sel.get("slot", 0)
            row = con.execute("SELECT path FROM frames WHERE bvid=? AND step_idx=? AND frame_type=?", (bvid, step_idx, frame_type)).fetchone()
            if not row:
                continue
            con.execute(
                "INSERT OR REPLACE INTO approval_frames(bvid, step_idx, slot_idx, frame_type, frame_path, updated_at) VALUES(?,?,?,?,?,datetime('now'))",
                (bvid, step_idx, 0, frame_type, row[0]),
            )
        con.commit()
        update(task_id, "PACKAGING", "按选定帧生成 manifest 与 WebP")
        manifest = export.export_one(bvid, con, output_root=EXPORT_ROOT)
        _publish_and_register(tutorial, manifest, EXPORT_ROOT / manifest["packageId"])
        return manifest
    finally:
        os.chdir(old_cwd)


def _publish_and_register(tutorial: dict[str, Any], manifest: dict[str, Any], package_dir: Path) -> None:
    package_path = package_dir.name
    response = httpx.post(f"{BASE_URL}/v1/packages", headers=_headers(), json={"packagePath": package_path}, timeout=30)
    response.raise_for_status()
    # 上传为异步；轮询权威 ingest job，收到 recipe/version 后才登记教程版本。
    for _ in range(90):
        job = httpx.get(f"{BASE_URL}/v1/packages/{manifest['packageId']}", headers=_headers(), timeout=30)
        job.raise_for_status()
        data = job.json().get("data") or {}
        if data.get("status") in {"WAITING_REVIEW", "PUBLISHED"}:
            body = {
                "packageId": manifest["packageId"], "recipeId": data["recipeId"], "versionId": data["versionId"],
                "manifestHash": data.get("manifestHash"), "changeSummary": "庖丁解牛处理结果",
            }
            registered = httpx.post(f"{BASE_URL}/v1/tutorials/{tutorial['tutorialId']}/versions", headers=_headers(), json=body, timeout=30)
            registered.raise_for_status()
            return
        if str(data.get("status", "")).startswith("FAILED"):
            raise RuntimeError(f"处理包发布失败: {data.get('lastError')}")
        time.sleep(2)
    raise TimeoutError("等待处理包上云超时")


def _handle_task(task: dict[str, Any]) -> None:
    tutorial = task["tutorial"]
    # 服务端已验证平台和预检 verdict；仍在 worker 内断言，防止实现回退。
    if tutorial["platform"] != "bilibili" or tutorial.get("preflight", {}).get("verdict") != "PASSED":
        raise RuntimeError("refuse download: tutorial has not passed cooking preflight")
    task_id = task["taskId"]
    kind = task.get("kind", "PROCESS")
    if kind == "EXPORT":
        manifest = _run_export_stage(tutorial, task_id)
        update(task_id, "COMPLETED", "处理包已上云并登记教程版本")
        print(json.dumps({"taskId": task_id, "kind": kind, "tutorialId": tutorial["tutorialId"], "packageId": manifest["packageId"]}, ensure_ascii=False))
    else:
        draft = _run_process_stage(tutorial, task_id)
        print(json.dumps({"taskId": task_id, "kind": kind, "tutorialId": tutorial["tutorialId"], "stepCount": draft.get("stepCount")}, ensure_ascii=False))


def claim(kind: str = "PROCESS") -> dict[str, Any] | None:
    response = httpx.post(f"{BASE_URL}/v1/processing-tasks/claim", headers=_headers(), json={"workerId": WORKER_ID, "kind": kind}, timeout=30)
    response.raise_for_status()
    return response.json().get("data")


def run_once() -> int:
    # 先 EXPORT 后 PROCESS：让挑完帧的尽快出片。
    task = claim("EXPORT") or claim("PROCESS")
    if not task:
        print("no eligible Bilibili task")
        return 0
    try:
        _handle_task(task)
        return 0
    except Exception as exc:  # noqa: BLE001
        update(task["taskId"], "FAILED", error=f"{type(exc).__name__}: {exc}")
        raise


def run_forever() -> int:
    """容器常驻模式：轮询领取 EXPORT/PROCESS 任务，无任务时按 PAODING_POLL_SECONDS 休眠。

    单个任务失败不影响 worker 存活，只标记该任务 FAILED 后继续下一条。
    """
    interval = max(5, int(os.environ.get("PAODING_POLL_SECONDS", "20")))
    print(f"[paoding-worker] loop mode; base={BASE_URL} poll={interval}s")
    while True:
        try:
            task = claim("EXPORT") or claim("PROCESS")
            if not task:
                time.sleep(interval)
                continue
            try:
                _handle_task(task)
            except Exception as exc:  # noqa: BLE001
                update(task["taskId"], "FAILED", error=f"{type(exc).__name__}: {exc}")
                print(f"[paoding-worker] task {task['taskId']} failed: {exc}", file=sys.stderr)
        except KeyboardInterrupt:
            print("[paoding-worker] interrupted; exiting")
            return 0
        except Exception as exc:  # noqa: BLE001 — 控制面暂时不可达等，稍后重试。
            print(f"[paoding-worker] claim/loop error: {exc}", file=sys.stderr)
            time.sleep(interval)


if __name__ == "__main__":
    if "--once" in sys.argv:
        raise SystemExit(run_once())
    raise SystemExit(run_forever())
