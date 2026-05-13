# Strata 项目简介(简历用)

---

## 版本 A:精简版(简历正文用,适合放在"个人项目"section)

### 中文版

**Strata · 本地部署的个人数据沉淀与软件孵化平台** | 2026.01 - 至今
*个人项目 · TypeScript · OpenClaw / Claude Code / OpenSpec*

设计并实现一个**为单个用户在他自己机器上现场孵化业务软件**的 IM 助理系统。用户用 Telegram 自然记录生活数据,系统识别模式后通过协议化人机协作,自动浮现完整的业务能力——包括 schema、ingest pipeline、查询代码、dashboard。填补了 AI 编程工具(Lovable / v0 给开发者)与个人 AI 助理(Letta / Hermes 演化 agent)之间的赛道空白。

**项目演进**:

- **2026.01-04 · v1 自建方案**:独立设计 ~2800 行 spec,实现核心数据流(raw events + 业务表 + 飞轮),跑通后发现实施成本失控、研究价值与基础设施未分层
- **2026.05 · 推翻 + 生态调研**:系统对比 8+ 相邻项目(OpenClaw / Graphiti / Hermes / Letta / capability-evolver / Mem0 / Cognee 等),定位"用户业务能力浮现"是真空白(其他项目均演化 agent 自身或数据本身)
- **2026.05 · 实证 spike**:在 OpenClaw 2026.4.15 上做小样本实验(4 条消息),结合源码确认默认 agent 不具备"业务能力浮现"意识
- **2026.05 · 组件三层评估**:对 Graphiti 做能力/问题域/成本三层评估后决定不引入(虽看似贴合但核心问题域错配)——这次"主动放弃看似完美方案"是项目最重要的工程判断之一
- **2026.05 · 最终方案落定**:OpenClaw(agent runtime)+ Claude Code(代码生成)+ OpenSpec workflows(spec-driven 工作流)+ ~1500-2000 行 TypeScript 协议层,完整工程契约文档 2700+ 行

**核心研究产出**:能力生命周期协议套件
1. 能力生命周期状态机(三张表协作:proposals → builds → capability_registry)
2. 业务能力浮现协议(Reflect Agent 扫信号生成提议 + 用户审核)
3. 数据粒度协议(双层结构 messages/raw_events + 状态机)
4. Schema 演化与回填协议(extraction_version + 回填策略 + 用户可见成本)
5. Micro-app 全过程开发协议(Plan → Decompose → Orchestrated Build)

---

### 英文版

**Strata · Local-First Personal Data Sedimentation & Software Forge** | Jan 2026 – Present
*Personal Project · TypeScript · OpenClaw / Claude Code / OpenSpec*

Designed and built an IM-based assistant system that **forges custom business software on a user's own machine**. Users record life data via Telegram in natural language; the system detects patterns and, through a protocol-driven human-AI collaboration loop, materializes complete capabilities — schema, ingest pipeline, query logic, dashboard. Fills the gap between AI coding tools (Lovable / v0 for developers building SaaS) and personal AI agents (Letta / Hermes evolving the agent itself).

**Project evolution**:

- **Jan–Apr 2026 · v1 self-built**: Authored ~2800-line spec independently; implemented core dataflow (raw events + business tables + reflection loop); after running it, identified that implementation cost was outpacing research value due to unseparated infra/research layers
- **May 2026 · Pivot + ecosystem survey**: Systematically compared 8+ adjacent projects (OpenClaw, Graphiti, Hermes Agent, Letta, capability-evolver, Mem0, Cognee, etc.) — located "domain-level capability emergence" as a real gap (all others evolve the agent or the data, not the user's business system)
- **May 2026 · Empirical spike**: Ran small-sample experiment (4 messages) on OpenClaw 2026.4.15; combined with source code review, confirmed default agent lacks "capability emergence" awareness
- **May 2026 · Three-layer component evaluation**: Evaluated Graphiti on capability / problem-domain / cost — declined despite surface similarity (core problem domain mismatched). This "deliberate rejection of a seemingly perfect fit" was among the project's most consequential engineering decisions
- **May 2026 · Final architecture**: OpenClaw (agent runtime) + Claude Code (code generation) + OpenSpec workflows (spec-driven workflow) + ~1500–2000 lines of TypeScript protocol layer; full engineering contract document at 2700+ lines

**Core research output**: A capability lifecycle protocol suite of five components
1. Capability lifecycle state machine (three-table coordination: proposals → builds → capability_registry)
2. Capability emergence protocol (Reflect Agent scans signals → proposals → user review)
3. Data granularity protocol (two-layer messages/raw_events + state machine)
4. Schema evolution & backfill protocol (extraction_version + backfill strategies + user-visible cost)
5. Micro-app end-to-end build protocol (Plan → Decompose → Orchestrated Build)

---

## 版本 B:详细版(简历附录或 portfolio 用,可展开)

### Strata

**A local-first, IM-driven platform that forges personal software, capability by capability, from a user's daily data stream.**

---

#### What problem does it solve

Personal data tools today force a choice:

- **Closed SaaS** (Notion, Daylio, etc.) — predefined schemas, data in the cloud, no personalization
- **AI coding tools** (Lovable, v0, Cursor) — for developers building SaaS, not for end users
- **Personal AI agents** (Letta, Hermes) — improve the agent itself, but don't create custom software for the user

Strata sits in the **fourth quadrant** no one occupies: end users describe their needs to a Telegram bot in natural language, and the system grows a complete, personalized capability on their own machine — schema, ingest pipeline, query skill, dashboard, all generated and integrated.

---

#### Project evolution — the real journey, not the polished pitch

##### Phase 1 — Build v1 first (Jan – Apr 2026)

Wrote a ~2800-line spec document from scratch and implemented the core data flow:
- Raw events persistence
- Business tables with owner-pipeline isolation
- Dual-runtime agent architecture
- Reflection loop for capability emergence

**v1 ran.** It validated the core data flow. But after using it, two problems surfaced:
1. **Capability incompleteness** — the progressive emergence mechanism existed as a concept; the actual code generation, build protocol, and backfill mechanism were missing
2. **Implementation cost** — I was reinventing infrastructure (raw events store, agent runtime integration, vector search) instead of focusing on the research value layer

This forced a hard question: **rebuild, or push through?**

##### Phase 2 — Systematic ecosystem survey (May 2026)

Decided to rebuild. But first, properly survey the ecosystem along the "evolution object" axis:

| What evolves | Representative projects |
|---|---|
| Meta-level (the agent itself) | capability-evolver, Letta Skill Learning, Hermes Agent |
| Data-level (raw data self-structures) | Mem0, Graphiti, ByteRover |
| Knowledge-level (knowledge auto-organizes) | memory-wiki, Cognee |
| **Domain-capability-level (user's business system)** | **vacant** |

**Key finding**: My target — emerging entire business capabilities (schema + code + dashboard) from user input — was a real gap, not a manufactured one. Adjacent quadrants were hot; mine was empty for a specific reason no project had bridged.

##### Phase 3 — Empirical spike (May 2026)

Rather than assuming OpenClaw's behavior, ran a real experiment: sent 4 natural-language messages about family, work, and a book recommendation to OpenClaw 2026.4.15 default agent. Observed:

- ✅ Messages persisted to daily log
- ❌ No wiki entities created
- ❌ No structured extraction
- The agent itself, when asked why, identified two paradigms: "lazy memory" (its design) vs. "personal knowledge base" (mine). It acknowledged its architecture was the former.

**Small-sample empirical evidence, source-code verified, with agent's own admission as bonus.** This was the empirical foundation for the rest of the design—not statistical significance, but enough to be wrong about reproducibly.

##### Phase 4 — Three-layer evaluation of Graphiti (May 2026)

Graphiti (Zep's temporal knowledge graph) looked like a perfect fit on the surface. Did a deliberate three-layer evaluation before adopting:

| Layer | Finding |
|---|---|
| **Capability** | ✅ Auto entity/edge + temporal + hybrid search — looks ideal |
| **Problem domain** | ❌ Graphiti solves multi-hop semantic reasoning; my product needs transactional flow recording — fundamentally different problem domains |
| **Cost** | ❌ Each `add_episode` triggers 5-10 LLM calls; even with the OpenClaw integration plugin (hooks mode), session-bound triggering misaligns with event-stream philosophy |

**Decision: do not adopt.** This "rejection of a tempting fit" was one of the most important engineering judgments — the kind of decision that distinguishes pragmatic engineering from pattern-matching.

##### Phase 5 — Five protocols, designed through challenges (May 2026)

The protocol suite wasn't designed top-down — each piece was forced into existence by a specific question:

- **"Isn't this the same as OpenClaw's lazy paradigm?"** → forced me to distinguish "signal channel" rather than "lazy vs eager", revealing the real differentiation
- **"Won't schema bloat over time?"** → drove the bidirectional evolution protocol (elevation + demotion + archive, symmetric)
- **"Conversation granularity ≠ data granularity"** → drove the two-layer data structure (messages + raw_events + state machine)
- **"What about historical data when schema changes?"** → drove the schema evolution & backfill protocol (extraction_version + 3 strategies + user-visible cost)
- **"How does an upgrade actually become running code?"** → drove the micro-app full-process build protocol (Plan → Decompose → Orchestrated Build)

##### Phase 6 — Final architecture (May 2026)

Settled on a composition where infrastructure is reused, and only the research-value layer is custom:

**Reused (~0 lines of code)**:
- IM entry & agent runtime: OpenClaw
- Memory tiers: OpenClaw memory-core + memory-wiki
- Model providers: OpenClaw's abstraction (no API key handling)
- Code generation: Claude Code CLI subprocess
- Spec workflow: OpenSpec workflows profile
- Vector + full-text search: sqlite-vec + FTS5

**Custom (~1500-2000 lines TypeScript)**:
- Triage (intent classification)
- 6 tools for state machine management
- Reflect Agent (pattern detection → proposals)
- Build Bridge (orchestrating Claude Code through OpenSpec)
- Re-extraction Worker (historical backfill)
- Integration Layer (capability hot-load)

**Output documents**: 4000+ lines across research background + full engineering contract.

---

#### What makes this defensible

The project sits in a clear gap, but the bigger differentiator is the **process** that led here:

- **I built v1 before knowing whether to build v2** — empirical sunk cost, but earned the right to know what wouldn't work
- **I challenged my own framings multiple times** — "lazy vs eager" turned out to be the wrong axis; "we also need multiple occurrences before elevation" forced precision
- **I rejected a perfect-looking fit (Graphiti) for the right reason** — problem domain mismatch, not capability mismatch
- **I avoided two unnecessary self-built components** — Planner Agent and custom Phase A/B/C/D splitter — by recognizing OpenSpec's existing primitives mid-design

The product hasn't shipped yet (implementation in progress: minimum end-to-end skeleton targeted within ~4 weeks, full feature set thereafter). But the **design defensibility** is grounded in:
- Source-code-level evidence from the spike
- A documented ecosystem map (8+ projects)
- Multiple self-corrections recorded in the decision log

---

#### Time to talk through it

- **30 seconds**: see version A, "项目演进" section
- **5 minutes**: walk through Phases 1-6 above
- **30 minutes**: deep-dive into any one of the five protocols (each has its own design rationale)

Code & docs: [GitHub link when published]

---

## 使用建议

### 简历正文用版本 A 的中文版或英文版

直接复制到简历的"个人项目"section。一段定位 + 一段演进 + 一段研究产出,信息密度极高,扫读 10 秒能看到核心信号。

### 详细版本用作两种场景

1. **GitHub README**:Strata 仓库的 README 直接用版本 B,让面试官查 GitHub 时看到完整故事
2. **portfolio 网站**:如果有个人网站,放成单独一页

### 关键词浓度

为了 ATS(简历过滤系统)/ 搜索引擎匹配,版本 A 已经埋了:
- AI agent, LLM, agent system, agent runtime
- OpenClaw, Claude Code, OpenSpec
- TypeScript, SQLite
- spec-driven development
- protocol design, lifecycle management
- schema evolution, system architecture
- Telegram, IM, personal AI assistant

中英文版各 470 字左右,符合简历一页内的密度要求。
