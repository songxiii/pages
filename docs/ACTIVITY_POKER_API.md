# p.html 活动牌桌与 Java 对接

本次前端已经实现三个用户视图：错误/等待提示、创建人的下拉开房页、自动连接的活动牌桌。此文是 **活动入口 v1** 的对接约定，和 `docs/WEBSOCKET_PROTOCOL.md` 里首页双人演示的 **小写消息协议** 分开使用，不能混用。

仓库已有 `/entry`、`/rooms`、`AUTH`、`AUTH_OK`、`PING`、`SNAPSHOT` 的前端接入。新增牌局字段、生命周期命令和下注命令需 Java 确认并实现；本次用模拟服务验证前端，尚未用真实活动 ticket 验证 Java 的牌局能力。

## 1. 活动入口和开房（沿用）

页面地址 `p.html#ticket=...`，访问即调用：

```http
POST /api/poker/v1/entry
Content-Type: application/json
Authorization: Bearer <当前账号 access token>

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

### 当前账号的获取

当前实现读取同源当前标签页 `sessionStorage["poker-entry-access-token"]`。如果宿主尚未把登录态交给此网页，首次访问会收到 401 并显示简单账号提示。Java/宿主需要确认登录态交接方式：同源入口可在导航前写该值；跨域小程序/宿主需要另行约定受信任的登录态交接或后端换票接口。access token 不放进 URL。

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

### 完整牌局快照（需 Java 增补/确认）

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
      "handId":"A123-H8","handNumber":8,"phase":"preflop","board":[],"dealer":0,"turn":0,"pot":3,
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
- `turn` 和 `dealer` 都是座位号。`turnDeadline` 为 UTC/带时区 ISO 时间，前端显示剩余行动秒数，超时动作由 Java 执行。
- `pot` 是服务端计算的当前总底池。`bet` 是该玩家本轮总下注，`stack` 是尚未下注的筹码；不要只传动作增量。
- 未摊牌时对手底牌只传 `[null,null]`，本人可传 `Jc`、`7h` 等编码。旁观连接隐藏所有未公开底牌。禁止把牌堆、随机种子或全房间未公开底牌发给浏览器。
- 摊牌结束可返回 `result={"winners":[0],"message":"小明以同花获胜","hands":["同花","一对"]}`，`hands` 非空才显示服务端提供的对手公开底牌。弃牌结束时 `hands=null`。
- `legal` 仅给本人当前回合，其余情况为 `null`。加注范围来自 Java，前端不会自己计算牌局合法性。头像可选，缺失时显示昵称首字。
- `self`, `roomMembers`, `game` 需要是完整的接收者视图。尤其是起身后需明确发 `self.seatIndex=null`，不能省略并依赖旧值。

## 3. 入座、准备、起身、开局（需 Java 实现或映射）

前端 **只显示服务端 `self.allowedCommands` 授权的按钮**。缺失字段时不会显示未确认的生命周期功能。

| 状态 | `allowedCommands` 示例 | 消息 |
| --- | --- | --- |
| 旁观、允许入座 | `["SIT_DOWN"]` | `{"type":"SIT_DOWN","requestId":"uuid","payload":{"seatIndex":2}}` |
| 已入座、允许准备 | `["READY","STAND_UP"]` | `{"type":"READY","requestId":"uuid","payload":{}}` |
| 允许起身 | `["STAND_UP"]` | `{"type":"STAND_UP","requestId":"uuid","payload":{}}` |
| 创建人且满足开局条件 | `["START_HAND"]`，也可和其他命令组合 | `{"type":"START_HAND","requestId":"uuid","payload":{}}` |

随机落座发送 `SIT_DOWN` 的空 `payload={}`，由 Java 选座；自选时才发送零基 `seatIndex`。Java 必须校验座位占用、用户身份、人数、状态与开局权限。在牌局中何时能起身及下一手如何开始，由服务端通过 allowedCommands 控制。当前不包含取消准备命令；若需要，请一并提供协议。

## 4. 下注（需 Java 实现或确认）

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

## 给 Java 的最小任务清单

1. 确认原有 entry/rooms 的字段和当前账号登录态交接，错误返回可读中文 message。
2. AUTH 成功立即发上述 game/seatIndex/legal/revision/allowedCommands 快照，按接收者遮蔽底牌。
3. 实现/映射 SIT_DOWN、READY、STAND_UP、START_HAND、ACTION，成功发新快照，失败发 ERROR。
4. 提供 PONG、turnDeadline、关房与认证过期事件，并让服务器处理行动超时、断线与下注幂等。

这四项齐备后即可完整联调。若现有 Java 已经有对应消息但命名或字段不同，按实际协议调整前端映射即可，无需重做页面。
