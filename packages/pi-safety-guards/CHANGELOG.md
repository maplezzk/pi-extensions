# Changelog

## [1.0.1](https://github.com/maplezzk/pi-extensions/compare/pi-safety-guards-v1.0.0...pi-safety-guards-v1.0.1) (2026-09-19)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.7.0 to ^0.8.0

## [1.0.0](https://github.com/maplezzk/pi-extensions/compare/pi-safety-guards-v0.4.0...pi-safety-guards-v1.0.0) (2026-09-19)


### ⚠ BREAKING CHANGES

* **safety-guards:** presets 字段与 presets/ 目录已删除，旧配置需要把规则直接写进 rules；/config:safety-guards reset 和 TUI 预设菜单已移除。
* 配置里的 match.detector 已移除，请改用 commands / commandPrefixes / commandPattern，或需要精确判断时用 module。

### Features

* **safety-guards:** 删除预设，规则直接写进 config.json ([451f7e6](https://github.com/maplezzk/pi-extensions/commit/451f7e663118a1d8839890231b5e2d96228ae02d))
* 安全预设改为读取包内 JSON 规则文件 ([a821ba0](https://github.com/maplezzk/pi-extensions/commit/a821ba08c8a040592c39fedc6496c9a0a311616f))
* 安全预设改为读取包内 JSON 规则文件 ([58389c2](https://github.com/maplezzk/pi-extensions/commit/58389c2d73747c84e60a42edc4fb7a5fb7e3bf28))
* 移除 detector，匹配逻辑全部写进配置 ([2ef6d3c](https://github.com/maplezzk/pi-extensions/commit/2ef6d3c6389a62d5399df9083afe2256a6d6efda))


### Bug Fixes

* 解释器程序正文不再被当成路径导致安全规则失败 ([23d5a54](https://github.com/maplezzk/pi-extensions/commit/23d5a544e794a30c9a3aabd55e80dadb804c800c))
* 解释器程序正文不再被当成路径导致安全规则失败 ([caa6d5a](https://github.com/maplezzk/pi-extensions/commit/caa6d5ab5d30057e7a05a477a7f5958a875df9d6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.6.0 to ^0.7.0

## [0.4.0](https://github.com/maplezzk/pi-extensions/compare/pi-safety-guards-v0.3.0...pi-safety-guards-v0.4.0) (2026-09-14)


### Features

* show notices as filled transcript blocks under the message ([eb00293](https://github.com/maplezzk/pi-extensions/commit/eb002934f273df12cb109e54817dd16fdb09d52a))
* 提示改成会话区的带底色消息块，判定结论落在消息下方 ([f42992d](https://github.com/maplezzk/pi-extensions/commit/f42992d39af35e3fda33f681f833d89408cb4a3a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.5.0 to ^0.6.0

## [0.3.0](https://github.com/maplezzk/pi-extensions/compare/pi-safety-guards-v0.2.2...pi-safety-guards-v0.3.0) (2026-09-13)


### Features

* 所有扩展提示统一加来源标签与颜色 ([21ad9d9](https://github.com/maplezzk/pi-extensions/commit/21ad9d97347118a9817ae445bc03544b7c1c66da))
* 所有扩展提示统一加来源标签与颜色 ([a06c6f8](https://github.com/maplezzk/pi-extensions/commit/a06c6f86367fc7b43f14b34f754bddc4b6dd340a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.4.1 to ^0.5.0

## [0.2.2](https://github.com/maplezzk/pi-extensions/compare/pi-safety-guards-v0.2.1...pi-safety-guards-v0.2.2) (2026-09-13)


### Bug Fixes

* pi peer 范围只保留下限 &gt;=0.80.0 ([fdc012c](https://github.com/maplezzk/pi-extensions/commit/fdc012c7a0a968712cea4430afd7780eab53420b))
* 去掉 pi peer 上界并升级依赖到 0.85.1 ([28e897e](https://github.com/maplezzk/pi-extensions/commit/28e897eb45d76e91ca8ac6ac2a508a36c76c5682))
* 放宽 pi peer 范围并升级依赖到 0.85.1 ([3444c0c](https://github.com/maplezzk/pi-extensions/commit/3444c0cb4836006348fc6a9fbd30fe36bdc98ced))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.4.0 to ^0.4.1

## [0.2.1](https://github.com/maplezzk/pi-extensions/compare/pi-safety-guards-v0.2.0...pi-safety-guards-v0.2.1) (2026-09-07)


### Bug Fixes

* explain blocked external Bash paths ([e58fb0a](https://github.com/maplezzk/pi-extensions/commit/e58fb0a904b03aa990c3922390378034ed07da5d))
* **safety-guards:** explain blocked external paths ([6c0e923](https://github.com/maplezzk/pi-extensions/commit/6c0e9233b2edb1e522eecf68d54b146e41a92bfe))
* **safety-guards:** explain blocked external paths ([d02e359](https://github.com/maplezzk/pi-extensions/commit/d02e35940f0e0c803a11c5f842847622dad0601d))

## [0.2.0](https://github.com/maplezzk/pi-extensions/compare/pi-safety-guards-v0.1.0...pi-safety-guards-v0.2.0) (2026-09-07)


### Features

* 新增可独立配置的安全守卫 ([57ca630](https://github.com/maplezzk/pi-extensions/commit/57ca630c286e895eb34d5cc35d9607c586fab9ab))
* 新增可选预设与自定义规则的安全守卫 ([8a58394](https://github.com/maplezzk/pi-extensions/commit/8a583946acb8211e2ab4344ff773682d85d52548))
* 统一插件配置文件与斜杠命令 ([0a72e38](https://github.com/maplezzk/pi-extensions/commit/0a72e38eca217d044e4a0d36894bba5bc45af256))
* 统一插件配置文件与斜杠命令 ([5bc2191](https://github.com/maplezzk/pi-extensions/commit/5bc21917f358fc094c832e6f211ec7771349fa8e))


### Bug Fixes

* 使用 TUI 配置插件设置 ([47b1524](https://github.com/maplezzk/pi-extensions/commit/47b152459b89a3d41a0c11250f0994bd5d4a8eba))
* 合入 main 解决通知插件冲突并修复测试竞态 ([ddfbf0a](https://github.com/maplezzk/pi-extensions/commit/ddfbf0a8a8d7527fab4da4d53a59a22974244fa8))
* 同步 main 并解决命名插件登记冲突 ([de731e1](https://github.com/maplezzk/pi-extensions/commit/de731e1a0fec2153f56d8821b071638adc614d92))
* 恢复公开目录守卫的压缩后授权 ([1877f3a](https://github.com/maplezzk/pi-extensions/commit/1877f3a62ad733830df9198d5ad572e36e7110e5))
* 恢复公开目录守卫的压缩后授权 ([e18e1c8](https://github.com/maplezzk/pi-extensions/commit/e18e1c871e51fb831558df3af4ba499f81d66d7c))
* 改为 TUI 配置交互 ([3bd68af](https://github.com/maplezzk/pi-extensions/commit/3bd68afc58dd81f02d32045b2b64d785d70c0542))
