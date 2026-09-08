# 🚀 Vercel 1-Click Deployment Guide for PrimeTemp Mail Bot

এই প্রজেক্টটি Vercel-এ **Serverless Webhook** এবং **Vercel Cron Job** হিসেবে ডিপ্লয় করার জন্য ১০০% প্রস্তুত করা হয়েছে।

---

## 📋 Vercel-এ ডিপ্লয় করার ২টি সহজ স্টেপ:

### Step 1: Push Code to GitHub
১. প্রজেক্টটি আপনার GitHub রিপোজিটরিতে `Push` করুন।

### Step 2: Deploy on Vercel
১. [Vercel Dashboard](https://vercel.com/dashboard)-এ যান এবং **Add New Project**-এ ক্লিক করুন।
২. আপনার GitHub রিপোজিটরিটি সিলেক্ট করুন।
৩. **Environment Variables** সেকশনে নিচের ভ্যালু দুটি যোগ করুন:

| Key | Value | Description |
| :--- | :--- | :--- |
| `BOT_TOKEN` | `8921472442:AAEZao1VTAhOoRki4vWbaF1k82EZb6Enk7g` | আপনার Telegram Bot Token |
| `ADMIN_ID` | `8929349073` | আপনার Telegram Admin ID |
| `VERCEL` | `1` | Vercel Environment Flag |

৪. **Deploy** বাটনে ক্লিক করুন!

---

## 🎉 ডিপ্লয় হওয়ার পর কি হবে?

1. **Auto Webhook Registration**: Vercel-এ ডিপ্লয় হওয়ামাত্রই বট Telegram Webhook সেটআপ করে ফেলবে।
2. **Auto 1-Minute Cron Job**: `vercel.json`-এর মাধ্যমে প্রতি ১ মিনিট পর পর Vercel Cron অ্যান্ডপয়েন্টটি পিন করবে এবং ইউজারদের ইনবক্সে নতুন মেইল আসলে স্বয়ংক্রিয়ভাবে Telegram-এ পুশ নোটিফিকেশন চলে যাবে!

---

## ⚡ Local Computer-এ চালানোর জন্য:
যদি পিসিতে চালাতে চান, টার্মিনালে রান করুন:
```bash
python main.py
```
*(বর্তমানে আপনার পিসিতে `python main.py` চালুর মাধ্যমে বটটি সচল রয়েছে!)*
