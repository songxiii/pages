# 开局后管理、起身弃牌与下局加入

本文件保留上一轮实现设计；当前 Java 已落地主动关闭、本手起身、中途落座及自动后续参局。后续补充：[人数不足等待与立即恢复](POKER_WAITING_RESUME.md)，人数恢复后不再增加十秒等待，以该规则为准。

核对日期：2026-10-03。依据相邻 `daoleme/src/main/java/THPoker` 当前源码，不代表线上已部署。前端保留服务端授权：没有对应 `allowedCommands` 时说明原因，不伪造成功。

## 1. 现状与复用结论

| 能力 | 当前 Java 源码 | 所需工作 |
| --- | --- | --- |
| 开局后暂停 | `execute(PAUSE_GAME)` 位于运行手牌限制前，`PokerRoomViewService` 在 `playState=RUNNING` 时授权房主 | 已支持。保留 `{afterCurrentHand:true}`；本手完成后 PAUSED，不提前终止手牌 |
| 主动关闭游戏 | 已实现 CLOSE_GAME / HOST_CLOSED | 复用结束屏障与最终报告 |
| 本手中起身 | STAND_UP / withdraw 已实现 | 复用事务内弃牌与释放资格 |
| 中途落座，下局参局 | SIT_DOWN / 保留座与后续参局资格已实现 | 复用合法空座与下一手承诺 |
| 开始后的准备状态 | 已按有效在座资格延续内部 ready，开始后拒绝 READY/UNREADY | 复用，无需再次准备 |
| 时长与最终统计、10 秒最终结算 | 已有 RoomSettings.durationMinutes、PokerRoomTiming、requestEndOrFinalize、accumulate、freezeSettlement | 直接复用；本次无需重做，也无需新建结算接口 |
| 超时动作、ALL IN | 当前 timeout 一律 fold；allInCommitted 已落地 | 2026-10-07 超时策略需按 [新设计](POKER_ACTION_EFFECTS_TIMEOUT.md) 改为免费过牌，否则弃牌；ALL IN 复用 |

HTTP entry、rooms、原 WS 地址、requestId 去重、房间行锁、账本、加密手牌持久化及广播全部复用。暂停功能源码已支持；如果线上按钮仍灰，核对系统版本、房主身份、playState、timing 与 allowedCommands，不能仅凭前端截图认定服务端没有暂停实现。

## 2. 准备仅用于首次启动

- `room.playState=WAITING && hand==null`：保留 READY/UNREADY 和至少两名合格已准备者的现有首次开局验证。
- 首次开始后，RUNNING/PAUSE_PENDING/PAUSED/等待人数/十秒续局期间均不再给 READY、UNREADY、START_HAND 授权。房主仍可 PAUSE_GAME、RESUME_GAME，未结束时可 CLOSE_GAME。
- 内部 `seat.ready` 可作为“继续参加后续手牌”的承诺，复用 readyPlayers、startHand、updateNextHand；无需另建报名服务。新落座与筹码恢复的处理也必须为该承诺赋值，否则前端隐藏准备后新成员永远不会进入下一手。
- 推荐 `room.hasStarted = hand != null`，无需新增数据库列；前端兼容 game/playState 推断。成员不要在开局后的视图继续返回 READY；使用下述 participation 字段区分是否参加当前手。

## 3. 本手中起身：单条 STAND_UP 原子操作

沿用请求：

```json
{"type":"STAND_UP","requestId":"唯一请求号","payload":{}}
```

前端用自己的确认框说明立即放弃本手、已下注留在底池。只发送 STAND_UP，**不能先发 ACTION/fold 再起身**：普通 ACTION 只允许当前行动者，两个请求也不能保证原子性。

在 execute 的房间行锁与原事务内：

1. 复核身份、在座状态、requestId。获取 hand.player(userId)。本手没有该成员（仅等下一手）时直接取消下局资格、起身；已弃牌者不重复弃牌。
2. 本手仍进行且该人未弃牌时调用新的领域方法 `withdraw(userId, seconds, now)`，将 folded=true，保留 bet、contribution、hole 与本手身份。包含已 ALL IN 的人：其已支付筹码成为不可赢取的底池贡献，不返还；由同一个结算引擎处理主池/边池与退回，不得另建算法。
3. withdraw 允许非当前行动者。若起身者是当前行动人，按原 advance 流程寻找下一位并设新截止；若是非当前行动人且其他人仍需行动，**保留原 turn 和 deadline**，不能跳过当前玩家或延长他的时间。若只剩一名未弃牌者，立即复用 settle(false)；若没有需要行动者，则复用原公牌推进/摊牌逻辑。
4. 设 ledger.seatNo=null、status=STANDING、ready=false、stoodUpAt；持久 hand 与座位，再复用 persistHand 的首次结算分支。账本不删除、不清空，已支付筹码不退；待到账仍在正常结算边界应用。
5. 本手 players 列表保持原参局者，以 userId 写回余额/累计手数，包括已经起身的人。起身不能导致结算漏人，也不能再次自动 ready。
6. 递增 revision，保存去重记录，提交后广播完整 SNAPSHOT。self.seatIndex=null，self.roomState=STANDING；game.players 中对应人 folded=true，所有其他人的私牌规则不变。

**座位隔离：** 当前手牌所有 game.players 的 seatIndex 到结算前都保留为占用，包括已起身者。可在手牌投影派生“本手保留座”，不必新增座位表。该人在本手结束前不得再次 SIT_DOWN（防止同一 userId 的新筹码/资格被 persistHand 的旧手牌写回覆盖）。本手结束后释放保留，按真实 ledger 空座重新落座；新座位不能继承旧底牌、下注或赢家状态。

领域验收覆盖最后一位有可用筹码者起身、非当前人全下后起身、边池中某层所有候选人退出：沿用原已投入筹码守恒与未匹配投入退回规则，保证不会出现空 winner 列表、负余额、遗漏底池。如引擎目前不支持这些边界，先补领域规则和测试，再授权本手 STAND_UP，不能只改命令白名单。

## 4. 中途加入：占座现在生效，参局下一手生效

沿用 `SIT_DOWN`：自主选座 payload 为 `{seatIndex:3}`，随机落座仍为 `{}`，不能恢复为前端固定座号。

- 将 SIT_DOWN 分支移到运行手牌限制之前。空座候选为 **ledger 实际占座与本手保留座的并集之外**；房间行锁保证并发选同一座只有一人成功。禁止到期/主动结束时新加入。
- 只更新永久座位账本，不改当前 game.players、dealer、盲位、turn、deadline、底池、当前手私牌和牌堆。没有向新成员发当前手牌的操作。
- 若首次游戏尚未开始：保留 ready=false，由本人准备。
- 若已经开始：有可用筹码时设置内部 ready=true 作为下局承诺；无筹码时等待 BUY_IN 完成。本局 pendingBuyIn 到账后，同样补回“在座且有筹码且活动资格有效”的后续参局承诺。已起身者不能因此恢复。
- 自动续局在结算后复用 applyPending、readyPlayers、updateNextHand、startHand，取最新承诺成员。新成员无需 READY/START_HAND；人数不足仍 WAITING_PLAYERS，恢复至少两人后立即发下一手；正常结算后人数充足仍保留原十秒展示。
- PAUSED 期间可落座并保留后续承诺，由房主 RESUME_GAME 后开始；PAUSE_PENDING 下新加入不能绕过暂停。

在 self、roomMembers、seats 增量投影：

```json
{
  "self":{"userId":"u3","seatIndex":3,"roomState":"SEATED","participation":"WAITING_NEXT_HAND","allowedCommands":["STAND_UP","BUY_IN"]},
  "roomMembers":[{"userId":"u3","seatIndex":3,"state":"SEATED","participation":"WAITING_NEXT_HAND","ready":true,"stack":200}]
}
```

participation 枚举：WATCHING（未落座）、WAITING_NEXT_HAND（已落座待参局）、IN_HAND（本手参局未弃牌）、FOLDED（本手已弃牌）。内部 ready 不是页面准备状态。该字段可由最新手牌用户身份和 ledger 推导，必要时复用 ready 表示下局承诺；无需新增独立队列表。

前端当前手没有该 userId 时兼容推断“下局加入”；手牌完成后最好明确给 WAITING_NEXT_HAND，避免原手牌快照与新座位混淆。新手确实包含该 userId 后切换 IN_HAND，发牌动画仅给真正 entrants。起身者为 WATCHING，旧手牌参局记录继续保留 folded=true。

## 5. 关闭游戏：复用到期结束屏障

新增 WS 意图：

```json
{"type":"CLOSE_GAME","requestId":"唯一请求号","payload":{"afterCurrentHand":true}}
```

- 加入 execute 白名单，只允许真实活动创建人且固定 room.hostUserId 匹配。沿用 requireCreator，不能信任客户端 role。视图只向对应房主增加 CLOSE_GAME 授权。
- 运行手牌时记录 `room.endReason=HOST_CLOSED`，立即取消续局排期；复用 requestEndOrFinalize。timing.status=ENDING，当前 game/legal/turnDeadline 保留，ACTION、超时继续执行；不提前 CLOSED、不强行派奖。
- 没有运行手牌，包括 PAUSED、十秒续局、等待人数、未首次开始：直接复用结束事务 applyPending/freezeSettlement/CLOSED。
- 完成最后一手后，复用 settlementCommitted/accumulate/最终报告，showAt=endedAt+10 秒。完整最终 SNAPSHOT/ROOM_CLOSED 及 HTTP entry 直接结算语义不变。
- 主动关闭优先于暂停、继续、开始下一手和带入。保留原 endsAt，不靠修改活动状态或倒计时时间模拟关闭；PokerRoomTiming.reason 已优先返回持久 endReason，可直接复用。
- 重复 CLOSE_GAME 应在 CLOSED 检查前核对成功 requestId，使网络重试能返回原结果/最终快照，不能在第一次已成功后只返回 UNKNOWN_COMMAND 或 ROOM_CLOSED；不同 ID 的重复关闭也不能再次冻结报告/派奖。

## 6. 上线验收

1. 房主运行手可以暂停，PAUSE_PENDING 下仍能 ACTION；完成后 PAUSED。普通成员不可暂停/关闭。
2. CLOSE_GAME 在运行手、暂停、倒计时和零手房间正确复用结束事务；当前手完整结算，无下一手，十秒后最终报告；刷新立即最终报告。
3. 当前/非当前/已弃牌/ALL IN 玩家起身；立刻取消当前手赢取资格，原 turn 截止处理正确，账本和底池守恒，其他人私牌不公开。
4. 起身释放资格但保留本手位置，新成员只能选真正可用空座；重新落座旧 userId 不会被旧手写回覆盖。
5. 运行中落座只显示头像昵称和“下局加入”，不领取牌、不扣盲注；下一手自动参局，开始后全程不再显示准备按钮或准备徽章。
6. 新成员待到账/筹码不足、暂停后加入、缺人后恢复、到期边界、服务重启、多实例、重复 requestId 均无重复扣筹码或发牌。
