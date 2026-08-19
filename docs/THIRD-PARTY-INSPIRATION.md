# 第三方能力参考

梨园的鲜活世界与日历能力参考过以下开源项目的产品思路，并按梨园权威边界独立实现：

- [ST-SevenDaysCal](https://github.com/atonal519/ST-SevenDaysCal)：自定义历法、月历、多日日期、周期追踪与显式时间跳转交互。
- [world-backstage](https://github.com/h675786161-prog/world-backstage)：人物冻结认知、通讯送达、公开传播面、后台人物饥饿保护与事件终态。

没有引入 SillyTavern/Luker 的存储、DOM、prompt depth、独立世界钟或大一统状态仓。梨园继续坚持：

- 当前时间与镜头账本进入 `rp-state`；
- 宏观制度和历法进入 `rp-world-state`；
- 人物生活、通讯和具体事件进入 `rp-ecology-state`；
- 日历、舆情和认知展示为只读投影；
- 所有状态随 Session Tree 分支、回档和变体恢复。

`world-backstage` 仓库使用 MIT License；若后续直接复制其实质代码，应保留原版权与许可证。当前整合为依据公开行为重新实现。

能力合并的最终权威边界、一拍流程与维护要点以 `docs/ARCHITECTURE-OVERVIEW.md`、`docs/PLAN-WORLD-ENGINE.md`、`docs/PLAN-LIVING-ECOLOGY.md` 为准。
