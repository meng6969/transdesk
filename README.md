# 译台 TransDesk

纯离线的中 / 英 / 日翻译台：静态网站 + Android 10+ APK。词典、规则、OCR 与可选的 Bergamot 神经模型全部在本机运行，无账号、无后端、无第三方请求。

> **AI 生成声明：** 本项目由 AI 辅助生成，按现状提供，重要文本请自行核对。详见 [AI_DISCLOSURE.md](AI_DISCLOSURE.md)。
>
> **许可：** 原创代码自 v1.5 起采用 [PolyForm Noncommercial 1.0.0](LICENSE)，源码公开，仅供学习、研究与个人等非商业用途；**禁止商业使用、付费分发和倒卖**。第三方组件与数据保持原许可，见 [NOTICE.md](NOTICE.md)。v1.4 及更早的历史副本仍按 MIT 使用。

## 在线与下载

- 官网：<https://transdesk-rg8bmuwp2yo.qoder.zone>
  携带**英→中**神经模型；中→英自动回退词典引擎。
- 本站与 APP 均为纯静态/离线应用；模型加载失败时自动回退词典，不报错。

## 功能

- 中⇄英、中⇄日四个方向。
- 短语最长匹配、日文活用还原、虚词与语序规则、逐段对照与判定依据。


## 词典来源

`vendor/` 保留上游开放许可资料；构建脚本只做机械清洗与表查询。**查不通、或释义是“参见某条”等参照项的一律丢弃，不手工补词。** 来源与许可标识写入 `web/data/*.json` 的 `meta`。

主要来源：Word Atlas（CC BY 4.0）、CC-CEDICT（CC BY-SA 4.0）、JMdict / KANJIDIC2 / KanjiVG（CC BY-SA 4.0）、JmdictFurigana 与 Tatoeba（见 NOTICE）、jieba（MIT）。

## 贡献

提交前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。请勿提交密钥、模型二进制、缓存或隐私文本。

## 边界

不适合法律、合同、医疗、财务等精确文本，也不擅长文学双关与长难嵌套从句。中→英 / 中→日以短句为主，长段落可能退化为关键词式译文；专有名词可在“我的词典”中固定。
