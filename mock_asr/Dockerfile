FROM python:3.11-slim

WORKDIR /app

RUN pip install redis --no-cache-dir

COPY mock_asr.py .

ENTRYPOINT ["python", "-u", "mock_asr.py"]
CMD []
