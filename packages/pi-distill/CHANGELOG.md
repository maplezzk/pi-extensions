# Changelog

## [1.1.0](https://github.com/maplezzk/pi-extensions/compare/pi-distill-v1.0.2...pi-distill-v1.1.0) (2026-07-22)


### Features

* **pi-distill:** default disable edit and write distillation ([#45](https://github.com/maplezzk/pi-extensions/issues/45)) ([42a419b](https://github.com/maplezzk/pi-extensions/commit/42a419b519d1c943b47b32909b8f2677a0824dd9))
* 拆分提炼评测并补充真实语料 ([#43](https://github.com/maplezzk/pi-extensions/issues/43)) ([95cfa96](https://github.com/maplezzk/pi-extensions/commit/95cfa969af0bf057da10fc9cc8c7031445b9d92f))


### Bug Fixes

* **pi-distill:** 强制错误输出遵守最小阈值 ([#42](https://github.com/maplezzk/pi-extensions/issues/42)) ([f407e89](https://github.com/maplezzk/pi-extensions/commit/f407e89e21e53fd8a5b7b086f481e41af29bcb67))

## [1.0.2](https://github.com/maplezzk/pi-extensions/compare/pi-distill-v1.0.1...pi-distill-v1.0.2) (2026-07-22)


### Bug Fixes

* **pi-distill:** remove redundant file dumping, defer to Pi native output limiting ([#38](https://github.com/maplezzk/pi-extensions/issues/38)) ([3eb16e5](https://github.com/maplezzk/pi-extensions/commit/3eb16e5278e57988ea7a137a362dff076fe48468))
* refine pi-distill display icon ([#41](https://github.com/maplezzk/pi-extensions/issues/41)) ([ae55d33](https://github.com/maplezzk/pi-extensions/commit/ae55d33bce19528ad1d07b995064429636e001a7))

## [1.0.1](https://github.com/maplezzk/pi-extensions/compare/pi-distill-v1.0.0...pi-distill-v1.0.1) (2026-07-21)


### Bug Fixes

* repair release pipeline, rename pi-hud → pi-metrics, add package config CI gate ([#37](https://github.com/maplezzk/pi-extensions/issues/37)) ([3aa4985](https://github.com/maplezzk/pi-extensions/commit/3aa49850dfc6200ea2e8186e85649ecf7e41d697))

## [1.0.0](https://github.com/maplezzk/pi-extensions/compare/pi-distill-v0.4.3...pi-distill-v1.0.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* **pi-distill:** 工具 schema 中的 outputPrompt 字段已移除，请使用 outputRequest

### Features

* **pi-distill:** rename outputPrompt to outputRequest ([#29](https://github.com/maplezzk/pi-extensions/issues/29)) ([eeaa5a6](https://github.com/maplezzk/pi-extensions/commit/eeaa5a6964c0bb273c967e001dd4fb986c7f6227))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-tool-display bumped from ^0.2.2 to ^1.0.0

## [0.4.3](https://github.com/maplezzk/pi-extensions/compare/pi-distill-v0.4.2...pi-distill-v0.4.3) (2026-07-20)


### Bug Fixes

* **distill:** enforce RAW output handling contract ([#22](https://github.com/maplezzk/pi-extensions/issues/22)) ([043f26b](https://github.com/maplezzk/pi-extensions/commit/043f26bba7693f7a33b2a055c776a7838012982f))
* enforce outputPrompt tool-call contract ([#23](https://github.com/maplezzk/pi-extensions/issues/23)) ([40d2d12](https://github.com/maplezzk/pi-extensions/commit/40d2d12c879f8339f90b7689f4a6503ad65f002c))

## [0.4.2](https://github.com/maplezzk/pi-extensions/compare/pi-distill-v0.4.1...pi-distill-v0.4.2) (2026-07-20)


### Bug Fixes

* load tool display as a dependency extension ([#18](https://github.com/maplezzk/pi-extensions/issues/18)) ([d50b392](https://github.com/maplezzk/pi-extensions/commit/d50b392a44181328d2446182ecfe67d11b650061))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-tool-display bumped from ^0.2.1 to ^0.2.2

## [0.4.1](https://github.com/maplezzk/pi-extensions/compare/pi-distill-v0.4.0...pi-distill-v0.4.1) (2026-07-20)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-tool-display bumped from ^0.2.0 to ^0.2.1

## [0.4.0](https://github.com/maplezzk/pi-extensions/compare/pi-distill-v0.3.1...pi-distill-v0.4.0) (2026-07-20)


### Features

* embed the tool display host ([eb83f33](https://github.com/maplezzk/pi-extensions/commit/eb83f33c3cc6f45477ce116ae601fa229316fcf4))
* embed the tool display host ([1154156](https://github.com/maplezzk/pi-extensions/commit/11541567693f2f83bb7e1fca565e04f67a8f058b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-tool-display bumped from ^0.1.1 to ^0.2.0

## [0.3.1](https://github.com/maplezzk/pi-extensions/compare/pi-distill-v0.3.0...pi-distill-v0.3.1) (2026-07-19)


### Bug Fixes

* use unique shared tool display package name ([0b49bc1](https://github.com/maplezzk/pi-extensions/commit/0b49bc12886d6fddfd59fad950156458085b2bb6))
* use unique shared tool display package name ([913ba1e](https://github.com/maplezzk/pi-extensions/commit/913ba1e12946ba349d4062ca6781d497fbd84cfc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * pi-extensions-tool-display bumped from ^0.1.0 to ^0.1.1

## [0.3.0](https://github.com/maplezzk/pi-extensions/compare/pi-distill-v0.2.0...pi-distill-v0.3.0) (2026-07-19)


### Features

* localize distill prompts and document savings ([8c94db0](https://github.com/maplezzk/pi-extensions/commit/8c94db0fcb6c2334e32c3ee1fbc1b02880663977))
* localize distill prompts and document savings ([388b836](https://github.com/maplezzk/pi-extensions/commit/388b836bdad8215a2ad1d8d83ba7e7a686532f66))
* support distillation for all tools ([b84277c](https://github.com/maplezzk/pi-extensions/commit/b84277cbdd7711f0902a5076248bde0df59646a8))
* support distillation for all tools ([7ba50c7](https://github.com/maplezzk/pi-extensions/commit/7ba50c7d37bfb9367739a3dda4a5f791a832d097))


### Bug Fixes

* follow pi-language for distill prompts ([093794a](https://github.com/maplezzk/pi-extensions/commit/093794a62109241d0fdbd764a148d96150809730))
* keep distill output language on locale setting ([dfbb369](https://github.com/maplezzk/pi-extensions/commit/dfbb3697ec98d105c09367700443c02d45231093))
* preserve non-text tool results ([242f215](https://github.com/maplezzk/pi-extensions/commit/242f2158ffb40a4867417f58cd27730594893d3e))


### Dependencies

* The following workspace dependencies were updated
  * peerDependencies
    * pi-extensions-i18n bumped from ^0.2.0 to ^0.3.0

## [0.2.0](https://github.com/maplezzk/pi-extensions/compare/pi-distill-v0.1.0...pi-distill-v0.2.0) (2026-07-19)


### Features

* **distill:** migrate pi-distill package with in-package tests ([0da4fc0](https://github.com/maplezzk/pi-extensions/commit/0da4fc06d8ff7d486265ce2e1056645aba49ee1b))


### Bug Fixes

* regenerate lockfile against npmjs.org; pin publish registry in publishConfig ([968deda](https://github.com/maplezzk/pi-extensions/commit/968dedac98875065dde1704aff9fead9f9cbd50e))


### Dependencies

* The following workspace dependencies were updated
  * peerDependencies
    * pi-extensions-i18n bumped from ^0.1.0 to ^0.2.0
