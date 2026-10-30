# Changelog

## [18.14.0-zen.2] - 2026-10-31

### Added

- Eval 的 `archive` 新增 `grep()`：流式搜索会话正文，支持项目、时间范围、正则和子代理过滤，并返回命中前后的对话轮次，JS 和 Python 均可用。
  Eval `archive` gains `grep()`: stream-search transcript bodies with project, time-range, regex, and subagent filters, returning surrounding conversation turns in both JavaScript and Python.
- AnySearch 并入内置 `web_search` 及其回退链，通过 `/login anysearch` 保存 key；未登录也能搜索，但会提示用户和模型登录，以免被限流。
  AnySearch joins built-in `web_search` and its fallback chain with `/login anysearch`; anonymous searches still work but warn the user and model to log in to avoid rate limits.
- 重写内置 `generate_image`：单个自然语言提示词，支持透明背景、1–4 张并行、尺寸和质量（默认 high）；模型由 `image` 角色回退链决定，可在 `models.yml` 用 `api: openai-images` 声明中转站图片模型并与 Codex 登录混用；如实返回实际尺寸和质量，输出到不覆盖的临时文件。
  Rewrite built-in `generate_image`: one natural-language prompt with transparent backgrounds, 1–4 parallel images, size, and quality (default high); the `image` role fallback chain picks the model, relay image models can be declared in `models.yml` with `api: openai-images` and mixed with Codex login; actual size and quality are reported, and output goes to non-overwriting temporary files.

### Fixed

- 启动时不再因插件的纯类型依赖触发自动下载而卡住；zen 扩展使用当前宿主的 SDK 状态。
  Startup no longer stalls on automatic downloads for type-only plugin dependencies; zen extensions share the current host's SDK state.
- 中转站的 HTTP/2 流中断等临时故障会自动重试，补齐 sub2api 流内错误分类：区分额度耗尽与瞬时限流，需要管理员处理的上游凭据错误不再重试。
  Gateway HTTP/2 stream failures and other transient sub2api in-band errors are now retried; exhausted quotas are distinguished from throttling, and upstream credential failures that need an administrator are no longer retried.
- 修复原生 task 调用把可选参数的空占位误当成显式输入而被拒绝的问题，普通子代理、seance 和批量调用都已覆盖，真正错误的参数仍会报错。
  Native task calls no longer reject empty optional placeholders as explicit arguments across ordinary, seance, and batch spawns; genuinely invalid arguments are still refused.

## [18.14.0-zen.1] - 2026-10-30

### Added

- 支持在 Android 9 及以上的 Termux 官方 Bun 中安装和运行，提供 bionic 原生的 android-arm64 addon。
  Support installation and execution with Termux's native Bun on Android 9 and later using a bionic-native android-arm64 addon.

### Changed

- 跟进上游 18.14.0。
  Rebased onto upstream 18.14.0.
- 隔离的 agent 桌面通过 `apps.open` 启动浏览器时会提示改用 browser 工具，主机桌面不受影响。
  Browser launches through `apps.open` on the isolated agent desktop now direct agents to the browser tool; host desktop launches are unchanged.

### Fixed

- HTML 导出内嵌会话查看器、Markdown 解析和语法高亮库，无需联网即可显示会话。
  HTML exports embed the session viewer, Markdown parser, and syntax highlighter so sessions can be viewed offline.

## [18.13.3-zen.8] - 2026-10-30

### Added

- zen 更新日志随 npm 包分发，启动更新提示与 `/changelog` 分组展示 zen 和上游更新；发布前校验日志，npm 发布成功后自动创建 GitHub Release。
  Ship zen release notes with npm packages, group zen and upstream changes in startup notices and `/changelog`, and validate notes before publishing and creating a GitHub Release.

### Fixed

- KDE 桌面操作：`type()` 中的换行和 Tab 按真实按键发送，并替换选中文本、在光标处插入。
  KDE computer use: newlines and Tabs in `type()` are sent as real keys, and typing replaces the selection and inserts at the caret.
- KDE 桌面操作：Qt 应用的菜单可以列出子项并执行命令；Qt 文本控件（如 KCalc 显示屏）能读出值，隐藏控件的 `setValue` 会报错而不是静默成功。
  KDE computer use: Qt application menus list submenus and run commands; Qt text controls such as the KCalc display report their value, and `setValue` on hidden controls fails instead of silently succeeding.
- KDE 桌面操作：使用 fcitx5/Rime 时输入的文字不再被输入法改写；剪贴板兜底会先读回确认，绝不粘贴用户原有的剪贴板内容；部分送达的文字不会重复输入。
  KDE computer use: typed text is no longer rewritten by fcitx5/Rime; the clipboard fallback verifies its contents before pasting and never pastes the user's previous clipboard; partially delivered text is never typed twice.
- KDE 桌面操作：`apps.open` 会返回新窗口，不再抢走用户焦点；没有窗口的后台进程（如 `dolphin --daemon`）不再妨碍启动；接管期间弹出的对话框关闭后焦点也会归还。
  KDE computer use: `apps.open` returns the new window without stealing focus, windowless daemons such as `dolphin --daemon` no longer block launching, and focus returns after dialogs opened during takeover.
- KDE 桌面操作：同名对话框可以正确读取无障碍树；agent 桌面内的输入不再提示接管。
  KDE computer use: accessibility trees of same-titled dialogs resolve correctly, and input inside the agent desktop no longer reports a takeover.
- KDE 桌面操作：Qt 与 GTK 应用中的拖放可以正常使用；QML 输入框（如系统设置搜索）的输入会读回确认；接管后的输出会如实报告焦点是否已归还。
  KDE computer use: drag and drop works in Qt and GTK applications, input into QML fields such as the System Settings search is verified by reading it back, and takeover output reports whether focus actually returned.
- agent 桌面：剪贴板为空时读取返回空字符串；桌面里的应用可以使用主机音频。
  Agent desktop: reading an empty clipboard returns an empty string, and applications inside it can use host audio.
- agent 桌面：里面的应用可以使用主机的 KWallet/Secret Service 和通知，Chrome 等浏览器能沿用主人的登录状态；不再自动拉起额外的钱包进程。
  Agent desktop: applications inside it use the host KWallet/Secret Service and notifications, so browsers such as Chrome keep the user's sign-ins, and no extra wallet daemons are started.

## [18.13.3-zen.7] - 2026-10-29

### Added

- 支持 KDE Plasma 原生桌面操作：列出窗口、按窗口截图、直接输入，并可接管与归还焦点。
  Added native KDE Plasma computer use with window discovery, per-window screenshots, direct input, and focus takeover and release.
- 新增隔离的 agent 桌面，使用独立 KWin、D-Bus 和辅助功能会话；可通过 `computer.agentDesktop()` 启动，并用 `/desk` 显示、隐藏或关闭。
  Added an isolated agent desktop with its own KWin, D-Bus, and accessibility session; start it with `computer.agentDesktop()` and show, hide, or close it with `/desk`.

## [18.13.3-zen.6] - 2026-10-29

### Added

- 新增 `/redraw` 命令，从对话记录重建终端滚动历史。
  Added `/redraw` to rebuild terminal scrollback from the transcript.

### Changed

- 流式输出按完整显示行逐步定稿，多行段落和代码块无需等整块完成即可进入终端滚动历史。
  Streaming output now settles complete display lines incrementally, allowing multiline paragraphs and code blocks to enter terminal scrollback before the whole block finishes.

### Fixed

- 修复流式代码高亮未复位 ANSI 样式时，颜色泄漏到后续终端内容的问题。
  Fixed streamed code highlighting leaking ANSI styles into subsequent terminal content when reset codes were missing.

## [18.13.3-zen.5] - 2026-10-29

### Added

- 发布可独立部署的 Linux x64 collab relay，无需安装运行时；自托管更新支持健康检查与失败回滚。
  Added a standalone Linux x64 collab relay requiring no installed runtime, with health-checked self-hosted updates and rollback on failure.

## [18.13.3-zen.4] - 2026-10-29

### Changed

- 优化 npm 包发布流程，缩短整套 zen 包的发布等待时间。
  Improved npm publishing to reduce the wait for a complete zen package release.

## [18.13.3-zen.3] - 2026-10-29

### Changed

- 所有 zen 包统一通过 npm 可信发布，去除 collab-web 发布对长期 token 的依赖。
  All zen packages now use npm trusted publishing, removing the collab-web release dependency on a long-lived token.

## [18.13.3-zen.2] - 2026-10-28

### Added

- 发布不含站点统计脚本的 collab-web 静态站点 npm 包，并提供可自动更新的自托管部署方式。
  Added a collab-web static-site npm package without site analytics, with automatically updated self-hosted deployment support.

### Changed

- 协作会话优先加载最新消息，按需获取历史记录，并在加密前压缩数据，大会话加入更快。
  Collaboration sessions now load recent messages first, fetch history on demand, and compress data before encryption for faster joins to large sessions.

## [18.13.3-zen.1] - 2026-10-28

### Added

- 首个 npm 版：基于上游 18.13.3，以 `@oh-my-pi-zen/*` 包名发布；支持 Linux x64、Linux arm64 和 macOS arm64，Linux x64 原生模块包含 Wayland/PipeWire 支持。
  First npm release based on upstream 18.13.3, published as `@oh-my-pi-zen/*` for Linux x64, Linux arm64, and macOS arm64, with Wayland/PipeWire support in the Linux x64 native module.

### Changed

- `omp update` 与启动版本检查改用 zen npm 包；通过 Bun 同步更新 CLI 与匹配版本的原生模块。
  `omp update` and startup version checks now use zen npm packages, updating the CLI and matching native modules together through Bun.
