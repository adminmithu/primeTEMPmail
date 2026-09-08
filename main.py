import asyncio
import logging
import sys
from config import BOT_TOKEN
from database import init_db
from bot import setup_bot_application, auto_inbox_poller_task

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger(__name__)

async def main():
    logger.info("Initializing Mail.tm Temp Mail Bot (Advanced Version)...")
    
    # 1. Initialize SQLite Database
    await init_db()

    # 2. Check Bot Token
    if not BOT_TOKEN or BOT_TOKEN.strip() == "" or BOT_TOKEN == "YOUR_TELEGRAM_BOT_TOKEN_HERE":
        print("\n" + "=" * 60)
        print("❌ ERROR: BOT_TOKEN is missing or not set!")
        print("Please set your Telegram Bot Token in `.env` file.")
        print("=" * 60 + "\n")
        sys.exit(1)

    # 3. Build & Run Application
    app = setup_bot_application(BOT_TOKEN)
    logger.info("Starting Telegram Bot Application...")
    
    await app.initialize()
    await app.start()
    await app.updater.start_polling()

    # 4. Start Background Realtime Inbox Auto-Notifier Task
    poller_task = asyncio.create_task(auto_inbox_poller_task(app))

    logger.info("🚀 Bot & Background Realtime Auto-Notifier are running! Press Ctrl+C to stop.")

    try:
        while True:
            await asyncio.sleep(3600)
    except (KeyboardInterrupt, SystemExit):
        logger.info("Stopping bot...")
        poller_task.cancel()
        await app.updater.stop()
        await app.stop()
        await app.shutdown()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nBot stopped by user.")
