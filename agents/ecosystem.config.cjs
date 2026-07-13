// PM2 config. No secret values here; all processes load .env via dotenv in code.
// cwd is pinned so dotenv, fincore.db, and the Schwab token resolve correctly no
// matter which directory `pm2 start` runs from.
// Start:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'fincore-discord-bot',
      script: 'discord-bot.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
    },
    {
      name: 'fincore-daily',
      script: 'agent-daily.js',
      cwd: __dirname,
      autorestart: false,          // run-once job
      cron_restart: '0 7 * * *',   // 7:00 local each day; adjust to taste
    },
    {
      name: 'fincore-backup',
      script: 'backup.js',
      cwd: __dirname,
      autorestart: false,          // run-once job
      cron_restart: '30 6 * * *',  // daily fincore.db backup before the 7:00 run
    },
  ],
};
