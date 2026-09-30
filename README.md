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

`p.html#ticket=...` 打开后立即调用 `POST /api/poker/v1/entry`。若当前标签页已有 access token，会自动用于身份验证；否则接口返回 401 后提示输入与 ticket 本人一致的 Bearer token。输入的 token 仅缓存在当前标签页的 `sessionStorage` 中，刷新后可再次自动验证。普通成员在房间未创建时看到联系创建人的提示，活动创建人可以选择固定配置并调用 `POST /api/poker/v1/rooms` 建房。已有房间时页面显示房间信息、成员与 `connection.url`，并可用返回的短期 `wsToken` 手动建立 WebSocket 连接。页面顶部显示静态页面版本以及 HTTP/WS 响应顶层的 `systemVersion`；调试区展示脱敏的最近一次请求和响应。ticket 保留在 URL fragment 中，旧的 `?ticket=...` 链接会转成 fragment。

API 域名配置在 [src/poker-config.js](src/poker-config.js)。如果页面与 Java 服务不同源，服务端需要把页面的精确 HTTPS Origin 配置到 `POKER_ALLOWED_ORIGINS`，并设置 `POKER_WS_PUBLIC_URL`。小程序或宿主应用需把 ticket 放在 URL fragment 中；access token 不应放进 URL。

腾讯云托管当前服务的 `POKER_WS_PUBLIC_URL` 应设为 `wss://springboot-thzo-281960-9-1453811837.sh.run.tcloudbase.com/ws/poker/v1`，不要在公网 WSS 地址中拼接 `:80` 端口。页面兼容修正与 HTTPS API 同域的云托管 `wss://…:80` 地址，显示、复制和连接均使用修正后的公网地址；HTTP 调试区保留服务端原始响应。连接区域显示认证进度及断开的 code/reason。过期的 wsToken 会通过主入口重新获取。
