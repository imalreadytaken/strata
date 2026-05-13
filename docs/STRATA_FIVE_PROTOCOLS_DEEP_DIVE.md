# 能力生命周期协议套件 · 详细展开

**用途**:面试被追问"展开讲讲"时的深度材料 / portfolio 技术文档
**深度**:每件协议 3-5 分钟可充分讲解
**协议清单**:5 件——前 4 件是协议(状态机 / 浮现 / 数据粒度 / Schema 演化),第 5 件是把协议变成代码的引擎(Micro-app 开发)

---

## 整体定位:这五件协议解决的根本问题

先讲清楚为什么需要这套协议族——

**根本问题**:用户在自己机器上做个人数据沉淀,系统能力应该随真实使用而演化。但"演化"这件事在工程上需要回答 5 个相互关联的问题:

| 问题 | 对应协议 |
|---|---|
| capability 在系统里到底有几种状态?怎么从一种过渡到另一种? | 能力生命周期状态机 |
| 什么时候该建议建一个新 capability?什么时候该建议归档? | 业务能力浮现协议 |
| 用户的"输入"跟"事实"是同一个东西吗? | 数据粒度协议 |
| Schema 演化了,历史数据怎么办? | Schema 演化与回填协议 |
| 这些协议怎么真的变成可执行的软件? | Micro-app 全过程开发协议 |

**前 4 件是"协议"**——决定演化的规则。
**第 5 件是"引擎"**——让协议真正变成代码。

五件协议合起来,构成完整的"能力生命周期管理"——从信息进入系统、被结构化、被状态机推进、被归档,直到最终落地为可运行的业务能力。

---

## 第 1 件:能力生命周期状态机

### 解决的问题

每个 capability(用户的业务能力,如"消费追踪")在系统里到底是什么状态?
从模糊想法到上线运行,中间经过哪些环节?谁来推动每一步转换?

如果不明确这些,会有这些问题:
- 用户提了需求 → 没建,但系统也不知道有这个 pending 想法
- 能力上线后用了一阵不用了 → 但还在跑 ingest pipeline,浪费资源
- 用户想"再启用之前归档的能力" → 没机制
- 能力失败时(共建中报错) → 没有明确的失败状态可以查看和重试

需要一个**清晰的状态表达**,让 capability 的每一种存在形态都对应一个明确的工程实体。

### 核心机制:三张表协作表达生命周期

我最初把状态机塞进一张表(`capability_registry`),设计了 6 个状态(proposed/approved/building/active/archived/deleted)。后来实施推演时发现:**前 3 个状态在 capability_registry 里永远不会出现**——提议阶段由 `proposals` 表跟踪,构建阶段由 `builds` 表跟踪,只有真正上线的 capability 才会进 `capability_registry`。

所以最终设计是三张表协作:

```
1. 提议阶段:proposals 表
   none → status='pending'      Reflect 浮现 / 用户主动请求
   pending → 'approved'         用户批准
   pending → 'declined'         用户拒绝(30 天冷却)
   pending → 'expired'          30 天没响应

2. 构建阶段:builds 表
   approved 后创建 build:
   phase='plan'        → /opsx:explore 跟用户对话
   phase='decompose'   → /opsx:propose 拆分
   phase='build'       → /opsx:apply 执行 changes
   phase='integrate'   → 集成到运行时
   phase='post_deploy' → 通知 + 历史回填
   phase='done' / 'failed' / 'cancelled' / 'paused'

3. 上线阶段:capability_registry 表
   build phase='done' 时插入 status='active'
   active → archived   衰减信号 + 用户确认
   archived → active   用户重启
   archived → deleted  用户明确要求 soft delete
```

每个状态在数据库都有明确表征——不是"概念",是某张表某条记录的实际字段值。

### 关键洞察

**洞察 1:这是我从"L0-L5 阶梯"砍下来的设计**

我最初设计的是 L0-L5 渐进升级阶梯——听起来很 AI、很研究。
后来真的想"L1 在数据库里长什么样、谁来写、什么时候转 L2"时,发现:

- 用户主动共建会直接跳到 active,绕过中间级——阶梯跟实际使用不匹配
- L1/L2 在数据流里没有具体对应物(raw_event 已经有 event_type)
- 每级阈值都是凭直觉,没有 dogfood 数据支撑
- 简单状态表达已经完整覆盖了真实需求

**砍掉 L0-L5,改成三张表协作**——这是项目里一个具体的"承认简单是对的"自我修正。

> 面试讲到这里的杀手锏:**"我设计过 L0-L5,后来发现是装饰性概念,自己砍掉了"**。这种 self-correction 比"我设计了一套精美阶梯"更有说服力。

**洞察 2:为什么不是一张表的 6 状态机**

设计中第二次修正:**一张表多状态 vs 多张表协作**——

| 一张表多状态(最初设计) | 多张表协作(最终设计) |
|---|---|
| 状态切换全在一个字段里 | 状态由"哪张表有这条记录 + 那张表的字段"共同决定 |
| 简单直接,但状态字段含义混乱(proposed 时表里没数据,但要查得到) | 清晰分层,proposals/builds/capability_registry 各管一段 |
| 查询时要 filter status | 查询时去对应阶段的表 |
| 在 capability_registry 里 INSERT 一条 status='proposed' 的记录,然后 UPDATE 它经过多个状态 | 在 proposals 表创建 → approved 时创建 builds → done 时创建 capability_registry |

**多表协作更贴合真实数据库设计**——每张表代表生命周期的一个阶段,各自有不同的字段、查询模式、索引。

**洞察 3:状态转换都是"提议 + 审核",自动信号不直接转换**

任何 capability 的状态变化都不会自动发生,而是:

```
信号(自动) → proposal(自动) → 用户审核(人) → 状态转换(自动)
```

这避免了"系统自作主张"——很多场景用户可能就想随便记记,不希望被升级成正式能力。

**信号自动,决策人在回路**——这是整个 Strata 的产品哲学。

**洞察 4:archived 不等于 deleted**

很多系统把"不用了"等同于"删了"。Strata 区分:

- archived:capability_registry.status 改,pipeline 停,业务表数据保留,**用户随时可以重启**
- deleted:soft delete 标记(deleted_at 字段),物理记录可保留作审计

这跟传统数据库的"DROP TABLE"完全不同——**是 lifecycle 管理,不是数据 GC**。

用户使用产品越久,可能 archived 的能力越多——但这些 archived 数据**仍然是用户的资产**,任何时候可以回看、可以重启。

---

## 第 2 件:业务能力浮现协议

### 解决的问题

第 1 件协议定义了**状态机**——但状态转换由什么触发?

具体场景:
- 用户记了 10 条消费数据,系统应该建议"建立 expense 能力吗"?多少条算够?
- 用户某个能力 60 天没用了,系统应该建议归档吗?完全没用算?用得少算?
- 用户的 expense 表里 80% 都是 food,系统该建议加 subcategory 吗?

如果触发逻辑写死在代码里(`if count > 10 then propose`),没有可调性、没有可解释性。

需要一套**信号驱动的浮现协议**——把"信号采集 → 模式识别 → 提议生成"这条流水线做成可观察、可调整的工程模块。

### 核心机制:三类信号触发三类 proposal

```
信号 1: 浮现新能力的信号
  来源: 扫 status='committed' 且 capability_name=NULL 的 raw_events
  方法: embedding 聚类 + LLM 判断 cluster 是否构成 coherent domain
  阈值(MVP 起点,可调):
    cluster size ≥ 10
    span days ≥ 7
    LLM confidence ≥ 0.7
  产出: kind='new_capability' proposal

信号 2: 现有能力 schema 升级的信号
  来源: 扫现有业务表的字段分布
  方法: 检测枚举字段是否高度集中
  阈值: 某个值占比 > 60%,且总行数 > 30
  产出: kind='schema_evolution' proposal
       (例: "category='food' 占 80%,建议加 subcategory")

信号 3: 归档信号
  来源: 扫 capability_health 表
  方法: 检测写入和读取的衰减
  阈值: 最后写入 > 90 天,且最后读取 > 30 天
  产出: kind='capability_archive' proposal
```

每类 proposal 都进 `proposals` 表,通过 IM 推送给用户审核。用户批准则触发对应的状态转换(进入第 1 件的状态机)。

### 关键洞察

**洞察 1:阈值是 MVP 起点,不是科学结论**

每个阈值都来自产品直觉:**"10 条记录看起来够说明问题了"**、**"60% 占比明显倾斜了"**。
没有 dogfood 数据,也没有论文依据。

**这点必须诚实**——不假装是优化过的科学值。阈值放在 config 里,dogfood 后会调整。这跟 v1 时期把阈值写进 schema 字段里不同——**配置可调比 schema 可调成本低得多**。

**洞察 2:跟 OpenClaw 的根本差异是"信号通道"**

OpenClaw 默认 lazy memory——信号通道是"search 频率"。但用户不会反复搜自己的消费记录,会反复**录入**。

**信号通道选错了,整个浮现机制就空转**。这是我跟 OpenClaw 默认范式的最核心差异,也是我跟 OpenClaw 默认 agent 实地对话验证出来的——它自己承认 lazy 范式不适合"个人长期数据"场景。

**洞察 3:三类信号本质同构**

虽然信号采集方法不同(扫 raw_events / 扫业务表字段 / 扫 health 表),但抽象层是一致的:

```
扫数据 → 检测模式 → LLM/规则判断置信度 → 生成 proposal → 用户审核
```

代码上可以共享 base class,只是 detector 实现不同。这让代码量可控——三类信号合起来 ~300 行 TypeScript。

**洞察 4:为什么不需要"升级"这件事**

我最初的设计里有"L3 → L4 升级"(给 capability 加主动行为)。后来发现这是个伪需求:

- 加 cron 提醒 = 改 cron.json + 重新加载 → **本质就是一次 schema_evolution**(只是改的是行为配置不是表结构)
- "主动行为"不是 capability 的独立等级,是 capability 配置的一部分

**真正需要的演化只有两种**:加字段(schema 升级)和归档。**用两件事就把原来 4 级阶梯覆盖了**。

## 第 3 件:数据粒度协议

### 解决的问题

OpenClaw 的对话以 session 为单位,但用户在同一 session 里会反复修正、追加、确认。如果每条用户消息都当一条 raw_event,会出现严重数据冗余。

具体场景:

```
session 内 6 轮对话:
[1] 用户:"今天买了 Blue Bottle ¥45"
[2] 系统:"已记录"
[3] 用户:"哦不对,是 ¥48"
[4] 系统:"已更正"
[5] 用户:"还买了一个司康"
[6] 系统:"加上了吗?"
[7] 用户:"加上,¥18"
[8] 系统:"好的"
[9] 用户:"那总共多少了"
[10] 系统:"¥66"
[11] 用户:"行,记一下"
```

**11 条消息,但语义上只是 1 个消费事件**。

如果每条消息都进 raw_events 表:
- 飞轮分析时看到一堆"修正"和"中间态",难以判断真实信号
- 业务表数据冗余、字段错乱
- 历史回溯困难

需要一套机制,让**对话粒度跟数据粒度解耦**。

### 核心机制:双层数据结构 + 状态机

引入两层:

**第一层:`messages` 表**

```sql
CREATE TABLE messages (
  id, session_id, role, content,
  received_at,
  raw_event_id      REFERENCES raw_events(id),  -- 这条消息归属哪个事件
  raw_event_role    -- 'primary' / 'context' / 'correction' / 'confirmation'
);
```

每条 IM 消息原文,**完全机械的写入,永不丢失**。

**第二层:`raw_events` 表**

```sql
CREATE TABLE raw_events (
  id, session_id, event_type,
  status            -- 'pending' / 'committed' / 'superseded' / 'abandoned'
  extracted_data,
  source_summary,
  primary_message_id,
  related_message_ids,  -- 这个事件涉及的所有消息
  supersedes_event_id,  -- 修正链
  ...
);
```

**语义事件单位**,跨多条消息聚合。

### 状态机 4 个状态

```
新消息进来
   ↓
agent 判断意图,调用 tools 维护 raw_events 状态:

├─ 新事件起点
│    → CREATE raw_event WITH status='pending'
│
├─ 对现有 pending 的补充/修正
│    → UPDATE raw_event (加入 related_messages)
│
├─ 用户确认("好,记一下")
│    → UPDATE status='pending' → 'committed'
│
├─ 跨 session 修正历史事件
│    → CREATE new raw_event WITH supersedes_event_id=<old>
│    → UPDATE old status='committed' → 'superseded'
│
└─ 闲聊/无关
     → 不创建 raw_event(只在 messages 表)
```

**飞轮只看 status='committed' 的 raw_events**,pending/superseded/abandoned 都不参与统计。

### 关键洞察

**洞察 1:raw_event 的语义被精确化了**

> **raw_event 不是"用户说了什么",是"用户授权系统把什么当成事实"**。

这个区分非常重要。用户说"今天买了 ¥45 咖啡"——这只是**陈述**。说"行,记一下"——才是**授权**。

授权动作对应状态机的 `pending → committed` 转换。

**这跟前 4 件协议里的"用户审核"是同一种产品哲学**——任何"事实"的产生都需要用户的某种形式的确认,即使是隐式的。

**洞察 2:messages 表是被低估的关键支柱**

设计完整协议后回看,messages 表的角色比想象的重要——

它不只是"备份",**它是后续 schema 演化、协议升级、数据回填的基础**。任何衍生数据(raw_events / 业务表 / wiki)都可以从 messages 表重新派生。

> 没有 messages 表 → schema 演化后老数据无法重新抽取
>
> 没有 messages 表 → 升级协议改变后历史信号无法重新评估
>
> 没有 messages 表 → 协议本身不可演化

**这是后来才意识到的**——v1 时期我把 raw_events 当 source of truth,后来发现这是个根本性错误:**source of truth 必须是最原始的、最低抽象的、不依赖任何当时 schema 的层**。

**洞察 3:边界场景的处理**

设计过程中专门列了 4 个边界场景,每个都有明确处理:

| 场景 | 处理 |
|---|---|
| 跨 session 修正 | 把 committed event summary 写入 OpenClaw memory,agent 自动召回 + supersede |
| 批量录入(一次说 3 件事) | 拆成 3 个独立语义事件,每个独立 commit |
| 模糊陈述("今天花了不少钱") | 不创建 pending,先问澄清——不进入"为创建而创建" |
| 用户要求删除 | 软删除(abandoned),物理记录保留(P1 原则) |

**协议的可信度建立在对边界场景的诚实处理上**。

---

## 第 4 件:Schema 演化与回填协议

### 解决的问题

最开始记消费只分大类——`category ∈ ['food', 'goods', 'services']`。

用了 3 个月,记录了 200 条数据后,系统(或用户)意识到 food 出现得太频繁,应该细分:`subcategory ∈ ['meat', 'beverage', 'snack', ...]`。

升级 schema 容易(`ALTER TABLE ADD COLUMN subcategory`)。**但历史 200 条数据怎么办?**

如果不回填:
- 用户查"过去 3 个月吃肉花多少"——只能查到 schema 升级之后的数据
- 跨时间统计断裂
- 用户感觉"系统坏了"

如果不优雅地回填:
- 一次性补 200 条,LLM 成本失控、用户阻塞、失败处理复杂

这是"会成长的数据系统"的核心问题——**绝大多数项目根本不允许 schema 演化,就是为了避开这个问题**。

### 核心机制:三个组成部分

**组成 1:每行数据带"提取版本"标记**

所有业务表必须有这两个字段:

```sql
extraction_version INTEGER NOT NULL DEFAULT 1,
extraction_confidence REAL
```

每行知道自己是用哪个版本的 schema 抽出来的,新升级时只回填版本落后的行。

**组成 2:Schema 变更登记表**

```sql
CREATE TABLE schema_evolutions (
  capability_name,
  from_version, to_version,
  change_type,         -- 'add_column' / 'modify_column' / ...
  diff JSON,
  approved_at,
  applied_at,
  backfill_strategy,   -- 三种策略之一
  backfill_status,
  backfill_job_id
);
```

每次 schema 变更**是一个 first-class 事件**——可追溯、可审计。

**组成 3:三种回填策略**

```
策略 A · 从现有数据推导(零 LLM)
  例:加 day_of_week 字段 → 从 occurred_at 算出来,不需要 LLM

策略 B · 从 raw_events.extracted_data 推导(轻量 LLM)
  例:加 subcategory → 看老 extracted_data 里的描述
      用便宜 LLM 推断,$0.0001/条

策略 C · 从 messages 重新抽取(完整 LLM)
  例:之前没抽 location 字段,现在要补
      需要回到原文,用智能 LLM 重抽,$0.001/条
```

**策略由 Claude Code 共建时分析决定**——它生成的 design.md 必须说明用哪种策略,以及成本估算。

### 三种回填模式

```
Eager(立即全量回填):
  schema 升级完成 = 所有历史数据回填完成
  适合:数据量小(< 500 条)、用户接受等待

Lazy(查询时按需补):
  schema 升级即时生效,老数据 NULL
  查询触发时回填涉及的行
  适合:数据量中等(500-5000)、用户希望立即开始用新 schema

Sample(只回填 10% 抽样):
  按抽样回填,用于趋势分析
  适合:数据量大(> 5000)、回填成本高
```

### 用户可见的回填 UX

升级时用户看到:

```
建议升级 expense schema
新增字段: subcategory
预计回填: 200 条历史数据
预计成本: $0.8
预计时间: 8 分钟
[✅ 升级并回填] [⏸ 只升级,以后再补] [❌ 不升级]
```

回填过程中:

```
/status expense
─────────────
当前版本: v2
回填进度: 156/200 (78%)
预计剩余: 2 分钟
失败数: 3 (低置信度,需手动确认)
```

**透明,不掩盖**。

### 关键洞察

**洞察 1:回填是 schema 升级的一等公民**

很多系统的 schema migration 只想着"改 DDL",**没想 schema 改了之后老数据怎么办**。

我的协议把回填**作为升级流程的一部分**:

```
升级提案 → 用户审核(含成本估算)→ schema migration → 回填作业 → 完成通知
```

任何一步失败,整个升级可回滚。

**洞察 2:messages 表的存在让回填天然可能**

如果只有业务表数据 + raw_events 的 extracted_data——extracted_data 已经是按老 schema 抽的,字段都不在了,补不出来。

但有 messages 表 → 任何新 schema 都能从原文重抽。

> **messages 表是 schema 演化能力的物理基础**。

这跟数据粒度协议(第 3 件)是连环设计——**没有那一件,这一件就不存在**。

**洞察 3:不是所有数据都能成功回填**

某条 message 里就没有相关信息("买了点东西 ¥45")——subcategory 推不出来。

处理:用 LLM confidence 分流——

```
confidence ≥ 0.7  → 自动写入
0.3 ≤ confidence < 0.7  → 标记 'low_confidence',让用户确认
confidence < 0.3  → 标记 'unable_to_extract',保持 NULL
```

用户能看到"还有 5 条因为原始信息不足无法分类——你想手动补吗?"

**协议的诚实在于承认无解的情况,而不是假装能解决一切**。

**洞察 4:这件协议本身就是个研究空白**

整个 LLM-era 的数据工具生态——Mem0、Graphiti、Cognee、各种 ETL 工具——**都不处理 schema 长期演化的回填问题**。它们要么 schema 固定,要么单次抽取。

> "如何在 schema 演化时让 LLM 系统优雅地回填历史数据" 是个独立的研究产出。

---

## 第 5 件:Micro-app 全过程开发协议

### 解决的问题

前 4 件协议都讲"什么时候/怎么演化",**但还差一环——升级实际怎么落地成可运行的代码**?

具体场景:

```
Reflect Agent: "用户记了 30 条消费,建议建立 expense 能力"
用户: ✅ 同意

那么:
- 谁写 SQL migration?
- 谁写 ingest pipeline 代码?
- 谁设计 extract prompt?
- 谁定义 dashboard widget?
- 谁集成进运行时?
- 失败了谁负责回滚?
```

不能让用户自己写代码——他要是会写就不需要这个产品了。

需要一套机制,**让 LLM 自主完成完整的工程过程**,同时保证产物质量、用户可干预、可观察、可回滚。

### 核心机制:三段式流程 + OpenSpec 框架

**阶段 A · Plan Phase**

用户提需求 → agent 进入 `/opsx:explore` 模式 → 多轮对话精炼需求 → 沉淀 PLAN.md

```
用户: "我想加个股票追踪"
   ↓
Claude Code 在 explore 模式:
  不生成任何文件
  通过 IM 跟用户多轮对话
  读现有 specs/ 了解系统
  帮用户澄清: 数据模型、触发场景、查询场景、跨能力联通
   ↓
用户确认 → PLAN.md 沉淀
```

**阶段 B · Spec Decomposition**

PLAN.md 不是一次性大 build,而是拆成多个 atomic OpenSpec changes:

```
Claude Code 多次调用 /opsx:propose:
  changes/001-create-schema/
  changes/002-create-ingest/
  changes/003-create-skill/
  changes/004-create-dashboard/

每个 change 自动生成 4 个 artifact:
  proposal.md  — 为什么改
  specs/       — 改什么(deltas)
  design.md    — 技术决策
  tasks.md     — 实施清单
```

用户审核 changes 列表。

**阶段 C · Orchestrated Build**

Orchestrator 依次跑每个 change:

```python
for change in changes:
  1. claude code -p "/opsx:apply <change-id>"
     → Claude Code 读 tasks.md,逐个实施,自动勾选
  
  2. claude code -p "/opsx:verify <change-id>"
     → OpenSpec 内置 validation gate
  
  3. custom validation:
     - extraction_version 字段存在?
     - raw_event_id FK 有效?
     - 金额用 INTEGER minor units?
     - 没有动 scope 外的文件?
  
  4. claude code -p "/opsx:archive <change-id>"
     → archive 到 archive/_pending/
     → deltas merge 进 specs/
  
  5. IM 上报进度(✅ 或失败)

任何 change 失败 → 用户决策(重试 / 跳过 / 中止)
所有 change 完成 → 进入 Integration Phase
```

### 中断与恢复(5 种场景)

| 中断类型 | 处理方式 |
|---|---|
| agent 在输出里提开放问题 | 解析问题 → IM 呈现给用户(带默认答案)→ 二轮对话 |
| agent 达到 max_turns | Claude Code 原生 `--resume <session-id>` 续跑 |
| agent 反复失败 3+ 次 | AGENTS.md 强制 agent 写 BUILD_STUCK.md → 上报用户 |
| 用户主动 /stop | git commit 当前进度 + 标记 paused → 用户发"继续"恢复 |
| 进程崩溃 | builds 表持久化状态 → OpenClaw 启动时检查 unfinished → 询问用户 |

### Integration Layer

OpenSpec archive 完成 ≠ 能力上线。需要 8 步集成:

```
1. 应用 migration(写主 SQLite)
2. 注册到 capability_registry
3. 热加载 ingest pipeline
4. 注册新 skill 到 OpenClaw skill registry
5. 注册 cron jobs(如有)
6. 注册 dashboard widgets
7. v<N> 标记为 current(symlink)
8. git commit
```

任何一步失败 → git revert + cleanup → 主系统永远可恢复。

### 关键洞察

**洞察 1:渐进交付胜过一次性大 build**

最初想让 Claude Code "一次跑完整个 micro-app"——但 headless 模式下单次大任务的跑通率只有 40-60%。

拆成 5 个 atomic change 串行,**每个跑通率 >90%**,失败只影响那 1 个 change。

> 这跟软件工程的"小 commit 心智"完全一致——把 commit 的智慧应用到 AI 共建。

**洞察 2:OpenSpec workflows profile 是关键发现**

最开始我设计了自己的"Planner Agent"——把 PLAN.md 拆成多个 change。后来发现 OpenSpec 的 `/opsx:propose` 已经做了这件事。

类似的发现还有:
- `/opsx:explore` → Plan Phase
- `/opsx:verify` → 独立验证 gate
- `/opsx:archive` → 归档并 merge 到 specs/
- `/opsx:sync` → 反向同步代码到 spec

> 一次性砍掉了 2 个我打算自建的 agent——**学会"不重复造轮子"的教训通过反复发生新事实而强化**。

**洞察 3:AGENTS.md 是单一最重要的工程产出**

Claude Code 启动时自动读的"系统宪法"。它决定 Claude Code 生成的代码是否真的嵌入你的系统。

内容包括:
- 架构约束(双层结构 + owner pipeline 等原则)
- 硬性规则(P1-P6 数据原则)
- 命名约定(`_minor` 后缀、`_at` 时间戳等)
- 目录约定(capabilities/<name>/v<N>/)
- scope 纪律(每个 change 不动 tasks.md 外的文件)
- 失败逃逸机制(连续 3 次同错 → 写 BUILD_STUCK.md)

> AGENTS.md 写得好,Claude Code 生成的代码直接嵌入系统;写得差,需要无尽返工。

**洞察 4:这件协议是把前 4 件变成代码的引擎**

前 4 件协议是"协议",但**没有第 5 件,它们就不会真的发生**:

- 状态机走到 `approved` 时 → 没有第 5 件,**没有任何东西落地**
- Schema 演化协议 → 没有第 5 件,**没人写新 pipeline**
- 浮现提议 → 没有第 5 件,**只能告诉用户"我建议建能力",永远不能真建**

第 5 件 + OpenSpec 框架,**让整个 lifecycle 在工程上闭环**——所有演化都通过 OpenSpec changes 显式记录,archive/ 目录成为系统演化的完整史诗。

---

## 五件协议合起来的整体性

讲完每件后,值得回到整体看看它们怎么协作:

```
用户输入(IM 消息)
   ↓
[第 3 件 · 数据粒度协议]
  双层结构: messages 表 → raw_events 状态机
   ↓
[第 2 件 · 业务能力浮现协议]
  Reflect Agent 扫数据,识别三类信号
  → 生成 proposal(新能力 / schema 演化 / 归档)
   ↓
用户审核(统一审核 UI)
   ↓
[第 1 件 · 能力生命周期状态机]
  状态推进: proposals → builds(开始构建)
   ↓
[第 5 件 · Micro-app 开发协议]
  Build Bridge 调度 Claude Code 通过 OpenSpec changes 落地
   ↓
[第 4 件 · Schema 演化与回填协议]
  如果是 schema 升级,触发回填 worker 处理历史数据
   ↓
状态推进: builds → capability_registry(active)
   ↓
能力上线 / 后续可能 archived
```

**任何一件单独看是个独立协议;合起来构成完整的 capability lifecycle**。

---

## 这五件协议对应到面试场景

不同时长的展开建议:

### 30 秒版

> "我设计了五件套协议来管理能力的完整生命周期:状态机定义 capability 在系统里有几种存在形态;浮现协议决定什么时候建议建新能力、什么时候建议归档;数据粒度协议解决对话粒度跟事实粒度不对齐的问题;schema 演化与回填解决历史数据跟着新 schema 演化的问题;最后,micro-app 开发协议把所有这些用 OpenSpec + Claude Code 真正变成代码。前 4 件是协议,第 5 件是把协议变成代码的引擎。"

### 5 分钟版

每件协议讲 1 分钟——讲"解决什么问题 + 核心机制 + 一个关键洞察"。

### 30 分钟版

深入任何一件,把"关键洞察"展开。每件都有足够材料讲到这个深度。

---

## 这五件协议作为研究产出的特殊性

最后值得说一句——这五件协议**不是从一开始就设计好的**。它们是反复对话、自我反问、被否决、再校准的产物:

- 状态机 → 最初被设计成 L0-L5 阶梯,后来又改成 6 状态状态机,最终砍成"三张表协作"(proposals / builds / capability_registry 各管一段)——两次自我修正
- 浮现协议 → 被反问"会不会 schema 爆炸"才把归档信号也加进来
- 数据粒度 → 在思考"具体怎么实现"时撞到的真问题
- Schema 演化 → 被反问"schema 升级了历史怎么办"才浮现
- Micro-app 开发 → 把前 4 件变成代码时才搞清楚需要什么

> **真正的研究产出来自工程问题的反复诚实追问,不是从论文里推导出来的**。

这是这五件协议作为研究产出的最有说服力的地方——**每一件都有具体场景作为存在理由**,而且每件都经过至少一轮"自我否定 + 重写"。
