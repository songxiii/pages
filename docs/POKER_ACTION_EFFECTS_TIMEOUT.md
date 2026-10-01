# 手牌遮挡、行动特效与离线超时弃牌

2026-10-02 时长、最终结算及之前剩余项的统一交付清单见 [POKER_BACKEND_CAPABILITIES.md](POKER_BACKEND_CAPABILITIES.md)，本轮请优先使用该文档。

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

## 必须调整：超时一律弃牌，在线和离线相同

现有 `PokerActivityTimeoutScheduler.scan()` 每 500ms 扫描持久化截止时间，调用 `PokerActivityService.timeout()`；该服务加房间行锁、读取手牌并持久化结果，不依赖 WebSocket 在线人数。因此断线、关闭浏览器、所有客户端退出后，调度仍能处理超时。

但 `THPoker/domain/PokerHand.java` 的 `timeout(int seconds, long now)` 当前调用：

```java
act(p.userId, currentBet > p.bet ? "fold" : "check", null, seconds, now);
```

这表示需要跟注才弃牌、免费行动则自动过牌，与最新要求不符。保留现有运行中/turn/截止条件，把该调用改为：

```java
act(p.userId, "fold", null, seconds, now);
```

继续复用 `act()` 的行动推进、单赢家结算、主池/边池分配及之后的 10 秒续局流程。现有 legal 已允许免费行动时主动 fold，无需新增 ACTION 类型。不要在浏览器到零时替玩家提交 ACTION，也不要在断线瞬间弃牌；到服务端行动截止时才弃牌。已全下且无须再行动的玩家不应成为 turn，不得因断线而弃掉已全下的手牌。

原有数据库行锁与事务继续串行化手动行动和超时，避免并发重复结算。请更新原先期望“超时过牌”的 Java 测试。

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

1. 在线、离线、全员离线时，轮到玩家且 deadline 到期：有跟注额/没有跟注额均只弃牌一次。
2. 截止前断线不立即弃牌；重连看到同一个截止时间。已全下玩家无行动截止，不被误弃牌。
3. 手动行动与超时并发，只推进一次；剩一人时底池正确结算，接入现有自动续局。
4. 弃牌结束不公开对手底牌；摊牌时只公开未弃牌者。后端必须继续按 recipient 返回牌背，前端防护不替代服务端隐藏。
5. 全下立即结算的赢家也返回 allInCommitted=true；后续重复快照保留提示，新 handId 清除。
6. 2–9 人、320–540px 竖屏，手牌完整可见，D/SB/BB 不与牌面重叠；下注额、红色最后 10 秒与操作区一屏显示。
