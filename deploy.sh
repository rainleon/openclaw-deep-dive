#!/bin/bash
# 部署到gh-pages分支

echo "部署到 gh-pages 分支..."

# 保存当前分支
CURRENT_BRANCH=$(git branch --show-current)

# 创建临时目录
TEMP_DIR=$(mktemp -d)
echo "临时目录: $TEMP_DIR"

# 复制构建产物
cp -r docs/.vitepress/dist/* "$TEMP_DIR/"

# 切换到gh-pages分支（如果不存在则创建）
git checkout -b gh-pages 2>/dev/null || git checkout gh-pages

# 删除所有文件（除了.git目录）
find . -maxdepth 1 ! -name '.git' ! -name '.' ! -name '..' -exec rm -rf {} \;

# 复制构建产物
cp -r "$TEMP_DIR"/* .

# 提交并推送
git add -A
git commit -m "deploy: update site $(date '+%Y-%m-%d %H:%M:%S')"
git push origin gh-pages --force

# 切换回原分支
git checkout "$CURRENT_BRANCH"

# 清理临时目录
rm -rf "$TEMP_DIR"

echo "部署完成！"
