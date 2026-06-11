FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/apps/api
COPY apps/api ./
RUN pip install --no-cache-dir -e '.[dev]'

COPY data /app/data
COPY services/worldcup/db/dump /app/services/worldcup/db/dump

EXPOSE 8000
CMD ["uvicorn", "footballsage_api.main:app", "--host", "0.0.0.0", "--port", "8000"]
