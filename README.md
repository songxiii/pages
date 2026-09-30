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

`p.html#ticket=...` 打开后立即调用 `POST /api/poker/v1/entry`，已有当前账号 access token 时自动附带 Bearer 认证。页面提供三种视图：校验失败/普通成员等待开房时显示对应简单提示；活动创建人通过六项下拉配置调用 `POST /api/poker/v1/rooms`；已有房间时自动连接 WebSocket，认证后渲染当前牌局。牌桌支持 2–9 个座位、本人底牌、公共牌、下注筹码、底池、回合倒计时、发牌与翻牌动画、快捷加注和服务端授权的入座/准备/开局按钮。

活动牌桌去掉品牌标题，菜单显示活动名称；点击虚线空座申请落座，自选房间进入点击座位，随机房间由服务端安排。牌桌仅使用竖屏布局，按屏幕可用高度调整 2–9 人座位；底部仅保留加注入口，点击后在浮层选择快捷金额或拖动金额，再确认提交。左上菜单仅向房主显示开始、暂停和继续游戏；已落座用户通过页面动画弹框确认起身。准备状态显示在座位上，取消准备与带入筹码菜单已接入新协议，服务未授权时显示不可用。带入表示追加筹码，两局之间立即生效，本局中追加由服务端结算后生效。

右上角不再提供问号和全屏。连接错误/关闭仅显示状态并最多自动重试三次，后台网络失败保留牌桌；业务异常弹框可展开对应请求及返回，凭证自动遮盖。房间 ID 不显示。配置、成员、连接放在菜单折叠详情中，技术调试区仅在 `?debug=1` 时显示。开发联调可在调试区填写 token；ticket 保留在 fragment，旧的 query 链接自动转换。取消准备、带入筹码、暂停/继续尚需 Java 补齐，接口字段、事务顺序、幂等与待到账恢复设计见对接说明第 5 节。

空座统一显示“空座”，不展示座位序号；本手位置显示庄位、小盲、大盲及 UTG/UTG+1/LJ/HJ/CO。成员列表显示小头像和累计带入，盈亏仅显示红色 +金额、绿色 -金额或默认颜色 0。

**Java 待实现功能可直接交付 [后端接口设计文档](docs/POKER_BACKEND_TODO.md)**，包含 UNREADY、BUY_IN、PAUSE_GAME、RESUME_GAME 的请求、授权、快照、持久化与验收用例。

**Java 所需字段和消息见 [活动牌桌接口对接说明](docs/ACTIVITY_POKER_API.md)**。新增牌局快照和操作命令已通过模拟服务验证，仍需真实 Java 联调；这个活动 v1 的大写协议与首页演示协议分开。

API 域名配置在 [src/poker-config.js](src/poker-config.js)。如果页面与 Java 服务不同源，服务端需要把页面的精确 HTTPS Origin 配置到 `POKER_ALLOWED_ORIGINS`，并设置 `POKER_WS_PUBLIC_URL`。小程序或宿主应用需把 ticket 放在 URL fragment 中；access token 不应放进 URL。

腾讯云托管当前服务的 `POKER_WS_PUBLIC_URL` 应设为 `wss://springboot-thzo-281960-9-1453811837.sh.run.tcloudbase.com/ws/poker/v1`，不要在公网 WSS 地址中拼接 `:80` 端口。页面兼容修正与 HTTPS API 同域的云托管 `wss://…:80` 地址，显示、复制和连接均使用修正后的公网地址；HTTP 调试区保留服务端原始响应。连接区域显示认证进度及断开的 code/reason。过期的 wsToken 会通过主入口重新获取。
