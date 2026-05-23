# Galaxia — bot Telegram pour les galaxies filles PME.
# Reste léger : Python 3.12 slim + python-telegram-bot + sqlite3 stdlib.
# Le bot écrit dans le volume cockpit_data partagé avec le cockpit.

FROM python:3.12-slim AS runtime
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    COCKPIT_DB_PATH=/cockpit_data/cockpit.db \
    INBOX_PATH=/bot_data/inbox.md

# Toolchain minimale pour les deps natives éventuelles (python-telegram-bot
# n'a pas de C extension obligatoire en V1, donc on garde slim sans gcc).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY telegram_bot.py .

# Volumes :
# - /cockpit_data : partagé avec le cockpit (SQLite)
# - /bot_data : inbox.md (URL TikTok/X en attente du digest)
RUN mkdir -p /cockpit_data /bot_data && chown -R 1000:1000 /cockpit_data /bot_data

USER 1000:1000
VOLUME ["/cockpit_data", "/bot_data"]

# Le service est défini par docker-compose ; ce CMD est le default.
CMD ["python", "telegram_bot.py"]
