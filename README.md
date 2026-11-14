# 资本三流动态研究台 V2.0

2026-11-14。先读取参考站模型，完成融合研究与计算核心，再制作演示。旧版已保留；本版待用户评阅。

## 本版解决什么
- 三流从同一组资产迁移生成；七个去向：美股、美债、中国风险股债、黄金、第三地、美元现金。
- H/P/R 流动性—压力—政策反馈；有摩擦的边际收益驱动，自愿迁移与强制换现金分开。
- 四种无概率权重的条件情景，19 项可调条件/约束；逐月路径、资金分解、可终止窗口、27 组参数敏感性。
- 官方观测层：TIC 表 1 全球/内地/香港三类居民、36 个月的净交易与股债分项；表 5 美债持仓；欧洲中央银行汇率。
- 图表与 CSV/JSON 共用计算核心，参数链接可复算；电脑与手机界面。

## 重要口径
模型初始资本为 100 **指数点**，不是 100 亿美元或全球市场市值。回报、协方差、行为系数和初始持仓都是显式情景输入，尚未实证估计。页面中的 +n 月是条件演算时间，不是现实逆转日期；情景频数不是概率。

真实数据按其统计期更新，月频观测有发布滞后。真实净额、模型毛流量与净配置强度代理分开，未拟合观测到状态的映射，不声称自动计算了现实全量三流。完整研究说明在 public/downloads/model-v2.md。

本版不是自动投资系统，不收集账户资料、无交易功能、无追踪脚本、无密钥。

## 运行与部署
### Python 服务（自动采集）
Python 3.10+，标准库，无须安装依赖：
```bash
python server.py --host 0.0.0.0 --port 3080
```
打开根路径。每 6 小时尝试读取三个固定官方源；每 5 分钟浏览器同步 JSON。失败保留上次成功值、原观察期和原成功时间并标记 stale；无成功值标 unavailable。更新器加锁并原子写文件。手工更新：
```bash
python update_data.py
```
部分源失败退出码为 2，但保留文件可用。服务持续运行依赖部署宿主；停止进程不会继续抓取。标准库 HTTP 服务只适合小规模演示，公网生产应加 HTTPS 反向代理、进程监管与访问限制。

### 纯静态托管
上传 public/ 内所有文件到支持 HTTPS 的静态站。相对资源路径与 hash 路由支持子目录。不支持 file:// 双击运行。**仅上传静态文件不会自动抓新数据**，需要额外调度采集并发布 observations.json。

### GitHub Pages / Docker
GitHub Pages 使用 .github/workflows/refresh-and-pages.yml 发布，工作流每 6 小时尝试采集官方数据、保留快照并重新部署；来源失败仍发布标记为旧值的数据并报错。定时调度可能延迟，实际运行状态以仓库 Actions 和页面来源记录为准。静态网页本身不运行 Python。

附 Dockerfile：
```bash
docker build -t three-flow-v2 .
docker run -p 3080:3080 --restart unless-stopped three-flow-v2
```
Docker 配置未实测；以容器运行时，数据需配置持久化卷。

## 基础验证
```bash
node tests/engine.test.mjs
python -m unittest discover -s tests -p 'test_*.py' -v
```
11 项模型结构/数值检查，12 项数据解析/失败处理检查，主要浏览器交互及电脑/手机目检。这些是基本检查，不是历史回测、全量安全审计或用户验收。

## 代码结构
- public/index.html、workbench.css、workbench.mjs：研究台
- public/engine.mjs：原创模型核心
- public/data/observations.json：带来源、单位、观察期、采集状态的真实快照
- public/downloads/model-v2.md：参考站评阅与融合模型
- update_data.py、server.py：固定源采集与只读服务
- tests/：结构与解析测试

## 分享边界
此仓库仅发布网站源码、模型说明与公开来源观测。参考站整站源码、浏览器登录状态、授权凭据、旧研究会话与运行日志均不发布。网站托管由 GitHub Pages 提供，实际发布地址以仓库 Settings → Pages 为准。

AI 辅助开发与研究；制作平台：从简 Clarvy。
