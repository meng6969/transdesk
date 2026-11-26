# 第三方组件与数据源署名（NOTICE）

本文件列出译台 TransDesk 包含或派生的全部第三方组件与数据，以及各自许可。
仓库许可结论：**原创代码采用 PolyForm Noncommercial 1.0.0（源码公开、非商业使用）**；
**编译词典数据 `web/data/**` 为 CC BY-SA 4.0**（因含 CC BY-SA 源数据，适用相同方式共享条款）；
`vendor/` 与第三方运行库保留上游原许可文本。新版本（v1.5 起）禁止商业使用和售卖；
v1.4 及更早的历史副本仍按其发布时的 MIT 许可使用。

## 词典数据源

1. **Word Atlas** — <https://github.com/designfuchen/word-atlas>
   代码 MIT；词库数据 **CC BY 4.0**，署名 “Word Atlas contributors”。
   本仓库 `web/data/en2zh.json` 由其中文释义机械取项派生，含 CEFR 等级信息。

2. **CC-CEDICT** — <https://cc-cedict.org/>
   **CC BY-SA 4.0**。`vendor/cedict.json`（原许可文本见 `vendor/cedict-license.txt`）。
   派生：`web/data/zh2en.json` 等中→英条目。

3. **JMdict / KANJIDIC2 / KanjiVG（经 kotobako-data 汇编）** — EDRDG
   **CC BY-SA 4.0**。`vendor/kotobako.json`（版本与来源见文件内 `sources` 字段）。
   派生：`web/data/ja2zh.json` 等日→中条目与语法项。

4. **JmdictFurigana / JMnedict / Tatoeba 等（furifont 汇编）**
   除 Tatoeba 句库为 **CC BY 2.0 FR** 外均为 **CC BY-SA 4.0**；
   详见 `vendor/furifont-license.md`（含 Doublevil、stephenmk、Jonathan Waller、
   EDRDG、Desktop Tetsu、Japan Post/zipcloud 等来源署名）。`vendor/furifont.json`。

5. **jieba 词典** — <https://github.com/fxsjy/jieba>
   **MIT**。`vendor/jieba-dict.txt`，用于中文分词与中→外切词。

## 运行库与模型

6. **Tesseract.js** — <https://github.com/naptha/tesseract.js>
   **Apache-2.0**。`web/lib/tesseract.min.js`、`web/worker/`。

7. **tessdata_fast（eng / jpn）** — <https://github.com/tesseract-ocr/tessdata_fast>
   **Apache-2.0**。`web/data/ocr/*.traineddata`。

8. **bergamot-translator wasm 运行时** — Mozilla
   **MPL-2.0**。`mt/runtime/`，许可原文随附 `mt/runtime/LICENSE-mpl2-mozilla.txt`。

9. **Firefox Translations int8 神经模型**（model.zhen / model.enzh 等）— Mozilla
   随 Firefox Translations 项目发布，**MPL-2.0**。
   **不入库**：由 `mt/fetch-models.py` 下载，并逐文件与 Mozilla Remote Settings
   登记项做 sha256 校验（校验和见 `mt/SHA256SUMS.txt`）。

## 许可义务履行方式

- CC BY / CC BY-SA 署名：本文件 + 应用内「说明」面板（`web/index.html` #about）
  均保留上述来源与许可名称；`web/data/*.json` 的 `meta` 字段内嵌来源与许可标识。
- CC BY-SA 相同方式共享：派生词典数据以 CC BY-SA 4.0 再发布（见上）。
- MPL-2.0：运行时原文许可随附；模型二进制不入库、仅脚本获取。
- Apache-2.0：保留组件名称与许可名称；许可原文可于上游仓库获取。
