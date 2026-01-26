# ASR Dashboard

## Установка

```bash
git clone https://github.com/kresherzo/Ui-dashboard.git
cd Ui-dashboard
```

## Настройка

Отредактировать `.env`:

```bash
nano .env
```

Указать адрес Redis:

```
REDIS_HOST=192.168.1.100
REDIS_PORT=6379
```

## Запуск

```bash
docker-compose up -d --build
```

Открыть: http://localhost:3000

## Остановка

```bash
docker-compose down
```

## Логи

```bash
docker logs asr-backend
docker logs asr-frontend
```

## Проверка подключения к Redis

```bash
redis-cli -h 192.168.1.100 -p 6379 ping
```
