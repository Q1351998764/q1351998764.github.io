# memebox generating

PAGELANG?=zh

TITLE?=MemeBox
DESC?=Joy for Everyone
TDESC?=> _Text memes description._
FOOTER?=零下的meme图

GITHUB_OWNER?=Q1351998764
GITHUB_REPO?=q1351998764.github.io
GITHUB_BRANCH?=main
MEMEBOX_API_ROOT?=https://memebox.137-131-36-153.sslip.io

ifeq (${PAGELANG}, zh)
T_MEMEPIC?=图片梗
T_MEMETXT?=文字梗
T_DOWNLOAD?=下载图片
T_ANOTHER?=梗图不喜欢？换一组试试看
T_BACK?=返回画廊
T_ZOOMIN?=查看大图
T_NIMGS?=目前已有 $${entries.length} 组，共 $${imageCount} 张。
T_ALL?=全部
T_SENSITIVE?=显示敏感内容
T_SENSITIVE_HIDDEN?=敏感内容已隐藏
T_EMPTY?=暂无内容
T_UPLOAD?=上传管理
T_IMAGES?=张
T_SORT?=排序
T_SORT_RANDOM?=随机
T_SORT_NEWEST?=最新上传
T_SORT_OLDEST?=最早上传
T_NTEXTS?=目前已有 $${entries.length} 组，共 $${documentCount} 篇。
T_TEXTS?=篇
T_LONG_IMAGE?=长图
endif

T_MEMEPIC?=Picture memes
T_MEMETXT?=Text memes
T_DOWNLOAD?=Download image
T_ANOTHER?=Try another entry
T_BACK?=Back to gallery
T_ZOOMIN?=Zoom in
T_NIMGS?=$${entries.length} entries and $${imageCount} images.
T_ALL?=All
T_SENSITIVE?=Show sensitive content
T_SENSITIVE_HIDDEN?=Sensitive content is hidden
T_EMPTY?=No content
T_UPLOAD?=Upload
T_IMAGES?=images
T_SORT?=Sort
T_SORT_RANDOM?=Random
T_SORT_NEWEST?=Newest uploads
T_SORT_OLDEST?=Oldest uploads
T_NTEXTS?=$${entries.length} entries and $${documentCount} documents.
T_TEXTS?=documents
T_LONG_IMAGE?=Tall image

.PHONY: clean icon copyandstub fixshperm

GENERATED_TEMPLATES = index.html text/index.html manage/index.html comments-admin/index.html shell/genartlist.sh shell/art2text.sh static/scripts/index.js static/scripts/text.js

all: copyandstub ${GENERATED_TEMPLATES} icon fixshperm

${GENERATED_TEMPLATES}: %: src/%.in
	mkdir -pv $(@D)
	sed 's%@TITLE@%${TITLE}%g' $^ \
		| sed 's%@DESC@%${DESC}%g' \
		| sed 's%@TDESC@%${TDESC}%g' \
		| sed 's%@FOOTER@%${FOOTER}%g' \
		| sed 's%@PAGELANG@%${PAGELANG}%g' \
		| sed 's%@T_MEMEPIC@%${T_MEMEPIC}%g' \
		| sed 's%@T_MEMETXT@%${T_MEMETXT}%g' \
		| sed 's%@T_DOWNLOAD@%${T_DOWNLOAD}%g' \
		| sed 's%@T_ANOTHER@%${T_ANOTHER}%g' \
		| sed 's%@T_BACK@%${T_BACK}%g' \
		| sed 's%@T_ZOOMIN@%${T_ZOOMIN}%g' \
		| sed 's%@T_NIMGS@%${T_NIMGS}%g' \
		| sed 's%@T_ALL@%${T_ALL}%g' \
		| sed 's%@T_SENSITIVE@%${T_SENSITIVE}%g' \
		| sed 's%@T_SENSITIVE_HIDDEN@%${T_SENSITIVE_HIDDEN}%g' \
		| sed 's%@T_EMPTY@%${T_EMPTY}%g' \
		| sed 's%@T_UPLOAD@%${T_UPLOAD}%g' \
		| sed 's%@T_IMAGES@%${T_IMAGES}%g' \
		| sed 's%@T_SORT@%${T_SORT}%g' \
		| sed 's%@T_SORT_RANDOM@%${T_SORT_RANDOM}%g' \
		| sed 's%@T_SORT_NEWEST@%${T_SORT_NEWEST}%g' \
		| sed 's%@T_SORT_OLDEST@%${T_SORT_OLDEST}%g' \
		| sed 's%@T_NTEXTS@%${T_NTEXTS}%g' \
		| sed 's%@T_TEXTS@%${T_TEXTS}%g' \
		| sed 's%@T_LONG_IMAGE@%${T_LONG_IMAGE}%g' \
		| sed 's%@GITHUB_OWNER@%${GITHUB_OWNER}%g' \
		| sed 's%@GITHUB_REPO@%${GITHUB_REPO}%g' \
		| sed 's%@GITHUB_BRANCH@%${GITHUB_BRANCH}%g' \
		| sed 's%@MEMEBOX_API_ROOT@%${MEMEBOX_API_ROOT}%g' > $@

fixshperm: shell/genartlist.sh shell/art2text.sh shell/computed.sh
	chmod +x $^

icon:
	@echo
	@echo "*** Two icon files are used:"
	@echo "***     - static/favicon.ico"
	@echo "***     - static/favicon.png"
	@echo "*** Please put your icons to the right place."

copyandstub:
	mkdir -pv manage comments-admin shell static/data/images static/scripts
	touch static/data/.gitkeep static/data/images/.gitkeep
	cp -rf src/.github .
	cp -rf src/static/pico.min.css src/static/style.css src/static/text.css src/static/manage.css src/static/comments-admin.css static/
	cp -rf src/static/vendor static/
	cp -rf src/static/scripts/manage.js static/scripts/
	cp -rf src/static/scripts/comments-admin.js static/scripts/
	cp -rf src/shell/catalog_git.py src/shell/computed.sh src/shell/generate_config.py src/shell/generate_text_config.py src/shell/imgcheck.py shell/

clean:
	rm -rfv .github manage comments-admin shell static index.html
