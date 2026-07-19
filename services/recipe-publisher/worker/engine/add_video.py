"""手动加视频（按 bvid 或 B 站 URL）。

不需要走发现流程；直接 fetch 视频信息并入库。
后续可由 process next / 用户手动触发处理。
"""
from __future__ import annotations

import argparse
import asyncio
import re
import sqlite3
import sys
from datetime import datetime, timezone

from bilibili_api.video import Video

from .schema import DB_PATH, init_db

SAFE_BVID = re.compile(r"^BV[0-9A-Za-z]+$")


def _parse_bvid(token: str) -> str:
    token = token.strip()
    if SAFE_BVID.match(token):
        return token
    m = re.search(r"(BV[0-9A-Za-z]+)", token)
    if m:
        return m.group(1)
    raise ValueError(f"无法从 '{token}' 解析出 bvid（需要 BV 号或 B 站视频 URL）")


async def _fetch_video_info(bvid: str) -> dict:
    v = Video(bvid=bvid)
    info = await v.get_info()
    stat = info.get("stat", {})
    owner = info.get("owner", {})
    return {
        "bvid": bvid,
        "title": info.get("title", ""),
        "up_mid": owner.get("mid", 0),
        "up_name": owner.get("name", ""),
        "duration": info.get("duration", 0),
        "view_count": stat.get("view", 0),
        "like_count": stat.get("like", 0),
        "coin_count": stat.get("coin", 0),
        "fav_count": stat.get("favorite", 0),
        "share_count": stat.get("share", 0),
        "danmaku_count": stat.get("danmaku", 0),
        "reply_count": stat.get("reply", 0),
        "pubdate": info.get("pubdate", 0),
        "tname": info.get("tname_v2") or info.get("tname", ""),
        "desc": info.get("desc", ""),
    }


def _quality_score(info: dict) -> float:
    """从 view/like/reply 算一个初始 quality_score（与 discover 层一致）。"""
    import math
    view = max(info["view_count"], 1)
    pop = math.log10(view + 1) * 10
    eng = (info["like_count"] + info["coin_count"] * 2 + info["fav_count"] * 1.5) / view * 100
    ideal = 10 if 120 <= info["duration"] <= 600 else 0
    return round(pop + eng + ideal, 2)


def add_one_bvid(bvid: str, con: sqlite3.Connection,
                 *, discovered_via: str = "manual",
                 verbose: bool = False) -> dict:
    """入库单条视频。已存在则跳过。"""
    existing = con.execute(
        "SELECT bvid, title, discovered_via, last_seen_at FROM videos WHERE bvid=?",
        (bvid,),
    ).fetchone()
    if existing:
        if verbose:
            print(f"  跳过 {bvid}（已存在，discovered_via={existing[2]}）")
        return {"bvid": bvid, "status": "exists", "discovered_via": existing[2]}

    try:
        info = asyncio.run(_fetch_video_info(bvid))
    except Exception as e:  # noqa: BLE001
        if verbose:
            print(f"  拉 {bvid} 失败：{e}")
        return {"bvid": bvid, "status": f"fetch_error: {e}"}

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    score = _quality_score(info)

    con.execute("""
        INSERT INTO videos(
            bvid, title, up_mid, up_name, duration,
            view_count, like_count, coin_count, fav_count, share_count,
            danmaku_count, reply_count, pubdate, tname, desc,
            has_subtitle, subtitle_count, quality_score,
            first_seen_at, last_seen_at, status, processing_status, last_processed_at, discovered_via
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        info["bvid"], info["title"], info["up_mid"], info["up_name"], info["duration"],
        info["view_count"], info["like_count"], info["coin_count"], info["fav_count"], info["share_count"],
        info["danmaku_count"], info["reply_count"], info["pubdate"], info["tname"], info["desc"],
        0, 0, score,
        now, now, "new", "new", None, discovered_via,
    ))
    con.commit()
    if verbose:
        print(f"  ✓ {bvid}  {info['title'][:40]}  评分 {score}  via {discovered_via}")
    return {"bvid": bvid, "status": "added", "discovered_via": discovered_via, "score": score}


def add(token: str, con: sqlite3.Connection | None = None,
        *, discovered_via: str = "manual") -> dict:
    """从 token（bvid 或 URL）入库。"""
    con = con or init_db()
    bvid = _parse_bvid(token)
    return add_one_bvid(bvid, con, discovered_via=discovered_via, verbose=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description="手动加视频到发现库")
    parser.add_argument("token", help="BV 号或 B 站视频 URL")
    parser.add_argument("--via", default="manual",
                        choices=("manual", "ups", "historical", "food_3day"),
                        help="发现来源标签")
    args = parser.parse_args(argv)
    r = add(args.token, discovered_via=args.via)
    return 0 if r["status"] in ("added", "exists") else 1


if __name__ == "__main__":
    sys.exit(main())
