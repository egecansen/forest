#!/usr/bin/env python3
"""
TDK Sözlük API aracılığıyla kelime kontrolü.

Kullanım:
    python3 tdk_kontrol.py yazim <kelime>        # Yazım Kılavuzu kontrolü
    python3 tdk_kontrol.py anlam <kelime>         # Güncel Türkçe Sözlük (anlam)
    python3 tdk_kontrol.py deyim <kelime>         # Atasözleri ve Deyimler
    python3 tdk_kontrol.py kontrol <kelime1> <kelime2> ...  # Toplu yazım kontrolü

API Endpoints:
    - Yazım Kılavuzu:  https://sozluk.gov.tr/yazim?ara=KELIME
    - GTS (Anlam):      https://sozluk.gov.tr/gts?ara=KELIME
    - Atasözü/Deyim:    https://sozluk.gov.tr/atasozu?ara=KELIME
"""

# PEP 604 unions (`dict | list | None`) are evaluated at def-time on Python < 3.10.
# This defers annotation evaluation so the script runs on 3.7+ — macOS still ships
# 3.9, where the annotation on tdk_fetch otherwise raises TypeError at import.
from __future__ import annotations

import json
import sys
import urllib.request
import urllib.parse


BASE_URL = "https://sozluk.gov.tr"


def tdk_fetch(endpoint: str, kelime: str) -> dict | list | None:
    """TDK API'ye istek gönderir."""
    encoded = urllib.parse.quote(kelime, safe="")
    url = f"{BASE_URL}/{endpoint}?ara={encoded}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8").strip())
            if isinstance(data, dict) and "error" in data:
                return None
            return data
    except Exception as e:
        print(f"HATA: {e}", file=sys.stderr)
        return None


def yazim_kontrol(kelime: str) -> dict:
    """
    Yazım Kılavuzu'nda kelimeyi arar.
    Döndürdüğü dict:
      - bulundu: bool
      - sonuclar: list[dict] (her biri: dogru_yazim, ekler)
    """
    result = tdk_fetch("yazim", kelime)
    if not result:
        return {"bulundu": False, "kelime": kelime, "sonuclar": []}

    sonuclar = []
    for entry in result:
        sonuclar.append({
            "dogru_yazim": entry.get("sozu", "").strip(),
            "ekler": entry.get("ekler", "").strip() or None,
        })

    return {"bulundu": True, "kelime": kelime, "sonuclar": sonuclar}


def anlam_getir(kelime: str) -> dict:
    """
    Güncel Türkçe Sözlük'te kelimeyi arar.
    Döndürdüğü dict:
      - bulundu: bool
      - madde: str
      - lisan: str (köken bilgisi)
      - anlamlar: list[str]
    """
    result = tdk_fetch("gts", kelime)
    if not result:
        return {"bulundu": False, "kelime": kelime}

    entry = result[0]
    anlamlar = []
    for a in entry.get("anlamlarListe", []):
        anlam_text = a.get("anlam", "")
        # HTML temizle
        anlam_text = anlam_text.replace("<p>", "").replace("</p>", "").strip()
        anlamlar.append(anlam_text)

    return {
        "bulundu": True,
        "kelime": kelime,
        "madde": entry.get("madde", ""),
        "lisan": entry.get("lisan", ""),
        "anlamlar": anlamlar,
    }


def deyim_ara(kelime: str) -> dict:
    """
    Atasözleri ve Deyimler Sözlüğü'nde arar.
    Döndürdüğü dict:
      - bulundu: bool
      - sonuclar: list[dict] (sozum, anlami, tur)
    """
    result = tdk_fetch("atasozu", kelime)
    if not result:
        return {"bulundu": False, "kelime": kelime, "sonuclar": []}

    sonuclar = []
    for entry in result:
        sonuclar.append({
            "sozum": entry.get("sozum", ""),
            "anlami": entry.get("anlami", "").replace("<i>", "").replace("</i>", ""),
            "tur": entry.get("turu2", ""),
        })

    return {"bulundu": True, "kelime": kelime, "sonuclar": sonuclar}


def toplu_yazim_kontrol(kelimeler: list[str]) -> list[dict]:
    """Birden fazla kelimeyi yazım kılavuzunda kontrol eder."""
    sonuclar = []
    for k in kelimeler:
        r = yazim_kontrol(k)
        sonuclar.append(r)
    return sonuclar


def format_yazim(result: dict) -> str:
    """Yazım sonucunu okunabilir biçimde formatlar."""
    if not result["bulundu"]:
        return f"  ❌ '{result['kelime']}' → TDK Yazım Kılavuzu'nda bulunamadı"

    lines = []
    for s in result["sonuclar"]:
        line = f"  ✅ '{result['kelime']}' → {s['dogru_yazim']}"
        if s["ekler"]:
            line += f"  ({s['ekler']})"
        lines.append(line)
    return "\n".join(lines)


def format_anlam(result: dict) -> str:
    """Anlam sonucunu okunabilir biçimde formatlar."""
    if not result["bulundu"]:
        return f"  ❌ '{result['kelime']}' → GTS'de bulunamadı"

    lines = [f"  ✅ {result['madde']}  [{result.get('lisan', '')}]"]
    for i, a in enumerate(result.get("anlamlar", []), 1):
        lines.append(f"     {i}. {a}")
    return "\n".join(lines)


def format_deyim(result: dict) -> str:
    """Deyim sonucunu okunabilir biçimde formatlar."""
    if not result["bulundu"]:
        return f"  ❌ '{result['kelime']}' → Atasözleri/Deyimler'de bulunamadı"

    lines = []
    for s in result.get("sonuclar", []):
        lines.append(f"  ✅ [{s['tur']}] {s['sozum']}: {s['anlami'][:120]}")
    return "\n".join(lines)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    args = sys.argv[2:]

    if cmd == "yazim":
        r = yazim_kontrol(args[0])
        print(format_yazim(r))

    elif cmd == "anlam":
        r = anlam_getir(args[0])
        print(format_anlam(r))

    elif cmd == "deyim":
        query = " ".join(args)
        r = deyim_ara(query)
        print(format_deyim(r))

    elif cmd == "kontrol":
        sonuclar = toplu_yazim_kontrol(args)
        for s in sonuclar:
            print(format_yazim(s))

    else:
        print(f"Bilinmeyen komut: {cmd}")
        print(__doc__)
        sys.exit(1)
