"""发现层 → 控制面推送。

原庖丁解牛的发现把候选写进本地 SQLite 作为权威；整合后 **Node 控制面才是唯一权威**。
本模块只负责：抓 B站候选与元数据 → 调 Node `submitBilibili` 登记为 SYSTEM 教程候选
→ 调 `preflight` 让服务端用「仅元数据、播放量不放行」的规则判定是否为正常做饭教程。

预检 PASSED 的候选由管理员在 Dashboard `enqueue`，再由 paoding_worker 领取下载处理；
本模块**绝不触发下载**。

用法：
  python worker/discovery_push.py --source food_3day --limit 30
  python worker/discovery_push.py --source historical --limit 50
  python worker/discovery_push.py BV1xx... https://www.bilibili.com/video/BV2yy...
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import add_video, discover_cooking  # noqa: E402

BASE_URL = os.environ.get("PAODING_API_BASE", "http://127.0.0.1:8080")
TOKEN = os.environ.get("INGEST_API_TOKEN", "")
ACTOR = os.environ.get("PAODING_DISCOVERY_ACTOR", "bilibili-discovery-worker")


def _headers() -> dict[str, str]:
    return {"authorization": f"Bearer {TOKEN}", "x-actor-id": ACTOR}


async def _fetch_top_comments(bvid: str, limit: int = 5) -> list[dict]:
    """拉取视频高赞评论，返回最多 limit 条。"""
    try:
        from bilibili_api.video import Video
        from bilibili_api.comment import get_comments
        v = Video(bvid=bvid)
        info = await v.get_info()
        oid = info.get("aid") or info.get("id") or 0
        if not oid:
            return []
        comments = await get_comments(
            oid=oid,
            type_=1,       # 1=视频评论
            order=1,       # 1=按热度排序
            page_index=1,
        )
        items = []
        for c in (comments.get("replies") or [])[:limit]:
            items.append({
                "content": (c.get("content") or {}).get("message", ""),
                "likes": c.get("like", 0),
                "user": (c.get("member") or {}).get("uname", ""),
            })
        return items
    except Exception:
        return []


async def _candidate_metadata(item: dict, fetch_comments: bool = True) -> dict:
    """把 rank / search 归一化 item 映射成控制面 preflight 需要的元数据。
    额外拉取评论存入 _sourceData，供拆解环节使用。
    """
    stat = item.get("stat", {}) or {}
    owner = item.get("owner", {}) or {}
    tag = item.get("tag", "")
    tags = [t.strip() for t in tag.split(",")] if isinstance(tag, str) and tag else (tag if isinstance(tag, list) else [])
    bvid = item.get("bvid", "")

    # 拉取高赞评论
    top_comments = []
    if fetch_comments and bvid:
        top_comments = await _fetch_top_comments(bvid)

    metadata = {
        "title": item.get("title", ""),
        "description": item.get("desc") or item.get("description", ""),
        "tags": tags,
        "category": item.get("tname_v2") or item.get("tname") or item.get("typename", ""),
        "durationSeconds": int(item.get("duration", 0) or 0),
        "authorName": owner.get("name", ""),
        "viewCount": stat.get("view", 0),
        # 供拆解环节使用的额外上下文
        "_sourceData": {
            "description": item.get("desc") or item.get("description", ""),
            "tags": tags,
            "title": item.get("title", ""),
            "topComments": top_comments,
        },
    }
    return metadata


async def _fetch_candidates(source: str, limit: int) -> list[dict]:
    if source == "food_3day":
        items = await discover_cooking.fetch_ranking()
    elif source == "historical":
        items = await discover_cooking.fetch_historical()
    elif source == "ups":
        # ups 模式在 run() 中单独处理，这里返回空列表
        return []
    elif source == "auto":
        rank_items = await discover_cooking.fetch_ranking()
        hist_items = await discover_cooking.fetch_historical()
        seen, items = set(), []
        for it in [*rank_items, *hist_items]:
            bvid = it.get("bvid")
            if bvid and bvid not in seen:
                seen.add(bvid)
                items.append(it)
    else:
        raise ValueError(f"未知 source: {source}")
    return items[:limit]


def _push_one(client: httpx.Client, bvid: str, metadata: dict) -> dict:
    """登记 SYSTEM 候选并预检。返回控制面预检结论。"""
    submit = client.post(
        f"{BASE_URL}/v1/tutorials/bilibili",
        headers=_headers(), json={"bvid": bvid, "ownerType": "SYSTEM"}, timeout=30,
    )
    submit.raise_for_status()
    tutorial = submit.json()["data"]
    pre = client.post(
        f"{BASE_URL}/v1/tutorials/{tutorial['tutorialId']}/preflight",
        headers=_headers(), json={"metadata": metadata}, timeout=30,
    )
    pre.raise_for_status()
    return pre.json()["data"]


def run(source: str | None, limit: int, tokens: list[str]) -> int:
    if not TOKEN:
        print("❌ 缺 INGEST_API_TOKEN 环境变量（控制面内部令牌）", file=sys.stderr)
        return 2

    # 1) 组装候选（bvid + 元数据）。显式 token 优先。
    candidates: list[tuple[str, dict]] = []
    if tokens:
        for tok in tokens:
            try:
                bvid = add_video._parse_bvid(tok)
                info = asyncio.run(add_video._fetch_video_info(bvid))
                candidates.append((bvid, asyncio.run(_candidate_metadata(info, fetch_comments=True))))
            except Exception as exc:  # noqa: BLE001
                print(f"  跳过 {tok}: {exc}", file=sys.stderr)
    else:
        items = asyncio.run(_fetch_candidates(source or "food_3day", limit))
        for it in items:
            bvid = it.get("bvid")
            if bvid:
                candidates.append((bvid, asyncio.run(_candidate_metadata(it, fetch_comments=True))))

    # UP主模式：拉取已关注UP主的新视频
    if source == "ups":
        import sqlite3 as _sqlite3
        from engine.schema import DB_PATH
        db_con = _sqlite3.connect(DB_PATH)
        try:
            from engine.ups import crawl_all as ups_crawl_all
            results = ups_crawl_all(db_con, days=90, only_cooking=True, max_results=30, pages=2)
            for r in results:
                if r.get("status") == "ok":
                    # crawl_all 内部已通过 add_one_bvid 入库新视频
                    # 这里只需要把新增的视频推送到控制面
                    pass
            # 从SQLite读取本次新发现的视频
            mids = [r["mid"] for r in results if r.get("status") == "ok"]
            if mids:
                placeholders = ",".join("?" * len(mids))
                new_videos = db_con.execute(
                    f"SELECT bvid,title FROM videos WHERE up_mid IN ({placeholders}) AND discovered_via='ups' AND processing_status='new'",
                    mids,
                ).fetchall()
                for bvid, title in new_videos:
                    try:
                        info = asyncio.run(add_video._fetch_video_info(bvid))
                        candidates.append((bvid, asyncio.run(_candidate_metadata(info, fetch_comments=True))))
                    except Exception as exc:
                        print(f"  跳过 {bvid}: {exc}", file=sys.stderr)
        finally:
            db_con.close()

    if not candidates:
        print("没有候选可推送")
        return 0

    # 2) 逐条推送到控制面并预检。
    passed = rejected = manual = failed = 0
    with httpx.Client() as client:
        for bvid, metadata in candidates:
            try:
                result = _push_one(client, bvid, metadata)
                verdict = result.get("verdict")
                if verdict == "PASSED":
                    passed += 1
                elif verdict == "REJECTED":
                    rejected += 1
                else:
                    manual += 1
                print(f"  {bvid}  {verdict:<24} {metadata.get('title','')[:36]}")
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"  {bvid}  推送失败: {exc}", file=sys.stderr)

    print(f"\ndone. 通过={passed} 待人工={manual} 拒绝={rejected} 失败={failed} / 共 {len(candidates)}")
    print("通过项需在 Dashboard 或 /v1/tutorials/{id}/enqueue 入队后才会下载处理。")
    return 0 if failed == 0 else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="B站发现 → 控制面预检推送（不下载）")
    parser.add_argument("tokens", nargs="*", help="显式 BV 号或 B站视频 URL（给定则忽略 --source）")
    parser.add_argument("--source", choices=("auto", "food_3day", "historical", "ups"), default="food_3day")
    parser.add_argument("--limit", type=int, default=30)
    args = parser.parse_args(argv)
    return run(args.source, args.limit, args.tokens)


if __name__ == "__main__":
    raise SystemExit(main())
