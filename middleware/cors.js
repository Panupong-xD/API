export function buildCorsOptions() {
  const rawOrigin = process.env.CORS_ORIGIN || "*";
  const allowAll = rawOrigin.trim() === "*";
  const allowedOrigins = rawOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }

      if (allowAll) {
        return callback(null, "*");
      }

      return callback(null, allowedOrigins.includes(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "OpenAI-Organization",
      "OpenAI-Project",
      "X-Requested-With"
    ],
    credentials: false,
    maxAge: 86400
  };
}
