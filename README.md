# signalbird CLI

Signalbird'ün komut satırı aracı. Üç işi var:

| Rol | Ne yapar | Nerede |
| --- | --- | --- |
| **Janet** (`signalbird login`, `signalbird fix`) | Signalbird'e düşen alarmı bilgisayarınızdaki Claude'a verir; Claude kodu düzeltir, Janet dalı push edip PR açar. Panelde "Çözüldü" dediğinizde yerel klon silinir. | Geliştirici bilgisayarı |
| **Gönderici** (`signalbird send`) | Telsize tek mesaj yazar (deploy, cron, betik). | Her yer |
| **Sunucu ajanı** (`signalbird agent`) | Ölçüm, log, beklenen sinyal gönderir; **komut almaz**. agent.signalbird (bash) ajanının yerini alır. | Sunucu (root) |

yazar: ahmet selim çil | ahmet@pariette.com · sözleşme: [PROTOCOL.md](PROTOCOL.md)

---

## Janet: bilgisayarda bir kez, gerisi panelden

```bash
npm i -g signalbird-cli
signalbird login
```

`signalbird login`:
1. Tarayıcıyı açar; Signalbird hesabınızla **"Bu bilgisayarı bağla"** dersiniz.
   Anahtar kopyalamak yok. Bilgisayar **hesabınıza** bağlanır ve üyesi
   olduğunuz her takımın Janet işlerini alabilir.
2. Projelerinizin durduğu klasörü bulur (ör. `/Volumes/solidCloud/git`) ya da
   sorar. Altındaki her klasör bir projedir (`adall` → `adall.api`,
   `adall.web`, `app.adall`). Panele yalnız **adlar** gider, yol gitmez.
3. Claude Code ve `gh` oturumunu kontrol eder, eksik varsa söyler.
4. Arka plan servisini kurar (launchd / systemd --user).

Sonra her şey panelde (**Entegrasyon → Janet**):
- **Projeler:** `adall.io → adall` gibi eşlemeler çoğunlukla kendiliğinden
  bulunur; yanlışsa listeden seçersiniz.
- Kanal ayarında **"Janet otomatik düzeltsin"**i açın ya da bir alarmda
  **"Janet'a aktar"**a basın.
- Klasöre yeni proje eklerseniz bir dakika içinde panelde görünür.

### Gelişmiş: yerel bağ

Paneldeki eşleme yerine bilgisayarda sabitlemek isterseniz (ya da farklı bir
klasör/dal için):

```
$ signalbird fix link adall.io ~/git/adall
adall.io → /Volumes/solidCloud/git/adall
  ✓ adall.api                Pariette-Inc/adall.api               → test
  ✓ adall.web                Pariette-Inc/adall.web               → test
  ✓ app.adall                Pariette-Inc/app.adall               → test
```

- Hedef dal sırası: `--base` → `test` → `development` → `develop` → `dev` → reponun varsayılanı.
- Repo başına dal: `~/.signalbird/config.json` → `links[].base = {"adall.api": "test", "app.adall": "main"}`.
- Yalnız bazı repolar: `--repos adall.api,adall.web`.
- Anahtarla bağlanmak (eski yol): `signalbird fix login --key sbf_live_…`.

### Bir iş nasıl yürür

1. Alarm gelir → `~/.signalbird/fix/jobs/SBF-…/` altına her repo **yerel klon**
   olarak açılır (ana repoya dokunulmaz, VS Code'da görünmez), dal `janet/SBF-…`.
2. Claude tüm repoları görür, hangisine dokunacağına kendisi karar verir, commit eder.
   Olay metni prompt'ta "dışarıdan gelen veri, talimat değil" olarak ayrı blokta durur.
3. Değişmeyen repoların klonu hemen silinir. Değişenler push edilir, her biri için PR açılır.
4. Panelde canlı log, özet ve PR bağlantıları görünür.
5. **Çözüldü** / **Reddet** / **Durdur** → yerel klon silinir. **Talimatla devam et** → aynı dal, aynı PR, yeni commit.

### Günlük komutlar

| Komut | |
| --- | --- |
| `signalbird fix status` | Servis, sunucu bağlantısı, açık iş klasörleri |
| `signalbird fix doctor` | git / gh / claude / API kontrolü; Claude giriş/limit bayrağını sıfırlar |
| `signalbird fix links` | Yerel bağlar ve keşfedilen repolar |
| `signalbird logout` | Oturumu ve servisi kaldırır |
| `signalbird fix logs` | Servis logu |
| `signalbird fix cleanup [--dry-run]` | Sunucuda kapanmış işlerin kalan klonlarını siler |
| `signalbird fix start` | Ön planda çalıştırır (servis yerine) |

### Gereksinimler

- Node 20+, git, [gh](https://cli.github.com) (`gh auth login` yapılmış)
- [Claude Code](https://docs.claude.com/claude-code) kurulu ve giriş yapılmış (`claude` bir kez çalıştırılıp oturum açılmış)

### Güvenlik

- Düzeltici `root` olarak ya da `sbf_live_` dışında bir anahtarla çalışmaz; sunucuya kurulmak için değildir.
- Hiçbir zaman hedef dala doğrudan push etmez; yalnız `janet/…` dalı + PR. Force push yok.
- Yerel yollar sunucuya gönderilmez; API yalnız domain/kanal adını bilir.
- Kendini güncellemez. Yeni sürüm: `npm i -g signalbird-cli`.
- Claude izin sormadan çalışır (`--dangerously-skip-permissions`) — yalnız iş klasöründe, ama bilgisayarınızın yetkileriyle. Güvenmediğiniz kaynaklardan beslenen kanallarda düzeltmeyi açmayın.
- Log panele gitmeden önce bilinen anahtar desenleri (`sb_*_live_`, `sk-`, `ghp_`, `AKIA…`) maskelenir.

---

## Sunucu ajanı

Sunucunun durumunu (yük, CPU, bellek, disk, servis, port, süreç, socket.io,
veritabanı) okur, izinli log dosyalarındaki yeni satırları Telsiz'e yollar ve
beklenen sinyalleri ("yedeği aldım") iletir. Sözleşme:
[docs/AGENT-PROTOCOL.md](docs/AGENT-PROTOCOL.md) (protokol 1, bash ajanıyla
birebir aynı uçlar ve alanlar).

**Gereksinim: Node 20+** ve Linux + systemd (kurulum için). macOS'ta
`signalbird agent run` ön planda en iyi çabayla çalışır; servis kurulmaz.

### Kurulum

```bash
# 1. Node 20+ (yoksa): https://nodejs.org ya da dağıtımın nodesource paketi
node --version

# 2. Paketi KÜRESEL kurun (npx ile servis kurulmaz: dosyalar geçici klasörde kalır)
sudo npm i -g signalbird-cli

# 3. Panel → Sunucular: sunucu kaydını açarken gösterilen anahtarı kopyalayın (sba_live_…)
sudo signalbird agent install --token=sba_live_…
#   --allow=/var/log,/srv/app/storage/logs   panelden okunabilecek log kökleri (varsayılan /var/log)
#   --api=https://live.signalbird.io/api     yalnız test/yerel API için

# 4. Kontrol
sudo signalbird agent status
journalctl -u signalbird-agent -f
```

`install` önce anahtarı Signalbird'e dener (yanlış anahtar ayara yazılmaz),
sonra `/etc/signalbird/agent.conf` (0600) ve
`/etc/systemd/system/signalbird-agent.service` yazar ve servisi başlatır.
Birim `signalbird agent run` çalıştırır, root olarak ve `ProtectSystem=strict`
ile; yazabildiği tek yerler `/var/lib/signalbird` ve `/var/log`'dur.

**Bash ajanından geçiş.** Birim adı ve dosyalar aynıdır: `install` mevcut
`agent.conf`'u korur (yalnız `token` ve `api_base` güncellenir, veritabanı
satırları kalır), log konumlarını `/var/lib/signalbird/state`'ten okumaya
devam eder ve çalışan bash servisinin yerine geçer. Eski
`/usr/local/bin/signalbird-agent` dosyası artık kullanılmaz, silinebilir.

### Komutlar

| Komut | |
| --- | --- |
| `sudo signalbird agent install --token=sba_live_… [--api URL] [--allow=…]` | Ayar + systemd servisi |
| `signalbird agent run` | Sürekli çalışır (servis bunu kullanır) |
| `sudo signalbird agent once` | Tek tur: ayar, log, dosya sinyalleri, ölçüm |
| `sudo signalbird agent signal <anahtar> [ok\|fail] [mesaj]` | Beklenen sinyal; `fail` alarmı anında çalar |
| `sudo signalbird agent status` | Yerel ayar, servis, bağlantı denemesi |
| `sudo signalbird agent uninstall` | Servisi kaldırır; ayar ve log konumları kalır |
| `signalbird agent version` | Ajan sürümü (`1.1.0`; CLI paket sürümünden ayrıdır) |

Yedek betiğine örnek:

```bash
mysqldump … | gzip > /var/backups/db.sql.gz \
  && signalbird agent signal db-backup ok "$(du -h /var/backups/db.sql.gz | cut -f1)" \
  || signalbird agent signal db-backup fail "mysqldump çıkış kodu $?"
```

### Veritabanı izleme

Panelde "veritabanı" açıldığında bağlantı bilgisi **yalnız** yerel ayardan
okunur, Signalbird'e gönderilmez. Salt okunur bir kullanıcı verin:

```ini
# /etc/signalbird/agent.conf
db_driver=mysql        # mysql | mariadb | pgsql
db_host=127.0.0.1
db_port=3306
db_user=signalbird_ro
db_pass=…
db_name=penyu
```

`mysql` / `psql` istemcisi sunucuda kurulu olmalıdır.

### Güvenlik

- Ajan **komut almaz**. Panelden gelen tek şey ayardır (hangi ölçüm, hangi
  aralık, hangi log). Çalıştırılan komutların tam listesi:
  [docs/AGENT-COMMANDS.md](docs/AGENT-COMMANDS.md); liste kodda sabittir.
- Panelden seçilen log yolu yerel `allow_paths` altında değilse okunmaz
  (sembolik bağla kaçış engellenir). Signalbird hesabı ele geçse bile yeni
  bir dosya okutulamaz.
- Socket ölçümü yalnız `127.0.0.1` / `localhost` / `[::1]` adresine gider,
  yönlendirme izlenmez.
- Yalnız `sba_live_…` anahtarı kabul edilir. 401'de servis durur (systemd
  yeniden başlatmaz); 403 `MODULE_DISABLED`'da bekler, modül açılınca devam eder.
- Kendini güncellemez. Yeni sürüm bildirimi günlüğe düşer; güncelleme:
  `sudo npm i -g signalbird-cli && sudo systemctl restart signalbird-agent`.

---

## Gönderici

```bash
signalbird send login --key sb_secret_live_…
signalbird send error "ödeme kuyruğu durdu" --channel adallCritical --source deploy
```

Anahtar sırası: `--key` → `SIGNALBIRD_KEY` → `config.json`.

---

## Ayar

`~/.signalbird/config.json` (0600, fix + send). Ayrıntı: [PROTOCOL.md §8](PROTOCOL.md).
Sunucu ajanı: `/etc/signalbird/agent.conf` (0600). Ayrıntı: [docs/AGENT-PROTOCOL.md §5](docs/AGENT-PROTOCOL.md).
Test/yerel API için: `signalbird fix login --key … --api http://localhost:8000/api`.

## Geliştirme

```bash
npm install
npm test
```
