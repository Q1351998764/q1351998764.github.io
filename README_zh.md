<center><h1> MemeBox </h1></center>

<center>NoneMeme项目使用的网站模板</center>

* * *

### 描述

本模板提取自 [NoneMeme/NoneMeme](https://github.com/NoneMeme/NoneMeme).

Memebox 可以存放多种内容，如`图片`和`Markdown文档`。

### 构建

1. 准备一个`make`工具。

2. 使用本模板，生成你的仓库。

3. 克隆你的仓库。

4. 打开终端，进入你的仓库。

5. 运行 make。

    > 注意: 默认的变量 `PAGELANG` 现在是 `zh` (中文).
    >
    > 详情： [自定义文字](#自定义文字).

6. 将你的资源放入 `art/` (文档) 或 `meme/` (图片).

    > 注意: Memebox **不** 含有网站图标。
    >
    > 你应该将你的图标放入`static/`目录内。
    >
    > 更多信息可查看`make`的输出内容。

7. 提交并推送。

### 图片分类与多图组

分类由 `meme/categories.json` 定义：

```json
{
  "categories": [
    {
      "id": "reaction",
      "label": "反应图",
      "order": 10,
      "sensitive": false
    }
  ]
}
```

- `meme/1.jpg`：未分类单图，兼容旧目录结构。
- `meme/reaction/1.jpg`：`reaction` 分类中的单图。
- `meme/reaction/某个系列/01.jpg`：多图组，文件名按自然顺序排列。
- `sensitive` 为 `true` 时，网页默认不加载该分类的图片。
- 未在配置中声明的一级目录也会自动成为分类，显示名称使用目录名。
- 首页可以按随机、最新上传或最早上传排序。
- 高宽比超过 4:1 的超长图片会在首页标记为“长图”，预览限制在约一屏高度；
  点进详情后仍显示完整原图。

上传图片后，GitHub Actions 会运行 `shell/generate_config.py`，自动更新
`static/scripts/config.js`。上传时间取图片首次加入 Git 历史的提交时间；移动分类、
修改组名和调整组内顺序不会改变原上传时间。

### 文字分类与多篇组

文字分类由 `art/categories.json` 定义，字段含义和图片分类相同：

```json
{
  "categories": [
    {
      "id": "dialogue",
      "label": "对话",
      "order": 10,
      "sensitive": false
    }
  ]
}
```

- `art/example.md`：未分类的单篇文字梗，兼容旧目录结构。
- `art/dialogue/example.md`：`dialogue` 分类中的单篇文字梗。
- `art/dialogue/某个系列/01-first.md`：多篇组，文件名按自然顺序排列。
- 每篇文档的第一个一级标题作为显示标题；没有一级标题时使用文件名。
- `sensitive` 为 `true` 时，网页默认隐藏该分类的文字内容。
- 未在配置中声明的一级目录也会自动成为分类，显示名称使用目录名。
- 文字页可以按随机、最新上传或最早上传排序。

上传文字后，GitHub Actions 会运行 `shell/generate_text_config.py`，自动更新
`static/scripts/text-config.js`。上传时间同样取文件首次加入 Git 历史的提交时间；
移动分类、修改组名和调整组内顺序不会改变原上传时间。

### 网页上传

网站的 `/manage/` 页面可以直接管理图片梗和文字梗。图片管理支持：

- 选择或新建分类。
- 标记敏感分类。
- 上传单图或按顺序创建多图组。
- 筛选、搜索和选择已经上传的图片。
- 按目录顺序、最新上传或最早上传排列管理列表。
- 将已有图片移动到其他分类，或合并、追加到多图组。
- 调整多图组的图片顺序，或删除选中的图片。
- 一批图片只创建一个 Git commit。

文字管理支持：

- 选择或新建分类，并可标记敏感分类。
- 在线填写标题和 Markdown 正文，或导入不超过 2 MB 的 `.md` 文件。
- 上传单篇文字，或追加、创建多篇组。
- 筛选、搜索并按目录顺序、最新上传或最早上传排列已有文字。
- 将已有文字移动到其他分类，合并或追加到多篇组。
- 调整多篇组的篇章顺序，或删除选中的文档。
- 每次上传或管理操作只创建一个 Git commit。

移动、成组和排序操作会复用仓库中原文件的 Git blob，不会重新上传或改写内容。
提交前管理页会检查分支是否已经变化，避免覆盖其他刚完成的提交。

管理页使用 GitHub 细粒度 Personal Access Token。Token 应只授权当前仓库，
并仅开启 `Contents: read and write`。勾选“当前标签页内记住 Token”后，Token 会保存在
浏览器的 `sessionStorage` 中；刷新或在同一标签页重新进入管理页时可自动连接，退出管理
或关闭该标签页后清除。取消勾选时仍只在页面内存中保存。

### 浏览量与评论

图片详情页通过独立 API 显示浏览量和已审核评论。浏览量按匿名访客每日去重；服务端只保存
HMAC 哈希，不保存原始 IP。访客评论默认进入待审核状态，可在 `/comments-admin/` 输入服务
器管理员令牌后通过或拒绝。管理员令牌和 GitHub Token 一样只会在当前标签页的
`sessionStorage` 中暂存。

每个图片条目都有独立的永久 UUID。`shell/generate_config.py` 会将 UUID 写入
`static/data/meme-entry-ids.json`，并利用 Git blob 身份在移动分类、修改组名和调整组内顺序
后继续沿用原 UUID。该映射是公开目录数据，不包含访问令牌或其他密钥。

当前 API 地址由 `MEMEBOX_API_ROOT` 构建变量控制。服务端程序、systemd 沙箱、Caddy 配置和
备份配置位于 `server/`，详细运维步骤见 `server/README.md`。

项目将 Pico CSS 固定在 `static/pico.min.css`，页面和管理页不依赖第三方脚本或样式服务。

### 自定义文字

通常，你可能想自定义网站的标题等等。

你可以通过在终端中定义以下环境变量值来进行修改操作：

|名称|D描述|
|:----|:----|
|PAGELANG|.html文件的页面语言标记,同时也定义了网站使用的语言，例如："zh"|
|TITLE|网站标题， 例如："MemeBox"|
|DESC|网站描述，例如："Joy for Everyone"|
|TDESC|文字梗的描述|
|FOOTER|每个页面的脚注|
|MEMEBOX_API_ROOT|评论和浏览量 API 的 HTTPS 根地址|

比如：

    PAGELANG=en TITLE=Foo DESC=Bar FOOTER="Lorem ipsum" make

如果默认信息你看不顺眼，没关系，它们也是可以修改的：

|名称|描述|
|:----|:----|
|T_MEMEPIC|跳转至图片页面的链接名称|
|T_MEMETXT|跳转至文字页面的超链接名称|
|T_DOWNLOAD|下载一张图片时弹出的提示|
|T_ANOTHER|随机选择一张图片时弹出的提示|
|T_BACK|返回主页的提示|
|T_ZOOMIN|查看大图的提示|
|T_NIMGS|图片统计信息|
|T_ALL|全部分类标签|
|T_SENSITIVE|敏感内容开关|
|T_SENSITIVE_HIDDEN|敏感内容隐藏提示|
|T_EMPTY|空分类提示|
|T_UPLOAD|上传管理链接|
|T_IMAGES|多图组数量单位|
|T_SORT|排序控件名称|
|T_SORT_RANDOM|随机排序选项|
|T_SORT_NEWEST|最新上传排序选项|
|T_SORT_OLDEST|最早上传排序选项|
|T_NTEXTS|文字梗统计信息|
|T_TEXTS|文字篇数单位|
|T_LONG_IMAGE|超长图片预览标记|

### 许可证

本项目使用 [MIT 协议](LICENSE) 开源。

### 特别感谢

- **[modcrafts/a60-shop](https://github.com/modcrafts/a60-shop)**

- **[picocss/pico](https://github.com/picocss/pico/tree/f9e97c0bf430df8fa3f730eb6a6e84f63d4a9b0c)**

- **[markedjs/marked](https://github.com/markedjs/marked)**

- **[cure53/DOMPurify](https://github.com/cure53/DOMPurify)**

- **[NoneMeme/NoneMeme](https://github.com/NoneMeme/NoneMeme)**
