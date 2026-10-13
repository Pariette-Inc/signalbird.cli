# signalbird CLI

Signalbird'ün komut satırı aracı. Üç işi var:

| Rol | Ne yapar | Nerede |
| --- | --- | --- |
| **Düzeltici** (`signalbird fix`) | Telsize düşen alarmı bilgisayarınızdaki Claude'a verir; Claude kodu düzeltir, CLI dalı push edip PR açar. Panelde "Çözüldü" dediğinizde yerel klon silinir. | Geliştirici bilgisayarı |
| **Gönderici** (`signalbird send`) | Telsize tek mesaj yazar (deploy, cron, betik). | Her yer |
| **Sunucu ajanı** (`signalbird agent`) | Ölçüm, log, beklenen sinyal. *Yakında — agent.signalbird'ün yerini alacak.* | Sunucu |

yazar: ahmet selim çil | ahmet@pariette.com · sözleşme: [PROTOCOL.md](PROTOCOL.md)

---

## Düzeltici: 4 komut

```bash
npm i -g signalbird-cli
signalbird fix login --key sbf_live_…          # Panel → Telsiz → Düzeltici makineler → Makine ekle
signalbird fix link adall.io ~/git/adall        # domain → proje klasörü
signalbird fix install                          # açılışta başlar (launchd / systemd --user)
```

Sonra panelde ilgili kanalın ayarında **Kod düzeltmesi**'ni açın. O kanala
düşen her mesaj bu bilgisayara iş olarak gelir.

### Proje tanıtma

Yalnız kök klasörü verirsiniz. Altındaki git depoları, GitHub adresleri ve
hedef dallar iş anında bulunur:

```
$ signalbird fix link adall.io ~/git/adall
adall.io → /Volumes/solidCloud/git/adall
  ✓ adall.api                Pariette-Inc/adall.api               → test
  ✓ adall.web                Pariette-Inc/adall.web               → test
  ✓ app.adall                Pariette-Inc/app.adall               → test
```

- Klasöre yeni repo eklerseniz bir şey yapmanız gerekmez.
- Hedef dal sırası: `--base` → `test` → `development` → `develop` → `dev` → reponun varsayılanı.
- Repo başına dal: `~/.signalbird/config.json` → `links[].base = {"adall.api": "test", "app.adall": "main"}`.
- Yalnız bazı repolar: `--repos adall.api,adall.web`.
- Domain'siz olaylar (ör. sunucu kanalı) için kanal anahtarı: `signalbird fix link '#sunucu' ~/git/adall`.

### Bir iş nasıl yürür

1. Alarm gelir → `~/.signalbird/fix/jobs/SBF-…/` altına her repo **yerel klon**
   olarak açılır (ana repoya dokunulmaz, VS Code'da görünmez), dal `sb-fix/SBF-…`.
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
| `signalbird fix links` | Bağlar ve keşfedilen repolar |
| `signalbird fix logs` | Servis logu |
| `signalbird fix cleanup [--dry-run]` | Sunucuda kapanmış işlerin kalan klonlarını siler |
| `signalbird fix start` | Ön planda çalıştırır (servis yerine) |

### Gereksinimler

- Node 20+, git, [gh](https://cli.github.com) (`gh auth login` yapılmış)
- [Claude Code](https://docs.claude.com/claude-code) kurulu ve giriş yapılmış (`claude` bir kez çalıştırılıp oturum açılmış)

### Güvenlik

- Düzeltici `root` olarak ya da `sbf_live_` dışında bir anahtarla çalışmaz; sunucuya kurulmak için değildir.
- Hiçbir zaman hedef dala doğrudan push etmez; yalnız `sb-fix/…` dalı + PR. Force push yok.
- Yerel yollar sunucuya gönderilmez; API yalnız domain/kanal adını bilir.
- Kendini güncellemez. Yeni sürüm: `npm i -g signalbird-cli`.
- Claude izin sormadan çalışır (`--dangerously-skip-permissions`) — yalnız iş klasöründe, ama bilgisayarınızın yetkileriyle. Güvenmediğiniz kaynaklardan beslenen kanallarda düzeltmeyi açmayın.
- Log panele gitmeden önce bilinen anahtar desenleri (`sb_*_live_`, `sk-`, `ghp_`, `AKIA…`) maskelenir.

---

## Gönderici

```bash
signalbird send login --key sb_secret_live_…
signalbird send error "ödeme kuyruğu durdu" --channel adallCritical --source deploy
```

Anahtar sırası: `--key` → `SIGNALBIRD_KEY` → `config.json`.

---

## Ayar

`~/.signalbird/config.json` (0600). Ayrıntı: [PROTOCOL.md §8](PROTOCOL.md).
Test/yerel API için: `signalbird fix login --key … --api http://localhost:8000/api`.

## Geliştirme

```bash
npm install
npm test
```
