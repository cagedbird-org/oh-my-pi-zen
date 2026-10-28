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

### npm 发布流程

- 手动运行 `.github/workflows/zen-release.yml`，或由其他 workflow 通过 `gh workflow run zen-release.yml` 触发 `workflow_dispatch`；不随 push 发布。
- `zen_number` 指定 `N`；留空时查询 npm `latest`，同一 upstream 版本递增，否则从 `1` 开始。失败重跑时填写原 `N`，已存在的精确版本会跳过。
- `bun scripts/zen/resolve-version.ts [N]` 输出 upstream 与 zen 版本。
- `bun scripts/zen/prepare-publish-worktree.ts --version X.Y.Z-zen.N --output /tmp/zen-publish --linux-addon <带 pipewire 的 linux-x64 addon>` 创建独立暂存树，下载官方 arm64 addon、逐一盖章、改名、构建并用 `npm pack` 生成 tarball；源工作区不改名。
- `bun scripts/zen/ci-release-publish.ts /tmp/zen-publish` 使用 npm CLI ≥ 11.5，显式 `--tag latest --access public`。全部 16 个包通过 OIDC 发布，npm 子进程不带 token，使用独立的空 userconfig/globalconfig。暂存 manifest 的 `repository.url` 指向本 fork，与 provenance 来源一致。发布后 best-effort 请求 npmmirror 同步。
- 发布集合为 12 个 workspace 包（`pi-utils`、`pi-wire`、`omptype`、`pi-catalog`、`pi-ai`、`pi-natives`、`pi-tui`、`pi-mnemopi`、`snapcompact`、`omp-stats`、`pi-agent-core`、`pi-coding-agent`）、三个 native leaf，以及同版本的 `collab-web` 静态包（仅生产构建与许可证，去掉 umami）。发现其他新增可发布 workspace 包时中止，先确认发布范围。leaf 先发，依赖者随后，coding-agent 最后。
- `zen-follow.yml` 每小时或手动检查下一个 upstream release tag，rebase、测试后用 `ZEN_DEPLOY_KEY` 推送并触发发布；失败即停用，需手动检查后重新启用。
- zen 测试路径统一维护在 `scripts/zen/tests.txt`；本地及两个 workflow 都运行 `bun scripts/zen/run-tests.ts`。

### collab-web 自托管

- `scripts/zen/collab-web-mirror.py` 安装到 bj-edge 的 `/usr/local/libexec/omp-collab-web-mirror`，由原有同名 systemd timer/service 运行；沙箱写入范围仍只有 `/srv/omp-collab-web`。
- 优先用 npmmirror 的 `latest` 元数据，同查 npm 以选择较新版本；tarball 校验 sha512 后安装到 `releases/<version>`，原子切换 `current`，保留三版。缺包或校验失败保留现站。
- 测试可设置 `OMP_COLLAB_WEB_ROOT` 与逗号分隔的 `OMP_COLLAB_WEB_REGISTRIES`，在 scratch 目录使用本地 registry fixture，不改线上内容。
