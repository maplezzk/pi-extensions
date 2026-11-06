# Changelog

## [1.8.0](https://github.com/maplezzk/pi-extensions/compare/pi-models-discovery-v1.7.0...pi-models-discovery-v1.8.0) (2026-11-06)


### Features

* **pi-models-discovery:** add generic per-model API overrides ([#243](https://github.com/maplezzk/pi-extensions/issues/243)) ([4058f39](https://github.com/maplezzk/pi-extensions/commit/4058f39b82852713e0092b2569a4e4e5b8a61197))

## [1.7.0](https://github.com/maplezzk/pi-extensions/compare/pi-models-discovery-v1.6.1...pi-models-discovery-v1.7.0) (2026-10-24)


### Features

* **pi-models-discovery:** read advertised model metadata ([702ce19](https://github.com/maplezzk/pi-extensions/commit/702ce19d1632551648e92acfdff21883400e167d))
* **pi-models-discovery:** read advertised model metadata ([858660e](https://github.com/maplezzk/pi-extensions/commit/858660e85ea1edb68709a052782231e14ce5f132))

## [1.6.1](https://github.com/maplezzk/pi-extensions/compare/pi-models-discovery-v1.6.0...pi-models-discovery-v1.6.1) (2026-10-17)


### Bug Fixes

* **pi-models-discovery:** read vLLM max_model_len as the context window ([a3d2f23](https://github.com/maplezzk/pi-extensions/commit/a3d2f233c6c07c78b3a7765675c782c279222302))
* **pi-models-discovery:** read vLLM max_model_len as the context window ([147ecb8](https://github.com/maplezzk/pi-extensions/commit/147ecb8871896762c117f7518d72c4012ef9b272))
* **pi-models-discovery:** respect provider thinking configuration ([24708fc](https://github.com/maplezzk/pi-extensions/commit/24708fce95c244f6eedd59820e485282fe6f6525))
* **pi-models-discovery:** respect provider thinking configuration ([513e30c](https://github.com/maplezzk/pi-extensions/commit/513e30cc6636588166fa625254aa893c0b123ebf))

## [1.6.0](https://github.com/maplezzk/pi-extensions/compare/pi-models-discovery-v1.5.0...pi-models-discovery-v1.6.0) (2026-10-05)


### Features

* 统一全仓库配置 UI 为 SettingsList 面板 + 新增 pi-gen-ui ([c67a8c3](https://github.com/maplezzk/pi-extensions/commit/c67a8c3356f249ef5a49699d05ad2824b2ac008a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.8.0 to ^0.9.0

## [1.5.0](https://github.com/maplezzk/pi-extensions/compare/pi-models-discovery-v1.4.0...pi-models-discovery-v1.5.0) (2026-10-04)


### Features

* **pi-models-discovery:** 支持通过 modelsUrl 独立配置模型发现地址 ([c218e98](https://github.com/maplezzk/pi-extensions/commit/c218e983782658751d2b0ae88bb1ca15cbce6e57))
* **pi-models-discovery:** 支持通过 modelsUrl 独立配置模型发现地址 ([b9b6c3d](https://github.com/maplezzk/pi-extensions/commit/b9b6c3dbc18db0a588b107e483cffbaabe41adb4))

## [1.4.0](https://github.com/maplezzk/pi-extensions/compare/pi-models-discovery-v1.3.1...pi-models-discovery-v1.4.0) (2026-09-21)


### Features

* **pi-models-discovery:** 发现模型默认暴露 xhigh/max 思考等级 ([817e092](https://github.com/maplezzk/pi-extensions/commit/817e09204cd87fa0fcf6e2cd37a3fed33c6abcb8))
* **pi-models-discovery:** 发现模型默认暴露 xhigh/max 思考等级 ([5241ae4](https://github.com/maplezzk/pi-extensions/commit/5241ae4926106d82d0d43097043fd6a2d2df20f0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.7.0 to ^0.8.0

## [1.3.1](https://github.com/maplezzk/pi-extensions/compare/pi-models-discovery-v1.3.0...pi-models-discovery-v1.3.1) (2026-09-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.6.0 to ^0.7.0

## [1.3.0](https://github.com/maplezzk/pi-extensions/compare/pi-models-discovery-v1.2.0...pi-models-discovery-v1.3.0) (2026-09-14)


### Features

* show notices as filled transcript blocks under the message ([eb00293](https://github.com/maplezzk/pi-extensions/commit/eb002934f273df12cb109e54817dd16fdb09d52a))
* 提示改成会话区的带底色消息块，判定结论落在消息下方 ([f42992d](https://github.com/maplezzk/pi-extensions/commit/f42992d39af35e3fda33f681f833d89408cb4a3a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.5.0 to ^0.6.0

## [1.2.0](https://github.com/maplezzk/pi-extensions/compare/pi-models-discovery-v1.1.1...pi-models-discovery-v1.2.0) (2026-09-13)


### Features

* 所有扩展提示统一加来源标签与颜色 ([21ad9d9](https://github.com/maplezzk/pi-extensions/commit/21ad9d97347118a9817ae445bc03544b7c1c66da))
* 所有扩展提示统一加来源标签与颜色 ([a06c6f8](https://github.com/maplezzk/pi-extensions/commit/a06c6f86367fc7b43f14b34f754bddc4b6dd340a))


### Bug Fixes

* **pi-models-discovery:** 移除发现模型硬编码的 thinkingLevelMap ([bc64dcc](https://github.com/maplezzk/pi-extensions/commit/bc64dcc55e089b33102a861aea9eee8d239406bf))
* **pi-models-discovery:** 移除发现模型硬编码的 thinkingLevelMap ([8ed08cb](https://github.com/maplezzk/pi-extensions/commit/8ed08cb29f835b3599e61f822948d17171901591))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.4.1 to ^0.5.0

## [1.1.1](https://github.com/maplezzk/pi-extensions/compare/pi-models-discovery-v1.1.0...pi-models-discovery-v1.1.1) (2026-09-13)


### Bug Fixes

* pi peer 范围只保留下限 &gt;=0.80.0 ([fdc012c](https://github.com/maplezzk/pi-extensions/commit/fdc012c7a0a968712cea4430afd7780eab53420b))
* 去掉 pi peer 上界并升级依赖到 0.85.1 ([28e897e](https://github.com/maplezzk/pi-extensions/commit/28e897eb45d76e91ca8ac6ac2a508a36c76c5682))
* 放宽 pi peer 范围并升级依赖到 0.85.1 ([3444c0c](https://github.com/maplezzk/pi-extensions/commit/3444c0cb4836006348fc6a9fbd30fe36bdc98ced))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.4.0 to ^0.4.1

## [1.1.0](https://github.com/maplezzk/pi-extensions/compare/pi-models-discovery-v1.0.1...pi-models-discovery-v1.1.0) (2026-08-20)


### Features

* 为每个扩展提供配置 Skill ([626a731](https://github.com/maplezzk/pi-extensions/commit/626a73155279e44e89ca10f59b91cea6d174e63d))
* 为每个扩展提供配置 Skill ([9bb7374](https://github.com/maplezzk/pi-extensions/commit/9bb737457af0ece197894b4b9488373ab5f8e38f))


### Bug Fixes

* 将配置 Skill 放入各扩展根目录 ([57a9863](https://github.com/maplezzk/pi-extensions/commit/57a98635e63856df6631f3cfe724c325b28f15cc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.3.1 to ^0.4.0

## [1.0.1](https://github.com/maplezzk/pi-extensions/compare/pi-models-discovery-v1.0.0...pi-models-discovery-v1.0.1) (2026-07-27)


### Bug Fixes

* auto-install shared i18n extension dependencies ([6d5e069](https://github.com/maplezzk/pi-extensions/commit/6d5e06973ae82c69b51b9c68995a82704f7afbd3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.3.0 to ^0.3.1

## 1.0.0 (2026-07-21)


### Bug Fixes

* repair release pipeline, rename pi-hud → pi-metrics, add package config CI gate ([#37](https://github.com/maplezzk/pi-extensions/issues/37)) ([3aa4985](https://github.com/maplezzk/pi-extensions/commit/3aa49850dfc6200ea2e8186e85649ecf7e41d697))
