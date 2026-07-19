"""音频转写（ffmpeg + faster-whisper）。

输入：`data/videos/<bvid>.mp4`
输出：`data/transcripts/<bvid>.json` —— 带时间戳的分段文本 + 写入 transcripts 表

模型选择：
  - tiny / base / small / medium / large-v3
  - Mac CPU 上 base 即可（中文菜谱），medium 更准但慢约 5x
  - 首跑默认 base，后续可以重跑换大模型
"""
from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .schema import DB_PATH, init_db

AUDIO_DIR = Path("data/audios")
TRANSCRIPT_DIR = Path("data/transcripts")
WHISPER_DEFAULT_MODEL = "base"     # tiny/base/small/medium/large-v3


@dataclass
class TranscriptResult:
    bvid: str
    ok: bool
    segments_count: int = 0
    duration_sec: float = 0.0
    language: str = ""
    error: str | None = None


def extract_audio(video_path: Path, audio_path: Path) -> None:
    """ffmpeg 抽音轨：单声道 16kHz PCM wav，whisper 友好。"""
    if audio_path.exists():
        return
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(video_path),
        "-vn", "-ac", "1", "-ar", "16000",
        "-c:a", "pcm_s16le",
        str(audio_path),
    ]
    subprocess.run(cmd, check=True)


def transcribe(bvid: str, model_name: str = WHISPER_DEFAULT_MODEL) -> dict:
    """对单个 bvid 做 ASR，返回 {language, segments:[{start,end,text}], duration_sec}"""
    video_path = Path("data/videos") / f"{bvid}.mp4"
    if not video_path.exists():
        # yt-dlp 可能产出别的扩展名
        candidates = list((Path("data/videos")).glob(f"{bvid}.*"))
        candidates = [c for c in candidates if c.suffix in {".mp4", ".mkv", ".webm", ".flv"}]
        if not candidates:
            raise FileNotFoundError(f"video for {bvid} not found")
        video_path = candidates[0]

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    audio_path = AUDIO_DIR / f"{bvid}.wav"
    extract_audio(video_path, audio_path)

    from faster_whisper import WhisperModel  # 延迟导入，启动更快

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        str(audio_path),
        language="zh",
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        beam_size=5,
    )

    seg_list = []
    for seg in segments:
        seg_list.append({
            "start": round(seg.start, 2),
            "end": round(seg.end, 2),
            "text": seg.text.strip(),
        })

    return {
        "bvid": bvid,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration_sec": round(info.duration, 2),
        "model": model_name,
        "segments": seg_list,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def transcribe_one(bvid: str, con: sqlite3.Connection,
                   model_name: str = WHISPER_DEFAULT_MODEL,
                   overwrite: bool = False) -> TranscriptResult:
    """转写 + 写库。已有 transcript 时跳过（除非 overwrite）。"""
    out_path = TRANSCRIPT_DIR / f"{bvid}.json"
    if out_path.exists() and not overwrite:
        data = json.loads(out_path.read_text())
        con.execute("""
            INSERT INTO transcripts(bvid,path,language,model,segments_count,duration_sec,created_at)
            VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(bvid) DO UPDATE SET
                path=excluded.path, language=excluded.language, model=excluded.model,
                segments_count=excluded.segments_count, duration_sec=excluded.duration_sec
        """, (bvid, str(out_path), data["language"], data["model"],
              len(data["segments"]), data["duration_sec"], data["created_at"]))
        con.execute(
            "UPDATE videos SET processing_status='transcribed', last_processed_at=? WHERE bvid=?",
            (datetime.now(timezone.utc).isoformat(timespec="seconds"), bvid),
        )
        con.commit()
        return TranscriptResult(bvid, True, len(data["segments"]), data["duration_sec"], data["language"])

    try:
        data = transcribe(bvid, model_name=model_name)
    except Exception as e:  # noqa: BLE001
        return TranscriptResult(bvid, False, error=f"{type(e).__name__}: {str(e)[:200]}")

    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    con.execute("""
        INSERT INTO transcripts(bvid,path,language,model,segments_count,duration_sec,created_at)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(bvid) DO UPDATE SET
            path=excluded.path, language=excluded.language, model=excluded.model,
            segments_count=excluded.segments_count, duration_sec=excluded.duration_sec,
            created_at=excluded.created_at
    """, (bvid, str(out_path), data["language"], data["model"],
          len(data["segments"]), data["duration_sec"], data["created_at"]))
    con.execute(
        "UPDATE videos SET processing_status='transcribed', last_processed_at=? WHERE bvid=?",
        (datetime.now(timezone.utc).isoformat(timespec="seconds"), bvid),
    )
    con.commit()
    return TranscriptResult(bvid, True, len(data["segments"]), data["duration_sec"], data["language"])


def select_targets(con: sqlite3.Connection, *, limit: int) -> list[str]:
    rows = con.execute("""
        SELECT bvid FROM videos
        WHERE processing_status = 'downloaded'
        ORDER BY quality_score DESC LIMIT ?
    """, (limit,)).fetchall()
    return [r[0] for r in rows]


def cmd_transcribe(args: argparse.Namespace) -> int:
    con = init_db()
    targets = select_targets(con, limit=args.limit)
    if not targets:
        print("没有待转写的视频（先跑 download）")
        return 0
    print(f"待转写 {len(targets)} 条  model={args.model}\n")
    ok = fail = 0
    for i, bvid in enumerate(targets, 1):
        t0 = time.monotonic()
        r = transcribe_one(bvid, con, model_name=args.model, overwrite=args.overwrite)
        dt = time.monotonic() - t0
        flag = "✓" if r.ok else "✗"
        info = (f"{r.segments_count} 段  {r.duration_sec:.0f}s  {r.language}"
                if r.ok else r.error)
        print(f"  [{i:>3}/{len(targets)}] {flag} {bvid}  {dt:5.1f}s  {info}")
        if r.ok: ok += 1
        else: fail += 1
    print(f"\ndone. ok={ok} fail={fail}")
    return 0 if fail == 0 else 1


def cmd_show(args: argparse.Namespace) -> int:
    """展示某 bvid 的 transcript（人类可读，带时间戳）"""
    p = TRANSCRIPT_DIR / f"{args.bvid}.json"
    if not p.exists():
        print(f"transcript 不存在：{p}")
        return 1
    data = json.loads(p.read_text())
    print(f"\n{data['bvid']}  lang={data['language']}  segments={len(data['segments'])}  dur={data['duration_sec']:.1f}s  model={data['model']}\n")
    for seg in data["segments"][:args.limit]:
        print(f"  [{seg['start']:6.1f}s - {seg['end']:6.1f}s]  {seg['text']}")
    if len(data["segments"]) > args.limit:
        print(f"  ... ({len(data['segments']) - args.limit} more)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="音频转写（faster-whisper）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_t = sub.add_parser("run", help="转写一批")
    p_t.add_argument("--limit", type=int, default=5)
    p_t.add_argument("--model", default=WHISPER_DEFAULT_MODEL,
                    choices=("tiny", "base", "small", "medium", "large-v3"))
    p_t.add_argument("--overwrite", action="store_true")

    p_s = sub.add_parser("show", help="展示某 bvid 的 transcript")
    p_s.add_argument("bvid")
    p_s.add_argument("--limit", type=int, default=30)

    args = parser.parse_args(argv)
    if args.cmd == "run":
        return cmd_transcribe(args)
    if args.cmd == "show":
        return cmd_show(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
