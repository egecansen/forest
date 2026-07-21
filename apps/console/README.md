# şahika

**şahika**, sahibinden'in otonom QA süreci konsoludur: bir projeyi ve hedef URL'yi gösterin; iskele, hazırlık, mutlu yol, haritalama, kapsam, hata keşfi, gizlilik taraması ve rapor olmak üzere sekiz fazlı hattı uçtan uca yürütür, ilerlemeyi terminal görünümlü arayüze akıtır.

Konsolun sundukları:

- Koşum yapılandırması için **başlangıç ekranı**: proje yolu, hedef URL, mod, koşum derinliği ve izin politikası.
- Canlı log, faz zaman çizelgesi, bulgular, dosyalar, akışlar ve rapor sekmeleriyle **koşum görünümü**; ayrıca koşum telemetrisi (geçen süre, token, maliyet tahmini).
- **Koşum geçmişi** - geçmiş koşumlar `~/.sahika-gui/runs` altında saklanır ve  
*recent runs* menüsünden salt okunur olarak yeniden açılır.

Bu derlemede koşum yürütmesi, hattın tamamını uçtan uca çalıştıran dahili simülasyon katmanı üzerinden gerçekleşir.

## Çalıştırma

```bash
npm run install:all   # kök, client ve server bağımlılıklarını kurar
npm run dev           # server :8765, Vite geliştirme sunucusu :5173
```

`http://localhost:5173` adresini açın, **use demo values**'a ve ardından
**run demo**'ya tıklayın.

## Yapı

```
client/   Vite + React + TypeScript ön yüz (konsol arayüzü)
server/   Express + ws arka uç (koşu yaşam döngüsü, simülasyon katmanı, geçmiş)
```



## Testler

```bash
npm --prefix client test
npm --prefix server test
```



## Üretim derlemesi

```bash
npm run build && npm start
```

Sunucu, derlenen istemciyi `client/dist` üzerinden sunar.