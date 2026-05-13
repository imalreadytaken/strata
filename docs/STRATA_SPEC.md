# Strata Spec

**项目代号**:Strata
**版本**:1.0
**日期**:2026-05-11
**作者**:Seven

---

## 文档说明

本文档是 Strata 项目的**完整工程契约文档**——读完后可以直接照着实施。

适用读者:实施者(可能是你本人 + Claude Code)
适用场景:Phase 0 启动、后续功能扩展、Claude Code 共建参考

跟其他文档的关系:

| 文档 | 回答 | 状态 |
|---|---|---|
| `PROJECT_RESEARCH_BACKGROUND.md` | Why & What | ✅ 已完成,1215 行 |
| **本文档 (`STRATA_SPEC.md`)** | **How(完整工程契约)** | ✅ 当前 |
| `personal-assistant-spec.md` v1.1 | 旧设计 | ⚠️ 已废弃 |

---

## 1. 项目元信息

### 1.1 项目身份

| 维度 | 值 |
|---|---|
| 项目名 | Strata |
| 寓意 | 地层——隐喻"用户数据像沉积岩一样层层堆积,能力像地层中的化石一样从数据里浮现" |
| 形态 | OpenClaw plugin |
| 目标用户 | 单个终端用户在自己机器上 |
| 部署 | 100% 本地,无云端依赖 |

### 1.2 技术栈

| 层次 | 选型 |
|---|---|
| 编程语言 | TypeScript(单栈) |
| 运行时 | Node.js 20+ |
| 数据存储 | SQLite + sqlite-vec(向量) + FTS5(全文) |
| Agent runtime | OpenClaw |
| 代码生成 | Claude Code CLI(subprocess) |
| Spec 工作流 | OpenSpec(workflows profile) |
| Model 调用 | **完全通过 OpenClaw 抽象**(不存 API key) |
| 配置格式 | JSON5 |
| Migration 工具 | Knex.js migrations 或类似 |

### 1.3 核心原则(从研究背景文档继承,已锁定)

P1. Raw events 永不丢失——append-only,任何衍生数据 trace 回 raw_event_id
P2. 业务表每张有唯一 owner pipeline——其他组件只读
P3. 金额 INTEGER minor units——避免浮点
P4. 时间 ISO 8601 with TZ——避免 naive datetime
P5. 数据 100% 在用户机器上——隐私优先
P6. Schema 演化必须可回溯——任何变更可通过 messages 表重新抽取历史

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户机器                                   │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  OpenClaw Gateway (现成)                                  │    │
│  │                                                            │    │
│  │  ┌────────────────────┐  ┌────────────────────┐         │    │
│  │  │ Channels: Telegram │  │ Channels: 其他      │         │    │
│  │  └────────────────────┘  └────────────────────┘         │    │
│  │                                                            │    │
│  │  ┌────────────────────────────────────────────────┐     │    │
│  │  │ Model providers (用户配置:Anthropic/Codex/      │     │    │
│  │  │   DeepSeek/Gemini/Claude CLI 等任意组合)          │     │    │
│  │  └────────────────────────────────────────────────┘     │    │
│  │                                                            │    │
│  │  ┌────────────────────────────────────────────────┐     │    │
│  │  │ Strata Plugin (本项目)                            │     │    │
│  │  │ ─────────────────────────────────────            │     │    │
│  │  │  Hooks:                                           │     │    │
│  │  │  ├─ onUserMessage (兜底写 messages 表)           │     │    │
│  │  │  └─ onAssistantMessage                            │     │    │
│  │  │                                                    │     │    │
│  │  │  Tools (给 agent 用):                              │     │    │
│  │  │  ├─ strata_create_pending_event                   │     │    │
│  │  │  ├─ strata_update_pending_event                   │     │    │
│  │  │  ├─ strata_commit_event                           │     │    │
│  │  │  ├─ strata_supersede_event                        │     │    │
│  │  │  ├─ strata_abandon_event                          │     │    │
│  │  │  └─ strata_search_events                          │     │    │
│  │  │                                                    │     │    │
│  │  │  Skills (给 agent 用):                             │     │    │
│  │  │  ├─ capture       (识别 + 暂存事件)               │     │    │
│  │  │  ├─ query         (回答历史数据问题)              │     │    │
│  │  │  └─ build         (用户主动共建意图触发)          │     │    │
│  │  │                                                    │     │    │
│  │  │  Callbacks:                                        │     │    │
│  │  │  └─ inline keyboard (commit/edit/abandon)         │     │    │
│  │  │                                                    │     │    │
│  │  │  Internal services:                                │     │    │
│  │  │  ├─ Triage (意图分类)                              │     │    │
│  │  │  ├─ Reflect Agent (周期跑,识别模式生成提议)        │     │    │
│  │  │  ├─ Build Bridge (调度 Claude Code 共建)           │     │    │
│  │  │  ├─ Orchestrator (跑 OpenSpec changes)             │     │    │
│  │  │  ├─ Integration Layer (集成产物到运行时)            │     │    │
│  │  │  ├─ Re-extraction Worker (历史回填)                │     │    │
│  │  │  └─ Pending Buffer (session pending events)        │     │    │
│  │  └────────────────────────────────────────────────┘     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  数据层 (SQLite at ~/.strata/main.db)                     │    │
│  │                                                            │    │
│  │  系统表(Strata core):                                      │    │
│  │  ├─ messages              (所有 IM 消息)                  │    │
│  │  ├─ raw_events            (语义事件,状态机管理)            │    │
│  │  ├─ capability_registry   (能力清单)                       │    │
│  │  ├─ schema_evolutions     (schema 演化档案)                │    │
│  │  ├─ reextract_jobs        (回填作业)                        │    │
│  │  ├─ builds                (Build session 状态)             │    │
│  │  ├─ proposals             (Reflect 生成的提议)              │    │
│  │  └─ capability_health     (能力健康度跟踪)                  │    │
│  │                                                            │    │
│  │  业务表(运行时浮现):                                       │    │
│  │  ├─ expenses              (用户共建后生成)                  │    │
│  │  ├─ moods                                                   │    │
│  │  ├─ workouts                                                │    │
│  │  ├─ stock_holdings                                          │    │
│  │  └─ ...                                                     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  文件系统: ~/.strata/                                     │    │
│  │                                                            │    │
│  │  ├─ main.db                                                │    │
│  │  ├─ openspec/                                              │    │
│  │  │   ├─ project.md                                         │    │
│  │  │   ├─ AGENTS.md       ← 系统宪法                         │    │
│  │  │   ├─ specs/          ← 永久 specs                       │    │
│  │  │   └─ changes/                                           │    │
│  │  │       ├─ active/                                        │    │
│  │  │       └─ archive/                                       │    │
│  │  ├─ capabilities/         ← 浮现的能力代码                  │    │
│  │  │   ├─ expenses/v1/                                       │    │
│  │  │   ├─ moods/v1/                                          │    │
│  │  │   └─ ...                                                │    │
│  │  ├─ plans/                ← Plan Phase 沉淀                │    │
│  │  └─ builds/               ← Build workdir                  │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  外部 subprocess (按需 spawn)                              │    │
│  │  └─ Claude Code CLI (`claude -p`)                         │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 组件清单与职责

| 组件 | 类型 | 职责 |
|---|---|---|
| **OpenClaw Gateway** | 现成 | IM 入口 / agent runtime / model provider 抽象 |
| **Strata Plugin** | **本项目核心** | 整个 Strata 系统的代码,以 OpenClaw plugin 形式存在 |
| **Hooks** | Plugin 内部 | 拦截消息流,兜底写 messages 表 |
| **Tools** | Plugin 内部 | 给 agent 调用,管理 raw_events 状态机 |
| **Skills** | Plugin 内部 | 教 agent 何时调用 tools |
| **Triage** | Plugin 内部 | 意图分类——是 capture 还是 query 还是 build_request |
| **Reflect Agent** | Plugin 内部,周期任务 | 扫 raw_events 找模式,生成升级/降级提议 |
| **Build Bridge** | Plugin 内部 | 共建协议的总调度——Plan→Decompose→Orchestrate→Integrate |
| **Orchestrator** | Plugin 内部 | Build Bridge 子模块,跑 OpenSpec changes |
| **Integration Layer** | Plugin 内部 | OpenSpec archive 后把能力集成到运行时 |
| **Re-extraction Worker** | Plugin 内部,后台任务 | 处理 schema 演化的历史数据回填 |
| **Pending Buffer** | Plugin 内部 | session 级 pending event 管理 |
| **Claude Code** | 外部 subprocess | 实际写代码,由 Build Bridge spawn |
| **OpenSpec** | 外部 CLI | spec-driven 工作流,Build Bridge 内部调用 |

### 2.3 读路径

```
用户提问 "5 月消费多少"
   ↓
OpenClaw 收到消息
   ↓
[Strata Hook: onUserMessage] 写 messages 表
   ↓
OpenClaw 启动 agent loop
   ↓
[Strata Skill: query] 被激活
   ↓
agent 调 strata_search_events / 或直接查业务表
   ↓
[Plugin] 查 SQLite (expenses 表 GROUP BY month)
   ↓
agent 综合数据回复
   ↓
[Strata Hook: onAssistantMessage] 写 messages 表
   ↓
用户收到回复
```

### 2.4 写路径(用户记录新事实)

```
用户发 "今天买了 Blue Bottle ¥45"
   ↓
OpenClaw 收到消息
   ↓
[Strata Hook: onUserMessage] 写 messages 表
   ↓
OpenClaw 启动 agent loop
   ↓
[Strata Skill: capture] 被激活
   ↓
agent 调 strata_create_pending_event:
  event_type='consumption' (从已有能力推断)
  extracted_data={merchant: 'Blue Bottle', amount_minor: 4500}
   ↓
[Plugin] 写 raw_events 表 (status='pending')
[Plugin] 发 inline keyboard:
  "Blue Bottle ¥45 [✅ 记录] [✏️ 调整] [❌ 不记]"
   ↓
用户点 ✅
   ↓
[Callback handler] strata_commit_event 触发
[Plugin] raw_events 状态改为 'committed'
[Plugin] 触发对应 capability 的 ingest pipeline
[Plugin] 业务表 expenses 写入一行,raw_event_id 关联
   ↓
回复用户 "✅ 已记录"
```

### 2.5 浮现路径(飞轮)

```
[每周日凌晨 3:00] Reflect Agent 启动
   ↓
扫 raw_events (status='committed')
   ↓
按 event_type / extracted_data 聚类
   ↓
检测模式:
  - 重复出现 (count > 20 且持续 > 2 周)
  - 用户用自然语言描述但没有对应 capability
  - 已有 capability 的字段使用 unbalanced (subcategory 浮现)
   ↓
生成 proposals (写 proposals 表):
  - kind='new_capability'  (建新能力)
  - kind='schema_evolution' (升级现有 schema)
  - kind='capability_archive' (建议归档不用的能力)
   ↓
通过 IM 推送给用户 (Telegram 卡片)
   ↓
用户审核
   ├─ 同意 → 触发 Build Bridge (共建流程)
   └─ 拒绝 → proposal 状态改为 'declined',冷却 30 天
```

---

## 3. 数据模型

### 3.1 系统表 DDL

#### messages 表

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,           -- 'telegram' | 'discord' | ...
  role TEXT NOT NULL,              -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',  -- 'text' | 'image' | 'audio' | ...
  turn_index INTEGER NOT NULL,
  received_at TEXT NOT NULL,       -- ISO 8601 with TZ
  
  -- 关联(可选)
  raw_event_id INTEGER REFERENCES raw_events(id),
  raw_event_role TEXT,             -- 'primary' | 'context' | 'correction' | 'confirmation'
  
  -- 检索
  embedding BLOB,                  -- sqlite-vec
  
  -- 索引
  CHECK (role IN ('user', 'assistant', 'system')),
  CHECK (content_type IN ('text', 'image', 'audio', 'file', 'callback'))
);

CREATE INDEX idx_messages_session ON messages(session_id, turn_index);
CREATE INDEX idx_messages_time ON messages(received_at);
CREATE INDEX idx_messages_raw_event ON messages(raw_event_id) WHERE raw_event_id IS NOT NULL;

-- FTS5 全文搜
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='id'
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
  UPDATE messages_fts SET content = new.content WHERE rowid = new.id;
END;
```

#### raw_events 表

```sql
CREATE TABLE raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  
  -- 语义信息
  event_type TEXT NOT NULL,        -- 'unclassified' | 'consumption' | 'mood_log' | ...
  status TEXT NOT NULL,            -- 'pending' | 'committed' | 'superseded' | 'abandoned'
  
  -- 内容
  extracted_data TEXT NOT NULL,    -- JSON
  source_summary TEXT NOT NULL,    -- 一句话描述
  
  -- 跟 messages 的关联
  primary_message_id INTEGER NOT NULL REFERENCES messages(id),
  related_message_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array
  
  -- 时间
  event_occurred_at TEXT,          -- 用户描述的事件发生时间(可能不等于 received_at)
  committed_at TEXT,
  
  -- 修正链
  supersedes_event_id INTEGER REFERENCES raw_events(id),
  superseded_by_event_id INTEGER REFERENCES raw_events(id),
  abandoned_reason TEXT,
  
  -- 关联到业务表
  capability_name TEXT,            -- 'expenses' / 'moods' / ...
  business_row_id INTEGER,         -- 对应业务表的 row id
  
  -- 提取版本
  extraction_version INTEGER NOT NULL DEFAULT 1,
  extraction_confidence REAL,
  extraction_errors TEXT,          -- JSON,任何错误记录
  
  -- meta
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  
  CHECK (status IN ('pending', 'committed', 'superseded', 'abandoned')),
  CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1))
);

CREATE INDEX idx_raw_events_status ON raw_events(status, capability_name);
CREATE INDEX idx_raw_events_session ON raw_events(session_id);
CREATE INDEX idx_raw_events_occurred ON raw_events(event_occurred_at) WHERE event_occurred_at IS NOT NULL;
CREATE INDEX idx_raw_events_capability ON raw_events(capability_name, status);
CREATE INDEX idx_raw_events_supersedes ON raw_events(supersedes_event_id) WHERE supersedes_event_id IS NOT NULL;
```

#### capability_registry 表

```sql
CREATE TABLE capability_registry (
  name TEXT PRIMARY KEY,           -- 'expenses' / 'moods' / ...
  version INTEGER NOT NULL,        -- 当前 active version
  
  -- 生命周期状态(见 5.5 节)
  -- 只有 capability 真的有代码落地后才会进入这张表
  -- 提议阶段在 proposals 表;构建阶段在 builds 表;此表只记录"已落地的能力"
  status TEXT NOT NULL,
  
  meta_path TEXT NOT NULL,         -- capabilities/<name>/v<N>/meta.json 路径
  primary_table TEXT NOT NULL,     -- 'expenses'
  
  -- 时间
  created_at TEXT NOT NULL,        -- 进入 active(首次创建)的时间
  archived_at TEXT,                -- 进入 archived 的时间
  deleted_at TEXT,                 -- 进入 deleted 的时间(soft delete 标记)
  
  -- 来源
  proposal_id INTEGER REFERENCES proposals(id),  -- 触发创建的 proposal(如有)
  build_id INTEGER REFERENCES builds(id),        -- 实际构建 build 的 id
  
  CHECK (status IN ('active', 'archived', 'deleted'))
);

CREATE INDEX idx_capability_status ON capability_registry(status);
```

#### schema_evolutions 表

```sql
CREATE TABLE schema_evolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability_name TEXT NOT NULL REFERENCES capability_registry(name),
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  
  -- 变更内容
  change_type TEXT NOT NULL,       -- 'capability_create' | 'add_column' | 'modify_column' | ...
  diff TEXT NOT NULL,              -- JSON,描述具体变化
  
  -- OpenSpec change 关联
  openspec_change_id TEXT,
  
  -- 用户决策
  proposed_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,                -- 'user' | 'reflect_agent_auto'
  applied_at TEXT,
  
  -- 回填
  backfill_strategy TEXT,          -- 'none' | 'derive_existing' | 'reextract_raw_events' | 'reextract_messages'
  backfill_status TEXT,            -- 'not_needed' | 'pending' | 'running' | 'done' | 'failed' | 'partial'
  backfill_job_id INTEGER REFERENCES reextract_jobs(id),
  
  CHECK (change_type IN ('capability_create', 'add_column', 'modify_column', 'remove_column', 'rename_column', 'add_constraint', 'capability_archive', 'capability_restore')),
  CHECK (backfill_status IS NULL OR backfill_status IN ('not_needed', 'pending', 'running', 'done', 'failed', 'partial'))
);

CREATE INDEX idx_schema_evolutions_capability ON schema_evolutions(capability_name, to_version);
```

#### reextract_jobs 表

```sql
CREATE TABLE reextract_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_evolution_id INTEGER NOT NULL REFERENCES schema_evolutions(id),
  capability_name TEXT NOT NULL,
  strategy TEXT NOT NULL,
  
  -- 进度
  status TEXT NOT NULL,            -- 'pending' | 'running' | 'paused' | 'done' | 'failed'
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_done INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  rows_low_confidence INTEGER NOT NULL DEFAULT 0,
  
  -- 成本
  estimated_cost_cents INTEGER,
  actual_cost_cents INTEGER,
  
  -- 时间
  started_at TEXT,
  completed_at TEXT,
  last_checkpoint_at TEXT,
  
  -- 错误
  last_error TEXT,
  
  CHECK (status IN ('pending', 'running', 'paused', 'done', 'failed'))
);

CREATE INDEX idx_reextract_status ON reextract_jobs(status);
```

#### builds 表

```sql
CREATE TABLE builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  
  -- 来源
  trigger_kind TEXT NOT NULL,      -- 'user_request' | 'reflect_proposal'
  trigger_proposal_id INTEGER REFERENCES proposals(id),
  
  -- 目标
  target_capability TEXT NOT NULL,
  target_action TEXT NOT NULL,     -- 'create' | 'evolve' | 'archive'
  
  -- 状态
  phase TEXT NOT NULL,             -- 'plan' | 'decompose' | 'build' | 'integrate' | 'post_deploy' | 'done' | 'failed' | 'cancelled' | 'paused'
  plan_path TEXT,                  -- plans/<timestamp>-<target>/PLAN.md
  workdir_path TEXT,               -- builds/<session_id>/
  claude_session_id TEXT,          -- Claude Code 的 session,用于 resume
  
  -- 进度
  changes_total INTEGER,
  changes_done INTEGER NOT NULL DEFAULT 0,
  current_change_id TEXT,
  
  -- 时间
  created_at TEXT NOT NULL,
  paused_at TEXT,
  completed_at TEXT,
  last_heartbeat_at TEXT,
  
  -- 失败
  failure_reason TEXT,
  
  CHECK (phase IN ('plan', 'decompose', 'build', 'integrate', 'post_deploy', 'done', 'failed', 'cancelled', 'paused')),
  CHECK (trigger_kind IN ('user_request', 'reflect_proposal')),
  CHECK (target_action IN ('create', 'evolve', 'archive'))
);

CREATE INDEX idx_builds_phase ON builds(phase);
CREATE INDEX idx_builds_session ON builds(session_id);
```

#### proposals 表

```sql
CREATE TABLE proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- 来源
  source TEXT NOT NULL,            -- 'reflect_agent' | 'user_request'
  
  -- 类型
  kind TEXT NOT NULL,              -- 'new_capability' | 'schema_evolution' | 'capability_archive' | 'capability_demote'
  target_capability TEXT,          -- 已有能力的名字(如果是 evolve/archive)
  
  -- 内容
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  rationale TEXT NOT NULL,         -- Reflect agent 的理由
  proposed_design TEXT,            -- JSON,具体设计建议
  
  -- 信号
  signal_strength REAL,            -- 0-1,触发提议的信号强度
  evidence_event_ids TEXT,         -- JSON array of raw_event ids
  estimated_cost_cents INTEGER,
  estimated_time_minutes INTEGER,
  
  -- 状态
  status TEXT NOT NULL,            -- 'pending' | 'approved' | 'declined' | 'expired' | 'applied'
  
  -- 时间
  created_at TEXT NOT NULL,
  pushed_to_user_at TEXT,          -- 何时推给用户
  responded_at TEXT,
  expires_at TEXT,                 -- 30 天没响应自动 expired
  cooldown_until TEXT,             -- 拒绝后冷却时间
  
  -- 关联
  resulting_build_id INTEGER REFERENCES builds(id),
  
  CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'applied')),
  CHECK (kind IN ('new_capability', 'schema_evolution', 'capability_archive', 'capability_demote')),
  CHECK (source IN ('reflect_agent', 'user_request'))
);

CREATE INDEX idx_proposals_status ON proposals(status);
CREATE INDEX idx_proposals_capability ON proposals(target_capability) WHERE target_capability IS NOT NULL;
```

#### capability_health 表

跟踪每个能力的真实使用统计,作为生命周期状态转换(主要是 archive 触发)的输入信号。

```sql
CREATE TABLE capability_health (
  capability_name TEXT PRIMARY KEY REFERENCES capability_registry(name),
  
  -- 使用统计(机械计数,无主观字段)
  total_writes INTEGER NOT NULL DEFAULT 0,       -- 业务表写入次数
  total_reads INTEGER NOT NULL DEFAULT 0,        -- 被查询次数(skill 召回 / dashboard 渲染)
  total_corrections INTEGER NOT NULL DEFAULT 0,  -- supersede 发生次数
  
  -- 时间标记
  last_write_at TEXT,
  last_read_at TEXT,
  
  updated_at TEXT NOT NULL
);
```

**注意**:这张表只做**机械统计**——它不存"评分"、"健康度分数"这类需要主观归一化的字段。
真正的判断逻辑(比如"多久没写算 stale"、"多少次读算频繁")写在 Reflect Agent 的代码里,
不预设到 schema 里。这样 dogfood 后调整阈值不需要 migration。

### 3.2 业务表通用约束

任何 Claude Code 生成的业务表**必须**包含:

```sql
CREATE TABLE <capability>_<entity>s (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  
  -- 必备:溯源
  raw_event_id INTEGER NOT NULL REFERENCES raw_events(id),
  
  -- 必备:提取版本
  extraction_version INTEGER NOT NULL DEFAULT 1,
  extraction_confidence REAL,
  
  -- 必备:时间
  occurred_at TEXT NOT NULL,         -- ISO 8601 with TZ
  
  -- 业务字段(具体能力具体设计)...
  
  -- 必备:meta
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  
  CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1))
);
```

约定:
- 金额字段 `_minor INTEGER` + `currency TEXT`(避免浮点)
- 布尔字段 `is_<noun> INTEGER` (0/1,SQLite 无 BOOLEAN)
- 枚举字段 `<name>_kind TEXT` + CHECK constraint
- 时间字段 `<event>_at TEXT` (ISO 8601)
- FK 字段 `<table>_id INTEGER REFERENCES <table>(id)`

### 3.3 数据库连接抽象

为了未来扩展性(SQLite → Postgres),所有数据访问通过 repository 层:

```typescript
// src/db/repository.ts
export interface Repository<T> {
  findById(id: number): Promise<T | null>;
  findMany(query: Query<T>): Promise<T[]>;
  insert(data: Partial<T>): Promise<T>;
  update(id: number, patch: Partial<T>): Promise<T>;
  delete(id: number): Promise<void>;  // 软删除
  transaction<R>(fn: () => Promise<R>): Promise<R>;
}

// 具体实现
export class SQLiteRepository<T> implements Repository<T> { /* ... */ }
```

应用层不直接写 SQL,通过 repository 调用——切换存储只需要换实现。

---

## 4. 目录结构

### 4.1 用户机器上的目录

```
~/.strata/
├── main.db                          # 主 SQLite 数据库
├── main.db-wal                      # SQLite WAL
├── main.db-shm                      # SQLite shared memory
│
├── config.json                      # Strata 配置(无 API key)
│
├── openspec/                        # OpenSpec 工作目录
│   ├── project.md                   # 项目描述(供 Claude Code 读)
│   ├── AGENTS.md                    # ★ 系统宪法
│   ├── config.yaml                  # OpenSpec 配置(workflows profile)
│   ├── specs/                       # 永久 specs
│   │   ├── expenses/
│   │   │   └── spec.md
│   │   └── ...
│   └── changes/
│       ├── 001-init-expenses-schema/
│       │   ├── proposal.md
│       │   ├── specs/
│       │   ├── design.md
│       │   └── tasks.md
│       └── archive/
│           ├── _pending/            # 已完成但 micro-app 未集成
│           └── 2026-05-10-init-expenses-schema/
│
├── capabilities/                    # 浮现的能力代码
│   ├── expenses/
│   │   ├── v1/
│   │   │   ├── meta.json
│   │   │   ├── migrations/
│   │   │   │   └── 001_init.sql
│   │   │   ├── pipeline.ts
│   │   │   ├── extract_prompt.md
│   │   │   ├── skill/
│   │   │   │   └── SKILL.md
│   │   │   ├── dashboard.json
│   │   │   ├── cron.json
│   │   │   └── tests/
│   │   │       └── *.test.ts
│   │   ├── v2/                      # 升级后的版本
│   │   └── current → v2/            # symlink 指向 current
│   └── moods/
│       └── ...
│
├── plans/                           # Plan Phase 沉淀
│   └── 2026-05-11-stock-tracker/
│       ├── exploration.md           # explore 阶段对话摘要
│       ├── v1.md                    # 初版 plan
│       ├── v2.md                    # 用户调整后
│       └── final.md                 # 用户最终批准的
│
├── builds/                          # Build workdir(临时)
│   └── <session_id>-<timestamp>/
│       ├── AGENTS.md                # 复制自 openspec/AGENTS.md
│       ├── PLAN.md                  # 复制自 plans/.../final.md
│       ├── USER_CONTEXT.md          # 动态生成
│       ├── existing_capabilities/   # 现有能力 read-only snapshot
│       └── .git/
│
├── logs/                            # 日志
│   ├── plugin.log
│   ├── reextract.log
│   └── orchestrator.log
│
└── .strata-state/                   # 内部状态
    ├── pending_buffer.json          # session pending events 缓存
    └── locks/                       # 文件锁
```

### 4.2 Strata Plugin 源码结构

```
strata-plugin/
├── package.json
├── tsconfig.json
├── README.md
├── plugin.json                      # OpenClaw plugin manifest
│
├── src/
│   ├── index.ts                     # plugin 入口,注册 hooks/tools/skills
│   │
│   ├── core/                        # 核心基础设施
│   │   ├── config.ts                # 配置加载与校验
│   │   ├── logger.ts
│   │   └── errors.ts
│   │
│   ├── db/                          # 数据库层
│   │   ├── connection.ts            # SQLite 连接管理
│   │   ├── migrations/              # Strata core 系统表 migration
│   │   │   ├── 001_messages.sql
│   │   │   ├── 002_raw_events.sql
│   │   │   ├── 003_capability_registry.sql
│   │   │   ├── 004_schema_evolutions.sql
│   │   │   ├── 005_reextract_jobs.sql
│   │   │   ├── 006_builds.sql
│   │   │   ├── 007_proposals.sql
│   │   │   └── 008_capability_health.sql
│   │   ├── repositories/
│   │   │   ├── messages.ts
│   │   │   ├── raw_events.ts
│   │   │   ├── capability_registry.ts
│   │   │   ├── schema_evolutions.ts
│   │   │   ├── reextract_jobs.ts
│   │   │   ├── builds.ts
│   │   │   ├── proposals.ts
│   │   │   └── capability_health.ts
│   │   └── repository.ts            # Repository 抽象
│   │
│   ├── hooks/                       # OpenClaw hooks
│   │   ├── on_user_message.ts       # 兜底写 messages 表
│   │   └── on_assistant_message.ts
│   │
│   ├── tools/                       # 给 agent 用的 tools
│   │   ├── create_pending_event.ts
│   │   ├── update_pending_event.ts
│   │   ├── commit_event.ts
│   │   ├── supersede_event.ts
│   │   ├── abandon_event.ts
│   │   └── search_events.ts
│   │
│   ├── skills/                      # Skill markdown 文件
│   │   ├── capture/
│   │   │   └── SKILL.md
│   │   ├── query/
│   │   │   └── SKILL.md
│   │   └── build/
│   │       └── SKILL.md
│   │
│   ├── triage/                      # 意图分类
│   │   ├── index.ts
│   │   └── prompts.ts
│   │
│   ├── callbacks/                   # IM 回调处理
│   │   └── inline_keyboard.ts
│   │
│   ├── reflect/                     # Reflect Agent
│   │   ├── index.ts                 # 主入口
│   │   ├── scanner.ts               # 扫描 raw_events
│   │   ├── pattern_detector.ts      # 模式识别
│   │   ├── emergence_detector.ts    # 浮现新能力/升级 schema 触发
│   │   ├── decay_detector.ts        # 归档触发
│   │   ├── proposal_generator.ts    # 生成 proposals
│   │   └── prompts.ts
│   │
│   ├── build/                       # Build Bridge
│   │   ├── index.ts                 # 主入口
│   │   ├── plan_phase.ts            # Plan(用 /opsx:explore)
│   │   ├── decompose_phase.ts       # 拆分(用 /opsx:propose)
│   │   ├── orchestrator.ts          # 调度 changes(/opsx:apply/verify/archive)
│   │   ├── claude_code_runner.ts    # spawn Claude Code subprocess
│   │   ├── progress_forwarder.ts    # 转发进度到 IM
│   │   ├── integration.ts           # Integration Layer
│   │   ├── post_deploy.ts           # Post-deploy
│   │   ├── stop_resume.ts           # 暂停/恢复
│   │   ├── validator.ts             # 自定义验收
│   │   ├── templates/
│   │   │   ├── AGENTS.md.template
│   │   │   ├── PLAN.md.template
│   │   │   └── USER_CONTEXT.md.template
│   │   └── prompts.ts
│   │
│   ├── reextract/                   # 历史回填
│   │   ├── worker.ts                # 后台 worker
│   │   ├── strategies/
│   │   │   ├── derive_existing.ts
│   │   │   ├── reextract_raw_events.ts
│   │   │   └── reextract_messages.ts
│   │   └── checkpointing.ts
│   │
│   ├── pending_buffer/              # session 级 pending 管理
│   │   ├── index.ts
│   │   ├── timeout.ts               # 超时自动 commit/abandon
│   │   └── persistence.ts
│   │
│   ├── capabilities/                # 能力加载与热重载
│   │   ├── loader.ts                # 加载 capabilities/<name>/v<N>/
│   │   ├── pipeline_runner.ts       # 跑 ingest pipeline
│   │   └── skill_registrar.ts       # 注册到 OpenClaw
│   │
│   └── dashboard/                   # Dashboard 渲染(IM 内)
│       ├── index.ts
│       ├── widget_renderer.ts
│       └── kpi.ts
│
└── tests/
    ├── unit/
    ├── integration/
    └── fixtures/
```

---

## 5. 核心模块详细设计

### 5.1 Plugin 入口 (src/index.ts)

```typescript
import { definePlugin } from '@openclaw/sdk';
import { onUserMessage, onAssistantMessage } from './hooks';
import { tools } from './tools';
import { skills } from './skills';
import { handleInlineKeyboard } from './callbacks/inline_keyboard';
import { initDatabase } from './db/connection';
import { startReflectAgent } from './reflect';
import { startReextractWorker } from './reextract/worker';
import { startPendingBufferTimeoutLoop } from './pending_buffer/timeout';
import { loadAllCapabilities } from './capabilities/loader';

export default definePlugin({
  id: 'strata',
  name: 'Strata',
  version: '1.0.0',
  
  async onLoad(api) {
    // 1. 初始化数据库
    await initDatabase();
    
    // 2. 加载已有 capabilities
    await loadAllCapabilities(api);
    
    // 3. 启动后台任务
    startReflectAgent(api);            // 周日凌晨跑
    startReextractWorker(api);          // 持续监控 reextract_jobs
    startPendingBufferTimeoutLoop(api); // 每分钟扫一次超时 pending
  },
  
  hooks: {
    onUserMessage,
    onAssistantMessage,
  },
  
  tools: Object.values(tools),
  
  skills: skills,
  
  callbacks: {
    inlineKeyboard: handleInlineKeyboard,
  },
});
```

### 5.2 Hooks: onUserMessage

**唯一职责**:每条用户消息到达时,机械地写入 messages 表。**不做任何 agent 决策**。

```typescript
// src/hooks/on_user_message.ts
import { Hook } from '@openclaw/sdk';
import { messagesRepo } from '../db/repositories/messages';
import { computeEmbedding } from '../core/embeddings';

export const onUserMessage: Hook = async (api, message) => {
  try {
    const turnIndex = await messagesRepo.getNextTurnIndex(message.session_id);
    
    const msgId = await messagesRepo.insert({
      session_id: message.session_id,
      channel: message.channel,
      role: 'user',
      content: message.text,
      content_type: message.contentType || 'text',
      turn_index: turnIndex,
      received_at: new Date().toISOString(),
    });
    
    // 异步生成 embedding(不阻塞)
    computeEmbedding(message.text).then(embedding => {
      messagesRepo.updateEmbedding(msgId, embedding);
    }).catch(err => api.logger.warn('embedding failed', err));
    
  } catch (err) {
    // 写库失败是严重问题,但不能阻塞 agent
    api.logger.error('Failed to persist user message', err);
  }
};
```

`onAssistantMessage` 对称——记录 agent 回复。

### 5.3 Tools

#### 5.3.1 strata_create_pending_event

```typescript
// src/tools/create_pending_event.ts
import { Tool } from '@openclaw/sdk';
import { z } from 'zod';
import { rawEventsRepo } from '../db/repositories/raw_events';
import { pendingBuffer } from '../pending_buffer';

export const createPendingEvent: Tool = {
  name: 'strata_create_pending_event',
  description: `
Create a pending raw_event to be confirmed by the user.

Use when the user has shared structured data that should be persisted
(consumption, exercise, mood, reading, purchase, etc.) AND the event
is clear enough to summarize but needs user confirmation.

Do NOT use for:
- Simple questions (use query skill instead)
- Vague statements ("today was tough" without specifics)
- Build requests (use build skill instead)
  `,
  parameters: z.object({
    event_type: z.string().describe('Type: consumption|mood|workout|reading|... or unclassified'),
    capability_name: z.string().optional().describe('If matches existing capability, the name. Otherwise omit.'),
    extracted_data: z.record(z.unknown()).describe('Structured data extracted from the message'),
    source_summary: z.string().describe('One-line summary in user-facing language'),
    event_occurred_at: z.string().optional().describe('ISO 8601, if user mentioned specific time'),
    primary_message_id: z.number().describe('The message that triggered this event'),
    confidence: z.number().min(0).max(1).describe('How confident extraction is'),
  }),
  
  async execute(input, api) {
    const eventId = await rawEventsRepo.insert({
      session_id: api.context.session_id,
      event_type: input.event_type,
      capability_name: input.capability_name,
      status: 'pending',
      extracted_data: JSON.stringify(input.extracted_data),
      source_summary: input.source_summary,
      primary_message_id: input.primary_message_id,
      related_message_ids: JSON.stringify([input.primary_message_id]),
      event_occurred_at: input.event_occurred_at,
      extraction_confidence: input.confidence,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    
    // 加入 pending buffer
    await pendingBuffer.add(api.context.session_id, eventId);
    
    // 发 inline keyboard
    await api.channel.send({
      text: `${input.source_summary}\n\n要记下吗?`,
      inlineKeyboard: [[
        { text: '✅ 记录', callback_data: `strata:commit:${eventId}` },
        { text: '✏️ 调整', callback_data: `strata:edit:${eventId}` },
        { text: '❌ 不记', callback_data: `strata:abandon:${eventId}` },
      ]],
    });
    
    return {
      event_id: eventId,
      status: 'awaiting_confirmation',
    };
  },
};
```

#### 5.3.2 strata_update_pending_event

```typescript
export const updatePendingEvent: Tool = {
  name: 'strata_update_pending_event',
  description: `
Update fields of an existing pending raw_event.

Use when:
- User adds more details to a recently created pending event
- User corrects a field in pending state ("不对,是 ¥48 不是 ¥45")
  `,
  parameters: z.object({
    event_id: z.number(),
    patch: z.record(z.unknown()).describe('Fields to update in extracted_data'),
    new_summary: z.string().optional().describe('Updated summary if changes are significant'),
    related_message_id: z.number().describe('The message containing this update'),
  }),
  
  async execute(input, api) {
    const current = await rawEventsRepo.findById(input.event_id);
    if (!current || current.status !== 'pending') {
      throw new Error(`Event ${input.event_id} is not in pending state`);
    }
    
    const oldData = JSON.parse(current.extracted_data);
    const newData = { ...oldData, ...input.patch };
    const newRelated = [...JSON.parse(current.related_message_ids), input.related_message_id];
    
    await rawEventsRepo.update(input.event_id, {
      extracted_data: JSON.stringify(newData),
      related_message_ids: JSON.stringify(newRelated),
      source_summary: input.new_summary || current.source_summary,
      updated_at: new Date().toISOString(),
    });
    
    // 重新发 inline keyboard(更新后的内容)
    await api.channel.send({
      text: `更新为: ${input.new_summary || current.source_summary}\n\n确认记录吗?`,
      inlineKeyboard: [[
        { text: '✅ 记录', callback_data: `strata:commit:${input.event_id}` },
        { text: '❌ 不记', callback_data: `strata:abandon:${input.event_id}` },
      ]],
    });
    
    return { event_id: input.event_id, status: 'updated' };
  },
};
```

#### 5.3.3 strata_commit_event

```typescript
export const commitEvent: Tool = {
  name: 'strata_commit_event',
  description: `
Commit a pending event to make it a permanent fact in the system.

Use when:
- User explicitly confirms ("记一下", "OK", "yes")
- User's response strongly implies confirmation
  `,
  parameters: z.object({
    event_id: z.number(),
  }),
  
  async execute(input, api) {
    return await commitEventCore(input.event_id, api);
  },
};

// 共享的核心逻辑(callback 也用)
export async function commitEventCore(eventId: number, api: any) {
  const event = await rawEventsRepo.findById(eventId);
  if (!event) throw new Error(`Event ${eventId} not found`);
  if (event.status !== 'pending') {
    throw new Error(`Event ${eventId} is not pending (current: ${event.status})`);
  }
  
  await rawEventsRepo.update(eventId, {
    status: 'committed',
    committed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  
  // 从 pending buffer 移除
  await pendingBuffer.remove(event.session_id, eventId);
  
  // 写 OpenClaw memory(用于跨 session 修正)
  await api.memory.store({
    content: `[event#${eventId}] ${event.source_summary} @ ${event.event_occurred_at || event.created_at}`,
    metadata: {
      strata_event_id: eventId,
      strata_event_type: event.event_type,
      strata_capability: event.capability_name,
    },
  });
  
  // 触发业务表写入(如果绑定了 capability)
  if (event.capability_name) {
    const { runPipeline } = await import('../capabilities/pipeline_runner');
    await runPipeline(event.capability_name, event);
  }
  
  // 更新 capability_health
  if (event.capability_name) {
    await capabilityHealthRepo.incrementWrite(event.capability_name);
  }
  
  return {
    event_id: eventId,
    status: 'committed',
    capability_written: !!event.capability_name,
  };
}
```

#### 5.3.4 strata_supersede_event

```typescript
export const supersedeEvent: Tool = {
  name: 'strata_supersede_event',
  description: `
Supersede an old committed event with new information (cross-session correction).

Use when:
- User in a new session corrects a previously recorded fact
- ("上周一咖啡其实是 ¥48 不是 ¥45")

First use strata_search_events to find the old event ID.
  `,
  parameters: z.object({
    old_event_id: z.number(),
    new_extracted_data: z.record(z.unknown()),
    new_summary: z.string(),
    correction_message_id: z.number(),
  }),
  
  async execute(input, api) {
    const old = await rawEventsRepo.findById(input.old_event_id);
    if (!old) throw new Error(`Event ${input.old_event_id} not found`);
    if (old.status !== 'committed') {
      throw new Error(`Can only supersede committed events`);
    }
    
    // 创建新的 committed event
    const newId = await rawEventsRepo.insert({
      session_id: api.context.session_id,
      event_type: old.event_type,
      capability_name: old.capability_name,
      status: 'committed',
      extracted_data: JSON.stringify(input.new_extracted_data),
      source_summary: input.new_summary,
      primary_message_id: input.correction_message_id,
      related_message_ids: JSON.stringify([input.correction_message_id]),
      event_occurred_at: old.event_occurred_at,
      committed_at: new Date().toISOString(),
      supersedes_event_id: input.old_event_id,
      extraction_version: old.extraction_version,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    
    // 标记老的为 superseded
    await rawEventsRepo.update(input.old_event_id, {
      status: 'superseded',
      superseded_by_event_id: newId,
      updated_at: new Date().toISOString(),
    });
    
    // 更新业务表(如果有)
    if (old.capability_name && old.business_row_id) {
      const { updateBusinessRow } = await import('../capabilities/pipeline_runner');
      await updateBusinessRow(old.capability_name, old.business_row_id, input.new_extracted_data);
    }
    
    return { new_event_id: newId, old_event_id: input.old_event_id };
  },
};
```

#### 5.3.5 strata_abandon_event 和 strata_search_events

类似的设计——abandon 把 pending 改为 abandoned;search 提供 vector + FTS 综合检索 raw_events。

### 5.4 Skills

#### 5.4.1 capture skill

```markdown
---
name: capture
description: |
  Activate when the user shares structured data about their life:
  consumption, exercise, mood, reading, purchases, observations, etc.
  
  Examples that trigger this skill:
  - "今天买了 Blue Bottle 拿铁 ¥45"
  - "跑了 5km,用时 32 分钟"
  - "心情有点低落"
  - "刚读完《沉默的巡游》"
  
  Do NOT activate for:
  - Questions about historical data (use query skill)
  - Build requests ("我想加个X追踪") (use build skill)
  - Pure chitchat with no factual content
---

# Capture Skill

## Workflow

When user shares life data:

1. **Identify the event type**
   - consumption: 购物/餐饮/服务消费
   - workout: 运动记录
   - mood: 情绪记录
   - reading: 阅读记录
   - health: 健康指标(体重/血压等)
   - asset: 资产快照(股票/账户余额等)
   - relation: 人物/关系信息
   - other / unclassified

2. **Check if event_type matches existing capability**
   - Read context.capabilities (injected by Strata)
   - If yes, use capability_name in create_pending_event
   - If no, use event_type='unclassified' (Reflect agent may later propose new capability)

3. **Extract structured data**
   - For consumption: { merchant, amount_minor, currency, items?, occurred_at }
   - For workout: { activity_type, duration_minutes, distance_km?, intensity?, occurred_at }
   - ...
   - Always extract event_occurred_at if mentioned ("today/yesterday/3pm/just now")
   - Default occurred_at to received_at if not mentioned

4. **Confidence assessment**
   - >= 0.7: Clear and complete → create_pending_event with confidence
   - 0.3-0.7: Ambiguous → ask user one clarifying question first, then create
   - < 0.3: Too vague → don't create event, just acknowledge

5. **Call strata_create_pending_event**
   - Inline keyboard will be sent to user automatically
   - Wait for user's callback response (handled by callback handler)

## Handling follow-up

If user follows up with corrections/additions to a recently created pending event
(check pending_buffer for current session):

- Adding info → call strata_update_pending_event
- Correcting → call strata_update_pending_event with new values
- Confirming → call strata_commit_event (or wait for inline keyboard click)
- Cancelling → call strata_abandon_event

## Cross-session corrections

If user in a new session refers to a past event:
- "上周一咖啡其实是 ¥48"

1. Call memory_search to find the relevant past event
2. Call strata_search_events with time/keyword filter to confirm
3. Call strata_supersede_event with new data
```

#### 5.4.2 query skill 和 5.4.3 build skill

类似的设计——query 教 agent 怎么查业务表和 raw_events,build 教 agent 怎么识别 build_request 并触发 Build Bridge。

### 5.5 Callbacks: Inline Keyboard

```typescript
// src/callbacks/inline_keyboard.ts
import { commitEventCore } from '../tools/commit_event';
import { rawEventsRepo } from '../db/repositories/raw_events';

export async function handleInlineKeyboard(api, callback) {
  const data = callback.data;
  
  // 格式: strata:<action>:<event_id>
  if (!data.startsWith('strata:')) return;
  
  const [, action, eventIdStr] = data.split(':');
  const eventId = parseInt(eventIdStr);
  
  switch (action) {
    case 'commit':
      await commitEventCore(eventId, api);
      await api.callback.answer({ text: '✅ 已记录' });
      await api.channel.editMessage(callback.message_id, {
        text: callback.message_text.replace('要记下吗?', '✅ 已记录'),
        inlineKeyboard: null,
      });
      break;
    
    case 'abandon':
      await rawEventsRepo.update(eventId, {
        status: 'abandoned',
        abandoned_reason: 'user_declined_via_inline',
        updated_at: new Date().toISOString(),
      });
      await api.callback.answer({ text: '好的,不记' });
      await api.channel.editMessage(callback.message_id, {
        text: callback.message_text.replace('要记下吗?', '❌ 不记'),
        inlineKeyboard: null,
      });
      break;
    
    case 'edit':
      // 触发新一轮对话让 agent 帮用户改
      const event = await rawEventsRepo.findById(eventId);
      await api.channel.send({
        text: `当前: ${event.source_summary}\n要改什么?`,
      });
      // agent 接下来的回复会调用 strata_update_pending_event
      break;
  }
}
```

### 5.6 Triage

意图分类是个**轻量 LLM 调用**,决定哪个 skill 该被激活。

```typescript
// src/triage/index.ts
import { z } from 'zod';

const TriageResult = z.object({
  kind: z.enum(['capture', 'query', 'build_request', 'chitchat', 'correction']),
  confidence: z.number(),
  reasoning: z.string(),
});

export async function classifyIntent(message: string, context: any, api: any) {
  const response = await api.models.infer({
    model: 'fast',  // 用户配的 fast model(便宜)
    response_format: { type: 'json_schema', schema: TriageResult },
    messages: [
      { role: 'system', content: TRIAGE_PROMPT },
      { role: 'user', content: JSON.stringify({
        user_message: message,
        recent_messages: context.recentMessages,
        active_capabilities: context.activeCapabilities,
        pending_events: context.pendingEvents,
      }) },
    ],
  });
  
  return TriageResult.parse(JSON.parse(response.content));
}
```

Triage prompt 见 §7.3。

### 5.7 Reflect Agent

```typescript
// src/reflect/index.ts
import { CronJob } from 'cron';
import { scanRawEvents } from './scanner';
import { detectPatterns } from './pattern_detector';
import { detectNewCapabilityEmergence, detectSchemaEvolutionNeed } from './emergence_detector';
import { detectArchiveCandidates } from './decay_detector';
import { generateProposals } from './proposal_generator';
import { pushProposalsToUser } from './push';

export function startReflectAgent(api) {
  // 默认每周日凌晨 3:00(用户时区)
  const cron = new CronJob('0 3 * * 0', async () => {
    api.logger.info('Reflect agent starting...');
    
    try {
      // 1. 检测三类信号
      const newCapabilities = await detectNewCapabilityEmergence(api);
      const schemaEvolutions = await detectSchemaEvolutionNeed(api);
      const archiveCandidates = await detectArchiveCandidates(api);
      
      // 2. 生成 proposals
      const proposals = await generateProposals({
        newCapabilities,
        schemaEvolutions,
        archiveCandidates,
      }, api);
      
      // 3. 推送给用户
      await pushProposalsToUser(proposals, api);
      
    } catch (err) {
      api.logger.error('Reflect agent failed', err);
    }
  }, null, true, getUserTimezone());
}
```

#### 5.7.1 Pattern Detector

```typescript
// src/reflect/pattern_detector.ts
export async function detectPatterns(events: RawEvent[], api: any) {
  // 1. 聚类 unclassified events 和 event_type 没有对应 capability 的 events
  const unmapped = events.filter(e => 
    e.status === 'committed' && 
    (!e.capability_name || !isActiveCapability(e.capability_name))
  );
  
  // 2. 用 embedding 聚类
  const clusters = await clusterByEmbedding(unmapped);
  
  // 3. 对每个 cluster 让 LLM 判断
  const patterns = [];
  for (const cluster of clusters) {
    if (cluster.size < REFLECT_MIN_CLUSTER_SIZE) continue;
    if (cluster.spanDays < REFLECT_MIN_SPAN_DAYS) continue;
    
    const analysis = await api.models.infer({
      model: 'smart',
      response_format: { type: 'json_schema', schema: PatternAnalysis },
      messages: [
        { role: 'system', content: PATTERN_ANALYSIS_PROMPT },
        { role: 'user', content: JSON.stringify({
          cluster_size: cluster.size,
          span_days: cluster.spanDays,
          sample_events: cluster.events.slice(0, 10),
        }) },
      ],
    });
    
    if (analysis.confidence >= REFLECT_PATTERN_CONFIDENCE_THRESHOLD) {
      patterns.push({
        suggested_capability_name: analysis.suggestedName,
        suggested_schema: analysis.suggestedSchema,
        evidence_event_ids: cluster.events.map(e => e.id),
        signal_strength: analysis.confidence,
        rationale: analysis.rationale,
      });
    }
  }
  
  return patterns;
}
```

#### 5.7.2 Emergence Detector(浮现检测)

扫 raw_events,识别"该建立新 capability"或"该升级现有 capability"的信号:

```typescript
// src/reflect/emergence_detector.ts

// 浮现新能力的信号:event_type='unclassified' 的累积聚类
export async function detectNewCapabilityEmergence(api) {
  const unclassified = await rawEventsRepo.findMany({
    status: 'committed',
    capability_name: null,
  });
  
  // 用 embedding 聚类,LLM 判断每个 cluster 是否值得建 capability
  const clusters = await clusterByEmbedding(unclassified);
  const candidates = [];
  
  for (const cluster of clusters) {
    // MVP 阈值(从产品直觉来,dogfood 后会调):
    if (cluster.size < 10) continue;
    if (cluster.spanDays < 7) continue;
    
    const analysis = await api.models.infer({
      model: 'smart',
      messages: [
        { role: 'system', content: EMERGENCE_ANALYSIS_PROMPT },
        { role: 'user', content: JSON.stringify({ cluster_size: cluster.size, samples: cluster.events.slice(0, 10) }) },
      ],
    });
    
    if (analysis.confidence >= 0.7) {
      candidates.push({
        kind: 'new_capability',
        suggested_name: analysis.suggestedName,
        suggested_design: analysis.suggestedDesign,
        evidence_event_ids: cluster.events.map(e => e.id),
        signal_strength: analysis.confidence,
      });
    }
  }
  
  return candidates;
}

// 升级现有 capability 的信号:schema 字段使用 unbalanced(例如 food 太多)
export async function detectSchemaEvolutionNeed(api) {
  const activeCapabilities = await capabilityRegistryRepo.findMany({ status: 'active' });
  const candidates = [];
  
  for (const cap of activeCapabilities) {
    // 检测枚举字段是否高度集中(例:80% 都是某一个 category 值)
    const skew = await detectFieldSkew(cap.primary_table);
    if (skew.maxRatio > 0.6 && skew.totalRows > 30) {
      candidates.push({
        kind: 'schema_evolution',
        target_capability: cap.name,
        rationale: `Field '${skew.field}' value '${skew.dominantValue}' is ${Math.round(skew.maxRatio * 100)}% of rows. Consider subcategory.`,
        signal_strength: skew.maxRatio,
      });
    }
  }
  
  return candidates;
}
```

**关键说明**:
- 这里的阈值(`size >= 10`、`spanDays >= 7`、`maxRatio > 0.6` 等)是 **MVP 起点**,不是科学结论
- 阈值放在代码常量里(不是 schema 字段),改起来不需要 migration
- Dogfood 一段时间后根据真实命中率 / 误报率调整

#### 5.7.3 Decay Detector(衰减/归档检测)

```typescript
// src/reflect/decay_detector.ts

export async function detectArchiveCandidates(api) {
  const activeCapabilities = await capabilityRegistryRepo.findMany({ status: 'active' });
  const candidates = [];
  
  for (const cap of activeCapabilities) {
    const health = await capabilityHealthRepo.findById(cap.name);
    if (!health) continue;
    
    const daysSinceLastWrite = daysSince(health.last_write_at);
    const daysSinceLastRead = daysSince(health.last_read_at);
    
    // MVP 阈值
    if (daysSinceLastWrite > 90 && daysSinceLastRead > 30) {
      candidates.push({
        kind: 'capability_archive',
        target_capability: cap.name,
        rationale: `Last write ${daysSinceLastWrite}d ago, last read ${daysSinceLastRead}d ago.`,
        signal_strength: Math.min(daysSinceLastWrite / 180, 1.0),
      });
    }
  }
  
  return candidates;
}
```

**注意**:Archive 不等于删除——只是把 capability 的 status 从 `active` 改为 `archived`,业务表数据保留、pipeline 停止。
用户随时可以重启(archived → active)。物理删除(`deleted` 状态)仅在用户明确要求时发生。

### 5.8 Build Bridge

这是 5.8 节描述的 micro-app 开发协议的实现。代码大致结构:

```typescript
// src/build/index.ts
import { runPlanPhase } from './plan_phase';
import { runDecomposePhase } from './decompose_phase';
import { Orchestrator } from './orchestrator';
import { runIntegration } from './integration';
import { runPostDeploy } from './post_deploy';
import { buildsRepo } from '../db/repositories/builds';

export async function startBuild(opts: {
  trigger_kind: 'user_request' | 'reflect_proposal',
  trigger_proposal_id?: number,
  target_capability: string,
  target_action: 'create' | 'evolve' | 'archive',
  session_id: string,
  initial_request?: string,
}, api) {
  // 1. 创建 build session
  const buildId = await buildsRepo.insert({
    ...opts,
    phase: 'plan',
    created_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
  });
  
  try {
    // 2. Plan Phase
    await buildsRepo.update(buildId, { phase: 'plan' });
    const plan = await runPlanPhase(buildId, opts, api);
    
    if (plan.cancelled) {
      await buildsRepo.update(buildId, { phase: 'cancelled' });
      return;
    }
    
    // 3. Decompose Phase
    await buildsRepo.update(buildId, { phase: 'decompose' });
    const changes = await runDecomposePhase(buildId, plan, api);
    
    // 4. Orchestrate Build
    await buildsRepo.update(buildId, { 
      phase: 'build',
      changes_total: changes.length,
    });
    const orchestrator = new Orchestrator(buildId, api);
    await orchestrator.run(changes);
    
    // 5. Integration
    await buildsRepo.update(buildId, { phase: 'integrate' });
    await runIntegration(buildId, opts.target_capability, api);
    
    // 6. Post-deploy
    await buildsRepo.update(buildId, { phase: 'post_deploy' });
    await runPostDeploy(buildId, opts.target_capability, api);
    
    // 7. Done
    await buildsRepo.update(buildId, { 
      phase: 'done',
      completed_at: new Date().toISOString(),
    });
    
  } catch (err) {
    api.logger.error(`Build ${buildId} failed`, err);
    await buildsRepo.update(buildId, {
      phase: 'failed',
      failure_reason: err.message,
    });
    
    await api.channel.send({
      text: `❌ 构建失败: ${err.message}\n是否重试? [重试] [放弃]`,
    });
  }
}
```

#### 5.8.1 Plan Phase

```typescript
// src/build/plan_phase.ts
import { runClaudeCode } from './claude_code_runner';

export async function runPlanPhase(buildId: number, opts: any, api: any) {
  // 用 Claude Code 的 /opsx:explore 模式
  const workdir = await prepareWorkdir(buildId);
  
  const initialPrompt = opts.initial_request 
    ? `User wants: "${opts.initial_request}". Use /opsx:explore to refine.`
    : `Refer to proposals/${opts.trigger_proposal_id}.md. Use /opsx:explore to flesh out.`;
  
  // 启动 Claude Code 在 explore 模式
  // 注意:explore 模式下 Claude Code 不会自己生成文件
  // 但它的响应需要被转发到 IM,让用户跟它对话
  const result = await runClaudeCode({
    workdir,
    prompt: initialPrompt,
    mode: 'explore',
    maxTurns: 20,
    onProgress: (msg) => forwardToIM(msg, api),
    onUserInput: () => waitForIMUserInput(api),
  });
  
  if (result.cancelled) {
    return { cancelled: true };
  }
  
  // 当 Claude Code 觉得已经探索够了,它会写一个 PLAN.md
  const planPath = `${workdir}/PLAN.md`;
  const planContent = await fs.readFile(planPath, 'utf8');
  
  // 把 plan 持久化到 plans/
  const finalPlanPath = `~/.strata/plans/${timestamp()}-${opts.target_capability}/final.md`;
  await fs.copyFile(planPath, finalPlanPath);
  
  await buildsRepo.update(buildId, { plan_path: finalPlanPath });
  
  // 推给用户最终确认
  await api.channel.send({
    text: `📋 Plan 已确定,要开始构建吗?\n\n${summarizePlan(planContent)}`,
    inlineKeyboard: [[
      { text: '✅ 开始构建', callback_data: `strata:build_proceed:${buildId}` },
      { text: '✏️ 还要调整', callback_data: `strata:plan_continue:${buildId}` },
      { text: '❌ 取消', callback_data: `strata:build_cancel:${buildId}` },
    ]],
  });
  
  // 等用户回复
  const decision = await waitForUserDecision(buildId);
  
  return { cancelled: decision !== 'proceed', plan_path: finalPlanPath };
}
```

#### 5.8.2 Decompose Phase

```typescript
// src/build/decompose_phase.ts
export async function runDecomposePhase(buildId: number, plan: any, api: any) {
  const workdir = await getBuildWorkdir(buildId);
  
  // 让 Claude Code 用 /opsx:propose 多次,把 PLAN.md 拆成 atomic changes
  await runClaudeCode({
    workdir,
    prompt: `
Read PLAN.md carefully.

Decompose this plan into atomic OpenSpec changes. For each atomic change,
use /opsx:propose with a clear description.

Guidelines for atomicity:
- One change for new schema creation
- One change for ingest pipeline
- One change for agent skill
- One change for dashboard widgets
- One change for cron (if needed)

Order changes so that dependencies are satisfied (schema before ingest, etc.)

After creating all changes, write a CHANGES_SUMMARY.md listing them in order.
    `,
    mode: 'apply',
    maxTurns: 30,
    onProgress: (msg) => forwardToIM(msg, api),
  });
  
  // 读 CHANGES_SUMMARY.md 拿 change 列表
  const summary = await readChangesSummary(workdir);
  
  // 对每个 change 跑 openspec validate(基础检查)
  for (const change of summary.changes) {
    const result = await exec(`openspec validate ${change.id}`, { cwd: workdir });
    if (result.exitCode !== 0) {
      // 让 Claude Code 修
      await fixChangeValidation(change, result.stderr, workdir, api);
    }
  }
  
  // 推给用户审核 change 列表
  await api.channel.send({
    text: renderChangesSummary(summary),
    inlineKeyboard: [[
      { text: '✅ 全部批准', callback_data: `strata:approve_all:${buildId}` },
      { text: '📖 看详情', callback_data: `strata:view_changes:${buildId}` },
      { text: '❌ 取消', callback_data: `strata:build_cancel:${buildId}` },
    ]],
  });
  
  const decision = await waitForUserDecision(buildId);
  if (decision !== 'approve_all') {
    // 处理详情查看 / 取消...
  }
  
  return summary.changes;
}
```

#### 5.8.3 Orchestrator

```typescript
// src/build/orchestrator.ts
import { runClaudeCode } from './claude_code_runner';
import { validateChangeOutput } from './validator';

export class Orchestrator {
  constructor(public buildId: number, public api: any) {}
  
  async run(changes: Change[]) {
    const completed = [];
    
    for (const change of changes) {
      await this.api.channel.send({
        text: `🔨 [${change.id}] ${change.title}`,
      });
      
      let retries = 0;
      while (retries < 3) {
        try {
          // Apply
          await this.applyChange(change, completed);
          
          // Verify(OpenSpec 内置)
          await this.verifyChange(change);
          
          // Custom validation
          await validateChangeOutput(change, this.buildId);
          
          // Archive(staged 到 archive/_pending/)
          await this.archiveChange(change);
          
          completed.push(change);
          await buildsRepo.update(this.buildId, { 
            changes_done: completed.length,
            current_change_id: null,
          });
          
          await this.api.channel.send({
            text: `✅ [${change.id}] 完成 (${completed.length}/${changes.length})`,
          });
          
          break;  // 成功
          
        } catch (err) {
          retries++;
          if (retries < 3) {
            this.api.logger.warn(`Change ${change.id} attempt ${retries} failed: ${err.message}`);
            continue;
          }
          
          // 3 次都失败 → 让用户决定
          const decision = await this.askUserAboutFailure(change, err);
          if (decision === 'retry') {
            retries = 0;
            continue;
          } else if (decision === 'skip') {
            await this.markChangeSkipped(change);
            break;
          } else {
            throw new Error(`Build aborted by user at ${change.id}`);
          }
        }
      }
    }
    
    return completed;
  }
  
  async applyChange(change, completedSoFar) {
    const workdir = await getBuildWorkdir(this.buildId);
    
    await runClaudeCode({
      workdir,
      prompt: `/opsx:apply ${change.id}`,
      mode: 'apply',
      maxTurns: 80,
      claudeSessionId: await this.getClaudeSessionForBuild(),
      onProgress: (msg) => this.forwardProgress(change, msg),
      env: this.buildEnvWithContext(completedSoFar),
    });
  }
  
  async verifyChange(change) {
    const workdir = await getBuildWorkdir(this.buildId);
    const result = await exec(`openspec verify ${change.id}`, { cwd: workdir });
    
    if (result.exitCode !== 0) {
      // 提取 CRITICAL/WARNING/SUGGESTION
      const report = parseVerifyReport(result.stdout);
      
      if (report.criticals.length > 0) {
        throw new VerificationError(report);
      }
      
      // WARNING 不阻塞,但记录
      if (report.warnings.length > 0) {
        this.api.logger.warn(`Change ${change.id} verify warnings:`, report.warnings);
      }
    }
  }
  
  async archiveChange(change) {
    const workdir = await getBuildWorkdir(this.buildId);
    // Staged archive: 到 archive/_pending/ 而不是正式 archive/
    await exec(`openspec archive ${change.id} --staged`, { cwd: workdir });
  }
  
  // ... 其他辅助方法
}
```

#### 5.8.4 Claude Code Runner

```typescript
// src/build/claude_code_runner.ts
import { spawn } from 'child_process';

export async function runClaudeCode(opts: {
  workdir: string,
  prompt: string,
  mode: 'explore' | 'apply' | 'propose',
  maxTurns: number,
  claudeSessionId?: string,
  onProgress: (msg: any) => void,
  env?: Record<string, string>,
}) {
  const args = [
    '-p', opts.prompt,
    '--output-format', 'stream-json',
    '--max-turns', opts.maxTurns.toString(),
    '--allowed-tools', 'Read,Write,Edit,Bash,Glob,Grep,TodoWrite',
    '--deny-tools', 'WebFetch,WebSearch',
    '--dangerously-skip-permissions',  // MVP 阶段
  ];
  
  if (opts.claudeSessionId) {
    args.push('--resume', opts.claudeSessionId);
  }
  
  const proc = spawn('claude', args, {
    cwd: opts.workdir,
    env: { ...process.env, ...opts.env },
  });
  
  // 解析 stream-json 输出
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          opts.onProgress(msg);
        } catch (err) {
          // ignore parse errors
        }
      }
    }
  });
  
  // 等进程结束
  const exitCode = await new Promise<number>((resolve) => {
    proc.on('exit', (code) => resolve(code ?? -1));
  });
  
  if (exitCode !== 0) {
    throw new Error(`Claude Code exited with code ${exitCode}`);
  }
  
  return { exitCode };
}
```

#### 5.8.5 Integration Layer

```typescript
// src/build/integration.ts
export async function runIntegration(buildId: number, capabilityName: string, api: any) {
  const workdir = await getBuildWorkdir(buildId);
  const finalPath = `~/.strata/capabilities/${capabilityName}/v1/`;
  
  const snapshot = await createGitSnapshot();
  
  try {
    // 1. 把 _workdir 的产物移到 capabilities/
    await fs.move(`${workdir}/capabilities/${capabilityName}/v1/`, finalPath);
    
    // 2. 跑 migration
    const meta = await loadMeta(finalPath);
    await applyMigrations(`${finalPath}/migrations/`);
    
    // 3. 注册到 capability_registry(此时正式进入 active)
    await capabilityRegistryRepo.insert({
      name: capabilityName,
      version: 1,
      status: 'active',
      meta_path: `${finalPath}/meta.json`,
      primary_table: meta.primary_table,
      proposal_id: opts.proposal_id ?? null,
      build_id: buildId,
      created_at: new Date().toISOString(),
    });
    
    // 4. 热加载 pipeline
    await pluginRuntime.loadPipeline(capabilityName, finalPath);
    
    // 5. 注册 skill 到 OpenClaw
    await api.skills.register({
      path: `${finalPath}/skill/SKILL.md`,
      capability_name: capabilityName,
    });
    
    // 6. 注册 cron(如有)
    if (await fileExists(`${finalPath}/cron.json`)) {
      const crons = await readJson(`${finalPath}/cron.json`);
      for (const c of crons) {
        await scheduler.register(c);
      }
    }
    
    // 7. 注册 dashboard widgets
    if (await fileExists(`${finalPath}/dashboard.json`)) {
      const widgets = await readJson(`${finalPath}/dashboard.json`);
      await dashboardRegistry.register(capabilityName, widgets);
    }
    
    // 8. schema_evolutions 登记
    await schemaEvolutionsRepo.insert({
      capability_name: capabilityName,
      from_version: 0,
      to_version: 1,
      change_type: 'capability_create',
      diff: JSON.stringify({ new: true }),
      proposed_at: new Date().toISOString(),
      approved_at: new Date().toISOString(),
      applied_at: new Date().toISOString(),
      approved_by: 'user',
      backfill_strategy: 'none',
      backfill_status: 'not_needed',
    });
    
    // 9. 创建 capability_health 初始记录
    await capabilityHealthRepo.insert({
      capability_name: capabilityName,
      updated_at: new Date().toISOString(),
    });
    
    // 10. 把 _pending archives promote 到正式 archive
    await promotePendingArchives(workdir);
    
    // 11. symlink current
    await fs.symlink(finalPath, `~/.strata/capabilities/${capabilityName}/current`);
    
    // 12. git commit
    await gitCommit('main', `integrate: ${capabilityName} v1`);
    
  } catch (err) {
    await revertToSnapshot(snapshot);
    throw err;
  }
}
```

### 5.9 Re-extraction Worker

```typescript
// src/reextract/worker.ts
export function startReextractWorker(api) {
  // 每 30 秒检查 reextract_jobs
  setInterval(async () => {
    const job = await reextractJobsRepo.findOne({ status: 'pending' });
    if (!job) return;
    
    await reextractJobsRepo.update(job.id, { 
      status: 'running',
      started_at: new Date().toISOString(),
    });
    
    try {
      await runReextract(job, api);
      await reextractJobsRepo.update(job.id, { 
        status: 'done',
        completed_at: new Date().toISOString(),
      });
    } catch (err) {
      await reextractJobsRepo.update(job.id, {
        status: 'failed',
        last_error: err.message,
      });
    }
  }, 30_000);
}

async function runReextract(job, api) {
  // 根据策略选择 worker
  const strategy = await import(`./strategies/${job.strategy}`);
  
  // 获取待回填的 rows
  const rows = await getRowsToBackfill(job);
  await reextractJobsRepo.update(job.id, { rows_total: rows.length });
  
  // 逐个回填
  for (const row of rows) {
    try {
      const result = await strategy.process(row, job, api);
      
      if (result.confidence >= 0.7) {
        await updateBusinessRow(job.capability_name, row.id, result.data);
        await reextractJobsRepo.increment(job.id, 'rows_done');
      } else if (result.confidence >= 0.3) {
        await markLowConfidence(row, result);
        await reextractJobsRepo.increment(job.id, 'rows_low_confidence');
      } else {
        await markUnableToExtract(row);
        await reextractJobsRepo.increment(job.id, 'rows_failed');
      }
    } catch (err) {
      await reextractJobsRepo.increment(job.id, 'rows_failed');
    }
    
    // 每 20 条 checkpoint
    if ((rows_done % 20) === 0) {
      await reextractJobsRepo.update(job.id, {
        last_checkpoint_at: new Date().toISOString(),
      });
    }
  }
}
```

### 5.10 Pending Buffer

```typescript
// src/pending_buffer/index.ts
const PENDING_TIMEOUT_MINUTES = 30;

export const pendingBuffer = {
  async add(sessionId: string, eventId: number) {
    // 加入 buffer + 设超时
    // ...
  },
  
  async getAll(sessionId: string): Promise<number[]> {
    // 返回 session 的所有 pending event id
    // ...
  },
  
  async remove(sessionId: string, eventId: number) {
    // ...
  },
};

// src/pending_buffer/timeout.ts
export function startPendingBufferTimeoutLoop(api) {
  setInterval(async () => {
    // 找超时的 pending events
    const expired = await rawEventsRepo.findExpiredPending(PENDING_TIMEOUT_MINUTES);
    
    for (const event of expired) {
      // 简单事件超时自动 commit(基于 confidence)
      if (event.extraction_confidence >= 0.7) {
        await commitEventCore(event.id, api);
        await api.channel.send({
          text: `(自动确认了 ${event.source_summary})`,
        });
      } else {
        await rawEventsRepo.update(event.id, {
          status: 'abandoned',
          abandoned_reason: 'pending_timeout',
        });
      }
    }
  }, 60_000);
}
```

---

## 6. AGENTS.md(系统宪法)

这是 Claude Code 在共建时**自动读**的文件,决定它的工作行为。**它是单一最重要的工程产出**。

```markdown
# Strata System Constitution

You are working inside a user's Strata personal data system. Read this carefully
before writing any code. Violations will fail validation and require rework.

## Architecture

Strata is a personal data sediment system. Key facts:

- Strata is implemented as an OpenClaw plugin (TypeScript).
- SQLite at ~/.strata/main.db is the source of truth.
- All business data follows two-layer pattern: messages → raw_events → business_table
- Business tables are written by exactly ONE ingest pipeline (owner pipeline rule).
- All other components have READ-ONLY access to business tables.
- LLM access goes through OpenClaw's model provider abstraction—NEVER hardcode API keys.

## Hard constraints (MUST follow, validation will fail otherwise)

1. **Raw events are append-only.** Never DELETE or UPDATE rows in raw_events.
   For corrections, use the supersedes_event_id chain.

2. **Money uses INTEGER minor units.** Never use FLOAT for money.
   - Correct: `amount_minor INTEGER NOT NULL`, `currency TEXT NOT NULL DEFAULT 'CNY'`
   - Wrong: `amount REAL`

3. **All timestamps are ISO 8601 with timezone.**
   - Correct: `occurred_at TEXT NOT NULL` storing `"2026-05-11T15:30:00+08:00"`
   - Wrong: SQLite DATETIME or naive strings

4. **Every business table row MUST have these fields:**
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `raw_event_id INTEGER NOT NULL REFERENCES raw_events(id)`
   - `extraction_version INTEGER NOT NULL DEFAULT 1`
   - `extraction_confidence REAL` (NULL if not extracted by LLM)
   - `occurred_at TEXT NOT NULL`
   - `created_at TEXT NOT NULL`
   - `updated_at TEXT NOT NULL`

5. **Migrations are immutable.** Once applied, never edit a migration file.
   For schema changes, add a new migration with the next sequence number.

6. **Schema evolution must update schema_evolutions registry.**
   Any ALTER TABLE in your migration must also INSERT into schema_evolutions.

## Naming conventions

- Capability directory: `~/.strata/capabilities/<snake_case_name>/v<N>/`
- Primary business table: `<capability>_<entity_plural>` (e.g., `expenses`, `mood_logs`)
- Migration file: `migrations/<NNN>_<description>.sql` (zero-padded 3-digit prefix)
- Pipeline file: `pipeline.ts`
- Extraction prompt: `extract_prompt.md`
- Skill: `skill/SKILL.md`
- Dashboard config: `dashboard.json`
- Cron config: `cron.json`
- Meta: `meta.json`
- Tests: `tests/*.test.ts`

### Field naming
- Money: `<purpose>_minor INTEGER` paired with `currency TEXT`
- Timestamps: `<event>_at TEXT` (ISO 8601)
- Booleans: `is_<noun> INTEGER` (0/1; SQLite has no BOOLEAN)
- Enums: `<name>_kind TEXT` with CHECK constraint
- Foreign keys: `<table>_id INTEGER REFERENCES <table>(id)`

## File structure for a capability

```
capabilities/<name>/v<N>/
├── meta.json              # Capability metadata
├── migrations/
│   └── 001_init.sql      # Or 002_add_subcategory.sql etc.
├── pipeline.ts            # Ingest logic
├── extract_prompt.md      # LLM extraction prompt
├── skill/
│   └── SKILL.md          # Agent skill for this domain
├── dashboard.json        # Widget definitions (optional)
├── cron.json             # Scheduled tasks (optional)
└── tests/
    └── *.test.ts
```

### meta.json schema

```json
{
  "name": "expenses",
  "version": 1,
  "description": "Track personal consumption with merchant/amount/category",
  "primary_table": "expenses",
  "depends_on_capabilities": [],
  "ingest_event_types": ["consumption"],
  "owner_pipeline": "pipeline.ts",
  "exposed_skills": ["skill/SKILL.md"]
}
```

## What you can do (within scope)

- Create new business tables (always with required fields above)
- Write ingest pipelines (match raw_events, parse, write business table)
- Write LLM extraction prompts
- Write agent skills for querying this domain
- Define dashboard widgets
- Register cron jobs
- Write tests

## What you MUST NOT do

- Modify any file outside the current change's scope
- Modify any file in core/ or shared/
- Modify any file in another capability's directory
- Delete any data (including in your own capability—use soft delete via status field)
- Bypass the owner-pipeline rule (one pipeline per business table)
- Skip writing tests
- Hardcode API keys, model names, or provider URLs
- Use Bash to install packages globally
- Make network requests during build (no WebFetch/WebSearch)

## LLM access

- For extraction prompts and reasoning, the pipeline will call OpenClaw's 
  `api.models.infer({ model: 'fast' | 'smart' })`. Never hardcode model names.
- The user's API keys are managed by OpenClaw configuration. You never touch them.

## Failure escape

If you encounter the same error 3+ times in a row, STOP and write a file 
called `BUILD_STUCK.md` in the workdir with:
- What you were trying to do
- The error encountered  
- What you've already tried
- Specific question for the user

Then exit gracefully. Do NOT keep retrying indefinitely.

## OpenSpec workflow

You are using OpenSpec workflows profile. Key commands:
- `/opsx:propose <description>` - Create a change with proposal/specs/design/tasks
- `/opsx:apply <change-id>` - Implement the tasks
- `/opsx:verify <change-id>` - Run validation gate
- `/opsx:archive <change-id>` - Archive after successful integration

Always:
- Check off tasks in tasks.md as you complete them
- Run `/opsx:verify` after implementation, before archiving
- Address all CRITICAL findings before archiving (WARNINGs can be acknowledged)

## Testing requirements

Every capability MUST have tests for:
1. Migration applies cleanly to a fresh DB
2. Pipeline correctly extracts at least 3 sample inputs
3. Schema constraints are enforced (e.g., NOT NULL, CHECK)
4. Extracted row has correct extraction_version and raw_event_id FK

## Reference: Existing capabilities

Before writing any new capability, ALWAYS read the files in 
`existing_capabilities/` directory in your workdir. These are read-only 
snapshots of capabilities already in the system. Follow their style for 
naming, field conventions, and prompt patterns.
```

---

## 7. 关键 Prompt 模板

### 7.1 Triage Prompt

```
You are the intent classifier for Strata, a personal data sediment system.
Given a user message and context, classify the intent.

Available kinds:
- capture: User is sharing factual life data (consumption, exercise, mood, etc.)
- query: User is asking about historical data ("how much did I spend last month")
- build_request: User explicitly asks to add a new capability or modify existing
- correction: User is correcting a previously recorded fact
- chitchat: Other (greetings, casual conversation, etc.)

Return JSON matching the schema. Be precise: when uncertain, prefer chitchat
over capture (we'd rather miss a record than fabricate one).

Context provided:
- User's recent 3 messages
- List of active capabilities
- Pending events in current session
```

### 7.2 Pattern Analysis Prompt(for Reflect Agent)

```
You are analyzing a cluster of similar raw_events that don't fit any 
existing capability. Determine if this cluster represents a coherent
domain that should become a new Strata capability.

Cluster info:
- Size: {size} events
- Span: {spanDays} days  
- Sample events: {samples}

Return JSON with:
- isCoherentDomain: boolean
- suggestedName: snake_case proposed capability name
- suggestedSchema: high-level proposed fields (just names + types)
- rationale: 1-2 sentence explanation
- confidence: 0-1

A coherent domain means:
- Events have similar structure (same kinds of fields would apply)
- User talks about them with consistent vocabulary
- It would make sense to query/aggregate across them

If the cluster is too heterogeneous or too small to justify a capability,
set isCoherentDomain=false.
```

### 7.3 Capture Skill 内嵌 prompt 提示

(已在 5.4.1 中描述)

### 7.4 Decompose Prompt

```
You are decomposing a user-approved PLAN.md into atomic OpenSpec changes.

Read PLAN.md carefully. Then for each atomic unit of work, run /opsx:propose
with a clear description. Each change should:

- Be implementable in ~3-5 minutes by Claude Code
- Have clear dependencies (schema before pipeline before skill, etc.)
- Be independently verifiable

Typical decomposition for a new capability:
1. Schema + meta.json + migration (depends on: nothing)
2. Ingest pipeline + extract_prompt (depends on: 1)
3. Agent skill (depends on: 1, 2)
4. Dashboard widgets (depends on: 1, optional)
5. Cron jobs (depends on: 1, 2, optional)

For schema evolution, typical decomposition:
1. New migration ALTER TABLE
2. Updated extract_prompt
3. Updated pipeline
4. Re-extraction job registration
5. Updated dashboard (if affected)

After creating all changes, write CHANGES_SUMMARY.md with:
- Ordered list of change IDs
- One-line description for each
- Dependency markers
```

---

## 8. 验收 Checklist

每个 OpenSpec change 完成 `/opsx:apply` 后,Orchestrator 跑这套自定义 validation:

```typescript
const validationChecks = [
  {
    name: 'change_scope',
    description: 'Verify only files in change scope were modified',
    check: async (change, workdir) => {
      const modified = await getModifiedFiles(workdir, since: change.startCommit);
      const scope = await getChangeScope(change);
      return modified.every(f => scope.includes(f));
    },
  },
  {
    name: 'required_fields_in_business_tables',
    description: 'New business tables have all required fields',
    check: async (change, workdir) => {
      const newTables = await extractNewTables(change);
      for (const table of newTables) {
        const cols = table.columns;
        assert(cols.has('id'));
        assert(cols.has('raw_event_id'));
        assert(cols.has('extraction_version'));
        assert(cols.has('extraction_confidence'));
        assert(cols.has('occurred_at'));
        assert(cols.has('created_at'));
        assert(cols.has('updated_at'));
      }
    },
  },
  {
    name: 'no_float_for_money',
    description: 'Money fields use INTEGER',
    check: async (change, workdir) => {
      const migration = await readChangeMigration(change, workdir);
      const moneyFields = extractMoneyFields(migration);
      return moneyFields.every(f => f.type === 'INTEGER' && f.name.endsWith('_minor'));
    },
  },
  {
    name: 'iso_8601_timestamps',
    description: 'Timestamp fields are TEXT (for ISO 8601)',
    check: async (change, workdir) => {
      const migration = await readChangeMigration(change, workdir);
      const timeFields = extractTimeFields(migration);
      return timeFields.every(f => f.type === 'TEXT' && f.name.endsWith('_at'));
    },
  },
  {
    name: 'no_api_keys',
    description: 'No hardcoded API keys',
    check: async (change, workdir) => {
      const files = await getModifiedFiles(workdir);
      for (const file of files) {
        const content = await fs.readFile(file, 'utf8');
        if (content.match(/sk-[a-zA-Z0-9]{32,}/)) return false;
        if (content.match(/API_KEY\s*=\s*['"]/)) return false;
      }
      return true;
    },
  },
  {
    name: 'migration_applies_clean',
    description: 'Migration applies to fresh test DB',
    check: async (change, workdir) => {
      const testDb = await createTempTestDb();
      try {
        await applyAllMigrations(testDb, change);
        return true;
      } finally {
        await fs.unlink(testDb);
      }
    },
  },
  {
    name: 'pipeline_handles_sample',
    description: 'Pipeline ingests at least one sample correctly',
    check: async (change, workdir) => {
      // 从 extract_prompt.md 提取 sample,跑 pipeline 验证
      // ...
    },
  },
  {
    name: 'tests_pass',
    description: 'All tests in this change pass',
    check: async (change, workdir) => {
      const result = await exec('npm test', { cwd: workdir });
      return result.exitCode === 0;
    },
  },
  {
    name: 'meta_json_valid',
    description: 'meta.json conforms to schema',
    check: async (change, workdir) => {
      const meta = await readMeta(change);
      return validateMetaSchema(meta);
    },
  },
  {
    name: 'extract_prompt_present',
    description: 'extract_prompt.md exists and references model abstractly',
    check: async (change, workdir) => {
      const prompt = await readExtractPrompt(change);
      assert(prompt.length > 100);
      assert(!prompt.match(/gpt-|claude-|gemini-/));  // 不写死 model 名
    },
  },
];
```

---

## 9. 实施路线

虽然不再分 v0/v1,但实施仍需要分阶段——一次写完整系统是不现实的。**这是分**周**的实施计划**,不是分**版本**。

### Week 1:基础设施

- [ ] OpenClaw 环境就绪(已完成)
- [ ] Strata plugin 骨架(plugin.json + index.ts + tsconfig + 基础 deps)
- [ ] 数据库 migration 全部 8 张系统表
- [ ] Repository 抽象层 + SQLite 实现
- [ ] Logger + Config
- [ ] 单元测试基础设施

**产出**:Plugin 能加载,数据库能初始化,8 张系统表创建成功。

### Week 2:Capture 流程

- [ ] onUserMessage hook(写 messages 表)
- [ ] onAssistantMessage hook
- [ ] 5 个 tools 全部实现
- [ ] capture skill 编写
- [ ] inline keyboard callback handler
- [ ] Pending buffer + 超时机制
- [ ] Triage(意图分类)
- [ ] **跑通端到端**:用户发消息 → pending event 创建 → 确认 → committed

**产出**:用户可以用 Telegram 跟 bot 说"今天买了 ¥45 咖啡",bot 会问确认,确认后写入 raw_events。

### Week 3:OpenSpec + 第一个手动 capability

- [ ] OpenSpec init + workflows profile 配置
- [ ] AGENTS.md 完整编写
- [ ] 手动创建第一个 capability:expenses
  - 走 OpenSpec 完整流程(不通过 Build Bridge,直接 CLI)
  - 验证 AGENTS.md 是否能引导 Claude Code 正确产出
- [ ] capabilities/loader.ts:加载 capability 到运行时
- [ ] pipeline_runner.ts:执行 ingest pipeline
- [ ] **跑通端到端**:capture 流程触发 expenses pipeline,数据写入 expenses 表

**产出**:第一个能力 expenses 上线,用户记一笔消费能完整流转到业务表。

### Week 4:Build Bridge(关键里程碑)

- [ ] claude_code_runner.ts:spawn + stream-json 解析
- [ ] plan_phase.ts:`/opsx:explore` 集成
- [ ] decompose_phase.ts:`/opsx:propose` 多次调用
- [ ] orchestrator.ts:`/opsx:apply` + `/opsx:verify` + `/opsx:archive`
- [ ] validator.ts:10 项自定义验收
- [ ] integration.ts:产物集成到运行时
- [ ] progress_forwarder.ts:转发到 Telegram
- [ ] build skill:识别 build_request
- [ ] **跑通端到端**:用户在 Telegram 说"我想加个体重追踪",系统经过完整 Build Bridge 流程产出能用的能力

**产出**:用户能通过 Telegram 共建新能力。**这是 Strata 的核心产品价值首次完整展现**。

### Week 5:Reflect Agent

- [ ] scanner.ts:扫 raw_events
- [ ] pattern_detector.ts:聚类 + LLM 判断
- [ ] emergence_detector.ts:浮现新能力 / schema 升级信号
- [ ] decay_detector.ts:归档信号检测
- [ ] proposal_generator.ts:生成 proposals
- [ ] push.ts:推给用户(IM 卡片)
- [ ] proposal 审核 callback
- [ ] **跑通**:周日 cron 触发 Reflect,生成提议

**产出**:Reflect Agent 能从 raw_events 浮现升级提议,推给用户审核。**飞轮初现**。

### Week 6:Re-extraction Worker + Query Skill

- [ ] reextract_jobs 表的 worker 主循环
- [ ] 3 个 strategy 实现
- [ ] checkpointing + 错误处理
- [ ] query skill 编写
- [ ] Dashboard 基础(在 Telegram 渲染 KPI 卡片)
- [ ] **跑通**:schema 演化触发回填,query skill 能回答历史数据问题

**产出**:Schema 演化协议完整闭环,查询能力上线。

### Week 7:Dogfood + 调优

- [ ] 全功能 dogfood 一周
- [ ] 记录所有摩擦点
- [ ] 修关键 bug
- [ ] Prompt 优化(基于真实数据)
- [ ] 添加 stop/resume 完整支持

**产出**:可用版本。

### Week 8:文档 + 发布准备

- [ ] README + 安装文档
- [ ] AGENTS.md 优化(基于 dogfood 经验)
- [ ] 演示视频
- [ ] GitHub 仓库 polish

**产出**:可向他人展示的项目。

---

## 10. 配置规范

### 10.1 ~/.strata/config.json

```json5
{
  "version": "1.0",
  
  "database": {
    "path": "~/.strata/main.db"
  },
  
  "models": {
    // 不指定 model id,完全用 OpenClaw 的默认
    // 只指定"逻辑用途",由 OpenClaw 决定具体走哪个 provider
    "fast": "auto",      // Triage / 简单分类
    "smart": "auto",     // Plan / Reflect / 复杂推理
    "coder": "claude-code-cli"  // Build phase
  },
  
  "reflect": {
    "enabled": true,
    "schedule": "0 3 * * 0",  // 周日凌晨 3 点
    "timezone": "auto",        // 跟 OpenClaw 一致
    "min_cluster_size": 5,
    "min_span_days": 3,
    "min_pattern_confidence": 0.7
  },
  
  "pending_buffer": {
    "timeout_minutes": 30,
    "auto_commit_threshold": 0.7,
    "max_pending_per_session": 5
  },
  
  "build": {
    "max_turns_per_change": 80,
    "dangerously_skip_permissions": true,  // MVP 阶段
    "workdir_root": "~/.strata/builds"
  },
  
  "reextract": {
    "enabled": true,
    "poll_interval_seconds": 30,
    "checkpoint_every_rows": 20,
    "max_concurrent_jobs": 1
  },
  
  "emergence": {
    "min_cluster_size": 10,
    "min_span_days": 7,
    "min_confidence": 0.7
  },
  
  "schema_evolution": {
    "field_skew_threshold": 0.6,
    "min_rows_for_skew_check": 30
  },
  
  "archive": {
    "days_since_last_write": 90,
    "days_since_last_read": 30
  }
}
```

**所有阈值都是 MVP 起点值**——dogfood 阶段会调整。放在 config 里不放在 schema 里,改起来无需 migration。

### 10.2 OpenClaw 端配置(用户已有)

用户在自己的 `~/.openclaw/openclaw.json` 里配 model providers(参考 OpenClaw 文档)。Strata 不需要知道这些。

---

## 11. 测试策略

### 11.1 单元测试

每个 module 独立测试:

- Repository CRUD
- Tools 输入输出
- Triage 准确率(用 fixtures)
- Reflect 阈值判断
- Validator checks

目标覆盖率:70%

### 11.2 集成测试

端到端流程测试:

1. 用户消息 → messages 表写入
2. Triage → 正确分类
3. capture → pending event 创建 → commit → 业务表写入
4. Build Bridge 完整流程(用 mock Claude Code)
5. Reflect 完整流程
6. Re-extraction 完整流程

### 11.3 Dogfood 验收标准

第 7 周 dogfood,以下场景必须 work:

- [ ] 用户发"今天买了 ¥45 咖啡" → 确认后写入 expenses
- [ ] 用户发"心情有点低落" → pending,问澄清,记录
- [ ] 用户问"5 月消费多少" → 准确回答
- [ ] 用户发"我想加个体重追踪" → 完整共建到上线
- [ ] 一周后 Reflect 跑 → 推送 1-3 个合理 proposal
- [ ] 用户批准 schema 演化 → 回填正确

---

## 12. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Claude Code 共建产物不合规 | 高 | 高 | AGENTS.md 严格 + 多层 validation + 回滚机制 |
| Triage 分类不准 | 中 | 中 | fixtures 测试 + 用户能纠正 |
| Reflect 误报严重 | 中 | 中 | 用户审核 + cooldown 机制 |
| Re-extraction LLM 成本失控 | 低 | 中 | 用户审批 + 估算告知 + 可中断 |
| OpenClaw API 变动 | 低 | 高 | 锁定 OpenClaw 版本,major upgrade 谨慎 |
| SQLite 数据损坏 | 极低 | 极高 | WAL 模式 + 定期备份脚本 |

---

## 13. 后续扩展

v1 之后可考虑(不在本 spec 范围):

- 多用户支持(目前是单用户假设)
- 跨 OpenClaw instance 的数据同步(隐私权衡)
- 引入 Graphiti 作为可选数据层(若用户产生大量关系性数据)
- 离线模式(本地 LLM via Ollama)
- 数据导出/导入(隐私迁移)
- Honcho 集成(用户认知建模)

---

## 14. 决策日志

(完整决策来自 PROJECT_RESEARCH_BACKGROUND.md 第 9 章。本文档新增的实施级决策:)

### D-10:项目名定为 Strata(2026-05-11)

- 理由:沉积岩寓意完美对应"数据层层沉淀 + 能力像化石一样浮现"
- 替代:DataLoom / Mycelium / Sediment(放弃)

### D-11:不存任何 API key(2026-05-11)

- 完全依赖 OpenClaw model 抽象
- 用户配置一次,Strata 透明使用
- 副作用:无法 spawn 时传 API key(但 Claude CLI session 共享解决了)

### D-12:Plugin 单一不拆分(2026-05-11)

- 整个 Strata 是一个 OpenClaw plugin
- 浮现的 capabilities 不是独立 plugin,而是 plugin 内部加载的模块
- 简化 MVP,后续可拆

### D-13:`--dangerously-skip-permissions` 在 MVP 接受(2026-05-11)

- 通过 workdir 隔离 + AGENTS.md 约束 + git 回滚兜底
- 后续可升级到 sandboxed execution

### D-14:实施按周不按版本(2026-05-11)

- 用户决定:不分 v0/v1,直接实施完整功能
- 8 周完成完整系统(乐观估计——v1 用过 4 个月,实际可能更长。本时间表的硬承诺是前 4 周的最小端到端骨架;Week 5-8 的 Reflect / Re-extraction / 完整 dogfood 视实施情况调整)

---

## 文档结束

下一步:
1. 复制本文档到 Strata 项目仓库 `docs/SPEC.md`
2. 在仓库根目录跑 `openspec init` 选 workflows profile
3. 把本文档第 6 章的 AGENTS.md 内容写入 `openspec/AGENTS.md`
4. 按 Week 1 开始实施

任何实施中产生的设计变更,通过 OpenSpec change 流程更新 spec,**不直接改本文档**。本文档反映"已实施 + 已对齐"的状态,sync 通过 `/opsx:sync` 维护。
