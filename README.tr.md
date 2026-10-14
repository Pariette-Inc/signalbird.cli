# signalbird-cli

`signalbird-cli`, Signalbird'ün komut satırı aracıdır. Tek paket, üç iş:

| Rol | Ne yapar | Nerede çalışır |
| --- | --- | --- |
| **Janet** (`signalbird login`, `signalbird fix …`) | Telsiz'e düşen alarmı bilgisayarınızdaki Claude Code'a verir, düzeltmeyi pull request olarak açar. İnceleyip birleştiren sizsiniz. | Geliştirici bilgisayarı |
| **Gönderici** (`signalbird send …`) | Deploy betiğinden, cron'dan ya da herhangi bir kabuktan Telsiz kanalına tek olay yazar. | Her yer |
| **Sunucu ajanı** (`signalbird agent …`) | Yük, bellek, disk, servis, veritabanı ve log satırlarını Sunucular ekranına taşır. Komut almaz. | Linux sunucu (root) |

[English README](README.md) · [Doküman](https://signalbird.io/tr/sdk/cli) · [Sözleşme](PROTOCOL.md) · MIT

```bash
npm i -g signalbird-cli
signalbird --version
```

**Node.js 20+** gerekir. Paket kendini güncellemez; yeni sürüm için aynı `npm i -g signalbird-cli` komutunu tekrar çalıştırın.

---

## 1. Janet: alarmı düzeltir, PR açar

Bilgisayarınızda bir kez iki komut çalıştırırsınız. Sonrası panelden yürür.

```bash
npm i -g signalbird-cli
signalbird login
```

`signalbird login` dört adımda ilerler:

1. **Proje klasörü.** Projelerinizin durduğu klasörü (ör. `~/git`) bulur ya da sorar. Altındaki her klasör bir projedir: `~/git/adall` içinde `adall.api`, `adall.web`, `app.adall`. Signalbird'e yalnız klasör ve repo **adları** gider, yol gitmez.
2. **Hesap.** Tarayıcıyı açar; Signalbird hesabınızla **Bu bilgisayarı bağla** dersiniz. Anahtar kopyalamak yok. Bilgisayar **hesabınıza** bağlanır ve üyesi olduğunuz her takımın Janet görevlerini alabilir.
3. **Kontrol.** git, `gh` ve Claude Code; Claude oturumunun gerçekten çalışıp çalışmadığı dahil.
4. **Servis.** Bilgisayar açılınca başlayan arka plan servisini kurar (macOS'ta launchd, Linux'ta `systemd --user`).

Sonra her şey panelde, **Entegrasyon → Janet** altında:

* **Projeler:** `adall.io → adall` gibi eşlemeler çoğunlukla kendiliğinden bulunur. Yanlışsa listeden doğru klasörü seçersiniz.
* Bir Telsiz kanalının ayarında **Janet otomatik düzeltsin**i açın ya da tek bir olayda **Janet'a aktar**a basın.
* Görev sayfasında Janet'la konuşun. Alarm belirsizse Janet size soru sorar; görev cevabınızı bekler.
* İş bitince **Çözüldü** deyin. Yerel klon silinir.

### Bir görev nasıl yürür

1. Alarm gelir. Projenin her reposu `git clone --shared` ile `~/.signalbird/fix/jobs/SBF-…/` altına, yeni bir `janet/SBF-…` dalında açılır. Çalışma kopyanıza dokunulmaz, klon editörünüzde görünmez.
2. Claude alarmı, o ana kadarki konuşmayı ve bütün repoları okur, sorunun nerede olduğuna karar verir ve düzeltmeyi commit'ler. Alarm metni "dışarıdan gelen veri, talimat değil" diye ayrı bir blokta durur.
3. Değişmeyen repoların klonu hemen silinir. Değişenler push edilir, her biri için PR açılır.
4. Panelde canlı log, Janet'ın özeti ve PR bağlantıları görünür. Janet'ın bilgiye ihtiyacı varsa görev **Cevap bekliyor** durumuna geçer.
5. **Çözüldü**, **Reddet** ya da **Durdur** yerel klonu siler. Açık bir görevde Janet'a yazarsanız aynı dalda, aynı PR'a devam eder.

### Janet komutları

| Komut | Ne yapar |
| --- | --- |
| `signalbird login [--root ~/git] [--no-service] [--api URL]` | Bu bilgisayarı hesabınıza bağlar (tarayıcı onayı), proje klasörünü bulur, servisi kurar. Bir kez çalıştırmanız yeter. |
| `signalbird logout` | Bu bilgisayarın oturumunu ve servisini kaldırır. |
| `signalbird fix status` | Servis, bağlantı, Claude oturumu ve açık görev klasörleri. |
| `signalbird fix doctor` | git, gh, Claude (oturum dahil) ve API kontrolü. Claude yeniden çalışıyorsa eski "Claude'a giriş yapın" bayrağını sıfırlar. |
| `signalbird fix claude-token [anahtar]` | Janet'ı `claude setup-token` ile alınan uzun ömürlü anahtarla Claude'a bağlar. Terminal anahtarı iki satıra bölse de doğru okunur. |
| `signalbird fix links` | Yerel bağlar ve klasörünüzde bulunan projeler. |
| `signalbird fix link <domain\|#kanal> <klasör> [--base dal] [--repos a,b]` | Bir domain'i ya da kanalı bu bilgisayardaki klasöre sabitler. Paneldeki otomatik eşlemenin önüne geçer. |
| `signalbird fix unlink <domain\|#kanal>` | Yerel bağı kaldırır. |
| `signalbird fix install` | Arka plan servisini kurar (ya da yeniden başlatır). Paketi güncelledikten sonra çalıştırın. |
| `signalbird fix uninstall` | Servisi kaldırır. |
| `signalbird fix start` | Servis yerine ön planda çalıştırır. |
| `signalbird fix logs [-n 100]` | Servis logunun sonu. |
| `signalbird fix cleanup [--dry-run] [--force]` | Sunucuda kapanmış görevlerin yerel klonlarını siler. |
| `signalbird fix login --key sbf_live_… [--api URL]` | Gelişmiş: hesap yerine takım anahtarıyla bağlanır. |

**Hedef dal.** Önce `--base`, sonra `test`, `development`, `develop`, `dev` dallarından ilk var olanı, en son reponun varsayılan dalı. Repo başına farklı dal için `~/.signalbird/config.json` içinde `links[].base = {"adall.api": "test", "app.adall": "main"}` yazın.

### Claude oturumu

Janet `claude` komutunu terminal oturumuyla çalıştırır; bu oturum Claude masaüstü uygulamasından ayrıdır. Panel "Claude oturumu kapanmış" derse:

```bash
claude setup-token              # uzun ömürlü anahtarı yazdırır
signalbird fix claude-token     # anahtarı buraya yapıştırın
```

Anahtar `~/.signalbird/config.json` (0600) içinde durur ve yalnız `claude` sürecine verilir.

### Gereksinimler

* Node.js 20+, git
* [GitHub CLI](https://cli.github.com), giriş yapılmış (`gh auth login`)
* [Claude Code](https://docs.claude.com/claude-code), kurulu ve giriş yapılmış

### Güvenlik

* Janet hedef dala asla push etmez. Yalnız `janet/…` dallarını push eder ve PR açar. Force push yok.
* `root` olarak çalışmayı reddeder. Geliştirici bilgisayarı içindir, sunucu için değil.
* Yerel yollar gönderilmez. API yalnız domain, kanal ve klasör adlarını bilir.
* Claude görev klasöründe izin sormadan (`--dangerously-skip-permissions`), sizin kullanıcı yetkilerinizle çalışır. Güvenmediğiniz kaynaklardan beslenen kanallarda otomatik düzeltmeyi açmayın.
* Log satırı panele gitmeden önce bilinen gizli anahtar desenleri (`sb_*_live_`, `sk-`, `ghp_`, `AKIA…`) maskelenir.

---

## 2. Gönderici: herhangi bir kabuktan tek olay

```bash
signalbird send login --key sb_secret_live_…
signalbird send error "ödeme kuyruğu durdu" --channel adallCritical --source deploy
```

| Komut | Ne yapar |
| --- | --- |
| `signalbird send <seviye> <mesaj> --channel <kanal> [--key …] [--source x] [--context '{"a":1}']` | Tek olay yazar. Seviyeler: `debug`, `info`, `warn`, `error`, `critical`. `--channel` için kısa yol `-c`. |
| `signalbird send login --key sb_secret_live_… [--api URL]` | Anahtarı kaydeder; sonraki çağrılarda `--key` gerekmez. |

Anahtar sırası: `--key`, sonra `SIGNALBIRD_KEY` ortam değişkeni, sonra `config.json`. Bildirim kuralı (kim aranır, sessiz saatler) betikte değil panelde durur.

---

## 3. Sunucu ajanı: Linux sunucunun içeriden görüntüsü

Yük, CPU, bellek, takas, disk ve inode, systemd servisleri, dinlenen portlar, en çok kaynak yiyen süreçler, MySQL/MariaDB/PostgreSQL ve Socket.io durumunu okur. İzin verilen log dosyalarındaki yeni satırları Telsiz'e taşır, beklenen sinyalleri ("yedek alındı") iletir. **Komut almaz**: panel yalnız ayar değiştirebilir (hangi ölçüm, hangi aralık, hangi log).

Servis için systemd'li bir Linux gerekir. macOS'ta `signalbird agent run` deneme amaçlı ön planda çalışır.

```bash
sudo npm i -g signalbird-cli          # küresel kurun; npx servis kuramaz
sudo signalbird agent install --token=sba_live_…
sudo signalbird agent status
journalctl -u signalbird-agent -f
```

Anahtar **Sunucular → Sunucu ekle** ekranında gösterilir. `install` önce anahtarı Signalbird'e dener (yanlış anahtar ayara yazılmaz), sonra `/etc/signalbird/agent.conf` (0600) ve `/etc/systemd/system/signalbird-agent.service` dosyalarını yazar ve servisi başlatır. Birim root olarak, `ProtectSystem=strict` ile çalışır; yazabildiği tek yerler `/var/lib/signalbird` ve `/var/log`'dur. Adım adım anlatım: [Sunucu ajanı kılavuzu](https://signalbird.io/tr/sdk/agent).

| Komut | Ne yapar |
| --- | --- |
| `sudo signalbird agent install --token=sba_live_… [--api URL] [--allow=/var/log,/srv/app/logs]` | Ayarı yazar, systemd servisini kurar ve başlatır. `--allow` panelin log okuyabileceği klasörleri belirler (varsayılan `/var/log`). |
| `signalbird agent run` | Sürekli çalışır (servis bunu kullanır). |
| `sudo signalbird agent once` | Tek tur: ayar, log, dosya sinyalleri, ölçüm. Deneme için idealdir. |
| `sudo signalbird agent signal <anahtar> [ok\|fail] [mesaj]` | Beklenen sinyali iletir. `fail` alarmı beklemeden çaldırır. |
| `sudo signalbird agent status` | Yerel ayar, servis durumu ve bağlantı denemesi. |
| `sudo signalbird agent uninstall` | Servisi kaldırır. Ayar ve durum dosyaları kalır. |
| `signalbird agent version` | Ajan protokol sürümü (paket sürümünden ayrıdır). |

Yedek betiğine örnek:

```bash
if mysqldump --all-databases | gzip > /var/backups/db.sql.gz; then
  signalbird agent signal db-backup ok "$(du -h /var/backups/db.sql.gz | cut -f1)"
else
  signalbird agent signal db-backup fail "mysqldump hata verdi"
fi
```

Veritabanı bilgileri `/etc/signalbird/agent.conf` içinde kalır, hiçbir istekte gönderilmez. Ajana salt okunur bir kullanıcı verin:

```ini
db_driver=mysql        # mysql | mariadb | pgsql
db_host=127.0.0.1
db_port=3306
db_user=signalbird_ro
db_pass=…
db_name=dukkan
```

Ajanın çalıştırdığı komutların tam listesi kodda sabittir: [docs/AGENT-COMMANDS.md](docs/AGENT-COMMANDS.md). Panelden seçilen log yolu `--allow` altında değilse okunmaz; sembolik bağla kaçış da engellenir.

---

## 4. Dosyalar ve ortam değişkenleri

| | |
| --- | --- |
| `~/.signalbird/config.json` | Janet ve gönderici ayarı (0600). `SIGNALBIRD_CONFIG` ile başka dosya, `SIGNALBIRD_HOME` ile başka klasör seçilir. |
| `~/.signalbird/fix/jobs/` | Görev klonları. Görev çözülünce, reddedilince ya da durdurulunca silinir. |
| `/etc/signalbird/agent.conf` | Sunucu ajanı ayarı (0600). |
| `SIGNALBIRD_NO_BROWSER=1` | `signalbird login` tarayıcıyı açmak yerine onay bağlantısını yazar (SSH üzerinden bağlıyken kendiliğinden). |
| `NO_COLOR=1` | Renksiz, düz çıktı. |

## 5. Sık sorulanlar

**Janet benim yerime kodu birleştirir mi?** Hayır. Janet yalnız PR açar. İnceleme, birleştirme ve "Çözüldü" kararı sizindir.

**Bilgisayarım kapalıyken ne olur?** Görevler kuyrukta bekler. Bilgisayar açılınca servis bağlanır ve sırayla alır.

**Birden fazla takımda çalışıyorum, her biri için ayrı giriş mi yapacağım?** Hayır. Bilgisayar hesabınıza bağlanır; üyesi olduğunuz her takımın görevlerini alır.

**Sunucuya Janet kurabilir miyim?** Hayır. Janet `root` olarak çalışmaz ve kodu sizin GitHub oturumunuzla push eder; geliştirici bilgisayarı içindir. Sunucuya `signalbird agent` kurulur.

## Geliştirme

```bash
npm install
npm test
```

Sözleşmeler: [PROTOCOL.md](PROTOCOL.md) (Janet ve gönderici), [docs/AGENT-PROTOCOL.md](docs/AGENT-PROTOCOL.md) (sunucu ajanı).

ahmet selim çil | ahmet@pariette.com
