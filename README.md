# TOPIQ — 韩语背单词

基于 SM-2 间隔重复算法的 TOPIK 韩语词汇学习 PWA。纯前端静态站点，GitHub Pages 一键部署，移动端优先。

**2931 词 · 60 单元 · 初级 + 中级 + 高级 · 例句发音 + 数据统计**

---

## 功能

**学习**
- SM-2 间隔重复：忘记 / 模糊 / 认识 三档评分，算法自动排期
- 撤销评分：按错 3 秒内可撤回
- 学习范围多选：初级 / 中级 / 高级独立开关，随时调整
- 每日目标可调：0–500，零即不限

**单词库**
- 60 单元按书本分组浏览，每单元显示学习进度
- 快速复习：单单元顺序浏览 / 全部单词随机穿插
- 收藏系统：星标难词，筛选集中攻克
- 全文搜索：韩语、中文、例句均可检索

**发音**
- Web Speech API 驱动，自动选用系统最佳韩语语音
- 语音选择器：列出可用语音，点击试听
- 单词朗读 + 例句朗读，语速 0.5x–2.0x 可调

**统计**
- 遗忘曲线、30 天学习情况、记忆持久度分布
- 签到日历、连续打卡天数
- 今日复习记录：展开查看每词评分

**数据**
- JSON 导出 / 导入，备份全部学习进度
- 重置进度（两重确认）

---

## 本地运行

下载项目后用任意 HTTP 服务打开 `index.html` 即可（直接双击打开不行，浏览器会阻止 localStorage）。

```bash
# 方式一：用 Python（macOS/Windows 自带）
python -m http.server 8080

# 方式二：用 VS Code Live Server 插件
# 右键 index.html → Open with Live Server
```

然后浏览器打开 `http://localhost:8080`。

## GitHub Pages 部署

Settings → Pages → Source: main 分支，根目录 `/`，保存。1–2 分钟后生效。

---

## 技术栈

纯原生，零框架依赖。

| 层 | 实现 |
|----|------|
| 算法 | SM-2（SuperMemo 2），客户端 JavaScript |
| 数据 | 2931 词 JSON 数组，localStorage 持久化 |
| 图表 | Chart.js 4.x（CDN） |
| 语音 | Web Speech API |
| 样式 | CSS 变量 + 深色模式 + 移动端响应式 |
| 卡片 | CSS 3D transform 翻转 |

---

## 文件结构

```
├── index.html          # SPA 入口
├── static/
│   ├── script.js       # 全部逻辑（~1400 行）
│   ├── style.css        # 全部样式
│   └── words_data.js    # 2931 词数据
└── README.md
```

---

## License

MIT
