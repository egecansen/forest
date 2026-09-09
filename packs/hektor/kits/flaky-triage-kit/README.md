# Hektor Flaky-Triage Kit

Bir Selenium/JUnit paketinin flaky **testbox** koşusunu triage edin: bir s-report URL'si + bir testbox
alın, raporun başarısız testlerini o box üzerinde yeniden koşun, **tek bir** kolay-düzeltme→muhtemel-bug
küme tablosu sunun, kullanıcı seçsin, sonra seçilenleri baştan sona düzeltin — yeşil olduğu doğrulanmış
(pass^N), şüpheli uygulama bug'ları işaretlenmiş halde. **Yalnızca testbox. Asla commit atmaz, ticket
açmaz, test devre dışı bırakmaz.**

Motor düz shell olduğu için **her** terminalden çalışır — onu süren bir ajanla ya da bir insanla. Kitin
ajana bakan yarısı (Cursor'ın yüklediği beceri ve o ajanın kitin kendi güvenlik yüzeyini düzenlemesini
ya da oturumu kanıtsız bitirmesini engelleyen kapılar) Cursor'ı hedefler.

## Gereksinimler
`bash` · `jq` · `curl` · `python3` · `gradle` (+ paket için JDK 17). ES rapor sunucunuza ve testbox'a
ağ erişimi.

## Kurulum — tek komut

Bu `flaky-triage-kit/` klasörünü herhangi bir yere bırakın ve şu komutu çalıştırın:

```bash
./hektor-triage-kit install --project /path/to/your/repo
# PATH'e koyduktan sonra her yerden:
./hektor-triage-kit link            # ~/.local/bin altına symlink
hektor-triage-kit install --project /path/to/your/repo
```

`install` her şeyi otomatik yapılandırır — **elle yapılandırma adımı yok**: **JDK 17**'yi otomatik
bulur (`run.java_home` yazar) ve **source_roots**'u (sizin `src/test/java`'nız) tespit eder, sonra
kapıları bağlar. Diğer alt komutlar: `hektor-triage-kit lock|unlock|status` (OS düzeyindeki koruma
kademesi — `sudo` varken **hardened**, yoksa yalnızca-chmod **degraded**; bkz. `core/lock-kit.sh`'in
başlığı), `link` (PATH'e koyar), `build` (aşağıda) ve `--version` — bu, *bu kaynak checkout'unun*
sürümünü bildirir; `status` ise verilen bir *projenin* hangi sürümden kurulduğunu bildirir. (İsterseniz
`./install.sh` doğrudan da çalışır.)

Tek bir kurulum şunları yerleştirir:
- **motor + beceri**: `.cursor/skills/hektor-flaky-triage/` — Cursor beceriyi açıklamasıyla yükler ya
  da `/hektor-flaky-triage` ile çağırırsınız.
- **kendini koruma kapısı**, `beforeShellExecution` + `preToolUse` üzerine kayıtlı.
- **teslim kapısı**, `stop` üzerine kayıtlı.
- **Yalın terminal / insan** — motor öylece çalışır; başka bir şey gerekmez.

**Idempotent**tir (yeniden çalıştırılabilir, yinelenen kayıt yapmaz, hooks.json'ınızın geri kalanını
korur). Beceri ve hook'ların yüklenmesi için **Cursor penceresini yeniden yükleyin**; motor terminalden
hemen çalışır.

**Betikliyorsanız çıkış durumunu kontrol edin.** `0` temiz kurulumdur ve `install: done` ile biten tek
durumdur. `74`, kurulumun BİTTİĞİ ama teslim kapısının `stop` kaydının `.cursor/hooks.json` içine
birleştirilemediği anlamına gelir (neredeyse her zaman: `.hooks.stop` var ve bir dizi değil) — motor,
beceri ve diğer bütün kayıtlar yerindedir, sonuç `install: INCOMPLETE` der ve "sırada sertleştirme"
adımını bilinçli olarak **yazmaz**. Bu durumda `core/lock-kit.sh lock` çalıştırmayın: `core/.harness`
`stop` yeteneğini bilerek kaydetmeye devam eder, dolayısıyla bağlantı ekseni `unregistered` okur; ağaç
sizindeyken bu bir uyarı, root'a geçtiğinde ise **her giriş noktasından rc 76**'dır — orada yazdırdığı
çare (kurucuyu yeniden çalıştırmak) da `75` ile reddedilir. `.hooks.stop`'u düzeltin, kurucuyu yeniden
çalıştırın, *sonra* kilitleyin. (`64` hatalı argüman, `66` böyle bir proje yok, `69` `jq` yok, `75`
hedef kit zaten root'a ait — önce kilidi açın.)

## Dağıtılabilir paket üretme

    hektor-triage-kit build

Kiti `hektor-flaky-triage-<version>.tgz` içine paketler ve doğrular: `.lock-state`
yok, geliştirme artığı yok, paketlenen `install.sh` kaynaktakiyle birebir aynı.
Başarısız bir denetim, diskte bozuk bir artefakt bırakmak yerine onu siler.
Paketleme `scripts/scan-kit.sh`'e bağlıdır; bu betik `core/config.json` ve
`kernel.md` dışında iç hostname taşıyan bir ağacı reddeder; reddederse `build`
özet yerine taramanın kendi satırını — dosya ve satır numarası — yazar.

`npm pack` çalıştığı dizine yazar, dolayısıyla `.tgz` buraya, izlenen bir dizine
düşer. Bilerek git-ignore'ludur: üretin, kurun, atın. İki artefakt demek birinin
bayatlaması demektir; zip'in emekliye ayrılma sebebi budur.

`build`'i **bu kaynak checkout'undan** çalıştırın. Açılmış bir tarball'da
`package.json` vardır ama `scripts/` yoktur — paketleme araçları bilinçli olarak
`files` beyaz listesinin dışındadır — bu yüzden paketlenmiş bir kit kendini
yeniden paketleyemez ve `build` bunu söyler (çıkış 66).

Her yere kurun:

    npm i -g ./hektor-flaky-triage-1.0.0.tgz && hektor-triage-kit install
    npx /path/to/kits/flaky-triage-kit install

Her iki biçim de CLI'a bir symlink üzerinden ulaşır — npm'in `bin`'i böyle
çalışır, devre dışı bırakılamaz — bu yüzden CLI, `install.sh`'i bulmadan önce
kendi symlink zincirini çözer. `npx <tarball>` çalışan bir biçim **değildir**:
npx bir tarball spec'inden `bin` çözemez. `npx <dizin>` ya da
`npm i -g <tarball>` kullanın.

## Yapılandırma (aynı altyapıdaki bir ekip için gereken tek düzenleme)
`<repo>/.cursor/skills/hektor-flaky-triage/core/config.json` dosyasını düzenleyin:
- `source_roots` — test/page paketleriniz (`apply`'ın yazmasına izin verilen yer). **Zorunlu.**
- `run.workdir` — Gradle modülü (varsayılan `web-ui-test`).
- `es.host` (+ `es.host_allowlist`'e ekleyin) / `qagent` / `jira` — zaten paylaşılan kurum altyapısını
  gösterir; yalnızca sizinki farklıysa değiştirin. **Bu dosyada sır tutulmaz** (burası yapılandırma
  dikişidir, kernel §10).

JDK'yı bir kez ayarlayın: `export HEKTOR_FK_JAVA_HOME=/path/to/jdk-17`.

## Çalıştırma
LLM, `SKILL.md` içindeki döngüyü motoru çağırarak sürer:
```bash
KIT=.cursor/skills/hektor-flaky-triage/core
"$KIT/ingest.sh"  "<s-report-url>"   > fails.json     # doğrular + build'i sabitler; kaçak metni ayıklar
"$KIT/cluster.sh" < fails.json       > clusters.json  # kök-neden kümeleri (üst sınırlı)
"$KIT/rerun.sh"   "<fqcn-csv>" <tb>                    # doğrulama oracle'ı (RERUN_EARLY_EXIT=0 = tam N)
echo '{"file":"…","old":"…","new":"…"}' | "$KIT/apply.sh"   # çalışma ağacı düzenlemesi, source_roots ile sınırlı
"$KIT/summary.sh" < ledger.json                        # yakınsama raporu (yalnızca yapılandırılmış token'lar)
```

## Teslim kapısı
Teslim kapısı — `.cursor/hooks/flaky-kit-delivery-gate.sh` konumuna kurulur (kaynak:
`gates/flaky-kit-delivery-gate.sh`) — oturum **stop**'unda çalışır ve bir oturumun kanıtsız bitmesine
izin vermez. İki denetim taşır, bilinçli olarak farklı sertliklerde:

- **I11** — defter (ledger) yolunu/yollarını doğrudan transkriptten türetir ve her biri için
  `core/ledger.sh validate <ledger> --final` çalıştırır (bu argüman sırası: önce dosya, sonra bayrak —
  tersi olursa komut I11'in kendi 67'si yerine 65 "ledger değil" ile çıkar). Herhangi bir küme hâlâ
  `selected`/`applied` iken **her** stop'ta ateşlenir: loop-count kaçışı yok ve **ortam değişkeniyle
  atlatma yok** — çare tamamen ajanın elindedir (her kümeyi green/flagged/deferred'a taşıyıp yeniden
  bitirmek). `core/apply` ya da `core/rerun` çalıştırıp hiç defter bırakmayan bir oturum da aynı şekilde
  yakalanır; yalnızca `ingest` ya da `cluster` yapmış bir oturum denetimsiz geçer; kite hiç dokunmamış
  bir oturumda kapı sessizdir.

  **Defter-yok yarısının tek-token'lık bir kaçışı vardır ve bu bilinçlidir.** Yalnızca transkript
  hiçbir yerde `core/ledger` adını geçirmiyorsa ateşlenir. `core/apply` çalıştırmış ve bu token'ı da
  anan bir oturum — `true # core/ledger` yeter — bunun yerine fail-open koluna girer: denetim kaydı
  düşer, engellenmez (doğrulandı: tek başına `core/apply.sh c3` engelliyor; aynı oturum artı o tek
  komut geçiyor). Bu kol var, çünkü içinde boşluk olan bir defter yolu, boşluğa göre bölen bir
  transkript taramasıyla çözülemez ve orada ateşlenmek yanıtlanamaz olurdu — I11 yarısının loop-count
  kaçışı yoktur, dolayısıyla kapının kendi yazdırdığı çareyi izlemek bulguyu yeniden üretir ve oturum
  çıkışsız bir döngüye girer. Çıkışı olmayan yanlış bir durdurma, denetim satırı bırakan bir delikten
  daha kötüdür; bu yüzden delik duruyor ve okurun bulmasına bırakılmak yerine burada adlandırılıyor.
  **Yukarıdaki açık-küme yarısının böyle bir kaçışı yoktur**: o, transkriptin ifadesini değil defterin
  durumunu okur.
- **hedge-scan** — `SKILL.md`'nin zaten ajandan kendi özetini geçirmesini istediği taramanın aynısını,
  bu kez oturumun son asistan mesajı üzerinde yeniden çalıştırır. **Bir kez** ateşlenir (`loop_count`
  sıfırdan farklı olur olmaz geri çekilir ve `hooks.json` onu `loop_limit: 1` ile sınırlar): yanlış bir
  pozitif, oturumun geri kalanına değil yalnızca bir ekstra tura mal olur.

Kapının değerlendiremediği her yol — `jq` yok, okunamayan bir transkript, motorun bulunamaması, bir
verdict dışında bir şeyle çıkan bir `validate --final` — fail-open davranır ve tek bir denetim satırı
yazar; hiçbir zaman çağıranı kilitlemez ve hiçbir zaman sessizce başarısız olmaz.

Verdict biçimi hakkında not: bir `stop` hook'u veto edemez — çalıştığı anda ajan zaten durmuştur.
Bunun yerine bir `followup_message` döndürür; bu, bulguyu ajanın önüne koyar ve bir tur daha atmasını
sağlar. Bu bölümdeki "engeller" tam olarak bunu demektir.

## Kendini koruma
Kit kendi `core/` · `SKILL.md` dosyalarını korur — ayrıca
`.cursor/hooks/flaky-kit-self-protection-gate.sh` konumundaki kendi koruma kapısını, yanındaki
`.cursor/hooks/flaky-kit-delivery-gate.sh` teslim kapısını, o kapının vendor'ladığı `lib/`'i,
`.cursor/hooks/` altındaki Cursor kapısını ve lib'leri, ağaç dışındaki `.flaky-kit-expect` kademe
kaydını ve `mv`/`rm` işlenenleri olarak her iki hook dizinini de. Kapı bu ağacın DIŞINA bilerek kurulur,
böylece ağacı yeniden adlandırmak dedektörü de götüremez. `HEKTOR_FLAKYKIT_UNLOCK=1` olmadıkça bunların
hiçbirine ajanın yazmasına izin vermez — gerçek retlerdir, CLI tarafından da uygulanır, ama yine de
sezgisel bir dizgi eşleşmesidir: bir duvar değil, sürtünme ve denetim izi.

**Harness ayar dosyaları da bu yüzeydedir** — `.cursor/hooks.json`, `.cursor/hooks.json` ve
`.cursor/hooks.json` — çünkü kapıyı kayıttan düşürmek düzenlemekten ucuzdur ve yukarıdakilerin tamamı
o tek kaydın var olmasına bağlıdır. İki araç dalı onlara bilerek farklı sorular sorar:

- **Bash — her mutasyon reddedilir**, kaydı gerçekten değiştirip değiştirmeyeceğine bakılmaksızın.
  Orada dosya içeriği mevcut olmadığı için kural bir yol-artı-fiil eşleşmesidir. Zararsız göründükleri
  hâlde şunların reddedilmesini bekleyin: `cp .cursor/hooks.json /tmp/x` (bir *dışarı kopyalama* da
  mutasyon fiili anar) ve `rm -f .cursor/hooks.json.bak` (kalıbın token-sonu sınırı yoktur, dolayısıyla
  bir ayar yoluyla *yalnızca başlayan* her yol eşleşir — bilinen bir kabalık, işaretleme yönünde hata
  yapar). Okumalar geçer: bu dosyalarda `cat` / `jq .` dokunulmadan kalır.
- **Write/Edit — sonuca göre karar verilir.** Yük mevcut olduğu için kapı, değişiklikten sonra kitin
  kaydının hayatta kalıp kalmadığını sorar ve yalnızca kalmayacaksa reddeder. İzinleri, ortamı ya da
  modeli düzenlemek serbesttir; kaydı *genişletmek* de öyle (`Write|Edit` → `Write|Edit|MultiEdit` ya
  da her iki matcher'ın tek bir `*` içinde birleştirilmesi). Daraltmak, bir matcher'ı düşürmek ya da
  ayrıştırılamaz JSON önermek reddedilir. Bugün hiç kayıt taşımayan bir ayar dosyası bu kitin hiç işi
  değildir.

Teslim kapısının `stop` kaydı aynı modelin bir slot'udur; bu yüzden `preToolUse`'a dokunmayan bir
`del(.hooks.stop)`, bir `preToolUse` matcher'ını düşürmekle tam olarak aynı şekilde reddedilir — iki
denetim de aynı düzenlemeyle kayıttan düşer ve aynı maliyeti taşır. `stop` kaydı taşımayan bir
hooks.json (teslim kapısından önceki her kurulum) birdenbire ona ihtiyaç duymaya başlamaz: kural
"sahip olduğunu kaybeder mi", asla "her zaman kayıtlı bitmeli" değildir.

`core/_integrity.sh` ikinci soruyu sorar — *kapı gerçekten çalışacak mı?* — aynı slot modelinden,
böylece ikisi geçerli bir kaydın ne olduğu konusunda asla anlaşmazlığa düşmez. 2026-07-31'den beri
bulduğu bozuklukları ONARIR da (`core/_wiring_repair.sh`, tespitle raporlama arasında çağrılır) — ama
yalnızca koşunun **devam etmesine** izin veren bir kademede: kayıt eklemeli olarak yeniden yazılır —
`unregistered`, `partial` ve `dangling`, hepsi `install.sh`'in kendi yaptığı aynı jq birleştirmesiyle —
ve kapı DOSYASI motorun kendi vendor'ladığı kopyasından geri yüklenir; `foreign` hiçbir şekilde
ellenmez. **REDDEDEN her kademede — `hardened`, `stale` ve `mismatch` — hiçbir şey yazılmaz, ne kapı
dosyası ne de kayıt.** Daha eski bir sürüm orada kaydı da onarıyordu; gerekçesi, yeniden yazılan bir
kaydın onu yazan oturumu zaten silahlandırmadığı, dolayısıyla reddin yine de tutacağıydı. Ölçüldüğünde
bu tam olarak bir çağrı boyunca tuttu: `integrity_guard` her seferinde iki ekseni de dosya sisteminden
yeniden hesaplar, dolayısıyla bir sonraki giriş noktası az önce yazdığı kaydı okudu, `wired` gördü ve 0
döndürdü — bir çağrı reddediyor, ondan sonraki her çağrı sessizce korumasız. `mismatch`, "ağacın root'a
ait olduğu yerde" diyen ilk düzeltmenin gözünden kaçtı; o düzeltme diğer ikisine ulaştı ama tüm anlamı
ağacın sahip *olmadığı* kayıtlı bir root mülkiyeti olan bu tek kademeye ulaşmadı — orada ölçüldüğünde
onarım, aynı koşunun güvenilmez ilan ettiği bir ağaçtan kapı betiğini kitin kendi koruma-hook yoluna
kopyaladı ve ekseni `dangling`'den `wired`'a çevirdi. Düzeltildi: üçünde de muhafız tespit eder, neyin
yanlış olduğunu söyler ve hiçbir şey yazmaz; böylece disk üzerinde hiçbir şey değişmediği için ret
(çıkış 76) her giriş noktasında tutar. Orada yazdırılan tavsiye hâlâ kilidi açmak, yeniden kurmak ve
kilitlemektir — o kademede gerçekten bir şeyi değiştiren tek yol budur.

Bir onarımı yalnızca gerçekten olduğu yerde duyurur. Onarım, eksen herhangi bir başarısızlık bildirdiğinde
**her** slot'u yeniden birleştirir; dolayısıyla karışık bir durumda (bir denetim bozuk, bir diğeri zaten
iyi) ekleyecek şeyi olmayan her birleştirme idempotent bir no-op'tur — ve *"REPAIRED — the … registration
has been rewritten"* bir durum değişikliği iddiasıdır, hiçbir durum değişmediğinde yanlıştır. Bu yüzden
her iki kaydedici de (`preToolUse`/`beforeShellExecution` ve `stop`) iki değil üç sonuç bildirir — indi ve
değiştirdi, indi ve hiçbir şey değiştirmedi, inmedi — ve yalnızca ilki, denetim başına adıyla duyurulur.
Birinden gelen sessizlik, yapacak işi olmadığı anlamına gelir; asla atlandığı anlamına gelmez: inmeyen bir
birleştirme bunu stderr'de söyler.

Duvar, varsa, altta: `lock-kit.sh` OS düzeyinde bir kademeye uzanır. **hardened** — `core/**`,
`SKILL.md`, kapı betikleri, vendor'lanan lib'ler ve kit kökünün kendisi root'a chown'lanır, böylece
yeniden açmak parola ister — her harness'ta tutar, çünkü onu bir hook değil çekirdek uygular. `sudo`
olmadan, aynı kullanıcının (ve dolayısıyla o kullanıcı olarak koşan bir ajanın) geri alabileceği
yalnızca-chmod salt-okunur bit'ine **düşer** — duvar değil, sürtünme. `lock-kit.sh status` yürürlükteki
kademeyi adlandırır ve her yüzey yolunun SAHİBİNİ yazar; bazı yollara uygulanıp bazılarına uygulanmamış
bir `chown`'u fark etmenin tek yolu budur. **Bir kiti korunuyor saymadan önce `core/lock-kit.sh`'in
başlığını okuyun:** hardened kademenin kapsamadıklarının otoriter ve yaşayan listesi odur — bu sayfa
değil, o dosya güncel sayı için güvenilecek yerdir. Aşağıdaki, bu sayfanın kolaylığı için tutulan bir
kopyadır; elle güncel tutuluyor ve başlığın yerini tutmaz; ikisi çelişirse başlık kazanır:

1. **Gölgeleme** — kit dizinini `mv` ile kenara alıp yerine başkasını koymak. Ağaç dışı kayıt üzerinden tespit edilir, önlenmez.
2. **O kayıt da silinebilir** — dizininin kullanıcıya ait kalması gerekir, dolayısıyla aynı aktör beklentiyi silebilir.
3. **Ağaç dışındaki her yüzey yolu** (üç kapı betiği de — her iki kendini koruma kapısı ve teslim kapısı — ve vendor'lanan lib'ler) *düzenlemeye* karşı korunur, *değiştirilmeye* karşı değil: ebeveynleri kullanıcıya ait kalır.
4. Bir insanı unlock'u çalıştırmaya ikna etmek — **sosyal mühendislik**.
5. **Parola yazıldıktan sonraki her şey** — `lock`/`unlock` `sudo -k` ile biter, ama komut istemiyle ayrıcalıklı bölümün sonu arasındaki pencere kalır.
6. **Kısmi sertleştirme** — bir `chown` bazı işlenenlerde başarılı, bazılarında başarısız olabilir; kademe yalnızca `core/`'dan örneklenir. Duyurulur ve teşhis edilebilir, önlenmez.
7. **`.cursor/hooks.json` hiçbir kademede chown'lanmaz**, hardened dahil — Cursor onu kendi sebepleriyle düzenlemeye devam eder. Tek koruması yukarıda anlatılan preToolUse kapısıdır; bu kapı, kendini koruma kapısının kendi kaydı gibi teslim kapısının `stop` kaydını da kapsar: altında mülkiyet zemini olmayan sezgisel bir politika katmanı. Yalnızca dosyanın bugün taşıdığı bir kaydı *kaybettirecek* bir değişikliği reddeder, asla "her zaman kayıtlı bitmeli" demez.
8. **Bağlantı denetimi, bir ajanın yazabildiği hooks.json'ın aynısını okur.** Bir kaydın mevcut olduğunu ve — ağaç root'a aitse — hâlâ bu kite ait bir dosyayı gösterdiğini kanıtlar. Harness'ın o kaydı *onurlandıracağını* hiçbir kademede kanıtlayamaz.
9. **Yalın bir `.cursor` işleneni hiçbir yüzey kalıbıyla eşleşmez**, dolayısıyla tüm dizini silmek serbesttir — ve hardened kademede bu, root'a ait kendini koruma kapısını, root'a ait teslim kapısını, denetim lib'ini, `.flaky-kit-expect`'i ve her iki kaydı birden siler. Önceden var olan bir durum ve ayrı bir iş olarak planlandı: kalıbı yalın `.cursor`'a genişletmek yüzeyi "kitin dosyaları"ndan "Cursor'ın tüm yapılandırma ağacı"na çevirir ve kendi tasarım turunu gerektirir.
10. **Bir onarım bir sonraki oturumda devreye girer, onu yapan oturumda asla.** Harness hook yapılandırmasını başlangıçta okur, dolayısıyla onarımla yeniden başlatma arasında kapı kayıtlıdır ama çalışmaz.
11. **Kit yalnızca kendi kaydını onarır.** Komşu bir paketin bayat kaydı kitin düzelteceği bir şey değildir ve düzeltilmez.
12. **Root'a ait bir ağacın altında geri yükleme kaynağının başka her şeyden fazla koruması yoktur** — zehirli bir `core/gate-src` zehirli bir kapı geri yükler. Alt kademeler zaten bunu demektir.
13. **Kayıt onarımı tamamen eklemelidir, asla bir temizleme değil.** `install.sh` birleştirmeden önce yer-değişikliği-öncesi kaydı düşürür; onarım düşürmez, dolayısıyla bulduğu ölü bir komut, onarımın eklediğinin yanında sonsuza dek kayıtlı kalır. Yakınsamayı engellemez — yer değişikliği sonrası yol, *tek bir ayar dosyası içinde* yer değişikliği öncesi olanın önüne sıralanır (`settings.json`/`settings.local.json` arasına bölündüğünde bu garanti değildir: `integrity_wiring` her dosyanın `unique` çıktısını dosya sırasıyla birleştirir ve `_wiring_cover` ilk satırı alır, yani dosyalar arası bir sıralama yoktur. Ölü girdi `settings.json`'da, yer değişikliği sonrası olan `settings.local.json`'da iken ölçüldü: `beforeShellExecution` için cover *yer-değişikliği-öncesi* komuttur ve verdict `dangling`'dir). Onarım orada yine de yakınsar, çünkü her zaman ilk okunan `settings.json`'a yazar — ölçüldü: tek bir onarım çağrısından önceki okumada `dangling`, sonrakinde `wired`. Yani yer değişikliği sonrası kapı dosyası var olduğunda eksen `wired` okur; oysa yalnızca bu eksenin denetlediğini değil kayıtlı her hook'u çalıştıran bir harness, eşleşen her çağrıda ölü komutu denemeye devam eder: özgün semptom, artık onu yakalayan eksene görünmez halde. Asıl çözüm, onu gerçekten temizleyen kurucuyu yeniden çalıştırmaktır.
14. **Teslim kapısının erişimi** — bir `stop` hook'u veto etmek yerine bir tur daha ister, dolayısıyla I11 ve hedge-scan bu değişiklikten önce ne idiyse o kalır: ajanın uyacağına güvenilen düzyazı.
15. **Kapı, oturumun kendisini değil harness'ın yazdığı transkripti okur** — ne olduğunu değil, neyin kaydedildiğini kanıtlar; ajanın bir komut satırında hiç anmadığı bir defter ona görünmezdir.
16. **"İş yapıldı"nın sınırı `core/apply`/`core/rerun`'dur** — bir şeyleri başka bir yolla değiştirip defter bırakmayan bir oturum yakalanmaz.
17. **Teslim kapısının kendi koruması tamamen ikinci derecedendir.** O bir `stop` hook'udur: oturum sonunda bir kez çalışır ve hiçbir araç çağrısını gözlemlemez, dolayısıyla kendisini kaldıran çağrıyı asla reddedemez. O çağrıyı reddeden her şey — dosyasına yapılan yüzey eşleşmesi ve `stop` kaydını düşüren bir düzenlemeyi reddeden sonuç testi — *preToolUse kendini koruma kapısında* yaşar. Önce o kapıyı alt edin (artık 7'nin kaçış sınıfları ya da artık 9'un yalın `.cursor`'ı) ve teslim kapısı hiçbir ek sürtünme olmadan düşer. Dosyasını root'a vermek burada artık 3'ün kabul ettiğinden daha az kazandırır: kayıt hiçbir kademede chown'lanmaz ve kayıttan düşürmek düzenlemekten ucuzdur. Sonradan bağlantı ekseni tarafından tespit edilir — ama yalnızca *bir sonraki* giriş noktasında ve tüm amacı durmak olan bir oturum hiç giriş noktası çalıştırmaz.
18. **Defter-yok denetiminin tasarım gereği tek-token'lık bir kaçışı vardır** — ne olduğu, neden orada olduğu ve neden ateşlenmek yerine denetim kaydı düştüğü için yukarıdaki teslim kapısı bölümüne bakın.
```bash
core/lock-kit.sh lock        # sudo varsa sertleştirir (root'a chown); yoksa yalnızca-chmod
                              # salt-okunur bit'ine düşer. `sudo -k` ile biter, böylece az önce
                              # önbelleklediği kimlik bilgisi parolasız bir yeniden açma penceresi bırakmaz.
core/lock-kit.sh status      # yol başına mod + SAHİP + yürürlükteki kademe
HEKTOR_FLAKYKIT_UNLOCK=1 core/lock-kit.sh unlock
```

## Elle hook kaydı (install.sh'i atlarsanız)
`.cursor/hooks.json` dosyasına ekleyin:

```json
{
  "hooks": {
    "beforeShellExecution": [
      { "command": ".cursor/hooks/flaky-kit-self-protection-gate.sh", "timeout": 10 }
    ],
    "preToolUse": [
      { "command": ".cursor/hooks/flaky-kit-self-protection-gate.sh", "timeout": 10 }
    ],
    "stop": [
      { "command": ".cursor/hooks/flaky-kit-delivery-gate.sh", "timeout": 20, "loop_limit": 1 }
    ]
  }
}
```

`.cursor/hooks/lib/cursor.sh` ve `.cursor/hooks/lib/audit.sh` dosyalarının mevcut olduğundan emin olun
— ikisi de install.sh tarafından vendor'lanır ve her kapı, onları yükleyemezse 0 ile çıkar (her şeye
izin verir).

## Burada ne var
```
core/         motor: ingest·cluster·rerun·apply·summary·compile·dom-capture / shell-guard·sanitize·lock-kit / config.json
skill/        SKILL.md — Cursor'ın yüklediği
gates/        kendini koruma + teslim kapıları ve vendor'ladıkları lib'ler
install.sh    kurucu (idempotent)
kernel.md · enforcement-codeowners.md    spesifikasyon + VCS katmanı sertleştirmesi
```

Spesifikasyon: [`kernel.md`](./kernel.md). Motor sözleşmeleri: `core/README.md`.
