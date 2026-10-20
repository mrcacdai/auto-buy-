module.exports = {
  apps: [
    {
      name: "autobuy-bot",
      script: "index.js",
      instances: 1,
      autorestart: true,
      watch: ["index.js", "bot", "minecraft", "utils", "web"],
      ignore_watch: [
        "node_modules",
        "data",
        "auth-cache",
        ".git",
        "config.json",
        "*.log",
        "logs"
      ],
      max_memory_restart: "1G",
      node_args: "--no-deprecation",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        FORCE_COLOR: "1"
      }
    }
  ]
};
