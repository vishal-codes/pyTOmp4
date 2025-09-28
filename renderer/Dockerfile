# renderer/Dockerfile
FROM python:3.11-slim

# ---- System deps (runtime + build) ----
# runtime: ffmpeg, cairo, pango, pixbuf, fonts
# build: compiler, pkg-config, dev headers, meson, ninja (needed for pycairo/manimpango)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libcairo2 libcairo2-dev \
    libpango-1.0-0 libpangoft2-1.0-0 libpangocairo-1.0-0 libpango1.0-dev \
    libgdk-pixbuf-2.0-0 \
    fonts-dejavu-core \
    ca-certificates \
    build-essential \
    pkg-config \
    python3-dev \
    meson ninja-build \
    libffi-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Python deps ----
COPY requirements.txt .
# (optional) upgrade pip first
RUN python -m pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

# ---- App code ----
COPY app ./app

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host=0.0.0.0", "--port=8000"]
