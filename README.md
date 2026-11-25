# 译台 TransDesk

纯离线的英/日 ⇄ 中翻译台：一个静态网站 + 一个 Android 10+ APK。
核心是**词典 + 规则引擎**（短语最长匹配、日文活用还原、虚词与语序规则、逐段对照），
可选加载**本地 Bergamot int8 神经模型**提升中⇄英质量。
没有后端、没有数据库、没有任何网络请求——断网、飞行模式下照常用。

## 在线体验

- GitHub Pages：<https://meng6969.github.io/transdesk/>（**默认携带中⇄英 int8 神经模型**，约 100 MB，位于 gh-pages 分支）
- Qoder Sites 镜像：<https://transdesk-rg8bmuwp2yo.qoder.zone>（部署产物有大小上限，仅词典引擎）

两处均为纯静态部署；模型缺失或加载失败时自动回退词典引擎，不报错。

## 功能

- 中⇄英、中⇄日四个方向，界面上只有两个方向键 + 一个 ⇄ 翻面键
- 短语优先的最长匹配；日文动词/形容词活用还原（走って → 歩く）
- 冠词/复数/时态、日文助词与句末语气的规则映射，译文按中文语序成句
- 逐段对照 / 判定依据：每一块译文是被哪条规则或哪个词条翻出来的，均可展开查看
- 我的词典：优先级最高，支持 CSV / TSV / JSON / Markdown 表格导入，只存本机 IndexedDB
- 图片翻译：Tesseract.js 本地 OCR（eng / jpn），图片不出本机
- 可选神经层：Bergamot/Marian int8（中⇄英），单线程 wasm，不需要 SharedArrayBuffer
- Android：WebView 壳 + 虚拟 https 源服务本地资源，**零权限**（无 INTERNET，离线由系统强制）

## 本地运行

```bash
python serve.py          # 把 web/ 服务到 http://localhost:8000
```

任何指向 `web/` 的静态服务器均可。直接双击 index.html 不行：
Service Worker / ES module / IndexedDB 需要安全上下文（localhost 或 https）。

## 神经模型（可选，约 100 MB）

```bash
python mt/fetch-models.py --pairs zh-en,en-zh
```

从 hf-mirror 下载 Mozilla 的 int8 模型，并逐文件与 Mozilla Remote Settings
登记项做 sha256 校验，重写 `mt/registry.json` 与 `mt/SHA256SUMS.txt`。
没有模型时网站与 APP 自动只走词典引擎，不会报错。
想加日文神经方向：`--pairs zh-en,en-zh,ja-en,en-ja`（经英文中转，体积与延迟翻倍，按需）。

模型二进制不进 git 主分支；`python pack-ghpages.py` 会把 `web/` 连同本地模型
打包成 GitHub Pages 部署目录（gh-pages 分支携带模型，main 分支保持轻量）。

## 词典数据重建

`vendor/` 是上游开放许可源数据（CC BY-SA 4.0 / CC BY 4.0 / MIT，见 NOTICE.md）。
`build-zh.py`、`build-ja.py`、`build-en.py`、`build-en-extra.py` 与 `dictlib.py`
对其做机械清洗与表查询，产出 `web/data/*.json`。
规则：**查不通、或释义是“参见某条”这类参照项的一律丢弃，不手工补词**；
来源与许可标识写进每个 payload 的 `meta` 字段。

## Android 打包（无 Gradle / Maven）

```bash
bash android-tools/get-jdk17.sh    # 首次：Temurin JDK 17
bash android-tools/get-sdk.sh      # 首次：platform-34 + build-tools 34
bash android/rebuild.sh            # 打包 web/ + mt/ 并产出签名 APK
```

流水线：aapt2 compile/link → javac --release 17 → d8 → zipalign → apksigner。
`minSdk 29`（Android 10）、`targetSdk 34`。签名用本地自签名
`android/transdesk.keystore`（不入库，脚本缺失时自动生成），适合侧载：
`adb install android/build/TransDesk.apk` 或拷到手机直接安装。
Release 页也提供已签名的成品 APK。

注意：神经层与图片 OCR 需要 WebView 内核 ≥ Chrome 91（wasm SIMD）；
更老的内核上这两项自动不可用，词典与规则翻译不受影响。

## 目录结构

```
web/            静态网站（引擎、界面、词典数据、OCR 资源、sw.js）
web/mt/boot.js  可选神经层加载器（无模型时自行退出）
mt/             模型清单、校验和、获取脚本、wasm 运行时（模型二进制不入库）
vendor/         上游开放许可源数据与原许可文本
android/        WebView 壳源码 + 无 Gradle 打包脚本
build-*.py      词典数据构建管线（dictlib.py 为共用库）
serve.py        本地静态服务器
test.js         引擎回归测试（node test.js）
```

## 许可与署名

- 代码：**MIT**（见 LICENSE）
- 编译词典数据 `web/data/**`：**CC BY-SA 4.0**（含 CC BY-SA 源数据，适用相同方式共享）
- 第三方组件与数据源完整署名：**NOTICE.md**
- 应用内「说明」面板同样保留来源与许可名称

## 已知边界

- 不擅长：法律 / 合同 / 医疗 / 财务等必须精确的文本、文学与双关、长难嵌套从句
- 中→英 / 中→日为短句设计：主谓宾清楚的一两句效果不错，长段落会退化成关键词式译文
- 专有名词默认保留原文；加进「我的词典」即可固定译法
- 它是词典 + 规则引擎（加一个可选的小型本地神经层），不是云端大模型
