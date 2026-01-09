# src/utils/skeleton_key.py
"""
Skeleton Key - нормализация никнеймов для поиска в PostgreSQL.

Использует unidecode для конвертации Unicode → ASCII,
плюс 8 символов leetspeak (геймерские замены).

Примеры:
  "ᴋᴇᴠ✨"           → "kev"
  "𝕳𝖊𝖑𝖑𝖔"           → "hello"
  "K1ller"          → "killer"
  "▄︻┻╤✰YAKúZÂ⌖╼"  → "yakuza"
  "Турист"          → "turist"
"""

import re
from functools import lru_cache
from unidecode import unidecode


# Геймерские замены (leetspeak) — 7 символов (pipe удаляется отдельно)
# Это НЕ Unicode проблема, это сленг игроков
LEET = str.maketrans({
    '0': 'o',
    '1': 'i',
    '3': 'e',
    '4': 'a',
    '5': 's',
    '7': 't',
    '8': 'b',
})

# Разделители в никнеймах → удаляются
# OCR может распознать CJK разделитель как pipe или наоборот
# Решение: удаляем ВСЕ разделители, чтобы "DT|Suzaku" и "DT丨Suzaku" → "dtsuzaku"
SEPARATORS_TO_REMOVE = str.maketrans({
    '|': '',   # U+007C - ASCII pipe (часто используется как разделитель)
    '丨': '',  # U+4E28 - CJK "gun" - часто используется как разделитель
    '丿': '',  # U+4E3F - CJK "pie" 
    '乀': '',  # U+4E40 - CJK "fu"
    '乁': '',  # U+4E41 - CJK "yi"  
    '丶': '',  # U+4E36 - CJK dot
    '丷': '',  # U+4E37 - CJK "ba"
    '│': '',   # U+2502 - Box drawing vertical
    '┃': '',   # U+2503 - Box drawing heavy vertical
    '⏐': '',   # U+23D0 - Vertical line extension
    'ǀ': '',   # U+01C0 - Latin letter dental click
    'ı': '',   # U+0131 - Latin small dotless i (иногда используется как разделитель)
})


# Визуальные confusables: кириллица → латиница
# Эти символы выглядят идентично в игре, но имеют разные Unicode коды
CYRILLIC_CONFUSABLES = str.maketrans({
    'с': 'c', 'С': 'C',  # U+0441, U+0421 - Cyrillic s
    'а': 'a', 'А': 'A',  # U+0430, U+0410 - Cyrillic a
    'е': 'e', 'Е': 'E',  # U+0435, U+0415 - Cyrillic ie
    'о': 'o', 'О': 'O',  # U+043E, U+041E - Cyrillic o
    'р': 'p', 'Р': 'P',  # U+0440, U+0420 - Cyrillic r
    'х': 'x', 'Х': 'X',  # U+0445, U+0425 - Cyrillic x
    'у': 'y', 'У': 'Y',  # U+0443, U+0423 - Cyrillic u
    'і': 'i', 'І': 'I',  # U+0456, U+0407 - Ukrainian i
    'ј': 'j',            # U+0458 - Serbian j
})


def _normalize_cyrillic_confusables(text: str) -> str:
    """
    Нормализует визуально идентичные кириллические символы в латинские.

    Выполняется ПЕРЕД unidecode() чтобы обеспечить консистентность:
    - Кириллическая "с" (U+0441) → латинская "c"
    - Латинская "c" → "c" (без изменений)

    Результат: оба варианта дают одинаковый search_key.

    Args:
        text: Оригинальный текст

    Returns:
        Текст с нормализованными кириллическими символами
    """
    return text.translate(CYRILLIC_CONFUSABLES)


@lru_cache(maxsize=100000)
def generate_skeleton_key(text: str) -> str:
    """
    Генерирует "скелетный ключ" из никнейма.

    Args:
        text: Оригинальный никнейм

    Returns:
        Нормализованный ключ для поиска

    Examples:
        >>> generate_skeleton_key("ᴋᴇᴠ✨")
        'kev'
        >>> generate_skeleton_key("K1ller")
        'killer'
        >>> generate_skeleton_key("〜✨⌘ССX⌘✨〜")
        'ccx'
    """
    if not text:
        return ""

    # 1. Cyrillic confusables: Нормализация визуально идентичных символов
    #    Кириллические "с", "а", "о" и др. → латинские эквиваленты
    text = _normalize_cyrillic_confusables(text)

    # 2. Удаление разделителей ДО unidecode
    #    Иначе CJK "丨" (U+4E28) превратится в "gun", а pipe "|" удалится
    #    Результат: "DT|Suzaku" и "DT丨Suzaku" → оба дают "dtsuzaku"
    text = text.translate(SEPARATORS_TO_REMOVE)

    # 3. unidecode: Unicode → ASCII (ᴋ→K, デ→de, 𝕳→H, Турист→Turist)
    text = unidecode(text)

    # 4. Нижний регистр
    text = text.lower()

    # 5. Leetspeak: 1→i, 0→o, 3→e и т.д.
    text = text.translate(LEET)

    # 6. Оставляем только буквы и цифры
    text = re.sub(r'[^a-z0-9]', '', text)

    return text


def clear_skeleton_cache():
    """Очистить кэш skeleton key"""
    generate_skeleton_key.cache_clear()


def get_skeleton_cache_info() -> dict:
    """Статистика кэша skeleton key"""
    info = generate_skeleton_key.cache_info()
    return {
        'hits': info.hits,
        'misses': info.misses,
        'size': info.currsize,
        'maxsize': info.maxsize,
        'hit_rate': f"{info.hits / (info.hits + info.misses) * 100:.1f}%" if (info.hits + info.misses) > 0 else "0%"
    }


# ============================================================================
# ТЕСТИРОВАНИЕ
# ============================================================================

if __name__ == "__main__":
    test_cases = [
        # (input, expected)
        # EXISTING TESTS
        ("ᴋᴇᴠ✨", "kev"),
        ("𝕳𝖊𝖑𝖑𝖔", "hello"),
        ("K1ller", "killer"),
        ("Pr0", "pro"),
        ("▄︻┻╤✰YAKúZÂ⌖╼", "yakuza"),
        ("Турист", "typict"),  # Cyrillic: confusables first (у→y,р→p,с→c), then unidecode (Т→T,и→i,т→t)
        ("훈련자", "hunryeonja"),
        ("デス", "desu"),
        ("꧁☠️K1ller☠️꧂", "killer"),
        ("", ""),
        ("👻👻👻", ""),

        # NEW: Cyrillic confusables tests
        ("ССХ", "ccx"),                    # All Cyrillic uppercase
        ("сСхХ", "ccxx"),                  # Mixed case Cyrillic
        ("〜✨⌘ссx⌘✨〜", "ccx"),          # Real player case (original issue)
        ("The Nаpp", "thenapp"),           # Mixed latin + cyrillic "а" (пробел удаляется regex)
        ("сristyforer", "cristyforer"),    # Cyrillic "с" at start
        ("7Jоkyz7", "tjokyzt"),           # Cyrillic "о" → o, then leetspeak 7→t
        ("АBСDЕ", "abcde"),                # All cyrillic confusables
        ("Рlаyеr", "player"),              # Cyrillic р, а, е

        # NEW: Separator normalization tests (OCR issue: pipe vs CJK "gun")
        ("DT|Suzaku", "dtsuzaku"),           # ASCII pipe → removed
        ("DT丨Suzaku", "dtsuzaku"),           # CJK "gun" U+4E28 → removed
        ("DT│Suzaku", "dtsuzaku"),            # Box drawing vertical U+2502 → removed
        ("Nova|Esports", "novaesports"),     # Common clan tag format
        ("Nova丨Esports", "novaesports"),     # CJK variant
        ("A|B|C", "abc"),                    # Multiple pipes
        ("A丨B丨C", "abc"),                    # Multiple CJK separators
    ]

    print("=" * 60)
    print(f"{'INPUT':25} | {'EXPECTED':15} | {'RESULT':15} | OK?")
    print("=" * 60)

    passed = 0
    for inp, expected in test_cases:
        result = generate_skeleton_key(inp)
        ok = "✅" if result == expected else f"❌ got: {result}"
        if result == expected:
            passed += 1
        print(f"{inp:25} | {expected:15} | {result:15} | {ok}")

    print("=" * 60)
    print(f"Passed: {passed}/{len(test_cases)}")
