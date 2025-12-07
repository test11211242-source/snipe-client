# Настройка GitHub Actions для сборки Snipe Client

## 1. Создать GitHub репозиторий

1. Зайдите на https://github.com
2. Создайте новый репозиторий (например `snipe-client`)
3. **НЕ** инициализируйте с README/LICENSE

## 2. Настроить SSH ключ для доступа к серверу

### На сервере:

```bash
# Создайте SSH ключ (если еще нет)
ssh-keygen -t ed25519 -C "github-actions" -f ~/.ssh/github_actions_key -N ""

# Добавьте публичный ключ в authorized_keys
cat ~/.ssh/github_actions_key.pub >> ~/.ssh/authorized_keys

# Скопируйте ПРИВАТНЫЙ ключ (понадобится для GitHub Secrets)
cat ~/.ssh/github_actions_key
```

**ВАЖНО:** Скопируйте весь вывод приватного ключа, включая:
```
-----BEGIN OPENSSH PRIVATE KEY-----
...
-----END OPENSSH PRIVATE KEY-----
```

## 3. Настроить GitHub Secrets

1. Перейдите в Settings → Secrets and variables → Actions
2. Добавьте три секрета (New repository secret):

### **SSH_PRIVATE_KEY**
```
-----BEGIN OPENSSH PRIVATE KEY-----
(вставьте приватный ключ из предыдущего шага)
-----END OPENSSH PRIVATE KEY-----
```

### **SERVER_HOST**
```
130.61.118.215
```

### **SERVER_USER**
```
ubuntu
```

## 4. Загрузить код на GitHub

```bash
cd /home/ubuntu/snipe/pc-build

# Добавить remote
git remote add origin https://github.com/ВАШ_USERNAME/snipe-client.git

# Первый коммит
git add .
git commit -m "Initial commit with auto-update system"

# Загрузить на GitHub
git branch -M main
git push -u origin main
```

## 5. Запустить сборку

1. Перейдите в GitHub: **Actions** → **Build and Publish Snipe Client**
2. Нажмите **Run workflow**
3. Введите версию (например `3.1.21`)
4. Нажмите **Run workflow**

## Что происходит при сборке:

1. ✅ GitHub запускает Windows сервер
2. ✅ Устанавливает зависимости
3. ✅ Собирает NSIS установщик (.exe)
4. ✅ Создает latest.yml с SHA512 хешем
5. ✅ Загружает файлы на сервер по SSH
6. ✅ Обновляет versions.json
7. ✅ Клиенты получают обновление!

## Как обновить версию в будущем:

1. Измените код в `pc-build/app/`
2. Закоммитьте изменения:
   ```bash
   git add .
   git commit -m "Update: описание изменений"
   git push
   ```
3. Запустите workflow через GitHub Actions с новой версией

## Структура после сборки:

```
/home/ubuntu/snipe/data/updates/downloads/
├── Snipe_Client_Setup_3.1.20.exe
├── Snipe_Client_Setup_3.1.21.exe  ← новая версия
└── latest.yml                      ← указывает на последнюю версию

/home/ubuntu/snipe/data/updates/
└── versions.json                   ← история всех версий
```

## Проверка работы:

```bash
# На сервере проверьте файлы
ls -lh /home/ubuntu/snipe/data/updates/downloads/

# Проверьте latest.yml
cat /home/ubuntu/snipe/data/updates/downloads/latest.yml

# Проверьте versions.json
cat /home/ubuntu/snipe/data/updates/versions.json
```

## Устранение проблем:

### Ошибка SSH подключения:
- Проверьте что SSH_PRIVATE_KEY содержит правильный ключ
- Проверьте что SERVER_HOST и SERVER_USER правильные
- Проверьте что публичный ключ добавлен в ~/.ssh/authorized_keys на сервере

### Сборка падает:
- Проверьте логи в GitHub Actions
- Убедитесь что package.json имеет правильную структуру

### Клиенты не получают обновление:
- Проверьте что latest.yml доступен: http://130.61.118.215:8000/api/app/updates/latest.yml
- Проверьте что файл .exe загружен на сервер
- Проверьте логи приложения на клиенте (%USERPROFILE%\AppData\Roaming\Snipe Client\logs\)

---

**Готово!** Теперь вы можете собирать Windows приложение на GitHub Actions и автоматически публиковать обновления для клиентов.
