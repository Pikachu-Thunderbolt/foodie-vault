"""UP 主关注模块。

用法：
  .venv/bin/python -m src.ups add <mid>           # 关注一个 UP
  .venv/bin/python -m src.ups add <url>           # 也支持 B 站个人空间 URL
  .venv/bin/python -m src.ups remove <mid>
  .venv/bin/python -m src.ups list                # 看已关注
  .venv/bin/python -m src.ups crawl               # 一次性拉所有关注 UP 的新视频
  .venv/bin/python -m src.ups crawl <mid>         # 单个 UP 拉新视频
"""
from __future__ import annotations

import argparse
import asyncio
import re
import sqlite3
import sys
from datetime import datetime, timezone
from typing import Iterable

from bilibili_api.user import User
from bilibili_api.utils import network as _bili_network

from .add_video import add_one_bvid
from .schema import DB_PATH, init_db

SAFE_MID = re.compile(r"^\d{1,19}$")


# 修正 bilibili-api 默认 headers——否则 B 站风控会 412 拦截
_bili_network.HEADERS.update({
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/120.0.0.0 Safari/537.36"),
    "Referer": "https://www.bilibili.com/",
})


# 美食相关分区（用于 only_cooking 过滤）
COOKING_TNAMES = (
    "美食制作", "美食侦探", "美食测评",
    "家常菜", "菜谱", "烹饪", "烘焙", "甜品",
    "小吃", "夜宵", "早餐", "便当", "减脂餐", "饮品",
    "家常", "料理",
)
# 排序字段映射（key → 取值函数）
SORT_KEYS = {
    "pubdate":  lambda v: v.get("pubdate", 0),
    "view":     lambda v: v.get("view", 0),
    "favorite": lambda v: v.get("favorite", 0),
    "like":     lambda v: v.get("like", 0),
    "reply":    lambda v: v.get("reply", 0),
    "coin":     lambda v: v.get("coin", 0),
}


def _resolve_mid(token: str) -> int:
    """token 可能是 mid（纯数字）或 B 站个人空间 URL，从中提取 mid。"""
    if SAFE_MID.match(token):
        return int(token)
    # 常见 URL 形式：
    #   https://space.bilibili.com/123456
    #   https://space.bilibili.com/123456?from=...
    m = re.search(r"space\.bilibili\.com/(\d+)", token)
    if m:
        return int(m.group(1))
    raise ValueError(f"无法从 '{token}' 解析出 mid（需要纯数字或 space.bilibili.com URL）")


async def _get_user_info(mid: int) -> dict:
    u = User(uid=mid)
    info = await u.get_user_info()
    return {
        "mid": info["mid"],
        "name": info["name"],
        "sign": info.get("sign", ""),
    }


def add(mid_or_url: str, con: sqlite3.Connection | None = None) -> dict:
    """关注一个 UP。同 mid 已存在则不重复加。"""
    con = con or init_db()
    mid = _resolve_mid(mid_or_url)
    existing = con.execute(
        "SELECT mid, name, active FROM up_subscriptions WHERE mid=?", (mid,)
    ).fetchone()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if existing:
        # 重新激活
        con.execute(
            "UPDATE up_subscriptions SET active=1, name=COALESCE(NULLIF(name,''), ?) WHERE mid=?",
            (f"UP_{mid}", mid),
        )
        con.commit()
        return {"mid": mid, "name": existing[1], "status": "reactivated"}

    # 拉 UP 真名（异步转同步）
    name = f"UP_{mid}"
    try:
        info = asyncio.run(_get_user_info(mid))
        name = info["name"]
    except Exception as e:  # noqa: BLE001
        print(f"  警告：拉 UP 名称失败 ({e})，用 mid 暂代")
    con.execute("""
        INSERT INTO up_subscriptions(mid, name, added_at, active)
        VALUES(?, ?, ?, 1)
    """, (mid, name, now))
    con.commit()
    return {"mid": mid, "name": name, "status": "added"}


def remove(mid_or_url: str, con: sqlite3.Connection | None = None) -> dict:
    """取消关注（软删除：active=0，保留记录）。"""
    con = con or init_db()
    mid = _resolve_mid(mid_or_url)
    cur = con.execute("UPDATE up_subscriptions SET active=0 WHERE mid=?", (mid,))
    con.commit()
    if cur.rowcount == 0:
        return {"mid": mid, "status": "not_found"}
    return {"mid": mid, "status": "removed"}


def list_ups(con: sqlite3.Connection | None = None) -> list[dict]:
    con = con or init_db()
    rows = con.execute("""
        SELECT s.mid, s.name, s.added_at, s.last_checked_at, s.last_video_pubdate,
               s.last_video_bvid, s.active,
               (SELECT COUNT(*) FROM videos v
                WHERE v.up_mid=s.mid AND v.processing_status IN ('new','downloaded','transcribed','parsed','framed')) AS n_pending,
               (SELECT COUNT(*) FROM videos v
                WHERE v.up_mid=s.mid AND v.processing_status='approved') AS n_approved,
               (SELECT COUNT(*) FROM videos v
                WHERE v.up_mid=s.mid) AS n_total
        FROM up_subscriptions s
        WHERE s.active=1
        ORDER BY s.added_at DESC
    """).fetchall()
    return [
        {
            "mid": r[0], "name": r[1],
            "added_at": r[2], "last_checked_at": r[3],
            "last_video_pubdate": r[4], "last_video_bvid": r[5],
            "active": r[6],
            "n_pending": r[7] or 0, "n_approved": r[8] or 0, "n_total": r[9] or 0,
        }
        for r in rows
    ]


async def _fetch_user_videos(mid: int, max_count: int = 30, pages: int = 1) -> list[dict]:
    """拉 UP 视频。pages=1 拿最近 30，pages=2 拿最近 60…"""
    u = User(uid=mid)
    result: list[dict] = []
    for pn in range(1, pages + 1):
        try:
            ps = min(max_count, 30)
            videos = await u.get_videos(pn=pn, ps=ps)
        except Exception:  # noqa: BLE001
            break
        lst = videos.get("list", {}) if isinstance(videos, dict) else {}
        vlist = lst.get("vlist", []) if isinstance(lst, dict) else []
        if not vlist:
            break
        for v in vlist:
            if not isinstance(v, dict):
                continue
            bvid = v.get("bvid")
            if not bvid:
                continue
            result.append({
                "bvid": bvid,
                "title": v.get("title", ""),
                "pubdate": v.get("created", 0),
                "duration": v.get("length", ""),
                "play": v.get("play", 0),
                "view": v.get("play", 0),
                "like": v.get("like", 0),
                "favorite": v.get("favorites", 0) or v.get("favorite", 0),
                "reply": v.get("reply", 0),
                "coin": v.get("video_review", 0),  # 接口里没 coin，用 video_review 兜底
                "tname": v.get("typename", "") or v.get("tname", ""),
            })
            if len(result) >= max_count:
                break
        if len(result) >= max_count or len(vlist) < ps:
            break
    return result


def _filter_and_sort(videos: list[dict], *,
                     days: int | None = None,
                     only_cooking: bool = False,
                     sort_by: str = "pubdate",
                     max_results: int | None = None) -> list[dict]:
    """过滤 + 排序。注意：这是 in-memory 过滤，B 站接口已经先按 pubdate 拉过来。"""
    from datetime import datetime, timezone, timedelta

    out = list(videos)
    # 时间窗
    if days is not None and days > 0:
        cutoff = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
        out = [v for v in out if v.get("pubdate", 0) >= cutoff]
    # 仅做菜相关
    if only_cooking:
        out = [v for v in out if v.get("tname", "") in COOKING_TNAMES
                or any(kw in (v.get("title") or "") for kw in ("菜谱", "教程", "做法", "配方"))]
    # 排序
    key_fn = SORT_KEYS.get(sort_by, SORT_KEYS["pubdate"])
    out.sort(key=key_fn, reverse=True)
    # 截断
    if max_results:
        out = out[:max_results]
    return out


def refresh_name(mid: int, con: sqlite3.Connection | None = None) -> dict:
    """重新拉一次 UP 名称回填。"""
    con = con or init_db()
    try:
        info = asyncio.run(_get_user_info(mid))
    except Exception as e:  # noqa: BLE001
        return {"mid": mid, "status": f"fetch_error: {e}"}
    name = info["name"]
    con.execute("UPDATE up_subscriptions SET name=? WHERE mid=?", (name, mid))
    con.commit()
    return {"mid": mid, "name": name, "status": "refreshed"}


def crawl_one(mid: int, con: sqlite3.Connection | None = None, *,
              days: int | None = None,
              only_cooking: bool = False,
              sort_by: str = "pubdate",
              max_results: int | None = None,
              pages: int = 1) -> dict:
    """单个 UP 拉视频入库。

    参数：
      days         - 只拉 N 天内的（None=不限）
      only_cooking - 仅 tname 属于美食分区 或 标题含菜谱关键词
      sort_by      - 排序字段（pubdate/view/favorite/like/reply/coin）
      max_results  - 最多入多少条
      pages        - 翻几页 B 站（每页 30 条），默认 1 页 30 条

    返回：{"mid", "name", "fetched", "added", "skipped", "filtered_out", "status", "sort_by", "days"}
    """
    con = con or init_db()
    sub = con.execute(
        "SELECT name, last_video_pubdate, active FROM up_subscriptions WHERE mid=?", (mid,)
    ).fetchone()
    if not sub or not sub[2]:
        return {"mid": mid, "status": "not_subscribed"}
    name, last_pubdate, _ = sub

    max_count = max_results or (30 * pages)
    try:
        videos = asyncio.run(_fetch_user_videos(mid, max_count=max_count, pages=pages))
    except Exception as e:  # noqa: BLE001
        return {"mid": mid, "status": f"fetch_error: {e}"}

    fetched_total = len(videos)
    filtered = _filter_and_sort(videos, days=days, only_cooking=only_cooking,
                                sort_by=sort_by, max_results=max_results)
    filtered_out = fetched_total - len(filtered)

    added, skipped, newest, newest_bvid = 0, 0, last_pubdate or 0, None
    for v in filtered:
        r = add_one_bvid(v["bvid"], con, discovered_via="ups")
        if r["status"] == "added":
            added += 1
        else:
            skipped += 1
        if v.get("pubdate", 0) > newest:
            newest = v["pubdate"]
            newest_bvid = v["bvid"]

    con.execute("""
        UPDATE up_subscriptions
        SET last_checked_at=?, last_video_pubdate=?, last_video_bvid=?
        WHERE mid=?
    """, (datetime.now(timezone.utc).isoformat(timespec="seconds"),
          newest, newest_bvid, mid))
    con.commit()

    return {
        "mid": mid, "name": name,
        "fetched": fetched_total, "filtered_out": filtered_out,
        "added": added, "skipped": skipped,
        "newest_pubdate": newest, "newest_bvid": newest_bvid,
        "sort_by": sort_by, "days": days, "only_cooking": only_cooking,
        "status": "ok",
    }


def crawl_all(con: sqlite3.Connection | None = None, **kwargs) -> list[dict]:
    con = con or init_db()
    mids = [r[0] for r in con.execute(
        "SELECT mid FROM up_subscriptions WHERE active=1 ORDER BY added_at"
    ).fetchall()]
    out = []
    for mid in mids:
        print(f"  拉 UP {mid} ...", flush=True)
        r = crawl_one(mid, con, **kwargs)
        out.append(r)
    return out


# ---------- CLI ----------
def cmd_add(args):
    r = add(args.token)
    print(f"  ✓ {r['status']}: mid={r['mid']}  name={r['name']}")


def cmd_remove(args):
    r = remove(args.token)
    print(f"  {r['status']}: mid={r['mid']}")


def cmd_list(_args):
    ups = list_ups()
    if not ups:
        print("还没有关注任何 UP。用 `python -m src.ups add <mid 或 URL>` 加一个。")
        return
    print(f"\n已关注 {len(ups)} 个 UP：\n")
    print(f"  {'mid':<14} {'名称':<18} {'已处理/未处理':<14} {'上次检查':<22} {'最新视频'}")
    print(f"  {'-'*14} {'-'*18} {'-'*14} {'-'*22} {'-'*14}")
    for u in ups:
        last = (u["last_checked_at"] or "—")[:19]
        newest = u["last_video_bvid"] or "—"
        status = f"{u['n_approved']}✓ / {u['n_pending']}… / {u['n_total']}总"
        print(f"  {u['mid']:<14} {u['name'][:16]:<18} {status:<14} {last:<22} {newest}")


def cmd_crawl(args):
    if args.mid:
        r = crawl_one(args.mid)
        print(f"  {r['status']}: added={r['added']} skipped={r['skipped']}  newest_pubdate={r.get('newest_pubdate',0)}")
    else:
        rs = crawl_all()
        print(f"\n共拉取 {len(rs)} 个 UP")
        for r in rs:
            print(f"  {r.get('name','UP_'+str(r['mid'])):<18}  added={r['added']}  skipped={r['skipped']}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="UP 主关注")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_add = sub.add_parser("add", help="关注一个 UP")
    p_add.add_argument("token", help="mid 或 B 站个人空间 URL")

    p_rm = sub.add_parser("remove", help="取消关注（软删除）")
    p_rm.add_argument("token", help="mid 或 URL")

    sub.add_parser("list", help="查看已关注 UP")

    p_c = sub.add_parser("crawl", help="拉 UP 最近视频入库")
    p_c.add_argument("mid", nargs="?", type=int, default=None, help="不指定则拉全部")

    args = parser.parse_args(argv)
    if args.cmd == "add": return cmd_add(args)
    if args.cmd == "remove": return cmd_remove(args)
    if args.cmd == "list": return cmd_list(args)
    if args.cmd == "crawl": return cmd_crawl(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
