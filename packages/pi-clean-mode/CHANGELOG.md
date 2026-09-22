# Changelog

## [0.4.0](https://github.com/maplezzk/pi-extensions/compare/pi-clean-mode-v0.3.0...pi-clean-mode-v0.4.0) (2026-09-22)


### Features

* **clean-mode:** 工具行铺 Pi 原生底色、收起时隐藏 info 通知、组头混杂时写构成 ([713d677](https://github.com/maplezzk/pi-extensions/commit/713d6779a8eee9deb4ccdc64d18379b3c4157023))
* **clean-mode:** 工具行铺 Pi 原生底色、收起时隐藏 info 通知、组头混杂时写构成 ([73feb1a](https://github.com/maplezzk/pi-extensions/commit/73feb1afa2b4d177c78153d9b2700478691d1492))

## [0.3.0](https://github.com/maplezzk/pi-extensions/compare/pi-clean-mode-v0.2.0...pi-clean-mode-v0.3.0) (2026-09-21)


### Features

* clean mode 展开动作组时每条命令一行，点开才看原文 ([a456d96](https://github.com/maplezzk/pi-extensions/commit/a456d96ff78103fb1f647db6a4b865562b358ceb))
* **clean-mode:** 展开动作组时每条命令一行，点开才看原文 ([c9b9793](https://github.com/maplezzk/pi-extensions/commit/c9b97934e5842fcc36ec840cc875de3f5603f61a))
* **clean-mode:** 折叠头加 [clean] 来源前缀 ([1a75f6b](https://github.com/maplezzk/pi-extensions/commit/1a75f6b8e6d7239a15d7e8d228a2b24b9466ce10))
* 块头统一 [xxx] 来源前缀，展开方向统一用箭头 ([8cae968](https://github.com/maplezzk/pi-extensions/commit/8cae9688341fa2f47de1014b17ca606acac98694))


### Bug Fixes

* **clean-mode:** 占位摘要不再锁死组头文案，参数到齐后换成真摘要 ([e7f37a4](https://github.com/maplezzk/pi-extensions/commit/e7f37a4d602e91bab52954abf43749142c50295c))
* **clean-mode:** 左侧轨道只留组头一行，运行级不再画竖条 ([613f063](https://github.com/maplezzk/pi-extensions/commit/613f06365c13cb88a34c83b68d2c38acc62c8a8a))
* **clean-mode:** 左侧轨道只留组头一行，运行级不再画竖条 ([ef6d889](https://github.com/maplezzk/pi-extensions/commit/ef6d8896a9b8734a18a05a5db9753081cf31d967))
* **clean-mode:** 扩展消息面板（工作流结果等）同样接上运行轨道 ([e968e3a](https://github.com/maplezzk/pi-extensions/commit/e968e3ae10df86028071f8762aafd85b70ee7403))
* **clean-mode:** 流式登记先不把标签当摘要，等参数到齐再补 ([003b4a4](https://github.com/maplezzk/pi-extensions/commit/003b4a44d88e3cf8542d550f71be77b629c8557a))
* **clean-mode:** 流式登记只给标签占位，真摘要等参数到齐再换上 ([bde0f34](https://github.com/maplezzk/pi-extensions/commit/bde0f347071d89c3f67615ac4b0212bfdb3f14ff))
* **clean-mode:** 组头上面那行改成细竖条，组头与成员摘要改弱化色 ([94c3b98](https://github.com/maplezzk/pi-extensions/commit/94c3b981805c09ac7c2704b4fec73b318abfb111))
* **clean-mode:** 组头上面那行改成细竖条，组头与成员摘要改弱化色 ([d5cfcf4](https://github.com/maplezzk/pi-extensions/commit/d5cfcf4a48b3ba00d8569cc78e020c920ec2d391))
* **clean-mode:** 轨道归属按条目对象记，组件被重建后不翻面 ([c439b03](https://github.com/maplezzk/pi-extensions/commit/c439b03b537c4ca7cf5ffddb26a28ef73de24ca1))
* **clean-mode:** 运行中实时区不再跳：去顶部图标、尾注移位、整轮接管内置提示、流式登记工具行 ([0948cb6](https://github.com/maplezzk/pi-extensions/commit/0948cb6589b95c0dd8737f4f2b3e0fb4c538d516))
* **clean-mode:** 运行中实时区不再跳：去顶部转动图标、尾注改挂子项行、登记赶在渲染前、内置提示整轮接管 ([c0a64fc](https://github.com/maplezzk/pi-extensions/commit/c0a64fcf4f9f840cc97c24495201e5a45fc12a84))
* **clean-mode:** 运行中的提示块接上左侧轨道，不再切断结构 ([1a060da](https://github.com/maplezzk/pi-extensions/commit/1a060dac7b4cb800a79eeaa0a46f8cebb3ee6eba))
* **clean-mode:** 运行期间的扩展块去掉自带的前导空行 ([84ff2b5](https://github.com/maplezzk/pi-extensions/commit/84ff2b507bc3cbf8b4d5d6cadba3b2a22432c78d))
* **clean-mode:** 运行期间的扩展块去掉自带的前导空行 ([aad6432](https://github.com/maplezzk/pi-extensions/commit/aad6432be113de8f0a39db3ba0eca50247521cf3))
* **clean-mode:** 运行期间的扩展条目（含工作流面板）一并接上轨道 ([72100aa](https://github.com/maplezzk/pi-extensions/commit/72100aa2f375371fae7f414665c3420530ec384c))
* **clean-mode:** 运行期间的扩展条目与消息面板接上轨道，不再切断结构 ([6858f00](https://github.com/maplezzk/pi-extensions/commit/6858f00e65ada60c8f9066c76b6ec6a60221c335))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-i18n bumped from ^0.7.0 to ^0.8.0

## [0.2.0](https://github.com/maplezzk/pi-extensions/compare/pi-clean-mode-v0.1.0...pi-clean-mode-v0.2.0) (2026-09-19)


### Features

* **clean-mode:** 折叠扩展写入的工作条目 ([19c2a69](https://github.com/maplezzk/pi-extensions/commit/19c2a69968364529c1669ab4176511422676a65e))
* **clean-mode:** 折叠扩展写入的工作条目 ([0ba48d7](https://github.com/maplezzk/pi-extensions/commit/0ba48d783fef663590d47f32a504773f9d0e857c))
* **clean-mode:** 活动块用竖折挂在组头下面 ([0981c79](https://github.com/maplezzk/pi-extensions/commit/0981c79f3138f1fa60a0f860f7cf5f7776466290))
* **clean-mode:** 活动块竖折 + 组头主词按实际动作选 ([9ea3218](https://github.com/maplezzk/pi-extensions/commit/9ea32186725226b0391379f82b722144e799c88d))
* **clean-mode:** 活动块跟随当前动作组头，思考图标换成半填充圆 ([a8f70d3](https://github.com/maplezzk/pi-extensions/commit/a8f70d3e698bb2542c312eb5982b83f9286ddea9))
* **clean-mode:** 活动块跟随当前动作组头，思考图标换成弧线 ([28b60d9](https://github.com/maplezzk/pi-extensions/commit/28b60d95ba389843b04e806b92edfa8deb9e0c31))
* **clean-mode:** 组头主词按组内过半的动作分类选 ([2bf0ee1](https://github.com/maplezzk/pi-extensions/commit/2bf0ee1b31c6d6bc91e3ee2119e093e28add9135))
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

* **clean-mode:** 一个动作名只说一遍，最新状态贴在最新动作下面 ([3b4fcec](https://github.com/maplezzk/pi-extensions/commit/3b4fcecfb627d63f0b429fc8cf0c3999025193fe))
* **clean-mode:** 单条组的动作名不再重复第二遍 ([03b6e9c](https://github.com/maplezzk/pi-extensions/commit/03b6e9caa9956eefabf408e6b76372fa63835272))
* **clean-mode:** 思考图标改成半填充圆 ◐◓◑◒ ([ee48528](https://github.com/maplezzk/pi-extensions/commit/ee4852891f2889519c44d313f37f6bda45445886))
* **clean-mode:** 思考图标改用 cli-spinners 的 dots11 单点环绕 ([#185](https://github.com/maplezzk/pi-extensions/issues/185)) ([296c711](https://github.com/maplezzk/pi-extensions/commit/296c7112a7070e76d948f9036f0c2ce3e330eaee))
* **clean-mode:** 恢复会话后历史轮次不再原样铺开 ([e90b523](https://github.com/maplezzk/pi-extensions/commit/e90b5231ee22acf37a653f78c79ffd62cc236012))
* **clean-mode:** 恢复会话后历史轮次不再原样铺开 ([fb1cd90](https://github.com/maplezzk/pi-extensions/commit/fb1cd90a97cb0cf5a4e572084c4e1c7b8084f7fb))
* **clean-mode:** 承载者出现前不再关掉 Pi 的 Working 提示 ([dade49d](https://github.com/maplezzk/pi-extensions/commit/dade49d0cd44222e49dcfb89b5015224d3bae1fe))
* **clean-mode:** 承载者出现前不再关掉 Pi 的 Working 提示 ([dd4337a](https://github.com/maplezzk/pi-extensions/commit/dd4337aadaa66ea7b7f13dddc13805afd03bb8bf))
* **clean-mode:** 活动区首行改成底色横条，并修掉对齐与 markdown 噪音 ([957b05b](https://github.com/maplezzk/pi-extensions/commit/957b05b58e4fdc74b1ea4fac038866984c7295c7))
* **clean-mode:** 活动区首行改成底色横条，并修掉对齐与 markdown 噪音 ([a3caf3c](https://github.com/maplezzk/pi-extensions/commit/a3caf3c1f5227570bbb36b41c2eac93df1730375))
* **clean-mode:** 活动块贴在最新动作下面，轮首只留整轮时间 ([75163df](https://github.com/maplezzk/pi-extensions/commit/75163df46729ca4b329b909f5df6698e3925d793))
* **clean-mode:** 活动块首行只报计数，去掉重复的「处理中」 ([1598f7c](https://github.com/maplezzk/pi-extensions/commit/1598f7c4993ae1f3f773cb0a85d95b94d72dba3f))
* **clean-mode:** 轮首只显示运行级时间，思考与工具细节留给组头 ([6e9474d](https://github.com/maplezzk/pi-extensions/commit/6e9474d892e87ab646d52cba81cdd98454614596))
* **clean-mode:** 运行中收起后轮首继续显示「处理中」状态横条 ([77d755c](https://github.com/maplezzk/pi-extensions/commit/77d755c3829526c1b078a4bfa7a7075b4ad7f933))
* **clean-mode:** 运行中收起后轮首继续显示「处理中」状态横条 ([7273ef6](https://github.com/maplezzk/pi-extensions/commit/7273ef6d676ccb1ba0988810807e30d2bf7ceb48))
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
