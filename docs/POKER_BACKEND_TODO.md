# 活动牌桌：Java 后端待实现接口设计

2026-10-02 时长、最终结算及之前剩余项的统一交付清单见 [POKER_BACKEND_CAPABILITIES.md](POKER_BACKEND_CAPABILITIES.md)，本轮请优先使用该文档。

核对日期：2026-10-01。页面：`p.html`。核对依据是相邻 `daoleme` 仓库当前源码，不代表公网部署已完成验证。本文件可以直接交给 Java 开发；完整现有协议见 [ACTIVITY_POKER_API.md](ACTIVITY_POKER_API.md)。

最新核对更新：相邻 Java 已补齐 UNREADY/BUY_IN/PAUSE_GAME/RESUME_GAME 的业务与快照授权、带入/暂停字段，以及 UTG 等位置；这些原有缺口进入部署验收阶段。前端保留对只授权 STAND_UP 的旧取消准备快照的兼容。

**赢家派奖与自动续局已在最新 Java 源码实现，按 [赢家派奖与 10 秒自动续局设计](POKER_SETTLEMENT_AUTOPLAY.md) 部署验收**：result.payouts / settledAt、room.nextHand、每手延续参局资格及服务端到期发牌。首次开始后不用再准备/开始；该新文档的续局及暂停恢复规则优先于下面原版的逐手准备/立即恢复描述。

最新剩余调整见 [行动特效与离线超时弃牌设计](POKER_ACTION_EFFECTS_TIMEOUT.md)：统一超时 fold，以及 allInCommitted 解决全下赢家立即结算时漏提示。无需新增接口。

## 1. 实现范围

前端已实现以下入口、消息发送和快照渲染，后端补齐并返回授权即可启用，不需要另建 HTTP 接口。

| 项目 | 当前源码状态 | 后端需补齐 |
| --- | --- | --- |
| 入口、开房 | 已有 POST `/api/poker/v1/entry`、`/api/poker/v1/rooms` | 沿用现有 ticket 身份验证 |
| 连接、落座、准备、起身、开局、下注 | 已有 AUTH/PING/SIT_DOWN/READY/STAND_UP/START_HAND/ACTION | 沿用现有活动 v1 大写协议 |
| 取消准备 | 业务与视图已加入 UNREADY | 部署验收：已准备授权 UNREADY，未准备授权 READY |
| 追加带入 | BUY_IN、配置/金额/授权快照已加入 | 部署验收即时和延迟到账、幂等及恢复 |
| 暂停游戏 | PAUSE_GAME、playState 和授权已加入 | 验收结算边界；新增自动续局排期取消规则 |
| 继续游戏 | RESUME_GAME 和暂停授权已加入 | 按新设计改为恢复10秒排期，不要求再次准备 |
| 赢家派奖明细和自动续局 | 已加入 payouts/settledAt/nextHand 和持久调度 | 部署验收金额、十秒排期、连续参局与暂停恢复 |
| 离线超时一律弃牌 | 已有独立于连接的调度，但免费行动超时仍 check | 按新文档改为统一 fold |
| 全下立即结算的提示 | allIn 仅以最终 stack==0 判断 | 增加本手持久标志 allInCommitted |
| 成员头像、累计带入、盈亏 | 已有 avatarUrl/totalBuyIn/netChips | 沿用；第 6 节说明结算盈亏可选调整 |
| UTG、UTG+1、LJ、HJ、CO | 当前 PokerHand 已补齐 | 沿用 position，部署后核对庄位轮转；旧版本由前端兼容 |

需要重点修改 `PokerActivityService`（命令白名单及事务）、`PokerRoomViewService`（授权与快照）、`PokerHand`（结算边界与位置）、账本/流水/房间存储及超时调度。`PokerSocketEndpoint` 已把认证后的非 PING 命令交给业务服务，沿用即可。禁止混用首页演示的小写协议。

## 2. 通用消息与一致性

复用入口返回的 WSS 连接。用户身份、活动、房间由 AUTH 绑定；命令不接受客户端指定他人 userId、房间或余额。

```json
{"type":"UNREADY","requestId":"唯一请求ID","payload":{}}
{"type":"BUY_IN","requestId":"唯一请求ID","payload":{"amount":400}}
{"type":"PAUSE_GAME","requestId":"唯一请求ID","payload":{"afterCurrentHand":true}}
{"type":"RESUME_GAME","requestId":"唯一请求ID","payload":{}}
```

这些命令不带 `expectedRevision`。仅 ACTION 沿用 handId/expectedRevision 校验。保持 payload 白名单，拒绝多余字段。

- 所有变更按房间数据库行锁串行化，复核活动资格、生命周期、房主身份和最新状态。复用现有 `(roomId,userId,requestId)` 持久去重；同 ID 同命令同 payload 不重复执行，同 ID 不同意图返回 REQUEST_ID_REUSED。
- 成功事务写业务状态、流水、命令记录并递增 room revision；提交后给各连接发送按接收者生成的完整 SNAPSHOT。可以沿用现有数据库 revision 轮询传播，不要求增加增量事件。
- 请求连接的成功 SNAPSHOT 携带原 requestId。其他连接也收到新快照；未公开底牌仍按用户遮蔽。
- 幂等重试返回最新快照，不重复加筹码、发牌或递增 revision。拒绝不修改业务状态，返回原 requestId 与可展示中文原因：

```json
{"type":"ERROR","requestId":"对应请求ID","payload":{"code":"HAND_RUNNING","message":"请等待本手结束后操作"}}
```

前端只有收到 SNAPSHOT 才改变准备、筹码和暂停状态；不能只返回自定义 ACK。网络中断后从 `/entry` 重新取凭证，再认证取最新快照。

## 3. UNREADY：取消准备

请求：`{"type":"UNREADY","requestId":"uuid","payload":{}}`。

- 仅当前已落座、已准备、没有正在运行的手牌时可用。暂停期间允许调整准备状态；房间关闭或活动结束拒绝操作。
- 锁内设 `ready=false`，保留座位、筹码与累计带入；递增 revision 并广播。
- 本人快照 `self.roomState=SEATED`；对应成员 `state=SEATED, ready=false`，本人 allowedCommands 移除 UNREADY，重新加入 READY（有筹码时）。已准备时反向授权 UNREADY，不授权 READY。
- 与 START_HAND 并发使用相同行锁：取消先成功，开局按最新准备人数重新校验；开局先成功，取消返回 HAND_RUNNING。
- 错误：NOT_SEATED、NOT_READY、HAND_RUNNING、ROOM_CLOSED、NOT_ROOM_MEMBER、ACTIVITY_ENDED。

## 4. BUY_IN：追加带入筹码

请求金额是追加量，不覆盖原余额，不接受负数或提现。

```json
{"type":"BUY_IN","requestId":"uuid","payload":{"amount":400}}
```

### 4.1 配置和权限

入口、开房返回和每次 SNAPSHOT 都增加以下字段，缺失时前端不开放带入操作：

```json
{
  "room":{"buyIn":{"minAmount":200,"maxAmount":2000,"step":200,"options":[200,400,1000,2000]}},
  "self":{"stack":600,"pendingBuyIn":400,"allowedCommands":["BUY_IN"]},
  "roomMembers":[{"userId":"u1","stack":600,"totalBuyIn":1000,"pendingBuyIn":400,"netChips":-400}]
}
```

该片段只演示带入字段；正式返回完整快照与完整 allowedCommands，不能覆盖其他可用命令。

- 允许有活动资格的房间成员在旁观、起身、落座和参局中申请；运行中仍授权 BUY_IN，但延迟到账。
- 金额为正整数、安全范围内的整数；每次申请满足 `minAmount <= amount <= maxAmount`、`(amount-minAmount)%step=0`。配置 step/min/max 必须合法，options 必须符合范围与步长。后端校验，不信任下拉选择。
- 设置明确的用户与房间筹码上限，受理前检查余额、已受理待到账及本次金额之和不会溢出 Java/JavaScript 金额范围。

### 4.2 即时与延迟到账

| 受理时状态 | 事务行为 | 玩家可用筹码 |
| --- | --- | --- |
| 未开局、两局之间、已暂停 | stack += amount；totalBuyIn += amount；流水直接 APPLIED | 新快照立即更新 |
| 当前存在运行中的手牌 | pendingBuyIn += amount；流水 PENDING | 本局 stack、底池与下注上限不变 |

运行中申请成功也必须立即广播新 revision，确认待到账金额。本人已弃牌或正在旁观仍等当前手结束；追加不自动改变准备状态。

结算事务必须按以下顺序执行：

1. 完成全部底池/边池支付并把游戏结果写回参局成员账本。
2. 对全房间成员（包括旁观、起身、弃牌成员）应用所有 PENDING：stack 和 totalBuyIn 同时增加到账金额，pendingBuyIn 清零，流水改 APPLIED。
3. 保存完整结算快照和单调递增 revision，再判断暂停状态，提交后广播。
4. 上述步骤全部完成后才允许下一次开局。防止当前 persistHand 覆写 stack 吞掉新增筹码。

complete 快照里的 `roomMembers.stack` 是到账后的余额，`game.players.stack` 可以保留本手结算结果；前端已在 complete 时优先展示成员账本。未到账金额不计入 totalBuyIn，不进入本局筹码守恒计算。

### 4.3 持久化与恢复

- 扩展现有带入流水或增加流水表：roomId、userId、requestId、amount、受理 handId（可空）、PENDING/APPLIED、createdAt、appliedAt。命令幂等记录与流水在同一事务提交。
- 成员筹码账本增加 pendingBuyIn（默认 0），继续使用已有 stack/totalBuyIn。资金归 roomId/userId，不归会轮转或更换的座位。
- 重启恢复 PENDING 流水；聚合值与流水合计一致。应用流水使用状态条件更新和事务，重复结算、跨实例恢复只到账一次。若恢复发现无运行中手牌，先补应用待到账再开放开局。
- 关闭房间或活动结束前处理已受理的待到账金额；有运行中手牌时先完成安全结算，不能丢弃已确认款项。关闭后拒绝新申请。
- 错误：BUY_IN_DISABLED、BAD_BUY_IN_AMOUNT、CHIP_LIMIT、ROOM_CLOSED、NOT_ROOM_MEMBER、ACTIVITY_ENDED。失败不写流水、不改金额。

## 5. PAUSE_GAME / RESUME_GAME：暂停和继续

房间新增持久化 `playState`，与生命周期 `room.status` 分开。入口、开房和所有快照均返回。

| playState | 含义 | 房主管理授权 |
| --- | --- | --- |
| WAITING | 首次开始前 | 准备人数满足时 START_HAND |
| RUNNING | 已开始，正常进行；也包括两手之间 | 两手之间满足条件时 START_HAND；PAUSE_GAME |
| PAUSE_PENDING | 当前手结束后暂停 | 移除 PAUSE_GAME、START_HAND、RESUME_GAME |
| PAUSED | 本手已结束，停止下一手 | 准备人数满足时 RESUME_GAME |

普通成员始终不授权房主管理命令；服务端校验真实活动创建人，不能仅依赖前端隐藏按钮。

### 5.1 暂停

请求：`{"type":"PAUSE_GAME","requestId":"uuid","payload":{"afterCurrentHand":true}}`。

- 仅房主、状态 RUNNING 可申请；只接受 afterCurrentHand=true。
- 有运行中手牌：锁内设 PAUSE_PENDING，立即广播。保留 game/turn/legal/turnDeadline，继续 ACTION、行动超时和正常结算。不能冻结本手，也不能取消已受理的带入。
- 本手结算和待到账应用结束后，同一事务改 PAUSED，保留 complete 结果，停止手动/自动发下一手。
- 申请时已经在两手之间：立即改 PAUSED；初始 WAITING 没有正在运行的游戏，拒绝暂停。
- 重复新 requestId 可返回 ALREADY_PAUSED/PAUSE_ALREADY_PENDING；相同 ID 重试按幂等成功处理。

### 5.2 继续

请求：`{"type":"RESUME_GAME","requestId":"uuid","payload":{}}`。

- 仅房主、PAUSED、没有运行中手牌时可用；重新检查至少两名有有效座位、有正筹码且已准备的活动成员，符合当前 Java 准备机制。
- 锁内改 RUNNING，按现有 START_HAND 流程安全开始下一手；新 handId、正确庄位/盲位、清理已消费的准备状态，广播新 game。前端只发送 RESUME_GAME，不会随后自动补 START_HAND。
- 如果人数或准备不足，保持 PAUSED，返回 NOT_ENOUGH_PLAYERS 或 NOT_ENOUGH_READY_PLAYERS；快照不授权 RESUME_GAME，成员仍可 READY/UNREADY/BUY_IN/安全起身落座。
- 超时调度、跨实例轮询、服务重启必须遵守持久 playState；PAUSE_PENDING 继续完成本手，PAUSED 不得自动开启新手。
- 错误：NOT_ROOM_CREATOR、BAD_PAYLOAD、NOT_RUNNING、NOT_PAUSED、HAND_RUNNING、ROOM_CLOSED，以及上面的重复和人数错误。

## 6. 金额口径与位置字段

### 成员展示：已有接口

前端使用 avatarUrl、nickname、state、online、totalBuyIn、netChips。盈亏仅显示数字与符号：正数红色 `+120`，负数绿色 `-80`，零默认颜色 `0`；没有“盈利/亏损”文字，没有座位序号。空座仅显示“空座”。成员不是按座位排序展示。

当前 Java 的 netChips 是 `stack-totalBuyIn`，会随本局下注出现临时负数。这个字段已有，不属于缺失接口。若要改成“已结算净收益”，推荐新增持久 `settledNetChips` 内部字段并继续通过 netChips 返回：初始 0，每手结算后更新（结算余额减累计已到账带入），运行中保持上手结果；追加到账同时增加余额与 totalBuyIn，不改变净收益。重连、起身和换座不得清零。该口径调整需后端统一决定，无需新增前端接口。

### 位置名称：建议补齐，前端已有兼容

继续提供 `game.dealer/smallBlindSeat/bigBlindSeat` 和 `game.players[].position`。座号为零基内部标识，不是页面文案。每手发牌时根据参局人员计算一次位置，随本手固定；弃牌不删除位置，跳过没参局的空座或旁观者。

三人以上从大盲之后的第一个参局者开始，直到庄位之前，使用本项目约定：

| 本手人数 | 大盲后到庄位前的位置顺序 |
| --- | --- |
| 3 | 无 |
| 4 | UTG |
| 5 | UTG、CO |
| 6 | UTG、HJ、CO |
| 7 | UTG、UTG+1、HJ、CO |
| 8 | UTG、UTG+1、LJ、HJ、CO |
| 9 | UTG、UTG+1、UTG+2、LJ、HJ、CO |

服务端庄位/盲位 position 保持 BTN/SB/BB，前端翻译为庄位/小盲/大盲；双人庄位兼小盲，仍提供明确 dealer 和 smallBlindSeat，前端显示“庄位/小盲”。其余标签优先服务端 position，旧服务为空时按上述规则兼容推导。下一手重新计算，不保存为用户永久位置。

## 7. 交付验收

1. 准备后显示取消准备；取消快照回 SEATED。与开局并发不会少于两名已准备成员开局，运行中取消被拒绝。
2. 初始 stack=200、totalBuyIn=200；两局间追加 400 后立即变 600/600，netChips=0。
3. 运行中追加两次 400/200：pendingBuyIn=600，本局 stack/legal/pot 不变；结算后一次到账 600。旁观者和已弃牌者同样到账。
4. 同 requestId 的 BUY_IN 重发不重复到账；改金额返回 REQUEST_ID_REUSED；并发开局/结算/带入金额守恒。
5. 服务重启、跨实例结算、房间关闭处理所有待到账，最终不丢失、不重复；重连返回完整金额和授权。
6. 本局申请暂停立即 PAUSE_PENDING，当前行动与超时正常；结算及追加到账后 PAUSED，没有下一手。恢复只发一个新 handId，普通成员请求被拒绝。
7. PAUSED 下人数不足或未准备不恢复；补足并准备后授权 RESUME_GAME。所有 START_HAND 入口均拒绝 PAUSE_PENDING/PAUSED。
8. 2–9 人、空座、弃牌、庄位轮转、双人庄位兼小盲正确；本人始终位于屏幕正下方，命令仍使用真实 seatIndex。随机房间请求 payload={}，自选为 {seatIndex}。
9. 头像、金额符号与颜色、累计带入在快照变更后更新；缺字段不能冒充零；失败 ERROR 包含原 requestId 和中文 message。

交付顺序建议：数据库迁移与恢复 → UNREADY → BUY_IN → 暂停/继续 → 位置和可选盈亏口径 → 真实 ticket、双客户端与重启联调。部署后沿用现有 WSS/CORS/密钥配置，前端不用更换 URL 或协议。
