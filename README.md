# 开一局

面向中文熟人小群的多人网页游戏平台。根据《开一局 MVP 产品需求文档 v0.1》启动，当前交付第一条可运行链路：**成语炸弹的建房 → 邀请 → 准备 → 对局 → 结算 → 原房间复玩**。

## 本地启动

环境：Node.js 24 或更新的兼容版本、npm。SQLite 使用 Node 内置模块，无需另装数据库。

```bash
npm install
npm run dev
```

打开 **http://localhost:3000**。停止服务按 `Ctrl+C`。

两人联调：用两个不同浏览器，或一个普通窗口加一个无痕窗口。创建房间后复制链接，在另一个浏览器中加入并准备，房主点击开始。同一浏览器的普通标签页共享访客身份，新页面会接管旧页面，不会变成第二个玩家。

默认端口：入口 `3000`、Next.js `3001`、游戏服务 `3002`；仅监听本机。按需复制 `.env.example` 为 `.env`，配置端口、入口 Origin 与 SQLite 路径。入口代理负责同源 HTTP 和 WebSocket 转发；不要直接访问 `3001` 玩游戏。

## 当前实现

- Next.js + React + TypeScript，独立 Node.js / Socket.IO 游戏服务。
- 32 字节随机访客凭证，HttpOnly / SameSite Cookie；SQLite 只保存凭证哈希。
- 6 位随机房间码，最多 8 人，昵称校验与重名序号、房主权限、准备和开局倒计时。
- 成语炸弹：2 条生命、12/9 秒固定回合、180 秒整局上限、词库判题、重复答案限制。
- 服务端单调时钟与同步命令处理，actionId 幂等、载荷冲突拒绝、旧回合拒绝。
- 1 秒正确反馈、2 秒失误反馈、淘汰、观战、结算、同房复玩。
- 断线保留席位 30 秒，不暂停计时；超时移除、房主转移、重连全量快照。
- 同一访客只有一个控制连接，旧连接只读；基础 Origin 检查和限流。
- 私人邀请入口、复制失败时手动复制、中文输入法 Enter 防误触、手机竖屏布局。
- 本地 SQLite 记录部分核心事件和主动反馈，30 天清理。

## 扩展词库与发布边界

**当前是开发试玩版本，不是完成全部 PRD 验收的发布版。**

当前使用 `content/idioms.generated.json`，包含 **29,503 条可判定词条**。其中 29,502 条来自固定版本的 `pwxcoo/chinese-xinhua` 四字词条，另保留原样本中上游缺失的“心想事成”。“不拘一格”“水天一色”均已收录。

答案库与难度配置分开：`content/idioms.seed.json` 中的 120 条常用词用于筛选 10 个题面，其余收录词同样可判为正确。每次出题要求仍有至少 8 个未使用的常用答案，避免靠生僻词凑出题门槛。旧样本 `idioms.v0.1.json` 保留用于稳定旧词条 ID 和兼容补词。

上游原始文件、Git 提交号、SHA256 和许可证保存在 `content/sources/chinese-xinhua/`。导入会排除非四字记录、去重、检查别名冲突，并生成 `content/import-report.json`。当前未逐条人工复核；上游仓库声明 MIT，但也说明内容采集自网站，原始数据授权仍待确认。当前作为本地开发词库，不宣称完整或权威。维护步骤见 [词库维护](docs/CONTENT.md)。

缩写炸弹、谁最像暂时关闭，符合需求文档“先打通一款”的开发顺序。分享卡片与预设表情暂降级为复制邀请。

发布前需要完成词条复核、30 个可用题面、来源及授权确认、禁用内容审核；`npm run content:release` 当前**应当失败**，正式模式也会阻止启动未审核题库。导入数量增加不代表完成审核。

尚未完成：完整传播及回访指标、inviteId 归因、完整指标看板、备份运维、25 房间 / 200 连接压测、跨浏览器和微信实机验收。首版规则和后续工作详见 [项目状态](docs/PROJECT_STATUS.md)。

## 检查与联调

```bash
npm run typecheck       # 前后端 TypeScript 检查
npm run content:build   # 从固定原始数据、常用词及补词配置离线生成题包
npm run content:check   # 来源校验和、重建一致性、题包结构与常用覆盖校验
npm test               # 游戏边界、权限、内容和持久化自动化测试
npm run build          # Next.js 构建 + 游戏服务编译
npm run check          # 以上检查集合
```

先运行 `npm run dev`，再在另一个终端运行真实 Socket.IO 联调：

```bash
npm run test:integration
```

联调使用独立访客与真实连接，覆盖建房、加入、准备、开局、答题、幂等、观战、结算、复玩和连接接管。可用 `TEST_ORIGIN` 指向自定义本地入口。它不会替代人工浏览器验收。

## 代码结构

```text
app/                  页面、客户端交互、响应式样式
shared/protocol.ts    前后端公共类型及错误文案
server/engine.ts      房间与 Bomb Engine 权威状态机
server/content.ts     题包加载、prompt → answerId 索引及校验器
server/index.ts       HTTP、Socket.IO、身份鉴权、快照投影与基础限流
server/store.ts       SQLite 访客凭证哈希、事件和反馈
content/              固定来源、生成题包、常用词配置、补词/纠错及导入报告
scripts/              开发入口代理、内容校验与协议集成测试
tests/                引擎和持久化测试
docs/                 当前实现边界与后续排期
```

## 数据与运行方式

房间、对局及幂等回执保存在单进程内存，重启会丢失房间。客户端会显示结束原因并允许重新建房；不支持多实例或无损恢复。访客哈希、事件与反馈保存在 `data/kaiyiju.sqlite`（已忽略提交）。当前备份未自动化，后续部署需使用 SQLite 在线备份方案，并同时考虑 WAL 文件。

浏览器 localStorage 只保存昵称；凭证不可被脚本读取。默认不保存每次原始答案，反馈是用户主动提交。SQLite 自动清理过期凭证以及 30 天前的事件、反馈。

审核内容准备好后可以 `npm run build`、`npm start`。正式环境仍需单区域部署、同域 HTTPS/WSS、TLS 反向代理及正确的 `APP_ORIGIN`；Secure Cookie 仅在 HTTPS 下工作。本轮没有发布外网服务。

## 技术参考

- [Next.js 安装文档](https://nextjs.org/docs/app/getting-started/installation)
- [Socket.IO 交付保证](https://socket.io/docs/v4/delivery-guarantees/)
- [Socket.IO 反向代理](https://socket.io/docs/v4/reverse-proxy/)
