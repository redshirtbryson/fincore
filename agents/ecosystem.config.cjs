// PM2 config. No secret values here; both processes load .env via dotenv in code.
// Start:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'fincore-discord-bot',
      script: 'discord-bot.js',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
    },
    {
      name: 'fincore-daily',
      script: 'agent-daily.js',
      autorestart: false,          // run-once job
      cron_restart: '0 7 * * *',   // 7:00 local each day; adjust to taste
    },
  ],
};
