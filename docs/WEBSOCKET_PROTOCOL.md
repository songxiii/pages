# Java WebSocket 对接协议

前端联机入口在 `src/app.js`，默认地址在 `src/config.js`。页面也允许玩家在“联机服务设置”里填写地址，保存在该浏览器。正式发布时请把 `POKER_WS_URL` 改成你的 `wss://域名/路径`。GitHub Pages 使用 HTTPS，因此线上 WebSocket 必须使用 WSS，并且 Java 服务需要可从公网访问、允许 `https://songxiii.github.io` 这个 Origin。

每条消息都是一个 UTF-8 JSON 文本帧。所有发牌、回合、下注合法性、筹码与胜负由 Java 服务计算；客户端发送的是意图，收到完整 `state` 后才更新牌桌。玩家的 token 用于断线重连，请由服务端生成足够随机的值并验证，客户端会按房间保存在 `localStorage`。

## 客户端发给服务端

创建房间：

```json
{"type":"create_room","name":"小明"}
```

加入房间，已有 token 时表示重连：

```json
{"type":"join_room","code":"ABC234","token":"","name":"小红"}
```

房主开始第一局、下一局、筹码耗尽后重开：

```json
{"type":"start_game"}
{"type":"next_hand"}
{"type":"reset_game"}
```

玩家操作：

```json
{"type":"action","action":"fold"}
{"type":"action","action":"check"}
{"type":"action","action":"call"}
{"type":"action","action":"raise","amount":60}
```

`raise.amount` 表示**本轮总下注额**，不是在当前下注上再加的数量。服务端应逐条校验当前连接所属座位、回合、筹码余额、最小加注、全下与其他规则。不要信任前端传入的数值。

## 服务端发给客户端

创建成功时先发：

```json
{"type":"room_created","code":"ABC234","seat":0,"token":"服务端生成的随机凭证"}
```

加入或重连成功时先发：

```json
{"type":"room_joined","code":"ABC234","seat":1,"token":"服务端生成或验证后的凭证"}
```

随后向两位玩家分别发送各自的完整状态。房间变化和每次操作后都重新发送；下一条 `state` 完全替代上一条。

```json
{
  "type": "state",
  "code": "ABC234",
  "seat": 0,
  "room": {
    "seats": [{"name":"小明"},{"name":"小红"}],
    "connected": [true,true]
  },
  "game": {
    "mode": "online",
    "handNumber": 1,
    "phase": "preflop",
    "board": [],
    "dealer": 0,
    "turn": 0,
    "pot": 30,
    "players": [
      {"id":0,"name":"小明","stack":990,"bet":10,"folded":false,"allIn":false,"hole":["As","Kh"]},
      {"id":1,"name":"小红","stack":980,"bet":20,"folded":false,"allIn":false,"hole":[null,null]}
    ],
    "legal": {"toCall":10,"canCheck":false,"canCall":true,"canRaise":true,"minRaiseTo":40,"maxRaiseTo":1000},
    "result": null,
    "log": ["第 1 局开始，盲注 10/20"]
  }
}
```

尚未开始时 `game` 为 `null`；`seats` 中未入座的位置为 `null`。`seat` 是当前接收者的座位编号 0 或 1。对方底牌在摊牌前必须是 `[null,null]`，**不要把牌堆、对方底牌或随机种子发给客户端**。非当前行动玩家的 `legal` 为 `null`。`board` 依次为 0、3、4、5 张公共牌。`phase` 值为 `preflop`、`flop`、`turn`、`river`、`complete`。牌面编码用 `2-9,T,J,Q,K,A` 加 `s,h,d,c`，如 `As` 为黑桃 A。

本局结束时，`result` 例如：

```json
{"winners":[0],"message":"小明以同花赢得 120 筹码","hands":["同花","一对"]}
```

若通过弃牌结束，`hands` 为 `null`，对方底牌继续隐藏。平局时 `winners` 为 `[0,1]`。错误时发送：

```json
{"type":"error","error":"现在不是你的回合"}
```

## 服务端实现要点

1. 房间码只用于定位牌桌，token 才是座位凭证。不要把 token 放进邀请链接或广播状态。
2. 游戏状态保存在服务端；断线重连用 `join_room` 和同一 token 恢复座位，返回最新完整 `state`。
3. WebSocket 连接一旦加入房间，就把后续 `start_game`、`action` 等消息关联到该座位；拒绝未加入房间的操作。
4. 每次状态变化后分别生成两个视图，遮蔽对方底牌；洗牌请使用安全随机数。
5. 服务端负责底池和边池、全下、未跟注筹码退回、平局分池、按钮轮换及合法操作范围。

单人模式是本地浏览器游戏，使用 `src/engine.js`；上述 WebSocket 协议只用于在线房间。
