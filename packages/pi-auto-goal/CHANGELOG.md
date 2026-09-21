# Changelog

## [0.6.1](https://github.com/maplezzk/pi-extensions/compare/pi-auto-goal-v0.6.0...pi-auto-goal-v0.6.1) (2026-09-21)


### Bug Fixes

* **pi-auto-goal:** 催促改用 system 提示注入，并修掉改动指令的漏催 ([cd86dd8](https://github.com/maplezzk/pi-extensions/commit/cd86dd8b9cd72e7fed1d66bab7bc014d79ae17f6))
* **pi-auto-goal:** 催促改用 system 提示注入，并修掉改动指令的漏催 ([af0ec0c](https://github.com/maplezzk/pi-extensions/commit/af0ec0c1f651093a45c0fe5121dd762322cae90c))
* **pi-auto-goal:** 判定纳入 ask_user_question 的用户回答 ([d13a808](https://github.com/maplezzk/pi-extensions/commit/d13a808760e115fa5c40b54b5c1262d0e7a878d8))
* **pi-auto-goal:** 判定纳入 ask_user_question 的用户回答 ([8f35bbd](https://github.com/maplezzk/pi-extensions/commit/8f35bbda1dc367cf930deab79bb1272b467985c7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.7.0 to ^0.8.0

## [0.6.0](https://github.com/maplezzk/pi-extensions/compare/pi-auto-goal-v0.5.0...pi-auto-goal-v0.6.0) (2026-09-19)


### Features

* **pi-auto-goal:** 判定模型可以在菜单和命令里直接选 ([dc57eb4](https://github.com/maplezzk/pi-extensions/commit/dc57eb4215c220fd69bdc7c661d01eac4d1a29da))
* **pi-auto-goal:** 判定模型可在菜单和命令里直接选 ([236aeef](https://github.com/maplezzk/pi-extensions/commit/236aeefb88efe491175074435be379caf8481dcb))
* 判定上下文默认不带工具轨迹 ([b285130](https://github.com/maplezzk/pi-extensions/commit/b28513037737fcfd5b8078bc1311531095af51f0))
* 判定可停止的理由直接写进提示正文 ([83ceafd](https://github.com/maplezzk/pi-extensions/commit/83ceafdac277fd1f8cbff9b46e38352b10a6548c))


### Bug Fixes

* **pi-auto-goal:** 判定理由回到默认收起 ([6b59e1a](https://github.com/maplezzk/pi-extensions/commit/6b59e1a4b4c8083bc818dd54bf475b73de9400eb))
* **pi-auto-goal:** 等后台任务时判为可停止，判定默认只看最后输出 ([bc0c280](https://github.com/maplezzk/pi-extensions/commit/bc0c28017bf9db1fd583c431a81bf6c90dd278c0))
* 判定可停止的理由改为默认显示在结论下一行 ([8ca4003](https://github.com/maplezzk/pi-extensions/commit/8ca4003205f4c758b2af90452383975fac8b50b2))
* 判定提示写清置信度百分比并换双宽图标 ([113eae9](https://github.com/maplezzk/pi-extensions/commit/113eae95774af53af9f0ec39b403b67b3d16d6cc))
* 判定提示写清置信度百分比并换双宽图标 ([13d0ea0](https://github.com/maplezzk/pi-extensions/commit/13d0ea0e1bea16754a83b9961eff8e32a330b420))
* 后台任务在跑时不再把停止判为提前停止 ([90eb7cd](https://github.com/maplezzk/pi-extensions/commit/90eb7cd19e26154b4925b14c6224dc8aec33e647))
* 后台任务规则改为只看 agent 最后输出 ([4fd4daf](https://github.com/maplezzk/pi-extensions/commit/4fd4dafbf6402fa92362fd0ce23a01a876bc99de))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.6.0 to ^0.7.0

## [0.5.0](https://github.com/maplezzk/pi-extensions/compare/pi-auto-goal-v0.4.0...pi-auto-goal-v0.5.0) (2026-09-14)


### Features

* show notices as filled transcript blocks under the message ([eb00293](https://github.com/maplezzk/pi-extensions/commit/eb002934f273df12cb109e54817dd16fdb09d52a))
* 提示改成会话区的带底色消息块，判定结论落在消息下方 ([f42992d](https://github.com/maplezzk/pi-extensions/commit/f42992d39af35e3fda33f681f833d89408cb4a3a))
* 每轮只发一条判定提示，指标提示不再重复 ([ef8398c](https://github.com/maplezzk/pi-extensions/commit/ef8398cd19808215f85a7ef771c0deb238a6f61f))
* 每轮只发一条判定提示，指标提示也不再重复 ([d123f51](https://github.com/maplezzk/pi-extensions/commit/d123f519c6d6e21f49d6786809eab7e34c8fd1f8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.5.0 to ^0.6.0

## [0.4.0](https://github.com/maplezzk/pi-extensions/compare/pi-auto-goal-v0.3.0...pi-auto-goal-v0.4.0) (2026-09-13)


### Features

* 所有扩展提示统一加来源标签与颜色 ([21ad9d9](https://github.com/maplezzk/pi-extensions/commit/21ad9d97347118a9817ae445bc03544b7c1c66da))
* 所有扩展提示统一加来源标签与颜色 ([a06c6f8](https://github.com/maplezzk/pi-extensions/commit/a06c6f86367fc7b43f14b34f754bddc4b6dd340a))


### Bug Fixes

* **pi-auto-goal:** 用户按 Esc 打断后不再判定，避免把 agent 自动复活 ([48bbe9a](https://github.com/maplezzk/pi-extensions/commit/48bbe9ace192c123146cef78966aeaf551e23145))
* **pi-auto-goal:** 用户按 Esc 打断后不再判定，避免把 agent 自动复活 ([2b527f8](https://github.com/maplezzk/pi-extensions/commit/2b527f8de52ad1125d0794db768421f69dcb54f8))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.4.1 to ^0.5.0

## [0.3.0](https://github.com/maplezzk/pi-extensions/compare/pi-auto-goal-v0.2.0...pi-auto-goal-v0.3.0) (2026-09-13)


### Features

* **pi-auto-goal:** 判定结果常驻页脚一行状态，提示按结论上色 ([5641479](https://github.com/maplezzk/pi-extensions/commit/56414795c553b8e5bbe8201a86572f180a6f9250))
* **pi-auto-goal:** 判定结果常驻页脚一行状态，提示按结论上色 ([bac11ec](https://github.com/maplezzk/pi-extensions/commit/bac11ec50b4b62bed13374d4ce1f51ca328e90b0))


### Bug Fixes

* pi peer 范围只保留下限 &gt;=0.80.0 ([fdc012c](https://github.com/maplezzk/pi-extensions/commit/fdc012c7a0a968712cea4430afd7780eab53420b))
* **pi-auto-goal:** 判定响应被截断时不再只报「空响应」 ([3c0de4b](https://github.com/maplezzk/pi-extensions/commit/3c0de4b9b0c10083039a3bff62836668a7643f2a))
* **pi-auto-goal:** 判定响应被截断时不再只报「空响应」 ([16467f8](https://github.com/maplezzk/pi-extensions/commit/16467f8cef2fcba9118eacd20367b214332fa1e9))
* 去掉 pi peer 上界并升级依赖到 0.85.1 ([28e897e](https://github.com/maplezzk/pi-extensions/commit/28e897eb45d76e91ca8ac6ac2a508a36c76c5682))
* 放宽 pi peer 范围并升级依赖到 0.85.1 ([3444c0c](https://github.com/maplezzk/pi-extensions/commit/3444c0cb4836006348fc6a9fbd30fe36bdc98ced))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.4.0 to ^0.4.1

## [0.2.0](https://github.com/maplezzk/pi-extensions/compare/pi-auto-goal-v0.1.0...pi-auto-goal-v0.2.0) (2026-09-11)


### Features

* 新增提前停止判定插件 pi-auto-goal ([0ed047c](https://github.com/maplezzk/pi-extensions/commit/0ed047c612a7bcaf7859c07adc0d2c2ea7940f2f))
* 新增提前停止判定插件 pi-auto-goal ([371d127](https://github.com/maplezzk/pi-extensions/commit/371d12786a31dab8d09a83ce99ba1b9cac4d075c))

## Changelog
