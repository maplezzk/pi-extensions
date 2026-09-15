# Changelog

## [0.2.0](https://github.com/maplezzk/pi-extensions/compare/pi-clean-mode-v0.1.0...pi-clean-mode-v0.2.0) (2026-09-15)


### Features

* 三级折叠补齐 L2 动作组，组边界跟着解说走 ([1bd88e9](https://github.com/maplezzk/pi-extensions/commit/1bd88e9a024af4dcd81213cbdc981e6297e082c0))
* 增加 TUI 配置面板，不用再手写 key=on/off ([69b4609](https://github.com/maplezzk/pi-extensions/commit/69b4609de440bf1c512b0129b4ebb5016afabcc4))
* 折叠头改成有层级的视觉，不再和正文混成一片 ([8d6383e](https://github.com/maplezzk/pi-extensions/commit/8d6383e0a65a389fb8e7f1e8f1d6bdd94809512a))
* 新增 pi-clean-mode 把一轮运行折叠成耗时头 ([61ebd65](https://github.com/maplezzk/pi-extensions/commit/61ebd65f4b3617bd2b3701bbe6f940f55cdbdc1c))
* 新增 pi-clean-mode 把一轮运行折叠成耗时头 ([abd0d36](https://github.com/maplezzk/pi-extensions/commit/abd0d360518f184bb81e04ba6a605dc361f9186d))
* 新增编辑器上方的实时活动区 ([47e48ff](https://github.com/maplezzk/pi-extensions/commit/47e48ff92e0cb57d61f25861b172b706dc0628a3))
* 活动区移到整轮最上面，并抽掉 thinking 原文 ([c32f3a6](https://github.com/maplezzk/pi-extensions/commit/c32f3a60e120c96f4d3ac7291066a4411692bcad))
* 活动区行数上限从 6 放宽到 20 ([d3269da](https://github.com/maplezzk/pi-extensions/commit/d3269da8a3ba1df93d0d9aaeda06dc9d36b927e4))
* 清爽模式支持鼠标点击切换，并修正折叠头上下间距 ([164eb4c](https://github.com/maplezzk/pi-extensions/commit/164eb4cbc8e66dd235996c918ff9943ef1d47597))
* 箭头改成实心三角并紧跟文案，去掉 f2 提示，工具行也带箭头 ([df0bcd2](https://github.com/maplezzk/pi-extensions/commit/df0bcd2df4dc10cd23672562aa153eee71f80e57))
* 耗时头移到整轮最前面，运行中即开启工具聚合 ([cb25472](https://github.com/maplezzk/pi-extensions/commit/cb254728795c4bca4542faf140fdd28eda1a96f0))


### Bug Fixes

* **clean-mode:** 思考图标改用 cli-spinners 的 dots11 单点环绕 ([#185](https://github.com/maplezzk/pi-extensions/issues/185)) ([296c711](https://github.com/maplezzk/pi-extensions/commit/296c7112a7070e76d948f9036f0c2ce3e330eaee))
* **clean-mode:** 恢复会话后历史轮次不再原样铺开 ([e90b523](https://github.com/maplezzk/pi-extensions/commit/e90b5231ee22acf37a653f78c79ffd62cc236012))
* **clean-mode:** 恢复会话后历史轮次不再原样铺开 ([fb1cd90](https://github.com/maplezzk/pi-extensions/commit/fb1cd90a97cb0cf5a4e572084c4e1c7b8084f7fb))
* **clean-mode:** 承载者出现前不再关掉 Pi 的 Working 提示 ([dade49d](https://github.com/maplezzk/pi-extensions/commit/dade49d0cd44222e49dcfb89b5015224d3bae1fe))
* **clean-mode:** 承载者出现前不再关掉 Pi 的 Working 提示 ([dd4337a](https://github.com/maplezzk/pi-extensions/commit/dd4337aadaa66ea7b7f13dddc13805afd03bb8bf))
* **clean-mode:** 活动区首行改成底色横条，并修掉对齐与 markdown 噪音 ([957b05b](https://github.com/maplezzk/pi-extensions/commit/957b05b58e4fdc74b1ea4fac038866984c7295c7))
* **clean-mode:** 活动区首行改成底色横条，并修掉对齐与 markdown 噪音 ([a3caf3c](https://github.com/maplezzk/pi-extensions/commit/a3caf3c1f5227570bbb36b41c2eac93df1730375))
* 修掉工具输出露原始内容与两处卡顿 ([c06dfc6](https://github.com/maplezzk/pi-extensions/commit/c06dfc6589f3ee35331979cd0711e75160bad442))
* 动作组头与运行级折叠头左对齐，去掉多出来的一级缩进 ([cd07bf4](https://github.com/maplezzk/pi-extensions/commit/cd07bf4af36b65001a11a498d7935f53604dd714))
* 动作组展开后仍保留组头，可以再次收起 ([cbc0e0e](https://github.com/maplezzk/pi-extensions/commit/cbc0e0e5160e7d7a7be66e0c60edc2ceebbcf7b4))
* 展开箭头挪到右侧，左侧只留文案 ([00420b3](https://github.com/maplezzk/pi-extensions/commit/00420b34912faf385f856bab996825f7c59cf3d8))
* 活动区改到对话流末尾，并修好收起态耗时头点不动 ([fdc6308](https://github.com/maplezzk/pi-extensions/commit/fdc630843d37c2cc285812f06f4f1a19dadf7cea))
* 点成员箭头不再折叠整组，组头底色与横条左边缘对齐 ([08a76cb](https://github.com/maplezzk/pi-extensions/commit/08a76cb644b055c8ad0e85e4ee5c40860a9519ff))
* 组头箭头贴到行的右边缘，和折叠头对齐成一条竖线 ([e8c2143](https://github.com/maplezzk/pi-extensions/commit/e8c214316a5339e299c465ad02b54ec409c10dd9))
* 运行期间不做动作组聚合，消除行数反复增减导致的闪动 ([f7fe136](https://github.com/maplezzk/pi-extensions/commit/f7fe1367925047ff7c6dbcd2be5cdba8a4ba230e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.6.0 to ^0.7.0
