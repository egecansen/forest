# Hektor

sahibinden Selenium/JUnit paketi için paylaşılabilir bir QA metodoloji paketi;
**Cursor** için yapılmıştır. `*Page/*Layout/*Test.java` (web-test),
`*ResourceClient/AbName.java` (test-data-client) ve `*DAO/*DAOImpl.java`
(test-dao) dosyalarını **otomatik PR inceleyicisinden ilk seferde geçecek**
şekilde yazmanıza yardım eden beceriler ve uygulama kapıları; REST/SQL
yardımcıları web-test içinde yazılmaz (`tech/TDC-<n>` / `tech/DAO-<n>`).

## Kurulum (ekip arkadaşları: buradan başlayın)

> Forest kullanıyorsanız bu bölüme gerek yok: paket forest'ın içinde
> (`packs/hektor`) yaşar ve `web-test`, `test-data-client` ve `test-dao`
> worktree'lerine oluşturulurken ve her başlatmada otomatik kurulur. Aşağısı forest olmadan,
> elle kurulum içindir.

`hektor/` dizinini deponuza ekleyin (klonlayın ya da kopyalayın), sonra depodan
tek komut çalıştırın:

```bash
./hektor/hektor package install
```

Ardından becerilerin ve hook'ların yüklenmesi için **Cursor penceresini yeniden
yükleyin** (`Cmd/Ctrl+Shift+P` → *Developer: Reload Window*). Hepsi bu; yeniden
çalıştırmak güvenlidir (idempotent). PATH'te `jq` gerekir.

`./hektor/hektor` yerine yalın `hektor` komutunu mu istiyorsunuz? Bir kez
bağlayın; ilk komut `hektor` komutunu `~/.local/bin` altına bağlar, ikincisi
artık hangi depoda olursanız olun çalışır:

```bash
./hektor/hektor package link
hektor package install
```

### `hektor` CLI'ı

| Komut | Ne yapar |
|---|---|
| `hektor package install [--project DIR] [--no-kits]` | paketi bir depoya bağlar (çalıştırdığınız depoyu otomatik bulur) |
| `hektor package status [--project DIR]` | kurulu olanı gösterir ve eksik bir betiğe işaret eden kayıtları işaretler |
| `hektor doctor [--project DIR]` | paketi denetler (ölü yönlendirme yok / geçerli frontmatter / gerçek Cursor olayları / geçerli şemalar) |
| `hektor package uninstall [--project DIR]` | Hektor'u kaldırır (diğer `.cursor` girdilerinize ve çalışma durumunuza dokunmaz) |
| `hektor package link` / `unlink` | `hektor` komutunu PATH'e ekler / PATH'ten çıkarır |
| `hektor version` / `help` | — |

`install` aslında `install.sh` betiğini çalıştırır; onu doğrudan da
çağırabilirsiniz (`./install.sh --project /path/to/repo`). Çalıştığınız her
depoya kurun (`web-test`, `test-data-client`, `test-dao`, …).

## Ne elde edersiniz

Her şey projenin `.cursor/` dizinine iner; Cursor'ın okuduğu tek ağaç budur:

```
.cursor/
├── skills/<name>/SKILL.md    açıklamasıyla otomatik ya da /<name> ile açıkça çağrılır
├── agents/hektor-*.md        becerilerin gönderdiği alt ajan rolleri
├── rules/hektor-kernel.mdc   her zaman uygulanır — yönlendirici + testbox sözleşmesi
├── hooks/ + hooks.json       uygulama kapıları
└── schemas/                  alt ajan dönüş sözleşmeleri
```

- **Beceriler** — yazma/triage el kitapları. PR'ları geçiren iki tanesi glob
  kapsamlıdır; yönettikleri bir dosyayı açtığınızda kendiliğinden bağlanır:
  - `hektor-conventions` — her **web-test** PR-inceleyici kuralı
    (BLOCKER/WARNING) doğru kalıbıyla. `web-ui-test/**/*.java` üzerinde bağlanır.
  - `hektor-resource-client` — **test-data-client** kuralları + web-test'ten
    REST helper handoff'u (önce mevcut metodu kullan, yoksa `tech/TDC-<n>`).
    `*ResourceClient.java` / `AbName.java` üzerinde bağlanır.
  - `hektor-test-dao` — **test-dao** SQL helper handoff'u (önce mevcut metodu
    kullan, yoksa `tech/DAO-<n>`). `*DAO.java` / `*DAOImpl.java` üzerinde bağlanır.

  Başka her yerde `/hektor-orchestrator` ile başlayın ya da görevi anlatın.

- **Alt ajanlar** — `hektor-composer`, `-prober`, `-diagnoser`, `-reviewer`,
  `-mapper`, `-distiller`. Beceriler bunları paralel gönderir; inceleyici
  `readonly: true`'dur çünkü işi düzeltmek değil incelemektir.

- **`pr-rules-gate`** — inceleyicinin belirlenimci (Katman 1a) denetimlerinin
  **yazma anında** çalışan yerel bir aynası; ihlal PR'da değil push'tan önce
  yakalanır. BLOCKER'lar yazmayı veto eder; WARNING'ler not olarak döner.

- **Uygulama katmanının geri kalanı** — bkz. [`hooks/README.md`](./hooks/README.md).

## Uygulama bir bakışta

| Cursor olayı | Kapılar | Etki |
|---|---|---|
| `sessionStart` | kernel-inject | yönlendiriciyi oturum başına bir kez enjekte eder |
| `beforeShellExecution` | commit, destructive-command | kesin engel |
| `preToolUse` | pr-rules, invisible-unicode, journey-map-sentinel, run-status-write, enforcement-self-protection | kesin engel |
| `subagentStart` | approver-registry, reviewer-brief, schema-preread, dispatch-ordering, first-pass-guard | reddeder |
| `subagentStop` | reviewer-attestation, return-schema | takip turu |
| `postToolUse` | pr-rules (tavsiye yarısı), observe | not / sessiz kayıt |
| `stop` | delivery-gate | takip turu |

## Kapatma anahtarları

Her kapının kendi ortam anahtarı vardır (`HEKTOR_PR_RULES_GATE=off`,
`HEKTOR_COMMIT_GATE=off`, …); bilinçli ve belgelenmiş bir istisna içindir. Daha
kaba ayarlar: `HEKTOR_HOOK_PROFILE=minimal|standard|strict` bir kademe seçer,
`HEKTOR_DISABLED_HOOKS=a,b` kapıları adlandırır, `HEKTOR_CURSOR_HOOKS=off` tüm
katmanı kapatır.

Bunlar sürtünmedir, güvenlik sınırı değil: kapılanan ajan hepsini kendisi
ayarlayabilir. Kullanımları `docs/hektor/.hook-audit.log` dosyasına kaydedilir.
Bkz. [`hooks/README.md`](./hooks/README.md) §Vulnerabilities.

## Yerleşim

```
hektor                  CLI — `hektor package install|status|doctor|uninstall|link`
install.sh              CLI'ın sürdüğü kurucu
catalog.json            beceri/kit dizini
hooks.json              kapı kayıtları (.cursor/hooks.json içine birleştirilir)
skills/<name>/          beceriler
agents/                 alt ajan rol tanımları
rules/                  her zaman uygulanan çekirdek kural
hooks/                  uygulama kapıları (+ hooks/README.md)
schemas/                alt ajan dönüş biçimi sözleşmeleri
kits/flaky-triage-kit/  bağımsız flaky-triage kiti (kendi kurucusu var)
docs/cursor-parity.md   Cursor'ın pakete verdikleri ve vermediği tek şey
```

## Commit'ler hakkında not

Kapılar bir ekip kuralını uygular: **ajan asla commit ya da push yapmaz**;
çalışma ağacını siz inceler ve kendiniz commit'lersiniz. Bu bir hata değil,
kasıtlıdır.
