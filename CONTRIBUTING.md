# 参与贡献

欢迎学习、研究和个人非商业改进。提交 Issue 或 Pull Request 前请：

- 不提交 token、签名密钥、`android/transdesk.keystore`、模型二进制或构建缓存。
- 词典词条只能由开放授权资料机械清洗/表查询生成；查不通或仅为“参见某条”的参照项必须丢弃，不手工补词。
- 保留 `web/data/*.json` 的 `meta` 来源与许可字段，以及 `NOTICE.md` 的第三方署名。
- 不加入第三方域名请求；Android 壳继续不申请 `INTERNET` 权限。
- 修改引擎后运行 `node test.js`；修改安卓壳后运行 `bash android/rebuild.sh` 并检查 APK 可安装。
- 说明测试环境、改动目的和已知限制。AI 辅助生成的内容应在 PR 中如实标注。

新贡献默认采用与本项目相同的 PolyForm Noncommercial 1.0.0 许可；第三方材料保持原许可。
