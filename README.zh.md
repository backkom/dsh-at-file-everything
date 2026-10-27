# dsh-at-file-everything

为 Windows 上的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Everything 索引搜索，经 `es.exe` 查询：给**人**用的秒级 `@文件` 补全，以及给**模型**用的 `find_files` 工具——两者共用同一份 [Everything](https://www.voidtools.com/) 索引。

> English documentation: [README.md](README.md)。

## 为什么需要它

有两个调用方都需要找文件，而遍历目录树对两者都不合适。

**人敲 `@` 的时候。** Harness 自带的 `@deepseek-ai/dsh-file-reference-local` 会自己遍历工作区，并按 `maxEntries` 截断。在大仓库里这种遍历既慢又有损。以本插件所针对的 Unity 工程为例：

| | 上游遍历方案 | 本插件 |
|---|---|---|
| 检索对象 | 工作区根目录下的每个文件 | Everything 索引，用 `-path` 限定范围 |
| 条目上限 | `maxEntries`（默认 50 000） | 无 |
| 会话里第一次 `@` | 完整遍历 | ~80 ms |
| 后续查询 | 在有限索引里重排 | ~70–80 ms |
| 覆盖范围 | 调优后约 46.9 万 / 约 150 万 | 整个限定范围 |
| 占用堆内存 | 索引约 99 MB | 插件不持有 |

上游上限造成的真实故障：`Library/` 下约 120 万文件、`Output/` 下约 27 万文件，在触达 `Assets/` 源码之前就把索引额度耗尽，于是 `@PlayablePrefab` 只返回 `Library/*` 的噪声，真正的文件反而搜不到。

**模型自己找路径的时候。** 它只有 `glob` 和 shell，两者都遍历目录树，都会遇到同一个额度问题。`find_files` 改查索引——就是让 `@` 变快的那次查询，放到模型能调用的地方。

Everything 本身就以 Windows 服务的形式维护着全机索引，因此两个入口都直接查它，不做任何遍历。

## `find_files` 工具

| 参数 | 含义 |
|---|---|
| `query` | 文件或目录名，或它的任意连续片段。大小写不敏感。`*` 或省略表示「范围内全部」。 |
| `path` | 限定搜索的绝对目录，含其子目录。省略则搜索所有已索引磁盘。 |
| `foldersOnly` / `filesOnly` | 限定返回条目类型。 |
| `limit` | 分页大小（默认 50，最多 500）。 |

工具返回绝对路径，每行一条，并说明这一页与整个匹配集的关系：

```
2 match(es) under Y:\pm-devs:
Y:\pm-devs\Assets\Scripts\Behaviour.Editor\
Y:\pm-devs\Assets\Scripts\Deep.ts
(more than 2 matched; raise `limit`, or narrow `query`/`path`)
```

最后那行很重要：没有它，被截断的一页会被当成完整答案，模型就会把存在的文件报成找不到。只有当页取满时才加这行，所以短页确实意味着「这就是全部」。

**它刻意不限定在工作区内。** `@` 补全限定在一个工作目录，是因为补全框绝不能冒出用户看不见的、另一个副本里的文件。而被要求找文件的模型需求正好相反：在存着同一工程多份副本的机器上，限定范围只会让它答错副本或什么都答不到。它返回绝对路径，让模型自己决定读哪个。

它和补全共用 `esClient` 适配层，但不共用排序：补全为人的按键排序并返回相对路径；工具按要求返回全部匹配、绝对路径。各自服务各自的调用方，而不是折中。

只有当组合里有 `tools` 服务时才注册该工具，所以没有工具服务的组合依然有 `@` 补全。

### 不需要任何配置

光有工具描述，模型并不会用它。它同时看到 `glob`、`grep`、`find_files`，会按习惯选——而习惯通常是 `glob`，那个遍历目录树、跑到一半就放弃的。所以插件还会注入一段 system prompt，讲清**三者各自回答哪个问题**：按名字定位文件（尤其是工作区外、或被忽略的大目录里）用 `find_files`；要路径模式且需遵守忽略规则用 `glob`；搜内容用 `grep`。

这段说明随工具注册一起安装，**没有自己的开关**。用户没有任何东西要打开：即使从没听说过这个工具，模型也会知道该调它。它紧挨在宿主自己的 `glob` 说明之前，让两者读起来是同一个决策，而不是两个互不相关的功能。

`installPrompt` 仍然存在，但它只控制 `@path` 那段说明——关掉它不会让模型看不到这个工具。

## 安装

```powershell
# 每台机器装一次
winget install voidtools.Everything

# 每个 profile 装一次
dsh plugin --profile <profile> add dsh-at-file-everything
```

`es.exe` **不是**单独的前置条件：本包在 `bin/` 里带了一份固定版本的副本，机器上没有自己的客户端时就用它。若你希望用自己的 ES（它跟你的 Everything 版本一致），装上并留在 `PATH` 上即可——`PATH` 上可用的 `es.exe` 永远优先于随包副本。

```powershell
# 可选：用你自己的客户端，而不是随包副本
winget install voidtools.Everything.Cli
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
- **Everything 正在运行并已建立索引。** 插件只查询它，不捆绑、不启动它。

排查前先确认环境：

```powershell
es -get-everything-version   # Everything 服务是否在应答
es -version                  # 命令行客户端是否可用
```

### es.exe 从哪来

Everything 和它的命令行客户端是**两个独立的下载**：服务与索引是一个安装包，`es.exe` 是另一个。​很多机器装了 Everything 用了好几年，却从来没装过客户端，所以本插件不假设它一定存在，而是按下面的顺序解析：

1. `esCommand` 写成绝对路径时——显式指定永远优先；
2. `esCommand`（默认 `es.exe`）按 `extraPathDirectories`、再按 `PATH` 查找；
3. 随包的 `bin/es.exe`。

候选存在但启动失败（比如配置的路径已被卸载）会继续往下一个候选走，代价只是一次失败的启动，而不是整个补全列表失效。

**随包副本是兜底，不是覆盖。** 它排在 `PATH` **之后**是刻意的：装了 ES 的用户应该用自己那份——那才是与他 Everything 版本配对的客户端。随包副本只为「有服务、没客户端」的机器准备。

它固定为 **ES 1.1.0.34**，而**不是**最新版。从 1.1.0.35 起，`-n` 被实现成 `count:` 过滤，在 Everything 1.4 上每次查询要先多花约 300 ms 才返回第一行——而每一次按键都要付这笔钱。实测表格与推导见 [`bin/README.md`](bin/README.md)；1.1.0.34 是最后一个既让 `-n` 便宜、又已支持 `--`、`-get-result-count` 以及 Everything 1.5 的 IPC3 的版本。

那张表是按**本插件的参数向量**测的，所以如果改动发出哪些开关，值得重测。

如果某个部署需要指定客户端——离线镜像、受限机器——把 `esCommand` 指向它即可，显式路径永远优先：

```yaml
    esCommand: 'C:\Program Files\MyImage\tools\es.exe'
```

`es.exe` 本身是 MIT 许可，所以自行分发是被允许的；许可声明随二进制放在 `bin/LICENSE-ES.txt` 里。

## 配置

**设置 → 插件 → `dsh-at-file-everything`**，配置卡片就在该 bundle 自己的页面上、描述下方。

| 控件 | 字段 | 默认 | 说明 |
|---|---|---|---|
| **es.exe 路径** | `esCommand` | 空 | 留空即自动探测；填入绝对路径可固定使用某一份客户端。 |
| **排除文件夹** | `excludeInQuery` | 空 | 文件夹名或通配符，在查询内剪掉。 |
| **排除文件** | `excludeFilePatterns` | 空 | 文件名或通配符，同样在查询内剪掉。 |
| **仅在结果里排除** | `excludedDirectories` | 空 | 只从返回行里过滤。查询时免费，但那些行已经消耗了配额。 |

### 为什么宿主半边也必须「认领」这个页面

只有浏览器卡片是不够的。插件页会先问宿主：这个命名空间还要不要自动生成页面。

```js
const autoGenerate = presentations.get(fiber)?.auto ?? true
```

默认是 `true`。于是只在 `plugins.bundle.config` 注册了卡片的插件，拿到的是**按 Config schema 自动生成的表单**，自己的卡片根本不会被画出来。而全 volatile 的 schema 在那个通用表单里没有可渲染的常规控件——这就是「配置页看起来是空的」的成因。

所以宿主半边要显式认领，写法与所有自带页面的官方插件完全一致：

```ts
ctx.inject(['settings'], (scope) => {
  scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber))
})
```

三点要记住：

- **只有卡片真的存在时才认领。** 设了 `auto: false` 却没有注册卡片，页面会是全空——比通用表单更糟。所以浏览器半边现在**无条件**向两个 slot 注册、每个都包 `try`/`catch`，并且**不再**在 `configForms` 不可达时提前返回；卡片改为自己渲染「不可用」提示。
- **slot 的 key 是包名，而设置命名空间是 Loader 的条目 id**（这里是 `file-reference-everything`）。两个字符串都不能省：`plugins.bundle.config` 按包名与页面清单比对，`configForms.get()` 认的是条目 id。
- **`ctx.locale.bind(ns)` 返回的是查表函数，不是文案对象。** 它接受 `t('some.key')`；把返回值当 `{ label, hint }` 读，会让每个标题、说明、按钮文字都是 `undefined`，而输入框（值来自数据）照常显示——于是一屏「空盒子」，看起来像布局坏了。所以本插件的文案是 `src/client.ts` 里的字面量表，只向 locale 服务问**用哪种语言**。`test/render.test.js` 按 React 的方式展开组件，任何一处文案丢失都会失败——这才是能抓住它的检查。

### 怎么填

填**名字或通配符**，不是 Everything 的语法：

```
排除文件夹   [ Library        ]
             [ Lib*           ]
             [ Temp?          ]

排除文件     [ *.meta         ]
             [ Thumbs.db      ]
```

- **不用写前面的 `!`。** 查询词由插件自己拼。粘贴 `!Library` 也接受，会把标记去掉——从 Everything 查询里复制过来不会报错。
- **两个列表都能用 `*` 和 `?`。** `Lib*` 是前缀，`Temp?` 是单个字符。其余字符按字面处理——名为 `a+b` 的文件夹只匹配 `a+b`，不会匹配 `aab`。
- **文件夹连内容一起剪，文件按名字排除。** 填 `Library` 会隐藏该文件夹**及其全部内容**，但保留 `Library.txt`；两个列表发的是不同的查询词。

为什么不能合成一个列表：Everything 解析「排除文件夹」和「排除文件」的方式不同，合成一个就得去猜用户指的是哪种。详见下面的查询语法表。

### 路径这一栏

输入框的 placeholder 显示**当前真正生效**的路径，下面一行说明它来自哪一级：

```
es.exe 路径   [ （留空）                                    ] [ 重新检测 ]

当前使用：C:\Program Files\Everything\es.exe（系统 PATH）
es.exe版本 1.1.0.34
```

版本来自 `es.exe -version`，它不需要 Everything 服务在运行，所以索引不可用时也能答。显示在路径旁边是因为它们是两件事：路径说明**跑哪一个**客户端，版本说明它**有多旧**——而一个早于某开关的版本能解释路径解释不了的行为。本机 `PATH` 上是 1.1.0.26、随包副本是 1.1.0.34，这一行立刻回答了「我实际拿到的是哪个」。

一旦拿到路径，这行就用等宽字体显示——它是卡片上唯一的**运行时**事实，也是用户会复制的东西。三种状态刻意分开：*检测中*、*无法向宿主查询*、*未检测到*。只有最后一种意味着该装 ES；路由没有响应是另一回事，文案会这么说，而不是把锅推给安装。

这一行才是这个控件的重点。**用户自带的客户端**和**随包副本**并不是可以互换的——随包副本固定在某一个版本，而 Everything 升级之后机器可能该用自己的那份。一个只显示路径的文本框说不清当前跑的是哪一份，所以卡片去问宿主，因为解析链和文件系统的事实只在宿主那边。

它也会如实报出这些尴尬状态：

- **什么都没找到** ——「未检测到 es.exe：请安装 Everything 的 ES，或在上方手动填入路径。」这和「Everything 没运行」是两个不同的问题，文案会区分。
- **无法向宿主查询** —— 状态路由没响应，就直说这个，而不是谎称「没找到」。
- **指定的路径已不存在** —— 解析链会继续往下走，并且明说：`指定的路径不存在，当前回退到 …（随包副本）`。否则输入框显示一个路径、实际跑的却是另一个。

**留空就是保持自动探测**：它存的是裸默认值 `es.exe`，而不会把用户没选过的路径写死。**重新检测**只重跑探测、不保存——改完 `PATH` 或刚装了 ES 之后点一下即可。保存也会自动重新检测，所以那一行不会落后于配置。

路由是用 `inject(['webServer'])` 注册的，而不是用 `ctx.get` 探一次。否则在本插件之后才提供 Web 服务的宿主上，路由永远不会注册，卡片会一直停在「无法向宿主查询」——而这个控件存在的意义正是排除这种情况。

**没有「浏览…」按钮。** 宿主的 `directoryPicker` 选的是**目录**而不是文件（它暴露 `pick` 与目录列举原语），所以选中之后只能去猜 `<目录>\es.exe` 就是客户端。手填或粘贴路径只有一步，而且不会猜错。

### 排除列表

卡片里直接写明这个取舍，因为光看字段名看不出来：查询内排除才能让藏在巨大 `Library/` 后面的真实匹配仍然被找到，代价是每次查询多几毫秒；结果内排除免费，但救不回已经花掉的配额。

两个查询内列表都是**每行一条**。文件夹条目拼成 `!path:*\<pattern>\*`，剪掉该文件夹及其内容，同时保留 `Library.txt` 和 `LibraryBeta`；文件条目拼成 `!<pattern>`。只有路径分隔符或 Everything 运算符会被拒绝——`*` 和 `?` 正是要支持的。

其余配置仍然写在 profile 的 patch 里，因为它们是「设一次」而不是「按工程调」：

```yaml
- id: file-reference-everything
  name: dsh-at-file-everything
  config:
    esCommand: es.exe
    maxResults: 20
    maxCandidates: 300
    timeoutMs: 10000
    deadlineMs: 25000
    fuzzyFallback: true
    excludeInQuery: []
    excludeFilePatterns: []
    excludedDirectories: []
    extraPathDirectories: []
    installPrompt: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `esCommand` | `es.exe` | 绝对路径，或不含分隔符的名字（按 `extraPathDirectories`、再按 `PATH` 查找）。两者都找不到时用随包的 `bin/es.exe`。 |
| `maxResults` | `20` | 单次查询返回的候选数量。 |
| `maxCandidates` | `300` | 排序前向 Everything 请求的行数。调高基本线性增加耗时（在 47 万条目上实测约 +0.3 ms/行）。 |
| `timeoutMs` | `10000` | `es.exe` 等待 Everything 数据库加载完成的时长（`-timeout`）。冷索引、大盘时调大。 |
| `deadlineMs` | `25000` | 单次 `es.exe` 调用的截止时间，含进程启动。必须大于 `timeoutMs`；超时只会让补全结果为空，不会在输入框里报错。 |
| `fuzzyFallback` | `true` | 连续子串匹配不到时，改用子序列重试（`pbin` → `PlayButton`）。 |
| `extraPathDirectories` | `[]` | 查找不含分隔符的 `esCommand` 时，先于 `PATH` 搜索，用于便携版 Everything。 |
| `installPrompt` | `true` | Agent 能调用 `read` 时，注入 seam 约定的 `@path` 说明。 |

`timeoutMs` 与 `deadlineMs` 刻意分开：前者交给 `es.exe` 作为它自己等数据库的时间，后者是本进程杀子进程的时间。合成一个值就必须覆盖冷索引加载，于是健康的查询会在客户端刚要放弃的同一刻被杀掉，失败还会显示成「超时」而不是「索引还在加载」。

### 为什么默认是空

该排除什么，是**工程**的属性，不是插件的属性。Unity 工程要 `Library` 和 `Output`，Rust 工程要 `target`，monorepo 两者都不要——随便给个默认值，会在前两种工程里悄悄藏掉真实源码，在第三种里毫无用处。所以这件事交给卡片决定。

### 为什么查询内分成两个列表

Everything 对两者的解析方式不同：文件夹按路径段排除，文件按名字模式排除。几种「看起来对、其实不对」的写法：

| 词条 | 实际效果 |
|---|---|
| `!path:Library` | 匹配路径中**任意位置**的字符串，因此连 `Library.txt`、`LibraryBeta` 一起误杀。 |
| `!folder:Library` | 只匹配文件夹那一行，**不含其内容**，子树依然在。 |
| `!\Library\` | 剪掉该文件夹及其内容，`Library.txt` 保留——但**通配符放不进去**：`!\Lib*\` 什么也匹配不到。 |
| `!path:*\Lib*\*` | 剪掉任何名字匹配该模式的文件夹及其内容。卡片写的就是这个。 |

最后一行正是卡片能接受裸 `Lib*` 的原因：开头的 `*` 让路径段在任意深度匹配，结尾的 `\*` 才真正触达内容。`?` 在路径段里表现不稳定，所以卡片的说明只承诺 `*`，不夸大。

Unity 工程可以这样起步：

```yaml
    excludeInQuery: [Library, Output]
    excludeFilePatterns: ['*.meta']
```

查询内词条的实测代价：0 个 56 ms、1 个 83 ms、2 个 115 ms（47 万条目，客户端 1.1.0.26）。只放最肥的两三个。

## 行为

`@` 打开补全，继续输入即过滤，选中后插入普通的 `@path` 文本。目录候选会保留尾斜杠的引号形式，以便继续向下钻取。选中文件**不会**读取内容——模型仍需自行调用 `read`。

- **裸查询**（`@Archive`）：搜索整个工作目录。
- **目录查询**（`@Assets/Scripts/`）：只列该目录，每层一次很便宜的查询。最后一个 `/` 之后的片段会作为检索词发给 Everything，因此子项数超过 `maxCandidates` 的目录依然答得对——事后再过滤那一页会丢掉所有名字排在被截断位置之后的条目。
- **排除**由卡片决定：`excludeInQuery` 与 `excludeFilePatterns` 在查询内剪枝，`excludedDirectories` 从返回行里过滤。三者都默认为空。
- **隐藏项**：查询本身以 `.` 开头之前，不会出现在结果里。
- **严格限定在工作目录内。** 裸查询带 `-path <cwd>`，每条结果在渲染前还会按根目录再校验一次，工作区之外的内容不会出现。目录下钻同样有守卫：`@../sibling/`、`@D:\elsewhere\` 会解析到根目录之外，此时返回空而不是列出另一棵树。这对同一工程存在多份副本的机器很关键——一个工作区永远看不到、也选不中另一个工作区的文件。
- **Everything 没运行会明说，不会伪装成空结果。** ES 退出码 8 表示服务未运行；这一原因单独记录，否则空的 `@` 列表看起来像「没有这个文件」，而实际上索引是完整的、只是没人应答。

排序完整复刻上游的分档，因此换用本插件不会改变某个按键序列最终选中的文件：全名精确 > 前缀 > 子串 > 目录段 > 子序列；同分时目录优先于文件，其次路径更短者优先，最后按码位排序。

## 实现要点

`es.exe` 的六条行为决定了实现，每条都由实测真实客户端得出：

1. **每个 argv 元素都是独立的、以 AND 相连的检索词。** 单个参数里带空格（`"package json"`）什么也匹配不到，而 `package`、`json` 两个参数能匹配到 `package.json`。因此检索词绝不拼接空格，模式里的字面空格改用 `?` 表示。
2. **Everything 默认只索引文件名；`-p` 才把检索词扩展到完整路径。** 文件名匹配同时是快路径：通配符形式在 47 万条目的工作区上约 70–150 ms，而全路径的 `regex:` 会扫描整个索引，需要 0.6–44 s。因此查询保持在文件名范围，范围限定交给 `-path`。
3. **标准输出不是 UTF-8。** `es.exe` 按进程 ANSI/OEM 代码页输出，在中文系统上 CJK 与假名会变成乱码。唯一与代码页无关的通道是 `-export-csv <文件>` 配 `-utf8-bom`，它把真正的 UTF-8 写进插件自己掌握的文件。它和 stdout 开销相近（约 110 ms 对 100 ms），所以每次查询都走这条路。
4. **导出 CSV 的列序和参数顺序不一致。** `-csv -attributes` 写出的是 `Filename,Attributes`——文件名在前。按下标读的解析器会把路径换成属性值，查询「成功」但返回垃圾。因此解析器按表头定位列，不按下标。
5. **`Attributes` 是十进制位掩码，不是字母。** 目录导出为 `16`（`FILE_ATTRIBUTE_DIRECTORY`），普通文件为 `32`。按文档暗示去测字母 `D`，会把**每一行**都判成文件，于是补全里所有目录都不带尾斜杠。
6. **客户端版本决定某个开关的代价。** `-n` 在 1.1.0.34 之前是分页上限，从 1.1.0.35 起变成 `count:` 过滤，在 Everything 1.4 上每次查询要多花约 300 ms。这就是随包客户端要固定的原因；见 [`bin/README.md`](bin/README.md)。

目录与文件的区分来自导出的 `Attributes` 列（按 0x10 位判断），省去一次文件系统往返。

## 验证

```powershell
npm run typecheck        # 对 src/ 做严格 TS 检查
npm run test             # 单元测试 + 真实 es.exe 集成测试
npm run verify:activate  # 按宿主的方式真正加载一次插件
```

单元测试在任何机器上都能跑。集成测试在 `%TEMP%` 下建一棵夹具树，等 Everything 索引后验证：目录识别、根范围限定、CJK 文件名解码、含空格文件名、子序列匹配、空结果、取消、查询内剪枝，以及它现在专门守住的那个回归——名字排在很小的 `-n` 页之后依然能被找到。

`test/` 刻意不依赖 Harness 安装：纯逻辑放在 `src/pure.ts`（打包成 `lib/pure.js`），配置校验放在 `src/config.ts`（打包成 `lib/config.js`），工具定义放在 `src/tool.ts`（打包成 `lib/tool.js`，测试用 `dsh-tools` 桩驱动）。

`verify:activate` 是唯一需要真实安装的检查：它从 profile 里 import `schemastery`、套用 schema、再拿产出的配置调用 `apply`。之所以值得单独做，看下一段。

### `volatile` 陷阱

本插件的 `Config` 每个字段都是 `volatile`，有两个原因：Harness **只**给 volatile 字段生成设置表单（普通配置意味着插件根本没有卡片），而 volatile 也正是「改配置不用重挂插件」的机制。

代价很容易踩：`apply` 拿到的**不是值**。每个 volatile 字段是 `Object.freeze({ get })`。于是读 `config.maxResults` 再判断是不是数字的代码，看到的是一个对象，判定配置非法，在激活阶段抛错——整个 bundle 加载失败、报 *「1 entry did not activate」*，而所有传普通对象的单元测试依然全绿。

所以本仓库遵守三条：

- 所有字段都经 `currentValue()`（`src/config.ts`）读取，它负责解包句柄、放行普通值；
- **校验用解包后的值，返回时保留句柄**——归一化成普通副本会把第一次的值永久钉死，配置从此变成只读；
- 测试要覆盖句柄形状，而不只是普通对象（`test/config.test.js` 就是这么做的）。

## 目录结构

```
src/index.ts      插件、服务类、配置 schema
src/config.ts     配置形状、默认值、校验（不依赖 Harness）
src/es-client.ts  es.exe 适配层：spawn、导出、解码、超时
src/resolve.ts    es.exe 解析链（配置 → PATH → 随包副本）
src/status.ts     宿主路由：当前生效的是哪个 es.exe、来自哪
src/tool.ts       find_files 模型工具
src/client.ts     浏览器半边：插件页上的配置卡片
src/candidates.ts 纯排序与路径归一
src/pure.ts       不含 Harness 依赖的入口，供测试与复用
bin/es.exe        固定版本的 Everything CLI，其他都找不到时使用
bin/README.md     为什么是这一版；实测版本对照表
cordis.patch.yml  打包层：插入本行，禁用 file-reference-local
assets/           市场图标及其许可记录
scripts/make-icon.py  由 icon-256.png 渲染 assets/icon-{180,256,512}.png
```

`@deepseek-ai/*` 在打包时保持 external：由宿主从安装目录解析；若内联，本插件会得到第二份 Cordis `Service` 类身份。

`lib/client.cjs.js` **不是** ES 模块。Web 外壳把它当普通脚本执行，期待它在 `window.__ModuleLoader__` 上注册一个惰性 CommonJS 工厂，所以它按 CJS 打包、并把 `react` 保持 external（内联 React 会是第二份副本，卡片里所有 hook 都会坏）。它**刻意不** import `@deepseek-ai/dsh-client-ui-primitives`：那个包会继续拉 `*.module.css` 和更多 DSH 依赖，卡片就没法在 Node 测试里挂载了。控件按 `--dsw-alias-*` 主题变量手写，这也正是宿主自己的插件作者指引所建议的做法。

**每个 `var()` 都必须带回退，且只能用主题里真实存在的变量名。** 无回退的 `var()` 一旦解析不到，会让**整条声明**失效——`border: 1px solid var(--dsw-alias-border-secondary)`（这个名字并不存在）就这样悄悄变成 `border: none`，于是卡片的输入框看起来只是一段裸文本。这里用到的名字都对着实际部署核对过（`bg-l1`、`border-l1`、`border-l2`、`label-primary`、`label-tertiary`、`state-error-primary`、`settings-card-fill`），并且 `scripts/verify-card-style.mjs` 会枚举渲染树里出现的每个 token，改名字会变成一次失败，而不是一条消失的边框。

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

- **仅 Windows**，且效果取决于 Everything 的索引范围。未纳入索引的文件同样搜不到——`find_files` 与 `@` 都一样。
- **必须让 Everything 保持运行。** 服务停掉时插件会单独记录这一原因、补全返回空；`find_files` 会抛出指明了原因、并指向 `glob` 的错误。随包的 `es.exe` 提供的是**客户端**，不是服务，所以这种情况下帮不上忙。
- **随包客户端是固定版本。** 它是按 Everything 1.4 的延迟选的（见 `bin/README.md`）。若未来的 Everything 让 `count:` 过滤变便宜，更新的客户端才是更好的钉子；`PATH` 上或 `esCommand` 里用户自带的 `es.exe` 永远优先，所以这只影响依赖兜底副本的机器。
- **检索限定在文件名。** 带 `/` 的查询会列出该目录，但裸查询匹配不到「文件名里不含、只在深层路径里出现」的片段——这是用上游的路径子串匹配换来了索引路径约 30 倍的提速。`find_files` 只搜名字，同理。
- **`find_files` 是分页的，不是流式的。** 单次最多返回 500 条，超过就得收窄查询或提高 `limit` 翻页；结果里会说明这一点。
- **每次查询一个 `es.exe` 进程。** 每次查询都是新进程（预热后约 70–80 ms），取消会杀掉它。
- **Everything 索引处于冷态时**，首次查询可能需要约 1 s 让服务把索引换入；`timeoutMs` 覆盖这段等待，`deadlineMs` 覆盖进程本身。

## 许可

MIT，见 [LICENSE](LICENSE)。

`bin/es.exe` 来自 [voidtools ES](https://github.com/voidtools/ES)，MIT，Copyright (c) 2025 voidtools；见 [`bin/LICENSE-ES.txt`](bin/LICENSE-ES.txt)。
