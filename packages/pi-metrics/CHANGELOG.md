# Changelog

## [0.7.0](https://github.com/maplezzk/pi-extensions/compare/pi-metrics-v0.6.0...pi-metrics-v0.7.0) (2026-09-15)


### Features

* **pi-metrics:** 显示时机可配置，默认改成停下后汇总一行 ([0c66c65](https://github.com/maplezzk/pi-extensions/commit/0c66c6597a6462ccc60310ef9b1ef9adfa58d0a7))
* **pi-metrics:** 显示时机可配置，默认改成停下后汇总一行 ([97afc11](https://github.com/maplezzk/pi-extensions/commit/97afc114f997b01b782668eab694582f98c478fb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.6.0 to ^0.7.0

## [0.6.0](https://github.com/maplezzk/pi-extensions/compare/pi-metrics-v0.5.0...pi-metrics-v0.6.0) (2026-09-14)


### Features

* show notices as filled transcript blocks under the message ([eb00293](https://github.com/maplezzk/pi-extensions/commit/eb002934f273df12cb109e54817dd16fdb09d52a))
* 提示改成会话区的带底色消息块，判定结论落在消息下方 ([f42992d](https://github.com/maplezzk/pi-extensions/commit/f42992d39af35e3fda33f681f833d89408cb4a3a))
* 每轮只发一条判定提示，指标提示不再重复 ([ef8398c](https://github.com/maplezzk/pi-extensions/commit/ef8398cd19808215f85a7ef771c0deb238a6f61f))
* 每轮只发一条判定提示，指标提示也不再重复 ([d123f51](https://github.com/maplezzk/pi-extensions/commit/d123f519c6d6e21f49d6786809eab7e34c8fd1f8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.5.0 to ^0.6.0

## [0.5.0](https://github.com/maplezzk/pi-extensions/compare/pi-metrics-v0.4.2...pi-metrics-v0.5.0) (2026-09-13)


### Features

* 所有扩展提示统一加来源标签与颜色 ([21ad9d9](https://github.com/maplezzk/pi-extensions/commit/21ad9d97347118a9817ae445bc03544b7c1c66da))
* 所有扩展提示统一加来源标签与颜色 ([a06c6f8](https://github.com/maplezzk/pi-extensions/commit/a06c6f86367fc7b43f14b34f754bddc4b6dd340a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.4.1 to ^0.5.0

## [0.4.2](https://github.com/maplezzk/pi-extensions/compare/pi-metrics-v0.4.1...pi-metrics-v0.4.2) (2026-09-13)


### Bug Fixes

* pi peer 范围只保留下限 &gt;=0.80.0 ([fdc012c](https://github.com/maplezzk/pi-extensions/commit/fdc012c7a0a968712cea4430afd7780eab53420b))
* 去掉 pi peer 上界并升级依赖到 0.85.1 ([28e897e](https://github.com/maplezzk/pi-extensions/commit/28e897eb45d76e91ca8ac6ac2a508a36c76c5682))
* 放宽 pi peer 范围并升级依赖到 0.85.1 ([3444c0c](https://github.com/maplezzk/pi-extensions/commit/3444c0cb4836006348fc6a9fbd30fe36bdc98ced))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.4.0 to ^0.4.1

## [0.4.1](https://github.com/maplezzk/pi-extensions/compare/pi-metrics-v0.4.0...pi-metrics-v0.4.1) (2026-09-07)


### Bug Fixes

* **safety-guards:** explain blocked external paths ([6c0e923](https://github.com/maplezzk/pi-extensions/commit/6c0e9233b2edb1e522eecf68d54b146e41a92bfe))

## [0.4.0](https://github.com/maplezzk/pi-extensions/compare/pi-metrics-v0.3.0...pi-metrics-v0.4.0) (2026-09-07)


### Features

* 统一插件配置文件与斜杠命令 ([0a72e38](https://github.com/maplezzk/pi-extensions/commit/0a72e38eca217d044e4a0d36894bba5bc45af256))
* 统一插件配置文件与斜杠命令 ([5bc2191](https://github.com/maplezzk/pi-extensions/commit/5bc21917f358fc094c832e6f211ec7771349fa8e))


### Bug Fixes

* 使用 TUI 配置插件设置 ([47b1524](https://github.com/maplezzk/pi-extensions/commit/47b152459b89a3d41a0c11250f0994bd5d4a8eba))
* 改为 TUI 配置交互 ([3bd68af](https://github.com/maplezzk/pi-extensions/commit/3bd68afc58dd81f02d32045b2b64d785d70c0542))

## [0.3.0](https://github.com/maplezzk/pi-extensions/compare/pi-metrics-v0.2.3...pi-metrics-v0.3.0) (2026-08-20)


### Features

* 为每个扩展提供配置 Skill ([626a731](https://github.com/maplezzk/pi-extensions/commit/626a73155279e44e89ca10f59b91cea6d174e63d))
* 为每个扩展提供配置 Skill ([9bb7374](https://github.com/maplezzk/pi-extensions/commit/9bb737457af0ece197894b4b9488373ab5f8e38f))


### Bug Fixes

* 将配置 Skill 放入各扩展根目录 ([57a9863](https://github.com/maplezzk/pi-extensions/commit/57a98635e63856df6631f3cfe724c325b28f15cc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.3.1 to ^0.4.0

## [0.2.3](https://github.com/maplezzk/pi-extensions/compare/pi-metrics-v0.2.2...pi-metrics-v0.2.3) (2026-07-27)


### Bug Fixes

* auto-install shared i18n extension dependencies ([6d5e069](https://github.com/maplezzk/pi-extensions/commit/6d5e06973ae82c69b51b9c68995a82704f7afbd3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.3.0 to ^0.3.1

## [0.2.2](https://github.com/maplezzk/pi-extensions/compare/pi-metrics-v0.2.1...pi-metrics-v0.2.2) (2026-07-23)


### Bug Fixes

* 修复扩展重载生命周期并整合 TPS 指标 ([#47](https://github.com/maplezzk/pi-extensions/issues/47)) ([2999e36](https://github.com/maplezzk/pi-extensions/commit/2999e3681b08067a919db95097415ca51742580b))

## [0.2.1](https://github.com/maplezzk/pi-extensions/compare/pi-metrics-v0.2.0...pi-metrics-v0.2.1) (2026-07-21)


### Bug Fixes

* repair release pipeline, rename pi-hud → pi-metrics, add package config CI gate ([#37](https://github.com/maplezzk/pi-extensions/issues/37)) ([3aa4985](https://github.com/maplezzk/pi-extensions/commit/3aa49850dfc6200ea2e8186e85649ecf7e41d697))

## [0.2.0](https://github.com/maplezzk/pi-extensions/compare/pi-hud-v0.1.0...pi-hud-v0.2.0) (2026-07-21)


### Features

* 新增 pi-hud 会话耗时 HUD 包 ([#30](https://github.com/maplezzk/pi-extensions/issues/30)) ([e4076e3](https://github.com/maplezzk/pi-extensions/commit/e4076e3b47b0ea0540044b93081aad2bda6ea769))
