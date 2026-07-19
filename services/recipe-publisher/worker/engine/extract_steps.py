"""LLM 结构化步骤抽取（Claude）。

输入：`data/transcripts/<bvid>.json`
输出：`data/parsed/<bvid>.json` + 写 `steps` 表

这是流水线里**最关键的一步**：决定后续抽哪些帧、模型看多少图。

Prompt 要点：
  - 给 Claude 完整 transcript（带时间戳）
  - 让它输出结构化 JSON：recipe_name / ingredients / steps[]
  - 每步必须包含 `key_frame_sec` —— 这个时间戳就是后面 ffmpeg 抽哪一帧的依据
  - key_frame_sec 必须是画面最"展示动作"的那一瞬（不是话语讲到那一瞬）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .schema import DB_PATH, init_db
from . import llm_provider

PARSED_DIR = Path("data/parsed")
DEFAULT_MODEL = "claude-sonnet-4-5"


SYSTEM_PROMPT = """你是一个菜谱结构化解析器。
给定带时间戳的视频口播文稿（whisper 转写，可能有识别错误），输出结构化 JSON。

你的输出必须严格遵守 JSON Schema，不要写解释文字。"""


USER_PROMPT_TEMPLATE = """## 任务

解析下面这段做菜视频的口播文稿，输出结构化 JSON。

## 文稿格式

`[start_sec - end_sec] 文本`  每行一段。

## 视频信息（辅助参考）

标题：{title}
简介：{description}
标签：{tags}

## 观众高赞评论（可能有补充技巧或替代做法，请酌情参考）

{comments}

## 输出 JSON Schema

```json
{{
  "recipe_name": "菜名（如'糖醋里脊'）",
  "ingredients": [
    {{"name": "食材名", "amount": "量（如'300g'、'2勺'）", "note": "预处理备注（可选）"}}
  ],
  "steps": [
    {{
      "index": 0,
      "name": "步骤名（动词短语，如'切肉'、'热锅'、'翻炒'）",
      "description": "步骤详细描述（1-2 句话）",
      "start_sec": 0.0,
      "end_sec": 0.0,
      "key_frame_sec": 0.0,
      "key_visual_hint": "这一帧画面应该看到什么（如'刀切肉片的特写'）"
    }}
  ],
  "tips": [
    {{"content": "实用技巧（如'炒糖色要小火慢炒'）", "source": "comment 或 transcript"}}
  ]
}}
```

## 关键规则

1. **key_frame_sec** 是**画面最具代表性**的瞬间 —— 通常是动手操作的关键帧（刀落、锅起、食材变色），不是话语开始/结束
2. **步骤拆分**：按"动作切换"拆，不要按"句子切换"拆
3. **时间戳严格对齐**：用文稿里实际出现的时间，不要瞎猜
4. **食材归一**：同名食材合并（如"生抽"和"酱油"统一为"生抽"）
5. **数量写原文**：amount 保留原话（"适量"、"少许"、"两勺"都可以）
6. **过滤口播冗余**：忽略"大家好"、"记得点赞"这类非操作内容
7. **tips 提取**：从评论和口播中提取对做菜有实际帮助的技巧。标记来源（transcript 或 comment）

## 文稿（bvid={bvid}）

```
{transcript}
```
"""


def format_transcript(data: dict) -> str:
    """把 transcript JSON 渲染成 prompt 友好的纯文本。"""
    lines = []
    for seg in data["segments"]:
        lines.append(f"[{seg['start']:.1f} - {seg['end']:.1f}] {seg['text']}")
    return "\n".join(lines)


def _has_credential() -> bool:
    """由 provider 抽象层判断当前 provider 的凭证是否就绪。"""
    return llm_provider.has_credential()


def call_llm(transcript_text: str, bvid: str, model: str = DEFAULT_MODEL,
             title: str = "", description: str = "", tags: str = "",
             top_comments: list | None = None) -> dict:
    """调 LLM，返回解析后的 dict。可注入视频元数据和评论辅助提取。"""
    # 格式化评论
    comments_text = ""
    if top_comments:
        comments_lines = []
        for c in top_comments:
            likes = c.get("likes", 0)
            content = c.get("content", "")
            if content:
                comments_lines.append(f"- {content} (点赞 {likes})")
        comments_text = "\n".join(comments_lines) if comments_lines else "（无高赞评论）"
    else:
        comments_text = "（未获取评论数据）"

    user_msg = USER_PROMPT_TEMPLATE.format(
        bvid=bvid,
        transcript=transcript_text,
        title=title or "（未知）",
        description=description or "（未提供）",
        tags=tags or "（未提供）",
        comments=comments_text,
    )
    text = llm_provider.chat(SYSTEM_PROMPT, user_msg, model=model).strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def extract_one(bvid: str, con: sqlite3.Connection,
                model: str = DEFAULT_MODEL,
                overwrite: bool = False,
                source_data: dict | None = None) -> dict:
    """读 transcript → 调 LLM → 落库。可注入 sourceData 辅助提取。"""
    trans_path = Path("data/transcripts") / f"{bvid}.json"
    if not trans_path.exists():
        raise FileNotFoundError(f"transcript not found: {trans_path}")

    out_path = PARSED_DIR / f"{bvid}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if out_path.exists() and not overwrite:
        return json.loads(out_path.read_text())

    data = json.loads(trans_path.read_text())
    transcript_text = format_transcript(data)
    parsed = call_llm(
        transcript_text, bvid, model=model,
        title=(source_data or {}).get("title", ""),
        description=(source_data or {}).get("description", ""),
        tags=", ".join((source_data or {}).get("tags", [])),
        top_comments=(source_data or {}).get("topComments", []),
    )
    parsed["bvid"] = bvid
    parsed["model"] = model
    parsed["created_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    out_path.write_text(json.dumps(parsed, ensure_ascii=False, indent=2))

    # 写 steps 表
    now = parsed["created_at"]
    con.execute("DELETE FROM steps WHERE bvid=?", (bvid,))
    ingredients_json = json.dumps(parsed.get("ingredients", []), ensure_ascii=False)
    for step in parsed.get("steps", []):
        con.execute("""
            INSERT INTO steps(bvid,idx,name,description,ingredients_json,
                              start_sec,end_sec,key_frame_sec,key_visual_hint,recipe_name,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
        """, (
            bvid,
            step["index"],
            step["name"],
            step["description"],
            ingredients_json,
            step["start_sec"],
            step["end_sec"],
            step["key_frame_sec"],
            step.get("key_visual_hint", ""),
            parsed.get("recipe_name", ""),
            now,
        ))
    con.execute(
        "UPDATE videos SET processing_status='parsed', last_processed_at=? WHERE bvid=?",
        (now, bvid),
    )
    con.commit()
    return parsed


def select_targets(con: sqlite3.Connection, *, limit: int) -> list[str]:
    rows = con.execute("""
        SELECT bvid FROM videos
        WHERE processing_status = 'transcribed'
        ORDER BY quality_score DESC LIMIT ?
    """, (limit,)).fetchall()
    return [r[0] for r in rows]


def cmd_extract(args: argparse.Namespace) -> int:
    if not _has_credential():
        print(f"❌ {llm_provider.credential_hint()}")
        print("   例：export LLM_API_KEY=... LLM_BASE_URL=... LLM_MODEL=qwen-plus")
        return 2
    con = init_db()
    targets = select_targets(con, limit=args.limit)
    if not targets:
        print("没有待解析的 transcript（先跑 transcribe）")
        return 0
    print(f"待解析 {len(targets)} 条  model={args.model}\n")
    ok = fail = 0
    for i, bvid in enumerate(targets, 1):
        t0 = time.monotonic()
        try:
            parsed = extract_one(bvid, con, model=args.model, overwrite=args.overwrite)
            n_step = len(parsed.get("steps", []))
            n_ing = len(parsed.get("ingredients", []))
            dt = time.monotonic() - t0
            print(f"  [{i:>3}/{len(targets)}] ✓ {bvid}  {dt:5.1f}s  步骤{n_step}  食材{n_ing}  {parsed.get('recipe_name','')}")
            ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"  [{i:>3}/{len(targets)}] ✗ {bvid}  {type(e).__name__}: {str(e)[:120]}")
            fail += 1
    print(f"\ndone. ok={ok} fail={fail}")
    return 0 if fail == 0 else 1


def cmd_show(args: argparse.Namespace) -> int:
    p = PARSED_DIR / f"{args.bvid}.json"
    if not p.exists():
        print(f"parsed 不存在：{p}")
        return 1
    data = json.loads(p.read_text())
    print(f"\n{data['bvid']}  recipe={data.get('recipe_name','')}  model={data.get('model','')}\n")
    print(f"食材 ({len(data.get('ingredients', []))} 项)：")
    for ing in data.get("ingredients", []):
        note = f" ({ing['note']})" if ing.get("note") else ""
        print(f"  - {ing['name']:<10}  {ing.get('amount',''):<8}{note}")
    print(f"\n步骤 ({len(data.get('steps', []))} 步)：")
    for s in data.get("steps", []):
        print(f"\n  [{s['index']}] {s['name']}  ({s['start_sec']:.1f}s - {s['end_sec']:.1f}s, key={s['key_frame_sec']:.1f}s)")
        print(f"      {s['description']}")
        if s.get("key_visual_hint"):
            print(f"      🎯 {s['key_visual_hint']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LLM 结构化步骤抽取（Claude）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_e = sub.add_parser("run", help="解析一批")
    p_e.add_argument("--limit", type=int, default=5)
    p_e.add_argument("--model", default=DEFAULT_MODEL)
    p_e.add_argument("--overwrite", action="store_true")

    p_s = sub.add_parser("show", help="展示某 bvid 的解析结果")
    p_s.add_argument("bvid")

    args = parser.parse_args(argv)
    if args.cmd == "run":
        return cmd_extract(args)
    if args.cmd == "show":
        return cmd_show(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
