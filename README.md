# dsh-desktop-bridge

在屏幕**右下角**弹 Windows 系统通知：会话**需要你确认**时一条，**任务完成**时一条，**执行失败**时一条。

一个插件搞定，没有配套桌面程序、没有第二个端口、没有发现文件、没有要手动启动的东西。

## 为什么是这三类时机

DSH 页面里的确认面板只在你**正看着 DSH** 时才有用。真正会丢消息的情况是反过来的——你在别的窗口忙，会话卡在等你批准，或者已经跑完了、甚至已经报错了，而页面在后台。

所以这里只在三个**边沿**上打扰你：

- **需要你确认**：`pendingInteraction` 从无到有。`kind` 有 `approval`（批准操作）、`plan-review`（确认计划）、`question`（回答问题）三种，通知正文会写明是哪一种。
- **任务完成**：`running` 从 true 变 false，且这一轮没有报错。也看 `completionUnread`，但它**只对非主视图的会话**设置，只看它会漏掉「你正看着它跑完」这个最常见的情况。
- **执行失败**：同一时刻，但这一轮**真的出错了**。失败的轮次不会产出任何东西，通常还等着你重试，把这种结局叫作「任务已完成」是纯粹的误导——用户会以为活干完了。

### 失败是怎么认出来的

`uiSession.sessionStatus` 的快照只有 `{running, pendingInteraction, completionUnread}` 三个字段，**没有失败位**：干净跑完和报错停掉在它看来一模一样。所以失败信号来自客户端的另一条事件通道 `api-session/error`（宿主由 agent 循环的 `agent/error` 转发而来，每个真正失败的轮次一条，带错误文本）。

关键是它**只在真出错时发射**：用户自己按停止不会产生 `agent/error`（那条路径走 `aborted`），因此「你主动中断」不会被误报成失败。浏览器端收到错误就按会话记一笔，等随后的 `running → idle` 边沿到来时取用一次：

- 新的一轮开始时清掉旧记录，避免上一轮的失败给下一轮的健康收尾染色；
- 记录超过 2 分钟就作废，避免一个与轮次无关的错误（比如后台激活失败）在很久之后才误伤一次正常完成。

失败通知**永远不受焦点门控影响**：页面会把错误显示在对话里，而那正是走开的人不会看的地方。

### 一轮只弹一次

`running → idle` 和 `completionUnread` 说的是同一件事，但它们**不是同一瞬间变真的**：宿主在 idle 边沿之后才把这个标记落下去。所以同一轮会先后命中两个分支，弹出两条提示：

```
06:21:04  任务已完成 | 「删除会话插件来源」 已执行完毕：任务已完成
06:21:24  任务已完成 | 「删除会话插件来源」 已执行完毕：后台任务已完成
```

浏览器端因此维护一个「这一轮已经报过收尾」的集合：任一分支报过就不再报，只有新的一轮（`running` 由 false 变 true）才重新武装。这也顺带解决了「刷新页面时把已经完成的会话重播一遍」——首次观测到且已 idle 的会话直接算作已报过。

首次观测到的会话只记基线不通知，否则一刷页面就会把所有在等的会话重播一遍。同一会话同一类型还有冷却，避免状态反复发布把提示刷屏。

## 架构

```
浏览器渲染进程                        宿主进程（DSH 自己）
──────────────                       ─────────────────────
uiSession.sessionStatus  +  api-session/error
   │ 订阅、比对、取边沿（前者给时机，后者给成败）
   ▼
POST /__dsh-desktop-bridge/ingest
   │（同源，带 Bearer token）
   └───────────────────────────► 路由 → 调度器 → Toast
                                  （去重/免打扰/限流/AUMID）
```

会话状态只存在于**渲染进程**（`ui-session` 的宿主半边是个空 `apply() {}`），而发系统通知只能在**宿主进程**里做。所以两边必须有一次进程内通信——这就是那条 HTTP 路由的由来。

两条信号分工明确：`sessionStatus` 说「什么时候结束」，`api-session/error` 说「结束得体不体面」。后者不能替代前者（它只在出错时发，干净跑完时什么都不发），前者也替代不了后者（它没有失败位）。

路由挂在 **DSH 自带的 web 服务器**上（`ctx.webServer.register`），不另开端口。浏览器端是同源请求，没有 CORS。

## 文件

| 路径 | 职责 |
|---|---|
| `lib/client.js` | 浏览器半边：订阅 `sessionStatus` 取边沿、订阅 `api-session/error` 判成败、POST 事件 |
| `lib/index.js` | 宿主入口：注册路由、注入 token、生命周期 |
| `lib/ingest.js` | 路由处理：鉴权、限体积、把载荷规范化成事件 |
| `lib/notifier.js` | 事件 → 通知：调度器、AUMID 预热、销毁 |
| `lib/host/toast.js` | 常驻 PowerShell 5.1 工作进程发 toast（预热后 0 延迟） |
| `lib/host/dispatch.js` | 去重、免打扰时段、焦点门控、限流 |
| `lib/host/aumid.js` | 注册 AUMID，让通知标题显示为「DSH 任务提醒」 |
| `lib/host/activate.js` | 把 DSH 窗口拉到前台（点通知时用） |
| `lib/host/state.js` | 日志与 `settings.json` |
| `lib/host/ps.js` | 守护式调用 PowerShell 5.1（PS 7 没有 WinRT，硬约束） |

## 路由

| 路由 | 认证 | 用途 |
|---|---|---|
| `POST /__dsh-desktop-bridge/ingest` | Bearer token | 浏览器端上报事件 |
| `GET /__dsh-desktop-bridge/health` | 无 | 存活探测 + 各阶段计数 + 本进程接受的 kind，不泄露任何内容 |
| `POST /__dsh-desktop-bridge/probe` | Bearer token | 仅在 `debug` 开启时：浏览器端把每次状态发布的内容记进日志 |

"同源"不等于"可信"——本机任何进程都能连 127.0.0.1。所以宿主每个进程随机生成一个 token，用 `webserver/index-inject` 注入进 index.html，`/ingest` 要求它作 Bearer 凭证，随进程消亡。

```js
globalThis.__DSH_DESKTOP_BRIDGE__ = {
  token: "…",
  protocol: 1,
  kinds: ["waiting", "done", "failed"],  // 宿主认得哪些 kind
  debug: false,
}
```

每次渲染 index 都会重新注入，刷新页面后 token 不会失效。

`kinds` 是给「页面已经刷新、宿主还没重启」这段窗口准备的：浏览器端只发宿主声明支持的 kind，碰到不认识的就跳过并在控制台留一行，绝不把 `failed` 降级成 `done`。详见「已知边界」。

## 事件格式

```json
{
  "v": 1,
  "kind": "waiting",
  "sessionId": "abc123",
  "title": "重构登录模块",
  "detail": "等待你确认计划",
  "at": 1792206130837,
  "dedupeKey": "waiting:abc123:1792206130"
}
```

`dedupeKey` 由宿主按 `kind:sessionId:秒` 盖出来，浏览器端只管发前五个字段——重复投递由宿主识别。

`kind` 有三种取值：

| kind | 含义 | 正文 |
|---|---|---|
| `waiting` | 会话卡在等你动手 | 需要你确认 · `「会话」正在等待你的操作：<等待你干什么>` |
| `done` | 这一轮干净跑完 | 任务已完成 · `「会话」已执行完毕：任务已完成` |
| `failed` | 这一轮报错停掉 | 任务失败 · `「会话」执行出错了，需要你处理：<错误首行>` |

`failed` 的 `detail` 是错误信息的第一行，超过 120 字截断——堆栈和多段散文在通知里都读不了。

`title` 取 `sessions.list` 的行投影，无标题时退化为 `会话 <前8位id>`。

`isMain` 由浏览器端补上（该会话是否正占据主视图）。宿主看得见窗口，但只有页面知道屏幕上摆的是哪个会话，焦点门控需要这一位——否则「你在看 DSH」会连带压掉其它会话的完成提醒。

## 提醒规则（`lib/host/dispatch.js`）

按顺序判定，先命中先返回：

1. **去重**：最近 200 条 `dedupeKey` 命中即丢弃
2. **免打扰**：`quietHours` 内只记日志
3. **焦点门控**（默认关闭）：**只门控 `done`**，且只在「该会话正是主视图那一个 + DSH 在前台」时压掉；`waiting` 和 `failed` 从不门控——等待需要你动手、失败需要你重试，都跟你在看什么无关
4. **限流**：同类最小间隔 3 秒，超限的攒成一条摘要（「另外 2 个会话也在等你」）

设置写在 `%LOCALAPPDATA%\dsh-desktop-notifier\settings.json`（改完重启 DSH 生效）：

```json
{
  "throttleMs": 3000,
  "suppressWhenFocused": false,
  "quietHours": { "enabled": false, "from": "23:00", "to": "08:00" },
  "debug": false
}
```

`suppressWhenFocused` 默认 **false**：一轮任务结束时页面本身不给任何提示，这正是这个插件存在的理由——默认静音会把它变成一个看起来坏掉的功能。`debug` 打开后浏览器端会把每次 `sessionStatus` 发布的快照 POST 到 `/probe`，用来判断「渲染进程到底有没有看见这次状态变化」。

## 没弹窗怎么查

日志在 `%LOCALAPPDATA%\dsh-desktop-notifier\notifier.log`，一条事件的完整生命线都会留下痕迹：

| 日志 | 含义 |
|---|---|
| 完全没有 `ingest:` | 事件没离开浏览器（渲染半边未订阅上，或 token 没注入） |
| `auth: POST /ingest rejected` | token 不匹配，通常是页面缓存了上一个进程的 token，刷新即可 |
| `ingest: done "…"` + `dispatch: shown` | 已交给系统，问题在 Windows 通知设置/专注助手 |
| `dispatch: suppressed (…quiet hours…)` | 免打扰窗口命中 |
| `dispatch: suppressed (…on screen and DSH is focused…)` | 焦点门控命中，把 `suppressWhenFocused` 改回 `false` |
| `dispatch: throttled` | 3 秒限流，事件攒成了摘要 |
| `dispatch: duplicate` | 同一事件重复投递，正常情况下不该出现 |
| 失败的一轮弹了「任务已完成」 | `api-session/error` 没到达渲染进程：控制台应有 `[desktop-bridge] cannot subscribe to api-session/error` |

第三种（`failed`）如果始终不出现，先确认 `lib/client.js` 的 `inject` 里有 `remote`——`api-session/error` 走这条通道，缺了它就只能退回「一律当作完成」。

`GET /__dsh-desktop-bridge/health` 用计数器把这几段分开：`received`（到达宿主）→ `shown`（真的弹了）/ `suppressed`。它还返回 `kinds`，也就是**这个宿主进程真正接受的 kind 列表**——刷新页面不用重启就能换浏览器半边，所以「我页面上是新的，宿主是不是旧的」是个真问题，答案就在这里：

```powershell
(Invoke-RestMethod http://127.0.0.1:4814/__dsh-desktop-bridge/health).kinds
# ["waiting","done","failed"]  -> 宿主已跟上
# ["waiting","done"]           -> 宿主还是旧的，失败那一轮会保持安静，重启 DSH
```

## 已知边界

- **没有逐条 todo 清单。** `todos` 是 session 作用域的 keyed projection，只有会话内的对话视图能读，这里拿不到。通知只能给会话级信号。
- **失败按「轮次」而不是按「错误」报。** 一个轮次里连续报错多次只会在收尾时提示一次，正文取最近一次的错误信息。
- **`title` 依赖投影就绪。** 会话刚建立时投影可能还没算出来，此时标题退化为 id 片段。
- **事件不落盘。** 通知是即时的，补发过时通知只会制造噪音。
- **通知标题「DSH 任务提醒」来自本机 AUMID 注册**，不是插件名。
- **Windows 专属。** toast 走 WinRT，只有 Windows 有。
- **两半不同步。** 刷新页面就换上了新的 `lib/client.js`，而 `lib/index.js` 要重启 DSH 才换。宿主注入的 `__DSH_DESKTOP_BRIDGE__.kinds` 声明它会收哪些 kind：页面碰到宿主还不认识的 kind 就不发（只在控制台留一行提示），**不会**降级成 `done`——把失败说成「任务已完成」正是要修的那个 bug。所以刚升级完、还没重启时，失败那一轮是安静的；重启后立刻恢复。想知道当前运行中的宿主是哪一版，读 `/health` 的 `kinds` 即可。
- **失败提醒只在「轮次收尾」出现。** 依赖宿主转发的 `api-session/error`，它在 agent loop 里由 `throwError` 发出，早于 `running → idle` 的相位切换；用户主动停止（`aborted`）不发这个事件，所以停止不会被报成失败。

## 出错时的行为

所有失败路径都只记日志、不抛异常。插件起不来**绝不能**拖垮 DSH——`apply` 抛错会触发红色「Failed to load plugins」横幅，还会连累同一 profile 的其它插件。

同样地，`lib/client.js` 必须保持 `window.__ModuleLoader__.load({ id, factory })` 的经典脚本信封：一个顶层 `export` 就会让渲染进程抛 `Unexpected token 'export'`，导致整个 web boot 失败（`web boot: 1 entry did not activate`）。这是本项目真实踩过的坑，`test/contract.mjs` 专门守着它。

## 兼容性

插件只依赖五个宿主/客户端 API，全部按 **0.2.2-rc.5 的已装源码逐个核对**（不是照文档猜的），宿主半边另在真实 cordis 4.1 运行时上跑过一遍 apply → 注入 → dispose 全生命周期。行为契约由 `test/contract.mjs`（23 项）、`test/defaults.mjs`、`test/host-apply.mjs`（16 项）与 `test/runtime.mjs`（9 项，跑在真实 cordis 上）覆盖。

| 依赖的 API | 用途 | 在 0.2.2-rc.5 上核对结果 |
|---|---|---|
| `webServer.register({kind, path, handler})` | 注册三条路由 | 仍在，冲突时仍抛 `webserver: duplicate ${kind} route "<path>"`（本插件用 `kind:'exact'`），仍返回 disposer |
| `webserver/index-inject` 事件 | 把 token 注入 index.html | 签名自 rc.1 起为 **`(table, peer)`**：`collectIndexInjections()` 里是 `this.ctx.emit("webserver/index-inject", table, peer)`。多出来的 `peer` 对本插件无意义（token 认证的是路由，不是 Peer），监听器只读第一个参数 |
| `uiSession.sessionStatus` 快照 | 取 `running` / `pendingInteraction` / `completionUnread` 边沿 | 三个字段名与含义未变，`publishStatus()` 结构逐字一致；`pendingInteraction` 仍是带 `kind` 的类实例（`approval` / `plan-review` / `question`） |
| `sessions.list` 的 `retainedBy.mainView` | 判断会话是否在主视图 | 仍在，`isMain()` 仍按 `retainedBy.mainView` 判定 |
| `remote.$on("api-session/error", (sessionId, message)")` | 判定失败 | 仍在 `API_REMOTE_FORWARDED_EVENTS` 白名单里（`mode:'emit'`，`resources.session`），`$on` 签名未变（`message` 为 stringified error） |

### 0.2.2 上真正踩到的一处

这一处不是「文档说是这样」，是**在真实 cordis 4.1 上跑出来**的：

**`ctx.logger` 上根本没有 `.log`。** 它是可调用的 logger 服务，方法只有 `error` / `warn` / `info` / `debug`。旧代码按 `['info', 'log']` 依次找，找到 `info` 就 `return`，表面上「有日志」，实际全进了宿主控制台——而**打包后的桌面版宿主子进程没有挂控制台**，于是 `notifier.log` 里连一条 `ingest:` 都没有（历史日志实测：`toast:` 250 条，`ingest:` 0 条）。这也让 README「没弹窗怎么查」那张表**失效**：表里让你 grep 的 `ingest:` / `dispatch:` / `auth:` 三种行，当时一条都写不进文件。

现在 `log()` 同时写两处：`notifier.log`（README 让你读的那个文件）+ cordis logger（DSH 自己的启动诊断）。修复后同一台机器实测：`ingest:` 与 `dispatch:` 各 192 条，`auth:` 5 条，三种 grep 目标全部落地。

### 关于 `ctx.off`：一个需要澄清的说法

cordis 4.1 的事件 mixin 只有 `on` / `once` / `parallel` / `emit` / `serial` / `bail` / `waterfall`，**没有 `off`**（4.0.4 与 4.1.0 都一样，已实测 `typeof ctx.off === 'undefined'`）。旧代码的退订写成：

```js
bus.on('webserver/index-inject', listener)
disposers.push(() => bus.off?.('webserver/index-inject', listener))  // off 不存在 → 这行什么也没做
```

这段代码后来被改成使用 `on()` 返回的 disposer，当时的说明是「监听器会活过 dispose」。**这个说法是错的**，已更正：cordis 在 `register()` 内部用 `this.ctx.fiber.effect(...)` 把每个监听器绑到 fiber 上，fiber 销毁时 hook 会被自动移除。实测把服务挂在独立 fiber、用旧写法跑 apply → dispose，hook 数量是 `0 → 1 → 0`，并没有泄漏。

所以旧写法的真实缺陷是**退订路径是死的**，而不是泄漏：

- `bus.off?.(...)` 是一次静默失败，代码看起来做了清理，实际什么都没做；
- 它在今天不出事，完全依赖「宿主会销毁那个 fiber」这一隐含前提；
- 一旦宿主不销毁 fiber（或被别处复用），漏掉的就会是真的泄漏。

改成 `on()` 返回的 disposer 是**正确形式**而非「修了一个正在发生的 bug」：它显式、不依赖 fiber 生命周期、并且 `off` 链到 `undefined` 时不会伪装成功。`test/runtime.mjs` 把这条钉住了。

**验证过的版本**：`@deepseek-ai/dsh` 0.2.2-rc.5（DeepSeek Harness 0.2.2-rc.5，Electron 44.7.0，cordis 4.1.0，Node 24.21.0）。

0.2.2-rc.5 上除此之外的核对结论（均**不需要改代码**）：

- `webServer` 新增 `resource` 型路由与 `registerFallback({resource})`、`readResource()`、`serveResource()`；插件用的是 `handler` 型 `exact` 路由，语义与 disposer 都没变。
- `client-modules` 新增包内 `./assets/*` 资源路由（`/plugins/<pkg>/assets/<path>`）与按 Loader entry 名的增量对账；插件只暴露一个 `client.js`，不受影响。
- `client-ui-session` 的客户端 `inject` 多了 `remoteAccess`、`apply()` 走 `ctx.slots.provideRoot(...)`；插件只读 `ctx.uiSession.sessionStatus`，不受影响。
- `api-remotes` 的白名单新增 `llm/models-updated`、`plugin-manager/update-state`；`api-session/error` 条目逐字未变。
- `api-gateway` 客户端把 `privateEvents(ctx)` 从返回 `ctx` 改成返回 `ctx.events`（`$on` 的落点），对外签名不变。

### 上一轮（0.2.1-rc.5）的核对结论

rc.3 → rc.5 之间那五个面**无需改代码**，rc.5 上的实测结论也仍然成立：

- 宿主半边：`GET /__dsh-desktop-bridge/health` 返回 `kinds:["waiting","done","failed"]`；`test/host-apply.mjs` 全过并真的弹出两条通知。
- 浏览器半边：运行中页面的 combo URL `dsh-app://app/plugins/??…,dsh-desktop-bridge/client.js&rev=…` 已包含本插件，Code Cache 有对应编译产物。
- 真实投递：`notifier.log` 记录了升级后的「任务已完成」通知实际送达。

rc.3 里与本插件相关、但**不影响行为**的变化，升级时不必改代码：

- `webServer` 的 Config 收紧：`host` 必须是具体 IP 字面量（不再接受 `0.0.0.0`），并新增 `tls` 配置与 `getOrigin()`/`protocol`；插件只用 `register`，不受影响。
- `client-modules` 的 bundle 路由开始拒绝 `client.node.js` 之类的包内 chunk，且 bundle 改为异步读取；插件只暴露一个 `client.js`，不受影响。
- `dsh-desktop-host` 改为 `--host 127.0.0.1 --port 0`（端口每次随机），URL 用 `webServer.protocol` 拼；`/health` 仍从 DSH 自带 web 服务器读出实际端口。

DSH 升级后如果通知失灵，先跑 `/health` 看 `kinds`；再对照上表看哪个 API 变了。升级最容易打破的三个点：

1. `sessionStatus` 快照字段改名或增删 → 页面永远算不出边沿，`received` 一直不涨
2. `api-session/error` 改事件名或参数顺序 → 失败退回「一律报完成」
3. **`?.` 吞掉不存在的方法。** `ctx.off?.()` 看着跑了，实际什么都没做；`ctx.logger.log` 被 `['info','log']` 的短路绕开，日志全进了没人在看的地方。手读源码很难发现，`test/runtime.mjs` 在真实 cordis 上跑 apply 就是为了让这类调用抛出来。
4. **两半不同步。** 刷新页面就换了新的 `lib/client.js`，而 `lib/index.js` 要重启 DSH 才换——日志证据也来自重启之后（`ingest:` 从 0 条变 192 条）。

## 任务清单

维护一个功能时可以直接照着走：

- [x] **基础提醒**：会话需要确认 / 任务完成时弹 Windows 系统通知
- [x] **合并为单插件**：合并掉旧的双进程架构，无配套进程、无第二端口
- [x] **完成提醒默认不被静音**：`suppressWhenFocused` 默认 false（踩过：默认 true 让功能看起来完全坏掉）
- [x] **失败不再冒充成功**：接 `api-session/error`，失败的一轮弹「任务失败」
- [x] **两半版本不同步的保护**：宿主声明 `kinds`，页面不向旧宿主发它不认识的 kind（宁可不弹，不弹错）
- [x] **`/health` 可查宿主版本**：返回 `kinds`，把「宿主是新是旧」变成一次 GET
- [x] **一轮只弹一次**：修掉 `completionUnread` 晚到导致的重复提示
- [x] **真实失败轮次现场验证**：`06:20:59 toast: 任务失败 | 「问候交流」…：fetch failed`
- [x] **适配 0.2.1-rc.2**：逐个核对五个 API 面，均未变
- [x] **适配 0.2.1-rc.3**：五个 API 面按 rc.3 源码重新核对，均未变；同时把兼容性表里写错的冲突文案（实际是 `duplicate <kind> route`）和「四个 API」的笔误改正
- [x] **适配 0.2.1-rc.5**：五个 API 面按 rc.5 源码重新核对，均未变；运行中进程 `/health` 正常、页面 combo URL 已含本插件、`notifier.log` 记录升级后的真实送达
- [x] **适配 0.2.2-rc.1**：`ctx.logger.log` 不存在导致诊断行只进控制台、`notifier.log` 永远是空的（改为文件 + logger 双写，README 的排查表恢复有效）；`webserver/index-inject` 新签名 `(table, peer)` 已兼容。`ctx.off` 那条另见 rc.2 的更正——退订路径确实是死的，但没有造成泄漏
- [x] **适配 0.2.2-rc.2**：五个 API 面逐字节 diff 确认未变。新增 `test/runtime.mjs`（9 项）——在**真实 cordis 4.1** 上跑 apply → 注入 → dispose，任何调用不存在的方法都会当场抛错。同时更正上一轮夸大的说法：`ctx.off?.()` 的退订路径确实是死的，但监听器**并没有**泄漏，cordis 在 `register()` 内部用 fiber effect 兜住了（实测 hook 数 `0 → 1 → 0`）
- [x] **适配 0.2.2-rc.5**：五个 API 面按 rc.5 源码重新核对，全部未变，插件代码无需改动。核对基准是 npm 权威发布包（rc.2 与 rc.5 逐字节 cmp），并用 SHA256 反验本机 app.asar 提取物与 npm 包逐文件一致（10155 个文件全过），避免拿偏移量算错的提取结果当基准。`test/runtime.mjs` 在 rc.5 的 cordis 4.1 上 9 项全过；运行中实例 `/health` 正常（received/shown 各 15 次），`notifier.log` 里 `ingest:` 380 条、`dispatch:` 384 条
- [ ] **可选：点通知跳回对应会话**（当前只把 DSH 窗口拉到前台，不定位会话）
- [ ] **可选：会话标题变化时更新去重键**（当前同秒同名事件会被去重）

## 测试

```bash
node test/contract.mjs    # 浏览器半边：信封格式、inject 完整性、边沿行为（含失败判定、一轮一次）
node test/defaults.mjs    # 默认值与路由命名：默认静音这类回归由它守着
node test/host-apply.mjs  # 宿主半边：路由注册、token 注入、鉴权、去重、kinds 声明
                          # 会真的弹两条通知，这是刻意的
node test/runtime.mjs     # 在真实 cordis 上跑 apply → 注入 → dispose（见下）
node scripts/check-bundle.mjs    # bundle 静态契约
node scripts/verify-profile.mjs  # profile 接线是否完好
```

`test/runtime.mjs` 需要一个能解析到 `@deepseek-ai/cordis` 的目录，因为它的全部价值就在于用**真的** cordis 而不是 mock：

```bash
# 指向装好的 DSH 运行时（node_modules/@deepseek-ai/cordis 所在目录的上一级）
DSH_CORDIS_ROOT=/path/to/workspace node test/runtime.mjs
```

找不到 cordis 时它会打印一行说明并以 0 退出——裸检出仍然能跑其余测试，但它**不算通过**，别把跳过当成绿灯。这个文件是唯一能抓住「调用了 cordis 没有的方法」的测试：mock 会配合插件返回任何东西，真实运行时不会。

## 安装

```json
// <profile>/package.json 里
"dependencies": { "dsh-desktop-bridge": "link:D:/Workspace/DeepSeek Harness/dsh-desktop-bridge" },
"dsh": { "profile": { "bundles": ["…", "dsh-desktop-bridge"] } }
```

```yaml
# <profile>/cordis.patch.yml 里
- insert:
    - id: dsh-desktop-bridge
      name: dsh-desktop-bridge
```

改完需要重启 DSH（宿主半边不会热加载）。

## 许可

MIT
