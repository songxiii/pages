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

## 活动专属入口

`p.html#ticket=...` 对接 Java 服务的 `POST /api/poker/v1/entry` 和 `POST /api/poker/v1/rooms`。页面要求用户输入与 ticket 身份一致的 Bearer access token；令牌仅保留在当前页面内存中。验证后根据服务端返回的状态显示创建房间、等待创建、关闭提示或旁观牌桌。房间页使用服务端提供的 WebSocket 地址和短期 wsToken 完成 `AUTH`，以 `SNAPSHOT` 更新页面，掉线时重新调用入口取得新 wsToken。当前不提供入座、准备和下注操作，因为服务端游戏指令尚未开放。

页面底部的“请求与响应”区展示本次打开后的 HTTP 请求、HTTP 响应和 WebSocket 消息，默认遮盖 ticket、Bearer token 和 wsToken，可手动显示完整凭证。ticket 保留在 URL 的 fragment 中，刷新页面仍可重新验证；旧的 `?ticket=...` 链接会转成 fragment。

API 域名配置在 [src/poker-config.js](src/poker-config.js)。如果页面与 Java 服务不同源，服务端需要把页面的精确 HTTPS Origin 配置到 `POKER_ALLOWED_ORIGINS`，并设置 `POKER_WS_PUBLIC_URL`。小程序或宿主应用需把 ticket 放在 URL fragment 中；access token 不应放进 URL。
