"""视频下载器（bilibili-api + httpx + ffmpeg）。

为什么不用 yt-dlp 直接抓 B 站网页：B 站 anti-bot 频繁返 412，
但走 player API (`Video.get_download_url`) 拿 CDN 直链不受影响。
本模块流程：
  1) bilibili-api 拿 dash {video, audio} 流 URL
  2) httpx 拉两路到本地临时文件（断点续传 + 进度）
  3) ffmpeg -c copy 合并为 mp4（不重新编码，几秒完成）

输出：`data/videos/<bvid>.mp4`，状态写 `downloads` + 更新 `videos.processing_status`
"""
from __future__ import annotations

import argparse
import asyncio
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import httpx
from bilibili_api.video import Video

from .schema import DB_PATH, init_db

VIDEO_DIR = Path("data/videos")
TMP_DIR = Path("data/videos/.tmp")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Referer": "https://www.bilibili.com/",
}


@dataclass
class DownloadResult:
    bvid: str
    ok: bool
    path: str | None = None
    bytes: int = 0
    error: str | None = None


def expected_path(bvid: str) -> Path:
    return VIDEO_DIR / f"{bvid}.mp4"


def _pick_dash(info: dict) -> tuple[str, str]:
    """从 player 返回里挑一路 video + 一路 audio（带宽最高的）。"""
    dash = info.get("dash") or {}
    v_list = dash.get("video") or []
    a_list = dash.get("audio") or []
    if not v_list or not a_list:
        raise RuntimeError("dash 流为空（可能视频需要大会员或地区限制）")
    v_list = sorted(v_list, key=lambda s: s.get("bandwidth", 0), reverse=True)
    a_list = sorted(a_list, key=lambda s: s.get("bandwidth", 0), reverse=True)
    return v_list[0]["baseUrl"], a_list[0]["baseUrl"]


async def _download_stream(url: str, dest: Path, sem: asyncio.Semaphore,
                          max_retries: int = 4) -> int:
    """下载单个流到本地。带重试 + 退避。返回写入字节数。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            async with sem:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(120.0, connect=15.0),
                    follow_redirects=True, headers=HEADERS,
                ) as client:
                    async with client.stream("GET", url) as r:
                        r.raise_for_status()
                        with dest.open("wb") as f:
                            async for chunk in r.aiter_bytes(chunk_size=64 * 1024):
                                f.write(chunk)
            return dest.stat().st_size
        except Exception as e:  # noqa: BLE001
            last_err = e
            # 不完整文件清掉，下次重试从 0 开始
            try:
                dest.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass
            if attempt < max_retries - 1:
                wait = 2 ** attempt
                print(f"    retry {attempt+1}/{max_retries} after {wait}s: {type(e).__name__}")
                await asyncio.sleep(wait)
    raise RuntimeError(f"下载失败（{max_retries} 次）: {last_err}")


def _merge(video: Path, audio: Path, out: Path) -> int:
    """ffmpeg -c copy 合并为 mp4，不重新编码。"""
    import subprocess
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(video),
        "-i", str(audio),
        "-c", "copy",
        "-movflags", "+faststart",
        str(out),
    ]
    subprocess.run(cmd, check=True)
    return out.stat().st_size


async def _download_one_async(bvid: str, overwrite: bool) -> DownloadResult:
    out = expected_path(bvid)
    if out.exists() and not overwrite:
        return DownloadResult(bvid, True, str(out), out.stat().st_size)

    TMP_DIR.mkdir(parents=True, exist_ok=True)
    v_tmp = TMP_DIR / f"{bvid}.video"
    a_tmp = TMP_DIR / f"{bvid}.audio"

    try:
        info = await Video(bvid=bvid).get_download_url(page_index=0)
        v_url, a_url = _pick_dash(info)
        sem = asyncio.Semaphore(2)
        v_bytes, a_bytes = await asyncio.gather(
            _download_stream(v_url, v_tmp, sem),
            _download_stream(a_url, a_tmp, sem),
        )
        size = _merge(v_tmp, a_tmp, out)
    except Exception as e:  # noqa: BLE001
        return DownloadResult(bvid, False, error=f"{type(e).__name__}: {str(e)[:200]}")
    finally:
        for p in (v_tmp, a_tmp):
            try:
                p.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass

    return DownloadResult(bvid, True, str(out), size)


def download_one(bvid: str, con: sqlite3.Connection, overwrite: bool = False) -> DownloadResult:
    """同步包装。下载 + 写库。"""
    out = expected_path(bvid)
    if out.exists() and not overwrite:
        size = out.stat().st_size
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        con.execute("""
            INSERT INTO downloads(bvid,path,bytes,status,finished_at)
            VALUES(?,?,?,?,?)
            ON CONFLICT(bvid) DO UPDATE SET
                status='done', path=excluded.path, bytes=excluded.bytes, error=NULL,
                finished_at=excluded.finished_at
        """, (bvid, str(out), size, "done", now))
        con.execute(
            "UPDATE videos SET processing_status='downloaded', last_processed_at=? WHERE bvid=?",
            (now, bvid),
        )
        con.commit()
        return DownloadResult(bvid, True, str(out), size)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    con.execute("""
        INSERT INTO downloads(bvid,status,started_at) VALUES(?,?,?)
        ON CONFLICT(bvid) DO UPDATE SET status='downloading', error=NULL, started_at=excluded.started_at
    """, (bvid, "downloading", now))
    con.commit()

    r = asyncio.run(_download_one_async(bvid, overwrite))

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if r.ok:
        con.execute("""
            INSERT INTO downloads(bvid,path,bytes,status,finished_at)
            VALUES(?,?,?,?,?)
            ON CONFLICT(bvid) DO UPDATE SET
                path=excluded.path, bytes=excluded.bytes, status='done',
                error=NULL, finished_at=excluded.finished_at
        """, (bvid, r.path, r.bytes, "done", now))
        con.execute(
            "UPDATE videos SET processing_status='downloaded', last_processed_at=? WHERE bvid=?",
            (now, bvid),
        )
    else:
        con.execute(
            "UPDATE downloads SET status='failed', error=?, finished_at=? WHERE bvid=?",
            (r.error, now, bvid),
        )
    con.commit()
    return r


def select_targets(con: sqlite3.Connection, *, limit: int,
                  min_score: float | None = None,
                  min_views: int | None = None,
                  include_failed: bool = True) -> list[str]:
    where = ["1=1"]
    args: list = []
    if min_score is not None:
        where.append("quality_score >= ?"); args.append(min_score)
    if min_views is not None:
        where.append("view_count >= ?"); args.append(min_views)
    if include_failed:
        where.append("processing_status IN ('new','failed')")
    else:
        where.append("processing_status = 'new'")
    args.append(limit)
    rows = con.execute(
        f"SELECT bvid FROM videos WHERE {' AND '.join(where)} ORDER BY quality_score DESC LIMIT ?",
        args,
    ).fetchall()
    return [r[0] for r in rows]


def cmd_run(args: argparse.Namespace) -> int:
    con = init_db()
    targets = select_targets(con, limit=args.limit,
                             min_score=args.min_score, min_views=args.min_views,
                             include_failed=args.retry_failed)
    if not targets:
        print("没有可下载的目标")
        return 0
    print(f"准备下载 {len(targets)} 条\n")
    ok = fail = 0
    for i, bvid in enumerate(targets, 1):
        t0 = time.monotonic()
        r = download_one(bvid, con, overwrite=args.overwrite)
        dt = time.monotonic() - t0
        flag = "✓" if r.ok else "✗"
        info = f"{r.bytes/1e6:.1f}MB" if r.ok else r.error
        print(f"  [{i:>3}/{len(targets)}] {flag} {bvid}  {dt:5.1f}s  {info}")
        if r.ok: ok += 1
        else: fail += 1
    print(f"\ndone. ok={ok} fail={fail}")
    return 0 if fail == 0 else 1


def cmd_status(_args: argparse.Namespace) -> int:
    con = init_db()
    print("\n下载状态聚合：")
    for r in con.execute(
        "SELECT processing_status, COUNT(*) FROM videos GROUP BY processing_status ORDER BY 1"
    ).fetchall():
        print(f"  {r[0]:<14}  {r[1]:>5}")
    print("\n最近 5 条下载记录：")
    for r in con.execute(
        "SELECT bvid, status, bytes FROM downloads WHERE finished_at IS NOT NULL "
        "ORDER BY finished_at DESC LIMIT 5"
    ).fetchall():
        print(f"  [{r[0]}] {r[1]:<10}  {r[2]/1e6:>6.1f}MB")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="视频下载器（bilibili-api + ffmpeg）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_dl = sub.add_parser("run", help="按条件下载一批")
    p_dl.add_argument("--limit", type=int, default=5)
    p_dl.add_argument("--min-score", type=float, default=None)
    p_dl.add_argument("--min-views", type=int, default=None)
    p_dl.add_argument("--overwrite", action="store_true")
    p_dl.add_argument("--retry-failed", action="store_true", default=True)

    sub.add_parser("status", help="查看下载状态聚合")

    args = parser.parse_args(argv)
    if args.cmd == "run":
        return cmd_run(args)
    if args.cmd == "status":
        return cmd_status(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
