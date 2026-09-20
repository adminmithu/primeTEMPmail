import aiosqlite
import httpx
import logging
import os
from config import DB_PATH, SUPABASE_URL, SUPABASE_KEY

logger = logging.getLogger(__name__)

# Check if Supabase keys are configured
USE_SUPABASE = bool(SUPABASE_URL and SUPABASE_KEY and SUPABASE_URL.startswith("http"))

def get_supabase_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }

async def init_db():
    """Initialize SQLite database locally AND verify Supabase REST tables if available."""
    # 1. Local SQLite initialization & migration
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                telegram_id INTEGER PRIMARY KEY,
                active_email TEXT,
                language TEXT DEFAULT 'bn',
                username TEXT,
                first_name TEXT,
                is_banned INTEGER DEFAULT 0,
                is_vip INTEGER DEFAULT 0,
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
                expires_at TIMESTAMP,
                free_trial_used INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(telegram_id, email)
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS payment_claims (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_id INTEGER,
                email TEXT,
                sender_number TEXT,
                trx_id TEXT,
                amount INTEGER DEFAULT 10,
                status TEXT DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        try:
            await db.execute("ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'bn'")
        except Exception:
            pass

        try:
            await db.execute("ALTER TABLE users ADD COLUMN username TEXT")
        except Exception:
            pass

        try:
            await db.execute("ALTER TABLE users ADD COLUMN first_name TEXT")
        except Exception:
            pass

        try:
            await db.execute("ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0")
        except Exception:
            pass

        try:
            await db.execute("ALTER TABLE users ADD COLUMN is_vip INTEGER DEFAULT 0")
        except Exception:
            pass

        try:
            await db.execute("ALTER TABLE accounts ADD COLUMN last_msg_id TEXT")
        except Exception:
            pass

        try:
            await db.execute("ALTER TABLE accounts ADD COLUMN expires_at TIMESTAMP")
        except Exception:
            pass

        try:
            await db.execute("ALTER TABLE accounts ADD COLUMN free_trial_used INTEGER DEFAULT 0")
        except Exception:
            pass

        try:
            await db.execute("ALTER TABLE accounts ADD COLUMN reminded_3d INTEGER DEFAULT 0")
        except Exception:
            pass

        try:
            await db.execute("ALTER TABLE accounts ADD COLUMN reminded_1d INTEGER DEFAULT 0")
        except Exception:
            pass

        await db.commit()

    # 2. Supabase Cloud Check
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(f"{SUPABASE_URL}/rest/v1/users?select=count", headers=get_supabase_headers())
                if res.status_code in (200, 206):
                    logger.info("Connected to Supabase Cloud Database successfully.")
        except Exception as e:
            logger.warning(f"Supabase connection check skipped: {e}")

    logger.info("Database initialized successfully.")

async def set_user_language(telegram_id: int, lang: str):
    if USE_SUPABASE:
        try:
            payload = {"telegram_id": telegram_id, "language": lang}
            async with httpx.AsyncClient(timeout=5.0) as client:
                headers = get_supabase_headers()
                headers["Prefer"] = "resolution=merge-duplicates"
                await client.post(f"{SUPABASE_URL}/rest/v1/users", json=payload, headers=headers)
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO users (telegram_id, language)
            VALUES (?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET language = excluded.language
        """, (telegram_id, lang))
        await db.commit()

async def get_user_language(telegram_id: int) -> str:
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/users?telegram_id=eq.{telegram_id}&select=language",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()[0].get("language", "bn")
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT language FROM users WHERE telegram_id = ?", (telegram_id,)) as cursor:
            row = await cursor.fetchone()
            return row[0] if row and row[0] else "bn"

async def save_account(telegram_id: int, email: str, password: str, token: str = "", account_id: str = ""):
    import datetime
    expires_at = (datetime.datetime.now() + datetime.timedelta(days=60)).strftime("%Y-%m-%d %H:%M:%S")

    if USE_SUPABASE:
        try:
            acc_payload = {
                "telegram_id": telegram_id,
                "email": email,
                "password": password,
                "token": token,
                "account_id": account_id,
                "expires_at": expires_at,
                "free_trial_used": 0
            }
            user_payload = {"telegram_id": telegram_id, "active_email": email}
            headers = get_supabase_headers()
            headers["Prefer"] = "resolution=merge-duplicates"
            
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(f"{SUPABASE_URL}/rest/v1/accounts", json=acc_payload, headers=headers)
                await client.post(f"{SUPABASE_URL}/rest/v1/users", json=user_payload, headers=headers)
        except Exception as e:
            logger.warning(f"Supabase save_account error: {e}")

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO accounts (telegram_id, email, password, token, account_id, expires_at, free_trial_used)
            VALUES (?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(telegram_id, email) DO UPDATE SET
                password = excluded.password,
                token = excluded.token,
                account_id = excluded.account_id,
                expires_at = COALESCE(accounts.expires_at, excluded.expires_at)
        """, (telegram_id, email, password, token, account_id, expires_at))
        
        await db.execute("""
            INSERT INTO users (telegram_id, active_email)
            VALUES (?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET active_email = excluded.active_email
        """, (telegram_id, email))
        
        await db.commit()

async def extend_email_validity_free(telegram_id: int, email: str):
    acc = await get_account(telegram_id, email)
    if not acc:
        return False, "account_not_found"

    free_used = acc.get("free_trial_used", 0)
    if free_used and int(free_used) == 1:
        return False, "already_used"

    import datetime
    current_exp = acc.get("expires_at")
    if current_exp:
        try:
            exp_dt = datetime.datetime.strptime(str(current_exp)[:19], "%Y-%m-%d %H:%M:%S")
        except Exception:
            exp_dt = datetime.datetime.now()
    else:
        exp_dt = datetime.datetime.now()

    new_exp_dt = exp_dt + datetime.timedelta(days=60)
    new_exp_str = new_exp_dt.strftime("%Y-%m-%d %H:%M:%S")

    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{email}",
                    json={"expires_at": new_exp_str, "free_trial_used": 1},
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE accounts SET expires_at = ?, free_trial_used = 1 WHERE telegram_id = ? AND email = ?",
            (new_exp_str, telegram_id, email)
        )
        await db.commit()

    return True, new_exp_str

async def extend_email_validity_paid(telegram_id: int, email: str, days: int = 60):
    acc = await get_account(telegram_id, email)
    if not acc:
        return False

    import datetime
    current_exp = acc.get("expires_at")
    if current_exp:
        try:
            exp_dt = datetime.datetime.strptime(str(current_exp)[:19], "%Y-%m-%d %H:%M:%S")
        except Exception:
            exp_dt = datetime.datetime.now()
    else:
        exp_dt = datetime.datetime.now()

    new_exp_dt = exp_dt + datetime.timedelta(days=days)
    new_exp_str = new_exp_dt.strftime("%Y-%m-%d %H:%M:%S")

    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{email}",
                    json={"expires_at": new_exp_str},
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE accounts SET expires_at = ? WHERE telegram_id = ? AND email = ?",
            (new_exp_str, telegram_id, email)
        )
        await db.commit()

    return True

async def extend_all_user_accounts_validity_paid(telegram_id: int, days: int = 60):
    accounts = await get_user_accounts(telegram_id)
    if not accounts:
        return False

    import datetime
    now = datetime.datetime.now()
    for acc in accounts:
        current_exp = acc.get("expires_at")
        if current_exp:
            try:
                exp_dt = datetime.datetime.strptime(str(current_exp)[:19], "%Y-%m-%d %H:%M:%S")
            except Exception:
                exp_dt = now
        else:
            exp_dt = now

        base_dt = max(exp_dt, now)
        new_exp_dt = base_dt + datetime.timedelta(days=days)
        new_exp_str = new_exp_dt.strftime("%Y-%m-%d %H:%M:%S")
        email = acc["email"]

        if USE_SUPABASE:
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    await client.patch(
                        f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{email}",
                        json={"expires_at": new_exp_str},
                        headers=get_supabase_headers()
                    )
            except Exception:
                pass

        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE accounts SET expires_at = ? WHERE telegram_id = ? AND email = ?",
                (new_exp_str, telegram_id, email)
            )
            await db.commit()

    return True

async def get_user_accounts(telegram_id: int):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&order=id.desc",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT email, password, token, account_id, last_msg_id, expires_at, free_trial_used, created_at FROM accounts WHERE telegram_id = ? ORDER BY id DESC",
            (telegram_id,)
        ) as cursor:
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

async def get_account(telegram_id: int, email: str):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{email}",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()[0]
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT email, password, token, account_id, last_msg_id, expires_at, free_trial_used FROM accounts WHERE telegram_id = ? AND email = ?",
            (telegram_id, email)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

async def get_active_account(telegram_id: int):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                u_res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/users?telegram_id=eq.{telegram_id}&select=active_email",
                    headers=get_supabase_headers()
                )
                if u_res.status_code == 200 and u_res.json():
                    active_email = u_res.json()[0].get("active_email")
                    if active_email:
                        a_res = await client.get(
                            f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{active_email}",
                            headers=get_supabase_headers()
                        )
                        if a_res.status_code == 200 and a_res.json():
                            return a_res.json()[0]
        except Exception:
            pass

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
    if USE_SUPABASE:
        try:
            payload = {"telegram_id": telegram_id, "active_email": email}
            headers = get_supabase_headers()
            headers["Prefer"] = "resolution=merge-duplicates"
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(f"{SUPABASE_URL}/rest/v1/users", json=payload, headers=headers)
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO users (telegram_id, active_email)
            VALUES (?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET active_email = excluded.active_email
        """, (telegram_id, email))
        await db.commit()

async def update_account_token(telegram_id: int, email: str, token: str):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{email}",
                    json={"token": token},
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE accounts SET token = ? WHERE telegram_id = ? AND email = ?",
            (token, telegram_id, email)
        )
        await db.commit()

async def update_last_msg_id(telegram_id: int, email: str, msg_id: str):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{email}",
                    json={"last_msg_id": msg_id},
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE accounts SET last_msg_id = ? WHERE telegram_id = ? AND email = ?",
            (msg_id, telegram_id, email)
        )
        await db.commit()

async def delete_saved_account(telegram_id: int, email: str):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.delete(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{email}",
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

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

def check_account_expiry_status(acc: dict):
    if not acc or not acc.get("expires_at"):
        return "active", None

    import datetime
    try:
        exp_dt = datetime.datetime.strptime(str(acc["expires_at"])[:19], "%Y-%m-%d %H:%M:%S")
    except Exception:
        return "active", None

    now = datetime.datetime.now()
    if now <= exp_dt:
        return "active", exp_dt

    grace_cutoff = exp_dt + datetime.timedelta(days=5)
    if now > grace_cutoff:
        return "overdue_delete", exp_dt

    return "expired", exp_dt

async def cleanup_overdue_expired_accounts():
    accounts = []
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/accounts?select=telegram_id,email,expires_at,token,account_id",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    accounts = res.json()
        except Exception:
            pass

    if not accounts:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT telegram_id, email, expires_at, token, account_id FROM accounts") as cursor:
                rows = await cursor.fetchall()
                accounts = [dict(row) for row in rows]

    deleted_accounts = []
    import datetime
    now = datetime.datetime.now()

    for acc in accounts:
        exp_str = acc.get("expires_at")
        if not exp_str:
            continue
        try:
            exp_dt = datetime.datetime.strptime(str(exp_str)[:19], "%Y-%m-%d %H:%M:%S")
            if now > exp_dt + datetime.timedelta(days=5):
                t_id = acc["telegram_id"]
                email = acc["email"]
                await delete_saved_account(t_id, email)
                deleted_accounts.append(acc)
        except Exception:
            pass

    return deleted_accounts

async def check_and_send_expiry_reminders(bot_instance):
    accounts = []
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/accounts?select=telegram_id,email,password,expires_at,reminded_3d,reminded_1d",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    accounts = res.json()
        except Exception:
            pass

    if not accounts:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT telegram_id, email, password, expires_at, reminded_3d, reminded_1d FROM accounts") as cursor:
                rows = await cursor.fetchall()
                accounts = [dict(row) for row in rows]

    import datetime, io
    from telegram import InputFile, InlineKeyboardButton, InlineKeyboardMarkup
    now = datetime.datetime.now()

    for acc in accounts:
        exp_str = acc.get("expires_at")
        if not exp_str:
            continue
        try:
            exp_dt = datetime.datetime.strptime(str(exp_str)[:19], "%Y-%m-%d %H:%M:%S")
            diff_hours = (exp_dt - now).total_seconds() / 3600.0
            u_id = acc["telegram_id"]
            email = acc["email"]
            password = acc.get("password", "N/A")
            rem_3d = acc.get("reminded_3d", 0) or 0
            rem_1d = acc.get("reminded_1d", 0) or 0

            days_left_text = f"{round(diff_hours / 24, 1)} Days"

            # Generate formatted .txt document for the expiring account
            txt_content = "=====================================================\n"
            txt_content += "     EXPIRING TEMP EMAIL ACCOUNT WARNING (.TXT)     \n"
            txt_content += "=====================================================\n\n"
            txt_content += f"EMAIL ADDRESS   : {email}\n"
            txt_content += f"PASSWORD        : {password}\n"
            txt_content += f"EXPIRATION DATE : {exp_str}\n"
            txt_content += f"TIME REMAINING  : {days_left_text}\n"
            txt_content += "-----------------------------------------------------\n"
            txt_content += "NOTE: Please renew your email validity before it\n"
            txt_content += "expires to avoid inbox locking and auto-deletion!\n"
            txt_content += "=====================================================\n"

            doc_filename = f"expiring_mail_{email.split('@')[0]}.txt"

            # 3 days warning (between 48h and 72h)
            if 48.0 <= diff_hours <= 72.0 and rem_3d == 0:
                msg = (
                    f"⚠️ <b>ইমেইলের মেয়াদের সতর্কবার্তা (৩ দিন বাকি)!</b>\n"
                    f"━━━━━━━━━━━━━━━━━━━━━━\n\n"
                    f"<blockquote>📧 <b>Email:</b> <code>{email}</code>\n"
                    f"⏳ <b>মেয়াদ শেষ হবে:</b> <code>{exp_str}</code> (৩ দিন বাকি)\n\n"
                    f"<i>লকিং এড়াতে এবং ইনবক্স সচল রাখতে এখনই ১০/১২ টাকা সেন্ড মানি করে মেয়াদ বাড়িয়ে নিন! নিচে ডেসক্রিপশনসহ .txt ফাইল যুক্ত করা হলো।</i></blockquote>"
                )
                kb = [[InlineKeyboardButton("🎁 Renew / Extend 2 Months", callback_data=f"extend_mail:{email}")]]
                try:
                    txt_bytes = io.BytesIO(txt_content.encode("utf-8"))
                    await bot_instance.send_document(
                        chat_id=u_id,
                        document=InputFile(txt_bytes, filename=doc_filename),
                        caption=msg,
                        parse_mode="HTML",
                        reply_markup=InlineKeyboardMarkup(kb)
                    )
                    await mark_account_reminded(u_id, email, field="reminded_3d")
                except Exception:
                    try:
                        await bot_instance.send_message(chat_id=u_id, text=msg, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
                        await mark_account_reminded(u_id, email, field="reminded_3d")
                    except Exception:
                        pass

            # 1 day warning (between 0h and 24h)
            elif 0.0 <= diff_hours <= 24.0 and rem_1d == 0:
                msg = (
                    f"🚨 <b>জরুরী মেয়াদের সতর্কবার্তা (১ দিন বাকি)!</b>\n"
                    f"━━━━━━━━━━━━━━━━━━━━━━\n\n"
                    f"<blockquote>📧 <b>Email:</b> <code>{email}</code>\n"
                    f"⏳ <b>মেয়াদ শেষ হবে:</b> <code>{exp_str}</code> (আগামীকাল!)\n\n"
                    f"<i>আগামীকাল এই ইমেইলের মেয়াদ শেষ হয়ে ইনবক্স লক হয়ে যাবে। এখনই নিচে ক্লিক করে রিনিউ সম্পন্ন করুন! নিচে বিস্তারিত তথ্যসহ .txt ফাইল যুক্ত করা হলো।</i></blockquote>"
                )
                kb = [[InlineKeyboardButton("🎁 Renew / Extend 2 Months", callback_data=f"extend_mail:{email}")]]
                try:
                    txt_bytes = io.BytesIO(txt_content.encode("utf-8"))
                    await bot_instance.send_document(
                        chat_id=u_id,
                        document=InputFile(txt_bytes, filename=doc_filename),
                        caption=msg,
                        parse_mode="HTML",
                        reply_markup=InlineKeyboardMarkup(kb)
                    )
                    await mark_account_reminded(u_id, email, field="reminded_1d")
                except Exception:
                    try:
                        await bot_instance.send_message(chat_id=u_id, text=msg, parse_mode="HTML", reply_markup=InlineKeyboardMarkup(kb))
                        await mark_account_reminded(u_id, email, field="reminded_1d")
                    except Exception:
                        pass
        except Exception:
            pass

async def mark_account_reminded(telegram_id: int, email: str, field: str):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}&email=eq.{email}",
                    json={field: 1},
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(f"UPDATE accounts SET {field} = 1 WHERE telegram_id = ? AND email = ?", (telegram_id, email))
        await db.commit()

async def delete_all_user_accounts(telegram_id: int):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.delete(
                    f"{SUPABASE_URL}/rest/v1/accounts?telegram_id=eq.{telegram_id}",
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM accounts WHERE telegram_id = ?", (telegram_id,))
        await db.execute("UPDATE users SET active_email = NULL WHERE telegram_id = ?", (telegram_id,))
        await db.commit()

async def get_all_active_accounts():
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/accounts?select=telegram_id,email,password,token,last_msg_id",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()
        except Exception:
            pass

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
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/users?select=telegram_id",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return [r["telegram_id"] for r in res.json()]
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT telegram_id FROM users") as cursor:
            rows = await cursor.fetchall()
            return [r[0] for r in rows]

async def register_user(telegram_id: int, username: str = None, first_name: str = None):
    if USE_SUPABASE:
        try:
            payload = {"telegram_id": telegram_id}
            if username: payload["username"] = username
            if first_name: payload["first_name"] = first_name
            headers = get_supabase_headers()
            headers["Prefer"] = "resolution=merge-duplicates"
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(f"{SUPABASE_URL}/rest/v1/users", json=payload, headers=headers)
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO users (telegram_id, username, first_name)
            VALUES (?, ?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET
                username = COALESCE(excluded.username, users.username),
                first_name = COALESCE(excluded.first_name, users.first_name)
        """, (telegram_id, username, first_name))
        await db.commit()

async def find_user_by_identifier(identifier: str):
    clean_id = identifier.strip().lstrip("@")
    if not clean_id:
        return None

    is_numeric = clean_id.isdigit()
    
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                if is_numeric:
                    url = f"{SUPABASE_URL}/rest/v1/users?telegram_id=eq.{clean_id}"
                else:
                    url = f"{SUPABASE_URL}/rest/v1/users?username=ilike.{clean_id}"
                res = await client.get(url, headers=get_supabase_headers())
                if res.status_code == 200 and res.json():
                    return res.json()[0]
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if is_numeric:
            query = "SELECT telegram_id, username, first_name, is_banned, is_vip FROM users WHERE telegram_id = ?"
            param = int(clean_id)
        else:
            query = "SELECT telegram_id, username, first_name, is_banned, is_vip FROM users WHERE LOWER(username) = LOWER(?)"
            param = clean_id
        async with db.execute(query, (param,)) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

async def get_all_users_for_export():
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/users?select=telegram_id,username,first_name,is_banned,is_vip,created_at&order=telegram_id.desc",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT telegram_id, username, first_name, is_banned, is_vip, created_at FROM users ORDER BY telegram_id DESC"
        ) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]

async def get_banned_users_list():
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/users?is_banned=eq.1&select=telegram_id,username,first_name,created_at",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT telegram_id, username, first_name, created_at FROM users WHERE is_banned = 1"
        ) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]

async def is_user_banned(telegram_id: int) -> bool:
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/users?telegram_id=eq.{telegram_id}&select=is_banned",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return bool(res.json()[0].get("is_banned", 0))
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT is_banned FROM users WHERE telegram_id = ?", (telegram_id,)) as cursor:
            row = await cursor.fetchone()
            return bool(row[0]) if row and row[0] else False

async def is_user_vip(telegram_id: int) -> bool:
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/users?telegram_id=eq.{telegram_id}&select=is_vip",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return bool(res.json()[0].get("is_vip", 0))
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT is_vip FROM users WHERE telegram_id = ?", (telegram_id,)) as cursor:
            row = await cursor.fetchone()
            return bool(row[0]) if row and row[0] else False

async def set_user_ban_status(telegram_id: int, is_banned: bool):
    val = 1 if is_banned else 0
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/users?telegram_id=eq.{telegram_id}",
                    json={"is_banned": val},
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE users SET is_banned = ? WHERE telegram_id = ?", (val, telegram_id))
        await db.commit()

async def toggle_user_vip(telegram_id: int) -> bool:
    current_vip = await is_user_vip(telegram_id)
    new_val = 0 if current_vip else 1
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/users?telegram_id=eq.{telegram_id}",
                    json={"is_vip": new_val},
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE users SET is_vip = ? WHERE telegram_id = ?", (new_val, telegram_id))
        await db.commit()
    return bool(new_val)

async def get_admin_stats():
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r1 = await client.get(f"{SUPABASE_URL}/rest/v1/users?select=telegram_id,is_banned,is_vip,created_at", headers=get_supabase_headers())
                r2 = await client.get(f"{SUPABASE_URL}/rest/v1/accounts?select=id,created_at", headers=get_supabase_headers())
                users = r1.json() if r1.status_code == 200 and isinstance(r1.json(), list) else []
                accs = r2.json() if r2.status_code == 200 and isinstance(r2.json(), list) else []
                
                u_cnt = len(users)
                a_cnt = len(accs)
                banned_cnt = sum(1 for u in users if u.get("is_banned") == 1)
                vip_cnt = sum(1 for u in users if u.get("is_vip") == 1)
                
                import datetime
                today_str = datetime.date.today().isoformat()
                new_today = sum(1 for u in users if u.get("created_at") and str(u.get("created_at")).startswith(today_str))
                accs_today = sum(1 for a in accs if a.get("created_at") and str(a.get("created_at")).startswith(today_str))

                return {
                    "total_users": u_cnt,
                    "new_users_today": new_today,
                    "total_accounts": a_cnt,
                    "today_accounts": accs_today,
                    "banned_users": banned_cnt,
                    "vip_users": vip_cnt
                }
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT COUNT(*) FROM users") as c1:
            total_users = (await c1.fetchone())[0]
        async with db.execute("SELECT COUNT(*) FROM users WHERE date(created_at) = date('now')") as c2:
            new_users_today = (await c2.fetchone())[0]
        async with db.execute("SELECT COUNT(*) FROM accounts") as c3:
            total_accounts = (await c3.fetchone())[0]
        async with db.execute("SELECT COUNT(*) FROM accounts WHERE date(created_at) = date('now')") as c4:
            today_accounts = (await c4.fetchone())[0]
        async with db.execute("SELECT COUNT(*) FROM users WHERE is_banned = 1") as c5:
            banned_users = (await c5.fetchone())[0]
        async with db.execute("SELECT COUNT(*) FROM users WHERE is_vip = 1") as c6:
            vip_users = (await c6.fetchone())[0]

        return {
            "total_users": total_users,
            "new_users_today": new_users_today,
            "total_accounts": total_accounts,
            "today_accounts": today_accounts,
            "banned_users": banned_users,
            "vip_users": vip_users
        }

async def create_payment_claim(telegram_id: int, email: str, sender_number: str, trx_id: str, amount: int = 10) -> int:
    if USE_SUPABASE:
        try:
            payload = {
                "telegram_id": telegram_id,
                "email": email,
                "sender_number": sender_number,
                "trx_id": trx_id,
                "amount": amount,
                "status": "PENDING"
            }
            headers = get_supabase_headers()
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.post(f"{SUPABASE_URL}/rest/v1/payment_claims", json=payload, headers=headers)
                if res.status_code in (200, 201) and res.json():
                    return res.json()[0].get("id", 0)
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("""
            INSERT INTO payment_claims (telegram_id, email, sender_number, trx_id, amount, status)
            VALUES (?, ?, ?, ?, ?, 'PENDING')
        """, (telegram_id, email, sender_number, trx_id, amount))
        claim_id = cursor.lastrowid
        await db.commit()
        return claim_id

async def get_pending_payment_claims():
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/payment_claims?status=eq.PENDING&order=id.desc",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id, telegram_id, email, sender_number, trx_id, amount, status, created_at FROM payment_claims WHERE status = 'PENDING' ORDER BY id DESC") as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]

async def get_payment_claim(claim_id: int):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/payment_claims?id=eq.{claim_id}",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()[0]
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id, telegram_id, email, sender_number, trx_id, amount, status, created_at FROM payment_claims WHERE id = ?", (claim_id,)) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

async def approve_payment_claim(claim_id: int):
    claim = await get_payment_claim(claim_id)
    if not claim:
        return False, None

    u_id = claim["telegram_id"]
    email = claim["email"]
    amount = claim.get("amount", 10)

    # Extend email validity by +60 days (2 months)
    if amount >= 12 or email == "ALL":
        await extend_all_user_accounts_validity_paid(u_id, days=60)
    else:
        await extend_email_validity_paid(u_id, email, days=60)

    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/payment_claims?id=eq.{claim_id}",
                    json={"status": "APPROVED"},
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE payment_claims SET status = 'APPROVED' WHERE id = ?", (claim_id,))
        await db.commit()

    return True, claim

async def reject_payment_claim(claim_id: int):
    claim = await get_payment_claim(claim_id)
    if not claim:
        return False, None

    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/payment_claims?id=eq.{claim_id}",
                    json={"status": "REJECTED"},
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE payment_claims SET status = 'REJECTED' WHERE id = ?", (claim_id,))
        await db.commit()

    return True, claim

async def cancel_user_pending_claim(telegram_id: int):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.patch(
                    f"{SUPABASE_URL}/rest/v1/payment_claims?telegram_id=eq.{telegram_id}&status=eq.PENDING",
                    json={"status": "CANCELLED_BY_USER"},
                    headers=get_supabase_headers()
                )
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE payment_claims SET status = 'CANCELLED_BY_USER' WHERE telegram_id = ? AND status = 'PENDING'", (telegram_id,))
        await db.commit()
    return True

async def get_user_details(telegram_id: int):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/users?telegram_id=eq.{telegram_id}",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()[0]
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT telegram_id, username, first_name, is_banned, is_vip, created_at FROM users WHERE telegram_id = ?", (telegram_id,)) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None

async def get_user_payment_claims(telegram_id: int):
    if USE_SUPABASE:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/rest/v1/payment_claims?telegram_id=eq.{telegram_id}&order=id.desc&limit=5",
                    headers=get_supabase_headers()
                )
                if res.status_code == 200 and res.json():
                    return res.json()
        except Exception:
            pass

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id, telegram_id, email, sender_number, trx_id, amount, status, created_at FROM payment_claims WHERE telegram_id = ? ORDER BY id DESC LIMIT 5", (telegram_id,)) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]

