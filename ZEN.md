# oh-my-pi-zen 维护规则

本仓库是 `can1357/oh-my-pi` 的 fork：`cagedbird-org/oh-my-pi-zen`，工作分支 `zen/main`。
`zen/main` = 某个 upstream release tag + 一组 zen 补丁提交。本文件由 `.omp/config.yml` 的
`contextFiles.extra` 加载，与根目录 `AGENTS.md` 并列生效；upstream 规则仍然适用，冲突时以本文件为准。

## 分支与跟进

- `zen/main` 只建立在 upstream release tag 上，跟进新 tag 用 rebase，不 merge。
- upstream 的文件尽量不改；必须改的地方改动要小且集中，降低 rebase 冲突。
- zen 专属内容放在 upstream 没有的路径（如本文件、`.omp/config.yml`、`.github/workflows/zen-*.yml`）。
- upstream 的 workflow（`ci.yml`、`bun-cache-warm.yml`、`nix.yml`）在仓库设置里停用，文件不改。

## 提交组织

- 每个 zen 补丁是一个按主题划分的独立提交，提交信息用中文，带 `zen` 相关前缀便于识别。
- 修改已有补丁用 `git commit --fixup=<该补丁提交>`，再 `git rebase -i --autosquash <upstream tag>` 合并回去；
  不要在补丁之上堆叠零散的修补提交。
- 推送 `zen/main` 使用 `git push --force-with-lease`。

## 版本与发布

- 版本号 `X.Y.Z-zen.N`：`X.Y.Z` 是所基于的 upstream tag；同一 tag 上重新发布递增 `N`，跟进新 tag 从 `zen.1` 重计。
- 发布到 npm 的 `@oh-my-pi-zen/*`：所有 `@oh-my-pi/*` 子包改名后全量发布；zen 包之间的依赖写死精确版本，
  不用 `^`/`>=` 等范围（预发布版本不满足范围）；发布显式使用 `--tag latest`。
- natives 只发三个平台：`linux-x64`（自编，cargo feature `wayland-pipewire`）、`darwin-arm64`、`linux-arm64`
  （后两者复用官方同版本 npm 包里的 `.node`）。addon 版本在链接后写入，必须与 `X.Y.Z-zen.N` 一致。
- 安装：`bun install -g @oh-my-pi-zen/pi-coding-agent`。
