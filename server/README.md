# MemeBox API 运维

生产地址：`https://memebox.137-131-36-153.sslip.io`

## 服务布局

- Caddy 监听 `80/443`，负责自动 HTTPS 和反向代理。
- API 以 `memebox` 无登录系统用户运行，只监听 `127.0.0.1:8787`。
- SQLite 数据库位于 `/var/lib/memebox-api/memebox.db`。
- 服务器密钥位于 `/etc/memebox-api.env`，权限为 `0640 root:memebox`。
- systemd 对 API 启用只读系统目录、私有临时目录、禁止提权和 192 MB 内存上限。
- `memebox-api-backup.timer` 每天创建一致性备份，保留最近 14 份。

仓库中的 `server/install.sh` 不包含密钥。部署时需要单独提供
`memebox-api.env.tmp`，正式环境文件不得加入 Git。

## 常用检查

```sh
sudo systemctl status memebox-api caddy
sudo journalctl -u memebox-api -u caddy -n 100 --no-pager
sudo systemctl list-timers memebox-api-backup.timer
curl https://memebox.137-131-36-153.sslip.io/api/v1/health
```

## 手动备份

```sh
sudo systemctl start memebox-api-backup.service
sudo find /var/lib/memebox-api/backups -maxdepth 1 -type f -ls
```

本机备份只能防止数据库误操作，不能防止整块云硬盘损坏。长期运行时应定期将备份复制到
另一台机器或对象存储，并继续将副本视为敏感数据。

## 更新 API

将新的 `app.py` 和 `backup.py` 安装到 `/opt/memebox-api/` 后执行：

```sh
sudo systemctl restart memebox-api
curl https://memebox.137-131-36-153.sslip.io/api/v1/health
```

不要在命令行、日志或 Git commit 中写入管理员令牌和访客哈希密钥。
