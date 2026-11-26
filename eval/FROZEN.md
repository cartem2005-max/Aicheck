# FROZEN: заморозка перед запуском на test (шаг 8)

Время: 2026-11-25T18:39:30.882Z (UTC); локально Wed Nov 25 2026 23:39:30 GMT+0500

После этой записи файлы ниже не меняются. Test открывается один раз (eval/run_test.js, eval/fix_eval.js). Если после запуска найден баг, чиним, пишем в STATUS.md и в результаты обе цифры (до и после починки).

- Порог линтера: 15 (scale 10, maxPerRule 2, minLength 400)
- Детектор: только линтер (8 правил с весом); LLM-судьи для детекции нет
- Модель переписывания: gpt-6.1-terra, запасная claude-sonnet-5-5; промпт rewrite v2, длина +15% / −25%, до 2 кругов
- Оценщик слепого A/B и базового уровня (г): claude-sonnet-5-5, effort low; порог базового уровня 30 (выбран на dev, eval/results/baseline_dev.json)
- Зерно A/B на dev 8001/8002, на test 8003/8004

| файл | sha256 |
|---|---|
| src/rules.json | c08a03ab37595ccab6409913ed0f1a1937ccf984cff927751d03d2ab75b3414e |
| src/linter.js | 173a6f022655191fd8d6c7cbf67fd0f91bec8465d96fc37dffd2f59a58a01585 |
| src/detectors.js | f26f6b561e1a4f100cb0e4205b779229792d672cfae597e65453c9f1a6ebaecb |
| src/textparse.js | 1e5ca3fc391bb3bc71a1e55674b180f6ae9ef46f8e4e0e8355d91532945d7801 |
| src/autofix.js | 931f06b69587e9a335cc9b172b3b673ad13c1702cfac098a23e4ebeb3aef8257 |
| src/facts.js | 63e97147af9eff04fc1228f0502467af0bcf3953230bae8202dceb4f06328f86 |
| src/facts_words.js | 0443216ea37cdff339e7eaf8a9764a700b13b66a5431cc50f1d4eff040d7c781 |
| src/rewrite.js | 5c615b267f3f063dedd8b5d11af1d66562a643c89d4fa07c44ddf75ecd9123fb |
| src/samples.js | 9469a01c45e443dcabfc3210f9ca0a338ca71c8d7807d6f44b84414a79b34237 |
| src/worn.js | 0f9484bfbebe37698f80b027c79bcf152023d39dd8ef9768816ea05071ccf568 |
| src/prompts/brief.md | 23bb4088c2d8acd93496ef8f15b6459af183a100bb2bf8aff4e2c48495fe16e4 |
| src/prompts/gen_human.md | b454b9d788e3c04b72b470c1d86b6267a36e13870e59dd264e9cda62a0364804 |
| src/prompts/gen_naive.md | dbebbbfc1bf4d2c99fd012a24e1b4374100025e9a3f33e6ccec607a6f45b339c |
| src/prompts/rewrite.md | 1c20cc2b4c81fb770903b556a6c913a79a95bf8f83dbfa114c55c92510670963 |
| src/prompts/voice.md | 4611aec63d6dd11ac57a4c2fd0663b1bc9695d2ac280409e2e353b6cb9e8f79f |
| eval/ab_judge.js | 3b46535ce088597d95a7fcbf3c64f279bdc507d14579fc843321bc2cafea3264 |
| eval/baseline_ai.js | 8a302ec0ae444929485416a859eddf92316056535733f8337bd1a124427805f7 |
