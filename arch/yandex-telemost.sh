#!/bin/sh
# Запуск Яндекс Телемоста на системном Electron.
# Другая версия Electron: ELECTRON_BIN=electron33 yandex-telemost
export TELEMOST_LAUNCHER=/usr/bin/yandex-telemost
exec "${ELECTRON_BIN:-electron}" --class=yandex-telemost /usr/lib/yandex-telemost "$@"
