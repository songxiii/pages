# Java 对接能力清单：房间时长、最终结算及历史剩余项

核对日期：2026-10-02。依据为相邻 daoleme 当前源码，未以真实 ticket 验证线上部署。本文件是本轮统一交付清单，前端 p.html 已接入下面的字段。旧设计有冲突时以本文为准。

## 1. 复用范围与尚缺能力

| 能力 | 当前源码 | 本轮工作 |
| --- | --- | --- |
| 入口、开房、闭房只读入口 | POST `/api/poker/v1/entry`、`/api/poker/v1/rooms`，已有 ROOM_CLOSED | 复用这两个接口；闭房入口补最终报告，禁止重新初始化成员/筹码 |
| 落座、准备/取消、起身、下注 | 已有 SIT_DOWN/READY/UNREADY/STAND_UP/START_HAND/ACTION | 沿用授权和事务；增加到期校验，当前手牌 ACTION 可继续 |
| 带入、暂停、继续 | BUY_IN/PAUSE_GAME/RESUME_GAME、待到账、playState 已实现 | 复用；截止到时优先结束，暂停不延长时间，原待到账在最终关房前应用 |
| 赢家金额、十秒连续开手 | result.payouts/settledAt、PokerNextHand、参局资格延续、服务端调度已实现 | 沿用；到期立即取消下一手排期，不能把下一手倒计时当最终结算倒计时 |
| 固定游戏时长与房间截止 | RoomSettings/roomView/Repository 当前没有时长或 endsAt | **新增 durationMinutes 与 room.timing，持久化固定截止** |
| 安全到期与关房 | 已有活动结束后等待手牌完成、closeEndedRoom/applyPending | **扩展共用生命周期方法：房间到期、暂停、无客户端时均能关闭；避免入口提前视为 CLOSED** |
| 全场手数、流水、最大底池、个人手数 | 活动在线状态只存最新一手，没有持续累加这些统计 | **在首次结算事务累加全场与每人计数** |
| 最终结算与排名 | 永久座位账本有 stack/totalBuyIn；当前成员视图过滤退出者，无最终报告 | **按完整账本冻结 settlement，包括已起身/退出/离线的人** |
| 关房通知 | ROOM_CLOSED 目前只有 message；WebSocket 可能直接关闭 | **推送完整最终 game + settlement + room.timing，再关闭连接** |
| 超时一律弃牌 | 有独立于在线连接的超时调度，免费行动超时仍 check | **PokerHand.timeout() 一律 fold** |
| 全下立即结算提示 | allIn 仅判断最终 stack==0，赢家派奖后会 false | **HandPlayer 增加 allInCommitted，前端已兼容** |

无需新增 HTTP 接口、新的 WebSocket 地址、客户端 END_GAME 或 FETCH_SETTLEMENT 命令。HTTP 和 WS 共用 PokerRoomViewService 的投影及同一份最终报告。

**发布依赖：当前 RoomSettings 使用 JsonAnySetter 拒绝未知字段，新的 durationMinutes 请求现在会被拒绝。必须先上线后端配置支持，再发布/使用新版开房表单；不能偷偷丢弃时长后声称已设定。** 已有房间继续使用原字段；不含 timing 的旧快照不会显示虚构倒计时。

## 2. 开房与时长语义

仍调用 POST `/api/poker/v1/rooms`：

```json
{
  "ticket": "原活动ticket",
  "settings": {
    "maxSeats": 6,
    "seatingType": 1,
    "smallBlind": 10,
    "bigBlind": 20,
    "startingStack": 1000,
    "turnSeconds": 30,
    "durationMinutes": 120
  }
}
```

- 前端选项：30/60/90/120/180/240/360/480 分钟，默认 120；Java normalize 同样校验整数及选项、默认值，sameAs 必须比较时长。
- **从开房成功的 createdAt 开始计时**，endsAt=createdAt+durationMinutes；暂停、无人在线、等待准备、缺人数均继续计时。
- 配置创建后固定，重试开房、刷新、重连不能重置 endsAt，也不能用 updatedAt 延长时间。
- 时间采用服务端 UTC，JSON 为带时区 ISO-8601。createdAt、endsAt 持久化后复用；客户端只显示倒计时，不调用关房动作。
- 旧房间的迁移策略必须明确。建议新房必填；已有缺截止的房间保留 NULL，不在每次读取时临时生成截止。如要给旧房加时长，执行一次性明确迁移，按原 createdAt 固定计算，过期仍需安全完成当前手。

入口、建房返回和完整 SNAPSHOT 增加：

```json
{
  "serverTime": "2026-10-02T01:59:50.000Z",
  "room": {
    "status": "PLAYING",
    "settings": { "durationMinutes": 120 },
    "timing": {
      "status": "OPEN",
      "startedAt": "2026-10-02T00:00:00.000Z",
      "endsAt": "2026-10-02T02:00:00.000Z",
      "endedAt": null,
      "reason": null
    }
  }
}
```

上面省略所有原有 settings/game 等字段；正式响应仍是完整快照。timing.status：OPEN 未到期，ENDING 已请求结束且等待当前手牌，ENDED 已完成最终关房。到期还有手牌时 room.status 仍 PLAYING、game 保留运行状态；endedAt 只有真正结算/关房后才有值。reason 使用 DURATION_REACHED/ACTIVITY_ENDED/ACTIVITY_CANCELLED 等稳定代码。

前端把 endsAt 减 serverTime 进行显示，本机时钟偏差不应影响时间。无需每秒发送 WS；生成快照时返回准确 serverTime，首次到期/最终结束必须递增 revision 并推送。时长倒计时与 game.turnDeadline 的行动倒计时完全独立。

## 3. 到期事务与复用调度

### 3.1 共用结束判断

建议抽出 `isEnding(room, activity, now)` 和 `requestEndOrFinalize(room, hand, ledger, now, reason)`，在现有房间行锁及事务内复用，不另起一套结算引擎。结束原因既覆盖 endsAt<=now，也覆盖活动结束/取消。

1. 时间到时先取消 PokerNextHand 的 COUNTDOWN，阻止 START_HAND/RESUME_GAME/READY/SIT_DOWN/新 BUY_IN；返回对应授权为空或删去相应命令。禁止跨截止边界开下一手，即使定时扫描还没运行。
2. 有运行中手牌：持久化结束待办原因，timing=ENDING，保持 game/turn/legal/turnDeadline，正常 ACTION 与超时推进；不要改 CLOSED，不要冻结玩家，不要提前派奖或全场结算。
3. 当前手结算时复用 PokerHand.settle 和 persistHand 的首次结算分支：写回余额、应用所有旧待到账、统计本手，再最终关房。不得恢复自动续局排期。
4. 没有运行中手牌，包括 WAITING、PAUSED、WAITING_PLAYERS、从未开始：直接应用待到账并关房。
5. 关房冻结报告，设置 CLOSED、closedAt（作为 timing.endedAt），nextHand=IDLE，清除行动/续局调度，递增 revision。状态、统计、报告和账本必须同一事务提交。

结束优先于暂停/恢复/下一手；不要为了关闭该房间把原活动标为 ENDED，活动与房间截止是独立条件。已接受的待到账不能消失，也不能把它计为底池奖额。

### 3.2 需要改的已有入口

- `PokerActivityService.execute/startHand/advanceNextHand/updateNextHand`：每个持房间锁的操作都检查 now 与截止；当前手的 ACTION 允许继续，其余按结束状态拒绝。nextHand 原排期即使先到也要重新检查 room 截止。
- `persistHand`：首次完成结算后先统计；若结束待办或截止到达，走最终关房，跳过 ready 自动延续及下一手排期。
- `PokerRoomService.open`：当前以活动 ENDED/CANCELLED 直接返回 ROOM_CLOSED，可能尚有运行中手牌。应先复核真实生命周期：还有手牌返回 ROOM_READY + timing.ENDING，只有真正完成后 ROOM_CLOSED。到期也不要新建成员或初始账本。
- `verifyIdentity`、WS `stillAuthorized`：当前活动结束检查可能一并拒绝 ACTION/断开连接。区分写入新游戏资格与完成当前手；正常有效身份的本手玩家仍能行动，并能收到最后一手/最终报告。活动退出/封禁的权限规则仍由 Java 校验，离线行动由超时调度处理。
- `closeEndedRoom`：复用关房事务，扩展到时长到期；只能在手牌结束后闭房并冻结报告。

### 3.3 调度

复用 PokerActivityTimeoutScheduler。新增按 poker_room.ends_at 索引扫描到期但未 CLOSED 的房间，建议进入现有 500ms 扫描或等价短间隔；必须包含暂停、等待、缺人数、从未开手的房间。现有 interHandRoomIds 只取 WAITING+RUNNING，不足以覆盖全部。

房间行锁内重查 endsAt/status，首次到期发一版 ENDING，不要每次扫描都重复 bump。运行中继续复用 poker_activity_state.action_deadline_at 处理行动；不要把该索引的行动截止覆盖成房间截止。所有客户端离线、服务重启、多个实例时也必须按持久时间结束，且同一手/同一房间只结算一次。

## 4. 全场统计与冻结报告

### 4.1 统计定义

| JSON 字段 | 计算方法 |
| --- | --- |
| settlement.totalHands | 全场已完整结算的手数，包括弃牌直接结束的手，不能简单拿 lastHandNo 代替 |
| settlement.totalPot | 每手最终 finalPot 累计；也等于每手 payouts.amount 的总和累计，即页面“牌局总金额/全部流水” |
| settlement.maxPot | 所有已结算手牌 finalPot 的最大值，零手为 0 |
| settlement.totalBuyIn | 最终全体永久账本 totalBuyIn 之和，包含初始筹码及所有已确认追加 |
| players[].handsPlayed | 该用户实际获发底牌且完成结算的手数；弃牌也算，旁观不算，不能用 ready/在线次数计数 |
| players[].totalBuyIn | 复用永久账本累计带入，起身、换座不清零；待到账关房前处理完 |
| players[].netChips | 最终账本 stack-totalBuyIn；用真实余额，不累计“获胜奖额”作为盈利 |

finalPot 已由现有 PokerHand 计算并扣除未跟注退回；不要二次求和边池、把 refund/追加带入算入流水。所有金额和手数为安全整数，userId 为字符串。现有筹码政策限制整个房间余额；新增累计流水也需检查溢出，不允许 JS 超出安全范围。

### 4.2 在已有首次结算分支累加

当前 `persistHand` 使用 `firstSettlement = !hand.running() && !hand.settlementCommitted`，并在同一事务保存加密状态。复用此边界：

1. 仅首次结算累计 totalHands+=1、totalPot+=finalPot、maxPot=max(maxPot,finalPot)。
2. 对 hand.players 的 userId 各增加 handsPlayed，含 folded、全下、离线和已退出活动的参局者；读取完整 seat 账本，不按当前活动资格过滤。
3. 跟原筹码写回、pending 应用、settlementCommitted 保存在同一事务；房间行锁和状态标记保证重复请求/扫描/重启不会重复计数。

建议最小增量：poker_room 增加 duration_minutes、ends_at（索引）、end_reason、total_hands、total_pot、max_pot、settlement_json；poker_room_seat 增加 hands_played。复用已有 created_at/closed_at、永久座位账本、带入流水、加密牌局和房间版本。

Repository mapper/COLUMNS/INSERT/运行状态更新都要同步。统一提交 runtime 更新时写入对应字段，避免多个旧 updateRuntime 重载清空截止/报告或重复增加 version。每条 SQL 仍只操作当前仓库约定的一张表。

实际活动协议目前只覆盖保存最新手牌的 poker_activity_state；数据库设计中的 poker_hand/poker_hand_player 不等于已落地的历史写入。若后续接入历史流水，可复用它们审计，但本轮不要求重写引擎。旧场次缺历史时不能从最后一手补造全场统计：应明确标记缺失，或只对新房启用完整统计。迁移时旧房未知统计字段保留 NULL、报告返 null（前端显示 —），不能以默认 0 冒充真实零手；新房从 0 开始。

### 4.3 报告范围与持久化

最终报告按 **完整永久账本** 冻结，包含已起身、换座、离线、退出活动的人，以及曾进房但旁观者（手数 0、净盈利通常 0）。不能直接使用当前 roomMembers：当前视图会过滤退出/封禁人员，导致排名和总金额丢失。

保存结算时的昵称、头像、userId、netChips、totalBuyIn、handsPlayed。报告中禁止存底牌、牌堆、随机种子等私密字段。冻结后重复打开不重新计算、不因活动成员变化删人、也不把新查看者插入报告/发初始筹码。

排名为 netChips 降序，持平按 userId 字符串升序；前端也会排序。没有盈利者时不强行授予 MVP；零显示 0，正数红色 +，负数绿色 -。

## 5. 最终 WS/HTTP 协议（前端已接入）

推荐事务提交后广播现有完整 SNAPSHOT。沿用所有原字段，仅加 room.timing 和顶层 settlement：

```json
{
  "entryState": "ROOM_CLOSED",
  "revision": 801,
  "serverTime": "2026-10-02T02:00:15.000Z",
  "activity": { "activityId": "A123", "title": "周末活动" },
  "self": { "userId": "u1", "allowedCommands": [] },
  "room": {
    "status": "CLOSED",
    "createdAt": "2026-10-02T00:00:00.000Z",
    "settings": { "smallBlind": 1, "bigBlind": 2, "durationMinutes": 120 },
    "timing": {
      "status": "ENDED",
      "startedAt": "2026-10-02T00:00:00.000Z",
      "endsAt": "2026-10-02T02:00:00.000Z",
      "endedAt": "2026-10-02T02:00:15.000Z",
      "reason": "DURATION_REACHED"
    },
    "nextHand": { "status": "IDLE", "startsAt": null }
  },
  "settlement": {
    "status": "FINAL",
    "createdAt": "2026-10-02T00:00:00.000Z",
    "endedAt": "2026-10-02T02:00:15.000Z",
    "showAt": "2026-10-02T02:00:25.000Z",
    "totalHands": 140,
    "totalBuyIn": 10800,
    "totalPot": 40346,
    "maxPot": 2106,
    "players": [
      {"userId":"u1","nickname":"小明","avatarUrl":"https://example.com/u1.jpg","netChips":1647,"handsPlayed":140,"totalBuyIn":200},
      {"userId":"u2","nickname":"小红","avatarUrl":"https://example.com/u2.jpg","netChips":-1647,"handsPlayed":140,"totalBuyIn":10600}
    ]
  },
  "connection": null
}
```

示例省略最终 game/成员等原有字段；正式 WS 必须保留最后一手 `game.phase=complete` 的公共牌、本人底牌、允许公开的对手底牌及 result.payouts，让当前观战客户端先看到最后一手派奖。不得发送未完成的 game 却宣称已关房。

- `showAt=真正 endedAt+10 秒`，是最终展示的绝对截止。不能用 endsAt+10 秒，因为最后一手可能晚于房间截止结束。可用已持久的 closedAt 派生，不能每次 view 构建重置。
- 当前在线客户端收到最终完整快照：显示“结算 · 10s”，禁止动作，到 showAt 切换 p.html 的结算页，不发送 START_HAND；迟到快照只等待剩余时间。
- 刷新或重新打开：POST `/entry` 直接返回 ROOM_CLOSED + 同一份 settlement + connection=null，**立即显示结算，不再等待十秒**；不创建第二个房间、不重新入房、不签发 WS。
- 可以保留 ROOM_CLOSED 事件，但其 payload 要有同样的 room/game/settlement/serverTime/self。最好先发完整 SNAPSHOT 再关连接；不能只发 message 后断开，客户端无法展示最后一手及统计。旧 message-only 通知，前端会重新请求 entry 获取结算。
- 读取最终报告沿用 ticket 与身份验证，建立明确只读权限：活动有效成员/房主可以看；若要求已退出的原玩家也能重新查看，应以历史 room_member 复核只读权限，不能因此允许重新游戏；封禁/无关联身份仍拒绝。关闭后不要依赖在线授权或“活动必须 UPCOMING”才能读。
- 缺 settlement 的旧服务，前端只显示“尚未返回完整结算”与重试，手数/流水用 —；不会拿当前成员/最后一手拼造全场报告。

## 6. 之前仍未完成的两项

1. `THPoker/domain/PokerHand.timeout()` 当前为 `currentBet > p.bet ? "fold" : "check"`，改为一律 `act(p.userId, "fold", null, seconds, now)`。离线仍由已有服务端调度处理；已全下玩家不再轮到 ACTION，不能因断线误弃全下牌。
2. `HandPlayer.allInCommitted`：在 pay 实际支付>0且支付后 stack==0 时设 true（盲注、跟注、加注均覆盖）；持久化在本手状态、view 输出；refund/payout 后保留，新手重置。避免全下立即结算的赢家 allIn=false 而漏提示。前端支持该字段，普通 allIn 语义不变。

手牌隐藏、当前下注、folded/turnDeadline 等已有字段均复用，详见 [行动效果设计](POKER_ACTION_EFFECTS_TIMEOUT.md)。准备/取消、带入、暂停、派奖和十秒自动下一手已经在源码实现，不列为“需要重做”的能力。

## 7. 验收与上线顺序

1. 先完成增量迁移与 Java durationMinutes 支持，再启用新开房表单；30–480 分钟选项正确，重试/刷新/暂停均不延长截止。
2. 开房未开局、暂停、等待人数、全员离线均能按截止关闭；正在运行的手牌能继续 ACTION/超时，结算完成后关闭且不会新发牌。
3. 结束边界与 START_HAND/自动续局/BUY_IN/PAUSE/RESUME 并发，截止前后规则一致，筹码、统计、关闭只提交一次；多实例与重启不重复结算。
4. 最后一手含弃牌、全下、主池/边池/平局/未跟注退款，流水为最终 pot，不将退回、追加混入奖额；累计统计和真实账本一致。
5. 已起身、离线、换座、退出活动者都有真实手数/带入/盈亏；所有玩家 netChips 之和在无扣费规则下为 0，总最终余额等于总带入，统计中没有遗漏的账本。
6. 当前客户端看到最后一手+10秒，迟到/重复快照不重置倒计时；刷新/重新打开直接结算，不连 WS，不加成员或筹码。
7. 结算正红+、负绿-、0 默认色，按净盈利排序，本人高亮；显示全部手数、总带入、牌局总金额、最大底池。
8. 超时免费过牌场景改为弃牌；全下立即结算的赢家也能显示 ALL IN。旧房缺历史/旧服务缺字段不伪造结果。
