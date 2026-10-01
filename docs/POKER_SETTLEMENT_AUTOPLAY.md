# Java 对接补充：赢家派奖与每手结束后 10 秒自动续局

核对日期：2026-10-01；页面 p.html。规则已经明确：房主只在首次开始游戏，随后每手结算展示 10 秒，由服务器自动开始下一手；原参局人员不用重新准备，房主不用再次点开始。暂停、起身、退出活动、筹码不足或有效参局人数不足时停止自动续局。

本文件核对相邻 daoleme 当前源码，公网部署仍需真实 ticket 联调。完整入口与 WS 协议沿用 [ACTIVITY_POKER_API.md](ACTIVITY_POKER_API.md)，不新增 HTTP 接口，不新增客户端“下一手”命令。

## 1. 已有字段与缺口

| 内容 | 当前 Java 源码 | 本次前端 |
| --- | --- | --- |
| 赢家 | PokerHand.result.winners 为真实零基座位数组 | 赢家座位显示“获胜”、头像高亮，中央显示赢家昵称 |
| 底池 | game.pot，complete 时是扣除未跟注退回后的 finalPot | 底池筹码飞向赢家；金额和余额不在前端计算入账 |
| 成员当前筹码 | roomMembers.stack 已提供且 persistHand 写回 | 菜单显示当前筹码，结算/带入随快照同步 |
| 各赢家实得金额 | 只有赢家数组，没有每人分池金额 | 单赢家复用 pot；多赢家只标记获胜，不把 pot 平均分配 |
| 下一手 | startHand 可复用，但 persistHand 每次写 ready=false；当前调度只处理行动超时等 | 已接入下面的 room.nextHand；倒计时到零等待新快照，不发 READY/START_HAND |
| 准备、带入、暂停、继续 | 最新业务及视图已加入 UNREADY/BUY_IN/PAUSE_GAME/RESUME_GAME、playState、buyIn 等 | 沿用现有命令与授权，仍须部署验收 |

因此后端本轮主要补：**result.payouts、result.settledAt，以及 room.nextHand 的持久化倒计时、自动参局资格延续和定时开手**。不是要求重做已有结算引擎。

## 2. 在现有 result 内增加派奖明细

保留现有 winners/message/hands 和 game.pot 的意义：

```json
{
  "game": {
    "handId": "A123-H8",
    "handNumber": 8,
    "phase": "complete",
    "pot": 300,
    "result": {
      "winners": [0, 4],
      "message": "小明、小红分获底池",
      "hands": ["同花", null, "一对"],
      "settledAt": "2026-10-01T04:00:00.000Z",
      "payouts": [
        {"userId": "u0", "seatIndex": 0, "amount": 200},
        {"userId": "u4", "seatIndex": 4, "amount": 100}
      ]
    }
  }
}
```

此片段省略 game.players 等已有字段。正式 hands 的数组长度和顺序仍与 players 对应。payouts 建议按 userId 聚合每人从所有主池、边池得到的总额，每人一条；userId 为字符串，seatIndex 为本手座位，amount 为正的安全整数。前端也兼容同一人分多条金额并聚合。

实现复用 PokerHand.settle 的每个分池支付循环：每次实际 `p.stack += share` 时，把相同 share 累加到该用户的 payout；包括现有余筹码按庄位后顺序分配的实际结果。不得在 view 中拿总底池平均分给 winners。all-in 赢家、边池赢家、平局都使用实际支付值。

- `sum(payouts.amount) == finalPot`，每人余额确实增加对应金额。
- 未跟注退回 top.stack 的 refund 不属于赢得底池，不混入 payouts/winners；有需要可另传 refunds，当前前端不依赖它。
- settledAt 为服务器首次完成结算的 UTC 时间，持久化在现有加密牌局状态，重连或生成视图不能重置。
- 不把延迟带入到账混入 payout。成员 stack 是完成分池、退回和待到账后的实际余额；获胜 +金额只表示底池奖额，不表示净盈利。
- 本人/对手底牌继续按现有收件人视图隐藏：弃牌结束不公开他人牌，摊牌只提供允许公开的牌。

前端复用旧协议：只有一名赢家且没有 payouts 时，用当前 Java 的 finalPot 作为获奖金额；多赢家没有明细时仍显示每个赢家并播放示意筹码，但不展示猜测的分配金额。只有观察到运行中的同一手转为 complete 时才播放派奖，重复快照/重连不重播。筹码数量是视觉效果，不代表币值单位；真正入账以 Java 快照为准。

## 3. 下一手快照字段

入口、建房返回与完整 SNAPSHOT 的 room 中增加：

```json
{
  "serverTime": "2026-10-01T04:00:00.000Z",
  "room": {
    "playState": "RUNNING",
    "nextHand": {
      "status": "COUNTDOWN",
      "delaySeconds": 10,
      "sourceHandId": "A123-H8",
      "startsAt": "2026-10-01T04:00:10.000Z"
    }
  }
}
```

| status | 含义 | startsAt |
| --- | --- | --- |
| IDLE | 首次未开局或一手正在进行中 | null |
| COUNTDOWN | 本手结束，下一手已排期 | 服务器截止时间 |
| WAITING_PLAYERS | 已开始的游戏缺至少两名可继续参局人员 | null |
| PAUSED | 暂停，禁止自动续局 | null |

sourceHandId 是本次倒计时对应的刚完成手牌；没有上一手时可 null。时间用 UTC ISO-8601，serverTime 每次生成快照时返回服务器当前时间。浏览器用绝对截止时间减服务器当前时间倒计时，重复快照、重连、新用户进入不会重新开始 10 秒。

倒计时结束前保持 game.phase=complete、result 和公共牌，便于观看胜负；倒计时结束后广播新 handId 的 preflop 快照并把 nextHand.status=IDLE。起身/换座不影响历史结算的 userId，不能把旧赢家派奖到新占座用户；成员座位列表仍是当前真实位置。

没有 nextHand 的旧服务只能展示结算 10 秒，然后提示等待服务端开启下一手，**不能完成自动续局**。当前前端不会到零假发牌、伪造准备或反复发送 START_HAND；部署后端这部分是实现用户要求的必要步骤。

## 4. 继续参局资格：只需首次准备/开始

复用现有 ready 与本手 participants，避免增加一套需要客户端再次操作的准备流程：

1. 首次仍按现有规则落座、准备，房主 START_HAND；进入 RUNNING。READY 表示加入本次连续游戏。
2. 运行中准备按钮隐藏，继续沿用现有参局和 ACTION 验证。
3. 本手结算时，先写回游戏筹码并应用待到账带入。**仅在首次完成本手结算的事务**中，把本手玩家中仍有有效座位、活动资格和正筹码的人设 ready=true；其他成员已经显式 READY 的状态保留。这样不用再次准备即可参加下一手。
4. 保留起身、UNREADY 在两手之间的权限：UNREADY 代表退出自动参局，STAND_UP 代表起身。取消后不能被重复的 complete 视图/恢复扫描再次自动设回 true；只有下一次明确 READY 才重新加入。
5. 没有参过局的新落座者仍需首次 READY 加入连续游戏。离开活动、起身、筹码耗尽的用户不自动加入下一手；筹码到账后主动 READY 可以重新加入。筹码不足的人不阻止其他两名合格玩家继续。
6. 在线与否不改变已承诺的参局资格，沿用现有断线和行动超时策略；不得为了自动续局在前端替用户发送 READY。

当前 persistHand 中 `seat.ready=false` 是每手结束后必须重新准备的直接原因，需要区分“运行中清理准备显示”和“首次结算恢复继续参局资格”。不要在每次 complete 读取、补到账或 scheduler 扫描时再次写 ready=true。

## 5. 复用结算事务和开手逻辑

### 5.1 结算边界

对房间加数据库行锁，原子完成：

1. 分配全部主池/边池、退回未跟注金额，记录 payouts/settledAt；写回筹码账本。
2. 应用全房间待到账 BUY_IN，更新 totalBuyIn/pendingBuyIn 与流水。
3. 按第 4 节一次性延续本手玩家参局资格。
4. 若 playState=PAUSE_PENDING，改 PAUSED，nextHand=PAUSED、清空 startsAt；若房间关闭或活动结束也取消续局，安全结束。
5. RUNNING 且可继续玩家至少两人：nextHand=COUNTDOWN，startsAt=settledAt+10秒，sourceHandId=本手ID。否则 WAITING_PLAYERS。
6. 写加密牌局和 room 调度字段，递增 revision，事务提交后完整 SNAPSHOT。**这个快照必须先于下一手**，不能连发 complete/preflop 跳过展示。

### 5.2 持久调度

建议在现有 poker_room 增加或等价持久化：next_hand_status（默认 IDLE）、next_hand_at（UTC datetime(3)，可空）、next_hand_source_id（可空）。next_hand_at 建索引。仍使用现有 play_state、房间行锁、event_seq 与 PokerActivityStateRepository 保存的牌局。

扩展 PokerActivityTimeoutScheduler（当前已每 500ms 扫描行动超时）增加到期下一手扫描，不依赖任何客户端在线。每个房间进入事务后重新验证：

- 活动未结束、房间未关闭；playState=RUNNING。
- nextHand=COUNTDOWN，startsAt<=now，sourceHandId 等于当前已完成的 handId，没有运行中手牌。
- 最新 eligible + seated + stack>0 + ready=true 人数至少两人。

满足时复用现有 startHand(room, ledger, previous, now) 的校验、庄位轮转、洗牌、发牌及 persistHand。新手保存与清除倒计时必须同一事务完成：nextHand=IDLE、startsAt=null；递增 revision 并广播新快照。只开始一手，不在截止时发送一堆客户端指令。

多人、多实例及重复扫描均共享房间行锁与 sourceHandId 条件；胜出的事务清除原排期并生成唯一新 handId，后续扫描看到 IDLE/运行中手牌就退出。服务器重启读持久截止，过期排期验证后立即处理，不再重置 10 秒。

### 5.3 倒计时中的变化

- UNREADY、STAND_UP、活动退出等导致合格人数不足：立即取消排期，返回 WAITING_PLAYERS。再次满足两名合格玩家后重新排期 10 秒；不要求房主重新开始。
- 原排期内正常头像、连接、带入或其他不影响人数的变化，不延长 startsAt。
- 两手之间 PAUSE_GAME：立即 PAUSED 并取消排期。手牌中申请暂停仍等本手结算；不能把下注动作冻结。
- RESUME_GAME：房主恢复连续游戏，合格人数满足后设置 RUNNING+COUNTDOWN、安排 10 秒，不要求重做准备。此处将“立即发下一手”改为“恢复排期”，复用同一自动开手入口。
- START_HAND 只用于首次开始；已经处于自动连续游戏时，旧客户端再次提交应返回 AUTO_CONTINUE_ACTIVE 或 NEXT_HAND_COUNTDOWN。不能跳过 10 秒展示。
- 行动超时、自动续局、手动暂停/继续、带入、起身串行化。关闭房间与活动结束优先安全结算并补到账，然后取消全部排期。

## 6. 验收用例

1. 初次两人准备并开始后，玩完一手：清楚显示赢家、奖额、派奖动画，10 秒后服务端出现新 handId。双方没有再发 READY/START_HAND。
2. 赢家为他人、本人、多人平局、不同边池赢家均正确；奖额与服务器实际付款一致，分池金额不被平均猜测。
3. 弃牌结束只飞底池奖额，未跟注退回不算赢家奖额、不公开弃牌方底牌；延迟带入不算奖额。
4. 相同 complete 的多次 SNAPSHOT、不同行为更新或重连，不重复动画/支付、不重置截止；入场看到完成快照只显示结果。
5. 10 秒内暂停、起身、取消参局或活动结束，自动续局及时停止。重新满足人数/恢复后新排期正常。
6. READY 与 startHand 并发、下一手扫描与暂停并发、多实例与服务器重启都不重复发牌；无需任何客户端保持在线。
7. 当后端未实现 nextHand 时，前端结算展示后保持当前局面并明确等待服务端，不能声称自动续局已完成。
8. 320–540px 竖屏、2–9 人，五张大数字/花色公共牌、赢家/10 秒提示与操作区保持一屏，成员菜单正确展示当前筹码、累计带入和盈亏。
