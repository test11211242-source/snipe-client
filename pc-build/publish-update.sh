#!/bin/bash

set -e

# Загрузка переменных окружения из .env файла
if [ -f .env ]; then
    export $(cat .env | xargs)
fi

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# GitHub данные
GITHUB_USER="test11211242-source"
GITHUB_REPO="snipe-client"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

echo -e "${BLUE}╔════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Snipe Client - Публикация обновления    ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════╝${NC}"
echo ""

# Проверка аргумента версии
if [ -z "$1" ]; then
    # Получить текущую версию
    CURRENT_VERSION=$(node -p "require('./package.json').version")
    echo -e "${BLUE}→ Текущая версия: ${GREEN}$CURRENT_VERSION${NC}"
    echo ""
    
    # Разбить версию на части
    IFS='.' read -r -a VERSION_PARTS <<< "$CURRENT_VERSION"
    MAJOR=${VERSION_PARTS[0]}
    MINOR=${VERSION_PARTS[1]}
    PATCH=${VERSION_PARTS[2]}
    
    # Рассчитать варианты
    PATCH_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
    MINOR_VERSION="$MAJOR.$((MINOR + 1)).0"
    MAJOR_VERSION="$((MAJOR + 1)).0.0"
    
    # Показать меню
    echo -e "${YELLOW}Выберите тип обновления:${NC}"
    echo -e "  ${GREEN}[1]${NC} PATCH   (${CURRENT_VERSION} → ${PATCH_VERSION})  ${BLUE}- Багфиксы, мелкие исправления${NC}"
    echo -e "  ${GREEN}[2]${NC} MINOR   (${CURRENT_VERSION} → ${MINOR_VERSION})  ${BLUE}- Новые фичи${NC}"
    echo -e "  ${GREEN}[3]${NC} MAJOR   (${CURRENT_VERSION} → ${MAJOR_VERSION})  ${BLUE}- Большие изменения${NC}"
    echo ""
    
    # Читаем выбор
    read -p "Ваш выбор [1]: " VERSION_TYPE
    VERSION_TYPE=${VERSION_TYPE:-1}
    
    # Определяем новую версию
    case $VERSION_TYPE in
        1)
            NEW_VERSION=$PATCH_VERSION
            echo -e "${GREEN}→ Выбран PATCH: $NEW_VERSION${NC}"
            ;;
        2)
            NEW_VERSION=$MINOR_VERSION
            echo -e "${GREEN}→ Выбран MINOR: $NEW_VERSION${NC}"
            ;;
        3)
            NEW_VERSION=$MAJOR_VERSION
            echo -e "${GREEN}→ Выбран MAJOR: $NEW_VERSION${NC}"
            ;;
        *)
            echo -e "${RED}✗ Неверный выбор, используется PATCH${NC}"
            NEW_VERSION=$PATCH_VERSION
            VERSION_TYPE=1
            ;;
    esac
else
    NEW_VERSION=$1
    VERSION_TYPE="custom"
fi

# Валидация формата версии
if ! [[ $NEW_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo -e "${RED}✗ Неверный формат версии: $NEW_VERSION${NC}"
    echo -e "${YELLOW}Ожидается формат: MAJOR.MINOR.PATCH (например, 3.1.27)${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}→ Новая версия: ${GREEN}$NEW_VERSION${NC}"
echo ""

# Подтверждение
read -p "Продолжить публикацию версии $NEW_VERSION? (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}✗ Отменено${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Шаг 1/4: Коммит изменений в клиенте${NC}"
echo -e "${BLUE}════════════════════════════════════════════${NC}"

# Переход в корневую директорию репозитория
REPO_ROOT="/home/ubuntu/snipe"
SCRIPT_DIR="$(pwd)"
cd "$REPO_ROOT"

# Проверка наличия изменений ТОЛЬКО в pc-build/
CHANGED_FILES=$(git status --porcelain pc-build/app pc-build/package.json pc-build/package-lock.json 2>/dev/null)

if [ -n "$CHANGED_FILES" ]; then
    echo -e "${YELLOW}Найдены изменения для коммита:${NC}"
    echo "$CHANGED_FILES"
    echo ""
    
    # Добавляем только файлы клиента
    git add pc-build/app/ pc-build/package.json pc-build/package-lock.json
    
    # Определяем тип коммита на основе типа версии
    if [ "$VERSION_TYPE" = "1" ]; then
        COMMIT_TYPE="fix"
        COMMIT_DESC="Bug fixes and minor improvements"
    elif [ "$VERSION_TYPE" = "2" ]; then
        COMMIT_TYPE="feat"
        COMMIT_DESC="New features"
    elif [ "$VERSION_TYPE" = "3" ]; then
        COMMIT_TYPE="feat"
        COMMIT_DESC="Major update with breaking changes"
    else
        COMMIT_TYPE="release"
        COMMIT_DESC="Release"
    fi
    
    # Коммитим
    git commit -m "$COMMIT_TYPE: release version $NEW_VERSION

$COMMIT_DESC"
    
    # Пушим в main
    git push https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${GITHUB_REPO}.git main
    
    echo -e "${GREEN}✓ Изменения загружены на GitHub${NC}"
else
    echo -e "${RED}✗ Нет изменений для коммита${NC}"
    echo -e "${RED}✗ Сборка отменена. Сначала внесите изменения в код.${NC}"
    exit 1
fi

# Возвращаемся в pc-build/
cd "$SCRIPT_DIR"
echo ""

echo -e "${BLUE}════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Шаг 2/4: Запуск GitHub Actions${NC}"
echo -e "${BLUE}════════════════════════════════════════════${NC}"

# Запуск workflow через GitHub API
RESPONSE=$(curl -s -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/actions/workflows/build-and-publish.yml/dispatches \
  -d "{\"ref\":\"main\",\"inputs\":{\"version\":\"$NEW_VERSION\"}}")

if [ -z "$RESPONSE" ]; then
    echo -e "${GREEN}✓ Сборка запущена на GitHub Actions${NC}"
else
    echo -e "${YELLOW}⚠ Возможная ошибка: $RESPONSE${NC}"
fi
echo ""

echo -e "${BLUE}════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Шаг 3/4: Ожидание сборки${NC}"
echo -e "${BLUE}════════════════════════════════════════════${NC}"

echo -e "${YELLOW}Сборка запущена на GitHub Actions...${NC}"
echo -e "${BLUE}→ Следить за процессом: ${NC}https://github.com/${GITHUB_USER}/${GITHUB_REPO}/actions"
echo ""

# Ждем 10 секунд и начинаем проверять статус
sleep 10

echo -e "${YELLOW}Проверяем статус сборки...${NC}"

for i in {1..60}; do
    # Получаем последний запуск workflow
    RUN_STATUS=$(curl -s \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/actions/runs?per_page=1" \
      | grep -o '"status": "[^"]*"' | head -1 | cut -d'"' -f4)

    CONCLUSION=$(curl -s \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/actions/runs?per_page=1" \
      | grep -o '"conclusion": "[^"]*"' | head -1 | cut -d'"' -f4)

    if [ "$RUN_STATUS" = "completed" ]; then
        if [ "$CONCLUSION" = "success" ]; then
            echo ""
            echo -e "${GREEN}✓ Сборка завершена успешно!${NC}"
            break
        else
            echo ""
            echo -e "${RED}✗ Сборка завершилась с ошибкой: $CONCLUSION${NC}"
            exit 1
        fi
    fi

    echo -ne "${YELLOW}Статус: $RUN_STATUS ... ($i/60)\r${NC}"
    sleep 10
done

echo ""
echo ""
echo -e "${BLUE}════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Шаг 4/4: Проверка файлов на сервере${NC}"
echo -e "${BLUE}════════════════════════════════════════════${NC}"

sleep 5

# Проверяем что файлы появились
if [ -f "/home/ubuntu/snipe/data/updates/downloads/Snipe_Client_Setup_${NEW_VERSION}.exe" ]; then
    FILE_SIZE=$(ls -lh "/home/ubuntu/snipe/data/updates/downloads/Snipe_Client_Setup_${NEW_VERSION}.exe" | awk '{print $5}')
    echo -e "${GREEN}✓ Установщик: Snipe_Client_Setup_${NEW_VERSION}.exe ($FILE_SIZE)${NC}"
else
    echo -e "${RED}✗ Установщик не найден!${NC}"
fi

if [ -f "/home/ubuntu/snipe/data/updates/downloads/latest.yml" ]; then
    echo -e "${GREEN}✓ Файл latest.yml обновлен${NC}"
    echo ""
    cat /home/ubuntu/snipe/data/updates/downloads/latest.yml | grep "version:" | head -1
else
    echo -e "${RED}✗ latest.yml не найден!${NC}"
fi

# Проверяем versions.json
LATEST=$(cat /home/ubuntu/snipe/data/updates/versions.json 2>/dev/null | grep -o '"latest_version":"[^"]*"' | cut -d'"' -f4)
if [ "$LATEST" = "$NEW_VERSION" ]; then
    echo -e "${GREEN}✓ versions.json обновлен: $LATEST${NC}"
else
    echo -e "${YELLOW}⚠ versions.json: $LATEST (ожидалось $NEW_VERSION)${NC}"
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         🎉 ПУБЛИКАЦИЯ ЗАВЕРШЕНА! 🎉        ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}Версия: ${GREEN}$NEW_VERSION${NC}"
echo -e "${BLUE}URL обновления: ${NC}http://130.61.118.215:8000/api/app/updates/latest.yml"
echo ""
echo -e "${YELLOW}Клиенты получат обновление автоматически!${NC}"
echo ""
