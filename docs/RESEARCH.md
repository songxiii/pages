# GitHub 德州扑克项目调研

检索时间：2026-09-29。GitHub star 数会变化。按“可参考价值”筛选，不直接复制第三方代码。

| 项目 | 检索时 stars | 类型 | 本项目的参考点 |
| --- | ---: | --- | --- |
| [floatinghotpot/casino-server](https://github.com/floatinghotpot/casino-server) | 约 1.2k | Node.js + Redis + Socket.IO 多人牌桌 | 房间与服务端控制流程；仓库较旧，README 也提示不适合直接用于生产 |
| [pokerth/pokerth](https://github.com/pokerth/pokerth) | 约 661 | C++/Qt 桌面游戏 | 德州扑克流程与玩法参考，不能直接部署到 GitHub Pages |
| [goldfire/pokersolver](https://github.com/goldfire/pokersolver) | 约 438 | JavaScript 牌型求解库 | 5–7 张牌牌型判定的对照参考，非完整游戏 |
| [chenosaurus/poker-evaluator](https://github.com/chenosaurus/poker-evaluator) | 约 255 | JavaScript 牌型评估库 | 胜负判断的实现思路，非联机网页 |

高 star 仓库主要是服务端、桌面客户端或牌型库，很少能直接作为“GitHub Pages 前端 + 自有 Java WebSocket 后端”使用。当前网页和本地规则引擎为独立编写；在线房间通过 [WebSocket 协议](WEBSOCKET_PROTOCOL.md) 对接你的 Java 服务。
