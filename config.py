import os
from dotenv import load_dotenv

load_dotenv()

# Telegram Bot Config
BOT_TOKEN = os.getenv("BOT_TOKEN", "8921472442:AAEZao1VTAhOoRki4vWbaF1k82EZb6Enk7g")
ADMIN_ID = int(os.getenv("ADMIN_ID", "8929349073"))
BOT_ID = os.getenv("BOT_ID", "8921472442")

# Mail.tm REST API Config
MAIL_TM_API_BASE = "https://api.mail.tm"

# SQLite Database File Path (Vercel Serverless environment uses /tmp directory)
if os.getenv("VERCEL"):
    DB_PATH = "/tmp/mail_bot.db"
else:
    DB_PATH = os.path.join(os.path.dirname(__file__), "mail_bot.db")

# Inbox Background Polling Interval (in seconds)
POLL_INTERVAL = 5
