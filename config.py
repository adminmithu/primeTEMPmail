import os
from dotenv import load_dotenv

load_dotenv()

# Telegram Bot Config
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))
BOT_ID = os.getenv("BOT_ID", "")
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "")

# Supabase Cloud Database Config (Permanent cloud persistence across Vercel deployments)
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")

# Mail.tm REST API Config
MAIL_TM_API_BASE = "https://api.mail.tm"

# SQLite Database File Path (Fallback for local dev)
if os.getenv("VERCEL"):
    DB_PATH = "/tmp/mail_bot.db"
else:
    DB_PATH = os.path.join(os.path.dirname(__file__), "mail_bot.db")

# Inbox Background Polling Interval (in seconds)
POLL_INTERVAL = 5

