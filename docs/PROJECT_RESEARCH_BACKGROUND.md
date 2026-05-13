# 项目研究背景文档

**版本**:1.0 (2026-05-10)
**作者**:Seven
**项目代号**:DailyLogClaw / 起居注 (待最终定名)

---

## 文档说明

本文档是"在 OpenClaw 之上做个人软件平台"项目的**研究背景文档**——记录**为什么做这个项目、生态空白在哪、设计决策从哪些实证证据来**。

它不是 spec 文档(不讲 how),不是产品文档(不讲 what),它是**研究文档**(讲 why)。

适用读者:面试官、协作者、未来的自己。
适用场景:讲清楚"为什么这件事值得做"。

---

## 1. 一句话定位

**一个本地部署的、IM 入口的、为单个用户在他自己机器上现场孵化业务能力的个人软件平台。**

每个限定词都是差异点:

| 限定词 | 排除了什么 |
|---|---|
| 本地部署 | 不是 SaaS |
| IM 入口 | 不是开发工具 |
| 为单个用户 | 不是开发者给别人造产品 |
| 在他自己机器上 | 不是云端服务 |
| 现场孵化 | 不是预制功能 |
| 业务能力 | 不是 agent 认知层 |
| 个人软件平台 | 不是单一工具 |

---

## 2. 核心研究问题

> **"如果终端用户能在自己机器上,通过自然对话,现场孵化属于自己的业务软件能力,这种新的人-软件关系会改变什么?"**

三个子问题(对应三个研究方向):

1. **人机界面**:协议化的人机协作能否让 LLM 现场生成业务软件——而不只是在开发者协作下做?
2. **系统架构**:多个能力共享一个数据底盘的"软件组合"形态,能否取代"应用程序"的传统形态?
3. **生命周期管理**:能力的双向演化协议(升级 + 降级),能否让系统在长期运行下保持健康而不熵增?

---

## 3. 生态地图:演化光谱

研究领域里"agent 演化 / 自我学习"是个热门方向,但仔细看,不同项目演化的**对象**完全不同。

```
[meta-level evolution] — agent 自己变强
  capability-evolver (autogame-17):
    扫 agent 运行日志,修 agent 的 prompt 和 tool
  self-evolve (longmans):
    agent 在 episodic memory 上做强化学习
  agent-evolver / agent-reflect (OpenClaw skills):
    通过对话反省提升 agent 行为
  Letta Skill Learning (2025-12):
    agent 从对话经验里学习抽象 skill
  Hermes Agent (NousResearch, 2026-02):  ← 新调研
    autonomous skill creation + Honcho 用户建模 + 跨 session 记忆
    最接近本项目方向的"个人 IM agent + 自演化"项目
    但仍是 meta-level (agent 自己学,不是用户业务能力浮现)

[data-level evolution] — 数据自己结构化
  Mem0:
    自动从对话抽 atomic memories
  Graphiti (Zep):
    自动抽 entity + edge,带 temporal validity
  ByteRover (CortexReach):
    三层记忆架构,每日 9 点跑 Knowledge Mining
  memory-lancedb-pro:
    LLM 6-category extraction,Weibull decay

[knowledge-level evolution] — 知识自动组织
  memory-wiki (OpenClaw bundled, 2026-04-07):
    把记忆编译成 wiki claims,带 provenance
  ClawXMemory (清华 + OpenBMB):
    文件式 markdown memory + Dream reorganization
  Cognee:
    GraphRAG 知识图谱

[domain-capability-level evolution] — 用户业务能力浮现
  ← 本项目研究位置,生态空白
```

**生态调研结论**:几乎所有现有"自演化"项目演化的是 **agent 自己** 或 **数据本身** 或 **知识组织**——**没有一个项目演化的是"用户业务能力"**。

把 user 的真实输入 → 识别业务模式 → 设计业务 schema → 生成业务代码 → 部署成完整 capability(包括 dashboard 和主动行为)——这条链**生态里没有实现**。

最接近的是 **Lovable / v0 / Bolt** 这类 AI 编程工具,但它们是:
- **一次性**(描述需求 → 生成 → 走人)
- **给开发者**(目标用户是要做 SaaS 的人)
- **不联通**(每次生成的产品互相独立)

---

## 4. Spike 实证证据

2026-05-10 进行了真实环境 spike,在 OpenClaw 2026.4.15 + Telegram channel 上验证关键假设。

### 4.1 实验设计

- **环境**:macOS,OpenClaw 2026.4.15 (041266a),memory-wiki 默认启用
- **输入**:4 条关于人物关系的自然对话消息(Lily、家人、推荐的书)
- **观察对象**:OpenClaw 默认 agent 在没有显式指令下的行为

### 4.2 实证发现

#### 发现 A:OpenClaw 默认是 lazy memory 范式

> "我刚才的处理,不是因为'我特别确信这就是最优解',而是因为**在默认 agent 视角下,保守地不写 wiki,比贸然写 wiki 更像真实合理行为**。"
> — OpenClaw 默认 agent,自述 (2026-05-10)

实证证据(源码层):

```
memory-core 默认值:
  DEFAULT_MEMORY_DREAMING_ENABLED = false
  
recall 触发机制:
  recordShortTermRecalls(...) 在 memory_search 工具执行后调用
  不是消息一进来就调用

promotion 阈值:
  minRecallCount = 3
  minUniqueQueries = 3
  
即:一条记忆要被搜索 3+ 次、跨 3 个不同 query 才有资格 promote。
```

**含义**:OpenClaw 的设计哲学是 **memory should be earned**——记忆需要被反复使用才值得固化。这适合通用 chatbot,**不适合"个人长期数据"场景**(用户的消费、健康、人际记录不会被反复"搜索",但天然就是长期资产)。

#### 发现 B:memory-wiki 不是 daily memory 的自动镜像

实证证据(源码层):

```
memory-wiki 插件代码不引用:
  - recordShortTermRecalls
  - memory/.dreams
  - session-corpus
  - MEMORY.md
  - DREAMS.md
```

memory-wiki 的入口是 **显式 API**:
- `wiki.ingest` (导入 source)
- `wiki.apply` (agent 主动 mutate page)
- `wiki.compile` (显式编译)

**没有"消息进来 → 自动写 wiki"的自动管道**。

#### 发现 C:OpenClaw 自身识别出两种范式差异

> "...它夹在两种范式之间:
> 1. 轻量记忆范式:先记 daily log,等后续被多次提及再升格
> 2. 个人知识库范式:人物、关系、作品一出现就建 entity
> 而当前 OpenClaw 的默认架构...更偏向第 1 种,不会自然地把这些日常事实自动编成 wiki entity。"
> — OpenClaw 默认 agent,自述 (2026-05-10)

**这是 spike 的金子**——不是外部推测,是 OpenClaw 自己 agent **用源码证据** 识别出来的范式差异。

#### 发现 D:agent 在被显式驱动时识别质量高

当被显式要求识别 entity 时,agent 主动产出:

- 准确识别 3 个核心 entity(Lily / 妈妈 / 东野圭吾)
- 主动建议加 1 个 work entity(《沉默的巡游》)
- 主动指出 schema 设计 trap("Lily 是我老婆"用 entity-centric 还是 user-centric 表达?)
- 主动暴露 memory-wiki 容器局限("claim + evidence + confidence 不是完整 graph schema")

**这说明**:OpenClaw agent 的**底层认知能力足够**,缺的是**主动触发判断的协议**——什么时候该升级、升级到什么形态。

### 4.3 综合实证结论

| 问题 | 结论 | 证据 |
|---|---|---|
| OpenClaw 默认会自动 raw → wiki 吗? | 不会 | memory status + 源码 |
| 为什么不会?bug 还是设计? | 设计选择 | 源码默认值 + agent 自述 |
| memory-wiki 是自动镜像层吗? | 不是,是独立编译器 | memory-wiki 源码不引用 memory-core |
| agent 默认有"升级意识"吗? | 没有内在协议 | 自主行为实验 + agent 自述 |
| agent 在被驱动时表现如何? | 识别质量高,能暴露局限 | entity 识别报告 |
| 生态空白真实存在吗? | **完全成立** | 5 类项目调研 + spike 三重交叉验证 |

### 4.4 第二轮调研:知识图谱方案评估(Graphiti)

OpenClaw spike 验证了"agent 层、wiki 层的空白"。但还有个关键问题需要评估:**"raw event → 自动 entity/relationship 抽取 → temporal 知识图"这层是否需要引入现成方案?**

2026-05-10/11 进行了三层深度评估:

#### 候选方案对比

| 项目 | 自动抽 entity | 自动抽 relationship | 自动浮现 type schema | 渐进升级协议 |
|---|---|---|---|---|
| **Graphiti** (getzep) | ✅ | ✅ free-form | ❌(默认无 type,可传 Pydantic 强类型化) | ❌ |
| **Cognee** | ✅ | ✅ | ❌(必须传 OWL ontology 文件) | ❌ |
| **Mem0** | ✅(atomic fact) | ❌ | N/A(无 entity 概念) | ❌ |
| **MemoryGraph** | ✅ | ✅ | ❌(12 个固定 memory types) | ❌ |
| **Memgraph U2G** | ✅ | ✅ | ❌(单次 one-shot) | ❌ |
| **ZOES** (arxiv 2506.04458) | ✅ | ✅ | ✅ bottom-up | ❌(单次,学术 PoC) |
| **OntoKG** (arxiv 2604.02618) | ✅ | ✅ | 部分(Wikidata 数据驱动) | ❌(学术 PoC) |

Graphiti 是看起来最贴合的方案(自动 entity/edge + temporal + 演化 schema),进入了详细评估。

#### 第一层评估:能力覆盖度

Graphiti 提供:
- Episode-based raw event 存储
- 自动 entity 抽取
- 自动 relationship 抽取(free-form,bottom-up 浮现)
- Temporal validity(`valid_at` / `invalid_at`)
- Hybrid 检索(vector + BM25 + graph BFS)
- Schema 演化(加字段不破坏老数据)
- 历史 episode 用新 schema 重 ingest

**初步判断:看似高度贴合**。

#### 第二层评估:核心问题域是否重合

仔细对比 Graphiti 解决的核心问题和本项目核心需求:

| Graphiti 解决的核心问题 | 本项目核心需求 |
|---|---|
| 多跳语义关系推理("通过 X 找到 Y 的关联") | 流水数据沉淀(消费、运动、健康记录) |
| 实体跨提及自动归并 | 业务能力浮现(从输入模式建立 schema + pipeline) |
| 时态推理(关系何时生效/失效) | 协议化人机协作(提案-审核-落地) |
| 持续从对话学习实体 | 双向能力生命周期(升级 + 降级) |

**关键发现:问题域不重合**。

- Graphiti 的高 LLM 成本是为"持续从对话抽取实体"的核心机制服务的——适合 chatbot 场景
- 本项目的数据 90% 是事务流水(消费、运动等),**结构化形态应该是 SQL 表**,而不是图节点
- 关系性输入只占 10%,而且大部分查询不需要多跳推理

GitHub Issue #1308 (2026-03,still open) 揭示 Graphiti 的另一个限制:不传 entity_types 时所有实体只有通用 `:Entity` label,没有自动类型浮现。即使想用 Graphiti 做"type schema 自动浮现"也做不到。

#### 第三层评估:成本结构

每次 `add_episode()` 内部触发 LLM 调用:

> "Each episode involves multiple LLM calls (entity extraction, deduplication, summarization)."
> — Graphiti MCP server README

单次 add_episode 内部 LLM 调用:5-10 次(entity extraction + resolution + edge extraction + dedup + temporal invalidation + summarization + embedding)。

社区在 GitHub Issue #1299 / #1193 抱怨成本不可控,Zep 团队目前没有官方的"绕过 LLM 抽取"API。

**单纯使用 Graphiti(per-message ingest)成本估算**:

```
30 条消息/天 × 7 次 LLM/episode × 30 天 = 6300 次 LLM 调用/月
按 DeepSeek V4 Pro:约 $11/月
对照 $30/月 总预算:占 37%——性价比极差
```

#### 第四层评估:OpenClaw 集成插件让成本可控,但揭示新问题

社区有现成的 `@robertogongora/graphiti` 插件(2026-02 发布),支持两种触发模式:

**Hooks Mode(默认)**:
> "Session compacts or resets → before_compaction/before_reset fires → Plugin extracts user+assistant messages (min 4) → POSTs up to 12,000 chars to Graphiti /messages"

只在 session 压缩/重置时批量 ingest,典型用户 1 天 1-3 次,**成本压到 $2-3/月**——预算友好。

**ContextEngine Mode(OpenClaw 2026.3.7+)**:
> "per-turn in ContextEngine mode"

每轮对话触发,接近 per-message,成本回到 $11/月级别。

**但 Hooks Mode 揭示了更深的架构错配**:

| 维度 | Hooks Mode 假设 | 本项目实际 |
|---|---|---|
| 输入模型 | 聊天会话(有 session 边界) | 持续生活记录流(无 session 概念) |
| 触发时机 | session 即将消亡时抢救 | 输入即时可查 |
| 数据上限 | 单次 12K 字符 | 任意长度,不能截断 |
| 数据本质 | 对话(user/assistant 轮次) | 事件(消费、运动、记录) |

**Hooks Mode 是为聊天 bot 设计的低成本图存储**——不是为个人数据沉淀流设计的。

#### 综合判断:评估后**不引入** Graphiti

完整决策依据:

1. **问题域不重合**——Graphiti 解决多跳语义推理,本项目核心是流水数据沉淀
2. **数据形态错配**——90% 数据应该是 SQL 表,不是图节点
3. **架构哲学错配**——session-bound 触发 vs event-stream 哲学
4. **延迟与上限风险**——Hooks Mode 有触发延迟和 12K 字符截断风险
5. **成本性价比差**——即使 $2-3/月,得到的能力跟产品需求重合度低

**替代方案**:

- 事务流水数据 → SQLite 业务表(由飞轮浮现)
- 简单 entity resolution → raw_events 的 LLM extraction JSON 字段 + memory-wiki 的 aliases 列表
- 多跳推理 → 让 LLM 综合 raw_events(小数据量下够用)
- Temporal validity → raw_events append-only 天然保留 + 业务表的 `valid_from/valid_to` 字段

**研究价值方向调整**:

去掉 Graphiti 后,研究焦点更聚焦:
- 不研究"何时把 :Entity 升级为 :Person"(那是图 ontology 问题)
- 研究"何时把零散 raw events 升级为业务能力"(这是产品能力问题)

后者更贴近你的产品命题。

#### 这次评估的简历叙事价值

讲清楚"为什么不用 Graphiti"本身就是 senior 工程师的能力体现:

> "调研中我评估了 Graphiti(Zep 团队的 temporal knowledge graph),它在数据模型上跟我设计的业务表演化看起来高度相似。但通过三层评估(能力覆盖度 / 问题域 / 成本结构)后发现:
>
> 1. Graphiti 核心问题是多跳语义推理,我的核心需求是流水数据沉淀,**两者问题域不重合**
> 2. 即使社区有 OpenClaw 集成插件将成本压到 $2-3/月,**Hooks Mode 的 session-bound 触发跟个人数据 event-stream 哲学错配**
> 3. 即使强用 ContextEngine Mode,成本占预算 37% 但得到的能力跟产品需求重合度只有 10-20%
>
> 我选择不引入 Graphiti,转而用 SQLite + sqlite-vec + 业务表 + memory-wiki 的轻量组合,把节省的预算分配给 Domain agent 和共建对话——这些才是产品真正的核心价值环节。"

这种**多层评估的决策日志**比"直接说用 X 或不用 X"更有说服力——它展示对工程权衡的深度理解。

### 4.5 不重复造轮子的最终分工

| 功能 | 谁做 | 你的工作量 |
|---|---|---|
| IM 入口 | OpenClaw | 0 |
| Agent runtime | OpenClaw | 0 |
| Memory tier(短期/recall/dreaming)| memory-core | 0 |
| Wiki 容器(claim/evidence/provenance)| memory-wiki | 0 |
| Raw event 存储 | **SQLite + sqlite-vec** | 表设计(<200 行 SQL) |
| 简单 entity 引用 | raw_events.llm_extraction JSON 字段 | 包含在 ingest pipeline 里 |
| Temporal | raw_events append-only + 业务表字段 | 业务表 schema 设计 |
| Hybrid 检索 | SQLite FTS5 + sqlite-vec + LLM 综合 | <100 行胶水 |
| Schema 演化 | SQLite migration + Claude Code | 0(Claude Code 写) |
| 业务表(消费/运动/健康/...) | **飞轮浮现 → Claude Code 落地** | 0(运行时浮现) |
| 代码生成(共建)| **Claude Code** | 0 |
| Spec-driven 工程化 | **OpenSpec** | 0 |
| **业务能力浮现协议** | ⚠️ 没人做 → 你做 | 核心研究 |
| **业务能力浮现协议** | ⚠️ 没人做 → 你做 | 核心研究 |
| **能力生命周期状态机(含归档)** | ⚠️ 没人做 → 你做 | 核心研究 |
| **共建审核协议** | ⚠️ 没人做 → 你做 | 核心研究 |
| **IM 适配层** | 没现成 → 你做(薄) | 桥接 |
| **Build Bridge(IM ↔ Claude Code)** | 没现成 → 你做(薄) | 桥接 |

**确认**:你写的代码 100% 是核心研究价值层 + 必要的桥接——没有一行重复造轮子。**且不引入 Graphiti、Neo4j 等不必要的复杂度**。

---

## 5. 设计原则

基于以上实证,项目的核心设计原则:

### 5.1 范式定位

**两种范式中间**:不是 lazy memory(OpenClaw 默认),不是 eager auto-structure(过度结构化导致 schema 爆炸)——而是 **protocol-driven progressive structuralization**(协议化的渐进结构化)。

具体:
- 数据**默认全部沉淀**(不丢失,不靠 search 触发)
- 但**结构化是个状态机**:从 raw 消息开始,只有通过明确触发(用户授权 / 信号累积)才升级到下一形态
- 何时升级、何时归档,由 **信号驱动 + 协议化判断 + 用户审核** 决定
- 同时支持**归档**,避免熵增

### 5.2 演化对象

**演化的不是 agent,是用户的业务系统**。

- 不演化 agent prompt(那是 capability-evolver 的事)
- 不演化 memory 组织(那是 memory-wiki / ByteRover 的事)
- 不演化 entity 抽取(那是 Graphiti 的事)
- **演化的是 micro-app 体系**——schema、pipeline 代码、查询代码、dashboard 配置、主动行为

这层在 OpenClaw 生态里**没有任何项目做**。

### 5.3 实施分工

**核心原则:绝不重复造轮子**。

```
现成实现层 (0 行代码):
  IM 入口      → OpenClaw Telegram channel
  Agent runtime → OpenClaw
  Memory 容器   → memory-core + memory-wiki
  Skill 标准    → Anthropic Skills (OpenClaw 兼容)
  代码生成      → Claude Code (subprocess 调度)
  代码工程化    → OpenSpec
  
研究价值层 (~1500-2500 行 TypeScript):
  Reflect Agent (识别业务模式,生成升级 / 归档提议)
  Proposal Protocol (协议化人机审核)
  Capability Lifecycle Manager (状态机:proposed → active → archived)
  Build Bridge (调度 Claude Code 落地)
  Integration Layer (接收产物,集成回主系统)
```

### 5.4 数据原则

(从 spec v1.1 继承,经 spike 验证仍然成立)

1. **Raw events 永不丢失**——append-only,任何衍生数据 trace 回 raw_event_id
2. **业务表每张有唯一 owner pipeline**——其他组件只读
3. **金额 INTEGER minor units**——避免浮点
4. **时间 ISO 8601 with TZ**——避免 naive datetime
5. **数据 100% 在用户机器上**——隐私优先
6. **Schema 演化必须可回溯**——任何 schema 变更必须能够通过 messages 表重新抽取历史数据,且回溯过程对用户可见、可中断、可观察成本

### 5.5 能力生命周期状态机

每个 capability(用户的业务能力,如"消费追踪")作为系统中的一等公民,有明确的状态机:

```
状态:
  proposed   — Reflect 浮现的提议,等用户决策
  approved   — 用户批准,排队进 Build Bridge
  building   — Build Bridge 处理中
  active     — capability 已上线,在用
  archived   — 归档(数据保留,pipeline 停止,可重启)
  deleted    — 物理删除(仅用户明确要求)

转换:
  none → proposed       by Reflect Agent
  proposed → approved   by 用户审核(IM)
  proposed → declined   by 用户拒绝(进入冷却期,30 天)
  approved → building   by Build Bridge 开始
  building → active     by 集成完成
  building → failed     by 验证失败 + 用户中止
  active → archived     by 衰减信号 + 用户确认
  archived → active     by 用户重启
  archived → deleted    by 用户明确要求物理删除
```

**信号驱动 + 用户审核**:状态转换由两类信号触发:

| 触发 | 来源 | 例子 |
|---|---|---|
| **浮现信号**(none → proposed)| Reflect Agent 扫 raw_events | 用户记了 10+ 条 unclassified 消费数据 |
| **归档信号**(active → archived 提议) | Reflect Agent 扫 capability_health | 某能力 90 天没写入、30 天没查询 |
| **演化信号**(active capability 需要 schema 升级) | Reflect Agent 检测字段分布 | category='food' 占比 80%,建议加 subcategory |
| **主动信号**(用户在 IM 表达需求) | Triage 识别 build_request | "我想加个体重追踪" |

**所有自动信号产生的都是 proposal,不是直接转换**。用户始终在审核回路里。

#### 为什么不用 L0-L5 这种阶梯

设计早期曾考虑过用 L0-L5 的分级抽象(从 raw 到 domain 到 capability 到 proactive 等)。
经过实施推演后放弃,因为:

1. **用户主动共建**路径会直接跳到 active,绕过中间级——分级跟实际使用不匹配
2. **L1/L2 在数据流里没有具体对应物**(raw_event 已经有 event_type,跟"L2 domain identified"重复)
3. **每级阈值都是凭直觉**,没有 dogfood 数据支撑——多级反而增加错误可能
4. **简单的 5 状态状态机**完整覆盖了真实需求,且每个状态都有明确数据库表征

**承认简单是对的**:能力的生命周期就是个状态机,不需要伪装成阶梯。

### 5.6 数据粒度协议:消息层 vs 事件层

**问题来源**:OpenClaw 的对话是 session 维度的,但用户在同一 session 里会反复修正、追加、确认。如果每轮对话都直接当 raw_event,会出现大量冗余/修正/无效数据。

**核心洞察**:

> **raw_event 的真正语义不是"用户说了什么",而是"用户授权系统把什么当成事实"。**

#### 双层结构

引入两层而非一层:

**第一层 — messages 表**(对话原始记录):

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT,           -- OpenClaw session ID
  role TEXT,                 -- 'user' | 'assistant' | 'system'
  content TEXT,              -- 消息原文
  turn_index INTEGER,        -- session 内第几轮
  received_at TEXT,          -- ISO 8601 with TZ
  embedding BLOB,            -- 可选,sqlite-vec

  raw_event_id INTEGER,      -- NULL if 还没归属到任何事件
  raw_event_role TEXT        -- 'primary' | 'context' | 'correction' | 'confirmation'
);
```

完全机械,每条用户消息进来就写,**永不丢失**。

**第二层 — raw_events 表**(语义事件):

```sql
CREATE TABLE raw_events (
  id INTEGER PRIMARY KEY,
  session_id TEXT,

  event_type TEXT,           -- 'unclassified' | 'purchase' | 'mood_log' | ...
  status TEXT,               -- 'pending' | 'committed' | 'superseded' | 'abandoned'

  extracted_data JSON,       -- LLM 抽出的结构化数据
  source_summary TEXT,       -- 一句话描述

  primary_message_id INTEGER,
  related_message_ids JSON,

  event_occurred_at TEXT,    -- 事件实际发生时间
  committed_at TEXT,

  supersedes_event_id INTEGER  -- 修正链
);
```

语义事件粒度,一个事件对应一行(可能跨多条 messages)。

#### 状态机

```
pending     正在对话中,还没用户授权
   ↓ 用户确认 / 自动 commit
committed   用户授权的事实,飞轮唯一处理对象
   ↓ 用户修正
superseded  被新版本替代(历史保留)
   ↓
abandoned   用户取消(软删除)
```

**飞轮规则**:L1-L5 升级协议、Reflect 扫描、业务表浮现——**只读 status='committed' 的 raw_events**。pending/superseded/abandoned 仅用于审计和修正链。

#### MVP 决策:用户主动授权创建

经过讨论,MVP 阶段采用**保守策略**:

> **当 agent 识别到语义事件足够明确时,在回复里附带确认选项,用户主动授权后才 commit。**

例:

```
用户: 今天买了 Blue Bottle ¥45
Agent: 我把这条记下来? [✅ 记录] [✏️ 调整] [❌ 不记]
用户: ✅
→ 创建 raw_event,status='committed'
```

或:

```
用户: 今天有点累
Agent: 这是想记心情吗?要的话简单说几句细节
       [💭 是,我说细节] [🚫 只是聊聊,不记]
```

**理由**:
- 数据 trust 是产品基石,前期宁可慢也别错
- 用户感知到"我授权了系统记什么"——心智正确
- 后期累积足够多授权样本后,再讨论自动化(类似 Phase 4+ 才上 auto-commit)

#### 4 个边界情况处理

**情况 1:跨 session 修正**

用户在新 session 说"上周一咖啡其实是 ¥48"——

**方案**:把 committed 的 raw_event 摘要写入 OpenClaw memory,agent 在处理新输入时**自动扫描 memory**,识别"修正历史事件"意图后定位目标 event_id,创建新 raw_event 并 supersede 旧的。

不需要专门的 search 工具——OpenClaw 的 memory recall 机制天然支持这种"历史回查 + 修正"。

**情况 2:批量录入**

用户一次说多个事件 → **拆解为多个独立 raw_event**。

例:"周一买咖啡 ¥45,周二跑步 5km,周三跟 Lily 吃饭" → agent 输出 3 个 event_actions,各自有独立的 primary_message 和 event_occurred_at。

**情况 3:渐进式 commit**

用户说"今天花了不少钱"(模糊) → agent 不主动创建 pending,而是反问让用户给具体数据。

**情况 4:删除请求**

用户说"删掉" → 软删除(status='abandoned'),物理记录保留。用户的查询/统计不再返回 abandoned 记录,但溯源仍可见。

**只有用户明确要求"彻底删除"且二次确认后**,才物理删除——这是 P1 原则的延伸。

#### raw_event 跟现有设计的关系

这套设计**完全兼容** spec section 6.3 的 P1 原则:

- "永不丢失" → messages 表保证(更彻底)
- "append-only" → raw_events 也 append-only,修正用 supersedes 链
- "trace 回 raw_event_id" → 业务表数据仍然 trace 回 raw_event_id

只是把 raw_event 的语义从"对话单位"升级为"语义事件单位"——P1 原则不变,实现方式精确化。

### 5.7 Schema 演化与回填协议

**问题来源**:业务表 schema 必然会演化(初版用大类'food',后期细分为 meat/beverage 等)。已有的历史数据在 schema 演化后会"过时"——新字段是 NULL,无法按新维度查询。需要一套机制让历史数据**跟着 schema 演化**。

这是"会成长的数据系统"的核心问题之一,生态内基本没人系统性解决。

#### 双层结构提供的能力

回填的可能性建立在双层结构上:

```
messages 表(永久保留所有原文)
   ↓
raw_events 表(LLM 抽取结果 + primary_message_id)
   ↓
业务表 expenses(结构化字段)
```

**两个关键资产保证可回填**:
1. messages 表保留所有原文 → 任何字段都可以重抽
2. raw_events 保留旧抽取结果 → 部分字段可以从历史抽取推导

#### 核心设计:业务表带 extraction_version

```sql
ALTER TABLE <business_table> ADD COLUMN extraction_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE <business_table> ADD COLUMN extraction_pipeline_id TEXT;
ALTER TABLE <business_table> ADD COLUMN extracted_at TEXT;
```

**每条数据都带版本标记**,可以识别"哪些数据需要回填"。

#### Schema 演化登记

每次 schema 变更是一等公民事件:

```sql
CREATE TABLE schema_evolutions (
  id INTEGER PRIMARY KEY,
  table_name TEXT,
  from_version INTEGER,
  to_version INTEGER,
  evolved_at TEXT,

  change_type TEXT,        -- 'add_column' | 'remove_column' | 'split_column' | 'merge_column' | 'change_type'
  change_spec JSON,        -- 详细描述变更

  backfill_strategy TEXT,  -- 'derive_from_existing' | 'reextract_from_raw' | 'manual' | 'skip'
  backfill_status TEXT,    -- 'pending' | 'in_progress' | 'completed' | 'failed'
  backfill_completed_at TEXT,

  triggered_by_proposal_id INTEGER
);
```

#### 三种回填策略

按"信息来源"分:

**策略 A:从现有数据推导**(零 LLM 成本)

新字段可以从已有字段确定性推出。例:
- 加 `is_weekend` → 从 `occurred_at` 推导
- 加 `currency_code` (之前默认 CNY) → 全填 'CNY'
- `category='food'` 拆为 `category='dining', meal_type=null` → 平移

实现:SQL UPDATE 或简单脚本,瞬时完成。

**策略 B:从 raw_events.extracted_data 推导**(轻量 LLM)

旧抽取已含信息,只是没存到业务表。例:
- v1 LLM 抽过 `merchant: "麦当劳"`,存在 raw_events.extracted_data
- v2 加 `cuisine_type` 字段 → 可从 merchant 推导

实现:扫 raw_events,跑映射函数(可缓存 unique merchant)。

**策略 C:从 messages 重抽**(贵但最准)

新字段信息只在原文里。例:
- v2 加 `payment_method` → 从原文 "今天用招行信用卡刷了 ¥45" 重抽

实现:取 primary_message 原文,跑新版 LLM 抽取。每条都要 LLM,最贵。

#### 三种回填模式

按"何时跑"分:

**Eager** — schema 演化通过后立即全量回填。
- 适合:数据量小、字段重要
- 例:200 条数据用策略 C × $0.0005 = $0.1

**Lazy** — 老数据保持 NULL,用户查询触发时按需回填。
- 适合:数据量大、字段不紧急
- 例:用户问"过去半年咖啡按支付方式分布" → 触发只回填这部分的 payment_method

**Sample** — 抽样回填(如 10%),用于统计分析。
- 适合:用户要看趋势不要全量精确
- 具体查询时再 on-demand 回填那一条

#### 完整流程举例

Phase 1:用户用了一段时间,飞轮 Reflect 发现 "category=food 占 60% 且分布差异大"

```
[Telegram 通知]
🪴 我注意到你的 food 消费分布差异很大。要不要细分?

候选小类: 🥩 肉类 / 🥬 蔬菜 / 🍹 饮料 / 🍞 主食 / 🍰 甜品 / 🍔 快餐 / 其他

📊 影响:
- 新增 1 个字段
- 回填 87 条历史 food 记录
- 预计 LLM 成本 $0.04,耗时 1-2 分钟

[✅ 同意] [✏️ 调整候选值] [❌ 不要]
```

用户同意 → Claude Code 落地:

1. 生成 migration `ALTER TABLE expenses ADD COLUMN subcategory TEXT`
2. 登记 `schema_evolutions` 记录,backfill_strategy='reextract_from_raw'
3. 生成回填脚本
4. 跑回填(Eager 模式,数据量小)
5. 更新 backfill_status='completed'

用户看到:

```
🔨 正在调整 expenses 能力...
  ✅ schema migration 完成
  ⏳ 回填 87 条历史数据... (44/87)
  ✅ 回填完成
✅ expenses 能力已升级到 v2
   现在你可以问: "上月饮料花了多少"
```

#### 这套机制对研究价值的意外增量

之前的研究问题:"业务能力浮现协议"——重点在"何时升级"。

加上 Schema 演化协议后,多了一个维度:**"当业务能力升级时,历史数据如何无缝跟随?"**

生态对比:
- Lovable / v0:一次性生成,不演化
- Notion AI:用户手动维护 database
- 记账 App:schema 固定
- Letta / OpenClaw:演化的是 agent,不是业务数据
- Flyway / Alembic:只管 schema 不管语义回填
- dbt:需要工程师写规则

**让 AI 系统自主决定"该不该演化 schema、用什么回填策略",生态没人做**——本项目的研究产出又多一条。

### 5.8 Micro-app 全过程开发协议

**问题来源**:Lifecycle 协议(5.5)说"何时升级",Schema 演化协议(5.7)说"升级后历史怎么办",但还差一环——**升级实际落地的工程过程**:从用户审核通过的提案到上线运行的 micro-app,中间这套全过程怎么走?

这是把整套 lifecycle 协议从"概念"变成"代码"的发动机。

#### 现成基础设施

- **Claude Code**:执行实际代码生成(subprocess 模式)
- **OpenSpec**(workflows profile):提供 spec-driven 工作流框架,11 个 slash command
- **OpenClaw**:提供 IM 入口、agent runtime、消息流

本项目要写的:**Orchestrator + Integration Layer + IM 转发层**——约 500-800 行 TypeScript。

#### 三段式开发流程

**阶段 A:Plan Phase**(用 `/opsx:explore`)

用户在 IM 表达需求 → Triage 识别 `build_request` → Build Bridge 启动 Claude Code 进入 `/opsx:explore` 模式。

```
用户: 我想加个股票追踪
   ↓
Triage: kind=build_request
   ↓
Build Bridge: spawn claude code with /opsx:explore
   ↓
Claude Code(在 explore 模式):
  - 不生成任何文件
  - 跟用户多轮对话(通过 IM)
  - 读现有 specs/ 了解系统
  - 帮用户澄清:数据模型、触发场景、查询场景、跨能力联通
   ↓
用户: 好,可以开始
   ↓
PLAN.md 沉淀(对话产出的需求结构化文档)
```

**阶段 B:Spec Decomposition**(用 `/opsx:propose` 多次)

```
Build Bridge: spawn claude code with prompt:
  "Read PLAN.md. Decompose into atomic OpenSpec changes 
   using /opsx:propose for each. Order by dependency."
   ↓
Claude Code:
  /opsx:propose stock-tracker-schema      → changes/001-*/
  /opsx:propose stock-tracker-ingest      → changes/002-*/
  /opsx:propose stock-tracker-skill       → changes/003-*/
  /opsx:propose stock-tracker-dashboard   → changes/004-*/
   ↓
每个 change 自动生成 4 个 artifact:
  proposal.md  — 为什么改
  specs/       — 改什么(deltas)
  design.md    — 技术决策
  tasks.md     — 实施清单
   ↓
Build Bridge 把 changes summary 通过 IM 推给用户
用户审核 changes 列表
```

**阶段 C:Orchestrated Build**(Orchestrator + 多次 `/opsx:apply` + `/opsx:verify` + `/opsx:archive`)

```typescript
// 伪代码
for each change in changes:
  1. spawn claude code -p "/opsx:apply <change-id>"
     → Claude Code 读 tasks.md,逐个实施,自动勾选
  
  2. spawn claude code -p "/opsx:verify <change-id>"
     → OpenSpec 内置 validation gate
     → 返回 CRITICAL / WARNING / SUGGESTION 报告
  
  3. custom validation(项目专属约束):
     - extraction_version 字段存在
     - raw_event_id FK 有效
     - 金额用 INTEGER minor units
     - 时间用 ISO 8601 with TZ
     - 没有动 capabilities/ 之外的目录
  
  4. spawn claude code -p "/opsx:archive <change-id>"
     → change 移到 archive/
     → deltas merge 进 openspec/specs/<capability>/spec.md
  
  5. 通过 IM 上报进度(✅/失败)

任何 change 失败 → 用户决策(重试/跳过/中止)
所有 change 完成 → 进入 Integration Phase
```

#### Profile 选择:workflows profile

OpenSpec 提供两种 profile,本项目选 **workflows profile**(扩展版,11 个命令)。

理由:

1. **`/opsx:explore` 实现 Plan Phase** — core profile 没有 explore,需要自定义 Plan Agent,违反"不重复造轮子"原则
2. **`/opsx:verify` 独立 validation gate** — 返回结构化报告,Orchestrator 容易解析,core profile 把 verify 隐式包在 apply 里
3. **`/opsx:sync` 反向同步** — 长期运行后代码会漂移,sync 能把 spec 拉回来,day 1 不用 day 100+ 救命
4. **学习成本可控** — 多 8 个命令但实际用 5-6 个,半天能掌握

#### Integration Layer

OpenSpec archive 完成 ≠ 能力上线。还需要把 `capabilities/<name>/v<N>/` 的产物激活进运行时:

```typescript
async function integrate(capabilityName, version) {
  const snapshot = await git.createSnapshot('main');
  try {
    // 1. 应用 migration(写主 SQLite)
    await applyMigrations(mainDb, finalPath);
    
    // 2. 注册到 capability_registry 表
    await registerCapability(capabilityName, version);
    
    // 3. 热加载 ingest pipeline
    await pluginRuntime.loadPipeline(finalPath);
    
    // 4. 注册新 skill 到 OpenClaw skill registry
    await openclaw.registerSkill(finalPath + '/skill/SKILL.md');
    
    // 5. 注册 cron(如有)
    await scheduler.registerFromCronJson(finalPath);
    
    // 6. 注册 dashboard widgets
    await dashboardRegistry.register(capabilityName, finalPath);
    
    // 7. 把 v<N> 标记为 current(symlink)
    await markCurrent(capabilityName, version);
    
    // 8. git commit
    await git.commit('main', `integrate: ${capabilityName} v${version}`);
  } catch (e) {
    // 任何一步失败 → 完整回滚
    await git.revertTo(snapshot);
    await cleanupArtifacts(finalPath);
    throw e;
  }
}
```

#### Post-deploy

集成成功后两件事并行:

1. **历史回填**(如果是 schema 升级):触发 5.7 节的 re-extraction worker
2. **用户通知 + 上手指引**:通过 IM 告诉用户怎么用新能力

#### 中断与恢复

任何阶段都可中断、可恢复(借鉴 Lovable 的 stop/resume 设计):

| 中断类型 | 处理方式 |
|---|---|
| Agent 在输出里提开放问题 | 解析问题 → IM 呈现给用户(带默认答案)→ 二轮对话 |
| Agent 达到 max_turns | Claude Code 原生 `--resume <session-id>` 续跑 |
| Agent 反复失败(3+ 次同错) | AGENTS.md 强制 agent 写 BUILD_STUCK.md → 上报用户 |
| 用户主动 /stop | git commit 当前进度 + 标记 paused → 用户发"继续"恢复 |
| 进程崩溃 | builds 表持久化状态 → OpenClaw 启动时检查 unfinished → 询问用户 |

#### 渐进交付:不追求"一次跑完整个 micro-app"

每个 change 是一次独立的 `/opsx:apply` → 5-10 个 change 串行,而非 1 个大 build。

| 维度 | 一次性大 build | 渐进交付(本方案) |
|---|---|---|
| 单次 Claude Code 任务量 | 大 | 小 |
| headless 跑通率 | 40-60% | >90%/change |
| 失败影响 | 几乎全废 | 只影响那 1 个 change |
| 用户进度感 | 黑盒 | 每 change 可见 |
| 用户中途干预 | 难 | 任意 change 之间可暂停 |
| 总时长 | 3-5 分钟 | 5-15 分钟 |

总时长稍长,但可控性、可观察性碾压。

#### 系统宪法:AGENTS.md

Claude Code 启动时自动读 `AGENTS.md`,这是约束它行为最重要的文件。本项目的 AGENTS.md 必须涵盖:

- **架构约束**:OpenClaw + SQLite + 双层结构原则
- **硬性规则**:raw_events append-only / 金额 INTEGER / ISO 8601 / extraction_version 字段
- **目录约定**:capabilities/<name>/v<N>/ 完整文件结构
- **命名约定**:`_minor` 后缀 / `_at` 时间戳 / FK 命名等
- **scope 纪律**:每个 change 只动 tasks.md 列出的文件,不碰 capabilities/ 外目录
- **失败逃逸**:连续 3 次同错 → 写 BUILD_STUCK.md 退出,不进入死循环

AGENTS.md 是**单一最重要的工程产出**——它决定 Claude Code 生成的代码是否真的嵌入你的系统。

#### 跟 lifecycle 协议其他几件的关系

```
                 ┌─── 触发 ───┐
浮现/演化信号 ──→│            │
归档信号    ────→│   Plan     │  Explore mode 沉淀需求
用户主动    ────→│   Phase    │
                 └──────┬─────┘
                        ↓
                 ┌──────────────┐
                 │   Spec       │  /opsx:propose 多次
                 │   Decomp     │  拆成 atomic changes
                 └──────┬───────┘
                        ↓
                 ┌──────────────┐
                 │ Orchestrated │  /opsx:apply + verify + archive
                 │   Build      │  per change
                 └──────┬───────┘
                        ↓
                 ┌──────────────┐
                 │  Integration │  capabilities/ 集成到运行时
                 └──────┬───────┘
                        ↓
                 ┌──────────────┐
                 │  Post-deploy │  历史回填(5.7) + 用户通知
                 └──────────────┘
```

#### 这是 lifecycle 协议套件的发动机

```
1. 能力生命周期状态机       (5.5) — proposed → active → archived
2. 业务能力浮现协议         (5.5) — 浮现 + 归档信号驱动
3. 数据粒度协议             (5.6) — 双层结构 + 状态机
4. Schema 演化与回填协议    (5.7) — 升级后历史怎么办
5. Micro-app 开发协议       (5.8) — 升级如何实际落地 ★
```

前四件是**协议**,第五件是**把协议变成代码的发动机**。
没有第五件:
- 状态机走到 `approved` 时**没有任何东西落地**
- Schema 演化只是个理论,**没人写新 pipeline**
- 飞轮提案只能告诉用户"我建议建能力",**永远不能真建**

第五件 + OpenSpec 框架,让整个 lifecycle 在工程上闭环——所有演化都通过 OpenSpec changes 显式记录,archive/ 目录成为系统演化的完整史诗。

---

## 6. 差异化:跟相关项目的精确对比

### 6.1 vs Lovable / v0 / Bolt

**根本差异**:
- Lovable 把"做软件"当**一次性事件**(描述 → 生成 → 走人)
- 我把"做软件"当**持续过程**(每个能力建在已有数据底盘上,互联演化)

**一句话**:Lovable 做"AI 给开发者批量造软件",我做"AI 在终端用户机器上现场长软件"。

### 6.2 vs Letta

**根本差异**:
- Letta 演化的是 **agent 认知层**(skill 库、memory、user 偏好)
- 我演化的是 **系统业务能力层**(schema、pipeline、dashboard)

**一句话**:Letta 让 agent 越聊越懂你,我让系统越用越像专属于你的 IDE——你的生活数据是它的代码库。

### 6.3 vs OpenClaw

**根本差异**:
- OpenClaw 是通用 agent runtime,默认 lazy memory
- 我做的是 **在 OpenClaw 之上的 capability lifecycle layer**

**一句话**:OpenClaw 是地基,我做的是一层"能力生命周期协议",让 OpenClaw 能为终端用户长出业务系统。

### 6.4 vs Notion AI

**根本差异**:
- Notion 是 **用户搭框架,AI 填内容**——你必须知道自己要追踪什么
- 我是 **用户随便讲,AI 浮现框架**——你不需要预先知道

### 6.5 vs Daylio / 记账 App

**根本差异**:
- 记账 App 是工程师预设的固定 schema,所有用户共享
- 我的能力是为单个用户从他真实记录里浮现的,反映他的语言、分类直觉、关注点
- 而且所有能力共享同一数据底盘,支持跨域分析(消费 vs 心情 vs 睡眠)

### 6.6 vs capability-evolver(OpenClaw skill)

**根本差异**:
- capability-evolver 演化 **agent 自己的能力**(meta-level)
- 我演化 **用户的业务能力**(domain-level)

具体:capability-evolver 扫 agent runtime 日志,生成 agent 自身的 prompt 改进和 Capsule。**它不会**建业务表、写业务代码、做 dashboard——这些不是它的目标。

### 6.7 vs Hermes Agent (NousResearch)

**最值得详细对比的项目**——它最接近你产品形态。

**注**:本节中关于 Hermes 的具体数据(发布日期、stars、版本号、benchmark 数字、论文奖项)来自 web search 调研,未经第一手验证。面试时若要引用具体数字,建议先访问 https://github.com/nousresearch/hermes-agent 复核。

#### Hermes 的画像

- NousResearch(开源 AI 研究公司)出品
- **从 OpenClaw 演化而来**——提供完整迁移路径
- 高 GitHub 关注度,持续高频迭代(据公开信息)
- MIT 协议,主要 Python

#### Hermes 4 个主打能力

1. **Autonomous Skill Creation**——完成复杂任务后自动写 skill 文档,使用中自我修补
2. **自演化引擎**——配套项目通过 DSPy 读取 execution trace 分析失败原因,生成 prompt 和 skill 改进(据公开论文)
3. **Honcho 用户建模**——dialectic 用户认知建模,跨 session 累积用户特征,自动注入 base context
4. **多 terminal backends + 多渠道 IM + cron scheduler**——支持 serverless idle 部署

据第三方报告:self-created skills 显著降低重复任务的耗时(具体数字需要复核)。

#### 精确差异

| 维度 | Hermes | 本项目 |
|---|---|---|
| **演化对象** | Agent 自己(skill / prompt / 用户模型) | **用户的业务系统**(schema / 代码 / dashboard) |
| **演化层级** | meta-level | **domain-level** |
| **产物形态** | skill markdown 文档 | **完整 micro-app**(业务表 + 入库代码 + 查询代码 + dashboard) |
| **学习内容** | "用户喜欢简洁回复"、"用户在做 Rust" | "用户在追踪消费"、"用户的资产分布" |
| **数据形态** | 自然语言 markdown | **结构化业务数据 + 表 schema** |
| **是否落地代码** | ❌ skill 只是描述 | ✅ **产物是可执行软件** |
| **人机审核** | ❌ 自主(curator 后台跑) | ✅ **协议化提案 → 审核 → 落地** |
| **演化/归档** | 部分(curator archive 过时 skill) | ✅ **能力生命周期状态机 + 用户审核审批** |
| **核心研究问题** | agent 自我演化(ICLR 2026 已发表) | business capability 从用户输入流浮现 |

#### 核心区别一句话

**Hermes 是"自演化的个人助理 framework"**——卖点是 agent 越用越懂你、越用越强。

**本项目是"个人软件工厂"**——卖点是从你的数据中长出专属于你的小软件。

#### 是直接竞争吗?

**当前不是直接竞争**:

- 演化对象根本不同(agent 自己 vs 用户业务系统)
- 产物形态根本不同(markdown vs 可执行 micro-app)
- 核心 narrative 不同(learning agent vs software factory)

但**要警惕的**:Hermes 已经具备多渠道 IM + cron + skill 自创建 + 用户建模 + memory——这套基础设施一旦 NousResearch 决定让 skill 从"markdown 文档"升级为"可执行 micro-app",**他们就直接进入本赛道**。

NousResearch 是研究公司,具备技术能力快速转向。但**当前路线明确是"self-improving coding agent"**——估计窗口期 6-12 个月。

#### 从 Hermes 借鉴的 5 件事

1. **Skills Hub 标准** (agentskills.io) — 让你共建产物可移植
2. **Autonomous Curator 模式** — 后台用 auxiliary model 做 review/合并/归档
3. **GEPA execution trace 分析** — Reflect Agent 不只看数据模式,也看用户查询失败/撤销轨迹
4. **Honcho 集成** — 直接用 Honcho 做"用户认知建模",自己专注"用户业务数据"
5. **多 terminal backends** — 长期可用 serverless wake-on-demand 降本

#### 一句话总结

Hermes 验证了"自演化个人助理"这个赛道是真实需求且有 128K 用户。你做的"个人软件工厂"是相邻但更窄的赛道,**两者形态相近、目标不同、目前不冲突,但需要密切跟踪**。

---

## 7. 研究 narrative(简历 / 面试用)

### 7.1 30 秒版本

> "现在 AI 编程工具有两种范式:一种是 Lovable / v0,开发者描述需求 → AI 生成 SaaS 给别人用;另一种是 Cursor / Claude Code,AI 辅助开发者写自己的代码。
>
> 但有个第三种范式还没人做:**终端用户用自然对话,AI 在他自己机器上为他一个人长出专属软件**。
>
> 我做的就是这个第三种。具体是个本地部署的 IM 助理——用户用 Telegram 跟它聊,聊久了系统识别出'这个用户在追踪消费',自动提议建立完整的消费追踪能力(schema + 代码 + dashboard),用户审核后**调用 Claude Code 作为内部组件**真的把代码写出来集成进系统。
>
> 它跟现有所有方案的根本差异是:**数据归用户、能力归用户、演化由用户和系统共同决策、最终产物是一个随你的生活生长的个人软件平台**。"

### 7.2 反驳防御:"这听起来就是 Lovable + Telegram bot"

> "Lovable 是一次性的——用户描述需求 → AI 生成 → 用户拿走部署。**Lovable 不知道用户后面用得怎么样**。
>
> 我的系统是持续的——每个能力建在用户已有的数据底盘上,跟其他能力**互联**,能力之间会**互相影响**(新能力会迁移旧数据、改老 schema)。系统**全程在场**,知道每个能力被用了多少、用得对不对、是否该升级、是否该淘汰。
>
> Lovable 不解决这些问题,因为它的产物离开它就独立运行了。**我做的不是'造一个软件',是'养一个软件平台'**。"

### 7.3 反驳防御:"OpenClaw 不是已经做了 IM + agent + memory + skill 吗?"

> "我做了一周 spike,发现 OpenClaw 默认是 **lazy memory 范式**——记忆需要被反复搜索才会固化。这适合通用对话助理,但**不适合个人长期数据场景**——用户的消费记录、健康数据、人际关系从第一次出现就已经是长期资产,不需要'被搜索 3 次'才被认可。
>
> 我跟 OpenClaw 默认 agent 做了对话实验,**它自己识别出了这两种范式的差异**,并明确说当前架构偏向第一种。
>
> 所以我做的不是替代 OpenClaw,而是 **在 OpenClaw 之上加一层 capability lifecycle protocol**——把 OpenClaw 通用 agent runtime 改造成支持个人长期数据沉淀和业务能力涌现的系统。"

### 7.4 反驳防御:"Hermes Agent 不是已经做了自演化 + 多渠道 + skill 自创建吗?"

> "Hermes 是 NousResearch 的 self-improving coding agent——非常优秀,广受关注。但它演化的是 **agent 自己**:skill markdown、prompt、用户认知模型(Honcho)。
>
> 我做的是演化 **用户的业务系统**:从用户的消费/运动/健康输入流中浮现业务 schema,落地为可执行的 micro-app(包括数据表、入库代码、查询代码、dashboard)。
>
> 一个具体差异:用户说'帮我记一下今天买了 ¥45 咖啡'——
> - Hermes 会写一个 skill markdown:'用户喜欢记录咖啡消费,可以用 X 方式回答'
> - 我的系统会建立完整能力:建立 expenses 表、写 ingest pipeline、生成消费 dashboard、关联到资产视图
>
> Hermes 产物是**自然语言描述**,我的产物是**可执行软件**。两者是相邻但不同的赛道——Hermes 让 agent 越用越懂你,我让你拥有越用越精准的私人软件平台。"

---

## 8. 实施现状

### 8.1 已完成

- [x] 完整产品需求梳理(多轮迭代)
- [x] 生态全面调研(5 类项目对比)
- [x] OpenClaw 实证 spike(2026-05-10,4 个核心发现)
- [x] 设计原则确定(范式定位 + 双向演化协议)
- [x] 差异化分析(对 6 类项目)

### 8.2 下一步

- [ ] 5 个核心组件详细设计:
  - Reflect Agent (业务模式识别)
  - Proposal Generator (升级/降级提案)
  - Audit Protocol (人机审核状态机)
  - Build Bridge (Claude Code 调度 + OpenSpec 工作流)
  - Integration Layer (接收 Claude Code 产物,集成主系统)
- [ ] OpenSpec 工作流设计
- [ ] Phase 0 实施(最小骨架)

### 8.3 时间估计

- Phase 0 (骨架 + IM 入口验证):1 周
- Phase 1 (Build Bridge + 第一个 micro-app 共建):2 周
- Phase 2 (Reflect Agent + 提案协议):2 周
- Phase 3 (双向演化协议 + 能力等级):1 周
- Phase 4 (Dogfood + 调优):2 周
- **总计:~8 周**

---

## 9. 关键决策日志

按时间倒序,关键决策点:

### 决策 9 (2026-05-10):废弃"自建一切"路线,确立"OpenClaw + 协议层"架构

- 触发:spike 证实 OpenClaw 不够但**地基价值**显著
- 影响:核心代码量从 5000+ 行降到 ~1500-2500 行;TypeScript 单一栈;时间从 6-10 周降到 ~8 周

### 决策 8 (2026-05-10):"双向演化"取代"单向升级"

- 触发:讨论 schema 爆炸风险
- 影响:Capability Lifecycle 设计成对称协议(升级 + 降级 + 归档 + 删除)

### 决策 7 (2026-05-10):放弃"AI 自动创建 schema"的强假设

- 触发:认识到这跟 OpenClaw lazy 范式不冲突,只是信号通道不同
- 影响:Reflect Agent 设计调整——不是 eager 抢着升级,是 protocol-driven 渐进升级

### 决策 6 (2026-05-09):common 落地通道是 Claude Code,不再自建 coding agent

- 触发:意识到 Claude Code 已经是 mature solution
- 影响:Curator 角色从"自己写代码"降级为"调度 Claude Code 写代码"

### 决策 5 (2026-05-09):IM 是唯一入口,不要做 web UI

- 触发:讨论产品形态简化
- 影响:Dashboard 用 Telegram inline 渲染(matplotlib + 图片),不做 web shell

### 决策 4 (2026-05-08):产品从空状态启动,不内置任何能力

- 触发:研究价值优先
- 影响:Phase 1-4 都不预装能力,完全靠飞轮 + 共建长出来

### 决策 3 (2026-05-08):支持"用户主动共建"路径,跟"被动浮现"并存

- 触发:讨论产品形态完整性
- 影响:两条演化路径,共用同一个 Claude Code 落地通道

### 决策 2 (2026-05-07):API key 模式,不走订阅 OAuth

- 触发:Anthropic 2026-02-19 ToS 变更
- 影响:用户用自己的 API key,不替用户付费;Claude Code 也用 API key

### 决策 1 (2026-05-06):DeepSeek + Anthropic 混合模型路由(已部分被新架构覆盖)

- 触发:成本优化
- 现状:在 OpenClaw 之上,这层由 OpenClaw 的 model provider 处理,你只需配置

---

## 10. 附录:已生成的核心文档

| 文档 | 作用 | 状态 |
|---|---|---|
| `personal-assistant-spec.md` | v1.1 完整技术 spec(~2800 行) | 部分过时,需基于新架构重写 |
| `README.md` | spec 导航 | 部分过时 |
| `IMPLEMENTATION_GUIDE.md` | OpenSpec + Claude Code 工作流手册 | 仍适用,但目标项目改变 |
| **本文档** | 研究背景与决策日志 | ✅ 当前 |

下一步要生成:

| 待生成 | 作用 |
|---|---|
| `ARCHITECTURE_v2.md` | 基于 OpenClaw + 协议层的新架构图 |
| `CORE_COMPONENTS_DESIGN.md` | 5 个核心组件详细设计 |
| `PHASE_0_PLAN.md` | Phase 0 实施步骤 |

---

**文档结束**。

接下来推荐进入两件事之一:
1. 写 `CORE_COMPONENTS_DESIGN.md`——把 5 个核心组件设计细化到可写代码
2. 写 `PHASE_0_PLAN.md`——直接开始最小骨架实施
