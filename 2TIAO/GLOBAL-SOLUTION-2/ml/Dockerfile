# Serviço de ML (AD-072): treina e serve o LightGBM e o K-means da V2.
FROM python:3.12-slim
# o LightGBM precisa do OpenMP
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt /app/ml/requirements.txt
RUN pip install --no-cache-dir -r /app/ml/requirements.txt
COPY . /app/ml
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8788
CMD ["uvicorn", "ml.api:app", "--host", "0.0.0.0", "--port", "8788"]
