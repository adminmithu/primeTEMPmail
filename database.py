import aiosqlite
import logging
from config import DB_PATH

logger = logging.getLogger(__name__)

async def init_db():
    """Initialize SQLite database tables for users and saved mail accounts with schema migration."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                telegram_id INTEGER PRIMARY KEY,
                active_email TEXT,
                language TEXT DEFAULT 'bn',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_id INTEGER,
                email TEXT NOT NULL,
                password TEXT NOT NULL,
                token TEXT,
                account_id TEXT,
                last_msg_id TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(telegram_id, email)
            )
        """)
        
        try:
            await db.execute("ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'bn'")
        except Exception:
            pass

        try:
            await db.execute("ALTER TABLE accounts ADD COLUMN last_msg_id TEXT")
        except Exception:
            pass

        await db.commit()
    logger.info("Database initialized & schema migrated successfully.")

async def set_user_language(telegram_id: int, lang: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO users (telegram_id, language)
            VALUES (?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET language = excluded.language
        """, (telegram_id, lang))
        await db.commit()

async def get_user_language(telegram_id: int) -> str:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT language FROM users WHERE telegram_id = ?", (telegram_id,)) as cursor:
            row = await cursor.fetchone()
            return row[0] if row and row[0] else "bn"

async def save_account(telegram_id: int, email: str, password: str, token: str = "", account_id: str = ""):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO accounts (telegram_id, email, password, token, account_id)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(telegram_id, email) DO UPDATE SET
                password = excluded.password,
                token = excluded.token,
                account_id = excluded.account_id
        """, (telegram_id, email, password, token, account_id))
        
        await db.execute("""
            INSERT INTO users (telegram_id, active_email)
            VALUES (?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET active_email = excluded.active_email
        """, (telegram_id, email))
        
        await db.commit()

async def get_user_accounts(telegram_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT email, password, token, account_id, last_msg_id, created_at FROM accounts WHERE telegram_id = ? ORDER BY id DESC",
            (telegram_id,)
        ) as cursor:
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

async def get_account(telegram_id: int, email: str):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT email, password, token, account_id, last_msg_id FROM accounts WHERE telegram_id = ? AND email = ?",
            (telegram_id, email)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

async def get_active_account(telegram_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT active_email FROM users WHERE telegram_id = ?",
            (telegram_id,)
        ) as cursor:
            user_row = await cursor.fetchone()
            if not user_row or not user_row["active_email"]:
                return None
            active_email = user_row["active_email"]

        async with db.execute(
            "SELECT email, password, token, account_id, last_msg_id FROM accounts WHERE telegram_id = ? AND email = ?",
            (telegram_id, active_email)
        ) as cursor:
            acc_row = await cursor.fetchone()
            return dict(acc_row) if acc_row else None

async def set_active_account(telegram_id: int, email: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO users (telegram_id, active_email)
            VALUES (?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET active_email = excluded.active_email
        """, (telegram_id, email))
        await db.commit()

async def update_account_token(telegram_id: int, email: str, token: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE accounts SET token = ? WHERE telegram_id = ? AND email = ?",
            (token, telegram_id, email)
        )
        await db.commit()

async def update_last_msg_id(telegram_id: int, email: str, msg_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE accounts SET last_msg_id = ? WHERE telegram_id = ? AND email = ?",
            (msg_id, telegram_id, email)
        )
        await db.commit()

async def delete_saved_account(telegram_id: int, email: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "DELETE FROM accounts WHERE telegram_id = ? AND email = ?",
            (telegram_id, email)
        )
        async with db.execute("SELECT active_email FROM users WHERE telegram_id = ?", (telegram_id,)) as cursor:
            row = await cursor.fetchone()
            if row and row[0] == email:
                await db.execute("UPDATE users SET active_email = NULL WHERE telegram_id = ?", (telegram_id,))
        await db.commit()

async def delete_all_user_accounts(telegram_id: int):
    """Delete all saved accounts for a user."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM accounts WHERE telegram_id = ?", (telegram_id,))
        await db.execute("UPDATE users SET active_email = NULL WHERE telegram_id = ?", (telegram_id,))
        await db.commit()

async def get_all_active_accounts():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("""
            SELECT u.telegram_id, a.email, a.password, a.token, a.last_msg_id
            FROM users u
            JOIN accounts a ON u.telegram_id = a.telegram_id AND u.active_email = a.email
        """) as cursor:
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

async def get_all_users():
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT telegram_id FROM users") as cursor:
            rows = await cursor.fetchall()
            return [r[0] for r in rows]

async def get_admin_stats():
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT COUNT(*) FROM users") as c1:
            total_users = (await c1.fetchone())[0]
        async with db.execute("SELECT COUNT(*) FROM accounts") as c2:
            total_accounts = (await c2.fetchone())[0]
        return {"total_users": total_users, "total_accounts": total_accounts}
