"""处理流水线编排器。

串联 download → transcribe → extract_steps → extract_frames 四阶段，
按 `videos.processing_status` 推进（new → downloaded → transcribed → parsed → framed）。

子命令：
  next   选 1 个未完成的视频，跑完整流水线
  all    批量推进 N 个视频到下一阶段
  status  看流水线状态聚合
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from datetime import datetime, timezone

from . import download, extract_frames, extract_steps, transcribe
from .schema import DB_PATH, init_db


def _pick_one(con: sqlite3.Connection, min_score: float | None) -> str | None:
    """挑一个未完成的视频。优先级：queued > new。"""
    where = ["processing_status IN ('queued','new','downloaded','transcribed','parsed')"]
    args: list = []
    if min_score is not None:
        where.append("quality_score >= ?")
        args.append(min_score)
    # 优先 queued（按 added time asc = 早入队的先处理）
    row = con.execute(
        f"SELECT bvid FROM videos WHERE processing_status='queued' "
        f"ORDER BY last_processed_at ASC LIMIT 1"
    ).fetchone()
    if row:
        return row[0]
    # 其次 new（按 quality_score desc）
    row = con.execute(
        f"SELECT bvid FROM videos WHERE {' AND '.join(where)} "
        f"ORDER BY quality_score DESC LIMIT 1", args
    ).fetchone()
    return row[0] if row else None


def cmd_next(args: argparse.Namespace) -> int:
    con = init_db()
    bvid = _pick_one(con, args.min_score)
    if not bvid:
        print("没有可推进的视频")
        return 0

    print(f"\n=== 推进 {bvid} ===\n")
    t_total = time.monotonic()

    # 阶段 1：download
    row = con.execute(
        "SELECT processing_status FROM videos WHERE bvid=?", (bvid,)
    ).fetchone()
    cur = row[0] if row else "new"
    if cur == "new":
        print("[1/4] 下载 ...")
        r = download.download_one(bvid, con)
        if not r.ok:
            print(f"  ✗ 下载失败：{r.error}")
            return 1
        print(f"  ✓ {r.bytes/1e6:.1f}MB")
    else:
        print(f"[1/4] 下载 ... 跳过（已是 {cur}）")

    # 阶段 2：transcribe
    print("[2/4] ASR 转写 ...")
    r = transcribe.transcribe_one(bvid, con, model_name=args.whisper_model)
    if not r.ok:
        print(f"  ✗ 转写失败：{r.error}")
        return 1
    print(f"  ✓ {r.segments_count} 段 / {r.duration_sec:.0f}s / {r.language}")

    # 阶段 3：extract_steps（需要 ANTHROPIC_API_KEY）
    print("[3/4] LLM 抽取步骤 ...")
    try:
        parsed = extract_steps.extract_one(bvid, con, model=args.claude_model)
        print(f"  ✓ {parsed.get('recipe_name','')}  步骤 {len(parsed.get('steps', []))}  食材 {len(parsed.get('ingredients', []))}")
    except Exception as e:  # noqa: BLE001
        print(f"  ✗ {type(e).__name__}: {str(e)[:200]}")
        return 1

    # 阶段 4：extract_frames
    print("[4/4] 抽关键帧 ...")
    frames = extract_frames.extract_frames_for(bvid, con, include_context=True)
    n_key = sum(1 for v in frames.values() if "key" in v)
    n_ctx = sum(1 for v in frames.values() if "ctx" in v)
    print(f"  ✓ 主帧 {n_key}  上下文 {n_ctx}")

    dt = time.monotonic() - t_total
    print(f"\n✅ {bvid} 完成（{dt:.1f}s）  状态 → framed")
    return 0


def cmd_all(args: argparse.Namespace) -> int:
    """批量推进：每个视频都跑到 framed。"""
    import os
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        print("❌ 缺 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN")
        return 2

    con = init_db()
    # 选一批评分高且未完成的
    where = ["processing_status IN ('new','downloaded','transcribed','parsed')"]
    args_list: list = []
    if args.min_score is not None:
        where.append("quality_score >= ?")
        args_list.append(args.min_score)
    args_list.append(args.limit)
    rows = con.execute(
        f"SELECT bvid FROM videos WHERE {' AND '.join(where)} "
        f"ORDER BY quality_score DESC LIMIT ?", args_list
    ).fetchall()
    bvids = [r[0] for r in rows]
    if not bvids:
        print("没有可推进的视频")
        return 0

    print(f"待推进 {len(bvids)} 条\n")
    ok = fail = 0
    for i, bvid in enumerate(bvids, 1):
        print(f"\n[{i}/{len(bvids)}] {bvid}")
        # 阶段 1
        cur = con.execute(
            "SELECT processing_status FROM videos WHERE bvid=?", (bvid,)
        ).fetchone()[0]
        if cur == "new":
            r = download.download_one(bvid, con)
            if not r.ok:
                print(f"  ✗ dl: {r.error}"); fail += 1; continue
        # 阶段 2
        if cur in ("new", "downloaded"):
            r = transcribe.transcribe_one(bvid, con, model_name=args.whisper_model)
            if not r.ok:
                print(f"  ✗ asr: {r.error}"); fail += 1; continue
        # 阶段 3
        cur = con.execute("SELECT processing_status FROM videos WHERE bvid=?", (bvid,)).fetchone()[0]
        if cur in ("new", "downloaded", "transcribed"):
            try:
                extract_steps.extract_one(bvid, con, model=args.claude_model)
            except Exception as e:
                print(f"  ✗ parse: {e}"); fail += 1; continue
        # 阶段 4
        try:
            extract_frames.extract_frames_for(bvid, con, include_context=True)
        except Exception as e:
            print(f"  ✗ frames: {e}"); fail += 1; continue
        print(f"  ✓ done")
        ok += 1
    print(f"\nok={ok} fail={fail}")
    return 0 if fail == 0 else 1


def cmd_status(_args: argparse.Namespace) -> int:
    con = init_db()
    print("\n流水线状态聚合：")
    for r in con.execute(
        "SELECT processing_status, COUNT(*) FROM videos GROUP BY processing_status ORDER BY 1"
    ).fetchall():
        print(f"  {r[0]:<14}  {r[1]:>5}")
    print("\n最近 framed 的 5 条：")
    for r in con.execute("""
        SELECT bvid, title, view_count, last_processed_at,
               (SELECT COUNT(*) FROM steps WHERE bvid=videos.bvid) AS n_steps,
               (SELECT COUNT(*) FROM frames WHERE bvid=videos.bvid) AS n_frames
        FROM videos
        WHERE processing_status = 'framed'
        ORDER BY last_processed_at DESC LIMIT 5
    """).fetchall():
        print(f"  [{r[0]}] {r[1][:32]:<32}  播{r[2]:>9,}  步骤{r[4]:>2}  帧{r[5]:>2}  {r[3]}")
    return 0


def run_queue(limit: int = 3) -> list[dict]:
    """跑处理队列：连续处理 limit 个 queued 视频。

    顺序：先 queued（按入队时间升序），再 new。
    返回：每条的 {"bvid", "status": "ok"|"failed", "elapsed_sec", "error"?}
    """
    from . import download, transcribe, extract_steps, extract_frames
    con = init_db()
    results: list[dict] = []
    for _ in range(limit):
        bvid = _pick_one(con, min_score=None)
        if not bvid:
            break
        # 如果这条不是 queued，但 _pick_one 选中的（new），也照样跑
        # 这与"队列"语义略偏，但实际更友好
        t0 = time.monotonic()
        try:
            r = download.download_one(bvid, con)
            if not r.ok:
                results.append({"bvid": bvid, "status": "failed", "stage": "download", "error": r.error})
                continue
            r = transcribe.transcribe_one(bvid, con, model_name="base")
            if not r.ok:
                results.append({"bvid": bvid, "status": "failed", "stage": "transcribe", "error": r.error})
                continue
            try:
                extract_steps.extract_one(bvid, con, model="claude-sonnet-4-5")
            except Exception as e:  # noqa: BLE001
                results.append({"bvid": bvid, "status": "failed", "stage": "parse", "error": str(e)[:200]})
                continue
            extract_frames.extract_frames_for(bvid, con, include_context=True)
            results.append({
                "bvid": bvid, "status": "ok",
                "elapsed_sec": round(time.monotonic() - t0, 1),
            })
        except Exception as e:  # noqa: BLE001
            results.append({"bvid": bvid, "status": "failed", "stage": "unknown",
                            "error": f"{type(e).__name__}: {str(e)[:200]}"})
    con.close()
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="处理流水线编排器")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_n = sub.add_parser("next", help="挑 1 个视频跑完整流水线")
    p_n.add_argument("--min-score", type=float, default=None)
    p_n.add_argument("--whisper-model", default="base")
    p_n.add_argument("--claude-model", default="claude-sonnet-4-5")

    p_a = sub.add_parser("all", help="批量推进")
    p_a.add_argument("--limit", type=int, default=5)
    p_a.add_argument("--min-score", type=float, default=None)
    p_a.add_argument("--whisper-model", default="base")
    p_a.add_argument("--claude-model", default="claude-sonnet-4-5")

    p_q = sub.add_parser("run-queue", help="跑处理队列（status=queued）")
    p_q.add_argument("--limit", type=int, default=3)

    sub.add_parser("status", help="流水线状态聚合")

    args = parser.parse_args(argv)
    if args.cmd == "next":
        return cmd_next(args)
    if args.cmd == "all":
        return cmd_all(args)
    if args.cmd == "run-queue":
        rs = run_queue(limit=args.limit)
        ok = sum(1 for r in rs if r["status"] == "ok")
        fail = sum(1 for r in rs if r["status"] == "failed")
        for r in rs:
            mark = "✓" if r["status"] == "ok" else "✗"
            extra = f" ({r.get('stage','?')})" if r["status"] == "failed" else ""
            print(f"  {mark} {r['bvid']}  {r.get('elapsed_sec','?')}s{extra}")
        print(f"\nok={ok} fail={fail} total={len(rs)}")
        return 0 if fail == 0 else 1
    if args.cmd == "status":
        return cmd_status(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
