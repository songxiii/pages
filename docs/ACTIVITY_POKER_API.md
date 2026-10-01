# p.html 活动牌桌与 Java 对接

本次前端已经实现三个用户视图：错误/等待提示、创建人的下拉开房页、自动连接的活动牌桌。此文是 **活动入口 v1** 的对接约定，和 `docs/WEBSOCKET_PROTOCOL.md` 里首页双人演示的 **小写消息协议** 分开使用，不能混用。

仓库已有 `/entry`、`/rooms`、`AUTH`、`AUTH_OK`、`PING`、`SNAPSHOT` 的前端接入。2026-09-30 Java 已补齐下文的完整牌局快照及 `SIT_DOWN/READY/STAND_UP/START_HAND/ACTION`，代码与部署说明见相邻 Java 仓库 `docs/POKER_ACTIVITY_V1.md`。前端曾用模拟服务验证；真实活动 ticket、MySQL 迁移与公网 WSS 联调仍待部署验证。

Java 的当前鉴权口径为 **ticket-only**：entry/rooms 不需要 Authorization，身份来自服务端校验的 ticket。数据库需新增 `poker_activity_state/poker_activity_command`；牌局加密默认从已有 `POKER_WS_SECRET` 派生，无需增加密钥配置，`POKER_STATE_KEY` 是可选优先覆盖。外部 `seatIndex` 从 0 开始，数据库 `seat_no` 保持 1 起；Java 早期设计稿中的 `SET_READY/PLAYER_ACTION/commandId/actionId` 和增量事件不用于此页面。

后端待实现功能的独立交付文档见 [Java 后端待实现接口设计](POKER_BACKEND_TODO.md)，含命令、字段、事务顺序和验收用例。

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

### 房间成员金额展示

成员列表使用 `roomMembers[].avatarUrl/nickname/state/seatIndex/online/totalBuyIn/netChips`，当前 Java 视图已提供这些字段，不需要新增查询接口。头像为 30px，缺失、非法地址或加载失败时显示昵称首字。右侧 `netChips > 0` 显示红色「+金额」，小于零显示绿色「-金额」，等于零使用默认字体颜色显示 `0`；下方显示「累计带入 totalBuyIn」。每次完整 SNAPSHOT 同步刷新。

缺失 `netChips` 时，仅在 `stack` 与 `totalBuyIn` 都有效时用两者差额兼容；金额缺失显示 `—`，不能误报零。累计带入只包含已到账金额，未结算的 `pendingBuyIn` 不混入。当前 Java 的 `netChips = stack - totalBuyIn` 是实时账面差额，手牌中已下注但未分配的底池会暂时体现为负数；若产品需要仅统计已完成手牌，Java 应将 `netChips` 改为结算后账本差额，并在下注期间保持上手结果，前端直接使用该值。

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
- 位置标签显示「庄位 / 小盲 / 大盲」，双人庄位兼小盲显示「庄位/小盲」。其他位置优先使用 `game.players[].position`；旧 Java 留空时，前端按本手参局成员从大盲后开始补齐 UTG、UTG+1、UTG+2、LJ、HJ、CO，详见独立交付文档。
- `turn` 和 `dealer` 都是座位号。`turnDeadline` 为 UTC/带时区 ISO 时间，前端显示剩余行动秒数，超时动作由 Java 执行。
- `pot` 是服务端计算的当前总底池。`bet` 是该玩家本轮总下注，`stack` 是尚未下注的筹码；不要只传动作增量。
- 未摊牌时对手底牌只传 `[null,null]`，本人可传 `Jc`、`7h` 等编码。旁观连接隐藏所有未公开底牌。禁止把牌堆、随机种子或全房间未公开底牌发给浏览器。
- 摊牌结束可返回 `result={"winners":[0],"message":"小明以同花获胜","hands":["同花","一对"]}`，`hands` 非空才显示服务端提供的对手公开底牌。弃牌结束时 `hands=null`。
- `legal` 仅给本人当前回合，其余情况为 `null`。加注范围来自 Java，前端不会自己计算牌局合法性。头像可选，缺失时显示昵称首字。
- `self`, `roomMembers`, `game` 需要是完整的接收者视图。尤其是起身后需明确发 `self.seatIndex=null`，不能省略并依赖旧值。

## 3. 点击落座、房主管理与起身（本轮前端新增规则）

页面不再显示品牌名称或牌桌水印；活动名称仅作为左上角菜单的标题，优先使用 activity.title。

前端同时检查服务端 `self.allowedCommands` 与自身状态。房主管理区仅 `self.role=CREATOR/HOST` 或 `self.isHost=true` 可见，提供开始、暂停、继续；普通成员即使收到错误的房主管理 allowedCommands，前端也不会显示或发送。Java 必须再次校验真实房主身份。

| 状态/操作 | 授权命令 | 前端发送 |
| --- | --- | --- |
| 未落座点击虚线空座 | `SIT_DOWN` | `{"type":"SIT_DOWN","requestId":"uuid","payload":{"seatIndex":2}}` |
| 已落座、允许准备（兼容原 Java） | `READY` | `{"type":"READY","requestId":"uuid","payload":{}}` |
| 已准备，取消准备 | **新增 `UNREADY`** | `{"type":"UNREADY","requestId":"uuid","payload":{}}` |
| 追加带入筹码 | **新增 `BUY_IN`** | `{"type":"BUY_IN","requestId":"uuid","payload":{"amount":400}}` |
| 已落座，确认起身 | `STAND_UP` | `{"type":"STAND_UP","requestId":"uuid","payload":{}}` |
| 房主开始游戏，至少两人落座 | `START_HAND` | `{"type":"START_HAND","requestId":"uuid","payload":{}}` |
| 房主申请本局结束后暂停 | **新增 `PAUSE_GAME`** | `{"type":"PAUSE_GAME","requestId":"uuid","payload":{"afterCurrentHand":true}}` |
| 房主继续已暂停游戏，至少两人落座 | **新增 `RESUME_GAME`** | `{"type":"RESUME_GAME","requestId":"uuid","payload":{}}` |

### 点击虚线空座

页面不展示座位序号，空位统一显示「空座」，成员列表仅显示状态和在线信息。真实 `seatIndex` 仍用于命令与布局，本人视觉位置始终旋转到正下方，不修改真实编号。随机房间点击任意空座都只申请随机分配，不指定点击的座位。若反复落座的快照仍始终返回 `self.seatIndex=0`，应核对线上 Java 版本、可用座位集合以及随机选择逻辑；当前本地 Java 源码使用 `SecureRandom.nextInt(empty.size())` 随机挑选空位。

点击空座根据房间配置发送兼容当前 Java 的消息：`seatingType=1` 自选房间发送 `{"seatIndex":2}`，号码是服务端真实的零基座位号；`seatingType=0` 随机房间发送空 `payload={}`，由 Java 随机选择可用座位。新开房默认自主选座，既有随机房间仍可点击任意空座申请随机入座。

**SIT_DOWN/READY/STAND_UP/START_HAND 不要带 expectedRevision**。现有 Java 用字段白名单校验，SIT_DOWN 只接受 seatIndex（随机房间不允许该字段），READY/STAND_UP/START_HAND 只接受空 payload。expectedRevision 仅用于 ACTION；上一版前端多带这个字段会收到 BAD_PAYLOAD。

空座按钮只在已有请求等待确认时锁定，其余不可落座状态点击后给出连接尚未就绪、已落座、当前手尚未结束或房间不允许落座的提示。旧快照缺少 allowedCommands 时，未落座且没有正在进行的手牌可发送落座申请，最终权限由 Java 校验；明确返回的 allowedCommands=[] 仍尊重拒绝。前端兼容旧 seatNo（1 起）转换为 seatIndex（0 起），显式 seatIndex=null 始终表示未落座。

成功快照需包含更新后的 `self.seatIndex`、`roomMembers[].seatIndex/nickname/avatarUrl/stack/state`，前端收到后才占座，显示头像昵称，并把本人旋转到正下方。没有头像时显示昵称首字。服务端应在同一事务检查空位，两个玩家同时点击同座时仅一人成功；失败发 ERROR 中文提示。已落座玩家不能再次点击其他空位换座，须先确认起身。

### 至少两人落座后开始

前端从当前完整 `roomMembers` 计算实际有效座位数量，排除旁观/起身、空座和重复座位，不仅信任 counts.seatedCount。人数不足 2、当前手未结束或已申请暂停时，开始按钮禁用；普通成员永远没有此控制。

用户此前要求至少两人落座才能开始；当前补充要求是：如果保留准备机制，牌桌要显示准备状态并提供取消准备。当前 Java 要求至少两名已准备且有筹码的成员，前端兼容此规则，显示准备人数与座位“已准备”标记。若服务改为两人落座直接开局，可以不再授权 READY/UNREADY；若保留准备机制，则必须在已准备快照中授权 UNREADY；目前前端兼容允许 STAND_UP 的未开局快照发送取消。最终 START_HAND 始终以服务端授权和校验为准。成功后由 Java 发牌并广播 SNAPSHOT，前端不自行开手。

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

本轮核对相邻 Java 已加入 PAUSE_GAME/RESUME_GAME 业务处理，但读取的视图仍未返回 room.playState 或新管理授权，需要同步补齐快照并验收。

### 起身确认

所有已落座用户，包括房主和普通成员，都能看到“我的座位 → 起身”；旁观者完全不显示此项。点击后打开页面自定义确认弹框（入场动画、背景模糊、继续落座/确认起身），不使用浏览器 window.confirm。取消、Esc 不发送请求；确认时重新检查最新权限后发送 STAND_UP。成功快照明确返回 self.seatIndex=null 及新的成员列表，前端再转旁观。

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
3. 校验现有 SIT_DOWN、READY、STAND_UP、START_HAND、ACTION；核对自选与随机房间落座、当前准备/开局规则，并新增 UNREADY/BUY_IN（第 5 节）、PAUSE_GAME/RESUME_GAME 与 room.playState，成功发新快照，失败发 ERROR。
4. 提供 PONG、turnDeadline、关房与认证过期事件，并让服务器处理行动超时、断线与下注幂等。

原有活动 v1 命令已在 Java 实现并有规则、JDBC 事务及 WS 回包测试；前端已兼容现有 Java 的落座及生命周期 payload；取消准备、追加带入、暂停与继续的业务命令已在最新 Java 源码加入，快照字段与授权仍需补齐，之后部署并用真实活动验证。在线人数目前只统计本实例连接；跨实例牌局通过数据库 revision 轮询更新，在线人数租约仍属后续。结算画面可保留；有人起身/换座后 Java 返回 game=null，避免旧玩家占据空座，服务端仍保留下一手手数与庄家轮换。


## 5. 本次新增需求：取消准备、带入筹码及当前后端缺口

以下核对的是相邻 Java 仓库当前源码，未代表公网已部署版本。前端已接入下面的命令与快照字段；带入和暂停/继续仍要求明确授权；取消准备兼容已准备、未开局且允许 STAND_UP 的快照，发送 UNREADY 由服务端校验，不自行变更准备或筹码。

| 项目 | 当前 Java | 本次前端 |
|---|---|---|
| READY 与准备状态 | 已实现，成员含 ready/state | 座位头像旁显示“已准备”，菜单显示准备人数 |
| UNREADY 取消准备 | 业务已加入，视图未授权 | 菜单入口及空 payload 已接入，兼容 STAND_UP 授权 |
| BUY_IN 追加带入 | 业务已加入，金额配置/待到账/授权快照待补齐 | 菜单下拉、当前余额、待到账金额已接入 |
| PAUSE_GAME / RESUME_GAME | 业务已加入，视图缺 room.playState 和授权 | 现有入口待完整快照与授权 |
| 起身确认、短屏一屏、连接静默重试 | 无需新增接口 | 页面确认动画；竖屏动态高度/座位；网络失败只显示状态，最多自动重试 3 次 |

### 5.1 取消准备

```json
{"type":"UNREADY","requestId":"uuid","payload":{}}
```

- 在命令白名单和 WS 路由中加入 UNREADY。身份、活动资格、房间状态按现有 READY 校验；仅已落座、ready=true、当前没有运行中手牌可取消。牌局已经开始时返回 HAND_RUNNING。
- 房间行锁内将本人 ready=false，保留座位和筹码，递增 revision，按 requestId 幂等记录，广播 SNAPSHOT。
- 快照同步 `self.roomState=SEATED`、`roomMembers[].state=SEATED`、`ready=false`。已准备且可取消时授权 UNREADY（不再授权 READY）；取消后反过来。
- READY 和 START_HAND 并发按同一房间行锁序列化。若取消先成功，开局必须按最新准备人数再校验。若开局先成功，取消返回 HAND_RUNNING。

### 5.2 追加带入筹码

金额表示**追加数量**，不会覆盖原余额或输赢，不允许负数提现。使用同一 WebSocket，不需要另建 HTTP 接口：

```json
{"type":"BUY_IN","requestId":"uuid","payload":{"amount":400}}
```

在入口、创建返回和每次 SNAPSHOT 的 room 中提供金额配置；只有实际可申请时，在 `self.allowedCommands` 加入 BUY_IN。允许当前活动成员在旁观/已起身/已落座/参局中追加，款项归用户永久筹码账本，不归临时座位编号。

```json
{
  "room": {
    "buyIn": {"minAmount":200,"maxAmount":2000,"step":200,"options":[200,400,1000,2000]}
  },
  "self": {"stack":600,"pendingBuyIn":400,"allowedCommands":["BUY_IN"]},
  "roomMembers": [{"userId":"u1","seatIndex":0,"stack":600,"pendingBuyIn":400,"totalBuyIn":1000}]
}
```

- `self.stack/self.pendingBuyIn` 对旁观和起身用户也必须返回；roomMembers 中每人的 pendingBuyIn 必须实时同步，金额未到账前不能混入 stack。
- `minAmount/maxAmount` 为单次追加范围；`step` 表示从 minAmount 起的增量单位，金额须满足 `(amount-minAmount)%step=0`，正整数且不超过 JavaScript 安全整数。`options` 是合法下拉金额，建议必填。前端过滤非法选项；Java 必须再次校验，不信任客户端。
- 增加带入流水：用户、roomId、requestId、amount、提交时 handId（可空）、状态 PENDING/APPLIED、创建/生效时间；在永久成员账本增加 pendingBuyIn 聚合值。复用现有去重存储，唯一键按 roomId/userId/requestId。相同 ID 相同请求不重复增加，相同 ID 不同金额返回 REQUEST_ID_REUSED。
- **没有运行中手牌（包括首次开局前、两局之间、暂停中）**：在事务内 `stack += amount`、`totalBuyIn += amount`，流水直接 APPLIED，递增 revision 并广播 SNAPSHOT。成员准备状态不因单纯追加而被静默改变。
- **存在运行中手牌**：流水标记 PENDING，聚合 `pendingBuyIn += amount`，立即广播新 revision 的 SNAPSHOT 作为“申请已确认”；本人游戏 player.stack、ledger.stack、本局底池、legal.maxRaiseTo、下注上限保持不变。即使本人已经弃牌或是旁观，也等这手结算结束后生效。
- **结算边界**：在同一事务先完成全部底池/边池分配并保存所有游戏玩家结算余额，再对全部成员（含未参局成员）应用待到账流水：`stack += pendingBuyIn`、`totalBuyIn += pendingBuyIn`，清零 pendingBuyIn，流水改 APPLIED。完成后才广播 complete 快照，才允许下一次 START_HAND。否则现有 persistHand 覆写 ledger.stack 会吞掉追加筹码。
- 全局筹码守恒校验只统计当前手进入时的筹码与底池；待到账金额不属于本局。完成快照中 roomMembers.stack 是**含新带入的账本余额**，game.players.stack 可保留本手结算结果；前端在 complete 阶段优先显示成员账本，避免显示旧金额。
- 行锁串行化 BUY_IN 与结算/开局，服务重启后从持久 PENDING 流水恢复；应用需事务原子性，重复超时结算或跨实例处理不会再次入账。申请开始时检查“余额+所有待到账+本次金额”及房间筹码总上限，避免结算时溢出。
- 若活动结束/房间关闭与当前局结算同时发生：已受理的 pending 必须先结算到账，之后关闭；关闭后拒绝新申请。不得丢弃或悄悄撤销已确认金额。
- 拒绝时按现有 ERROR 返回中文原因和原 requestId，建议代码 BUY_IN_DISABLED、BAD_BUY_IN_AMOUNT、CHIP_LIMIT、ROOM_CLOSED、NOT_ROOM_MEMBER；失败不写流水、不改余额。

### 5.3 连接与界面约定

连接 onerror、onclose、认证/快照超时仅更新顶部状态、牌桌提示和菜单连接说明，不弹异常框。自动重试使用 1.5/3/6 秒退避，重新取入口凭证再认证；后台入口网络/5xx失败保持现有牌桌并继续重试，3 次失败后保留手动重连。业务 ERROR、AUTH_EXPIRED 与接口业务异常仍可查看脱敏请求/返回详情。

右上角已移除问号和全屏按钮。牌桌仅使用竖屏布局，按可用浏览器高度压缩，保持本人在底部；底部不平铺快捷加注，点击加注才打开金额浮层；快捷金额、拖动及全下只选择金额，最后确认提交，不把操作区推到屏幕外。房间配置、成员和连接信息放在菜单折叠详情中。
