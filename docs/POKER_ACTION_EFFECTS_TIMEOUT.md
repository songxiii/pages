# 手牌遮挡、行动特效与超时动作

2026-10-07 最新超时规则：可过牌时自动过牌，需要跟注时自动弃牌。本次已调整前端计时圈，Java 超时策略仍需调整。时长、最终结算等其他能力见 [POKER_BACKEND_CAPABILITIES.md](POKER_BACKEND_CAPABILITIES.md)。

核对日期：2026-10-01。核对相邻 `daoleme` 当前 Java 源码；部署是否包含这些变更仍需真实房间联调。沿用活动 v1 WebSocket 与完整 SNAPSHOT，不新增 HTTP 接口或客户端超时命令。

## 已有字段直接复用

| 功能 | 现有字段 | 前端处理 |
| --- | --- | --- |
| 本轮下注金额 | `game.players[].bet` | 在玩家朝向牌桌的一侧显示；这是本轮累计投入，换下注轮后清零，结算后隐藏 |
| 弃牌 | `game.players[].folded` | 弃牌时收牌、闪烁边框；后续快照保留已弃牌状态，不重复播放收牌 |
| 全下 | `game.players[].allIn` | ALL IN 发光文字与头像边框；同一手已观察到的全下状态保留至结算 |
| 行动倒计时 | `game.turnDeadline`、`serverTime`、`settings.turnSeconds` | 按服务端截止时间倒计时，最后 10 秒红色心跳提示；本机时钟偏差不影响读数 |
| 底牌可见性 | `players[].hole`、`result.hands`、`folded` | 本人可看自己的牌；对手仅摊牌且未弃牌时显示；弃牌对手即使收到错误明牌也只渲染牌背 |

手牌向上覆盖头像，D/SB/BB 标记移入昵称信息框，避免遮挡牌面。两手之间仍由已实现的服务端 `room.nextHand` 排期自动继续。

## 必须调整：可过牌时超时过牌，否则弃牌

核对日期：2026-10-07。当前相邻 `daoleme` 的 `PokerHand.timeout()` 实际调用 `act(p.userId, "fold", null, seconds, now, "TIMEOUT")`，有测试 `timeoutAlwaysFoldsIncludingFreeCheck` 固定了免费行动也弃牌的旧策略。因此自动过牌需要后端改，前端仅调整计时圈不能改变服务端结算。本仓库未修改或部署相邻 Java 后端。

保留现有 running/turn/deadline 条件，将该方法改为：

```java
public void timeout(int seconds, long now) {
  if (running() && turn != null && deadline <= now) {
    HandPlayer p = playerAt(turn);
    act(p.userId, currentBet > p.bet ? "fold" : "check", null, seconds, now, "TIMEOUT");
  }
}
```

判断使用**截止时当前权威下注状态**，与 `view()` 中 `canCheck = toCall == 0` 保持一致；不能信任浏览器发来的 canCheck。无需补筹码才允许 check；需要跟注则 fold，不自动跟注、不额外扣筹码。保留 source=TIMEOUT，历史中记真实 CHECK/FOLD 动作及超时来源。

现有 `PokerActivityTimeoutScheduler.scan()` 每 500ms 扫描持久化截止时间，调用持房间行锁的 `PokerActivityService.timeout()`，不依赖 WebSocket 在线人数。继续复用这些调度、事务、act() 的换轮、结算、续局及 SNAPSHOT 广播。在线、离线、关闭浏览器、全员离线均按同一规则处理；截止前断线不能提前行动。已全下且无需行动者不在 turn 中，不误过牌或弃牌。

更新旧 Java 测试：需要跟注时超时只弃牌一次；免费行动时超时过牌、不标 folded、不扣筹码并正常换人或换街；未到截止不改变状态；重复扫描/手动动作并发不重复推进。服务重启、断线、历史 TIMEOUT 来源和相应 SNAPSHOT 一并验收。新策略可能让连续无人操作的免费轮次继续过牌，这是本次规则的预期结果。

### 前端计时圈（已实现）

- 本人当前可过牌时，中间“过牌”按钮周边显示递减进度圈及剩余秒数，弃牌按钮隐藏计时圈。
- 需要跟注时，中间显示跟注金额，左侧红色“弃牌”按钮显示计时圈；不会暗示超时自动跟注。
- 进度圈从顶部中间开始顺时针减少，与头像共用 serverTime/turnDeadline/turnSeconds，快照刷新不重置时间。提交后、旁观、轮到他人和结算时隐藏；断线仍显示已知剩余时间。
- 到零只禁用操作并等待服务端，不发送自动 CHECK/FOLD。这样避免多个页面重复动作和网络延迟竞态。前端计时圈已通过模拟服务验证，后端新策略仍需实现并上线联调。

## 补一个字段：全下后立即结算也能明确显示

当前 `PokerHand.view()` 的 `allIn` 使用 `p.stack == 0`。当全下立即触发跑牌和结算，赢家余额在同一次事务内加回，广播时 `allIn=false`；浏览器没有机会观察到全下状态，会漏掉赢家的 ALL IN 提示。

在现有 `HandPlayer` 和 `game.players[]` 增加可选布尔字段 `allInCommitted`，表示“本手曾投入所有可用筹码”。前端已经兼容这个字段：

```json
{
  "userId": "123",
  "seatIndex": 0,
  "stack": 400,
  "bet": 200,
  "folded": false,
  "allIn": false,
  "allInCommitted": true
}
```

在实际扣筹码的 `pay()` 中，仅当本次实际支付大于零且支付后 stack 为零时设置 `allInCommitted=true`，包括短筹码盲注、跟注和加注。退回未跟注筹码或派奖不能清除此字段；持久化在本手加密状态，新手新建 HandPlayer 时重置 false。`allIn` 继续表达现有行动能力，不改变 legal 判断。完整快照可复用，不需要额外事件或推断奖额。

## 验收

1. 在线、离线、全员离线时，轮到玩家且 deadline 到期：有跟注额则弃牌、没有跟注额则过牌，均只执行一次。
2. 截止前断线不立即弃牌；重连看到同一个截止时间。已全下玩家无行动截止，不被误弃牌。
3. 手动行动与超时并发，只推进一次；剩一人时底池正确结算，接入现有自动续局。
4. 弃牌结束不公开对手底牌；摊牌时只公开未弃牌者。后端必须继续按 recipient 返回牌背，前端防护不替代服务端隐藏。
5. 全下立即结算的赢家也返回 allInCommitted=true；后续重复快照保留提示，新 handId 清除。
6. 2–9 人、320–540px 竖屏，手牌完整可见，D/SB/BB 不与牌面重叠；下注额、红色最后 10 秒与操作区一屏显示。
