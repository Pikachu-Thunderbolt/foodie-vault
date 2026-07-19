"""SQLite schema 单一来源。

所有模块都从这里 import `init_db()`，保证表结构同步。
新增表 / 字段都在这里改。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

DB_PATH = Path("data/cooking_videos.db")


# ---------- schema ----------
# 必须分两段：CREATE TABLE 之前不能引用 ALTER 才会加的列，
# 所以先建表 + 老索引，ALTER 后再建依赖新列的索引。
SCHEMA_TABLES = """
CREATE TABLE IF NOT EXISTS videos (
    bvid          TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    up_mid        INTEGER,
    up_name       TEXT,
    duration      INTEGER,
    view_count    INTEGER,
    like_count    INTEGER,
    coin_count    INTEGER,
    fav_count     INTEGER,
    share_count   INTEGER,
    danmaku_count INTEGER,
    reply_count   INTEGER,
    pubdate       INTEGER,
    tname         TEXT,
    desc          TEXT,
    has_subtitle  INTEGER DEFAULT 0,
    subtitle_count INTEGER DEFAULT 0,
    quality_score REAL,
    first_seen_at TEXT,
    last_seen_at  TEXT,
    status        TEXT DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS idx_quality         ON videos(quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_status          ON videos(status);
CREATE INDEX IF NOT EXISTS idx_subtitle        ON videos(has_subtitle DESC, quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_pubdate         ON videos(pubdate);
CREATE INDEX IF NOT EXISTS idx_up_mid          ON videos(up_mid);

-- UP 主关注表（v1.1 扩展）
CREATE TABLE IF NOT EXISTS up_subscriptions (
    mid                  INTEGER PRIMARY KEY,
    name                 TEXT,
    added_at             TEXT,
    last_checked_at      TEXT,
    last_video_pubdate   INTEGER,
    last_video_bvid      TEXT,
    active               INTEGER DEFAULT 1
);

-- 下载记录
CREATE TABLE IF NOT EXISTS downloads (
    bvid           TEXT PRIMARY KEY,
    path           TEXT,
    bytes          INTEGER,
    status         TEXT,            -- pending/downloading/done/failed
    error          TEXT,
    started_at     TEXT,
    finished_at    TEXT
);

-- ASR 转写记录
CREATE TABLE IF NOT EXISTS transcripts (
    bvid           TEXT PRIMARY KEY,
    path           TEXT,
    language       TEXT,
    model          TEXT,
    segments_count INTEGER,
    duration_sec   REAL,
    created_at     TEXT
);

-- LLM 抽取的结构化步骤
CREATE TABLE IF NOT EXISTS steps (
    bvid             TEXT,
    idx              INTEGER,
    name             TEXT,
    description      TEXT,
    ingredients_json TEXT,         -- 整步共享的食材清单（JSON array）
    start_sec        REAL,
    end_sec          REAL,
    key_frame_sec    REAL,         -- 关键帧时间戳（秒）
    key_visual_hint  TEXT,         -- LLM 推断这一帧应该看到什么
    recipe_name      TEXT,
    created_at       TEXT,
    PRIMARY KEY (bvid, idx)
);
CREATE INDEX IF NOT EXISTS idx_steps_bvid ON steps(bvid);

-- 抽出的帧
CREATE TABLE IF NOT EXISTS frames (
    bvid         TEXT,
    step_idx     INTEGER,
    frame_type   TEXT,             -- 'key' 主帧 / 'context' 上下文帧 / 'cand0'..'candN' 候选
    path         TEXT,
    extracted_at TEXT,
    PRIMARY KEY (bvid, step_idx, frame_type)
);

-- 人工审批结果（review UI 写入）
CREATE TABLE IF NOT EXISTS approvals (
    bvid              TEXT,
    step_idx          INTEGER,
    picked_frame_type TEXT,         -- 兼容：第 1 张代表帧
    picked_path       TEXT,
    edited_name       TEXT,
    edited_description TEXT,
    edited_ingredients_json TEXT,   -- 编辑后的食材清单
    status            TEXT,         -- 'approved' / 'rejected' / 'pending'
    comment           TEXT,
    updated_at        TEXT,
    PRIMARY KEY (bvid, step_idx)
);

-- 每步最多 3 张代表帧（slot 0/1/2）
CREATE TABLE IF NOT EXISTS approval_frames (
    bvid       TEXT,
    step_idx   INTEGER,
    slot_idx   INTEGER,              -- 0/1/2
    frame_type TEXT,                 -- 'key' / 'context' / 'cand0'..'candN'
    frame_path TEXT,
    updated_at TEXT,
    PRIMARY KEY (bvid, step_idx, slot_idx)
);
CREATE INDEX IF NOT EXISTS idx_approval_frames ON approval_frames(bvid, step_idx);

-- 发现层运行日志
CREATE TABLE IF NOT EXISTS discovery_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at      TEXT NOT NULL,
    source      TEXT NOT NULL,
    fetched     INTEGER,
    kept        INTEGER,
    new_count   INTEGER,
    avg_score   REAL,
    max_score   REAL,
    elapsed_sec REAL
);
"""

SCHEMA_INDEXES_AFTER_ALTER = """
CREATE INDEX IF NOT EXISTS idx_processing      ON videos(processing_status);
CREATE INDEX IF NOT EXISTS idx_discovered_via  ON videos(discovered_via);
"""


def _add_column_if_missing(con: sqlite3.Connection, table: str, col: str, type_def: str) -> None:
    """幂等的列添加：列已存在就跳过。"""
    info = con.execute(f"PRAGMA table_info({table})").fetchall()
    cols = {row[1] for row in info}
    if col not in cols:
        con.execute(f"ALTER TABLE {table} ADD COLUMN {col} {type_def}")


def init_db(con: sqlite3.Connection | None = None, db_path: Path | None = None) -> sqlite3.Connection:
    """初始化或迁移数据库。"""
    if con is None:
        db_path = db_path or DB_PATH
        db_path.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(db_path)

    # 1) 建表 + 不依赖新列的索引
    con.executescript(SCHEMA_TABLES)

    # 2) 列迁移（幂等）
    _add_column_if_missing(con, "videos", "processing_status", "TEXT DEFAULT 'new'")
    _add_column_if_missing(con, "videos", "last_processed_at", "TEXT")
    _add_column_if_missing(con, "videos", "discovered_via", "TEXT DEFAULT 'auto'")

    # 3) 依赖新列的索引（必须 ALTER 之后）
    con.executescript(SCHEMA_INDEXES_AFTER_ALTER)

    con.commit()
    return con
