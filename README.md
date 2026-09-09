# Forest 🌲

Tüm depolarınızdaki git worktree'lerini takip eden ve bir dalda Claude ya da
Cursor başlatan, bağımlılığı olmayan yerel bir web paneli. Yalnızca Node gerekir
(sadece yerleşik modüller, `npm install` yok). Sunucu `127.0.0.1` adresine
bağlanır.

## Çalıştırma

    forest            # sunucuyu (kapalıysa) başlatır ve paneli açar

    forest up         # sunucuyu başlatır; tarayıcı açmaz
    forest down       # sunucuyu durdurur
    forest status     # çalışıp çalışmadığını pid ve port ile bildirir
    forest restart    # durdurup yeniden başlatır

`forest status`, sunucu çalışıyorsa 0, çalışmıyorsa 1 ile çıkar; böylece
zincirlenebilir: `forest status && open http://127.0.0.1:5577`.

Forest sunucusunu, yapılandırılmış porttaki dinleyiciye bakıp sürecin gerçekten
`node server.mjs` olduğunu doğrulayarak bulur. Portta başka bir şey oturuyorsa
`forest down` bunu bildirir ve öldürmeyi reddeder.

Ya da doğrudan:

    node server.mjs

Sonra http://127.0.0.1:5577 adresini açın.

## Ekip için kurulum

Forest beceri paketini kendi içinde taşır (`packs/`), bu yüzden tek bir klon her
şeyi getirir.

Gereksinimler: Node 20 veya üstü, git, `jq` (paket kurucusu kullanır), macOS
(başlatma için).

1. Depoyu klonlayın: `git clone <url> ~/code/forest`.
2. `forest` komutunu PATH'e alın: `ln -s "$PWD/bin/forest" ~/.local/bin/forest`.
3. `cp config.example.json config.json`; `roots`, `jiraBaseUrl`,
   `jiraProjectKey` ve `jiraToken` değerlerini girin.
4. `forest`.

Daha önce forest kullanıyorsanız `config.json` içindeki `packsDir` satırını
silin; eski bir `SKLS` yolu sessizce kullanılır ve o paketlerde `targets`
olmadığından otomatik hazırlama çalışmaz.

`web-test` ve `test-data-client` worktree'leri oluşturulurken otomatik
hazırlanır ve her başlatmada yeniden denetlenir. Paketi güncellemek için
forest'ta `git pull` yeterlidir; her worktree bir sonraki başlatmada yenilenir.

## Otomatik hazırlama

Her paketin `catalog.json` dosyasındaki `targets` listesi, paketin hangi depolar
için olduğunu söyler (forest'ın listelediği depo adı; `*` hepsi demektir).
Hedeflenen bir deponun worktree'si oluşturulduğunda ve her başlatmada forest
paketin tamamını iki eksene yazar: `.claude/` (beceriler, kitler, kapılar) ve
`.cursor/` (paketin kendi `install.sh` betiği ile). Paket değişmediyse (git
ağaç özeti aynıysa) iş atlanır. Yerel olarak düzenlenmiş bir hazırlanmış dosya
yenilemede üzerine yazılır ve günlükte adıyla listelenir.

Guided kipte worktree oluşturma komutu, git bittiğinde forest'a haber veren bir
`curl` çağrısıyla biter; hazırlama ancak checkout tamamlandığında başlar.

Bir worktree'yi elle hazırlamak için: `curl -s -X POST -H 'content-type: application/json' --data '{"path":"/worktree/yolu"}' http://127.0.0.1:5577/api/worktree/provision`. Aynı uç noktayı paketin kendi `scripts/worktree-provision.sh` betiği de kullanabilir.

Başlatma seçici (picker) açıldığında otomatik seçim işaretli gelir; işareti
kaldırmak seçimi bu worktree için geçersiz kılar. `config.json` içinde
`"autoProvision": false` otomatik hazırlamayı kapatır; seçici çalışmaya devam
eder.

Claude tarafı bugün yalnızca becerileri alır: paketin kapıları Cursor biçiminde
yanıt verir. Kapıların Claude sürümü pakette ayrı bir iş olarak planlandı.

Bilinen yan etki: paket kurucusu, hedef deponun izlenen `.gitignore` dosyasına
çalışma durumu dosyaları için bir blok ekler (yoksa). Bu, taban dalında blok
bulunmayan her yeni worktree'de bir kez olur; bloğu bir kez commit'lediğinizde
sonraki worktree'ler temiz kalır.

## Güven

Paketin kurucusu, kapı betikleri ve kit kurucusu, her ekip üyesinin makinesinde
bir sonraki başlatmada çalışır. `packs/` dizinini `CODEOWNERS` ile koruyun ve
inceleme zorunlu tutun. Forest paketi yalnızca kendi klonundan okur; hiçbir
zaman indirmez.

Sunucu yalnızca `127.0.0.1` üzerinde dinler ve her isteğin `Host` ve `Origin`
başlıklarını denetler; `/api/*` POST istekleri `application/json` içerik türü
ister. Reddedilen istekler günlükte bir kez görünür.

## Başka bir makinede kullanım

Forest'ta sabit yol yoktur; istediğiniz yere klonlayıp kodunuza yöneltin.

1. Depoyu klonlayın, ör. `git clone <url> ~/code/forest`.
2. Forest'a depolarınızın yerini söyleyin (birini seçin):
   - **Kural (sıfır yapılandırma):** Forest `<root>/APPS/forest` altındaysa
     deste kökü otomatik olarak `<root>` olur.
   - **`config.json`:** `cp config.example.json config.json` ve `roots`
     değerini girin.
   - **Ortam değişkenleri:** `FOREST_ROOTS=/path/a,/path/b FOREST_PORT=5577 node server.mjs`.
3. (İsteğe bağlı) `bin/forest` betiğini `PATH`'e alın:
   `ln -s "$PWD/bin/forest" ~/.local/bin/forest` — kendi konumunu çözer, her
   yerden çalışır.

> Şimdilik yalnızca macOS: Claude/Cursor başlatma ve "guided" terminal
> eylemleri `open`/AppleScript kullanır. Panelin kendisi platformdan
> bağımsızdır.

## Duruş

Forest bir cam kokpittir, otopilot değil. Görünürlük tamamen arayüzde;
değişiklikler önce terminalde. Başlıktaki **Guided ⟷ Auto** anahtarı bir eylemin
terminalinizde mi (akıcılığınızı korursunuz) yoksa arka planda mı (günlüğe
yazılır) çalışacağına karar verir. İki kip de yıkıcı eylemleri onaylatır ve bir
deponun birincil worktree'sine asla dokunmaz.

## Worktree açıklamaları

Her worktree'nin çekmecesinde bir açıklama vardır. Başlangıçta dalın biletinden
oluşur: iş başlığı, ardından tarama bağlantısı; düz metin olarak okunur ve bilet
URL'si tıklanabilir. **Edit** bunu istediğinizi yazabileceğiniz bir kutuya
çevirir; düğme **Save** olur, geri çıkmak için **Cancel**, bilet metnine dönmek
için **Reset to auto** vardır. `Description` başlığı bölümü katlar ve tercih
hatırlanır.

Geçersiz kılmalar dal başına `<repo>/.forest/descriptions.json` içinde saklanır;
worktree silinip yeniden oluşturulsa da kalır.

Destedeki dal adları bilerek bağlantı değildir: satıra tıklamak çekmeceyi açar,
bilet bağlantısı açıklamadadır.

Başlıkları okumak `jiraBaseUrl` ve `jiraToken` ister (aşağıda). Bunlar olmadan
açıklama yalnızca bağlantıya düşer; geri kalan her şey çalışır.

## Yapılandırma

`config.json` (gitignore'da, makineye özel) yerleşik varsayılanları geçersiz
kılar; her anahtarın `FOREST_*` ortam değişkeni karşılığı da vardır. Başlamak
için `config.example.json` dosyasını `config.json` olarak kopyalayın.

| Anahtar | Ortam | Varsayılan | Anlamı |
|-----|-----|---------|---------|
| `roots` | `FOREST_ROOTS` | `<install>/../..` | git depoları için taranan dizinler |
| `containers` | `FOREST_CONTAINERS` | `["APPS"]` | çocukları tek tek listelenen git olmayan klasörler |
| `packsDir` | `FOREST_PACKS_DIR` | `<forest>/packs` | beceri paketlerinin okunduğu dizin |
| `autoProvision` | — | `true` | hedeflenen depoların worktree'lerini otomatik hazırla |
| `port` | `FOREST_PORT` | `5577` | sunucu portu |
| `jiraBaseUrl` | `FOREST_JIRA_URL` | `""` | dal biletlerini Jira'ya bağlar |
| `jiraProjectKey` | `FOREST_JIRA_PROJECT_KEY` | `""` | dalın biletini yeniden anahtarlar (`WEBT-1` → `SHBDN-1`); boş = dalın kendi anahtarı |
| `jiraToken` | `FOREST_JIRA_TOKEN` | `""` | iş başlıklarını okumak için PAT; tarayıcıya asla gönderilmez |
| `jiraEmail` | `FOREST_JIRA_EMAIL` | `""` | yalnızca Jira Cloud için; Basic `email:token` ister |
| `staleDays` | — | `14` | bir worktree'nin bayat sayılacağı yaş |
| `defaultMode` | — | `guided` | `guided` ya da `auto` |
| `terminalApp` / `openEditorCmd` / `setupScript` | — | macOS varsayılanları | başlatma yardımcıları |

## Test

    npm test    # lib/*.test.mjs üzerinde node --test
