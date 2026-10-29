# collab relay

零依赖 Bun 生产 relay，取代 Go 仓库实现；只读取 4 字节 peerId 信封头，不解密载荷。

```sh
bun zen/collab-relay/main.ts -listen 127.0.0.1:7466
bun test zen/collab-relay
bun zen/collab-relay/source-hash.ts
bun build --compile --target=bun-linux-x64-baseline zen/collab-relay/main.ts --outfile /tmp/collab-relay --define 'COLLAB_RELAY_VERSION="18.13.3-zen.1"'
/tmp/collab-relay --version
curl 127.0.0.1:7466/healthz # ok rooms=N
```

参数同时支持 `-name`、`--name` 与 `=value`；命令行覆盖环境变量。

| 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `-listen` | `COLLAB_RELAY_LISTEN` | `127.0.0.1:7466` |
| `-host-cidrs` | `COLLAB_RELAY_HOST_CIDRS` | 空（host 不限来源） |
| `-trust-xff` | `COLLAB_RELAY_TRUST_XFF` | `true` |
| `-max-rooms` | `COLLAB_RELAY_MAX_ROOMS` | `64` |
| `-max-guests` | `COLLAB_RELAY_MAX_GUESTS` | `32` |
| `-max-conns-per-ip` | `COLLAB_RELAY_MAX_CONNS_PER_IP` | `32` |
| `-version` | — | 打印版本（未注入时为 `dev`） |

`host-cidrs` 为逗号分隔的 IPv4/IPv6 CIDR；guest 不受其限制。只信任 TCP 对端为回环地址时的 XFF 最后一跳。单帧 16 MiB，单连接发送积压 32 MiB（含条目开销），写超时 30 秒；SIGINT/SIGTERM 最多等待 8 秒，guest 收到 `room-closed` 与 4001，host 收到 1001。


心跳由 Bun/uWS 的 socket 级空闲检测处理：空闲 20 秒后 ping，再空闲一轮才断开（通常约 40 秒；Go 每 15 秒 ping）。它会感知未完整接收的大帧的部分字节，避免慢速上传误断。Bun 不支持发送分片，pong 可能排在大帧之后；持续收发数据的连接不会仅因 pong 未到而断开。
## Caddy

只代理 `/r/*`，不要公开 `/healthz`。relay 自身要求 `role` 恰好一次，避免重复查询参数绕过代理检查。

```caddyfile
collab.example.com {
	@hostOutsideTailnet {
		path /r/*
		query role=host
		not remote_ip 100.64.0.0/10 fd7a:115c:a1e0::/48
	}
	handle /r/* {
		respond @hostOutsideTailnet 403
		reverse_proxy 127.0.0.1:7466
	}
	handle {
		redir https://my.omp.sh/ 302
	}
}
```

## systemd

保存为 `/etc/systemd/system/collab-relay.service`：

```ini
[Unit]
Description=omp collab relay
After=network-online.target
Wants=network-online.target

[Service]
Environment=COLLAB_RELAY_LISTEN=127.0.0.1:7466
Environment=COLLAB_RELAY_HOST_CIDRS=100.64.0.0/10,fd7a:115c:a1e0::/48
ExecStart=/srv/omp-collab-relay/current/collab-relay
Restart=on-failure
RestartSec=2
TimeoutStopSec=15
DynamicUser=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
# Bun/JavaScriptCore 的 JIT 需要可执行内存，不能启用 MemoryDenyWriteExecute。
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged
UMask=0077
MemoryMax=384M
LimitNOFILE=8192
TasksMax=512

[Install]
WantedBy=multi-user.target
```
