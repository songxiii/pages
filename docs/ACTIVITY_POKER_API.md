# p.html 活动牌桌与 Java 对接

本次前端已经实现三个用户视图：错误/等待提示、创建人的下拉开房页、自动连接的活动牌桌。此文是 **活动入口 v1** 的对接约定，和 `docs/WEBSOCKET_PROTOCOL.md` 里首页双人演示的 **小写消息协议** 分开使用，不能混用。

仓库已有 `/entry`、`/rooms`、`AUTH`、`AUTH_OK`、`PING`、`SNAPSHOT` 的前端接入。2026-09-30 Java 已补齐下文的完整牌局快照及 `SIT_DOWN/READY/STAND_UP/START_HAND/ACTION`，代码与部署说明见相邻 Java 仓库 `docs/POKER_ACTIVITY_V1.md`。前端曾用模拟服务验证；真实活动 ticket、MySQL 迁移与公网 WSS 联调仍待部署验证。

Java 的当前鉴权口径为 **ticket-only**：entry/rooms 不需要 Authorization，身份来自服务端校验的 ticket。数据库需新增 `poker_activity_state/poker_activity_command`，并在所有实例配置稳定的 `POKER_STATE_KEY`。外部 `seatIndex` 从 0 开始，数据库 `seat_no` 保持 1 起；Java 早期设计稿中的 `SET_READY/PLAYER_ACTION/commandId/actionId` 和增量事件不用于此页面。

## 1. 活动入口和开房（沿用）

页面地址 `p.html#ticket=...`，访问即调用：

```http
POST /api/poker/v1/entry
Content-Type: application/json

{"ticket":"..."}
```

返回格式：

```json
{"code":0,"message":"success","systemVersion":"20260930213000","data":{}}
```

`data` 字段：

| 字段 | 用途 |
| --- | --- |
| `entryState` | `READY_TO_CREATE` / `WAITING_FOR_CREATOR` / `ROOM_READY` / `ROOM_CREATED` / `ROOM_CLOSED` |
| `canCreate` | Java 根据活动创建人身份计算，前端据此提供开房表单 |
| `activity` | `activityId`, `title`, `status` |
| `self` | 本人 `userId`（兼容 `id`）, `nickname`, `role`, `roomState`, `seatIndex`, `allowedCommands` |
| `room` | `roomId`, `name`, `status`, `settings` |
| `counts` | `activityParticipantCount`, `roomMemberCount`, `onlineCount`, `seatedCount` |
| `roomMembers` | 成员列表，包括座位和头像，见下文 |
| `connection` | `url`, `wsToken`, `protocolVersion`, `expiresAt`；已有房间时必须返回 |
| `game` | 可选的当前牌局；正式状态仍需 WS 认证后的完整快照 |

用户、活动、解密、权限等校验失败时，返回非零 `code`，并在 `message` 中提供**可直接展示给用户**的对应中文提示。例如“活动链接已过期，请返回活动重新打开”“你不是本场活动成员”。不要把堆栈、密钥或异常类名作为用户提示。401 显示账号提示，403 显示权限提示；普通成员遇到未开房显示等待创建人的提示。

访问已有房间的资格及创建人的开房权限必须由 Java 校验。前端不自行解密 ticket，不依据 URL 身份参数授权。

创建房间仍调用：

```http
POST /api/poker/v1/rooms

{"ticket":"...","settings":{"maxSeats":6,"seatingType":0,"smallBlind":10,"bigBlind":20,"startingStack":1000,"turnSeconds":30}}
```

返回同入口结构，`entryState=ROOM_CREATED` 或 `ROOM_READY`，同时返回 `connection`。成功后自动连接。并发已创建可返回 409，前端会重新检查入口。

六项配置全部使用下拉。当前沿用整数筹码限制：人数 2–9，落座 0 随机 / 1 自选，小盲 1/2/5/10/25/50，大盲 2/4/10/20/50/100，初始筹码 200/500/1000/2000/5000/10000/20000，行动时限 15/20/30/45/60/90/120 秒，初始筹码至少 20 个大盲。改小盲时默认大盲为两倍，筹码选项联动防止不足。

参考图里的 0.5/1 未放入开房选项，因为现有 `validateSettings` 要求整数。若需要小数盲注，Java 与前端需统一最小筹码单位并同时调整校验和金额步长。

### 当前 Java 鉴权口径

Java 已确认 entry/rooms 只要求请求体 ticket，票据允许转发，接收者以票据对应的用户身份操作；后端复核账号、活动成员资格及活动/房间状态。页面现有 `sessionStorage["poker-entry-access-token"]` 读取与可选 Bearer 头不是 Java 的入场前提，无需宿主另行交接 access token。401 在此口径下通常表示 ticket 无效，应返回活动重新打开。

仅在 `p.html?debug=1#ticket=...` 的调试区可手动填写 token，正式页面不让普通用户粘贴技术凭证。调试请求和响应遮盖 ticket、Authorization、wsToken；系统版本放在房间菜单内。

## 2. WebSocket 认证、心跳和快照

使用入口返回的公网 WSS 地址，建立连接后立即发送：

```json
{"type":"AUTH","requestId":"uuid","payload":{"wsToken":"短期凭证"}}
```

Java 校验 token 所属用户、活动和房间后，依次发送 `AUTH_OK` 与完整 `SNAPSHOT`。每次变更后分别向连接发送最新的完整快照；刚加入/重连也必须立即发当前状态。`AUTH_OK` 本身不会解锁下注按钮。

```json
{"type":"AUTH_OK","systemVersion":"20260930213000","payload":{}}
{"type":"PING","requestId":"uuid","payload":{"clientTime":"2026-09-30T13:30:00.000Z"}}
{"type":"PONG","requestId":"对应 PING 的 uuid","payload":{}}
```

前端每 20 秒心跳；60 秒没收到任何有效消息会重连。连接/认证或首次快照等待超过 15 秒也会重连。异常断开会在 1.5/3/6 秒后最多重试三次，每次重新请求 `/entry` 获取凭证；稳定收到快照后重置重试次数。可从房间菜单手动重新连接或重新检查入口。WS `4003` 表示永久权限拒绝，不自动重试。

### 完整牌局快照（Java 已实现）

```json
{
  "type":"SNAPSHOT",
  "systemVersion":"20260930213000",
  "payload":{
    "revision":12,
    "self":{"userId":"u0","nickname":"小明","role":"CREATOR","roomState":"IN_HAND","seatIndex":0,"allowedCommands":[]},
    "room":{"roomId":"A123","name":"周末牌局","status":"PLAYING","settings":{"maxSeats":6,"seatingType":1,"smallBlind":1,"bigBlind":2,"startingStack":200,"turnSeconds":30}},
    "counts":{"activityParticipantCount":6,"roomMemberCount":6,"onlineCount":6,"seatedCount":2},
    "roomMembers":[
      {"userId":"u0","nickname":"小明","seatIndex":0,"stack":199,"state":"IN_HAND","online":true,"avatarUrl":"https://example.com/avatar/u0.jpg"},
      {"userId":"u1","nickname":"小红","seatIndex":1,"stack":198,"state":"IN_HAND","online":true}
    ],
    "game":{
      "handId":"A123-H8","handNumber":8,"phase":"preflop","board":[],"dealer":0,"smallBlindSeat":0,"bigBlindSeat":1,"turn":0,"pot":3,
      "turnDeadline":"2026-09-30T13:30:30.000Z",
      "players":[
        {"userId":"u0","seatIndex":0,"nickname":"小明","position":"SB","stack":199,"bet":1,"folded":false,"allIn":false,"hole":["Jc","7h"]},
        {"userId":"u1","seatIndex":1,"nickname":"小红","position":"BB","stack":198,"bet":2,"folded":false,"allIn":false,"hole":[null,null]}
      ],
      "legal":{"toCall":1,"canFold":true,"canCheck":false,"canCall":true,"canRaise":true,"minRaiseTo":4,"maxRaiseTo":200,"chipUnit":1},
      "result":null
    }
  }
}
```

- `revision` 在每个房间中单调递增，过旧/重复快照被丢弃。一次业务变更产生新 revision；拒绝的请求发 `ERROR`。
- `seatIndex` 从 **0** 开始，空位不在成员/玩家列表里；旁观者 `self.seatIndex=null`。请不要把用户 ID 当座位号。前端兼容旧演示 `game.players[].id` 是座位的情形；活动协议请使用明确的 `seatIndex`。
- `game=null` 表示尚未开局；结束后可保留 `phase=complete` 的结算局面。`phase` 是 `preflop` / `flop` / `turn` / `river` / `complete`。
- `handId` 每手唯一。新手触发两轮从桌心飞向座位的发牌动画，公共牌新增时翻牌；同手普通更新不重复发牌。
- 前端按 `room.settings.maxSeats` 选用 2–9 人布局，保留空座。本人 `self.seatIndex` 始终旋转到屏幕正下方，其他座位按服务端座位顺序排列；旋转不改变命令中的真实座位编号。旁观者以 0 号座位为底部锚点。
- `dealer`、`smallBlindSeat`、`bigBlindSeat` 分别标记庄家 D、小盲 SB、大盲 BB，都是零基座位号。请 Java 在每手快照明确提供这三个字段，特殊规则下没有对应位置时明确返回 `null`。双人局庄家与小盲在同一座位，前端同时显示 D 和 SB。兼容旧快照：盲位优先从 `players[].position=SB/BB` 读取，否则根据本手 `game.players` 的参局座位与庄家推导，跳过空座，已弃牌者仍保留本手盲位；不会用下注额猜盲位。
- `turn` 和 `dealer` 都是座位号。`turnDeadline` 为 UTC/带时区 ISO 时间，前端显示剩余行动秒数，超时动作由 Java 执行。
- `pot` 是服务端计算的当前总底池。`bet` 是该玩家本轮总下注，`stack` 是尚未下注的筹码；不要只传动作增量。
- 未摊牌时对手底牌只传 `[null,null]`，本人可传 `Jc`、`7h` 等编码。旁观连接隐藏所有未公开底牌。禁止把牌堆、随机种子或全房间未公开底牌发给浏览器。
- 摊牌结束可返回 `result={"winners":[0],"message":"小明以同花获胜","hands":["同花","一对"]}`，`hands` 非空才显示服务端提供的对手公开底牌。弃牌结束时 `hands=null`。
- `legal` 仅给本人当前回合，其余情况为 `null`。加注范围来自 Java，前端不会自己计算牌局合法性。头像可选，缺失时显示昵称首字。
- `self`, `roomMembers`, `game` 需要是完整的接收者视图。尤其是起身后需明确发 `self.seatIndex=null`，不能省略并依赖旧值。

## 3. 点击落座、房主管理与起身（本轮前端新增规则）

页面名称为“算法培训班”，页头不再显示黑桃或“活动专属牌局”。

前端同时检查服务端 `self.allowedCommands` 与自身状态。房主管理区仅 `self.role=CREATOR/HOST` 或 `self.isHost=true` 可见，提供开始、暂停、继续；普通成员即使收到错误的房主管理 allowedCommands，前端也不会显示或发送。Java 必须再次校验真实房主身份。

| 状态/操作 | 授权命令 | 前端发送 |
| --- | --- | --- |
| 未落座点击虚线空座 | `SIT_DOWN` | `{"type":"SIT_DOWN","requestId":"uuid","payload":{"seatIndex":2,"expectedRevision":12}}` |
| 已落座、允许准备（兼容原 Java） | `READY` | `{"type":"READY","requestId":"uuid","payload":{"expectedRevision":12}}` |
| 已落座，确认起身 | `STAND_UP` | `{"type":"STAND_UP","requestId":"uuid","payload":{"expectedRevision":12}}` |
| 房主开始游戏，至少两人落座 | `START_HAND` | `{"type":"START_HAND","requestId":"uuid","payload":{"expectedRevision":12}}` |
| 房主申请本局结束后暂停 | **新增 `PAUSE_GAME`** | `{"type":"PAUSE_GAME","requestId":"uuid","payload":{"afterCurrentHand":true,"expectedRevision":12}}` |
| 房主继续已暂停游戏，至少两人落座 | **新增 `RESUME_GAME`** | `{"type":"RESUME_GAME","requestId":"uuid","payload":{"expectedRevision":12}}` |

### 点击虚线空座

点击的 `seatIndex` 始终是服务端真实的零基座位号，不是旋转后的屏幕位置。**现在无论配置 seatingType=0/1，点击座位都会带 seatIndex，Java 应优先采用该指定空座**；只有未提供 seatIndex 的兼容请求才按随机配置选座。当前 Java 随机房间仍忽略 seatIndex，需要调整。

成功快照需包含更新后的 `self.seatIndex`、`roomMembers[].seatIndex/nickname/avatarUrl/stack/state`，前端收到后才占座，显示头像昵称，并把本人旋转到正下方。没有头像时显示昵称首字。服务端应在同一事务检查空位，两个玩家同时点击同座时仅一人成功；失败发 ERROR 中文提示。已落座玩家不能再次点击其他空位换座，须先确认起身。

### 至少两人落座后开始

前端从当前完整 `roomMembers` 计算实际有效座位数量，排除旁观/起身、空座和重复座位，不仅信任 counts.seatedCount。人数不足 2、当前手未结束或已申请暂停时，开始按钮禁用；普通成员永远没有此控制。

**用户本轮要求：至少两人落座后就能由房主开始，无需另行手动准备。** 当前 Java 要求至少两名已准备且有筹码的成员，并据此提供 START_HAND，尚需按新规则修改。修改前前端保留服务端授权的 READY 菜单用于兼容旧服务；新服务可以不再提供 READY，只在人数/筹码/牌局状态满足时提供 START_HAND。成功后由 Java 发牌并广播 SNAPSHOT，前端不自行开手。

### 暂停与继续（需要 Java 新增）

`room` 新增 `playState`，和房间生命周期 `status` 分开：

| playState | 意义 |
| --- | --- |
| `WAITING` | 等待房主首次开始 |
| `RUNNING` | 正常进行 |
| `PAUSE_PENDING` | 房主申请暂停，当前这手仍继续 |
| `PAUSED` | 已安全暂停，不再发下一手 |

房主点击暂停后 Java 持久记录请求：

1. 若当前手正在进行，立即广播 `playState=PAUSE_PENDING`。**保留这手的 game/turn/legal/turnDeadline 和 ACTION 权限，继续正常下注、超时与结算**，不能冻结正在进行的手牌。
2. 当前手结算完成后再改为 PAUSED，保留结算展示并停止开下一手；若申请时已在两手之间，可立即进入 PAUSED。
3. PAUSE_PENDING 不再授权 PAUSE_GAME/START_HAND，避免重复申请或抢先开下一手。所有成员都看到“本局结束后生效”。
4. PAUSED 仅向房主提供 RESUME_GAME，且仍需至少两名有有效座位及筹码的玩家。继续后设 RUNNING，并按服务端流程恢复下一手；当前前端不会自己发牌或假装暂停。
5. 普通成员提交 PAUSE_GAME/RESUME_GAME/START_HAND 必须拒绝；请求幂等、revision、事务和跨实例传播沿用现有机制。

当前相邻 Java 仓库仅接收 SIT_DOWN/READY/STAND_UP/START_HAND/ACTION，尚无 PAUSE_GAME、RESUME_GAME 或 playState，需要同步补齐。

### 起身确认

所有已落座用户，包括房主和普通成员，都能看到“我的座位 → 起身”；旁观者完全不显示此项。点击后调用原生 `window.confirm`，取消不发送请求、不锁定控件；确认后发送 STAND_UP。成功快照明确返回 self.seatIndex=null 及新的成员列表，前端再转旁观。

沿用 Java 的安全约束：当前手进行时若不允许立即起身，不提供 STAND_UP，菜单显示禁用选项；两手之间再开放。不要在一手尚未结算时直接清除参局玩家的筹码或底池权益。客户端确认不代替服务端身份、状态与筹码校验。

## 4. 下注（Java 已实现）

```json
{"type":"ACTION","requestId":"uuid","payload":{"action":"fold","handId":"A123-H8","expectedRevision":12}}
{"type":"ACTION","requestId":"uuid","payload":{"action":"check","handId":"A123-H8","expectedRevision":12}}
{"type":"ACTION","requestId":"uuid","payload":{"action":"call","handId":"A123-H8","expectedRevision":12}}
{"type":"ACTION","requestId":"uuid","payload":{"action":"raise","amount":15,"handId":"A123-H8","expectedRevision":12}}
```

`raise.amount` 是 **本轮总下注额**；全下以 `raise` + `maxRaiseTo` 发送。Java 应仅在该值确实对应全下或合法加注时接受。`legal.maxRaiseTo` 必须和本人 `bet + stack`、本轮规则一致。

快捷加注比例为 125%、75%、50%、33%，总额按 `本人 bet + toCall + (pot + toCall) × 比例` 计算，再按 `chipUnit` 向上取整并限制在 `minRaiseTo..maxRaiseTo`。这些只是操作候选，Java 最终校验。短全下允许与否也由 legal 提供。

点击后前端锁住操作，收到新快照/错误才恢复，不预扣筹码。10 秒未确认会禁用操作并提示重新连接。Java 根据 `requestId` 幂等处理，校验 `handId`、`expectedRevision`、本人座位、回合及下注范围，拒绝过期操作。成功发送新完整 `SNAPSHOT`；失败发送：

```json
{"type":"ERROR","requestId":"对应请求 uuid","payload":{"code":"NOT_YOUR_TURN","message":"还没有轮到你行动"}}
```

操作错误不会把已认证的连接标记成失败；认证过期请发 `AUTH_EXPIRED` 并关闭连接。关房请发送 `ROOM_CLOSED`，或发送 `room.status=CLOSED` 的完整快照。

## 部署后联调清单

1. 确认原有 entry/rooms 的字段和当前账号登录态交接，错误返回可读中文 message。
2. AUTH 成功立即发上述 game/seatIndex/legal/revision/allowedCommands 快照，按接收者遮蔽底牌。
3. 校验现有 SIT_DOWN、READY、STAND_UP、START_HAND、ACTION；按本轮规则支持指定点击座位、两人落座开局，并新增 PAUSE_GAME/RESUME_GAME 与 room.playState，成功发新快照，失败发 ERROR。
4. 提供 PONG、turnDeadline、关房与认证过期事件，并让服务器处理行动超时、断线与下注幂等。

原有活动 v1 命令已在 Java 实现并有规则、JDBC 事务及 WS 回包测试；本轮新增的点击指定座位、两人落座开局、暂停与继续仍需 Java 更新，之后部署并用真实活动验证。在线人数目前只统计本实例连接；跨实例牌局通过数据库 revision 轮询更新，在线人数租约仍属后续。结算画面可保留；有人起身/换座后 Java 返回 game=null，避免旧玩家占据空座，服务端仍保留下一手手数与庄家轮换。
