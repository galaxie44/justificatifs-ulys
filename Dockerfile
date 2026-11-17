FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py database.py ulys_parser.py ./
COPY templates ./templates
COPY static ./static

ENV DATA_DIR=/data
ENV PORT=8080
RUN mkdir -p /data/uploads

EXPOSE 8080
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
