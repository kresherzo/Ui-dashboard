#!/usr/bin/env python3
"""
Mock ASR Module - Заглушка для тестирования дашборда
Имитирует работу настоящего ASR модуля:
- Принимает те же аргументы что и реальный ASR
- Случайно выбирает токены из существующих в Redis
- Увеличивает их счётчики
- Записывает в stream для Live Feed
"""

import redis
import time
import random
import os
import sys
import signal
import json
import argparse
from datetime import datetime

# Настройки из ENV
REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PORT = int(os.getenv("REDIS_PORT", 6379))
CONTAINER_NAME = os.getenv("CONTAINER_NAME", "mock-asr")

# Интервал между "детекциями" (секунды)
MIN_INTERVAL = 2
MAX_INTERVAL = 5

# Флаг для graceful shutdown
running = True

def signal_handler(sig, frame):
    global running
    print(f"\n[{CONTAINER_NAME}] Получен сигнал остановки, завершаю...")
    running = False

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


def parse_args():
    """Парсинг аргументов - совместимо с реальным ASR модулем"""
    parser = argparse.ArgumentParser(description='Mock ASR Module - имитация для тестирования')
    
    # Позиционный аргумент - URL стрима
    parser.add_argument('input', type=str, nargs='?', default='https://mock-stream.example.com',
                        help='URL of the audio stream (ignored in mock, just logged)')
    
    # Основные аргументы как у реального ASR
    parser.add_argument('--words', type=str, default='tokens/mock.csv',
                        help='Path to CSV with words, counts, tokens')
    parser.add_argument('--reference', type=str, default='mock',
                        help='Reference voice filename(s)')
    parser.add_argument('--similarity_threshold', type=float, default=0.70,
                        help='Similarity threshold (ignored in mock)')
    
    # Флаги
    parser.add_argument('--print-transcript', action='store_true', default=False,
                        help='Print transcript (mock will print detections)')
    parser.add_argument('--first-therm', action='store_true', default=False,
                        help='Exit after detecting the first word')
    parser.add_argument('--autostart', action='store_true', default=False,
                        help='Wait for stream to start (ignored in mock)')
    parser.add_argument('--verbose', '-v', action='store_true', default=False,
                        help='Verbose output')
    
    # Дополнительные аргументы (игнорируются в mock)
    parser.add_argument('--monitor-interval', type=int, default=5)
    parser.add_argument('--hls-interval', type=float, default=0.1)
    parser.add_argument('--format', type=str, default='bestaudio')
    parser.add_argument('--no-hls-skip', action='store_true', default=False)
    parser.add_argument('--chunk-size-ms', type=int, default=5000)
    parser.add_argument('--simulate-realtime', action='store_true', default=False)
    parser.add_argument('--use-fc', action='store_true', default=False)
    parser.add_argument('--downloader', type=str, default=None)
    
    return parser.parse_args()


def connect_redis():
    """Подключение к Redis"""
    print(f"[{CONTAINER_NAME}] Подключаюсь к Redis: {REDIS_HOST}:{REDIS_PORT}")
    
    for attempt in range(10):
        try:
            r = redis.Redis(
                host=REDIS_HOST, 
                port=REDIS_PORT, 
                decode_responses=True,
                socket_connect_timeout=5
            )
            r.ping()
            print(f"[{CONTAINER_NAME}] ✅ Подключено к Redis")
            return r
        except redis.exceptions.ConnectionError as e:
            print(f"[{CONTAINER_NAME}] ⏳ Попытка {attempt + 1}/10: Redis не доступен, жду...")
            time.sleep(2)
    
    print(f"[{CONTAINER_NAME}] ❌ Не удалось подключиться к Redis")
    sys.exit(1)


def get_existing_tokens(r):
    """Получить список существующих токенов из Redis"""
    tokens = r.hkeys("tokens_current_counts")
    
    if not tokens:
        # Если база пустая, используем дефолтные токены
        print(f"[{CONTAINER_NAME}] ⚠️ Нет токенов в базе, использую дефолтные")
        return [
            "KXTRUMPMENTION-26JAN10-CHIN_YES",
            "KXTRUMPMENTION-26JAN22-NATO_YES",
            "KXVANCEMENTION-26JAN24-ABOR_YES",
            "KXMAMDANIMENTION-26FEB17-SNOW_YES",
            "KXCONGRESSMENTION-26JAN08-WHIS_YES",
        ]
    
    # Фильтруем только текстовые токены (не числовые ID)
    text_tokens = [t for t in tokens if not t.isdigit()]
    
    if not text_tokens:
        text_tokens = tokens[:20]  # Если все числовые, берём первые 20
    
    print(f"[{CONTAINER_NAME}] 📋 Найдено {len(text_tokens)} токенов для имитации")
    return text_tokens


def simulate_detection(r, tokens, args):
    """Имитировать обнаружение слова"""
    # Выбираем случайный токен
    token_id = random.choice(tokens)
    
    # Увеличиваем счётчик
    new_count = r.hincrby("tokens_current_counts", token_id, 1)
    
    # Записываем в stream для Live Feed
    stream_data = {
        "token_id": token_id,
        "count": str(new_count),
        "container_id": CONTAINER_NAME,
        "timestamp": str(int(time.time() * 1000))
    }
    
    r.xadd("tokens_updates_stream", stream_data, maxlen=10000)
    
    return token_id, new_count


def main():
    args = parse_args()
    
    print(f"""
╔══════════════════════════════════════════════════════════════════╗
║              Mock ASR Module - Заглушка для тестирования          ║
╠══════════════════════════════════════════════════════════════════╣
║  Container:  {CONTAINER_NAME:<52} ║
║  Redis:      {REDIS_HOST}:{REDIS_PORT:<49} ║
║  Stream URL: {args.input[:50]:<52} ║
║  Words:      {args.words:<52} ║
║  Reference:  {args.reference:<52} ║
║  Threshold:  {args.similarity_threshold:<52} ║
║  Verbose:    {str(args.verbose):<52} ║
╚══════════════════════════════════════════════════════════════════╝
    """)
    
    if args.verbose:
        print(f"[{CONTAINER_NAME}] 📝 Все аргументы: {vars(args)}")
    
    r = connect_redis()
    tokens = get_existing_tokens(r)
    
    print(f"[{CONTAINER_NAME}] 🚀 Начинаю имитацию детекций...")
    print(f"[{CONTAINER_NAME}] Нажмите Ctrl+C для остановки\n")
    
    detection_count = 0
    
    while running:
        try:
            # Имитируем детекцию
            token_id, new_count = simulate_detection(r, tokens, args)
            detection_count += 1
            
            # Красивый вывод
            timestamp = datetime.now().strftime("%H:%M:%S")
            
            if args.print_transcript:
                print(f"[{timestamp}] 📝 TRANSCRIPT: Detected '{token_id.split('-')[-1]}' in speech")
            
            print(f"[{timestamp}] 🎯 #{detection_count} | {token_id} → count: {new_count}")
            
            # Выход после первого слова если --first-therm
            if args.first_therm:
                print(f"[{CONTAINER_NAME}] 🏁 --first-therm: выход после первой детекции")
                break
            
            # Случайная пауза
            sleep_time = random.uniform(MIN_INTERVAL, MAX_INTERVAL)
            time.sleep(sleep_time)
            
        except redis.exceptions.ConnectionError:
            print(f"[{CONTAINER_NAME}] ⚠️ Потеряно соединение с Redis, переподключаюсь...")
            r = connect_redis()
            tokens = get_existing_tokens(r)
        except Exception as e:
            print(f"[{CONTAINER_NAME}] ❌ Ошибка: {e}")
            time.sleep(1)
    
    print(f"\n[{CONTAINER_NAME}] 👋 Завершено. Всего детекций: {detection_count}")


if __name__ == "__main__":
    main()
