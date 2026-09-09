# 独立部署 DealGraph

前提：按项目许可证取得使用权限，准备 Node.js 24、npm 和自己的 Cloudflare 账号。仓库包含完整源码；不需要其他产品仓库或维护者账号。

## 1. 先本地运行

在仓库根目录：

```sh
npm ci
npm run dev
```

打开 **http://127.0.0.1:5174**。开发服务只接受本机同源请求，含模型 API 桥接；请勿把监听地址改成 `0.0.0.0` 后直接当公网服务使用。

无需模型就能使用示范、客户项目记录和加密保存。使用云模型时，仍须在页面输入自己的密钥并同意外发；本地运行不是离线大模型。`npm run preview` 只有静态预览，不挂载完整模型 API。

## 2. 配置自己的可信网址

生产结构：

```text
你的 HTTPS 域名
  → 同一个 Cloudflare Worker
      /api/relationships/* → 本次用户选定的模型服务商
      其他路径             → ASSETS 绑定的 dist/ 静态文件
```

先确定最终网址，再编辑 `wrangler.jsonc`。使用 `workers.dev` 时，在自己的 Cloudflare 账号中确认子域名；选定 Worker 名称后，实际地址通常形如 `https://dealgraph.你的子域名.workers.dev`。不要把这句示例当成可直接使用的真实地址。

必须核对：

| 配置 | 要求 |
| --- | --- |
| `name` | 你的 Worker 名称；应与预期部署网址对应 |
| `vars.APP_ORIGIN` | 手工填写唯一可信 HTTPS 来源，例如实际 workers.dev 地址或自有域名；只含协议和主机，不带路径、查询参数或末尾斜杠 |
| `assets.directory` | `./dist` |
| `assets.binding` | `ASSETS` |
| `assets.run_worker_first` | `true`，先经过同源检查、API 路由与安全响应头 |
| `API_LIMIT` / `GLOBAL_LIMIT` | 保留配置中的限流绑定；缺失时模型接口拒绝处理 |

不要提交维护者的账号 ID、区域 ID、登录令牌或模型密钥。`APP_ORIGIN` 不是请求头自动猜出来的地址；不要改成任意 Origin 通配或信任客户端提供的主机。

使用自有域名时，在自己的 Cloudflare 中为此 Worker 配置 Custom Domain，并将 `APP_ORIGIN` 设置成完全相同的 HTTPS 来源。域名路由、DNS 和证书要先确认归属；不要覆盖已有站点。若只选择自有域名作为可信入口，从 workers.dev 访问被拒绝是正常的来源保护。

## 3. 测试并发布

在仓库根目录运行以下登录命令，使用浏览器完成自己的 Cloudflare 授权：

```sh
npx wrangler login
```

确认账号和可信网址配置无误后运行：

```sh
npm test
npm run deploy:check
npm run deploy
```

`npm test` 包含离线测试与图谱渲染检查；`deploy:check` 先构建再执行不发布的打包检查，`deploy` 先构建再正式部署。也可单独运行 `npm run build`。

Wrangler **4.92.0** 由项目固定版本依赖提供，按锁文件通过 `npm ci` 安装，不另用全局旧版或未经验证的 `latest`。登录令牌是部署凭据，不是客户的模型密钥。

发布内容是 Worker 程序与 `dist/` 资产，前后端随同一部署更新。不要单独把 `dist/` 放到静态托管后声称模型也已部署；没有 API 后端时页面可显示，但不能完成发现或关系分析。

`public/` 会进入静态构建并公开。这里只放审核过的文档、样例和演示视频：

- `public/demo/dealgraph-demo-zh.mp4`、同名 `.srt`、海报。
- `public/examples/wechat-noisy.synthetic.json`、`demo-workbench.dgvault`。

不得放入客户聊天、个人工作台、真实评测原始输出、API 密钥、密码、日志或临时诊断文件。源码仓库也不提交 `.env`、`.dev.vars`、`node_modules` 等运行数据。

## 4. 不配置站长共享模型 key

此服务采用 BYOK：客户在页面选择服务商和模型，临时输入自己的 API 密钥，分别确认节点发现和关系分析。不要执行 `wrangler secret put OPENAI_API_KEY` 来提供共享额度，也不要把模型密钥写进前端构建变量。

API 密钥仅用于本次所选服务商的固定官方端点，不支持任意 base URL，不自动换服务商或重试收费请求。程序不持久化材料与密钥，不代表 Cloudflare 或模型服务商零保留。请保留页面中的上传同意、数据政策和费用说明，不因部署到内网就移除它们。

## 5. 发布后验收

1. 从 `APP_ORIGIN` 指定的网址打开，确认四个中文入口、静态资源、字幕视频和全虚构样例可用。
2. `/api/relationships/status` 返回 JSON，不是静态 HTML；前后端契约匹配。
3. 无 key、未同意、错误 Origin、过期客户端被拒绝，且不产生模型调用。不要用真实密钥检查拒绝分支。
4. 在页面用虚构文件检查范围／隐私预览、人工名单确认、取消和恢复；检查手机布局与文件下载。
5. 如需真实模型验收，另获用户同意，仅用小规模虚构数据，记录请求次数与结果。网络可达不代表密钥有效、余额充足或关系分析成功。

记录源码提交、Worker 版本、实际域名、测试时间与未测项目后，再宣布上线。更改域名时同步修改 `APP_ORIGIN` 并重新部署、验收；不要通过关闭同源校验解决错误来源。

## 常见问题

- **首页可开但模型不可用**：确认不是 `preview` 或纯静态部署，检查 `ASSETS`、API 路由、限流绑定和前后端契约。
- **提示来源不合法**：对照地址栏与 `APP_ORIGIN`，包括 HTTPS、完整主机和端口；不要直接放宽校验。
- **检测连接可达但调用失败**：再检查所选服务商 key、地区权限、余额及模型权限；检测连接不收费，也不验证这些条件。
- **本地网络需代理**：仅在已开启可信本机代理时，使用 `DEALGRAPH_LOCAL_PROXY=http://127.0.0.1:实际端口 npm run dev`。不接受远程代理或代理密码，不关闭 TLS 校验；此设置不进入生产 Worker。
- **视频不能播**：核对 MIME 类型和同源媒体 CSP；不要为视频放开任意脚本或任意联网来源。

回滚使用匹配的前后端版本和静态资产，保留原域名与授权边界。恢复代码不需要清空用户浏览器或删除已有加密文件。
