# Sunucu ajanının çalıştırdığı komutlar

> `signalbird agent` (ajan sürümü 1.1.0, protokol 1) · bash ajanındaki
> `PROTOCOL.md §7` listesinin Node karşılığı.

Ajan sunucuda hiçbir şeyi değiştirmez ve Signalbird'den komut almaz
([AGENT-PROTOCOL.md §1](AGENT-PROTOCOL.md)). Bu belge ajanın başlattığı
**her** dış süreci listeler. Liste kodda da sabittir:
`src/agent/exec.mjs` → `ALLOWED_COMMANDS = ['df', 'systemctl', 'ss', 'ps', 'mysql', 'psql']`.
Bu listede olmayan bir komut çağrılırsa ajan hata fırlatır (test:
`test/agent.test.mjs` → "exec beyaz listesi"). Komutlar kabuk olmadan,
argüman listesiyle (`execFile`) ve 10 sn zaman aşımıyla çalışır; panelden
gelen hiçbir değer kabukta yorumlanmaz.

## Dış komutlar

| Komut (tam argümanlarıyla) | Ne zaman | Ne için |
| --- | --- | --- |
| `df -P -x tmpfs -x devtmpfs -x overlay -x squashfs -x nfs -x nfs4 -x cifs` | `collectors.disks` açıksa (varsayılan) | Disk doluluğu (Linux) |
| `df -Pi -x tmpfs -x devtmpfs -x overlay -x squashfs -x nfs -x nfs4 -x cifs` | aynı | Inode doluluğu (Linux). Bash ajanı bunu bağlama noktası başına çağırıyordu; Node tek çağrıda alır |
| `df -Pk`, `df -Pi` | aynı | macOS (en iyi çaba) |
| `systemctl is-active <servis>` | `collectors.services` doluysa, servis başına | Servis durumu (yalnız okur). Ad `-` ile başlıyorsa ya da `[A-Za-z0-9@._:\-]` dışı karakter içeriyorsa hiç çalıştırılmaz, durum `unknown` |
| `ss -ltnpH` | `collectors.ports` açıksa (Linux) | Dinlenen TCP portları ve süreç adı. ss yoksa `ports` anahtarı hiç gönderilmez |
| `ps -eo comm=,pcpu=,rss= --sort=-pcpu` | `collectors.processes` > 0 (Linux) | CPU'ya göre ilk N süreç (en çok 20) |
| `ps -Ao comm=,pcpu=,rss= -r` | aynı (macOS) | aynı |
| `mysql -h <host> -P <port> [-u <user>] --connect-timeout=5 -N -B -e "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Slow_queries','Uptime'); SHOW GLOBAL VARIABLES LIKE 'max_connections';"` | `collectors.database.enabled` ve yerel `db_driver=mysql\|mariadb` | Veritabanı durumu |
| `mysql … -e "SELECT ROUND(SUM(data_length+index_length)/1048576,1) FROM information_schema.tables WHERE table_schema='<db_name>';"` | aynı, `db_name` verildiyse ve `[A-Za-z0-9_$-]{1,64}` ise | Veritabanı boyutu |
| `psql -h <host> -p <port> [-U <user>] -d <db_name\|postgres> -tAc "SELECT count(*) FROM pg_stat_activity;"` | yerel `db_driver=pgsql\|postgres\|postgresql` | Bağlantı sayısı |
| `psql … -tAc "SHOW max_connections;"` | aynı | Bağlantı sınırı |
| `psql … -tAc "SELECT ROUND(pg_database_size(current_database())/1048576.0,1);"` | aynı | Veritabanı boyutu |
| `systemctl daemon-reload`, `systemctl enable signalbird-agent.service`, `systemctl restart signalbird-agent.service` | yalnız `agent install` | Kendi servisini kurmak |
| `systemctl disable --now signalbird-agent.service`, `systemctl daemon-reload` | yalnız `agent uninstall` | Kendi servisini kaldırmak |
| `systemctl is-active signalbird-agent.service` | yalnız `agent status` | Kendi servisinin durumu |

Veritabanı parolası komut satırına **yazılmaz** (`ps` çıktısında görünürdü):
yalnız o çağrının ortamına `MYSQL_PWD` / `PGPASSWORD` olarak verilir.
`psql` için `PGCONNECT_TIMEOUT=5` da verilir. Bağlantı bilgisi yalnız
`/etc/signalbird/agent.conf`'tan okunur, Signalbird'e gönderilmez.

## Dış komut OLMAYAN okumalar

Bash ajanının komutla yaptığı bu işler Node'da doğrudan dosya/sistem
çağrısıdır; süreç başlatılmaz:

| Bash | Node | Ne için |
| --- | --- | --- |
| `cat /proc/uptime`, `cat /proc/loadavg` | `fs.readFileSync` | Çalışma süresi, yük |
| `cat /proc/stat` (1 sn arayla iki kez), `cat /proc/meminfo` | `fs.readFileSync` | CPU, bellek, takas |
| `grep PRETTY_NAME /etc/os-release`, `uname -sr`, `uname -m`, `hostname` | `fs` / `os` modülü | `hello` kimliği |
| `tail -c +<offset>`, `wc -c` | `fs.openSync` + `fs.readSync` (konumdan, en çok 1 MiB) | Log okuma |
| `readlink -f` | `fs.realpathSync` | `allow_paths` denetimi (sembolik bağla kaçış) |
| `stat -c %Y`, `du -h` | `fs.statSync` | Dosya sinyali (değişim zamanı, boyut) |
| `curl` (Signalbird API) | `fetch` | Gönderim, yalnız yerel ayardaki `api_base` |
| `curl` (socket ölçümü) | `fetch`, `redirect: 'error'`, 5 sn | Yalnız `127.0.0.1` / `localhost` / `[::1]`; kullanıcı bilgili adres (`http://localhost:80@evil.com/`) reddedilir, yönlendirme izlenmez |
| `python3` / `jq` | `JSON.parse` | Ayar okuma (Node'da ek araç gerekmez) |

## Yazılan dosyalar

| Yol | Ne |
| --- | --- |
| `/etc/signalbird/agent.conf` (0600) | Yalnız `agent install`: anahtar, API adresi, izinli yollar |
| `/etc/systemd/system/signalbird-agent.service` | Yalnız `agent install` / `uninstall` |
| `/var/lib/signalbird/state` | Log konumları (`log:…=<bayt>`) ve dosya kimliği (`ino:…=<inode>`) |
| `/var/lib/signalbird/config.json` | Son bilinen panel ayarı |
| `/var/log/signalbird-agent.log` | Yerel günlük (anahtar desenleri maskelenir) |

systemd birimi `ProtectSystem=strict` ile çalışır; yazılabilir yerler yalnız
`/var/lib/signalbird` ve `/var/log`'dur.
