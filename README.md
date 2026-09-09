# 世界知识 · 学习备忘录

想了解世界，不一定要先写出一整本百科全书。

这个项目先把知识整理成目录：找到感兴趣的小主题，复制给你常用的 AI 学习，再回来记下笔记、勾选进度。

- 浏览、搜索 8,335 个目录条目，也可以随机换一个主题。
- 一键复制主题和教学提示词，交给你常用的 AI。
- 记录完成度、知识点和聊天笔记，支持文件导入与备份。
- 适合手机使用，可添加到桌面；免登录，数据保存在本机。

目录会继续补充，不代表已经覆盖所有知识。图片与附件目前保存说明或引用，不会自动备份原文件。

## 运行

需要 Node.js 22.13 或以上版本。

```bash
npm ci
npm run dev
```

```bash
npm test
npm run typecheck
npm run build
npm run preview
```

构建结果在 `dist/`，可部署到域名根路径下的静态网站。手机安装与剪贴板功能需要 HTTPS，或在本机 localhost 测试。

## 数据

不用 API 密钥，也不上传个人笔记。换设备或清理浏览器前，请先在设置里导出备份。

目录数据在 `lib/catalogue-data.json`。条目使用固定编号，改名不会影响学习记录。

界面基于 React、Vite 和 shadcn/ui。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
