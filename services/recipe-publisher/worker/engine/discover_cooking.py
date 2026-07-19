"""优质做菜视频发现器。

数据源（两种，按需选择或组合）：
  1. `food_3day`  — B 站美食分区（rid=1020）三日榜。当下热度，反映"新爆款"。
  2. `historical` — 按关键词全站搜索 + 播放量倒排。覆盖历年经典菜谱。

流程（共用）：
  1. 拉取原始条目（来源不同，shape 不同，先归一化）
  2. 硬过滤（播放 / 点赞率 / 评论 / 时长）
  3. 菜谱内容判定（关键词 + 百万播放兜底）
  4. 并发调 get_info() 补"是否有 CC 字幕"信号
  5. 打分 + UPSERT 写入 SQLite（按 bvid 去重）

调度建议：cron 每日跑一次 `auto`，即可同时收获当日爆款 + 滚动补充历史优质。
"""
from __future__ import annotations

import argparse
import asyncio
import math
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from bilibili_api import rank, search
from bilibili_api.video import Video

from .schema import DB_PATH, init_db

# ---------- 过滤配置 ----------
# 正面关键词：标题命中即视为"菜谱教程"
RECIPE_KEYWORDS = ("教程", "做法", "菜谱", "配方", "步骤", "方法", "怎么", "recipe", "recipe")
# 负面关键词：标题命中直接排除（吃播/搞笑/探店等）
NEGATIVE_KEYWORDS = (
    "吃播", "试吃", "测评", "开箱", "搞笑", "段子", "vlog",
    "探店", "踩雷", "拉踩", "整活", "reaction",
)

MIN_DURATION = 60          # 秒，太短不像教程
MAX_DURATION = 1800        # 30 分钟，太长剪辑成本高
MIN_VIEWS = 30_000
MIN_LIKE_RATIO = 0.02      # likes / views
MIN_REPLY = 30

# 字幕对处理链路的影响极大，所以权重最高
SUBTITLE_BONUS = 25.0
SUBTITLE_PER_LANG = 3.0    # 多语种字幕额外加分，上限见下
SUBTITLE_LANG_CAP = 3

# 历史搜索配置
HISTORICAL_KEYWORDS = ("菜谱", "家常菜教程", "做饭教程")
HISTORICAL_PAGES = 5        # 每个关键词翻几页；每页 42 条
HISTORICAL_KEYWORD_DELAY = 0.5   # 秒，避免触发反爬

CONCURRENCY = 8            # 并发拉 info 的协程上限


# ---------- 数据层（schema 与 init_db 在 schema.py）----------


# ---------- 评分 ----------
def quality_score(stat: dict, duration: int, has_subtitle: bool, subtitle_count: int) -> float:
    view = max(stat.get("view", 0), 1)
    like = stat.get("like", 0)
    coin = stat.get("coin", 0)
    fav = stat.get("favorite", 0)

    pop = math.log10(view + 1) * 10.0                              # 0~50
    eng = (like + coin * 2 + fav * 1.5) / view * 100.0             # 0~50
    ideal_len = 10.0 if 120 <= duration <= 600 else 0.0           # 2~10 分钟最佳
    sub = SUBTITLE_BONUS if has_subtitle else 0.0
    sub += min(subtitle_count, SUBTITLE_LANG_CAP) * SUBTITLE_PER_LANG
    return round(pop + eng + ideal_len + sub, 2)


# ---------- 过滤 ----------
def is_recipe_content(item: dict) -> bool:
    title = (item.get("title") or "").lower()
    desc = (item.get("desc") or "").lower()
    text = title + " " + desc

    if any(kw in text for kw in NEGATIVE_KEYWORDS):
        return False
    if any(kw in title for kw in RECIPE_KEYWORDS):
        return True
    # 缺关键词但百万级播放的也放行（已被市场验证）
    return item["stat"]["view"] >= 1_000_000


def passes_hard_filters(stat: dict, duration: int) -> bool:
    view = stat.get("view", 0)
    if view < MIN_VIEWS:
        return False
    if stat.get("like", 0) / max(view, 1) < MIN_LIKE_RATIO:
        return False
    if stat.get("reply", 0) < MIN_REPLY:
        return False
    if duration < MIN_DURATION or duration > MAX_DURATION:
        return False
    return True


# ---------- 数据获取 ----------
async def fetch_ranking() -> list[dict]:
    """B 站官方美食分区三日榜，100 条。"""
    res = await rank.get_rank(type_=rank.RankType.Food, day=rank.RankDayType.THREE_DAY)
    return res.get("list", [])


# 搜索接口返回的 title 带 <em class="keyword"> 高亮，先剥掉
_EM_TAG = re.compile(r"</?em[^>]*>", re.IGNORECASE)


def parse_duration(s: str) -> int:
    """'M:S' / 'H:M:S' 字符串 → 秒。"""
    try:
        parts = [int(p) for p in s.strip().split(":")]
    except (ValueError, AttributeError):
        return 0
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return 0


def normalize_search_item(raw: dict) -> dict:
    """搜索接口的 item 归一化为与 rank 接口一致的形状，让后续过滤/打分代码无差别处理。"""
    play = raw.get("play", 0) or 0
    fav = raw.get("favorites", 0) or 0
    like = raw.get("like", 0) or 0
    reply = raw.get("review", 0) or 0
    danmaku = raw.get("video_review", 0) or 0
    # 搜索接口无 coin / share 字段，按 0 处理（不会影响下游过滤逻辑）
    return {
        "bvid": raw["bvid"],
        "title": _EM_TAG.sub("", raw.get("title", "")),
        "duration": parse_duration(raw.get("duration", "0:0")),
        "pubdate": raw.get("pubdate", 0),
        "owner": {"mid": raw.get("mid", 0), "name": raw.get("author", "")},
        "stat": {
            "view": play, "like": like, "coin": 0, "favorite": fav,
            "share": 0, "danmaku": danmaku, "reply": reply,
        },
        "desc": raw.get("description", ""),
        "typename": raw.get("typename", ""),
        "tag": raw.get("tag", ""),
        "_from": "search",
    }


async def fetch_historical(pages: int = HISTORICAL_PAGES) -> list[dict]:
    """多关键词 × 多页 × 播放倒排，跨年捞历史优质菜谱。
    返回值已按 bvid 去重。
    """
    seen: set[str] = set()
    items: list[dict] = []
    for kw in HISTORICAL_KEYWORDS:
        for page in range(1, pages + 1):
            try:
                res = await search.search_by_type(
                    search_type=search.SearchObjectType.VIDEO,
                    keyword=kw,
                    order_type=search.OrderVideo.CLICK,
                    page=page,
                )
            except Exception as e:  # noqa: BLE001
                print(f"  [{kw}/p{page}] err: {type(e).__name__}: {str(e)[:80]}")
                continue
            for raw in res.get("result") or []:
                norm = normalize_search_item(raw)
                if norm["bvid"] in seen:
                    continue
                seen.add(norm["bvid"])
                items.append(norm)
            await asyncio.sleep(HISTORICAL_KEYWORD_DELAY)
    return items


async def enrich_one(bvid: str, sem: asyncio.Semaphore) -> dict:
    async with sem:
        try:
            v = Video(bvid=bvid)
            info = await v.get_info()
            sub_list = (info.get("subtitle") or {}).get("list") or []
            return {
                "has_subtitle": bool(sub_list),
                "subtitle_count": len(sub_list),
                "tname": info.get("tname_v2") or info.get("tname"),
                "desc": info.get("desc"),
            }
        except Exception as e:  # noqa: BLE001
            return {
                "has_subtitle": False,
                "subtitle_count": 0,
                "tname": None,
                "desc": None,
                "_error": str(e)[:120],
            }


# ---------- 主流程 ----------
@dataclass
class RunStats:
    fetched: int
    kept: int
    new_count: int
    avg_score: float
    max_score: float
    elapsed_sec: float


async def run_once(source: str = "auto", verbose: bool = True) -> RunStats:
    t0 = time.monotonic()
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    init_db(con)
    cur = con.cursor()

    items: list[dict] = []
    sources_used: list[str] = []
    if source in ("food_3day", "auto"):
        rk = await fetch_ranking()
        sources_used.append(f"food_3day({len(rk)})")
        items.extend(rk)
    if source in ("historical", "auto"):
        hi = await fetch_historical()
        sources_used.append(f"historical({len(hi)})")
        items.extend(hi)
    if verbose:
        print(f"[{source}] 拉取 {len(items)} 条  来源={','.join(sources_used)}")

    candidates: list[dict] = []
    for it in items:
        if not passes_hard_filters(it["stat"], it.get("duration", 0)):
            continue
        if not is_recipe_content(it):
            continue
        candidates.append(it)
    if verbose:
        print(f"硬过滤 + 菜谱判定后剩 {len(candidates)} 条")

    sem = asyncio.Semaphore(CONCURRENCY)
    enrich_results = await asyncio.gather(
        *(enrich_one(it["bvid"], sem) for it in candidates),
        return_exceptions=True,
    )

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    new_count = 0
    score_sum = 0.0
    score_max = 0.0

    for it, enr in zip(candidates, enrich_results):
        if isinstance(enr, Exception) or enr is None:
            enr = {"has_subtitle": False, "subtitle_count": 0, "tname": None, "desc": None}

        existing = cur.execute(
            "SELECT first_seen_at FROM videos WHERE bvid=?", (it["bvid"],)
        ).fetchone()
        is_new = existing is None

        score = quality_score(
            it["stat"], it["duration"], enr["has_subtitle"], enr["subtitle_count"]
        )
        score_sum += score
        score_max = max(score_max, score)

        row = (
            it["bvid"],
            it["title"],
            it["owner"]["mid"],
            it["owner"]["name"],
            it["duration"],
            it["stat"]["view"],
            it["stat"]["like"],
            it["stat"]["coin"],
            it["stat"]["favorite"],
            it["stat"]["share"],
            it["stat"]["danmaku"],
            it["stat"]["reply"],
            it["pubdate"],
            enr.get("tname"),
            enr.get("desc"),
            1 if enr["has_subtitle"] else 0,
            enr["subtitle_count"],
            score,
            now if is_new else existing[0],
            now,
        )
        cur.execute("""
            INSERT INTO videos(
                bvid,title,up_mid,up_name,duration,
                view_count,like_count,coin_count,fav_count,share_count,
                danmaku_count,reply_count,pubdate,tname,desc,
                has_subtitle,subtitle_count,quality_score,
                first_seen_at,last_seen_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(bvid) DO UPDATE SET
                last_seen_at  = excluded.last_seen_at,
                quality_score = excluded.quality_score,
                view_count    = excluded.view_count,
                like_count    = excluded.like_count,
                coin_count    = excluded.coin_count,
                fav_count     = excluded.fav_count,
                share_count   = excluded.share_count,
                danmaku_count = excluded.danmaku_count,
                reply_count   = excluded.reply_count,
                has_subtitle  = excluded.has_subtitle,
                subtitle_count= excluded.subtitle_count,
                title         = excluded.title
        """, row)
        if is_new:
            new_count += 1

    kept = len(candidates)
    avg = score_sum / kept if kept else 0.0
    elapsed = time.monotonic() - t0

    cur.execute(
        "INSERT INTO discovery_log(run_at,source,fetched,kept,new_count,avg_score,max_score,elapsed_sec)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (now, source, len(items), kept, new_count, round(avg, 2), round(score_max, 2), round(elapsed, 2)),
    )
    con.commit()

    if verbose:
        print(f"kept={kept} new={new_count} avg={avg:.2f} max={score_max:.2f} elapsed={elapsed:.1f}s")
        print("\nTop 5 (按 quality_score):")
        for row in cur.execute(
            "SELECT bvid,title,view_count,quality_score,has_subtitle,subtitle_count "
            "FROM videos WHERE first_seen_at >= ? ORDER BY quality_score DESC LIMIT 5",
            (now,),
        ).fetchall():
            sub_flag = "✓" if row[4] else "·"
            print(f"  [{row[0]}] {row[1][:38]:<38}  播{row[2]:>9,}  评分{row[3]:>6}  字幕{sub_flag}({row[5]})")

    con.close()
    return RunStats(len(items), kept, new_count, round(avg, 2), round(score_max, 2), round(elapsed, 2))


def list_videos(con: sqlite3.Connection, *, has_subtitle: bool | None = None,
                status: str | None = None, limit: int = 20) -> list[tuple]:
    sql = "SELECT bvid,title,up_name,view_count,quality_score,has_subtitle,subtitle_count,status,last_seen_at FROM videos WHERE 1=1"
    args: list = []
    if has_subtitle is not None:
        sql += " AND has_subtitle=?"
        args.append(1 if has_subtitle else 0)
    if status:
        sql += " AND status=?"
        args.append(status)
    sql += " ORDER BY quality_score DESC LIMIT ?"
    args.append(limit)
    return con.execute(sql, args).fetchall()


def cmd_list(args: argparse.Namespace) -> None:
    con = sqlite3.connect(DB_PATH)
    rows = list_videos(con, has_subtitle=args.subtitle_only, status=args.status, limit=args.limit)
    print(f"\n共 {len(rows)} 条：\n")
    for r in rows:
        flag = "✓" if r[5] else "·"
        print(f"  [{r[0]}] {r[1][:40]:<40}  UP:{r[2]:<10}  播{r[3]:>9,}  评分{r[4]:>6}  字幕{flag}({r[6]})  {r[7]}  {r[8]}")
    con.close()


def cmd_log(args: argparse.Namespace) -> None:
    con = sqlite3.connect(DB_PATH)
    print("\n最近运行：")
    for r in con.execute(
        "SELECT run_at,source,fetched,kept,new_count,avg_score,max_score,elapsed_sec "
        "FROM discovery_log ORDER BY id DESC LIMIT ?", (args.limit,)
    ).fetchall():
        print(f"  {r[0]}  {r[1]:<10}  fetched={r[2]:>3} kept={r[3]:>3} new={r[4]:>2} "
              f"avg={r[5]:>6} max={r[6]:>6}  {r[7]:.1f}s")
    con.close()


def cmd_top(args: argparse.Namespace) -> None:
    """带过滤的 Top N 查询，给下载器/挑选器用。"""
    import datetime as _dt

    con = sqlite3.connect(DB_PATH)
    where = ["1=1"]
    qargs: list = []
    if args.min_score is not None:
        where.append("quality_score >= ?"); qargs.append(args.min_score)
    if args.min_views is not None:
        where.append("view_count >= ?"); qargs.append(args.min_views)
    if args.up_name:
        where.append("up_name LIKE ?"); qargs.append(f"%{args.up_name}%")
    if args.subtitle_only:
        where.append("has_subtitle = 1")
    if args.older_than_years is not None:
        cutoff = int((_dt.datetime.now() - _dt.timedelta(days=365*args.older_than_years)).timestamp())
        where.append("pubdate < ?"); qargs.append(cutoff)
    qargs.append(args.limit)

    rows = con.execute(
        f"SELECT bvid,title,up_name,view_count,quality_score,has_subtitle,pubdate,processing_status "
        f"FROM videos WHERE {' AND '.join(where)} "
        f"ORDER BY quality_score DESC LIMIT ?", qargs
    ).fetchall()
    print(f"\n命中 {len(rows)} 条：\n")
    for r in rows:
        bvid, title, up, view, score, sub_n, pub, pstatus = r
        pub_str = _dt.datetime.fromtimestamp(pub).strftime("%Y-%m-%d")
        flag = "✓" if sub_n else "·"
        print(f"  [{bvid}] {title[:38]:<38}  UP:{up[:10]:<10}  播{view:>9,}  评分{score:>6}  字幕{flag}  {pub_str}  proc={pstatus}")
    con.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="优质做菜视频发现器")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="跑一次发现")
    p_run.add_argument(
        "--source",
        choices=("auto", "food_3day", "historical"),
        default="auto",
        help="auto=两个源都跑；food_3day=仅当日三日榜；historical=仅历史搜索",
    )

    p_list = sub.add_parser("list", help="列出已收录的视频")
    p_list.add_argument("--subtitle-only", action="store_true")
    p_list.add_argument("--status", default=None)
    p_list.add_argument("--limit", type=int, default=20)

    p_top = sub.add_parser("top", help="按条件查询 Top N")
    p_top.add_argument("--limit", type=int, default=10)
    p_top.add_argument("--min-score", type=float, default=None)
    p_top.add_argument("--min-views", type=int, default=None)
    p_top.add_argument("--up-name", default=None, help="按 UP 主名模糊匹配")
    p_top.add_argument("--subtitle-only", action="store_true")
    p_top.add_argument("--older-than-years", type=int, default=None,
                       help="只看 N 年以上的老视频")

    sub.add_parser("log", help="查看运行日志").add_argument("--limit", type=int, default=10)

    args = parser.parse_args(argv)
    if args.cmd == "run":
        asyncio.run(run_once(source=args.source))
    elif args.cmd == "list":
        cmd_list(args)
    elif args.cmd == "top":
        cmd_top(args)
    elif args.cmd == "log":
        cmd_log(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
