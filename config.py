import os
from dotenv import load_dotenv

load_dotenv()

# Telegram Bot Config
BOT_TOKEN = os.getenv("BOT_TOKEN", "8921472442:AAEZao1VTAhOoRki4vWbaF1k82EZb6Enk7g")
ADMIN_ID = int(os.getenv("ADMIN_ID", "8929349073"))
BOT_ID = os.getenv("BOT_ID", "8921472442")

# Supabase Cloud Database Config (Permanent cloud persistence across Vercel deployments)
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://pnlcjkqvlpntvrbzrvqf.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBubGNqa3F2bHBudHZyYnpydnFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4NTcwNzcsImV4cCI6MjEwNDQzMzA3N30.1t97uwsU1Qnttn1sa8QufExg0nqf0IOSpsDDbCx35L8")

# Mail.tm REST API Config
MAIL_TM_API_BASE = "https://api.mail.tm"

# SQLite Database File Path (Fallback for local dev)
if os.getenv("VERCEL"):
    DB_PATH = "/tmp/mail_bot.db"
else:
    DB_PATH = os.path.join(os.path.dirname(__file__), "mail_bot.db")

# Inbox Background Polling Interval (in seconds)
POLL_INTERVAL = 5
