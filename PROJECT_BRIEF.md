# DJI Osmo Desktop V2

目标：

打造一个 Windows 桌面端 DJI Osmo Action 素材工作站。

当前首要适配设备：

DJI Osmo Action 4 / HG302

核心流程：

USB 连接
→ 自动发现 Action 4
→ 扫描 DCIM
→ 自动配对 MP4 / LRF / AAC
→ 使用 LRF 快速预览
→ D-Log M → Rec.709
→ 官方风格 LUT
→ 简单剪辑
→ 官方水印
→ 原始素材导出

核心原则：

1. 真实优先
2. 不使用 mock 冒充真实功能
3. LRF 只负责预览
4. 原始 MP4 负责最终导出
5. MP4 + AAC 自动合并
6. Preview 与 Export 使用同一套颜色/效果参数
7. 当前优先 Action 4
8. DUML / SWUDP / FPV / 相机控制暂不属于 V2