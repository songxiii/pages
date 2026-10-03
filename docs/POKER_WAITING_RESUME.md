# 人数不足等待，补筹码或入座后立即恢复

核对日期：2026-10-03，依据相邻 daoleme 当前 Java 源码，未验证线上发布版本。

## 结论

**前后端都要配合，发牌时机必须由后端修改。** 前端只显示等待原因、可参局人数和补筹码入口，不发送自动 READY/START_HAND/RESUME_GAME，不把本地金额当成已到账筹码。

当前源码已经支持：

- `readyPlayers` 排除没有座位、stack<=0、活动资格失效者。
- `updateNextHand` 按有效在座资格恢复内部 ready；筹码补足后无需重新准备。
- `STAND_UP` 在手牌中立即弃牌并解除在座资格；`SIT_DOWN` 可以占座后下局参加。
- 人数少于 2 时 `WAITING_PLAYERS`；正常运行中追加筹码 pending，到本手结算后到账。

**仍不满足“立刻开始”的地方：** `PokerActivityService.updateNextHand()` 在人数恢复后设置 `startsAt=now+PokerNextHand.DELAY_SECONDS*1000`，目前 DELAY_SECONDS=10；`execute` 的 BUY_IN/SIT_DOWN 成功后只更新排期，没有在同一次事务中启动下一手。500ms 调度到截止才发牌。

## 规则边界

| 场景 | 要求 |
| --- | --- |
| 游戏未首次开始 | 沿用首次准备和房主开始，不因两人入座自动启动整场 |
| 已开始，当前手仍运行 | 正常 ACTION/起身弃牌/派奖；新增筹码或成员仅影响下一手，绝不插入当前手 |
| 手牌已完成，合格人数不足 2 | playState 仍 RUNNING，nextHand=WAITING_PLAYERS，不关闭房间、不变成 PAUSED |
| 正在 WAITING_PLAYERS，补筹码到账/新入座后恢复至少 2 人 | 服务端在确认事务中立即发下一手，不新等 10 秒、不要求准备或房主再次开始 |
| 正常手牌完成且人数充足 | 保留既有 10 秒结果展示，然后自动下一手 |
| 普通倒计时中有人起身/筹码不足 | 取消原排期，转 WAITING_PLAYERS；人数恢复时适用立即恢复规则 |
| 房主主动暂停 | 仍保持 PAUSED，补筹码或入座不能绕过暂停；由房主继续 |
| 房间到期、主动关闭、活动结束 | 结束优先，禁止恢复/发牌，完成已有手牌后最终结算 |

这里的“人数”是 **有合法座位、可用 stack>0、活动资格有效的参局人数**，不是在线人数、房间成员总数或纯落座数。pendingBuyIn 不算可用筹码。零筹码全下者仍在当前手有赢取资格，不能因不满足下一手资格就提前弃牌或结算整场。

零筹码成员可保留座位，补足后自动恢复参局承诺。已起身成员只补筹码仍为旁观，须再次落座才能参局。断线不释放座位，行动仍按服务端超时规则处理。

## Java 最小改动

复用现有 execute、readyPlayers、applyPending、updateNextHand、advanceNextHand、startHand、persistHand 和房间行锁。

1. 在更新排期前记录此前是否 `WAITING_PLAYERS`，以及 sourceHandId 是否为当前已完成手牌。
2. 先应用应到账筹码，再按同一 readyPlayers 资格函数计算最新 entrants。不足 2 继续 WAITING_PLAYERS，startsAt 清空。
3. 恢复到至少 2，且 playState=RUNNING、手牌已完成、房间未结束时：本次命令事务直接调用共用 startHand/persistHand，保存新手牌、扣盲注、设置行动截止并清理旧排期；提交后广播新手牌完整 SNAPSHOT。
4. 若仍复用 COUNTDOWN 作为内部即时排期，恢复时设置 startsAt=now，再在 **同一个事务** 执行推进，不等待下一次 500ms 扫描，也不能把这个即时排期作为新十秒倒计时推送。
5. execute 的 BUY_IN、SIT_DOWN、STAND_UP，以及 recoverPending/资格复核调度共用该恢复方法。返回本次有效的 hand 或明确状态，防止启动 H2 后 execute 尾部又 states.save(H1) 把新手牌覆盖。
6. `bump` 与 requestId 成功记录统一收口：原操作、账本、新手牌、历史记录及筹码变化在一个事务提交。重复命令返回同一结果；多个实例争抢时，房间行锁只允许一个 H2 被创建。
7. 在实际 startHand 前再次检查 now 与 endsAt/endReason/暂停/人数，不能使用旧快照或旧 startsAt 决定开局。

不要把全局 DELAY_SECONDS 改成 0：这会误删普通两手之间的十秒展示。只改变从 WAITING_PLAYERS 恢复的分支。不新增 HTTP 接口、WS 命令或第二套发牌引擎。

服务重启时继续复核已持久 WAITING_PLAYERS；若发现已经满足资格而上次事务尚未开手，则在持锁事务内同样启动一次。无需任何在线客户端触发。

## 增量快照字段

HTTP entry 和 WS SNAPSHOT 共用现有 room.nextHand，建议增加可选字段：

```json
{
  "room": {
    "playState": "RUNNING",
    "nextHand": {
      "status": "WAITING_PLAYERS",
      "sourceHandId": "H1",
      "startsAt": null,
      "eligiblePlayerCount": 1,
      "minPlayers": 2,
      "waitingReason": "NOT_ENOUGH_FUNDED_PLAYERS"
    }
  }
}
```

eligiblePlayerCount 用与 startHand 同一个资格函数计算；不要用 counts.seatedCount 替代。前端优先使用服务字段，旧服务在 roomMembers 金额齐全时兼容计算；缺字段不把未知人数冒充 0。

BUY_IN/SIT_DOWN 恢复后直接返回 H2 的运行快照：game.handId=H2、phase=preflop、nextHand=IDLE、最新手牌及本人的 legal。前端据此直接发牌展示，不需额外客户端命令。若实际尚未生成 H2，不可仅返回成功文案宣称已经开始。

## 验收

- 1 名正筹码在座 + 1 名零筹码在座：WAITING_PLAYERS；旁观者、起身者和 pending 金额不凑人数。
- 零筹码成员 BUY_IN 成功到账：同一事务生成 H2，牌号只加一次，没有额外十秒，无 READY/START_HAND。
- 起身导致只剩 1 人，合法新成员 SIT_DOWN 恢复第 2 人：立即发牌；原起身用户只带入不落座不能触发恢复。
- 3 人房间中的 1 人零筹码：另 2 人照常开始下一手；零筹码者补足后在后续手加入。
- 本手中带入仍 pending，本手结束后才到账；ALL IN 零筹码仍可获胜，发牌不能跨当前手。
- PAUSED、PAUSE_PENDING、ENDING、到期边界下补筹码不能绕过管理状态。
- 普通手间倒计时仍为原 10 秒；恢复分支不重新倒计时，刷新、重复快照不重置任何服务端时间。
- 两个并发恢复请求、重复 requestId、多个实例与重启，只生成一手且筹码守恒。
