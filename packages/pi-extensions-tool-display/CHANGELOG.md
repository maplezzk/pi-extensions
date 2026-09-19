# Changelog

## [1.3.2](https://github.com/maplezzk/pi-extensions/compare/pi-extensions-tool-display-v1.3.1...pi-extensions-tool-display-v1.3.2) (2026-09-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.7.0 to ^0.8.0

## [1.3.1](https://github.com/maplezzk/pi-extensions/compare/pi-extensions-tool-display-v1.3.0...pi-extensions-tool-display-v1.3.1) (2026-09-19)


### Bug Fixes

* **tool-display:** 结果渲染中间件覆盖所有扩展注册的工具 ([abfcfbf](https://github.com/maplezzk/pi-extensions/commit/abfcfbf1565895e60e0cbece12fb252eb08f152c))
* **tool-display:** 结果渲染中间件覆盖所有扩展注册的工具 ([8a4e112](https://github.com/maplezzk/pi-extensions/commit/8a4e112308ddcd8ede8f4907e3ab8e8bd3672ac8)), closes [#187](https://github.com/maplezzk/pi-extensions/issues/187)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.6.0 to ^0.7.0

## [1.3.0](https://github.com/maplezzk/pi-extensions/compare/pi-extensions-tool-display-v1.2.0...pi-extensions-tool-display-v1.3.0) (2026-09-14)


### Features

* show notices as filled transcript blocks under the message ([eb00293](https://github.com/maplezzk/pi-extensions/commit/eb002934f273df12cb109e54817dd16fdb09d52a))
* 提示改成会话区的带底色消息块，判定结论落在消息下方 ([f42992d](https://github.com/maplezzk/pi-extensions/commit/f42992d39af35e3fda33f681f833d89408cb4a3a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.5.0 to ^0.6.0

## [1.2.0](https://github.com/maplezzk/pi-extensions/compare/pi-extensions-tool-display-v1.1.2...pi-extensions-tool-display-v1.2.0) (2026-09-13)


### Features

* 所有扩展提示统一加来源标签与颜色 ([21ad9d9](https://github.com/maplezzk/pi-extensions/commit/21ad9d97347118a9817ae445bc03544b7c1c66da))
* 所有扩展提示统一加来源标签与颜色 ([a06c6f8](https://github.com/maplezzk/pi-extensions/commit/a06c6f86367fc7b43f14b34f754bddc4b6dd340a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.4.0 to ^0.5.0

## [1.1.2](https://github.com/maplezzk/pi-extensions/compare/pi-extensions-tool-display-v1.1.1...pi-extensions-tool-display-v1.1.2) (2026-09-13)


### Bug Fixes

* pi peer 范围只保留下限 &gt;=0.80.0 ([fdc012c](https://github.com/maplezzk/pi-extensions/commit/fdc012c7a0a968712cea4430afd7780eab53420b))
* 去掉 pi peer 上界并升级依赖到 0.85.1 ([28e897e](https://github.com/maplezzk/pi-extensions/commit/28e897eb45d76e91ca8ac6ac2a508a36c76c5682))
* 放宽 pi peer 范围并升级依赖到 0.85.1 ([3444c0c](https://github.com/maplezzk/pi-extensions/commit/3444c0cb4836006348fc6a9fbd30fe36bdc98ced))

## [1.1.1](https://github.com/maplezzk/pi-extensions/compare/pi-extensions-tool-display-v1.1.0...pi-extensions-tool-display-v1.1.1) (2026-08-31)


### Bug Fixes

* **tool-display:** preserve active tool selection ([47a84b9](https://github.com/maplezzk/pi-extensions/commit/47a84b97cf2f4de244279e4ac71e190aa4de16a3))
* 保持工具展示覆盖的激活状态 ([c734a7b](https://github.com/maplezzk/pi-extensions/commit/c734a7b7d2db53c1d3001ff6559998d6bff3b448))

## [1.1.0](https://github.com/maplezzk/pi-extensions/compare/pi-extensions-tool-display-v1.0.1...pi-extensions-tool-display-v1.1.0) (2026-08-20)


### Features

* 为每个扩展提供配置 Skill ([626a731](https://github.com/maplezzk/pi-extensions/commit/626a73155279e44e89ca10f59b91cea6d174e63d))
* 为每个扩展提供配置 Skill ([9bb7374](https://github.com/maplezzk/pi-extensions/commit/9bb737457af0ece197894b4b9488373ab5f8e38f))


### Bug Fixes

* 将配置 Skill 放入各扩展根目录 ([57a9863](https://github.com/maplezzk/pi-extensions/commit/57a98635e63856df6631f3cfe724c325b28f15cc))

## [1.0.1](https://github.com/maplezzk/pi-extensions/compare/pi-extensions-tool-display-v1.0.0...pi-extensions-tool-display-v1.0.1) (2026-07-23)


### Bug Fixes

* 修复扩展重载生命周期并整合 TPS 指标 ([#47](https://github.com/maplezzk/pi-extensions/issues/47)) ([2999e36](https://github.com/maplezzk/pi-extensions/commit/2999e3681b08067a919db95097415ca51742580b))

## [1.0.0](https://github.com/maplezzk/pi-extensions/compare/pi-extensions-tool-display-v0.2.2...pi-extensions-tool-display-v1.0.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* **pi-distill:** 工具 schema 中的 outputPrompt 字段已移除，请使用 outputRequest

### Features

* **pi-distill:** rename outputPrompt to outputRequest ([#29](https://github.com/maplezzk/pi-extensions/issues/29)) ([eeaa5a6](https://github.com/maplezzk/pi-extensions/commit/eeaa5a6964c0bb273c967e001dd4fb986c7f6227))

## [0.2.2](https://github.com/maplezzk/pi-extensions/compare/pi-extensions-tool-display-v0.2.1...pi-extensions-tool-display-v0.2.2) (2026-07-20)


### Bug Fixes

* load tool display as a dependency extension ([#18](https://github.com/maplezzk/pi-extensions/issues/18)) ([d50b392](https://github.com/maplezzk/pi-extensions/commit/d50b392a44181328d2446182ecfe67d11b650061))

## [0.2.1](https://github.com/maplezzk/pi-extensions/compare/pi-extensions-tool-display-v0.2.0...pi-extensions-tool-display-v0.2.1) (2026-07-20)


### Bug Fixes

* deduplicate shared tool display command ([d4c7588](https://github.com/maplezzk/pi-extensions/commit/d4c75886279eb8747af0ae77c0a23e77017dae49))

## [0.2.0](https://github.com/maplezzk/pi-extensions/compare/pi-extensions-tool-display-v0.1.1...pi-extensions-tool-display-v0.2.0) (2026-07-20)


### Features

* embed the tool display host ([eb83f33](https://github.com/maplezzk/pi-extensions/commit/eb83f33c3cc6f45477ce116ae601fa229316fcf4))
* embed the tool display host ([1154156](https://github.com/maplezzk/pi-extensions/commit/11541567693f2f83bb7e1fca565e04f67a8f058b))

## [0.1.1](https://github.com/maplezzk/pi-extensions/compare/pi-extensions-tool-display-v0.1.0...pi-extensions-tool-display-v0.1.1) (2026-07-19)


### Bug Fixes

* use unique shared tool display package name ([0b49bc1](https://github.com/maplezzk/pi-extensions/commit/0b49bc12886d6fddfd59fad950156458085b2bb6))
* use unique shared tool display package name ([913ba1e](https://github.com/maplezzk/pi-extensions/commit/913ba1e12946ba349d4062ca6781d497fbd84cfc))

## [0.1.0] (2026-07-19)

### Features

* add shared result-render middleware protocol and component helpers
