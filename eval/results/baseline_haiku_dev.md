# Haiku как детектор на dev (шаг 9, п. 2)

Тот же промпт, что eval/baseline_ai.js (дословно), один вызов на текст. Haiku = claude-haiku-5-5; Sonnet = claude-sonnet-5-5 из baseline_dev (один вызов, старый кэш). Выборка: AI dev от 400 знаков (116 из 120), founder 24, editorial 30. Без ответа Haiku: 0.
Правило REVIEW_2 для замены Sonnet на Haiku: AUC против founder >= 0,95 и AUC human >= 0,93.

| метрика | Haiku | Sonnet |
|---|---|---|
| AUC: AI против founder | 0.744 | 0.974 |
| AUC naive | 0.76 | 0.986 |
| AUC human | 0.727 | 0.963 |
| AUC: AI против editorial | 0.432 | 0.682 |
| AUC: editorial против founder | 0.766 | 0.955 |
| порог 30: пойман AI / ложных на founder / editorial отмечено | 114/116 / 15/24 / 30/30 | 110/116 / 2/24 / 26/30 |
| порог с ложными на founder <= 15% | порог 88: AI 8/116 (6.9%), ложных на founder 2/24 | порог 30: AI 110/116 (94.8%), ложных на founder 2/24 |
| средняя оценка AI / founder / editorial | 72.7 / 46.6 / 73.6 | 58.9 / 15.1 / 45.6 |

Совпадение стороны порога 30 у Haiku и Sonnet: 151 из 174.
Решение по правилу REVIEW_2: Haiku НЕ проходит, детектор остаётся Sonnet.
Расход 0.0109 $.
