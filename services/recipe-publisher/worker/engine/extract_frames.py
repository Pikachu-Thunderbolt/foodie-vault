"""精准抽帧（ffmpeg，按 LLM 指定的时间戳）。

输入：`data/videos/<bvid>.mp4` + `data/parsed/<bvid>.json`
输出：`data/frames/<bvid>/<step_idx>_key.jpg` + `<step_idx>_ctx.jpg`，写 `frames` 表

设计核心：**只抽关键帧，不均匀采样**。
  - 每个 step 抽 1 张主帧（key_frame_sec，LLM 指定的"动作瞬间"）
  - 可选 1 张上下文帧（start_sec，看步骤起始状态）
  - 一般 8 步 × 1~2 张 ≈ 8~16 张/视频 —— 比均匀采样少 10x
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .schema import DB_PATH, init_db

FRAMES_DIR = Path("data/frames")
VIDEO_DIR = Path("data/videos")
PARSED_DIR = Path("data/parsed")

# 主帧长边上限，1280 是 vision 模型甜点
FRAME_MAX_EDGE = 1280
JPEG_QUALITY = 2     # ffmpeg -q:v 取值，越小越高（2 ≈ 97%）

# 每步在 key_frame_sec 前后抽多少候选帧（对称）
N_CANDIDATES = 4
# 候选帧与 key 的间隔（秒）
CANDIDATE_GAP = 1.5


def find_video(bvid: str) -> Path:
    """找视频文件，可能是 .mp4 / .mkv / .webm。"""
    for ext in (".mp4", ".mkv", ".webm", ".flv"):
        p = VIDEO_DIR / f"{bvid}{ext}"
        if p.exists():
            return p
    raise FileNotFoundError(f"video for {bvid} not found in {VIDEO_DIR}")


def extract_one_frame(video: Path, ts: float, out: Path) -> None:
    """ffmpeg 在指定时间戳抽一帧。"""
    if out.exists():
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    vf = f"scale='if(gt(iw,ih),min({FRAME_MAX_EDGE},iw),-2)':'if(gt(ih,iw),min({FRAME_MAX_EDGE},ih),-2)'"
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", f"{max(0.0, ts):.3f}",
        "-i", str(video),
        "-frames:v", "1",
        "-vf", vf,
        "-q:v", str(JPEG_QUALITY),
        str(out),
    ]
    subprocess.run(cmd, check=True)


def candidate_offsets(n: int, gap: float) -> list[float]:
    """在 0 周围对称地取 n 个偏移：[-(n//2)*gap, ..., -gap, +gap, ..., +(n//2)*gap]
    0 本身由 key 帧占据，所以候选只在两侧。
    例如 n=4, gap=1.5 -> [-3.0, -1.5, +1.5, +3.0]
    """
    if n <= 0:
        return []
    half = n // 2
    if n % 2 == 0:
        return [-gap * (half - i) for i in range(half)] + [gap * (i + 1) for i in range(half)]
    # 奇数：把 0 放在中间（不会与 key 重合，因为 key 的偏移是 +0）
    return [-(gap * (half - i)) for i in range(half + 1)] + [gap * (i + 1) for i in range(half)]


def extract_frames_for(bvid: str, con: sqlite3.Connection,
                       include_context: bool = True,
                       n_candidates: int = N_CANDIDATES,
                       candidate_gap: float = CANDIDATE_GAP) -> dict:
    """对单个 bvid 抽所有步骤的关键帧 + 上下文帧 + 候选帧。
    返回 {step_idx: {'key': path, 'ctx': path?, 'candidates': [path, ...]}}。
    """
    parsed_path = PARSED_DIR / f"{bvid}.json"
    if not parsed_path.exists():
        raise FileNotFoundError(f"parsed not found: {parsed_path}")
    parsed = json.loads(parsed_path.read_text())

    # 取视频总时长用于裁剪候选时间戳
    import subprocess as _sp
    dur_str = _sp.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", str(find_video(bvid))
    ], text=True).strip()
    try:
        video_duration = float(dur_str)
    except ValueError:
        video_duration = 1e9

    video = find_video(bvid)
    frame_root = FRAMES_DIR / bvid
    frame_root.mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out: dict[int, dict] = {}
    offsets = candidate_offsets(n_candidates, candidate_gap)

    for step in parsed.get("steps", []):
        idx = step["index"]
        key_ts = step.get("key_frame_sec")
        if key_ts is None:
            continue
        safe_name = sanitize_step_name(step.get("name", ""), idx)
        key_path = frame_root / f"{idx:02d}_{safe_name}_key.jpg"
        extract_one_frame(video, key_ts, key_path)

        ctx_path = None
        if include_context:
            ctx_ts = step.get("start_sec")
            if ctx_ts is not None and abs(ctx_ts - key_ts) > 0.5:
                ctx_path = frame_root / f"{idx:02d}_{safe_name}_ctx.jpg"
                extract_one_frame(video, ctx_ts, ctx_path)

        # 候选帧
        cand_paths: list[str] = []
        for k, off in enumerate(offsets):
            ts = key_ts + off
            if ts < 0 or ts > video_duration:
                continue
            cand_path = frame_root / f"{idx:02d}_{safe_name}_c{k}.jpg"
            extract_one_frame(video, ts, cand_path)
            cand_paths.append(str(cand_path))

        # 写 frames 表
        con.execute("""
            INSERT INTO frames(bvid,step_idx,frame_type,path,extracted_at)
            VALUES(?,?,?,?,?)
            ON CONFLICT(bvid,step_idx,frame_type) DO UPDATE SET
                path=excluded.path, extracted_at=excluded.extracted_at
        """, (bvid, idx, "key", str(key_path), now))
        if ctx_path:
            con.execute("""
                INSERT INTO frames(bvid,step_idx,frame_type,path,extracted_at)
                VALUES(?,?,?,?,?)
                ON CONFLICT(bvid,step_idx,frame_type) DO UPDATE SET
                    path=excluded.path, extracted_at=excluded.extracted_at
            """, (bvid, idx, "context", str(ctx_path), now))
        for k, cp in enumerate(cand_paths):
            con.execute("""
                INSERT INTO frames(bvid,step_idx,frame_type,path,extracted_at)
                VALUES(?,?,?,?,?)
                ON CONFLICT(bvid,step_idx,frame_type) DO UPDATE SET
                    path=excluded.path, extracted_at=excluded.extracted_at
            """, (bvid, idx, f"cand{k}", cp, now))

        out[idx] = {"key": str(key_path), "name": step.get("name", ""), "candidates": cand_paths}
        if ctx_path:
            out[idx]["ctx"] = str(ctx_path)

    con.execute(
        "UPDATE videos SET processing_status='framed', last_processed_at=? WHERE bvid=?",
        (now, bvid),
    )
    con.commit()
    return out


def sanitize_step_name(name: str, idx: int) -> str:
    """把步骤名变成文件名安全的 token。
    - 中文字符保留
    - 把 / \\ : * ? " < > | 与空白替换成 _
    - 连续 _ 合并
    - 长度上限 30
    - 空则 fallback 到 "step"
    """
    import re
    s = re.sub(r"[\\/:\*\?\"<>|\s]+", "_", name.strip())
    s = re.sub(r"_+", "_", s).strip("_")
    if not s:
        s = f"step{idx}"
    if len(s) > 30:
        s = s[:30].rstrip("_")
    return s


def rename_existing_frames(bvid: str, con: sqlite3.Connection) -> dict:
    """把已有的 <idx>_key.jpg / <idx>_ctx.jpg 重命名为带步骤名的版本。
    用于老数据迁移 + 修正命名。
    """
    parsed_path = PARSED_DIR / f"{bvid}.json"
    if not parsed_path.exists():
        raise FileNotFoundError(f"parsed not found: {parsed_path}")
    parsed = json.loads(parsed_path.read_text())
    step_names = {s["index"]: s.get("name", "") for s in parsed.get("steps", [])}

    frame_root = FRAMES_DIR / bvid
    if not frame_root.exists():
        return {"renamed": 0, "skipped": 0}

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    renamed = skipped = 0
    for step in parsed.get("steps", []):
        idx = step["index"]
        name = step.get("name", "")
        safe = sanitize_step_name(name, idx)
        for ftype in ("key", "ctx"):
            old = frame_root / f"{idx:02d}_{ftype}.jpg"
            new = frame_root / f"{idx:02d}_{safe}_{ftype}.jpg"
            if not old.exists():
                continue
            if old == new:
                skipped += 1
                continue
            old.rename(new)
            # 更新 frames 表
            con.execute("""
                UPDATE frames SET path=?, extracted_at=?
                WHERE bvid=? AND step_idx=? AND frame_type=?
            """, (str(new), now, bvid, idx, ftype))
            renamed += 1
    con.commit()
    return {"renamed": renamed, "skipped": skipped, "root": str(frame_root)}


def select_targets(con: sqlite3.Connection, *, limit: int) -> list[str]:
    rows = con.execute("""
        SELECT bvid FROM videos
        WHERE processing_status = 'parsed'
        ORDER BY quality_score DESC LIMIT ?
    """, (limit,)).fetchall()
    return [r[0] for r in rows]


def cmd_extract(args: argparse.Namespace) -> int:
    con = init_db()
    targets = select_targets(con, limit=args.limit)
    if not targets:
        print("没有待抽帧的视频（先跑 extract_steps）")
        return 0
    print(f"待抽帧 {len(targets)} 条\n")
    ok = fail = 0
    for i, bvid in enumerate(targets, 1):
        t0 = time.monotonic()
        try:
            frames = extract_frames_for(bvid, con, include_context=not args.no_context)
            n_key = sum(1 for v in frames.values() if "key" in v)
            n_ctx = sum(1 for v in frames.values() if "ctx" in v)
            dt = time.monotonic() - t0
            print(f"  [{i:>3}/{len(targets)}] ✓ {bvid}  {dt:5.1f}s  主帧{n_key}  上下文{n_ctx}")
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"  [{i:>3}/{len(targets)}] ✗ {bvid}  {type(e).__name__}: {str(e)[:120]}")
            fail += 1
    print(f"\ndone. ok={ok} fail={fail}")
    return 0 if fail == 0 else 1


def cmd_show(args: argparse.Namespace) -> int:
    """展示某 bvid 抽出的帧（按步骤）"""
    con = init_db()
    rows = con.execute("""
        SELECT s.idx, s.name, s.key_frame_sec, s.key_visual_hint,
               f_k.path AS key_path, f_c.path AS ctx_path
        FROM steps s
        LEFT JOIN frames f_k ON f_k.bvid=s.bvid AND f_k.step_idx=s.idx AND f_k.frame_type='key'
        LEFT JOIN frames f_c ON f_c.bvid=s.bvid AND f_c.step_idx=s.idx AND f_c.frame_type='context'
        WHERE s.bvid=?
        ORDER BY s.idx
    """, (args.bvid,)).fetchall()

    if not rows:
        print(f"无数据：{args.bvid}")
        return 1
    print(f"\n{args.bvid}  共 {len(rows)} 步\n")
    for r in rows:
        idx, name, ksec, hint, kpath, cpath = r
        print(f"  [{idx:>2}] {name:<10}  key@{ksec:.1f}s")
        if hint:
            print(f"       🎯 {hint}")
        if kpath:
            print(f"       📷 {kpath}")
        if cpath:
            print(f"       📷 {cpath}  (ctx)")
    return 0


def cmd_rename(args: argparse.Namespace) -> int:
    """把某 bvid 已抽出的帧改名为带步骤名的格式。"""
    con = init_db()
    targets = [args.bvid] if args.bvid else [
        r[0] for r in con.execute(
            "SELECT bvid FROM videos WHERE processing_status='framed'"
        ).fetchall()
    ]
    if not targets:
        print("没有 framed 状态的视频")
        return 0
    for bvid in targets:
        r = rename_existing_frames(bvid, con)
        print(f"  {bvid}  renamed={r['renamed']}  skipped={r['skipped']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="精准抽帧（ffmpeg）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_e = sub.add_parser("run", help="抽帧一批")
    p_e.add_argument("--limit", type=int, default=5)
    p_e.add_argument("--no-context", action="store_true", help="不抽上下文帧")

    p_s = sub.add_parser("show", help="展示某 bvid 的帧")
    p_s.add_argument("bvid")

    p_rn = sub.add_parser("rename", help="把已有帧改名为带步骤名的格式")
    p_rn.add_argument("bvid", nargs="?", default=None,
                     help="不指定则处理所有 framed 视频")

    args = parser.parse_args(argv)
    if args.cmd == "run":
        return cmd_extract(args)
    if args.cmd == "show":
        return cmd_show(args)
    if args.cmd == "rename":
        return cmd_rename(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
