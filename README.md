# 桌边 · 德州扑克

GitHub Pages 网页地址：[https://songxiii.github.io/pages/](https://songxiii.github.io/pages/)

这是双人德州扑克网页游戏。**单人练习**在浏览器本地运行，可以立即与电脑对战；**在线房间**通过你的 Java WebSocket 服务运行，所有房间、发牌、回合、下注和筹码计算由后端控制。前端已经提供创建房间、房间码加入、邀请链接、操作发送、状态渲染和断线重连接口。Java 服务接入前，在线房间无法创建。

## 本地运行

无需安装依赖。进入仓库目录后运行：

```bash
python3 -m http.server 8000
```

打开 [http://localhost:8000/](http://localhost:8000/)；规则测试运行 `npm test`。

## 对接 Java 后端

1. 阅读 [WebSocket 消息协议](docs/WEBSOCKET_PROTOCOL.md)，让 Java 服务实现这些 JSON 消息。
2. 将 [src/config.js](src/config.js) 里的 `POKER_WS_URL` 设成公网 `wss://` 地址，例如 `wss://poker.example.com/ws/poker`；也可先在网页“联机服务设置”手动填写，方便联调。
3. 确保 HTTPS 页面能访问该 WSS 地址，Java 服务校验并允许 `https://songxiii.github.io` 这个 Origin。房间状态必须按玩家分别发送，不能泄露对方底牌或牌堆。
4. 推送到 `main` 后 GitHub Pages 会更新网页。需要在中国大陆稳定访问时，建议给前端和 WSS 服务配置你自己的域名并实测目标网络。

GitHub 项目调研见 [docs/RESEARCH.md](docs/RESEARCH.md)。

仅供娱乐与学习。游戏筹码不具有现金价值。
