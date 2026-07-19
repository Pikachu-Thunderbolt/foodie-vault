"""按 v1.0 规范产出处理包。

输入：DB 中 framed/approved 状态的 bvid
输出：data/exports/<packageId>/
  ├── manifest.json          # 规范 §3-9
  ├── media/                 # 规范 §2.1
  │   ├── <sha256>.webp      # 步骤图 / 封面
  │   └── ...
  ├── READY                  # 规范 §2.1
  ├── qa-report.json         # 规范 §2.1（可选）
  └── notify-<action>.json   # 上传通知 payload（§2.5）

子命令：
  run     按 bvid 产包
  notify  产包后生成上传通知 payload
  show    展示包摘要
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .schema import DB_PATH, init_db

EXPORT_DIR = Path("data/exports")
PARSED_DIR = Path("data/parsed")
TRANSCRIPT_DIR = Path("data/transcripts")
FRAMES_DIR = Path("data/frames")

# ---------- Producer 标识（v1.0 §3.1） ----------
SCHEMA_VERSION = "1.0"
PRODUCER_SYSTEM_NAME = "paoding-jieniu"
PRODUCER_SYSTEM_VERSION = "0.1.0"
PRODUCER_PRODUCER_ID = "paoding-jieniu-local-001"   # 平台注册时由运营分配
WHISPER_MODEL = "base"
CLAUDE_MODEL = "claude-sonnet-4-5"

# 内容命名空间 UUID（生成 v5 packageId 用，固定不变）
PKG_NS = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")

# 单位换算白名单（1 单位 → 国际单位）。不在此表的不换算，保留原值。
# 关键原则：要么正确换算，要么不换——绝不允许瞎猜。
UNIT_CONVERSIONS = {
    "斤": ("g", 500),        # 1 斤 = 500 g（中国市制）
    "公斤": ("g", 1000),
    "千克": ("g", 1000),
    "kg": ("g", 1000),
    "g": ("g", 1),
    "两": ("g", 50),         # 1 两 = 50 g
    "ml": ("ml", 1),
    "L": ("ml", 1000),
    "升": ("ml", 1000),
    "勺": ("ml", 15),        # 中式 1 汤勺 ≈ 15 ml
    "汤匙": ("ml", 15),
    "茶匙": ("ml", 5),
    "杯": ("ml", 240),       # 标准 1 cup
}
# 直接不解析（"适量" 等模糊表达）
FUZZY_AMOUNT_TOKENS = {"适量", "少许", "一点", "一些", "若干", "适量即可", "看情况"}

# 中文数字 → 数字（简单常用，复杂写法"两勺"里的"两"=2）
CHINESE_DIGITS = {
    "半": 0.5, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
}


# ---------- 阶段枚举 ----------
STAGE_EXTRACTED = "EXTRACTED"          # 视频解析完成，标准化未做
STAGE_NORMALIZED = "NORMALIZED"         # food_dictionary 已匹配
STAGE_WAITING_REVIEW = "WAITING_REVIEW"
STAGE_PUBLISH_READY = "PUBLISH_READY"


# ---------- 工具函数 ----------
def compute_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def get_image_size(path: Path) -> tuple[int, int]:
    from PIL import Image
    with Image.open(path) as im:
        return im.size


def convert_to_webp(src: Path, dst: Path, *, max_edge: int, quality: int) -> None:
    if dst.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    from PIL import Image
    with Image.open(src) as im:
        # 长边缩到 max_edge，比例不变
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
        # WebP 不支持 CMYK 之类的模式，转换到 RGB
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGB")
        im.save(dst, "WEBP", quality=quality, method=4)


def slugify(s: str) -> str:
    """保留中英文，剔除标点/空白，截 32 字符"""
    s = re.sub(r"[\s/\\:*?\"<>|]+", "_", s.strip())
    s = re.sub(r"_+", "_", s).strip("_")
    if not s:
        s = "x"
    return s[:32]


def parse_amount(amount_text: str) -> tuple[float | None, str | None]:
    """把"3斤"/"半勺"/"300g"/"适量"解析为 (amount, unit)。

    严格规则：
      - "适量"类模糊表达：返回 (None, None)，由 amountText 保留原文
      - 单位在白名单内：正确换算成 g/ml（注意 1 斤 = 500g 不是 300g）
      - 单位不在白名单（如"个"/"块"/"片"/"把"）：原样保留（不换算）
      - 数字部分无法解析：返回 (None, None)
    """
    if not amount_text:
        return None, None
    text = amount_text.strip()
    if not text or text in FUZZY_AMOUNT_TOKENS:
        return None, None

    # 数字部分（阿拉伯 或 中文）
    m = re.match(r"^([0-9]+(?:\.[0-9]+)?|[半一二两三四五六七八九十]+)(.+)?$", text)
    if not m:
        return None, None
    num_str, unit = m.group(1), (m.group(2) or "").strip()

    amount: float | None
    try:
        amount = float(num_str)
    except ValueError:
        amount = CHINESE_DIGITS.get(num_str)

    if amount is None:
        return None, None

    if not unit:
        return amount, None  # 纯数字没有单位

    if unit in UNIT_CONVERSIONS:
        new_unit, factor = UNIT_CONVERSIONS[unit]
        return amount * factor, new_unit

    # 单位不在白名单：保留原值，不换算
    return amount, unit


def derive_package_id(bvid: str) -> str:
    return str(uuid.uuid5(PKG_NS, f"paoding-jieniu:{bvid}"))


# ---------- 证据生成（§9.2） ----------
def evidence_for_step(step: dict, transcript_segments: list) -> list[dict]:
    start = step.get("start_sec") or 0
    end = step.get("end_sec") or start + 1
    matched = [s for s in transcript_segments
               if s["end"] >= start - 1 and s["start"] <= end + 1]
    if not matched:
        return []
    text = " ".join(s["text"] for s in matched)[:200]
    return [{
        "evidenceId": f"E-step{step['index'] + 1:02d}-asr",
        "sourceType": "asr",
        "sourceTimeStartSeconds": round(matched[0]["start"], 1),
        "sourceTimeEndSeconds": round(matched[-1]["end"], 1),
        "textExcerpt": text,
        "assetId": None,
        "confidence": 0.8,
    }]


def evidence_for_ingredient(ingredient: dict, transcript_segments: list) -> list[dict]:
    name = ingredient.get("rawName", "")
    ref = ingredient.get("ingredientRef", "x")
    for seg in transcript_segments:
        if name and (name in seg["text"]):
            return [{
                "evidenceId": f"E-ing-{ref}-asr",
                "sourceType": "asr",
                "sourceTimeStartSeconds": round(seg["start"], 1),
                "sourceTimeEndSeconds": round(seg["end"], 1),
                "textExcerpt": seg["text"][:200],
                "assetId": None,
                "confidence": 0.7,
            }]
    if transcript_segments:
        return [{
            "evidenceId": f"E-ing-{ref}-asr-bg",
            "sourceType": "asr",
            "sourceTimeStartSeconds": 0,
            "sourceTimeEndSeconds": round(transcript_segments[-1]["end"], 1),
            "textExcerpt": "（食材名未在 ASR 中直接出现，来源为视觉识别推断）"[:200],
            "assetId": None,
            "confidence": 0.4,
        }]
    return []


# ---------- 数据加载 ----------
def load_package_data(bvid: str, con: sqlite3.Connection) -> dict:
    video = con.execute("""
        SELECT bvid, title, up_mid, up_name, view_count, quality_score,
               duration, pubdate, desc, tname
        FROM videos WHERE bvid=?
    """, (bvid,)).fetchone()
    if not video:
        raise ValueError(f"video {bvid} not found in DB")

    parsed_p = PARSED_DIR / f"{bvid}.json"
    parsed = json.loads(parsed_p.read_text()) if parsed_p.exists() else {}
    trans_p = TRANSCRIPT_DIR / f"{bvid}.json"
    transcript = json.loads(trans_p.read_text()) if trans_p.exists() else {"segments": []}

    steps = con.execute("""
        SELECT idx, name, description, ingredients_json, start_sec, end_sec,
               key_frame_sec, key_visual_hint
        FROM steps WHERE bvid=? ORDER BY idx
    """, (bvid,)).fetchall()
    steps_data = [
        {"index": s[0], "name": s[1], "description": s[2],
         "ingredients": json.loads(s[3]) if s[3] else [],
         "start_sec": s[4], "end_sec": s[5], "key_frame_sec": s[6],
         "key_visual_hint": s[7]} for s in steps
    ]

    picked = {}
    for r in con.execute("""
        SELECT step_idx, slot_idx, frame_type, frame_path
        FROM approval_frames WHERE bvid=? ORDER BY step_idx, slot_idx
    """, (bvid,)).fetchall():
        picked.setdefault(r[0], []).append({
            "slot": r[1], "frame_type": r[2], "frame_path": r[3]
        })

    frames = {}
    for r in con.execute("""
        SELECT step_idx, frame_type, path FROM frames WHERE bvid=?
    """, (bvid,)).fetchall():
        frames.setdefault(r[0], {})[r[1]] = r[2]

    return {
        "video": {
            "bvid": video[0], "title": video[1], "up_mid": video[2],
            "up_name": video[3], "view_count": video[4], "quality_score": video[5],
            "duration": video[6], "pubdate": video[7], "desc": video[8],
            "tname": video[9],
        },
        "parsed": parsed,
        "transcript": transcript,
        "steps_data": steps_data,
        "picked_by_step": picked,
        "frames_by_step": frames,
    }


# ---------- Manifest 构建（§3-9） ----------
def build_manifest(data: dict) -> dict:
    v = data["video"]
    parsed = data["parsed"]
    trans = data["transcript"]
    steps_data = data["steps_data"]
    picked = data["picked_by_step"]
    frames = data["frames_by_step"]

    bvid = v["bvid"]
    package_id = derive_package_id(bvid)
    now = datetime.now(timezone.utc)

    # ---- mediaAssets ----
    # 新策略：先列"该写哪些图"的 plan（src + role + stepNo + slot），
    # 写文件时把 source JPG → WebP → 算真实 SHA → 用真 SHA 命名 + 填尺寸/大小。
    # 这样保证：
    #   1) manifest 里 sha256 是最终 WebP 字节的哈希
    #   2) assetId 唯一（用 role:stepNo:slot 前缀）
    #   3) 物理文件按内容 SHA 去重（封面和步骤图可能指向同一源，但 assetId 不同）
    recipe_name = parsed.get("recipe_name") or v["title"]
    plan: list[dict] = []

    # 封面：选 step 0 的 key 帧
    cover_key = frames.get(0, {}).get("key")
    if cover_key and Path(cover_key).exists():
        plan.append({
            "src": Path(cover_key), "role": "cover",
            "step_no": None, "slot": 0,
            "alt": f"{recipe_name} 封面",
            "max_edge": 1280, "quality": 82,
        })
        # 缩略图：同源，480px
        plan.append({
            "src": Path(cover_key), "role": "thumbnail",
            "step_no": None, "slot": 0,
            "alt": f"{recipe_name} 缩略图",
            "max_edge": 480, "quality": 78,
        })

    # 步骤图：用审批选定的代表帧；没审批则用 key
    for step in steps_data:
        idx = step["index"]
        step_picked = picked.get(idx, [])
        if not step_picked:
            kf = frames.get(idx, {}).get("key")
            if kf:
                step_picked = [{"frame_type": "key", "frame_path": kf, "slot": 0}]
        for pf in step_picked[:3]:
            fp = Path(pf["frame_path"])
            if not fp.exists():
                continue
            plan.append({
                "src": fp, "role": "step",
                "step_no": idx + 1, "slot": pf["slot"],
                "alt": f"步骤{idx+1}：{step['name']}",
                "max_edge": 1280, "quality": 82,
            })

    # 调用 write_media 真正写文件 + 生成 mediaAssets（manifest 最后由 export_one 写盘时调用）
    # 计划 + 媒体资产都是占位，写盘阶段在 export_one 内部完成
    media_assets: list[dict] = []  # 写盘后回填
    cover_asset: dict | None = None  # 同上
    asset_sources: dict[str, Path] = {}  # 占位

    # ---- 食材（§7）----
    ingredients: list[dict] = []
    evidence_records: list[dict] = []
    unresolved: list[dict] = []  # 处理阶段未完成的字段清单（规范 §7-9 之外）
    for i, ing in enumerate(parsed.get("ingredients", [])):
        ref = slugify(ing.get("name", f"ing{i}"))
        evs = evidence_for_ingredient({"ingredientRef": ref, "rawName": ing.get("name", "")},
                                      trans.get("segments", []))
        evidence_records.extend(evs)
        # 简单启发：前 5 项算 required，后面算 seasoning
        role = "required" if i < 5 else "seasoning"
        raw_amount_text = ing.get("amount", "") or None
        amount, unit = parse_amount(raw_amount_text or "")

        # 核心/必需食材 → canonicalIngredientId 是发布阻断条件
        if role in ("core", "required"):
            unresolved.append({
                "fieldPath": f"ingredients[{i}].canonicalIngredientId",
                "reasonCode": "MISSING_DICTIONARY",
                "nextOwner": "dictionary",
                "blockingPublish": True,
            })
            unresolved.append({
                "fieldPath": f"ingredients[{i}].canonicalName",
                "reasonCode": "MISSING_DICTIONARY",
                "nextOwner": "dictionary",
                "blockingPublish": True,
            })
        else:
            # seasoning/optional：未匹配可接受，但需要登记
            unresolved.append({
                "fieldPath": f"ingredients[{i}].canonicalIngredientId",
                "reasonCode": "MISSING_DICTIONARY",
                "nextOwner": "dictionary",
                "blockingPublish": False,
            })

        # 原文没明确说替代关系时，substitutionNote 必须是 null，不能推测
        if ing.get("note") and "代替" in (ing.get("note") or ""):
            sub_note = ing.get("note")
        else:
            sub_note = None
            # 仅当核心食材缺失替代说明且原文有 note 时，登记
            if role in ("core", "required") and ing.get("note"):
                # 原文有 note 但不含"代替"——登记为 NOT_STATED_IN_SOURCE
                pass  # 不登记，因为没要求必有 substitution

        # isOptional 必须与 role 联动（规范要求保持一致）
        is_optional = (role == "optional")

        ingredients.append({
            "ingredientRef": ref,
            "rawName": ing.get("name", ""),
            "canonicalIngredientId": None,
            "canonicalName": None,
            "normalizationStatus": "unmatched",
            "amount": amount,
            "unit": unit,
            "amountText": raw_amount_text,
            "preparation": ing.get("note", "") or None,
            "role": role,
            "isOptional": is_optional,
            "substitutionNote": sub_note,
            "confidence": 0.7,
            "evidenceRefs": [e["evidenceId"] for e in evs],
        })

    # ---- 证据 + 步骤记录 ----
    # 预先建立 食材名 -> ingredientRef 的映射，用于精准匹配
    ing_name_to_ref = {ing["rawName"]: ing["ingredientRef"] for ing in ingredients}
    step_records: list[dict] = []

    for step in steps_data:
        evs = evidence_for_step(step, trans.get("segments", []))
        evidence_records.extend(evs)
        ev_refs = [e["evidenceId"] for e in evs]
        # 步骤图 assetIds
        img_asset_ids = [a["assetId"] for a in media_assets
                         if a["role"] == "step" and a["stepNo"] == step["index"] + 1]
        img_asset_ids.sort(key=lambda x: next((a.get("sortOrder", 0) for a in media_assets
                                                if a["assetId"] == x), 0))
        # 食材 refs：只放本步描述里实际提到的
        step_text = f"{step.get('name','')} {step.get('description','')}"
        ing_refs = []
        for raw_name, ref in ing_name_to_ref.items():
            if raw_name and (raw_name in step_text):
                ing_refs.append(ref)
        dur = (step.get("end_sec") or 0) - (step.get("start_sec") or 0)
        step_records.append({
            "stepNo": step["index"] + 1,
            "instruction": f"{step.get('name','')}：{step.get('description','')}".strip("：")[:160],
            "imageAssetIds": img_asset_ids,
            "ingredientRefs": ing_refs,
            "equipment": [],
            "durationSeconds": int(dur) if dur > 0 else None,
            "heatLevel": "unknown",
            "stateCue": None,
            "sourceTimeStartSeconds": int(step.get("start_sec") or 0),
            "sourceTimeEndSeconds": int(step.get("end_sec") or 0),
            "confidence": 0.7,
            "evidenceRefs": ev_refs,
        })

    # ---- source (§4) ----
    source = {
        "contentType": "video",
        "platform": "bilibili",
        "sourceContentId": bvid,
        "sourceUrl": f"https://www.bilibili.com/video/{bvid}",
        "normalizedUrl": f"https://www.bilibili.com/video/{bvid}",
        "title": v["title"],
        "authorId": str(v["up_mid"]) if v["up_mid"] else None,
        "authorName": v["up_name"],
        "publishedAt": datetime.fromtimestamp(v["pubdate"], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                       if v["pubdate"] else None,
        "durationSeconds": v["duration"],
        "language": "zh-CN",
        # 默认 cleared：MVP 阶段认为处理程序产生的包已"准备好"，可被下游上传服务接收；
        # 上传服务会在 ingest_jobs 阶段再次校验 rightsStatus（业务策略决定是否接受 cleared）。
        # 生产环境应根据实际授权审核结果改 cleared / restricted / rejected。
        "rightsStatus": "cleared",
        "rightsNote": ("默认 cleared。生产环境应在上传前由运营审核 UP 主授权、署名要求、"
                        "商用范围后改 cleared / restricted / rejected 之一。"),
    }

    # ---- recipe (§5) ----
    # summary：优先用 LLM 第一段步骤描述（避免空）
    first_step_desc = (steps_data[0].get("description") or "") if steps_data else ""
    summary_src = (v.get("desc") or "").strip()
    if summary_src in ("", "-", "—"):
        summary_src = first_step_desc
    recipe = {
        "recipeName": parsed.get("recipe_name") or "待审核菜名",
        "aliases": [],
        "canonicalDishId": None,           # 留空，由"标准化"阶段补
        "summary": summary_src[:120] if summary_src else None,
        "servings": None,
        "totalDurationSeconds": v.get("duration"),
        "difficulty": "unknown",
        "coverAssetId": cover_asset["assetId"] if cover_asset else None,
        "cuisineTags": [],
        "dietaryTags": [],
        "equipment": [],
        "tips": [],
        "reviewRequired": True,
    }
    # recipe.canonicalDishId 缺失 = 阻断发布（规范化阶段必填）
    unresolved.append({
        "fieldPath": "recipe.canonicalDishId",
        "reasonCode": "MISSING_DICTIONARY",
        "nextOwner": "dictionary",
        "blockingPublish": True,
    })
    # recipe.difficulty 未知 = 阻断发布（需要难度推断或人工确认）
    unresolved.append({
        "fieldPath": "recipe.difficulty",
        "reasonCode": "CAPABILITY_NOT_ENABLED",
        "nextOwner": "extractor",
        "blockingPublish": True,
    })

    # ---- quality (§9) ----
    # 注意：未标准化（canonicalDishId / canonicalIngredientId）和 rightsStatus=unknown
    # 不再列为 warnings——它们由 unresolvedFields 跟踪（更精确，能区分归谁管）。
    # 这里只放空骨架，validationStatus/warnings/blockingErrors 由 export_one 在
    # 媒体写完后回填（因为 coverAssetId / imageAssetIds 这时才能确定）。
    quality = {
        "overallConfidence": 0.0,
        "validationStatus": "pending",
        "warnings": [],
        "blockingErrors": [],
        "evidence": evidence_records,
    }

    # ---- 处理阶段 + 未完成字段（v1.0 之外的扩展，用于跨阶段追踪）----
    # 当前没有 food_dictionary / 授权审核 / 难度推断 → 卡在 EXTRACTED 阶段
    processing_stage = STAGE_EXTRACTED
    has_blocking = any(u["blockingPublish"] for u in unresolved)
    blocking_count = sum(1 for u in unresolved if u["blockingPublish"])
    if processing_stage == STAGE_EXTRACTED and not has_blocking:
        processing_stage = STAGE_NORMALIZED

    # ---- producer (§3.1) ----
    producer = {
        "systemName": PRODUCER_SYSTEM_NAME,
        "systemVersion": PRODUCER_SYSTEM_VERSION,
        "modelVersions": {
            "whisper": WHISPER_MODEL,
            "llm": CLAUDE_MODEL,
        },
        "jobId": f"job-{bvid}-{int(now.timestamp())}",
        "processedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    # ---- contentHash (§3) ----
    trans_text = " ".join(s["text"] for s in trans.get("segments", []))
    content_hash = hashlib.sha256(trans_text.encode("utf-8")).hexdigest()

    return {
        "schemaVersion": SCHEMA_VERSION,
        "packageId": package_id,
        "producer": producer,
        "createdAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "contentHash": content_hash,
        "source": source,
        "recipe": recipe,
        "mediaAssets": media_assets,
        "ingredients": ingredients,
        "steps": step_records,
        "quality": quality,
        "processingStage": processing_stage,
        "unresolvedFields": unresolved,
        "extension": {
            "paoding": {
                "bvid": bvid,
                "viewCount": v.get("view_count"),
                "qualityScore": v.get("quality_score"),
            }
        },
    }, plan


# ---------- 写媒体 ----------
def write_media(plan: list[dict], out_dir: Path) -> list[dict]:
    """按 plan 写 WebP、算真实 SHA、生成唯一 assetId。

    关键原则：
      - SHA 必须是最终 .webp 字节的哈希（不是源 JPG）
      - assetId 用 role:stepNo:slot 后缀保证唯一
      - 物理文件按内容 SHA 去重（封面和某步可能指向同一源，但 assetId 不同）

    返回：mediaAssets 列表。
    """
    media_dir = out_dir / "media"
    media_dir.mkdir(parents=True, exist_ok=True)
    assets: list[dict] = []
    seen_shas: set[str] = set()
    written_shas: set[str] = set()  # 真正落到磁盘的（用于去重日志）

    for i, item in enumerate(plan):
        src: Path = item["src"]
        if not src.exists():
            continue
        # 写到临时路径（用下标确保唯一），算完 SHA 再 rename 到真名
        temp_path = media_dir / f"_tmp_{i:03d}.webp"
        convert_to_webp(
            src, temp_path,
            max_edge=item["max_edge"],
            quality=item["quality"],
        )
        # 算最终 SHA（对 .webp 字节，不是源 JPG）
        sha = compute_sha256(temp_path)
        final_path = media_dir / f"{sha}.webp"

        # 物理去重：同内容已经在的话，不重复写
        if sha in written_shas:
            temp_path.unlink()
        else:
            if final_path.exists():
                # 同 SHA 之前写过（比如上一轮跑过）—— 删临时，复用
                temp_path.unlink()
            else:
                temp_path.rename(final_path)
            written_shas.add(sha)

        # 唯一 assetId：role:stepNo:slot 前缀 + 内容 SHA 前缀
        # 同样的源图 + 不同的 role/step 位置 → 不同的 assetId
        role = item["role"]
        step_no = item.get("step_no")
        slot = item.get("slot", 0)
        if role == "step":
            unique_suffix = f"step-{step_no}-{slot}"
        elif role == "cover":
            unique_suffix = "cover"
        elif role == "thumbnail":
            unique_suffix = "thumb-480"
        else:
            unique_suffix = role
        asset_id = f"sha256:{sha[:16]}:{unique_suffix}"

        # 拿真实尺寸
        w, h = get_image_size(final_path)
        asset = {
            "assetId": asset_id,
            "localRelativePath": f"media/{sha}.webp",
            "sha256": sha,
            "mediaType": "image",
            "mimeType": "image/webp",
            "byteSize": final_path.stat().st_size,
            "width": w,
            "height": h,
            "role": role,
            "altText": (item.get("alt") or "")[:60],
            "cropFocus": {"x": 0.5, "y": 0.5},
        }
        if role == "step":
            asset["stepNo"] = step_no
            asset["sortOrder"] = slot
        assets.append(asset)
        seen_shas.add(sha)

    return assets


# ---------- 导出 ----------
def export_one(bvid: str, con: sqlite3.Connection, output_root: Path = EXPORT_DIR) -> dict:
    data = load_package_data(bvid, con)
    manifest, plan = build_manifest(data)
    package_id = manifest["packageId"]
    out_dir = output_root / package_id
    out_dir.mkdir(parents=True, exist_ok=True)

    # 写媒体（按 plan 写入 + 写真 SHA + 生成 assets 列表）
    media_assets = write_media(plan, out_dir)
    manifest["mediaAssets"] = media_assets

    # 回填引用：recipe.coverAssetId + steps[].imageAssetIds
    cover_a = next((a for a in media_assets if a["role"] == "cover"), None)
    if cover_a and manifest["recipe"].get("coverAssetId") is None:
        manifest["recipe"]["coverAssetId"] = cover_a["assetId"]
    # 步骤：按 stepNo 分组
    by_step: dict[int, list[dict]] = {}
    for a in media_assets:
        if a["role"] == "step":
            by_step.setdefault(a["stepNo"], []).append(a)
    for s in manifest["steps"]:
        s_no = s["stepNo"]
        step_assets = sorted(by_step.get(s_no, []), key=lambda a: a.get("sortOrder", 0))
        s["imageAssetIds"] = [a["assetId"] for a in step_assets]

    # 回填 quality（媒体写完才能定 coverAssetId / imageAssetIds）
    v = data["video"]
    warnings, blocking = [], []
    if not v.get("duration"):
        warnings.append("视频时长缺失")
    if not manifest["recipe"].get("coverAssetId"):
        blocking.append("封面资源缺失")
    if not manifest["steps"]:
        blocking.append("步骤数为 0")
    if not manifest["ingredients"]:
        blocking.append("食材列表为空")
    for s in manifest["steps"]:
        if not s["imageAssetIds"]:
            warnings.append(f"第{s['stepNo']}步无图片")

    qs = v.get("quality_score") or 50
    overall_conf = round(max(0.0, min(1.0, qs / 100.0)), 2)
    if blocking:
        validation = "failed"
    elif warnings:
        validation = "warning"
    else:
        validation = "passed"

    manifest["quality"]["overallConfidence"] = overall_conf
    manifest["quality"]["validationStatus"] = validation
    manifest["quality"]["warnings"] = warnings
    manifest["quality"]["blockingErrors"] = blocking

    # 写 manifest
    manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2)
    (out_dir / "manifest.json").write_text(manifest_text)

    # READY marker
    (out_dir / "READY").touch()

    # qa-report.json
    manifest_hash = hashlib.sha256(manifest_text.encode("utf-8")).hexdigest()
    qa = {
        "packageId": package_id,
        "schemaVersion": manifest["schemaVersion"],
        "manifestHash": manifest_hash,
        "validationStatus": manifest["quality"]["validationStatus"],
        "processingStage": manifest.get("processingStage"),
        "blockingErrors": manifest["quality"]["blockingErrors"],
        "warnings": manifest["quality"]["warnings"],
        "unresolvedFieldCount": len(manifest.get("unresolvedFields", [])),
        "unresolvedBlockingCount": sum(1 for u in manifest.get("unresolvedFields", [])
                                       if u.get("blockingPublish")),
        "mediaAssetCount": len(manifest["mediaAssets"]),
        "ingredientCount": len(manifest["ingredients"]),
        "stepCount": len(manifest["steps"]),
        "evidenceCount": len(manifest["quality"]["evidence"]),
        "producedAt": manifest["createdAt"],
    }
    (out_dir / "qa-report.json").write_text(json.dumps(qa, ensure_ascii=False, indent=2))

    return {
        "packageId": package_id,
        "out_dir": str(out_dir),
        "manifest_hash": manifest_hash,
        "validation": manifest["quality"]["validationStatus"],
        "media_count": len(manifest["mediaAssets"]),
        "step_count": len(manifest["steps"]),
        "ingredient_count": len(manifest["ingredients"]),
        "evidence_count": len(manifest["quality"]["evidence"]),
    }


def build_notify_payload(package_dir: Path, *, action: str = "validate") -> dict:
    manifest_path = package_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    return {
        "packageId": manifest["packageId"],
        "producerId": PRODUCER_PRODUCER_ID,
        "manifestLocation": f"exports/{package_dir.name}/manifest.json",
        "readyMarkerLocation": f"exports/{package_dir.name}/READY",
        "manifestHash": compute_sha256(manifest_path),
        "requestedAction": action,
        "callbackId": f"cb-{manifest['packageId'][:8]}",
    }


# ---------- CLI ----------
def cmd_run(args):
    con = init_db()
    if args.bvid:
        targets = [args.bvid]
    else:
        rows = con.execute("""
            SELECT bvid FROM videos
            WHERE processing_status IN ('framed','approved')
            ORDER BY quality_score DESC
        """).fetchall()
        targets = [r[0] for r in rows]
    if not targets:
        print("没有可产包的视频（需要 framed 或 approved 状态）")
        return 0
    print(f"准备产包 {len(targets)} 条\n")
    for bvid in targets:
        try:
            r = export_one(bvid, con, Path(args.output))
            print(f"  ✓ {bvid}")
            print(f"      packageId: {r['packageId']}")
            print(f"      validation: {r['validation']}")
            print(f"      media={r['media_count']}  steps={r['step_count']}  ingredients={r['ingredient_count']}  evidence={r['evidence_count']}")
            print(f"      → {r['out_dir']}")
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ {bvid}  {type(e).__name__}: {str(e)[:200]}")
    return 0


def cmd_notify(args):
    pkg = Path(args.package_dir)
    if not (pkg / "manifest.json").exists():
        print(f"未找到 manifest.json: {pkg}")
        return 1
    payload = build_notify_payload(pkg, action=args.action)
    out = pkg / f"notify-{args.action}.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"通知 payload: {out}")
    print(f"  packageId       : {payload['packageId']}")
    print(f"  producerId      : {payload['producerId']}")
    print(f"  manifestLocation: {payload['manifestLocation']}")
    print(f"  readyMarkerLoc  : {payload['readyMarkerLocation']}")
    print(f"  manifestHash    : {payload['manifestHash'][:16]}...")
    print(f"  requestedAction : {payload['requestedAction']}")
    print(f"\n本命令只生成 payload，真实场景下把它 POST 给上传发布服务即可。")
    return 0


def cmd_show(args):
    p = Path(args.package_dir) / "manifest.json"
    if not p.exists():
        print(f"找不到: {p}")
        return 1
    m = json.loads(p.read_text())
    print(f"\n  Package   : {m['packageId']}")
    print(f"  Recipe    : {m['recipe']['recipeName']}")
    print(f"  Schema    : v{m['schemaVersion']}")
    print(f"  Source    : {m['source']['platform']} / {m['source']['sourceContentId']}  ({m['source']['durationSeconds']}s)")
    print(f"  Steps     : {len(m['steps'])}")
    print(f"  Ingredients: {len(m['ingredients'])}")
    print(f"  Media     : {len(m['mediaAssets'])}")
    print(f"  Evidence  : {len(m['quality']['evidence'])}")
    print(f"  Validation: {m['quality']['validationStatus']}")
    if m["quality"]["blockingErrors"]:
        print(f"  Blocking  : {m['quality']['blockingErrors']}")
    if m["quality"]["warnings"]:
        print(f"  Warnings  : {m['quality']['warnings']}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="按 v1.0 规范产出处理包")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="产包")
    p_run.add_argument("--bvid", default=None, help="指定单条；不传则处理所有 framed/approved")
    p_run.add_argument("--output", default="data/exports")

    p_n = sub.add_parser("notify", help="产包后生成上传通知 payload（§2.5）")
    p_n.add_argument("package_dir")
    p_n.add_argument("--action", default="validate",
                     choices=["validate", "upload", "publish"])

    p_s = sub.add_parser("show", help="展示包摘要")
    p_s.add_argument("package_dir")

    args = parser.parse_args(argv)
    if args.cmd == "run":
        return cmd_run(args)
    if args.cmd == "notify":
        return cmd_notify(args)
    if args.cmd == "show":
        return cmd_show(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
