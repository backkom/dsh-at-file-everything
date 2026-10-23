# dsh-at-file-everything

为 Windows 上的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供秒级的 `@文件` 补全，数据来自 [Everything](https://www.voidtools.com/) 的索引，经 `es.exe` 查询。

> English documentation: [README.md](README.md)。

## 为什么需要它

Harness 自带的 `@deepseek-ai/dsh-file-reference-local` 会自己遍历工作区，并按 `maxEntries` 截断。在大仓库里这种遍历既慢又有损。以本插件所针对的 Unity 工程为例：

| | 上游遍历方案 | 本插件 |
|---|---|---|
| 检索对象 | 工作区根目录下的每个文件 | Everything 索引，用 `-path` 限定范围 |
| 条目上限 | `maxEntries`（默认 50 000） | 无 |
| 会话里第一次 `@` | 完整遍历 | ~80 ms |
| 后续查询 | 在有限索引里重排 | ~70–80 ms |
| 覆盖范围 | 调优后约 46.9 万 / 约 150 万 | 整个限定范围 |
| 占用堆内存 | 索引约 99 MB | 插件不持有 |

上游上限造成的真实故障：`Library/` 下约 120 万文件、`Output/` 下约 27 万文件，在校验触达 `Assets/` 源码之前就把索引额度耗尽，于是 `@PlayablePrefab` 只返回 `Library/*` 的噪声，真正的文件反而搜不到。Everything 本身就以 Windows 服务的形式维护着全机索引，因此本插件直接查它，不做任何遍历。

## 安装

```powershell
# 每台机器装一次（原因见下方「为什么不内置 es.exe」）
winget install voidtools.Everything
winget install voidtools.Everything.Cli

# 每个 profile 装一次
dsh plugin --profile <profile> add dsh-at-file-everything
```

随包提供的 `cordis.patch.yml` 会：

1. 插入 `file-reference-everything` 行（即本插件）；
2. 禁用 `file-reference-local`，保证 `ctx.fileReferences` 只有一个提供者。

之后重启该 Harness profile。组合中的其他部分无需改动：Session Controller 的 `fileReferences/list` Remote 与 Web 输入框仍然解析同一个服务。

发布包自带已构建的 `lib/`，不需要你本地先编译。

### 从本地代码库安装

开发阶段可以直接指向本仓库：

```powershell
dsh plugin --profile <profile> add link:<本仓库路径>
```

> **更新 `link:` 安装时注意。** 在本 profile 的 pnpm 设置下，`link:` 依赖是被**复制**进去的，不是符号链接。因此只重新构建 `lib/` 不够——已安装的那份会继续跑旧代码，必须重新执行 `dsh plugin --profile <profile> add link:<本仓库路径>`（或先删掉 `<profile>/node_modules/dsh-at-file-everything` 再装）。开发时很容易被这一点误导，以为改动没生效。

## 前置条件

- **Windows。** 插件声明 `os: win32`；其他平台上没有 Everything，也就没有答案来源。
- **Everything 1.4+ 正在运行并已建立索引。** 插件只查询它，不捆绑、不启动它。
- **`es.exe` v1.1.0+ 在 `PATH` 上**，或用 `esCommand` 指定路径。

排查前先确认环境：

```powershell
es -get-everything-version   # Everything 服务是否在应答
es -version                  # 命令行客户端是否可用
```

### 为什么不内置 es.exe

内置它并不能做到「装完即用」，因为 `es.exe` 只是 Everything 的**客户端**。​它要通过 IPC 窗口和服务通信，服务不在时它会直接报：

```
Error 8: Everything IPC window not found. Please make sure Everything is running.
```

也就是说，即使把一份 `es.exe` 打进包里，用户仍然必须安装 Everything、让它常驻、并让它索引目标磁盘——而这几件事才是让 `@file` 真正可用的部分。​另外，随包固定的客户端会和服务**悄悄脱节**：Everything 的 IPC 与索引格式随服务一起升级，而插件里那份是冻结在发布时的。​

所以诚实的安装步骤就是上面两条命令，顺序不能反。​如果确实需要自行分发（离线镜像、受限机器），把 `esCommand` 指向你随包放的那份即可——显式 `esCommand` 永远优先于 `PATH`，其他都不用改：

```yaml
    esCommand: 'C:\Program Files\MyImage\tools\es.exe'
```

`es.exe` 本身是 MIT 许可（安装目录里的 `cli.c` 带有许可声明），所以自行分发是被允许的；它只是**不够**——这也是本包不假装相反的原因。​

## 配置

```yaml
- id: file-reference-everything
  name: dsh-at-file-everything
  config:
    esCommand: es.exe
    maxResults: 20
    maxCandidates: 300
    timeoutMs: 3000
    fuzzyFallback: true
    excludedDirectories: [.git, node_modules, Library, Temp, Output]
    extraPathDirectories: []
    installPrompt: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `esCommand` | `es.exe` | 可执行文件名或绝对路径；写文件名时按 `PATH` 查找。 |
| `maxResults` | `20` | 单次查询返回的候选数量。 |
| `maxCandidates` | `300` | 排序前向 Everything 请求的行数。调高基本线性增加耗时（在 47 万条目上实测约 +0.3 ms/行）。 |
| `timeoutMs` | `3000` | 单次 `es.exe` 超时。超时只会让补全结果为空，不会在输入框里报错。 |
| `fuzzyFallback` | `true` | 连续子串匹配不到时，改用子序列重试（`pbin` → `PlayButton`）。 |
| `excludedDirectories` | 构建/版本控制目录 | 按目录**名**过滤结果，大小写不敏感。名为 `build` 的**文件**不受影响。 |
| `extraPathDirectories` | `[]` | 追加到子进程 `PATH` 前面，用于便携版 Everything。 |
| `installPrompt` | `true` | Agent 能调用 `read` 时，注入 seam 约定的 `@path` 说明。 |

Unity 工程建议补上生成目录：

```yaml
    excludedDirectories:
      - .git
      - node_modules
      - Library
      - Temp
      - obj
      - Logs
      - UserSettings
      - Output
      - Publish
      - .vs
```

如果 `Export/` 下的构建产物需要可搜，就不要排除它。

## 行为

`@` 打开补全，继续输入即过滤，选中后插入普通的 `@path` 文本。目录候选会保留尾斜杠的引号形式，以便继续向下钻取。选中文件**不会**读取内容——模型仍需自行调用 `read`。

- **裸查询**（`@Archive`）：搜索整个工作目录。
- **目录查询**（`@Assets/Scripts/`）：只列该目录，每层一次很便宜的查询。
- **排除**是对返回行的过滤，因此被排除的目录在查询时零成本。
- **隐藏项**：查询本身以 `.` 开头之前，不会出现在结果里。
- **严格限定在工作目录内。** 裸查询带 `-path <cwd>`，每条结果在渲染前还会按根目录再校验一次，工作区之外的内容不会出现。目录下钻同样有守卫：`@../sibling/`、`@D:\elsewhere\` 会解析到根目录之外，此时返回空而不是列出另一棵树。这对同一工程存在多份副本的机器很关键——一个工作区永远看不到、也选不中另一个工作区的文件。

排序完整复刻上游的分档，因此换用本插件不会改变某个按键序列最终选中的文件：全名精确 > 前缀 > 子串 > 目录段 > 子序列；同分时目录优先于文件，其次路径更短者优先，最后按码位排序。

## 实现要点

`es.exe` 的三条行为决定了实现，每条都由实测真实客户端得出：

1. **每个 argv 元素都是独立的、以 AND 相连的检索词。** 单个参数里带空格（`"package json"`）什么也匹配不到，而 `package`、`json` 两个参数能匹配到 `package.json`。因此检索词绝不拼接空格，模式里的字面空格改用 `?` 表示。
2. **Everything 默认只索引文件名；`-p` 才把检索词扩展到完整路径。** 文件名匹配同时是快路径：通配符形式在 47 万条目的工作区上约 70–150 ms，而全路径的 `regex:` 会扫描整个索引，需要 0.6–44 s。因此查询保持在文件名范围，范围限定交给 `-path`。
3. **标准输出不是 UTF-8。** `es.exe` 按进程 ANSI/OEM 代码页输出，在中文系统上 CJK 与假名会变成乱码。唯一与代码页无关的通道是 `-export-csv <文件>` 配 `-utf8-bom`，它把真正的 UTF-8 写进插件自己掌握的文件。它和 stdout 开销相近（约 110 ms 对 100 ms），所以每次查询都走这条路。

目录与文件的区分来自导出的 `Attributes` 列（含 `D` 即目录），省去一次文件系统往返。

## 验证

```powershell
npm run typecheck   # 对 src/ 做严格 TS 检查
npm run test        # 单元测试 + 真实 es.exe 集成测试
```

单元测试在任何机器上都能跑。集成测试在 `%TEMP%` 下建一棵夹具树，等 Everything 索引后验证：目录识别、根范围限定、CJK 文件名解码、含空格文件名、子序列匹配、空结果与取消。缺少 `es.exe` 时自动跳过。

`test/` 刻意不依赖 Harness 安装：纯逻辑放在 `src/pure.ts`，单独打包成 `lib/pure.js` 就是为了这一点。

## 目录结构

```
src/index.ts      插件、服务类、配置 schema
src/es-client.ts  es.exe 适配层：spawn、导出、解码、超时
src/candidates.ts 纯排序与路径归一
src/pure.ts       不含 Harness 依赖的入口，供测试与复用
cordis.patch.yml  打包层：插入本行，禁用 file-reference-local
assets/           市场图标及其许可记录
scripts/make-icon.py  由 icon-256.png 渲染 assets/icon-{180,256,512}.png
```

`@deepseek-ai/*` 在打包时保持 external：由宿主从安装目录解析；若内联，本插件会得到第二份 Cordis `Service` 类身份。

## 图标

`assets/icon-{180,256,512}.png` 用的是 voidtools「Everything」的放大镜图标。
Everything（含图标）以 MIT 授权发布（Copyright (c) 2022 voidtools），因此复用
是允许的，唯一条件是许可声明随资产一起分发——声明在
[assets/ICON-LICENSE.txt](assets/ICON-LICENSE.txt)。重新渲染各尺寸：

```powershell
python scripts/make-icon.py
```

市场（awesome-dsh-plugin 列表、dsh-market）从目录条目里取图：

```yaml
icon: https://raw.githubusercontent.com/backkom/dsh-at-file-everything/master/assets/icon-180.png
```

该列表只接受托管在 GitHub 的 `png`/`jpg`/`jpeg`/`webp`，卡片按约 96px 显示，
所以方形位图最合适。本仓库默认分支是 `master`；若日后改名，这个 URL 要同步改。

## 已知限制

- **仅 Windows**，且效果取决于 Everything 的索引范围。未纳入索引的文件同样搜不到。
- **必须让 Everything 保持运行。** 服务停掉时插件只记录一条警告、补全返回空，不会退回到文件系统遍历。
- **检索限定在文件名。** 带 `/` 的查询会列出该目录，但裸查询匹配不到「文件名里不含、只在深层路径里出现」的片段——这是用上游的路径子串匹配换来了索引路径约 30 倍的提速。
- **每次按键一个 `es.exe` 进程。** 每次查询都是新进程（预热后约 70–80 ms），取消会杀掉它。
- **Everything 索引处于冷态时**，首次查询可能需要约 1 s 让服务把索引换入。

## 许可

MIT，见 [LICENSE](LICENSE)。
