# 超星学习通课件下载

一个油猴（Tampermonkey）脚本：在超星学习通 / 泛雅的章节学习页面列出当前章节的课件（PPT、PDF、Word 等），一键下载**原文件**或**PDF 版**。

下载 PDF 时会自动修复 WPS 导出的 PDF 在 **Edge / Adobe Acrobat 中公式显示为方框（乱码）** 的问题。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 点击安装脚本：**[chaoxing-courseware-downloader.user.js](https://raw.githubusercontent.com/wuheshidaozod/chaoxing-courseware-downloader/main/chaoxing-courseware-downloader.user.js)**
3. 打开任意课程章节页（`mooc1.chaoxing.com/mycourse/studentstudy?...`），左下角会出现「📥 课件下载」面板。

> 首次下载 PDF 时 Tampermonkey 可能询问是否允许跨域访问，选择「总是允许」。

## 功能

- 自动识别当前章节中的文档（视频不列出），切换章节后自动刷新列表。
- **原文件**：下载老师上传的原始文件（.pptx / .pdf / .docx …）。
- **PDF 版**：下载超星转换后的 PDF（非 PDF 文件才显示）。
- **全部下载**：一次下载当前章节所有课件。
- **PDF 字体修复**：WPS 导出 PDF 时会把整个 `.ttc` 字体集合（如 `cambria.ttc`）直接嵌入，这不符合 PDF 规范。Chrome 能正常显示，但 Edge（Acrobat 引擎）和 Adobe Reader 会把数学符号显示成方框。脚本会从集合中取出所需的单个字体替换回去，其余内容不变。

## 修复已下载的 PDF

仓库中的 [`fix_pdf_ttc.py`](fix_pdf_ttc.py) 可批量修复本地已有的 PDF：

```bash
pip install pymupdf fonttools
python fix_pdf_ttc.py "某个文件.pdf"      # 或传入文件夹
```

修复后的文件保存为同目录下的 `原文件名_fixed.pdf`。

## 原理

课件 iframe 的 `data` 属性中带有 `objectid`，请求 `/ananas/status/{objectid}` 即可得到原文件下载地址（`download`）和 PDF 地址（`pdf`）。

## 声明

仅供个人学习使用，请遵守学校及平台的相关规定，尊重课件作者的版权。

## License

[MIT](LICENSE)
