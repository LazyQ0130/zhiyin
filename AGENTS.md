# 用户工作区规则

禁止批量删除文件或目录。禁止使用 del /s、rd /s、rmdir /s、Remove-Item -Recurse、rm -rf。
如确需删除，只能一次删除一个明确路径的文件；批量删除须交由用户手动处理。
安装Playwright必须设置 PLAYWRIGHT_SKIP_BROWSER_GC=1。验收输出使用新目录，保留已有文件。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
