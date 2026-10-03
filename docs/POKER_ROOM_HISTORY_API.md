# 房间历史牌局接口与持久化设计

核对日期：2026-10-03；依据相邻 `daoleme/src/main/java/THPoker` 当前源码和 `poker_full_schema.sql`。本仓库已完成前端入口、历史面板及模拟接口验证；下面的 Java 接口和历史写入仍需后端实现，未验证线上数据库或真实服务。

## 1. 是否需要改数据库

**已有完整 poker 表时，不需要新增表、字段或迁移。** 复用：

| 表 | 用途 |
| --- | --- |
| poker_hand | 房间内手数、时间、庄位、盲位、公牌、底池、结算状态 |
| poker_hand_player | 本手参赛者、初始筹码、投入、退款、派奖、加密底牌、公开时间、牌型 |
| poker_action | 每手按 action_no 排序的贴盲、下注、弃牌、超时和退款流水 |
| poker_pot / poker_pot_award | 现有分池与实际派奖，沿用主池/边池规则 |
| poker_room_seat / poker_room_member | 用户身份及访问历史资格，起身、离线后仍保留 |

需要先确认部署库已有这些表，不能仅凭建表脚本判断线上存在。`poker_activity_state` 每个房间只有一条密文，`save()` 使用 ON DUPLICATE KEY UPDATE 覆盖；当前服务没有 `poker_hand/poker_hand_player/poker_action` 的 Repository 和写入逻辑。`PokerRoomEventRepository` 目前只写 MEMBER_ENTERED，成功命令去重记录也不是完整动作账本，均不能直接查询出所有历史牌局。

所以本次是**补 Java 写入和查询代码**，无需改现有完整表结构。开始持久化以前丢失的手牌不能从最新密文、累计手数、筹码差额恢复。旧房只展示实际保存的手牌，标记 PARTIAL；新房从第一手完整记录，标记 COMPLETE。

## 2. 前端已接入的接口

新增一个只读 HTTP 接口：`POST /api/poker/v1/rooms/history`。复用现有 `PokerApiResponse` 外层、Bearer 身份、ticket 校验、异常格式及 CORS；无需新增 WebSocket 命令。

```http
POST /api/poker/v1/rooms/history
Authorization: Bearer <当前账号 access token>
Content-Type: application/json
```

首次打开或刷新最新牌局：

```json
{ "ticket": "原活动ticket", "roomId": "A123" }
```

查询选定牌局：

```json
{
  "ticket": "原活动ticket",
  "roomId": "A123",
  "handNumber": 4,
  "throughHandNumber": 6
}
```

- `roomId` 使用现有前端 room.roomId，即对外 room_code，不是数据库内部主键；必须与 ticket 对应的房间一致。
- `handNumber` 可选正整数，省略选择最近一手已 SETTLED 的记录；明确指定但不存在/未结算，返回 404，不能静默换成另一手。
- `throughHandNumber` 可选正整数。第一次省略时由服务端取该房间最后一手已结算 hand_no，作为这一轮浏览的固定上界；后续切换必须带回它。请求手数不能超过上界。上界只限制集合，不赋予任何身份权限。
- 只返回一手详情和导航元数据，避免一次下发几百手所有动作。总数及前后导航来自同一固定范围内实际保存的 SETTLED 记录。
- 响应头 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`；ticket、token 不放 URL。

完整响应示例（虚拟筹码仍用现有整数单位，不引入现金换算）：

```json
{
  "code": 0,
  "message": "success",
  "systemVersion": "20261003180000",
  "data": {
    "roomId": "A123",
    "throughHandNumber": 6,
    "totalHands": 6,
    "position": 4,
    "firstHandNumber": 1,
    "lastHandNumber": 6,
    "previousHandNumber": 3,
    "nextHandNumber": 5,
    "coverage": { "status": "COMPLETE", "message": null },
    "hand": {
      "handId": "A123-H4",
      "handNumber": 4,
      "startedAt": "2026-10-03T05:55:00.000Z",
      "settledAt": "2026-10-03T05:56:00.000Z",
      "smallBlind": 1,
      "bigBlind": 2,
      "pot": 8,
      "board": ["2d", "5c", "6h", "8c", "2h"],
      "players": [
        {
          "userId": "1",
          "nickname": "本人",
          "avatarUrl": "https://example.com/1.jpg",
          "position": "BB",
          "holeCards": ["Qh", "8d"],
          "holeCardsRevealed": true,
          "handName": "两对",
          "folded": false,
          "netChips": 4,
          "actions": [
            { "sequence": 2, "street": "PREFLOP", "type": "POST_BIG_BLIND", "amount": 2, "streetTotalAfter": 2, "source": "SYSTEM" },
            { "sequence": 4, "street": "PREFLOP", "type": "CHECK", "amount": 0, "streetTotalAfter": 2, "source": "CLIENT_WS" },
            { "sequence": 5, "street": "FLOP", "type": "CHECK", "amount": 0, "streetTotalAfter": 0, "source": "CLIENT_WS" },
            { "sequence": 7, "street": "TURN", "type": "BET", "amount": 2, "streetTotalAfter": 2, "source": "CLIENT_WS" },
            { "sequence": 9, "street": "RIVER", "type": "CHECK", "amount": 0, "streetTotalAfter": 0, "source": "CLIENT_WS" }
          ]
        },
        {
          "userId": "2",
          "nickname": "对手",
          "avatarUrl": null,
          "position": "D/SB",
          "holeCards": ["Ks", "9h"],
          "holeCardsRevealed": true,
          "handName": "一对",
          "folded": false,
          "netChips": -4,
          "actions": [
            { "sequence": 1, "street": "PREFLOP", "type": "POST_SMALL_BLIND", "amount": 1, "streetTotalAfter": 1, "source": "SYSTEM" },
            { "sequence": 3, "street": "PREFLOP", "type": "CALL", "amount": 1, "streetTotalAfter": 2, "source": "CLIENT_WS" },
            { "sequence": 6, "street": "FLOP", "type": "CHECK", "amount": 0, "streetTotalAfter": 0, "source": "CLIENT_WS" },
            { "sequence": 8, "street": "TURN", "type": "CALL", "amount": 2, "streetTotalAfter": 2, "source": "CLIENT_WS" },
            { "sequence": 10, "street": "RIVER", "type": "CHECK", "amount": 0, "streetTotalAfter": 0, "source": "CLIENT_WS" }
          ]
        }
      ]
    }
  }
}
```

这是**整个房间**的历史：包括本人未参局的手和已起身/退出成员曾参与的手，不按当前 roomMembers 筛选，也不只查本人参赛记录。玩家按本手真实座位排列；人数 2–9，`userId/handId/roomId` 为字符串，金额、手数、序号均为 JS 安全整数。时间采用带时区 ISO-8601。

### 2.1 字段定义

- `totalHands`：固定范围内实际已保存、已结算的记录数，不取 lastHandNo 或当前全场累计统计冒充记录数。
- `position`：当前手在可查询记录按 hand_no 升序排列后的 1 基序号，不直接使用 handNumber。例如仅保存第 100、102 手，查看第 102 手应为 `2 / 2`，previousHandNumber=100。
- first/last 是此范围内最早/最近实际记录手数；previous/next 是邻近实际记录，不用 handNumber±1，第一/末手对应 null。
- `handId`：复用现有活动 v1 标识 `room_code + "-H" + hand_no`；内部 poker_hand.id 为长整型主键，仅在服务内部关联，不与 v1 字符串混用。
- `pot`：最终净底池，排除未跟注退款；不得累加实时街下注生成新结果。
- `netChips`：本手净盈亏，`award_total + refund_total - gross_paid`。如果 `total_contribution` 采用扣除退款后的净投入，则 `award_total - total_contribution`。必须固定一种持久化语义，不能把退款扣两遍。可用开手余额与纯游戏结算余额交叉校验，不能使用 applyPending 之后的永久账本余额（会混入追加带入）。
- `position`：玩家本手位置字符串，D/SB/BB/UTG/UTG+1/LJ/HJ/CO 等；双人庄家使用 D/SB。按本手参与者重建，不按当前座位及当前人数推算。
- `holeCards`：与当前牌桌相同的编码，点数 2–9/T/J/Q/K/A，花色 s/h/d/c。可见时两张；不可见必须 `[null,null]`。**不能先返回原始底牌再让前端遮盖。**
- `holeCardsRevealed`：是否已对房间公开底牌；本人即使 false 也可以收到本人底牌。对手只有已合法摊牌、未弃牌时才返回 true。`handName` 对隐藏对手必须 null，不得泄露牌型/最佳五张。
- `actions`：本手每人完整动作列表，sequence=全手 action_no，street 为 PREFLOP/FLOP/TURN/RIVER，type 与 poker_action 一致，source 为 CLIENT_WS/TIMEOUT/SYSTEM。`amount=amount_delta` 是本次实际支付（退款为退回金额）；`streetTotalAfter` 是该动作后本街总下注。加注目标与实际新增筹码须区分，不能把 WS ACTION.payload.amount 的目标值直接当增量。前端当前显示实际金额，超时标“（超时）”，不会在空轮次猜测“过牌”。

### 2.2 空记录与历史缺失

```json
{
  "roomId": "A123",
  "throughHandNumber": null,
  "totalHands": 0,
  "position": 0,
  "firstHandNumber": null,
  "lastHandNumber": null,
  "previousHandNumber": null,
  "nextHandNumber": null,
  "coverage": { "status": "COMPLETE", "message": null },
  "hand": null
}
```

尚未有已结算手牌正常返回 code=0 和这个结构；实际已经打过但历史未保存时 coverage 应为 PARTIAL，message 如“早期牌局未保存，仅展示已有历史”。不返回假手数或复制最新一手填充。ABORTED、RUNNING 均不纳入导航。客户端刷新清除固定上界，打开新浏览范围；普通 SNAPSHOT 不会自动切换正在查看的历史。

## 3. Java 实现位置与只读权限

建议新增 `PokerHistoryRequest`（ticket/roomId/handNumber/throughHandNumber）、`PokerHistoryService` 和 `PokerHandHistoryRepository`，在现有 Controller 增加 `/rooms/history`。请求 DTO 独立于开房 settings DTO，避免把只读查询字段混入开房配置。

权限复用 ticket 的签名/过期/身份一致性校验，再验证 ticket 活动房间映射。活动有效成员或房主可读；需要允许退出活动的原玩家重看时，以历史 poker_room_member 核验，封禁身份按现有业务策略拒绝。此接口不要调用 `PokerRoomService.open/entry` 加入路径：不得创建成员、初始化筹码、改变座位/准备、签发 wsToken、复活 CLOSED 房间。关房后沿用相同只读接口，不依赖活动必须 UPCOMING。

每次查询都校验访问资格，即使 throughHandNumber 来自上次响应。跨房查询拒绝 403，过期认证 401，参数错误 400，手牌不存在/未结算 404。未实现接口可暂时 404/405/501，前端已提供对应提示与重试。

在一致性只读事务内查询 SETTLED 集合、count、position、邻近手数及详情。复用 `uk_poker_hand_no(room_id,hand_no)` 和相关现有索引；Repository 按当前约定每条 SQL 只访问一张表：先查 room，再按 room_id/hand_id 分批查 hand、players、actions，按 user_id 批量查展示资料并组装，不做跨表 SQL，不对每个动作查询用户。底牌在授权投影服务内解密，隐藏对手根本不解密；不序列化整个 PokerHand 或 deck。

现有规范化表未保存历史昵称/头像：不改表时可批量读取现有用户资料作为显示名，账号不存在则回退“玩家”。若产品需要固定当时昵称/头像，可复用现有 poker_room_event 的 HAND_STARTED 公共 JSON 保存公开人物快照，不能凭空声称现有列已有快照。严禁在公开事件 JSON 放未公开底牌。

## 4. 当前活动引擎如何补历史写入

继续以 `poker_activity_state` 为实时引擎恢复源，历史表作为同事务投影；不用切换第二套发牌或结算引擎。每次写入都复用现有房间行锁和事务。

1. **开手**：`PokerHand.start` 前保存玩家开手筹码；start 后写 poker_hand 的 RUNNING 记录和全体 poker_hand_player，记录实际 seat_id/seat_no（Java seatIndex+1）、加密底牌、加密牌堆、初始余额、盲位、started_at；写两条实际贴盲流水，包括短筹码盲注。现有规范化表 deck/flow 等 NOT NULL 字段必须全部正确填充，不能仅插一个“历史摘要”行。
2. **接受动作及超时**：在 PokerHand.act/pay/退款等发生点记录 street、action_no、真实 delta、street_total_after、total_contribution_after、pot_after、stack_after、source；同事务同步历史投影与实时密文，沿用活动命令去重，重复 ACTION 不追加第二条流水。超时、起身引发弃牌、无客户端时动作同样记录，必须在换街/自动结算之前捕获所属 street。
3. **结算**：在 `persistHand` 的 `firstSettlement = !hand.running() && !hand.settlementCommitted` 边界，**applyPending 之前**固定纯游戏结果，更新 SETTLED/finished_at/public board/net pot、玩家退款/奖额/公开信息，写主池/边池派奖。与筹码账本、统计、settlementCommitted 一起提交；结果落库失败则整笔事务回滚，不能先确认筹码再异步“尽力保存历史”。
4. **恢复及自动下一手**：重启/调度/重连不重复插入，利用现有 hand_no、action_no、派奖唯一键及状态保证幂等。规范化记录内部 hand.id 用生成主键关联，v1 handId 保持字符串；写 poker_room.current_hand_id 若用该字段必须是真实数值 ID。
5. **引擎附加状态**：现有 PokerHand 没有完整 action 列表、startedAt/startStack，且只记录最后状态。可在加密聚合增加这些 Java 字段（不是数据库列），旧密文读取时给合理兼容值；捕获的新动作按 action_no 写规范化表。不能只在结算时根据最后 stack/bet/contribution 反推逐轮动作。
6. **隐私与资金语义**：公开时间和牌型仅合法摊牌记录；弃牌结束的赢家没有自动公开底牌。初始带入、追加带入不进入本手 netChips/pot/actions，退款和分池奖额只计算一次。统计或历史查询不修改引擎结果。

首次上线时已有的 RUNNING 手若缺开手/完整动作，应先继续正常游戏但跳过完整历史承诺，从下一手开始记录，coverage=PARTIAL。不要在不完整旧手中填充伪动作。旧房覆盖完整性的判断可以根据记录的连续性、最早 hand_no 是否为 1、实际已结算手数与现有可信 total_hands 交叉验证；无法证明完整时保守标 PARTIAL，不以缺失数据断言 COMPLETE。

## 5. 验收

- 新房连续开局 300 手，所有已结算记录可从最新/最早逐手查看；固定范围切换期间新手结算不改变 totalHands 和 position，刷新能看到新手。
- 2–9 人、双人庄小盲、盲注全下、翻前弃牌、摊牌、平局、主池/边池、未跟注退款；显示真实动作、时间和本手盈亏，无扣费时每手 netChips 之和为 0。
- 本人、参赛对手、旁观者分别查询：本人可见本人弃牌底牌；对手弃牌/未摊牌赢家隐藏，合法摊牌显示；JSON 不包含隐藏底牌、牌型、牌堆或密钥。
- 起身、换座、离线、退出后旧牌局仍保持原参与者；重连、重复操作、超时扫描、多实例及服务重启不丢手、不重复写入。
- 已关房能只读查询；无资格或 ticket 与 roomId 不一致时拒绝，查询不增加余额和成员、不改变 room.version。
- 零手、只有旧最新状态、早期历史缺失、历史 hand_no 不连续：空/部分状态诚实，导航返回实际邻近手数。
- 前端请求失败可重试，关闭后迟到响应不重新打开；加载及边界禁用导航。真实 Java 上线后再联调验收。
