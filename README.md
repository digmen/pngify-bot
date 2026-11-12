# Pngify — документы в PNG прямо в Telegram

Telegram-бот [@PngifyBot](https://t.me/PngifyBot). Присылаешь презентацию, документ, таблицу или PDF и получаешь каждую страницу или слайд отдельной PNG-картинкой либо одним ZIP-архивом.

Бот работает на своём сервере, без внешних сервисов конвертации. Файлы удаляются сразу после отправки.

## Что умеет

- **Форматы:** PowerPoint (`pptx`, `ppt`, `ppsx`), Word (`docx`, `doc`, `rtf`, `txt`), Excel (`xlsx`, `xls`, `csv`), PDF, OpenDocument (`odp`, `odt`, `ods`, `odg`), Keynote, Pages, Numbers, Visio.
- **Качество:** обычное (150 dpi, слайд 16:9 выходит шириной 2000 px) или чёткое (300 dpi).
- **Как прислать:** картинками без сжатия (файлами, пачками по 10) или одним ZIP. Внутри архива файлы с понятными русскими именами: `Отчёт-01.png`, `Отчёт-02.png`…
- **Живая карточка.** На каждый файл приходит HTML-виджет Telegram: значок формата, размер, переключатель качества, кнопки «Картинками» и «ZIP-архивом». Потом в той же карточке видно очередь, полосу прогресса («Рисую страницы 7 из 12») и итог.
- **Запасной путь.** Если клиент не показывает виджеты, работают кнопки обычного сообщения и команды `/png` и `/zip`.

## Как это устроено

```
файл ─► карточка-виджет (sendWidget) ─► выбор в карточке (widget_query)
     ─► очередь «по одной» ─► скачивание ─► LibreOffice → PDF ─► pdftoppm → PNG
     ─► отправка картинками или ZIP ─► карточка «Готово» ─► папка задачи удаляется
```

| Часть | Файл |
|---|---|
| Запуск бота, приём файлов, задачи | `src/index.ts` |
| Карточка-виджет: HTML, состояние, подписи | `src/widget.ts` |
| Отправка и обновление карточки (виджет или текст) | `src/cards.ts` |
| LibreOffice, pdftoppm, ZIP, песочница | `src/convert.ts` |
| Очередь «по одной» | `src/queue.ts` |
| Форматы, имена файлов | `src/formats.ts` |
| Настройки из окружения | `src/config.ts` |

### Виджеты Telegram (Bot API 10.4)

Карточка — это [HTML-виджет](https://core.telegram.org/bots/widgets): код неизменен после отправки, меняется только состояние (`chat_data`, JSON до 1024 байт), и пишет его бот через `editMessageWidgetData`. Кнопки в карточке шлют боту запрос `go:<png|zip>:<0|1>`, он приходит как `widget_query`, бот отвечает `answerWidgetQuery`.

Ограничения Telegram, под которые сделана карточка:

- HTML до 32 КБ и до 4 КБ после сжатия zlib. Сейчас карточка занимает ~4 КБ, сжатая ~1,9 КБ, это проверяет тест.
- В виджете нет сети, поэтому превью картинок в карточку не встроить: PNG приходят отдельными сообщениями.
- Пока виджеты работают только в личке с ботом и не пересылаются.
- Запросов из виджета не больше 5 за 5 секунд на пользователя. Обновления карточки бот сам сжимает до одного раза в 1,5 секунды.

### Безопасность

Чужие документы открываются так:

- **Песочница bubblewrap:** у LibreOffice и pdftoppm нет сети (документ не может ничего скачать по ссылке внутри), вся файловая система только на чтение, кроме папки задачи, свой `/tmp`, процессы убиваются вместе с ботом.
- **Отдельный пользователь `pngify`**, не root.
- **Потолок ресурсов systemd:** память до 1,5 ГБ, процессор до 2 ядер, `nice 10`. Сервер общий с другими ботами, и тяжёлый файл не должен их задеть.
- **Очередь «по одной»**, таймаут 120 с на открытие файла.
- **Файлы не хранятся:** документ скачивается, только когда до него дошла очередь, а папка задачи удаляется сразу после отправки (и при старте бота, если он упал посреди задачи).

## Лимиты

| | Все | Владелец (`OWNER_ID`) |
|---|---|---|
| Размер файла | 20 МБ (предел Bot API для скачивания) | 20 МБ |
| Страниц | 60 | 500 |
| ZIP | до 50 МБ, иначе бот шлёт картинками | то же |

## Запуск

Нужны Node.js 22+, а на сервере ещё:

```bash
apt-get install --no-install-recommends \
  libreoffice-core-nogui libreoffice-writer-nogui libreoffice-impress-nogui \
  libreoffice-calc-nogui libreoffice-draw-nogui poppler-utils bubblewrap \
  fonts-dejavu-core fonts-liberation fonts-liberation2 \
  fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core
```

Шрифты Carlito и Caladea совпадают по метрикам с Calibri и Cambria, а Liberation — с Arial и Times New Roman. Поэтому вёрстка документов из Office не съезжает.

На Ubuntu 24.04 bubblewrap нужен профиль AppArmor, иначе он не может отключить сеть (`kernel.apparmor_restrict_unprivileged_userns = 1`):

```
# /etc/apparmor.d/bwrap-pngify
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
```

Настройки — в `.env.example`. На сервере они лежат в `/etc/pngify-bot.env` (права 600).

```bash
npm install
npm test          # 12 тестов: пределы виджета, имена, очередь
npm run typecheck
npm start         # локально: SANDBOX=0 в .env, если нет bubblewrap
```

Выкладка: `PNGIFY_HOST=root@<сервер> deploy/deploy.sh`. Скрипт проверяет типы и тесты, копирует код через rsync (секреты не копируются), ставит службу `deploy/pngify-bot.service` и перезапускает её.

## Стек

TypeScript · [grammY](https://grammy.dev) · LibreOffice (headless) · Poppler (`pdftoppm`) · bubblewrap · systemd
